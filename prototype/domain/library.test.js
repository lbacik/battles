// Unit tests for the scenario library trust helpers (duplicate, revision
// conflicts, atomic failure, unreadable entries, newer format versions).
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  SCENARIO_FORMAT_VERSION,
  cloneScenario,
  createScenario,
  isUuid,
} from './scenario.js';
import { MemoryScenarioStore } from './store.js';
import {
  SaveConflictError,
  classifyStoredRecord,
  compareLibraryEntries,
  detectSaveConflict,
  duplicateScenario,
  exportRawRecord,
  isQuotaError,
  isUnsupportedDocument,
  performSave,
} from './library.js';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('duplicateScenario', () => {
  it('creates a new copy with a new identifier', async () => {
    const document = createScenario({ title: 'Mantinea' });
    const copy = duplicateScenario(document);
    assert.notEqual(copy.id, document.id);
    assert.ok(isUuid(copy.id), `expected UUID, got ${copy.id}`);
    assert.equal(copy.title, 'Mantinea (copy)');
    assert.deepEqual(copy.battlefield, document.battlefield);
    assert.deepEqual(copy.sides, document.sides);
    assert.deepEqual(copy.ruleset, document.ruleset);
    assert.deepEqual(copy.units, document.units);
    assert.deepEqual(copy.terrainFeatures, document.terrainFeatures);
    assert.ok(!Object.hasOwn(copy, 'revision'));
  });

  it('saves the original and the copy independently', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Mantinea' });
    const copy = duplicateScenario(document);
    const first = await store.save(document);
    const second = await store.save(copy);
    assert.equal(first.revision, 1);
    assert.equal(second.revision, 1);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.load(document.id)).title, 'Mantinea');
    assert.equal((await store.load(copy.id)).title, 'Mantinea (copy)');
  });

  it('refuses to duplicate what cannot be read', () => {
    assert.throws(() => duplicateScenario(null), /Cannot duplicate/);
    assert.throws(() => duplicateScenario({ kind: 'scenario' }), /Cannot duplicate/);
  });
});

describe('detectSaveConflict', () => {
  it('compares the loaded revision with the stored one', () => {
    assert.equal(detectSaveConflict(1, 1), false);
    assert.equal(detectSaveConflict(2, 2), false);
    assert.equal(detectSaveConflict(1, 2), true);
    assert.equal(detectSaveConflict(null, 1), false);
    assert.equal(detectSaveConflict(1, null), false);
    assert.equal(detectSaveConflict(null, null), false);
  });
});

