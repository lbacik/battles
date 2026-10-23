'use client';

// PÓLIS walking skeleton: scenario library → new scenario → empty
// battlefield editor → save → reload → reopen. Client-only: every store call
// runs in an effect, so the static prerender never touches IndexedDB.

import { useCallback, useEffect, useState } from 'react';
import Editor from './editor';
import Library from './library';
import { documentsMatch, getScenarioStore, type LibraryEntry } from '../lib/store';
import { cloneScenario, createScenario } from '../domain/scenario.js';

type ScenarioDocument = any;

function scenarioIdFromUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const id = new URLSearchParams(window.location.search).get('scenario');
  return id && id.trim() ? id : null;
}

export default function Home() {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [document, setDocument] = useState<ScenarioDocument | null>(null);
  const [savedDocument, setSavedDocument] = useState<ScenarioDocument | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const refreshLibrary = useCallback(async () => {
    try {
      const list = await getScenarioStore().list();
      setEntries((list as LibraryEntry[]).filter((entry) => entry.status === 'ok'));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, []);

  const openScenario = useCallback(
    async (id: string) => {
      setError(null);
      try {
        const loaded = await getScenarioStore().load(id);
        if (!loaded) {
          setError('That scenario is no longer in the library.');
          return;
        }
        setDocument(loaded);
        setSavedDocument(cloneScenario(loaded));
        setSaveError(null);
        setOpenId(id);
        const url = new URL(window.location.href);
        url.searchParams.set('scenario', id);
        window.history.replaceState(null, '', url);
      } catch (openError) {
        setError(openError instanceof Error ? openError.message : String(openError));
      }
    },
    [],
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
      const created = createScenario({ title });
      const metadata = await getScenarioStore().save(created);
      await refreshLibrary();
      await openScenario(metadata.id);
      showToast('Scenario created.');
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setCreating(false);
    }
  }

  async function handleSave() {
    if (!document) return;
    setSaving(true);
    setSaveError(null);
    try {
      await getScenarioStore().save(document);
      setSavedDocument(cloneScenario(document));
      await refreshLibrary();
      showToast('Scenario saved.');
    } catch (saveFailure) {
      setSaveError(saveFailure instanceof Error ? saveFailure.message : String(saveFailure));
    } finally {
      setSaving(false);
    }
  }

  function handleBack() {
    setOpenId(null);
    setDocument(null);
    setSavedDocument(null);
    setSaveError(null);
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

  return (
    <div className="app" data-testid="app">
      <div id="narrow-notice" role="alert">
        <h1>PÓLIS scenario editor</h1>
        <p>
          The scenario editor needs a viewport at least <strong>1280&nbsp;px</strong> wide: order
          of battle, map, and inspector sit side by side by design. Please widen the window or use
          a larger display.
        </p>
      </div>
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
        <Editor
          document={document}
          savedDocument={savedDocument}
          saveError={saveError}
          saving={saving}
          onChange={setDocument}
          onSave={handleSave}
          onBack={handleBack}
        />
      ) : (
        <Library
          entries={entries}
          loading={loading}
          error={error}
          onCreate={handleCreate}
          onOpen={openScenario}
          creating={creating}
        />
      )}
      <div id="toast" role="status" aria-live="polite" className={toast ? 'visible' : ''}>
        {toast}
      </div>
    </div>
  );
}
