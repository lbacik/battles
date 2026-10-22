// Unit tests for Reform and Withdraw orders: formation changes in place and
// breaking contact (decisions #6 items 10 and 13, #7 item 5).
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRng, startBattle } from './battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  TurnRejectedError,
  availableActions,
  buildPlayerView,
  resolveTurn,
  validateTurn,
} from './turn.js';
import { RULESET_PARAMETERS } from './polis-classical.js';
import { normalizeReform } from './reform.js';
import { withdrawDestination, withdrawParamsOf } from './withdraw.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, '..', 'scenarios');

function loadReference() {
  return JSON.parse(readFileSync(path.join(scenarioDir, 'acceptance-plain.json'), 'utf8'));
}

function freshBattle(seed = 2026) {
  const stored = loadReference();
  const controllers = {
    [stored.sides[0].id]: 'passive',
    [stored.sides[1].id]: 'passive',
  };
  const battle = startBattle(stored, { seed, controllers });
  assert.equal(battle.activeSide, 'athens');
  return battle;
}

function submissionFor(battle, orders) {
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
  };
}

function ownUnits(battle) {
  return battle.units.filter((unit) => unit.side === battle.activeSide);
}

function foreignUnits(battle) {
  return battle.units.filter((unit) => unit.side !== battle.activeSide);
}

function hopliteOf(battle) {
  return ownUnits(battle).find((unit) => unit.troopType === 'hoplite');
}

// Move a battle unit to a new position/facing. Tests mutate the started
// battle directly: validation reads the battle state as-is and never
// re-checks playability, so arranging footprints by hand is legitimate.
function place(battle, unitId, position, facing) {
  const unit = battle.units.find((entry) => entry.id === unitId);
  unit.position = { ...position };
  if (facing !== undefined) {
    unit.facing = facing;
  }
  return unit;
}

// Mark two units engaged with each other, as a committed charge would leave
// them. The aspects mirror a frontal contact.
function engage(battle, firstId, secondId) {
  const first = battle.units.find((entry) => entry.id === firstId);
  const second = battle.units.find((entry) => entry.id === secondId);
  first.engaged = {
    unitId: second.id,
    edge: 'front',
    aspect: 'front',
    frontageM: 16,
    files: 16,
  };
  second.engaged = {
    unitId: first.id,
    edge: 'front',
    aspect: 'front',
    frontageM: 16,
    files: 16,
  };
  return { first, second };
}

// An engaged withdrawer on the active side with everyone else parked far
// away: the Athenian hoplite at (500, 600) facing south, engaged with the
// Spartan hoplite parked far away. Withdrawing steps straight back to
// (500, 620) at the same facing.
function arrangedWithdraw() {
  const battle = freshBattle();
  const unit = hopliteOf(battle);
  const enemy = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
  place(battle, unit.id, { x: 500, y: 600 }, 180);
  place(battle, enemy.id, { x: 500, y: 300 }, 0);
  for (const other of battle.units) {
    if (other.id !== unit.id && other.id !== enemy.id) {
      place(battle, other.id, { x: 100, y: 100 }, 0);
    }
  }
  engage(battle, unit.id, enemy.id);
  return { battle, unit, enemy };
}

function acceptedVerdict(result, orderIndex = 0) {
  assert.equal(result.ok, true, `expected acceptance, got: ${JSON.stringify(result)}`);
  const verdict = result.verdicts[orderIndex];
  assert.equal(verdict.accepted, true);
  return verdict;
}

function rejectedVerdict(result, orderIndex = 0) {
  assert.equal(result.ok, false);
  const verdict = result.verdicts[orderIndex];
  assert.equal(verdict.accepted, false);
  return verdict.rejection;
}

// An rng state whose next draw passes (or fails) the withdraw cohesion test,
// found by scanning: both outcomes must exist for any pass chance strictly
// inside (0, 1), so the scan always terminates.
function rngStateFor(passChance, wantPass) {
  for (let state = 0; state < 100000; state += 1) {
    const value = createRng(state).next();
    if (wantPass ? value < passChance : value >= passChance) {
      return { state, value };
    }
  }
  throw new Error('no rng state found for the wanted cohesion outcome');
}

