// Client-side battle storage for the PÓLIS app.
//
// Battles live in their own IndexedDB collection, separate from scenarios
// (ADR 0003): every committed turn is saved, and reloading the page
// mid-battle resumes the identical state from here. This module is a thin
// client-only singleton wrapper so React components never touch `indexedDB`
// during server prerendering.

import { IndexedDBBattleStore } from '../domain/browser/battles-idb.js';

let store: IndexedDBBattleStore | null = null;

export function getBattleStore(): IndexedDBBattleStore {
  if (typeof window === 'undefined') {
    throw new Error('Battle storage is only available in the browser.');
  }
  if (!store) {
    store = new IndexedDBBattleStore();
  }
  return store;
}

export interface BattleEntry {
  id: string;
  title: string;
  scenarioId: string | null;
  status: string;
  turnNumber: number | null;
  round: number | null;
  activeSide: string | null;
  revision: number;
  updatedAt: string;
}
