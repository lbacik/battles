// Engine II gate (#32): fuzzing to an end, determinism, and golden tests.
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startBattle } from './battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  resolveTurn,
  validateTurn,
} from './turn.js';
import { runTurn } from './players.js';
import {
  cohesionMaxFor,
  cohesionParamsOf,
  unitCohesionValue,
} from './cohesion.js';
import { battleEndParamsOf } from './battle-end.js';
import {
  HOPLITE_A,
  PELT_A,
  checkInvariants,
  fuzzScenarios,
  loadScenario,
  randomPlayers,
} from './engine-gate-helpers.js';

describe('Engine II gate: fuzzing to an end, determinism, and golden tests', () => {
  // The Engine I invariants plus the Engine II ones: soldiers never increase
  // (losses are whole soldiers, and starting strengths never change), and
  // every unit's numeric cohesion stays within its troop-type range. The
  // stored cohesion strings are checked for coherence rather than equality
  // with the value-derived state: shooting steps the stored strings from
  // accumulated strain without touching the numeric value (see `./shoot.js`),
  // so a shot-routed unit can legitimately store 'Routed' while its numeric
  // value still maps to 'Disordered'. A finished battle carries no
  // `turn-resolved` for its last turn (the end lands at once), so that leg of
  // the Engine I checker is conditional (see the shared `checkInvariants`).
  function checkFuzzToEndInvariants(before, step) {
    checkInvariants(before, step);
    const after = step.battle;
    const cohesion = cohesionParamsOf(after.parameters);
    const seenBefore = new Map(before.units.map((unit) => [unit.id, unit]));
    for (const unit of after.units) {
      const prior = seenBefore.get(unit.id);
      assert.ok(prior, `unit ${unit.id} persists across turn ${before.turnNumber}`);
      assert.ok(
        Number.isInteger(unit.soldiers) && unit.soldiers >= 0 && unit.soldiers <= prior.soldiers,
        `unit ${unit.id} never gains soldiers (had ${prior.soldiers}, holds ${unit.soldiers})`,
      );
      assert.equal(
        unit.startingSoldiers,
        prior.startingSoldiers,
        `unit ${unit.id} keeps its starting strength`,
      );
      const max = cohesionMaxFor(unit.troopType, cohesion);
      const value = unitCohesionValue(unit, cohesion);
      assert.ok(
        Number.isFinite(value) && value >= 0 && value <= max,
        `unit ${unit.id} stays within its cohesion range (0-${max}, holds ${value})`,
      );
      assert.equal(
        unit.cohesion,
        unit.cohesionState,
        `unit ${unit.id} keeps both cohesion fields in sync`,
      );
      assert.ok(
        unit.cohesion === 'Steady' || unit.cohesion === 'Disordered' || unit.cohesion === 'Routed',
        `unit ${unit.id} stores a known cohesion state (holds ${unit.cohesion})`,
      );
      if (value === 0) {
        assert.equal(
          unit.cohesion,
          'Routed',
          `unit ${unit.id} with spent cohesion reads Routed`,
        );
      }
      assert.ok(
        ['active', 'destroyed', 'fled'].includes(unit.status),
        `unit ${unit.id} carries a known status (${unit.status})`,
      );
    }
  }

  it('plays Random vs Random to an end condition in every battle', async () => {
    const scenarios = fuzzScenarios();
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
    let played = 0;
    let broken = 0;
    let limited = 0;
    for (const scenario of scenarios) {
      const sideIds = scenario.sides.map((side) => side.id);
      for (const seed of seeds) {
        const controllers = Object.fromEntries(sideIds.map((id) => [id, 'random']));
        let battle = startBattle(JSON.parse(JSON.stringify(scenario)), { seed, controllers });
        const players = randomPlayers(scenario, seed);
        const { roundLimit } = battleEndParamsOf(battle.parameters);
        let guard = roundLimit * 2 + 1;
        while (battle.status === 'ongoing') {
          guard -= 1;
          assert.ok(guard > 0, `battle on seed ${seed} ends at the round limit at the latest`);
          const before = battle;
          const step = await runTurn(battle, players, { timeoutMs: 0 });
          assert.equal(step.decision.type, 'commit', 'the Random game never concedes');
          checkFuzzToEndInvariants(before, step);
          battle = step.battle;
        }
        assert.ok(
          battle.status === 'broken' || battle.status === 'round-limit',
          `battle on seed ${seed} ends by break or the round limit (got ${battle.status})`,
        );
        assert.ok(
          battle.turnNumber <= roundLimit * 2,
          `battle on seed ${seed} ends within the limit round (turn ${battle.turnNumber})`,
        );
        const ended = battle.events.find((event) => event.type === 'battle-ended');
        assert.ok(ended, `battle on seed ${seed} records its end`);
        assert.equal(ended.reason, battle.result.reason);
        assert.equal(ended.winner, battle.winner);
        assert.ok(
          battle.winner === null || sideIds.includes(battle.winner),
          `battle on seed ${seed} names a playing winner`,
        );
        if (battle.status === 'broken') {
          broken += 1;
        } else {
          limited += 1;
        }
        played += 1;
      }
    }
    assert.equal(played, scenarios.length * seeds.length);
    assert.ok(broken > 0, 'fuzzing reaches army breaks, not only the round limit');
    assert.ok(limited > 0, 'fuzzing reaches the round limit, not only army breaks');
  });

  it('replaying the seed and the committed decisions reproduces an identical battle', async () => {
    const scenario = loadScenario('acceptance-plain.json');
    const seed = 20260714;
    const controllers = Object.fromEntries(scenario.sides.map((side) => [side.id, 'random']));
    const players = randomPlayers(scenario, seed);
    let live = startBattle(JSON.parse(JSON.stringify(scenario)), { seed, controllers });
    const decisions = [];
    for (let turn = 0; turn < 6; turn += 1) {
      const step = await runTurn(live, players, { timeoutMs: 0 });
      assert.equal(step.fallback, null, 'the replayed game needs no runner fallback');
      decisions.push(step.decision);
      live = step.battle;
    }
    let replayed = startBattle(JSON.parse(JSON.stringify(scenario)), { seed, controllers });
    for (const decision of decisions) {
      replayed = resolveTurn(replayed, decision);
    }
    assert.deepEqual(replayed.events, live.events);
    assert.deepEqual(replayed.units, live.units);
    assert.equal(replayed.rngState, live.rngState);
    assert.equal(replayed.status, live.status);
    assert.equal(replayed.turnNumber, live.turnNumber);
    assert.equal(replayed.round, live.round);
    assert.equal(replayed.activeSide, live.activeSide);
    assert.deepEqual(replayed.result ?? null, live.result ?? null);
    assert.equal(replayed.winner ?? null, live.winner ?? null);
  });

  // A fixed scenario, seed, and orders produce exactly this event record: a
  // charge into contact plus a shot at range, with the starting-side draw,
  // the movement, the shooting draw and losses, both combat draws and the
  // fight, and the turn passing. The units below pin the same turn's
  // casualties and cohesion. Regenerate deliberately, never by hand: any
  // engine change that moves a draw or a loss must update this record.
  const GOLDEN_SEED = 2026;
  const GOLDEN_ATHENIAN_CAVALRY = '33333333-3333-4333-8333-333333333333';
  const GOLDEN_SPARTAN_HOPLITE = '44444444-4444-4444-8444-444444444444';
  const GOLDEN_SPARTAN_ARCHER = '55555555-5555-4555-8555-555555555555';
  const GOLDEN_SPARTAN_PELTAST = '66666666-6666-4666-8666-666666666666';
  const GOLDEN_EVENTS = [
    { seq: 0, type: 'random-draw', purpose: 'starting-side', value: 0.45540769933722913, result: 'athens' },
    { seq: 1, type: 'unit-charged', turnNumber: 1, side: 'athens', unitId: '11111111-1111-4111-8111-111111111111', targetId: '44444444-4444-4444-8444-444444444444', orderIndex: 0, edge: 'front', aspect: 'front', frontageM: 8, fightingFiles: 8, position: { x: 502, y: 540 }, facing: 180 },
    { seq: 2, type: 'turn-phase', turnNumber: 1, side: 'athens', phase: 'Movement', ordersApplied: 2 },
    { seq: 3, type: 'turn-phase', turnNumber: 1, side: 'athens', phase: 'Shooting', ordersApplied: 2 },
    { seq: 4, type: 'random-draw', purpose: 'shooting-loss', turnNumber: 1, side: 'athens', unitId: '22222222-2222-4222-8222-222222222222', targetId: '66666666-6666-4666-8666-666666666666', value: 0.30849614599719644, result: 2 },
    { seq: 5, type: 'units-shot', turnNumber: 1, side: 'athens', unitId: '22222222-2222-4222-8222-222222222222', targetId: '66666666-6666-4666-8666-666666666666', shooters: 120, modifiers: [], losses: 2, soldiers: { before: 120, after: 118 }, strain: 1 },
    { seq: 6, type: 'random-draw', purpose: 'combat-loss', turnNumber: 1, side: 'athens', unitId: '11111111-1111-4111-8111-111111111111', opponentId: '44444444-4444-4444-8444-444444444444', value: 0.6611574492417276, result: 7 },
    { seq: 7, type: 'random-draw', purpose: 'combat-loss', turnNumber: 1, side: 'sparta', unitId: '44444444-4444-4444-8444-444444444444', opponentId: '11111111-1111-4111-8111-111111111111', value: 0.6184752183035016, result: 4 },
    { seq: 8, type: 'units-fought', turnNumber: 1, side: 'athens', pair: ['11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444'], aspect: 'front', frontageM: 8, fights: [{ unitId: '11111111-1111-4111-8111-111111111111', opponentId: '44444444-4444-4444-8444-444444444444', files: 8, strength: 36, modifiers: [{ key: 'charge', factor: 1.5 }], lossesInflicted: 7, lossesTaken: 4, strain: 0.72 }, { unitId: '44444444-4444-4444-8444-444444444444', opponentId: '11111111-1111-4111-8111-111111111111', files: 8, strength: 24, modifiers: [], lossesInflicted: 4, lossesTaken: 7, strain: 1.89 }], soldiers: { '11111111-1111-4111-8111-111111111111': { before: 256, after: 252 }, '44444444-4444-4444-8444-444444444444': { before: 320, after: 313 } } },
    { seq: 9, type: 'turn-phase', turnNumber: 1, side: 'athens', phase: 'Combat', ordersApplied: 2 },
    { seq: 10, type: 'turn-phase', turnNumber: 1, side: 'athens', phase: 'Cohesion', ordersApplied: 2 },
    { seq: 11, type: 'turn-resolved', turnNumber: 1, side: 'athens', ordersApplied: 2, nextTurnNumber: 2, nextSide: 'sparta', nextRound: 1 },
  ];

  it('pins a fixed scenario, seed, and orders to the exact event record', () => {
    const stored = loadScenario('acceptance-plain.json');
    const controllers = {
      [stored.sides[0].id]: 'passive',
      [stored.sides[1].id]: 'passive',
    };
    const battle = startBattle(stored, { seed: GOLDEN_SEED, controllers });
    assert.equal(battle.activeSide, 'athens');
    const byId = new Map(battle.units.map((unit) => [unit.id, unit]));
    byId.get(GOLDEN_SPARTAN_HOPLITE).position = { x: 510, y: 540 };
    byId.get(GOLDEN_SPARTAN_HOPLITE).facing = 0;
    byId.get(GOLDEN_SPARTAN_PELTAST).position = { x: 770, y: 570 };
    byId.get(GOLDEN_SPARTAN_PELTAST).facing = 0;
    const parked = [{ x: 100, y: 100 }, { x: 100, y: 250 }];
    let parkedAt = 0;
    for (const unit of battle.units) {
      if (![HOPLITE_A, PELT_A, GOLDEN_SPARTAN_HOPLITE, GOLDEN_SPARTAN_PELTAST].includes(unit.id)) {
        unit.position = { ...parked[parkedAt] };
        unit.facing = 0;
        parkedAt += 1;
      }
    }
    const submission = {
      formatVersion: SUBMISSION_FORMAT_VERSION,
      battleId: battle.id,
      turnNumber: 1,
      side: 'athens',
      orders: [
        { unitId: HOPLITE_A, kind: 'Charge', targetId: GOLDEN_SPARTAN_HOPLITE, edge: 'front', approach: [] },
        { unitId: PELT_A, kind: 'Shoot', targetId: GOLDEN_SPARTAN_PELTAST },
      ],
    };
    assert.equal(validateTurn(battle, submission).ok, true, 'the golden orders are accepted');
    const next = resolveTurn(battle, { type: 'commit', submission });
    assert.deepEqual(next.events, GOLDEN_EVENTS);
    const soldiers = Object.fromEntries(next.units.map((unit) => [unit.id, unit.soldiers]));
    assert.deepEqual(soldiers, {
      [HOPLITE_A]: 252,
      [PELT_A]: 120,
      [GOLDEN_ATHENIAN_CAVALRY]: 80,
      [GOLDEN_SPARTAN_HOPLITE]: 313,
      [GOLDEN_SPARTAN_ARCHER]: 100,
      [GOLDEN_SPARTAN_PELTAST]: 118,
    });
    assert.equal(next.rngState, 3031297982);
    assert.equal(next.status, 'ongoing');
    assert.equal(next.turnNumber, 2);
  });
});