describe('reform', () => {
  it('changes files in place, anchored at the front midpoint', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const result = validateTurn(
      battle,
      submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', files: 8 }]),
    );
    const verdict = acceptedVerdict(result);
    // 256 soldiers in 8 files: 32 ranks; frontage 8 m, depth 32 m, front
    // midpoint unmoved at (500, 600), depth growing backwards (north).
    assert.deepEqual(verdict.reform, { files: 8, lateralInterval: 1, rankDepth: 1 });
    assert.deepEqual(verdict.preview.position, { x: 500, y: 600 });
    assert.equal(verdict.preview.facing, 180);
    // Corner order follows the unit's perspective: facing south, its left is
    // east, so front-left is the eastern corner.
    assert.deepEqual(verdict.preview.corners, [
      { x: 504, y: 600 },
      { x: 496, y: 600 },
      { x: 496, y: 632 },
      { x: 504, y: 632 },
    ]);
  });

  it('changes spacings, snapped to the stored 0.1 m precision', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const result = validateTurn(
      battle,
      submissionFor(battle, [
        { unitId: unit.id, kind: 'Reform', lateralInterval: 2.04, rankDepth: 1.96 },
      ]),
    );
    const verdict = acceptedVerdict(result);
    assert.deepEqual(verdict.reform, { files: 16, lateralInterval: 2, rankDepth: 2 });
    // Frontage 32 m centred on 500, depth 32 m backwards from 600.
    assert.deepEqual(verdict.preview.corners, [
      { x: 516, y: 600 },
      { x: 484, y: 600 },
      { x: 484, y: 632 },
      { x: 516, y: 632 },
    ]);
  });

  it('rejects malformed reforms as invalid_formation', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const cases = [
      [{ unitId: unit.id, kind: 'Reform' }, 'no-change'],
      [{ unitId: unit.id, kind: 'Reform', files: 0 }, 'bad-files'],
      [{ unitId: unit.id, kind: 'Reform', files: 2.5 }, 'bad-files'],
      [{ unitId: unit.id, kind: 'Reform', files: 257 }, 'bad-files'],
      [{ unitId: unit.id, kind: 'Reform', lateralInterval: 0 }, 'bad-spacing'],
      [{ unitId: unit.id, kind: 'Reform', rankDepth: -1 }, 'bad-spacing'],
      [{ unitId: unit.id, kind: 'Reform', lateralInterval: 0.5 }, 'spacing-out-of-range'],
      [{ unitId: unit.id, kind: 'Reform', lateralInterval: 5 }, 'spacing-out-of-range'],
      [{ unitId: unit.id, kind: 'Reform', rankDepth: 0.6 }, 'spacing-out-of-range'],
    ];
    for (const [order, reason] of cases) {
      const rejection = rejectedVerdict(validateTurn(battle, submissionFor(battle, [order])));
      assert.equal(rejection.code, 'invalid_formation');
      assert.equal(rejection.details.reason, reason);
      assert.equal(rejection.details.unitId, unit.id);
    }
  });

  it('snaps spacings before the permitted-range check', () => {
    // 1.04 m snaps to 1.0 m: inside the hoplite 0.7-4.0 m range.
    const template = { troopType: 'hoplite', soldiers: 256, files: 16, lateralInterval: 1, rankDepth: 1 };
    assert.equal(normalizeReform(template, { lateralInterval: 1.04 }).formation.lateralInterval, 1);
  });

  it('refuses an engaged unit with order_not_permitted', () => {
    const { battle, unit, enemy } = arrangedWithdraw();
    void enemy;
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', files: 8 }])),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.equal(rejection.details.reason, 'engaged');
  });

  it('refuses everything but Rally for a routed unit first', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    unit.cohesion = 'Routed';
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', files: 8 }])),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.equal(rejection.details.reason, 'routed');
  });

  it('rejects a wider footprint colliding with a friend as collision', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const friend = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    // Peltast frontage 18 m at (517, 600): its western edge at 508 meets the
    // hoplite eastern edge, a legal setup adjacency.
    place(battle, friend.id, { x: 517, y: 600 }, 180);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', files: 32 }])),
    );
    assert.equal(rejection.code, 'collision');
    assert.deepEqual(rejection.details, {
      unitId: unit.id,
      withUnitId: friend.id,
      at: { x: 500, y: 600 },
    });
  });

  it('rejects a footprint touching water as forbidden_ground', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    // Water east of the current footprint (which ends at 508): narrowing
    // clears it, widening touches it. The current touch-free pose is never
    // the question; only the new footprint is.
    battle.scenario.terrainFeatures = [{
      id: 'lake-test',
      kind: 'ground',
      category: 'water',
      polygon: [
        { x: 508, y: 590 },
        { x: 530, y: 590 },
        { x: 530, y: 620 },
        { x: 508, y: 620 },
      ],
    }];
    const clear = validateTurn(
      battle,
      submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', files: 8 }]),
    );
    assert.equal(clear.ok, true, JSON.stringify(clear));
    const rejection = rejectedVerdict(
      validateTurn(
        battle,
        submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', lateralInterval: 2 }]),
      ),
    );
    assert.equal(rejection.code, 'forbidden_ground');
    assert.deepEqual(rejection.details, {
      unitId: unit.id,
      featureId: 'lake-test',
      groundCover: 'water',
      at: { x: 500, y: 600 },
    });
  });

  it('rejects a footprint leaving the battlefield as battlefield_edge', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    place(battle, unit.id, { x: 10, y: 600 }, 180);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', files: 32 }])),
    );
    assert.equal(rejection.code, 'battlefield_edge');
    assert.equal(rejection.details.unitId, unit.id);
    // Frontage 32 m centred on 10: the western corner leaves the field.
    assert.deepEqual(rejection.details.at, { x: -6, y: 600 });
  });

  it('rejects ending in contact with an enemy but overlaps as collision', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const enemy = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    // Enemy front edge exactly on y 640 (footprint 640..660 facing south).
    place(battle, enemy.id, { x: 500, y: 640 }, 180);
    // 16 ranks at 2.5 m: the rear edge stops exactly on 640 — contact.
    const touch = rejectedVerdict(
      validateTurn(
        battle,
        submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', rankDepth: 2.5 }]),
      ),
    );
    assert.equal(touch.code, 'contact_with_enemy');
    assert.deepEqual(touch.details, { unitId: unit.id, withUnitId: enemy.id });
    // 3 m deep: the rear edge pushes past 640 into overlap — collision.
    const overlap = rejectedVerdict(
      validateTurn(
        battle,
        submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', rankDepth: 3 }]),
      ),
    );
    assert.equal(overlap.code, 'collision');
    assert.equal(overlap.details.withUnitId, enemy.id);
  });

  it('validates later orders against the reformed footprint', () => {
    const battle = freshBattle();
    const first = hopliteOf(battle);
    const second = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    place(battle, second.id, { x: 560, y: 600 }, 180);
    const reform = { unitId: first.id, kind: 'Reform', lateralInterval: 2 };
    const move = { unitId: second.id, kind: 'Move', legs: [{ to: { x: 520, y: 600 } }] };
    // Before the reform the peltast destination (frontage 18 m: 511..529)
    // clears the hoplite (492..508); after widening to 484..516 it overlaps.
    const before = validateTurn(battle, submissionFor(battle, [move]));
    assert.equal(before.ok, true, JSON.stringify(before));
    const after = validateTurn(battle, submissionFor(battle, [reform, move]));
    assert.equal(after.ok, false);
    assert.equal(after.verdicts[0].accepted, true);
    assert.equal(after.verdicts[1].accepted, false);
    assert.equal(after.verdicts[1].rejection.code, 'collision');
    assert.equal(after.verdicts[1].rejection.details.withUnitId, first.id);
  });

  it('commits the new formation with a reform event and passes the turn', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const before = JSON.stringify(battle);
    const submission = submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', files: 8 }]);
    const next = resolveTurn(battle, { type: 'commit', submission });
    assert.equal(JSON.stringify(battle), before, 'resolution stays pure');
    const reformed = next.units.find((entry) => entry.id === unit.id);
    assert.equal(reformed.files, 8);
    assert.equal(reformed.lateralInterval, 1);
    assert.equal(reformed.rankDepth, 1);
    assert.deepEqual(reformed.position, { x: 500, y: 600 });
    assert.equal(reformed.facing, 180);
    const event = next.events.find((entry) => entry.type === 'unit-reformed');
    assert.ok(event, 'a reform event is recorded');
    assert.equal(event.unitId, unit.id);
    assert.equal(event.files, 8);
    assert.equal(next.turnNumber, battle.turnNumber + 1);
  });

  it('returns the same preview for the same submission twice', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const submission = submissionFor(battle, [{ unitId: unit.id, kind: 'Reform', files: 8 }]);
    assert.deepEqual(validateTurn(battle, submission).verdicts, validateTurn(battle, submission).verdicts);
  });
});

