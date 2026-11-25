'use client';

// PÓLIS walking skeleton: scenario library → new scenario → empty
// battlefield editor → save → reload → reopen. Client-only: every store call
// runs in an effect, so the static prerender never touches IndexedDB.
//
// The library is complete and safe (ADR 0003): duplicate and delete (with
// confirmation), export to a JSON file, import always as a new copy (bad
// files are rejected whole with a specific message), two-tab save conflicts
// that never silently overwrite, a persistent-storage request with a refusal
// notice, and quota failures that keep the open scenario.

import { useCallback, useEffect, useRef, useState } from 'react';
import Editor from './editor';
import Library from './library';
import BattleSetup from './battle-setup';
import BattleScreen from './battle';
import BattlesList from './battles-list';
import { documentsMatch, getScenarioStore, type LibraryEntry } from '../lib/store';
import { getBattleStore, type BattleEntry } from '../lib/battles';
import {
  BattleStartError,
  startBattle,
  validatePlayability,
} from '../domain/battle.js';
import { createPlayerForController, runTurn } from '../domain/players.js';
import {
  SUBMISSION_FORMAT_VERSION,
  resolveTurn,
  validateTurn,
} from '../domain/turn.js';
import {
  classifyRulesetReference,
  cloneScenario,
  createHistory,
  createScenario,
  exportScenario,
  generateId,
  historyCommit,
  historyRedo,
  historyUndo,
  importScenarioDocument,
  rebindRulesetToCurrent,
  validateScenario,
} from '../domain/scenario.js';
import {
  SaveConflictError,
  duplicateScenario,
  exportRawRecord,
  isQuotaError,
  isUnsupportedDocument,
  performSave,
} from '../domain/library.js';
import { ensurePersistentStorage } from '../domain/browser/idb.js';

type ScenarioDocument = any;

import {
  battleIdFromUrl,
  battleSeedOverride,
  drawBattleSeed,
  downloadFile,
  quotaFailureMessage,
  scenarioIdFromUrl,
  setUrlParams,
} from './home/page-helpers';
import { createScenarioActions } from './home/scenario-actions';
import { createBattleActions } from './home/battle-actions';

