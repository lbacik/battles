// PÓLIS scenario library — IndexedDB implementation of the scenario store
// interface (ADR 0003). This is a storage adapter, not domain code: it
// imports only the framework-free domain model, never React or Next.js.
//
// Each record is stored as { id, document, revision, updatedAt } keyed by
// the document id. The revision counter lives on the record, never inside
// the document itself.

import { assertValidScenario, cloneScenario } from '../scenario.js';
import { classifyStoredRecord, compareLibraryEntries } from '../library.js';

export const SCENARIO_DB_NAME = 'polis-scenarios';
const RECORD_STORE = 'scenarios';

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

export class IndexedDBScenarioStore {
  constructor(options = {}) {
    this.dbName = options.dbName || SCENARIO_DB_NAME;
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
    return records
      .map((record) => classifyStoredRecord(record))
      .sort(compareLibraryEntries);
  }

  async load(id) {
    const database = await this.open();
    const record = await requestToPromise(recordStore(database, 'readonly').get(id));
    return record ? cloneScenario(record.document) : null;
  }

  // The raw stored record, deep-cloned: for raw export of library entries
  // that cannot be read (and of documents with a newer format version).
  async loadRaw(id) {
    const database = await this.open();
    const record = await requestToPromise(recordStore(database, 'readonly').get(id));
    return record ? JSON.parse(JSON.stringify(record)) : null;
  }

  async save(document) {
    assertValidScenario(document);
    const database = await this.open();
    const store = recordStore(database, 'readwrite');
    const previous = await requestToPromise(store.get(document.id));
    const stored = cloneScenario(document);
    stored.updatedAt = new Date().toISOString();
    const metadata = {
      id: stored.id,
      title: stored.title,
      revision: previous ? previous.revision + 1 : 1,
      updatedAt: stored.updatedAt,
    };
    await requestToPromise(store.put({ ...metadata, document: stored }));
    return { ...metadata };
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

// ADR 0003: the application requests persistent storage and tells the
// author when it is refused. Resolves true when persistence is granted.
export async function ensurePersistentStorage() {
  try {
    const storage = globalThis.navigator?.storage;
    if (!storage) return false;
    if (typeof storage.persist === 'function') {
      await storage.persist();
    }
    if (typeof storage.persisted === 'function') {
      return await storage.persisted();
    }
    return true;
  } catch {
    return false;
  }
}
