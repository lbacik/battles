// Unit tests for the battle store interface (in-memory implementation).
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startBattle } from './battle.js';
import { SUBMISSION_FORMAT_VERSION, resolveTurn } from './turn.js';
import { createScenario } from './scenario.js';
import {
  MemoryBattleStore,
  assertValidBattle,
  assertValidDecisions,
  cloneBattle,
  compareBattleEntries,
  isBattleFinished,
} from './battles.js';

function freshScenario(title = 'Mantinea') {
  const document = createScenario({ title });
  document.units.push({
    id: '00000000-0000-4000-8000-000000000001',
    name: 'First',
    side: 'side-a',
    troopType: 'hoplite',
    soldiers: 100,
    files: 10,
    lateralInterval: 1,
    rankDepth: 1,
    position: { x: 300, y: 600 },
    facing: 180,
  });
  document.units.push({
    id: '00000000-0000-4000-8000-000000000002',
    name: 'Second',
    side: 'side-b',
    troopType: 'hoplite',
    soldiers: 100,
    files: 10,
    lateralInterval: 1,
    rankDepth: 1,
    position: { x: 300, y: 200 },
    facing: 0,
  });
  return document;
}

function freshBattle(seed = 2026, battleId = 'battle-1') {
  const document = freshScenario();
  const controllers = { 'side-a': 'human', 'side-b': 'passive' };
  const battle = startBattle(document, { seed, controllers, battleId });
  return { document, battle, controllers };
}

