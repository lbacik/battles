'use client';

import { useState } from 'react';
import { formatSavedAt, type LibraryEntry } from '../lib/store';

interface LibraryProps {
  entries: LibraryEntry[];
  loading: boolean;
  error: string | null;
  persistent: boolean | null;
  importError: string | null;
  onCreate: (title: string) => Promise<void>;
  onOpen: (id: string) => void;
  onStartBattle: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onExportRaw: (id: string) => void;
  onImportFile: (file: File) => void;
  creating: boolean;
}

function entryLabel(entry: LibraryEntry): string {
  if (entry.status === 'unsupported-version') return 'Needs a newer application';
  return 'Unreadable';
}

export default function Library({
  entries,
  loading,
  error,
  persistent,
  importError,
  onCreate,
  onOpen,
  onStartBattle,
  onDuplicate,
  onDelete,
  onExport,
  onExportRaw,
  onImportFile,
  creating,
}: LibraryProps) {
  const [title, setTitle] = useState('');
  const [formError, setFormError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) {
      setFormError('A title is required to create a scenario.');
      return;
    }
    setFormError(null);
    await onCreate(trimmed);
    setTitle('');
  }

  return (
    <div className="library">
      <span className="eyebrow">PÓLIS · SCENARIO LIBRARY</span>
      <h1>Scenarios</h1>
      <p className="lede">
        Create a scenario, open its battlefield in the editor, save it, and reopen it after a
        reload. Export a scenario to a JSON file to move or back it up; importing a file always
        adds a new copy. Stored in this browser.
      </p>
      <form className="new-scenario" onSubmit={handleSubmit}>
        <input
          data-testid="new-scenario-title"
          name="title"
          placeholder="New scenario title (required)"
          value={title}
          maxLength={120}
          aria-label="New scenario title"
          onChange={(event) => setTitle(event.target.value)}
        />
        <button
          type="submit"
          className="btn-primary"
          data-testid="new-scenario-submit"
          disabled={!title.trim() || creating}
        >
          New scenario
        </button>
        <label className="btn-secondary import-label" htmlFor="import-file" data-testid="import-label">
          Import JSON
        </label>
        <input
          type="file"
          id="import-file"
          data-testid="import-file"
          accept=".json,application/json"
          hidden
          onChange={(event) => {
            const [file] = event.target.files || [];
            if (file) onImportFile(file);
            event.target.value = '';
          }}
        />
      </form>
      {formError ? (
        <p className="validation" role="alert">
          {formError}
        </p>
      ) : null}
      {importError ? (
        <p className="validation" role="alert" data-testid="import-error">
          {importError}
        </p>
      ) : null}
      {loading ? (
        <div className="empty-library" data-testid="library-loading">
          Loading scenarios…
        </div>
      ) : entries.length ? (
        <ul className="scenario-list" data-testid="scenario-list">
          {entries.map((entry) => (
            <li
              key={entry.id ?? entry.title}
              data-testid="scenario-row"
              className={entry.status === 'ok' ? '' : 'unreadable'}
            >
              <div>
                <div className="title" data-testid="scenario-row-title">
                  {entry.title}
                </div>
                {entry.status === 'ok' ? (
                  <div className="meta" data-testid="scenario-row-meta">
                    Revision {entry.revision} · Last saved {formatSavedAt(entry.updatedAt)}
                  </div>
                ) : (
                  <div className="meta" data-testid="scenario-row-cause">
                    {entryLabel(entry)} · {entry.cause || 'unknown cause'}
                  </div>
                )}
              </div>
              <div className="actions">
                {entry.status === 'ok' && entry.id ? (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="open-scenario"
                      onClick={() => onOpen(entry.id as string)}
                    >
                      Open
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="start-battle"
                      onClick={() => onStartBattle(entry.id as string)}
                    >
                      Start battle
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="duplicate-scenario"
                      onClick={() => onDuplicate(entry.id as string)}
                    >
                      Duplicate
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="export-scenario"
                      onClick={() => onExport(entry.id as string)}
                    >
                      Export
                    </button>
                    <button
                      type="button"
                      className="btn-quiet btn-danger"
                      data-testid="delete-scenario"
                      onClick={() => onDelete(entry.id as string)}
                    >
                      Delete
                    </button>
                  </>
                ) : entry.id ? (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="export-raw-scenario"
                      onClick={() => onExportRaw(entry.id as string)}
                    >
                      Export raw
                    </button>
                    <button
                      type="button"
                      className="btn-quiet btn-danger"
                      data-testid="delete-scenario"
                      onClick={() => onDelete(entry.id as string)}
                    >
                      Delete
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-library" data-testid="empty-library">
          No scenarios yet. Give the new scenario a title above to create the first one, or import
          an exported JSON file.
        </div>
      )}
      {error ? (
        <p className="validation" role="alert">
          {error}
        </p>
      ) : null}
      <p className="storage-note" data-testid="storage-note">
        {persistent === false
          ? 'Browser persistent storage was refused: scenarios may be evicted, so export is the only backup. '
          : null}
        Library lives in IndexedDB on this device; clearing site data removes it.
      </p>
    </div>
  );
}