describe('performSave', () => {
  it('saves when the stored revision matches the loaded one', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Mantinea' });
    const first = await store.save(document);
    const edited = { ...(await store.load(document.id)), description: 'Edited.' };
    const metadata = await performSave(store, edited, {
      loadedRevision: first.revision,
      storedRevision: first.revision,
    });
    assert.equal(metadata.revision, 2);
    assert.equal((await store.load(document.id)).description, 'Edited.');
  });

  it('raises a save conflict instead of silently overwriting', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Mantinea' });
    await store.save(document);
    const edited = await store.load(document.id);
    const otherTab = await store.load(document.id);
    // Another tab saves first: the stored revision moves to 2.
    await store.save({ ...otherTab, description: 'Other tab.' });
    await assert.rejects(
      performSave(store, { ...edited, description: 'Mine.' }, {
        loadedRevision: 1,
        storedRevision: 2,
      }),
      (error) =>
        error instanceof SaveConflictError &&
        error.code === 'save-conflict' &&
        error.loadedRevision === 1 &&
        error.storedRevision === 2,
    );
    // Nothing was stored: the other tab's version is intact.
    assert.equal((await store.load(document.id)).description, 'Other tab.');
  });

  it('overwrites only when asked and copies without conflict', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Mantinea' });
    await store.save(document);
    const edited = await store.load(document.id);
    const otherTab = await store.load(document.id);
    await store.save({ ...otherTab, description: 'Other tab.' });
    const overwritten = await performSave(
      store,
      { ...edited, description: 'Mine.' },
      { loadedRevision: 1, storedRevision: 2, overwrite: true },
    );
    assert.equal(overwritten.revision, 3);
    assert.equal((await store.load(document.id)).description, 'Mine.');
    // Saving as a copy is a fresh identifier: no conflict is possible.
    const copy = duplicateScenario(await store.load(document.id));
    const copied = await performSave(store, copy, {
      loadedRevision: null,
      storedRevision: null,
    });
    assert.equal(copied.revision, 1);
  });

  it('rejects invalid documents without touching the store', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Mantinea' });
    await store.save(document);
    await assert.rejects(
      performSave(store, { kind: 'scenario' }, { loadedRevision: 1, storedRevision: 1 }),
      /Invalid scenario/,
    );
    assert.equal((await store.load(document.id)).title, 'Mantinea');
  });

  it('lets a quota failure propagate so the caller keeps its unsaved state', async () => {
    const quota = new Error('QuotaExceededError: storage is full');
    quota.name = 'QuotaExceededError';
    assert.equal(isQuotaError(quota), true);
    const failingStore = {
      save: async () => {
        throw quota;
      },
    };
    const document = createScenario({ title: 'Mantinea' });
    let dirty = true;
    try {
      await performSave(failingStore, document, {
        loadedRevision: 1,
        storedRevision: 1,
      });
      dirty = false;
    } catch (error) {
      assert.equal(isQuotaError(error), true);
    }
    assert.equal(dirty, true);
  });
});

describe('classifyStoredRecord', () => {
  it('marks readable records as openable', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Mantinea' });
    await store.save(document);
    const [entry] = await store.list();
    assert.equal(entry.status, 'ok');
    assert.equal(entry.cause, null);
    assert.equal(entry.title, 'Mantinea');
    assert.equal(entry.revision, 1);
  });

  it('marks records without a readable document as unreadable', () => {
    for (const record of [
      null,
      { id: 'broken', revision: 1, updatedAt: 'today' },
      { id: 'broken', document: null, revision: 1, updatedAt: 'today' },
      { id: 'broken', document: { kind: 'battle' }, revision: 1, updatedAt: 'today' },
    ]) {
      const entry = classifyStoredRecord(record);
      assert.equal(entry.status, 'unreadable', JSON.stringify(record));
      assert.ok(entry.cause, 'a cause is required');
    }
    const invalid = createScenario({ title: 'Mantinea' });
    delete invalid.title;
    const entry = classifyStoredRecord({
      id: invalid.id,
      document: invalid,
      revision: 1,
      updatedAt: invalid.updatedAt,
    });
    assert.equal(entry.status, 'unreadable');
    assert.match(entry.cause, /title/);
  });

  it('marks records without a revision counter as unreadable', () => {
    const document = createScenario({ title: 'Mantinea' });
    const entry = classifyStoredRecord({
      id: document.id,
      document,
      updatedAt: document.updatedAt,
    });
    assert.equal(entry.status, 'unreadable');
    assert.match(entry.cause, /revision/);
  });

  it('marks newer format versions without touching the stored data', () => {
    const document = createScenario({ title: 'Mantinea' });
    const newer = { ...cloneScenario(document), formatVersion: SCENARIO_FORMAT_VERSION + 1 };
    const record = {
      id: newer.id,
      document: newer,
      revision: 3,
      updatedAt: newer.updatedAt,
    };
    const before = JSON.parse(JSON.stringify(record));
    const entry = classifyStoredRecord(record);
    assert.equal(entry.status, 'unsupported-version');
    assert.match(entry.cause, /newer/);
    assert.deepEqual(record, before);
  });
});