export default function Home() {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [document, setDocument] = useState<ScenarioDocument | null>(null);
  const [savedDocument, setSavedDocument] = useState<ScenarioDocument | null>(null);
  // Undo history for the editing session: snapshots of the document before
  // each committed change. Unbounded within the session, never saved, and
  // reset on every open. Selection and view changes are display-only and are
  // never recorded.
  const [history, setHistory] = useState<{ past: ScenarioDocument[]; future: ScenarioDocument[] }>(
    createHistory(),
  );
  // The stored revision of the open scenario when it was opened or last
  // saved: a save whose stored revision moved on detects the conflict and
  // never silently overwrites the other tab's work.
  const [revision, setRevision] = useState<number | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{
    loadedRevision: number | null;
    storedRevision: number | null;
  } | null>(null);
  // Battle flow: the setup screen (scenario plus controller choice), the
  // playability refusal, the live battle with its committed decisions, and
  // the stored Battles list. Every committed turn is saved to the battles
  // collection, so reloading mid-battle resumes the identical state.
  const [battles, setBattles] = useState<BattleEntry[]>([]);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [setupDocument, setSetupDocument] = useState<ScenarioDocument | null>(null);
  const [setupProblems, setSetupProblems] = useState<{ message: string }[]>([]);
  const [battle, setBattle] = useState<any | null>(null);
  const [decisions, setDecisions] = useState<any[]>([]);
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // After each resolution the next side waits for the device handoff: the
  // "<Side> — begin your turn" press unlocks the turn (a human side drafts,
  // an automated side resolves at once). The first turn is announced at once
  // and needs no handoff.
  const [awaitingHandoff, setAwaitingHandoff] = useState(false);
  const [handoffSide, setHandoffSide] = useState<string | null>(null);
  const [battleError, setBattleError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [persistent, setPersistent] = useState<boolean | null>(null);
  const persistRequested = useRef(false);

  const refreshLibrary = useCallback(async () => {
    try {
      const list = await getScenarioStore().list();
      setEntries(list as LibraryEntry[]);
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const refreshBattles = useCallback(async () => {
    try {
      const list = await getBattleStore().list();
      setBattles(list as BattleEntry[]);
      setBattleError(null);
    } catch (loadError) {
      setBattleError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  // The first save that needs browser storage requests persistent storage;
  // when the browser refuses, the library shows an unobtrusive notice that
  // data may be removed and recommends export as the only backup.
  const ensurePersistenceOnce = useCallback(async () => {
    if (persistRequested.current) return persistent;
    persistRequested.current = true;
    const granted = await ensurePersistentStorage();
    setPersistent(granted);
    return granted;
  }, [persistent]);

  const openScenario = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const list = (await getScenarioStore().list()) as LibraryEntry[];
        const entry = list.find((item) => item.id === id);
        if (!entry) {
          setError('That scenario is no longer in the library.');
          return;
        }
        // Entries that cannot be read are never opened, and documents with a
        // newer format version are refused: the stored data is left untouched.
        if (entry.status !== 'ok') {
          setError(entry.cause || 'This scenario cannot be opened.');
          await refreshLibrary();
          return;
        }
        const loaded = await getScenarioStore().load(id);
        if (!loaded) {
          setError('That scenario is no longer in the library.');
          return;
        }
        if (isUnsupportedDocument(loaded)) {
          setError(
            `This scenario needs a newer application (format version ${loaded.formatVersion}); the stored data was left untouched.`,
          );
          await refreshLibrary();
          return;
        }
        // Ruleset mismatch: an unknown identifier or a newer version of the
        // same ruleset is never opened, and the stored data is left
        // untouched. An older version opens against the current catalogue.
        const reference = classifyRulesetReference(loaded.ruleset);
        if (reference.status === 'unknown-ruleset' || reference.status === 'newer') {
          setError(
            reference.status === 'unknown-ruleset'
              ? `This scenario references an ${reference.cause}; the stored data was left untouched.`
              : `This scenario ${reference.cause}.`,
          );
          await refreshLibrary();
          return;
        }
        setDocument(loaded);
        setSavedDocument(cloneScenario(loaded));
        // A reopened scenario starts with a clean slate: the undo history is
        // empty, so undo is unavailable until the first new change.
        setHistory(createHistory());
        setRevision(Number.isInteger(entry.revision) ? (entry.revision as number) : null);
        setSaveError(null);
        setConflict(null);
        setOpenId(id);
        const url = new URL(window.location.href);
        url.searchParams.set('scenario', id);
        window.history.replaceState(null, '', url);
      } catch (openError) {
        setError(openError instanceof Error ? openError.message : String(openError));
      }
    },
    [refreshLibrary],
  );

  // Resuming a stored battle reloads the identical state: the battle keeps
  // its own scenario snapshot, so editing the scenario never changes it.
  const resumeBattle = useCallback(
    async (id: string) => {
      setBattleError(null);
      try {
        const stored = await getBattleStore().load(id);
        if (!stored) {
          setBattleError('That battle is no longer stored.');
          await refreshBattles();
          return;
        }
        setBattle(stored.battle);
        setDecisions(Array.isArray(stored.decisions) ? stored.decisions : []);
        setAwaitingHandoff(false);
        setHandoffSide(null);
        // The starting-side announcement belongs to the first turn only: a
        // resumed battle that already resolved a turn shows no announcement.
        const resolved = (stored.battle?.events || []).some(
          (event: any) =>
            event?.type === 'turn-resolved' ||
            event?.type === 'turn-conceded' ||
            event?.type === 'battle-ended',
        );
        const startedSide = (stored.battle?.scenario?.sides || []).find(
          (side: any) => side?.id === stored.battle?.startingSide,
        );
        setAnnouncement(
          !resolved && startedSide ? `${startedSide.name} begins — round 1, turn 1.` : null,
        );
        setResolveError(null);
        setResolving(false);
        setSetupId(null);
        setSetupDocument(null);
        setSetupProblems([]);
        setOpenId(null);
        setDocument(null);
        setSavedDocument(null);
        setUrlParams({ scenario: null, battle: id });
      } catch (resumeError) {
        setBattleError(
          resumeError instanceof Error ? resumeError.message : String(resumeError),
        );
      }
    },
    [refreshBattles],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshLibrary();
      await refreshBattles();
      if (cancelled) return;
      setLoading(false);
      const battleParam = battleIdFromUrl();
      if (battleParam) {
        await resumeBattle(battleParam);
        return;
      }
      const id = scenarioIdFromUrl();
      if (id) {
        await openScenario(id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshLibrary, refreshBattles, resumeBattle, openScenario]);

  // Scenario-library actions live in ./home/scenario-actions (pure move, no behaviour change).

  // Drops the open scenario and its editing state. A battle started from the
  // editor keeps the scenario open underneath, so leaving the battle flow for
  // the library must close it too, or the editor would reappear.
  function closeEditor() {
    setOpenId(null);
    setDocument(null);
    setSavedDocument(null);
    setHistory(createHistory());
    setRevision(null);
    setSaveError(null);
    setConflict(null);
  }

  // Battle-flow actions live in ./home/battle-actions (pure move, no behaviour change).

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2400);
  }

  const headerTitle =
    battle && battle.scenario
      ? battle.scenario.title
      : document && openId
        ? document.title
        : setupDocument && setupId
          ? setupDocument.title
          : 'Scenario library';
  const dirty = !!document && !!savedDocument && !documentsMatch(document, savedDocument);
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

  // Pure move: handlers close over the same state and setters each render.
  const {
    handleCreate,
    handleSave,
    handleChange,
    handleUndo,
    handleRedo,
    handleSaveConflictCopy,
    handleDuplicate,
    handleDelete,
    handleExport,
    handleExportRaw,
    handleImportFile,
    handleBack,
  } = createScenarioActions({
    creating,
    setCreating,
    error,
    setError,
    openId,
    setOpenId,
    document,
    setDocument,
    savedDocument,
    setSavedDocument,
    history,
    setHistory,
    revision,
    setRevision,
    saveError,
    setSaveError,
    saving,
    setSaving,
    conflict,
    setConflict,
    importError,
    setImportError,
    dirty,
    closeEditor,
    refreshLibrary,
    ensurePersistenceOnce,
    openScenario,
    showToast,
  });
  const {
    handleStartBattleFromLibrary,
    handleStartBattleFromEditor,
    handleBegin,
    handleCommitDraft,
    handleCommitEmpty,
    handleConcede,
    handleRematch,
    handleOpenBattleScenarioInEditor,
    handleContinueAutomated,
    handleHandoff,
    handleBackToLibrary,
    handleOpenSetupInEditor,
    handleDeleteBattle,
  } = createBattleActions({
    openId,
    setOpenId,
    document,
    setDocument,
    setSavedDocument,
    battles,
    setBattles,
    setupId,
    setSetupId,
    setupDocument,
    setSetupDocument,
    setupProblems,
    setSetupProblems,
    battle,
    setBattle,
    decisions,
    setDecisions,
    announcement,
    setAnnouncement,
    resolving,
    setResolving,
    resolveError,
    setResolveError,
    awaitingHandoff,
    setAwaitingHandoff,
    handoffSide,
    setHandoffSide,
    battleError,
    setBattleError,
    dirty,
    refreshLibrary,
    refreshBattles,
    openScenario,
    closeEditor,
    showToast,
  });

  // Leaving the editor (reload, close, navigate) with unsaved changes asks
  // for confirmation; the in-editor back button confirms on its own.
  useEffect(() => {
    if (!dirty) return undefined;
    const guard = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  return (
    <>
      <div className="app" data-testid="app">
        <header className="app-header">
          <div className="brand">
            PÓLIS<small>ANCIENT BATTLE LAB</small>
          </div>
          <div className="header-divider" aria-hidden="true" />
          <div className="scenario-title">
            <span className="eyebrow">{openId ? 'OPEN SCENARIO' : 'PÓLIS'}</span>
            <strong data-testid="header-title">{headerTitle}</strong>
          </div>
          <div className="topbar-actions">
            {dirty ? (
              <span className="status" data-testid="header-dirty">
                Unsaved changes
              </span>
            ) : null}
          </div>
        </header>
        {battle ? (
          <BattleScreen
            battle={battle}
            announcement={announcement}
            resolving={resolving}
            resolveError={resolveError}
            awaitingHandoff={awaitingHandoff}
            handoffSide={handoffSide}
            onHandoff={handleHandoff}
            onCommitEmpty={handleCommitEmpty}
            onCommitDraft={handleCommitDraft}
            onContinueAutomated={handleContinueAutomated}
            onConcede={handleConcede}
            onRematch={handleRematch}
            onOpenScenarioInEditor={handleOpenBattleScenarioInEditor}
            onBackToLibrary={handleBackToLibrary}
          />
        ) : setupDocument && setupId ? (
          <BattleSetup
            scenario={setupDocument}
            problems={setupProblems}
            onBegin={handleBegin}
            onOpenInEditor={handleOpenSetupInEditor}
            onBack={handleBackToLibrary}
          />
        ) : document && openId ? (
          <>
            <Editor
              document={document}
              dirty={dirty}
              saveError={saveError}
              saving={saving}
              revision={revision}
              canUndo={canUndo}
              canRedo={canRedo}
              onChange={handleChange}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onSave={handleSave}
              onExport={() => handleExport(null)}
              onBack={handleBack}
              onStartBattle={handleStartBattleFromEditor}
            />
            {conflict ? (
              <div className="conflict-backdrop" data-testid="conflict-dialog">
                <section
                  className="conflict-dialog"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="conflict-title"
                >
                  <h2 id="conflict-title">This scenario changed elsewhere</h2>
                  <p>
                    The stored copy is now at revision {String(conflict.storedRevision)}, but this
                    editor opened revision {String(conflict.loadedRevision)}. Overwriting replaces
                    the stored copy; saving as a copy keeps both under a new identifier.
                  </p>
                  <div className="conflict-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      data-testid="conflict-overwrite"
                      onClick={() => handleSave({ overwrite: true })}
                    >
                      Overwrite
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="conflict-copy"
                      onClick={handleSaveConflictCopy}
                    >
                      Save as copy
                    </button>
                    <button
                      type="button"
                      className="btn-quiet"
                      data-testid="conflict-cancel"
                      onClick={() => setConflict(null)}
                    >
                      Cancel
                    </button>
                  </div>
                </section>
              </div>
            ) : null}
          </>
        ) : (
          <>
            <Library
              entries={entries}
              loading={loading}
              error={error}
              persistent={persistent}
              importError={importError}
              onCreate={handleCreate}
              onOpen={openScenario}
              onStartBattle={handleStartBattleFromLibrary}
              onDuplicate={handleDuplicate}
              onDelete={handleDelete}
              onExport={(id) => handleExport(id)}
              onExportRaw={handleExportRaw}
              onImportFile={handleImportFile}
              creating={creating}
            />
            {battleError ? (
              <p className="validation" role="alert" data-testid="battle-error">
                {battleError}
              </p>
            ) : null}
            <BattlesList
              battles={battles}
              onResume={resumeBattle}
              onDelete={handleDeleteBattle}
            />
          </>
        )}
        <div id="toast" role="status" aria-live="polite" className={toast ? 'visible' : ''}>
          {toast}
        </div>
      </div>
    </>
  );
}