describe('withdraw', () => {
  it('steps straight back by the set distance without turning', () => {
    const { battle, unit, enemy } = arrangedWithdraw();
    const result = validateTurn(
      battle,
      submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }]),
    );
    const verdict = acceptedVerdict(result);
    const distanceM = RULESET_PARAMETERS.withdraw.distanceM;
    assert.deepEqual(verdict.withdraw, { distanceM, brokeContactWith: [enemy.id] });
    assert.deepEqual(verdict.preview.position, { x: 500, y: 600 + distanceM });
    assert.equal(verdict.preview.facing, 180);
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 40 });
    // The footprint translated straight back, facing unchanged.
    assert.deepEqual(verdict.preview.corners, [
      { x: 508, y: 620 },
      { x: 492, y: 620 },
      { x: 492, y: 636 },
      { x: 508, y: 636 },
    ]);
  });

  it('derives the step-back destination from the facing', () => {
    assert.deepEqual(withdrawDestination({ position: { x: 500, y: 600 }, facing: 180 }, 20), { x: 500, y: 620 });
    assert.deepEqual(withdrawDestination({ position: { x: 500, y: 540 }, facing: 0 }, 20), { x: 500, y: 520 });
  });

  it('refuses a unit that is not engaged with order_not_permitted', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }])),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.equal(rejection.details.reason, 'not-engaged');
    assert.deepEqual(
      rejection.details.permitted,
      ['Hold', 'Move', 'Charge', 'Reform'],
    );
  });

  it('rejects a blocked path back as collision', () => {
    const { battle, unit } = arrangedWithdraw();
    const blocker = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    // On the step back to (500, 620): the peltast footprint (491..509,
    // 613..628) overlaps the sweep.
    place(battle, blocker.id, { x: 500, y: 628 }, 180);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }])),
    );
    assert.equal(rejection.code, 'collision');
    assert.equal(rejection.details.withUnitId, blocker.id);
  });

  it('rejects stepping back into water as forbidden_ground', () => {
    const { battle, unit } = arrangedWithdraw();
    battle.scenario.terrainFeatures = [{
      id: 'lake-test',
      kind: 'ground',
      category: 'water',
      polygon: [
        { x: 480, y: 625 },
        { x: 520, y: 625 },
        { x: 520, y: 640 },
        { x: 480, y: 640 },
      ],
    }];
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }])),
    );
    assert.equal(rejection.code, 'forbidden_ground');
    assert.equal(rejection.details.featureId, 'lake-test');
  });

  it('rejects stepping back off the battlefield as battlefield_edge', () => {
    const { battle, unit } = arrangedWithdraw();
    place(battle, unit.id, { x: 500, y: 885 }, 180);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }])),
    );
    assert.equal(rejection.code, 'battlefield_edge');
    assert.equal(rejection.details.unitId, unit.id);
  });

  it('rejects a rest touching another enemy as contact_with_enemy but the broken one stays free', () => {
    const { battle, unit, enemy } = arrangedWithdraw();
    // The broken enemy sits on the old footprint: sliding away from it is the
    // coming break, not a collision.
    place(battle, enemy.id, { x: 500, y: 600 }, 0);
    const free = validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }]));
    assert.equal(free.ok, true, JSON.stringify(free));
    // A second enemy whose front edge meets the resting rear edge (636) is
    // refused: a mere touch with an enemy that is not being broken.
    const second = foreignUnits(battle).find((entry) => entry.id !== enemy.id);
    place(battle, second.id, { x: 500, y: 636 }, 180);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }])),
    );
    assert.equal(rejection.code, 'contact_with_enemy');
    assert.equal(rejection.details.withUnitId, second.id);
  });

  it('rejects a withdraw that does not fit the allowance as out_of_reach', () => {
    const { battle, unit } = arrangedWithdraw();
    battle.parameters.movement.allowanceM.hoplite = 10;
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }])),
    );
    assert.equal(rejection.code, 'out_of_reach');
    assert.deepEqual(rejection.details, {
      unitId: unit.id,
      availableM: 10,
      requiredM: 40,
      shortfallM: 30,
    });
  });

  it('honours custom withdraw parameters from the battle snapshot', () => {
    const { battle, unit, enemy } = arrangedWithdraw();
    battle.parameters.withdraw = { distanceM: 10, rateFactor: 1, cohesionPassChance: 1 };
    const verdict = acceptedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }])),
    );
    assert.deepEqual(verdict.withdraw, { distanceM: 10, brokeContactWith: [enemy.id] });
    assert.deepEqual(verdict.preview.position, { x: 500, y: 610 });
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 10 });
    // The custom pass chance reaches resolution: 1 always passes.
    const next = resolveTurn(
      battle,
      { type: 'commit', submission: submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }]) },
    );
    const moved = next.units.find((entry) => entry.id === unit.id);
    assert.deepEqual(moved.position, { x: 500, y: 610 });
    assert.equal(moved.cohesion, 'Steady');
    const draw = next.events.find(
      (entry) => entry.type === 'random-draw' && entry.purpose === 'withdraw-cohesion',
    );
    assert.equal(draw.result, 'passed');
  });

  it('reads withdraw parameters in either the outer or the inner shape', () => {
    const custom = { distanceM: 10, rateFactor: 1, cohesionPassChance: 0.75 };
    assert.deepEqual(withdrawParamsOf({ withdraw: custom }), custom);
    assert.deepEqual(withdrawParamsOf(custom), custom);
    assert.deepEqual(withdrawParamsOf(undefined), {
      distanceM: 20,
      rateFactor: 0.5,
      cohesionPassChance: 0.5,
    });
  });

  it('bills rough ground on the step back', () => {
    const { battle, unit } = arrangedWithdraw();
    battle.scenario.terrainFeatures = [{
      id: 'rough-test',
      kind: 'ground',
      category: 'rough',
      polygon: [
        { x: 480, y: 600 },
        { x: 520, y: 600 },
        { x: 520, y: 640 },
        { x: 480, y: 640 },
      ],
    }];
    const verdict = acceptedVerdict(
      validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }])),
    );
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 60 });
  });

  it('breaks contact on both sides and records the move with its draw', () => {
    const { battle, unit, enemy } = arrangedWithdraw();
    const passChance = RULESET_PARAMETERS.withdraw.cohesionPassChance;
    const { state, value } = rngStateFor(passChance, true);
    battle.rngState = state;
    const before = JSON.stringify(battle);
    const submission = submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }]);
    const next = resolveTurn(battle, { type: 'commit', submission });
    assert.equal(JSON.stringify(battle), before, 'resolution stays pure');
    const moved = next.units.find((entry) => entry.id === unit.id);
    assert.deepEqual(moved.position, { x: 500, y: 620 });
    assert.equal(moved.facing, 180, 'withdraw never turns');
    assert.equal(moved.engaged, null);
    const left = next.units.find((entry) => entry.id === enemy.id);
    assert.equal(left.engaged, null, 'the enemy contact breaks too');
    assert.deepEqual(left.position, { x: 500, y: 300 }, 'the enemy does not pursue');
    const withdrew = next.events.find((entry) => entry.type === 'unit-withdrew');
    assert.ok(withdrew, 'a withdraw event is recorded');
    assert.deepEqual(withdrew.brokeContactWith, [enemy.id]);
    assert.equal(withdrew.distanceM, RULESET_PARAMETERS.withdraw.distanceM);
    const draw = next.events.find(
      (entry) => entry.type === 'random-draw' && entry.purpose === 'withdraw-cohesion',
    );
    assert.ok(draw, 'the cohesion draw is recorded in the events');
    assert.equal(draw.unitId, unit.id);
    assert.equal(draw.value, value);
    assert.equal(draw.result, 'passed');
    assert.equal(draw.cohesionBefore, 'Steady');
    assert.equal(draw.cohesionAfter, 'Steady');
    assert.equal(moved.cohesion, 'Steady');
    assert.notEqual(next.rngState, battle.rngState, 'the draw advances the generator');
  });

  it('costs cohesion when the test fails, one step at a time', () => {
    const passChance = RULESET_PARAMETERS.withdraw.cohesionPassChance;
    for (const [start, end] of [['Steady', 'Disordered'], ['Disordered', 'Routed']]) {
      const { battle, unit } = arrangedWithdraw();
      unit.cohesion = start;
      battle.rngState = rngStateFor(passChance, false).state;
      const next = resolveTurn(
        battle,
        { type: 'commit', submission: submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }]) },
      );
      const moved = next.units.find((entry) => entry.id === unit.id);
      assert.equal(moved.cohesion, end, `${start} fails to ${end}`);
      const draw = next.events.find(
        (entry) => entry.type === 'random-draw' && entry.purpose === 'withdraw-cohesion',
      );
      assert.equal(draw.result, 'failed');
      assert.equal(draw.cohesionBefore, start);
      assert.equal(draw.cohesionAfter, end);
      const cohesionEvent = next.events.find(
        (entry) => entry.type === 'unit-cohesion' && entry.cause === 'withdraw',
      );
      assert.ok(cohesionEvent, 'a withdraw cohesion event is recorded on failure');
      assert.equal(cohesionEvent.unitId, unit.id);
      assert.equal(cohesionEvent.cohesionBefore, start);
      assert.equal(cohesionEvent.cohesionAfter, end);
      assert.equal(cohesionEvent.cause, 'withdraw');
    }
  });

  it('shows engaged and reformed permissions in the available actions', () => {
    const { battle, unit } = arrangedWithdraw();
    const actions = availableActions(battle, battle.activeSide);
    const engaged = actions.units.find((entry) => entry.unitId === unit.id);
    assert.deepEqual(engaged.permitted, [{ kind: 'Hold' }, { kind: 'Withdraw' }]);
    const calm = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    const entry = actions.units.find((item) => item.unitId === calm.id);
    assert.ok(entry.permitted.some((item) => item.kind === 'Reform'));
    assert.ok(entry.permitted.some((item) => item.kind === 'Withdraw') === false);
  });

  it('refuses a commit when any withdraw is rejected and changes nothing', () => {
    const { battle, unit } = arrangedWithdraw();
    const blocker = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    place(battle, blocker.id, { x: 500, y: 628 }, 180);
    const before = JSON.stringify(battle);
    const submission = submissionFor(battle, [{ unitId: unit.id, kind: 'Withdraw' }]);
    assert.throws(() => resolveTurn(battle, { type: 'commit', submission }), TurnRejectedError);
    assert.equal(JSON.stringify(battle), before);
  });

  it('keeps the player view free of the seed and the generator state', () => {
    const { battle } = arrangedWithdraw();
    const view = buildPlayerView(battle);
    const keys = new Set();
    const collect = (value) => {
      if (Array.isArray(value)) {
        value.forEach(collect);
      } else if (value && typeof value === 'object') {
        for (const [key, entry] of Object.entries(value)) {
          keys.add(key);
          collect(entry);
        }
      }
    };
    collect(view);
    assert.ok(!keys.has('seed') && !keys.has('rngState'));
  });
});
