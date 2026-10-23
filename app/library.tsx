'use client';

import { useState } from 'react';
import { formatSavedAt, type LibraryEntry } from '../lib/store';

interface LibraryProps {
  entries: LibraryEntry[];
  loading: boolean;
  error: string | null;
  onCreate: (title: string) => Promise<void>;
  onOpen: (id: string) => void;
  creating: boolean;
}

export default function Library({ entries, loading, error, onCreate, onOpen, creating }: LibraryProps) {
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
        Create a scenario, open its empty battlefield in the editor, save it, and reopen it after a
        reload. Stored in this browser.
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
      </form>
      {formError ? (
        <p className="validation" role="alert">
          {formError}
        </p>
      ) : null}
      {loading ? (
        <div className="empty-library" data-testid="library-loading">
          Loading scenarios…
        </div>
      ) : entries.length ? (
        <ul className="scenario-list" data-testid="scenario-list">
          {entries.map((entry) => (
            <li key={entry.id ?? entry.title} data-testid="scenario-row">
              <div>
                <div className="title" data-testid="scenario-row-title">
                  {entry.title}
                </div>
                <div className="meta" data-testid="scenario-row-meta">
                  Last saved {formatSavedAt(entry.updatedAt)}
                </div>
              </div>
              <div className="actions">
                {entry.id ? (
                  <button
                    type="button"
                    className="btn-secondary"
                    data-testid="open-scenario"
                    onClick={() => onOpen(entry.id as string)}
                  >
                    Open
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty-library" data-testid="empty-library">
          No scenarios yet. Give the new scenario a title above to create the first one.
        </div>
      )}
      {error ? (
        <p className="validation" role="alert">
          {error}
        </p>
      ) : null}
      <p className="storage-note">
        Library lives in IndexedDB on this device; clearing site data removes it.
      </p>
    </div>
  );
}
