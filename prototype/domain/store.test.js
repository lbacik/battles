// Unit tests for the scenario store interface (in-memory implementation).
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIO_FORMAT_VERSION, cloneScenario, createScenario } from './scenario.js';
import { MemoryScenarioStore } from './store.js';

describe('MemoryScenarioStore', () => {
  it('saves and reloads a scenario with identical values', async () => {
    const store = new MemoryScenarioStore();
    const scenario = createScenario({ title: 'Mantinea' });
    const metadata = await store.save(scenario);
    assert.equal(metadata.revision, 1);

    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, scenario.id);
    assert.equal(listed[0].title, 'Mantinea');

    const reloaded = await store.load(scenario.id);
    assert.deepEqual(
      { ...reloaded, updatedAt: scenario.updatedAt },
      { ...scenario, updatedAt: scenario.updatedAt },
    );
    assert.deepEqual(reloaded.battlefield, scenario.battlefield);
    assert.deepEqual(reloaded.sides, scenario.sides);
    assert.deepEqual(reloaded.ruleset, scenario.ruleset);
    assert.equal(reloaded.kind, 'scenario');
  });

  it('keeps the revision counter apart from the document', async () => {
    const store = new MemoryScenarioStore();
    const scenario = createScenario({ title: 'Mantinea' });
    await store.save(scenario);
    const secondSave = await store.save({ ...(await store.load(scenario.id)) });
    assert.equal(secondSave.revision, 2);

    const reloaded = await store.load(scenario.id);
    assert.ok(!Object.hasOwn(reloaded, 'revision'));
  });

  it('never changes the document identifier', async () => {
    const store = new MemoryScenarioStore();
    const scenario = createScenario({ title: 'Mantinea' });
    await store.save(scenario);
    const reloaded = await store.load(scenario.id);
    assert.equal(reloaded.id, scenario.id);

    const renamed = { ...reloaded, id: 'another-id', title: 'Leuctra' };
    await store.save(renamed);
    assert.equal((await store.list()).length, 2);
    assert.equal((await store.load(scenario.id)).title, 'Mantinea');
  });

  it('isolates stored state from caller mutations', async () => {
    const store = new MemoryScenarioStore();
    const scenario = createScenario({ title: 'Mantinea' });
    await store.save(scenario);
    scenario.title = 'Changed after save';
    assert.equal((await store.load(scenario.id)).title, 'Mantinea');

    const loaded = await store.load(scenario.id);
    loaded.title = 'Changed after load';
    assert.equal((await store.load(scenario.id)).title, 'Mantinea');
  });

  it('rejects invalid documents', async () => {
    const store = new MemoryScenarioStore();
    await assert.rejects(store.save({ kind: 'scenario' }), /Invalid scenario/);
    await assert.rejects(
      store.save({ ...createScenario({ title: 'Ok' }), revision: 1 }),
      /must not be stored/,
    );
  });

  it('marks readable entries as openable', async () => {
    const store = new MemoryScenarioStore();
    const scenario = createScenario({ title: 'Mantinea' });
    await store.save(scenario);
    const [entry] = await store.list();
    assert.equal(entry.status, 'ok');
    assert.equal(entry.cause, null);
  });

  it('lists unreadable entries with a cause instead of throwing', async () => {
    const store = new MemoryScenarioStore();
    const scenario = createScenario({ title: 'Mantinea' });
    await store.save(scenario);
    // Whatever another tab or an older build left behind: no document, and
    // a document that fails validation.
    store.records.set('missing-document', {
      document: null,
      metadata: { id: 'missing-document', title: '?', revision: 1, updatedAt: 'today' },
    });
    const broken = { kind: 'battle', formatVersion: 1 };
    store.records.set('broken-document', {
      document: broken,
      metadata: { id: 'broken-document', title: '?', revision: 2, updatedAt: 'today' },
    });
    const entries = await store.list();
    assert.equal(entries.length, 3);
    for (const id of ['missing-document', 'broken-document']) {
      const entry = entries.find((item) => item.id === id);
      assert.equal(entry.status, 'unreadable');
      assert.ok(entry.cause, 'a cause is required');
    }
    // Unreadable entries can still be removed.
    assert.equal(await store.remove('broken-document'), true);
    assert.equal((await store.list()).length, 2);
  });

  it('lists newer format versions without touching the stored data', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Future' });
    const newer = { ...cloneScenario(document), formatVersion: SCENARIO_FORMAT_VERSION + 1 };
    store.records.set(newer.id, {
      document: newer,
      metadata: { id: newer.id, title: newer.title, revision: 4, updatedAt: newer.updatedAt },
    });
    const before = JSON.parse(JSON.stringify(store.records.get(newer.id)));
    const entry = (await store.list()).find((item) => item.id === newer.id);
    assert.equal(entry.status, 'unsupported-version');
    assert.match(entry.cause, /newer/);
    assert.deepEqual(store.records.get(newer.id), before);
    // Loading never mutates the stored record either.
    await store.load(newer.id);
    assert.deepEqual(store.records.get(newer.id), before);
  });

  it('returns an isolated raw record for raw export', async () => {
    const store = new MemoryScenarioStore();
    const scenario = createScenario({ title: 'Mantinea' });
    await store.save(scenario);
    const raw = await store.loadRaw(scenario.id);
    assert.equal(raw.id, scenario.id);
    assert.deepEqual(raw.document.title, 'Mantinea');
    assert.equal(raw.revision, 1);
    raw.document.title = 'Changed after raw load';
    assert.equal((await store.load(scenario.id)).title, 'Mantinea');
    assert.equal(await store.loadRaw('missing'), null);
  });

  it('leaves the previous version intact when the write fails', async () => {
    const store = new MemoryScenarioStore();
    const scenario = createScenario({ title: 'Mantinea' });
    const first = await store.save(scenario);
    const edited = { ...(await store.load(scenario.id)), description: 'Edited in the form.' };
    // Simulate a browser quota error on write.
    const quota = new Error('QuotaExceededError: storage is full');
    quota.name = 'QuotaExceededError';
    const originalSet = store.records.set;
    store.records.set = () => {
      throw quota;
    };
    try {
      await assert.rejects(store.save(edited), /QuotaExceededError/);
    } finally {
      store.records.set = originalSet;
    }
    assert.equal((await store.load(scenario.id)).description, scenario.description);
    assert.equal(
      (await store.list()).find((item) => item.id === scenario.id).revision,
      first.revision,
    );
  });

  it('returns null for unknown ids and supports remove/clear', async () => {
    const store = new MemoryScenarioStore();
    assert.equal(await store.load('missing'), null);
    assert.equal(await store.remove('missing'), false);

    const scenario = createScenario({ title: 'Mantinea' });
    await store.save(scenario);
    assert.equal(await store.remove(scenario.id), true);
    assert.equal(await store.load(scenario.id), null);

    await store.save(createScenario({ title: 'A' }));
    await store.save(createScenario({ title: 'B' }));
    await store.clear();
    assert.deepEqual(await store.list(), []);
  });
});
