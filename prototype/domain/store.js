// PÓLIS tracer bullet — the narrow scenario store interface (ADR 0003).
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
//   list()   -> Promise<ScenarioMetadata[]>
//   load(id) -> Promise<ScenarioDocument | null>
//   save(document) -> Promise<ScenarioMetadata>
//   remove(id) -> Promise<boolean>
//   clear()  -> Promise<void>
// ScenarioMetadata: { id, title, revision, updatedAt }.
// save() validates the document, assigns revision 1 to a new id and
// increments it on every subsequent save of the same id. The document id is
// immutable: a save never changes it. Implementations must deep-clone across
// the boundary so callers cannot mutate stored state.

import { assertValidScenario, cloneScenario } from './scenario.js';

export class MemoryScenarioStore {
  constructor() {
    this.records = new Map();
  }

  async list() {
    return [...this.records.values()]
      .map((record) => ({ ...record.metadata }))
      .sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      );
  }

  async load(id) {
    const record = this.records.get(id);
    return record ? cloneScenario(record.document) : null;
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
