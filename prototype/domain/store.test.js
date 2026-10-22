// Unit tests for the scenario store interface (in-memory implementation).
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createScenario } from './scenario.js';
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
