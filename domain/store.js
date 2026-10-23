// PÓLIS scenario library — the narrow scenario store interface (ADR 0003).
//
// The scenario library sits behind this interface so browser storage
// (IndexedDB) can later be replaced by server storage without changing the
// editor. The interface is framework-free: it imports only the domain model.
//
// Document vs metadata: a stored document carries the document kind, an
// integer format version, and the ruleset reference. Library metadata — the
// revision counter and the last-modified timestamp — is kept apart from the
// document and travels in the metadata records returned by the store.
//
// Interface (every implementation must honour it):
//   list()   -> Promise<ScenarioMetadata[]> (entries carry a status and, when
//             they cannot be opened, a cause: { id, title, revision,
//             updatedAt, status, cause }; status is 'ok', 'unreadable', or
//             'unsupported-version')
//   load(id) -> Promise<ScenarioDocument | null>
//   loadRaw(id) -> Promise<stored record | null> (the raw record, for raw
//             export of entries that cannot be read; deep-cloned)
//   save(document) -> Promise<ScenarioMetadata>
//   remove(id) -> Promise<boolean>
//   clear()  -> Promise<void>
// ScenarioMetadata: { id, title, revision, updatedAt }.
// save() validates the document, assigns revision 1 to a new id and
// increments it on every subsequent save of the same id. The document id is
// immutable: a save never changes it. Implementations must deep-clone across
// the boundary so callers cannot mutate stored state.
// save() is atomic: it validates and clones before mutating anything, so a
// failure (for example a simulated quota error) rejects and leaves the
// previous version intact.

import { assertValidScenario, cloneScenario } from './scenario.js';
import { classifyStoredRecord, compareLibraryEntries } from './library.js';

export class MemoryScenarioStore {
  constructor() {
    this.records = new Map();
  }

  async list() {
    return [...this.records.values()]
      .map((record) =>
        classifyStoredRecord({
          id: record.metadata.id,
          document: record.document,
          revision: record.metadata.revision,
          updatedAt: record.metadata.updatedAt,
        }),
      )
      .sort(compareLibraryEntries);
  }

  async load(id) {
    const record = this.records.get(id);
    return record ? cloneScenario(record.document) : null;
  }

  async loadRaw(id) {
    const record = this.records.get(id);
    if (!record) return null;
    return JSON.parse(
      JSON.stringify({
        id: record.metadata.id,
        document: record.document,
        revision: record.metadata.revision,
        updatedAt: record.metadata.updatedAt,
      }),
    );
  }

  async save(document) {
    assertValidScenario(document);
    const previous = this.records.get(document.id);
    const stored = cloneScenario(document);
    stored.updatedAt = new Date().toISOString();
    const metadata = {
      id: stored.id,
      title: stored.title,
      revision: previous ? previous.metadata.revision + 1 : 1,
      updatedAt: stored.updatedAt,
    };
    this.records.set(stored.id, { document: stored, metadata });
    return { ...metadata };
  }

  async remove(id) {
    return this.records.delete(id);
  }

  async clear() {
    this.records.clear();
  }
}