describe('exportRawRecord', () => {
  it('exports entries that cannot be read', () => {
    const record = {
      id: 'broken',
      document: { kind: 'battle', title: 'Broken' },
      revision: 1,
      updatedAt: 'today',
    };
    const { fileName, json } = exportRawRecord(record);
    assert.match(fileName, /-raw\.json$/);
    assert.deepEqual(JSON.parse(json), record.document);
  });
});

describe('library ordering and version gate', () => {
  it('sorts newest first and entries without a timestamp last', () => {
    const entries = [
      { updatedAt: null },
      { updatedAt: '2026-01-02T00:00:00.000Z' },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    assert.deepEqual(
      [...entries].sort(compareLibraryEntries).map((entry) => entry.updatedAt),
      ['2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null],
    );
  });

  it('recognises documents with a newer format version', () => {
    const document = createScenario({ title: 'Mantinea' });
    assert.equal(isUnsupportedDocument(document), false);
    assert.equal(
      isUnsupportedDocument({ ...document, formatVersion: SCENARIO_FORMAT_VERSION + 1 }),
      true,
    );
    assert.equal(isUnsupportedDocument(null), false);
  });
});

describe('quota errors', () => {
  it('recognises quota failures and nothing else', () => {
    const quota = new Error('The quota has been exceeded.');
    quota.name = 'QuotaExceededError';
    assert.equal(isQuotaError(quota), true);
    assert.equal(isQuotaError(new Error('QuotaExceededError')), true);
    assert.equal(isQuotaError(new Error('IndexedDB put failed')), false);
    assert.equal(isQuotaError(null), false);
  });
});

describe('framework independence', () => {
  it('imports nothing from React or Next.js', () => {
    const source = readFileSync(path.join(here, 'library.js'), 'utf8');
    assert.ok(!/from\s+['"]react['"]/.test(source), 'library.js imports react');
    assert.ok(!/from\s+['"]next/.test(source), 'library.js imports next');
  });
});

describe('ruleset reference mismatch (decision #5 item 12)', () => {
  it('lists an older version of the same ruleset as openable', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Mantinea' });
    await store.save({ ...document, ruleset: { id: document.ruleset.id, version: '0.0' } });
    const [entry] = await store.list();
    assert.equal(entry.status, 'ok');
    assert.equal(entry.cause, null);
    // The stored reference is preserved until an explicit Save rebinds it.
    assert.deepEqual((await store.load(document.id)).ruleset, {
      id: document.ruleset.id,
      version: '0.0',
    });
  });

  it('lists a newer version of the same ruleset without touching the stored data', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Future rules' });
    const newer = cloneScenario(document);
    newer.ruleset = { id: newer.ruleset.id, version: '99.0' };
    // Validation alone allows any well-formed reference; the library gate
    // refuses the newer version.
    store.records.set(newer.id, {
      document: newer,
      metadata: { id: newer.id, title: newer.title, revision: 1, updatedAt: newer.updatedAt },
    });
    const before = JSON.parse(JSON.stringify(store.records.get(newer.id)));
    const entry = (await store.list()).find((item) => item.id === newer.id);
    assert.equal(entry.status, 'unreadable');
    assert.match(entry.cause, /newer/);
    assert.deepEqual(store.records.get(newer.id), before);
  });

  it('lists an unknown ruleset identifier without touching the stored data', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Foreign rules' });
    const foreign = cloneScenario(document);
    foreign.ruleset = { id: 'other-rules', version: '1.0' };
    store.records.set(foreign.id, {
      document: foreign,
      metadata: {
        id: foreign.id,
        title: foreign.title,
        revision: 1,
        updatedAt: foreign.updatedAt,
      },
    });
    const before = JSON.parse(JSON.stringify(store.records.get(foreign.id)));
    const entry = (await store.list()).find((item) => item.id === foreign.id);
    assert.equal(entry.status, 'unreadable');
    assert.match(entry.cause, /unknown ruleset/);
    assert.deepEqual(store.records.get(foreign.id), before);
  });
});
