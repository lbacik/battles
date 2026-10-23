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
import { documentsMatch, getScenarioStore, type LibraryEntry } from '../lib/store';
import {
  classifyRulesetReference,
  cloneScenario,
  createHistory,
  createScenario,
  exportScenario,
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

function scenarioIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const id = new URLSearchParams(window.location.search).get('scenario');
  return id && id.trim() ? id : null;
}

function downloadFile(fileName: string, text: string) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Quota failures never lose work: the store save is atomic, so the previous
// version is intact and the author keeps the same unsaved changes.
function quotaFailureMessage(what: string): string {
  return (
    `${what} failed: browser storage is full (quota exceeded). ` +
    'The previous version is intact; your changes are still here.'
  );
}

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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshLibrary();
      if (cancelled) return;
      setLoading(false);
      const id = scenarioIdFromUrl();
      if (id) {
        await openScenario(id);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshLibrary, openScenario]);

  async function handleCreate(title: string) {
    setCreating(true);
    setError(null);
    try {
      await ensurePersistenceOnce();
      const created = createScenario({ title });
      const metadata = await getScenarioStore().save(created);
      await refreshLibrary();
      await openScenario(metadata.id);
      showToast('Scenario created.');
    } catch (createError) {
      if (isQuotaError(createError)) {
        setError(quotaFailureMessage('Create'));
      } else {
        setError(createError instanceof Error ? createError.message : String(createError));
      }
    } finally {
      setCreating(false);
    }
  }

  // Fold an older ruleset reference into the installed one as part of an
  // explicit Save. Opening never rebinds, so a scenario that only sits in
  // the editor keeps its stored reference; the rebound version is what Save
  // validates and stores.
  function withRulesetRebind(candidate: ScenarioDocument): ScenarioDocument {
    try {
      if (classifyRulesetReference(candidate?.ruleset).status === 'older') {
        return rebindRulesetToCurrent(candidate);
      }
    } catch {
      // Validation below reports malformed references.
    }
    return candidate;
  }

  async function handleSave(options: { overwrite?: boolean } = {}) {
    if (!document) return;
    const overwrite = options.overwrite === true;
    // An explicit Save rebinds an older ruleset reference to the installed
    // catalogue. Opening never rebinds: only this path changes the
    // reference, and the rebound document is what is validated and stored.
    // Unknown troop-type keys are preserved verbatim either way.
    // Structural errors block saving; warnings and the ruleset notice never
    // do: a scenario with warnings still saves.
    const candidate = withRulesetRebind(document);
    if (JSON.stringify(candidate?.ruleset) !== JSON.stringify(document?.ruleset)) {
      setDocument(candidate);
    }
    const problems = validateScenario(candidate);
    if (problems.length) {
      setSaveError('Cannot save: fix the highlighted problems.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await ensurePersistenceOnce();
      const storedEntry = ((await getScenarioStore().list()) as LibraryEntry[]).find(
        (item) => item.id === candidate.id,
      );
      const storedRevision =
        storedEntry && Number.isInteger(storedEntry.revision)
          ? (storedEntry.revision as number)
          : null;
      const metadata = await performSave(getScenarioStore(), candidate, {
        loadedRevision: revision,
        storedRevision,
        overwrite,
      });
      const reloaded = await getScenarioStore().load(metadata.id);
      setDocument(reloaded ?? candidate);
      setSavedDocument(cloneScenario(reloaded ?? candidate));
      setRevision(metadata.revision);
      setConflict(null);
      setSaveError(null);
      await refreshLibrary();
      showToast('Scenario saved.');
    } catch (saveFailure) {
      if (saveFailure instanceof SaveConflictError) {
        // Nothing has been stored: the author chooses between overwriting
        // and saving as a copy.
        setConflict({
          loadedRevision: saveFailure.loadedRevision,
          storedRevision: saveFailure.storedRevision,
        });
        return;
      }
      // The store save is atomic: a failure (for example a quota error)
      // leaves the previous version intact, so the author keeps working on
      // the same unsaved changes instead of losing them.
      if (isQuotaError(saveFailure)) {
        setSaveError(quotaFailureMessage('Save'));
      } else {
        setSaveError(saveFailure instanceof Error ? saveFailure.message : String(saveFailure));
      }
    } finally {
      setSaving(false);
    }
  }

  function handleChange(next: ScenarioDocument) {
    if (!document || documentsMatch(next, document)) return;
    setHistory(historyCommit(history, cloneScenario(document)));
    setDocument(next);
  }

  function handleUndo() {
    if (!document) return;
    const stepped = historyUndo(history, cloneScenario(document));
    if (!stepped) return;
    setHistory(stepped.history);
    setDocument(stepped.document);
  }

  function handleRedo() {
    if (!document) return;
    const stepped = historyRedo(history, cloneScenario(document));
    if (!stepped) return;
    setHistory(stepped.history);
    setDocument(stepped.document);
  }

  async function handleSaveConflictCopy() {
    if (!document) return;
    setConflict(null);
    setSaving(true);
    setSaveError(null);
    try {
      await ensurePersistenceOnce();
      const copy = duplicateScenario(withRulesetRebind(document));
      const metadata = await getScenarioStore().save(copy);
      await refreshLibrary();
      await openScenario(metadata.id);
      showToast(`Saved as a new copy: ${copy.title}.`);
    } catch (copyFailure) {
      if (isQuotaError(copyFailure)) {
        setSaveError(quotaFailureMessage('Save as copy'));
      } else {
        setSaveError(copyFailure instanceof Error ? copyFailure.message : String(copyFailure));
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDuplicate(id: string) {
    setError(null);
    try {
      const source = await getScenarioStore().load(id);
      if (!source) {
        setError('That scenario is no longer in the library.');
        await refreshLibrary();
        return;
      }
      if (isUnsupportedDocument(source)) {
        setError(
          `Cannot duplicate: this scenario needs a newer application (format version ${source.formatVersion}).`,
        );
        return;
      }
      // Duplicating never opens the scenario, but a copy of a reference
      // that cannot open is another entry that cannot open: refuse it like
      // opening.
      const reference = classifyRulesetReference(source.ruleset);
      if (reference.status === 'unknown-ruleset' || reference.status === 'newer') {
        setError(
          reference.status === 'unknown-ruleset'
            ? `Cannot duplicate: this scenario references an ${reference.cause}; the stored data was left untouched.`
            : `Cannot duplicate: this scenario ${reference.cause}.`,
        );
        return;
      }
      await ensurePersistenceOnce();
      const copy = duplicateScenario(source);
      await getScenarioStore().save(copy);
      await refreshLibrary();
      showToast(`Duplicated as "${copy.title}".`);
    } catch (duplicateError) {
      if (isQuotaError(duplicateError)) {
        setError(quotaFailureMessage('Duplicate'));
      } else {
        setError(duplicateError instanceof Error ? duplicateError.message : String(duplicateError));
      }
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm('Delete this scenario?')) return;
    try {
      await getScenarioStore().remove(id);
      if (openId === id) {
        setOpenId(null);
        setDocument(null);
        setSavedDocument(null);
        setRevision(null);
        setSaveError(null);
        setConflict(null);
        const url = new URL(window.location.href);
        url.searchParams.delete('scenario');
        window.history.replaceState(null, '', url);
      }
      await refreshLibrary();
      showToast('Scenario deleted.');
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  async function handleExport(id: string | null) {
    try {
      const source = id ? await getScenarioStore().load(id) : document;
      if (!source) {
        showToast('Nothing to export.');
        return;
      }
      const { fileName, json } = exportScenario(source);
      downloadFile(fileName, json);
      showToast(`Exported ${fileName}.`);
    } catch (exportError) {
      showToast(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function handleExportRaw(id: string) {
    try {
      const record = await getScenarioStore().loadRaw(id);
      if (!record) {
        showToast('Nothing to export.');
        return;
      }
      const { fileName, json } = exportRawRecord(record);
      downloadFile(fileName, json);
      showToast(`Exported raw ${fileName}.`);
    } catch (exportError) {
      showToast(exportError instanceof Error ? exportError.message : String(exportError));
    }
  }

  async function handleImportFile(file: File) {
    setImportError(null);
    try {
      const text = await file.text();
      // Parsing (and its specific rejection messages) runs before anything
      // is stored, so a rejected file leaves the library unchanged.
      const copy = importScenarioDocument(text);
      await ensurePersistenceOnce();
      const metadata = await getScenarioStore().save(copy);
      await refreshLibrary();
      await openScenario(metadata.id);
      showToast(`Imported as a new copy: ${copy.title}.`);
    } catch (importFailure) {
      if (isQuotaError(importFailure)) {
        setImportError(quotaFailureMessage('Import'));
      } else {
        setImportError(
          importFailure instanceof Error ? importFailure.message : String(importFailure),
        );
      }
    }
  }

  function handleBack() {
    if (dirty && !window.confirm('You have unsaved changes. Leave the editor without saving?')) {
      return;
    }
    setOpenId(null);
    setDocument(null);
    setSavedDocument(null);
    setHistory(createHistory());
    setRevision(null);
    setSaveError(null);
    setConflict(null);
    const url = new URL(window.location.href);
    url.searchParams.delete('scenario');
    window.history.replaceState(null, '', url);
    void refreshLibrary();
  }

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(null), 2400);
  }

  const headerTitle = document && openId ? document.title : 'Scenario library';
  const dirty = !!document && !!savedDocument && !documentsMatch(document, savedDocument);
  const canUndo = history.past.length > 0;
  const canRedo = history.future.length > 0;

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
      <div id="narrow-notice" role="alert">
        <h1>PÓLIS scenario editor</h1>
        <p>
          The scenario editor needs a viewport at least <strong>1280&nbsp;px</strong> wide: order
          of battle, map, and inspector sit side by side by design. Please widen the window or use
          a larger display.
        </p>
      </div>
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
        {document && openId ? (
          <>
            <Editor
              document={document}
              dirty={dirty}
              saveError={saveError}
              saving={saving}
              canUndo={canUndo}
              canRedo={canRedo}
              onChange={handleChange}
              onUndo={handleUndo}
              onRedo={handleRedo}
              onSave={handleSave}
              onExport={() => handleExport(null)}
              onBack={handleBack}
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
          <Library
            entries={entries}
            loading={loading}
            error={error}
            persistent={persistent}
            importError={importError}
            onCreate={handleCreate}
            onOpen={openScenario}
            onDuplicate={handleDuplicate}
            onDelete={handleDelete}
            onExport={(id) => handleExport(id)}
            onExportRaw={handleExportRaw}
            onImportFile={handleImportFile}
            creating={creating}
          />
        )}
        <div id="toast" role="status" aria-live="polite" className={toast ? 'visible' : ''}>
          {toast}
        </div>
      </div>
    </>
  );
}
