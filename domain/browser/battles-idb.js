// PÓLIS tracer bullet — IndexedDB implementation of the battle store
// interface. This is a storage adapter, not domain code: it imports only the
// framework-free domain model, never React or Next.js.
//
// Each record is stored as { id, battle, decisions, revision, updatedAt }
// keyed by the battle id. The revision counter lives on the record, never
// inside the battle itself. The battles collection is separate from the
// scenarios collection (ADR 0003): editing a scenario never touches a started
// battle, because the battle keeps its own scenario snapshot.

import {
  assertValidBattle,
  assertValidDecisions,
  cloneBattle,
  cloneDecisions,
  compareBattleEntries,
} from '../battles.js';

export const BATTLE_DB_NAME = 'polis-battles';
const RECORD_STORE = 'battles';

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function recordStore(database, mode) {
  return database.transaction(RECORD_STORE, mode).objectStore(RECORD_STORE);
}

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(RECORD_STORE)) {
        request.result.createObjectStore(RECORD_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function metadataOf(record) {
  const battle = record?.battle;
  const scenario = battle?.scenario;
  return {
    id: record.id,
    title:
      scenario && typeof scenario.title === 'string' && scenario.title.trim()
        ? scenario.title
        : '(untitled battle)',
    scenarioId: scenario && typeof scenario.id === 'string' ? scenario.id : null,
    status: typeof battle?.status === 'string' ? battle.status : 'unknown',
    turnNumber: Number.isInteger(battle?.turnNumber) ? battle.turnNumber : null,
    round: Number.isInteger(battle?.round) ? battle.round : null,
    activeSide: typeof battle?.activeSide === 'string' ? battle.activeSide : null,
    revision: record.revision,
    updatedAt: record.updatedAt,
  };
}

function cloneRecord(record) {
  return JSON.parse(JSON.stringify(record));
}

export class IndexedDBBattleStore {
  constructor(options = {}) {
    this.dbName = options.dbName || BATTLE_DB_NAME;
    this.database = null;
  }

  async open() {
    if (!this.database) {
      this.database = await openDatabase(this.dbName);
    }
    return this.database;
  }

  close() {
    if (this.database) {
      this.database.close();
      this.database = null;
    }
  }

  async list() {
    const database = await this.open();
    const records = await requestToPromise(recordStore(database, 'readonly').getAll());
    return records.map(metadataOf).sort(compareBattleEntries);
  }

  async load(id) {
    const database = await this.open();
    const record = await requestToPromise(recordStore(database, 'readonly').get(id));
    if (!record) return null;
    return {
      battle: cloneBattle(record.battle),
      decisions: cloneDecisions(record.decisions),
    };
  }

  // The raw stored record, deep-cloned.
  async loadRaw(id) {
    const database = await this.open();
    const record = await requestToPromise(recordStore(database, 'readonly').get(id));
    return record ? cloneRecord(record) : null;
  }

  async save(battle, decisions = []) {
    assertValidBattle(battle);
    assertValidDecisions(decisions);
    const database = await this.open();
    const store = recordStore(database, 'readwrite');
    const previous = await requestToPromise(store.get(battle.id));
    const storedBattle = cloneBattle(battle);
    const storedDecisions = cloneDecisions(decisions);
    const updatedAt = new Date().toISOString();
    const revision = previous ? previous.revision + 1 : 1;
    await requestToPromise(
      store.put({ id: storedBattle.id, battle: storedBattle, decisions: storedDecisions, revision, updatedAt }),
    );
    return metadataOf({ id: storedBattle.id, battle: storedBattle, revision, updatedAt });
  }

  async remove(id) {
    const database = await this.open();
    const store = recordStore(database, 'readwrite');
    const previous = await requestToPromise(store.get(id));
    if (!previous) return false;
    await requestToPromise(store.delete(id));
    return true;
  }

  async clear() {
    const database = await this.open();
    await requestToPromise(recordStore(database, 'readwrite').clear());
  }
}
