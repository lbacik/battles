// Client-side scenario storage for the PÓLIS app.
//
// The editor talks to browser storage only through the narrow scenario store
// interface (ADR 0003): the IndexedDB implementation from the framework-free
// domain package. This module is a thin client-only singleton wrapper so
// React components never touch `indexedDB` during server prerendering.

import { IndexedDBScenarioStore } from '../domain/browser/idb.js';
import { scenarioContentEquals } from '../domain/scenario.js';

let store: IndexedDBScenarioStore | null = null;

export function getScenarioStore(): IndexedDBScenarioStore {
  if (typeof window === 'undefined') {
    throw new Error('Scenario storage is only available in the browser.');
  }
  if (!store) {
    store = new IndexedDBScenarioStore();
  }
  return store;
}

export interface LibraryEntry {
  id: string | null;
  title: string;
  revision: number | null;
  updatedAt: string | null;
  status: 'ok' | 'unreadable' | 'unsupported-version';
  cause: string | null;
}

export function formatSavedAt(updatedAt: string | null): string {
  if (!updatedAt) return 'never saved';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return 'never saved';
  return date.toLocaleString();
}

// True when two scenario documents hold identical content: the predicate
// behind the editor's unsaved-changes indicator. The canonical comparison
// lives in the framework-free domain package (and is unit-tested there);
// this module only re-exports it so the app keeps a single dirty source.
export function documentsMatch(a: unknown, b: unknown): boolean {
  return scenarioContentEquals(a, b);
}