describe('battle records', () => {
  it('saves the scenario snapshot, ruleset, parameters, seed, controllers, and decisions', async () => {
    const store = new MemoryBattleStore();
    const { battle } = freshBattle();
    const decisions = [];
    const metadata = await store.save(battle, decisions);
    assert.equal(metadata.id, battle.id);
    assert.equal(metadata.scenarioId, battle.scenario.id);
    assert.equal(metadata.status, 'ongoing');

    const raw = await store.loadRaw(battle.id);
    assert.equal(raw.id, battle.id);
    // Scenario snapshot travels with the battle.
    assert.deepEqual(raw.battle.scenario.title, battle.scenario.title);
    assert.deepEqual(raw.battle.scenario.units, battle.scenario.units);
    // Ruleset identifier, version, and parameter snapshot.
    assert.equal(raw.battle.ruleset.id, battle.ruleset.id);
    assert.equal(raw.battle.ruleset.version, battle.ruleset.version);
    assert.deepEqual(raw.battle.parameters, battle.parameters);
    // Seed and controllers.
    assert.equal(raw.battle.seed, battle.seed);
    assert.deepEqual(raw.battle.controllers, battle.controllers);
    // Committed turn decisions.
    assert.deepEqual(raw.decisions, []);
    assert.equal(raw.revision, 1);
  });

  it('reloads the identical state after a committed turn', async () => {
    const store = new MemoryBattleStore();
    const { battle } = freshBattle(7, 'battle-reload');
    await store.save(battle, []);
    const submission = {
      formatVersion: SUBMISSION_FORMAT_VERSION,
      battleId: battle.id,
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      orders: [],
    };
    const next = resolveTurn(battle, { type: 'commit', submission });
    const decisions = [{ type: 'commit', submission }];
    await store.save(next, decisions);

    const reloaded = await store.load(next.id);
    assert.deepEqual(reloaded.battle, next);
    assert.deepEqual(reloaded.decisions, decisions);
    const listed = await store.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].turnNumber, next.turnNumber);
    assert.equal(listed[0].round, next.round);
    assert.equal(listed[0].activeSide, next.activeSide);
    assert.equal(listed[0].revision, 2);
  });

  it('editing the scenario never changes a started battle', async () => {
    const store = new MemoryBattleStore();
    const { document, battle } = freshBattle(11, 'battle-frozen');
    await store.save(battle, []);
    // Edit the scenario after the battle started: the stored battle keeps
    // the snapshot it started with.
    document.title = 'Edited after Begin';
    document.units[0].name = 'Renamed';
    document.units.push({
      id: '00000000-0000-4000-8000-000000000003',
      name: 'Late arrival',
      side: 'side-a',
      troopType: 'hoplite',
      soldiers: 50,
      files: 5,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 500, y: 600 },
      facing: 180,
    });
    const reloaded = await store.load(battle.id);
    assert.notEqual(reloaded.battle.scenario.title, 'Edited after Begin');
    assert.equal(reloaded.battle.scenario.units.length, 2);
    assert.ok(!reloaded.battle.scenario.units.some((unit) => unit.name === 'Late arrival'));
  });

  it('keeps finished battles as read-only entries', async () => {
    const store = new MemoryBattleStore();
    const { battle } = freshBattle(13, 'battle-done');
    await store.save(battle, []);
    const conceded = resolveTurn(battle, { type: 'concede', side: battle.activeSide });
    assert.equal(isBattleFinished(conceded), true);
    assert.equal(isBattleFinished(battle), false);
    await store.save(conceded, [{ type: 'concede', side: battle.activeSide }]);
    const [entry] = await store.list();
    assert.equal(entry.status, 'conceded');
    const reloaded = await store.load(battle.id);
    assert.equal(reloaded.battle.status, 'conceded');
    assert.ok(reloaded.battle.winner);
  });

  it('isolates stored state from caller mutations', async () => {
    const store = new MemoryBattleStore();
    const { battle } = freshBattle(17, 'battle-alone');
    await store.save(battle, [{ type: 'concede', side: battle.activeSide }]);
    battle.scenario.title = 'Changed after save';
    battle.controllers['side-a'] = 'passive';
    const reloaded = await store.load('battle-alone');
    assert.notEqual(reloaded.battle.scenario.title, 'Changed after save');
    assert.equal(reloaded.battle.controllers['side-a'], 'human');

    reloaded.battle.turnNumber = 99;
    reloaded.decisions.push({ type: 'concede', side: 'side-a' });
    const again = await store.load('battle-alone');
    assert.notEqual(again.battle.turnNumber, 99);
    assert.equal(again.decisions.length, 1);
  });

  it('rejects battles missing the required snapshots', () => {
    const { battle } = freshBattle(19, 'battle-check');
    assert.throws(() => assertValidBattle(null), /Invalid battle/);
    assert.throws(() => assertValidBattle({ ...cloneBattle(battle), scenario: null }), /scenario snapshot/);
    assert.throws(() => assertValidBattle({ ...cloneBattle(battle), ruleset: { id: 'x' } }), /ruleset/);
    assert.throws(() => assertValidBattle({ ...cloneBattle(battle), parameters: null }), /parameters/);
    assert.throws(() => assertValidBattle({ ...cloneBattle(battle), seed: -1 }), /seed/);
    assert.throws(
      () => assertValidBattle({ ...cloneBattle(battle), controllers: { 'side-a': 'oracle' } }),
      /controller/,
    );
    assert.throws(() => assertValidDecisions({}), /array/);
    assert.throws(() => assertValidDecisions([{ type: 'warp' }]), /unknown type/);
  });

  it('leaves the previous version intact when the write fails', async () => {
    const store = new MemoryBattleStore();
    const { battle } = freshBattle(23, 'battle-atomic');
    const first = await store.save(battle, []);
    const edited = cloneBattle(battle);
    edited.turnNumber = 5;
    const quota = new Error('QuotaExceededError: storage is full');
    quota.name = 'QuotaExceededError';
    const originalSet = store.records.set;
    store.records.set = () => {
      throw quota;
    };
    try {
      await assert.rejects(store.save(edited, []), /QuotaExceededError/);
    } finally {
      store.records.set = originalSet;
    }
    const reloaded = await store.load(battle.id);
    assert.equal(reloaded.battle.turnNumber, battle.turnNumber);
    assert.equal((await store.list()).find((entry) => entry.id === battle.id).revision, first.revision);
  });

  it('returns null for unknown ids and supports remove/clear', async () => {
    const store = new MemoryBattleStore();
    assert.equal(await store.load('missing'), null);
    assert.equal(await store.loadRaw('missing'), null);
    assert.equal(await store.remove('missing'), false);

    const { battle } = freshBattle(29, 'battle-gone');
    await store.save(battle, []);
    assert.equal(await store.remove(battle.id), true);
    assert.equal(await store.load(battle.id), null);

    const first = freshBattle(31, 'battle-a');
    const second = freshBattle(37, 'battle-b');
    await store.save(first.battle, []);
    await store.save(second.battle, []);
    assert.equal((await store.list()).length, 2);
    await store.clear();
    assert.deepEqual(await store.list(), []);
  });

  it('orders the battles list newest first', () => {
    const entries = [
      { updatedAt: null },
      { updatedAt: '2026-01-02T00:00:00.000Z' },
      { updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
    assert.deepEqual(
      [...entries].sort(compareBattleEntries).map((entry) => entry.updatedAt),
      ['2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z', null],
    );
  });
});
