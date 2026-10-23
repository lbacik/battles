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
  status: 'ok' | 'unreadable' | 'unsupported-version';
  cause: string | null;
}

export function formatSavedAt(updatedAt: string | null): string {
  if (!updatedAt) return 'never saved';
  const date = new Date(updatedAt);
  if (Number.isNaN(date.getTime())) return 'never saved';
  return date.toLocaleString();
}

// True when two scenario documents hold identical content. Key order is
// ignored so a reload or clone that reorders keys still counts as unchanged.
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, canonicalize(entry)] as const)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

export function documentsMatch(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
}
