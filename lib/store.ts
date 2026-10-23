// Client-side scenario storage for the PÓLIS app.
//
// The editor talks to browser storage only through the narrow scenario store
// interface (ADR 0003): the IndexedDB implementation from the framework-free
// domain package. This module is a thin client-only singleton wrapper so
// React components never touch `indexedDB` during server prerendering.

import { IndexedDBScenarioStore } from '../domain/browser/idb.js';

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
  status: string;
  cause: string | null;
}

export function formatSavedAt(updatedAt: string | null): string {
  if (!updatedAt) return 'never saved';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return 'never saved';
  return date.toLocaleString();
}

// The scenario differs from the last saved version.
export function documentsMatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
