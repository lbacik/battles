// Engine I acceptance gate (#27) and Engine II acceptance gate (#32): one
// case per Engine I rejection code with the expected `details`, the Random
// test player, the runner fallbacks, Random vs Random fuzzing on the reference
// scenarios (Engine I: N turns with no invariant violations; Engine II: every
// battle to an end condition with soldiers and cohesion invariants),
// determinism by replaying the seed and the committed decisions, and golden
// tests pinning a fixed scenario, seed, and orders to the exact event record.
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startBattle } from './battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  availableActions,
  buildPlayerView,
  resolveTurn,
  validateTurn,
} from './turn.js';
import {
  RUNNER_DEFAULTS,
  createPlayerForController,
  createPassivePlayer,
  createRandomPlayer,
  resolveRunnerOptions,
  runRounds,
  runTurn,
} from './players.js';
import {
  deriveFootprint,
  polygonsOverlapPositiveArea,
  ringsTouch,
} from './geometry.js';
import { validateWithdrawOnField } from './withdraw.js';
import {
  cohesionMaxFor,
  cohesionParamsOf,
  unitCohesionValue,
} from './cohesion.js';
import { battleEndParamsOf } from './battle-end.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, 'fixtures');

const HOPLITE_A = '11111111-1111-4111-8111-111111111111';
const PELT_A = '22222222-2222-4222-8222-222222222222';
const HOPLITE_B = '44444444-4444-4444-8444-444444444444';

function loadScenario(name) {
  return JSON.parse(readFileSync(path.join(scenarioDir, name), 'utf8'));
}

function freshBattle(seed = 2026) {
  const stored = loadScenario('acceptance-plain.json');
  const controllers = {
    [stored.sides[0].id]: 'passive',
    [stored.sides[1].id]: 'passive',
  };
  const battle = startBattle(stored, { seed, controllers });
  assert.equal(battle.activeSide, 'athens');
  return battle;
}

function submissionFor(battle, orders, overrides = {}) {
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
    ...overrides,
  };
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

// Park every unit except the listed ones far away so sweeps cross nothing.
function parkOthers(battle, keepIds, at = { x: 100, y: 100 }) {
  for (const unit of battle.units) {
    if (!keepIds.includes(unit.id)) {
      place(battle, unit.id, at, 0);
    }
  }
}

// Mark two units engaged with each other, as a committed charge would leave
// them. The aspects mirror a frontal contact.
function engage(battle, firstId, secondId) {
  const first = battle.units.find((entry) => entry.id === firstId);
  const second = battle.units.find((entry) => entry.id === secondId);
  first.engaged = { unitId: second.id, edge: 'front', aspect: 'front', frontageM: 16, files: 16 };
  second.engaged = { unitId: first.id, edge: 'front', aspect: 'front', frontageM: 16, files: 16 };
}

function rejectedVerdict(result, orderIndex = 0) {
  assert.equal(result.ok, false, `expected refusal, got: ${JSON.stringify(result)}`);
  const verdict = result.verdicts[orderIndex];
  assert.equal(verdict.accepted, false);
  return verdict.rejection;
}

function validateOne(battle, order) {
  return validateTurn(battle, submissionFor(battle, [order]));
}

describe('Engine I rejection codes with the expected details', () => {
  it('unknown_unit names the missing unit', () => {
    const battle = freshBattle();
    const rejection = rejectedVerdict(validateOne(battle, { unitId: 'missing-unit', kind: 'Hold' }));
    assert.equal(rejection.code, 'unknown_unit');
    assert.deepEqual(rejection.details, { unitId: 'missing-unit' });
  });

  it('not_own_unit names the unit and both sides', () => {
    const battle = freshBattle();
    const foreign = battle.units.find((unit) => unit.side !== battle.activeSide);
    const rejection = rejectedVerdict(validateOne(battle, { unitId: foreign.id, kind: 'Hold' }));
    assert.equal(rejection.code, 'not_own_unit');
    assert.deepEqual(rejection.details, {
      unitId: foreign.id,
      ownerSide: foreign.side,
      submittingSide: battle.activeSide,
    });
  });

  it('duplicate_unit_order names the unit and the first order', () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const result = validateTurn(battle, submissionFor(battle, [
      { unitId: own[0].id, kind: 'Hold' },
      { unitId: own[0].id, kind: 'Hold' },
    ]));
    const rejection = rejectedVerdict(result, 1);
    assert.equal(rejection.code, 'duplicate_unit_order');
    assert.deepEqual(rejection.details, { unitId: own[0].id, firstOrderIndex: 0 });
  });

  it('unsupported_order_kind names the unit and the kind', () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const rejection = rejectedVerdict(validateOne(battle, { unitId: own[0].id, kind: 'Teleport' }));
    assert.equal(rejection.code, 'unsupported_order_kind');
    assert.deepEqual(rejection.details, { unitId: own[0].id, kind: 'Teleport' });
  });

  it('invalid_move names the unit and the reason', () => {
    const battle = freshBattle();
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [] }));
    assert.equal(rejection.code, 'invalid_move');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'no-legs' });
  });

  it('invalid_move refuses more legs than the ruleset allows', () => {
    const battle = freshBattle();
    const legs = [1, 2, 3, 4].map((step) => ({ to: { x: 500 + step, y: 610 } }));
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs }));
    assert.equal(rejection.code, 'invalid_move');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'too-many-legs' });
  });

  it('collision names the unit, the other unit, and the touch point', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, PELT_A, { x: 500, y: 650 }, 0);
    parkOthers(battle, [HOPLITE_A, PELT_A]);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 660 } }] }),
    );
    assert.equal(rejection.code, 'collision');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      withUnitId: PELT_A,
      at: { x: 500, y: 635 },
    });
  });

  it('battlefield_edge names the unit and the exit point', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    parkOthers(battle, [HOPLITE_A]);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 950 } }] }),
    );
    assert.equal(rejection.code, 'battlefield_edge');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, at: { x: 492, y: 901 } });
  });

  it('forbidden_ground names the water feature and the touch point', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    parkOthers(battle, [HOPLITE_A]);
    battle.scenario.terrainFeatures.push({
      id: 'pond-test',
      kind: 'ground',
      category: 'water',
      polygon: [{ x: 480, y: 640 }, { x: 520, y: 640 }, { x: 520, y: 680 }, { x: 480, y: 680 }],
    });
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 660 } }] }),
    );
    assert.equal(rejection.code, 'forbidden_ground');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      featureId: 'pond-test',
      groundCover: 'water',
      at: { x: 500, y: 640 },
    });
  });

  it('out_of_reach names the allowance, the requirement, and the shortfall', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    parkOthers(battle, [HOPLITE_A]);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 700 } }] }),
    );
    assert.equal(rejection.code, 'out_of_reach');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      availableM: 90,
      requiredM: 100,
      shortfallM: 10,
    });
  });

  it('contact_with_enemy names the unit and the enemy', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, HOPLITE_B, { x: 500, y: 660 }, 180);
    parkOthers(battle, [HOPLITE_A, HOPLITE_B]);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 660 } }] }),
    );
    assert.equal(rejection.code, 'contact_with_enemy');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, withUnitId: HOPLITE_B });
  });

  it('order_not_permitted refuses a Move for an engaged unit', () => {
    const battle = freshBattle();
    engage(battle, HOPLITE_A, HOPLITE_B);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 610 } }] }),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      reason: 'engaged',
      permitted: ['Hold', 'Withdraw'],
    });
  });

  it('order_not_permitted refuses a Charge for a disordered unit', () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.cohesion = 'Disordered';
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, HOPLITE_B, { x: 500, y: 660 }, 180);
    parkOthers(battle, [HOPLITE_A, HOPLITE_B]);
    const rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: HOPLITE_B, edge: 'front', approach: [],
    }));
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'disordered' });
  });

  it('order_not_permitted refuses everything but Rally for a routed unit', () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.cohesion = 'Routed';
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 610 } }] }));
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'routed', permitted: ['Rally'] });
  });

  it('order_not_permitted refuses a Withdraw for a unit that is not engaged', () => {
    const battle = freshBattle();
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Withdraw' }));
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      reason: 'not-engaged',
      permitted: ['Hold', 'Move', 'Charge', 'Reform'],
    });
  });

  it('outside_front_arc names the charger and the target', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, HOPLITE_B, { x: 500, y: 300 }, 0);
    parkOthers(battle, [HOPLITE_A, HOPLITE_B]);
    const rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: HOPLITE_B, edge: 'front', approach: [],
    }));
    assert.equal(rejection.code, 'outside_front_arc');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, targetId: HOPLITE_B });
  });

  it('invalid_charge names a bad edge, an unknown target, and a friendly target', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, HOPLITE_B, { x: 500, y: 660 }, 180);
    parkOthers(battle, [HOPLITE_A, HOPLITE_B, PELT_A]);
    let rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: HOPLITE_B, edge: 'top', approach: [],
    }));
    assert.equal(rejection.code, 'invalid_charge');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, targetId: HOPLITE_B, reason: 'bad-edge' });

    rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: 'missing-unit', edge: 'front', approach: [],
    }));
    assert.equal(rejection.code, 'invalid_charge');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'unknown-target' });

    rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: PELT_A, edge: 'front', approach: [],
    }));
    assert.equal(rejection.code, 'invalid_charge');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, targetId: PELT_A, reason: 'not-enemy' });
  });

  it('invalid_formation names an empty reform, bad files, and an out-of-range spacing', () => {
    const battle = freshBattle();
    let rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Reform' }));
    assert.equal(rejection.code, 'invalid_formation');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'no-change' });

    rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Reform', files: 9999 }));
    assert.equal(rejection.code, 'invalid_formation');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'bad-files' });

    rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Reform', lateralInterval: 99 }),
    );
    assert.equal(rejection.code, 'invalid_formation');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      reason: 'spacing-out-of-range',
      field: 'lateralInterval',
      value: 99,
      range: { min: 0.7, max: 4 },
    });
  });

  it('invalid_formation names an unknown troop type', () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.troopType = 'bogus-type';
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Reform', files: 8 }));
    assert.equal(rejection.code, 'invalid_formation');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'unknown-troop-type' });
  });

  it('invalid_withdraw reaches the contract when a contact names no enemy to break', () => {
    // The contract gates Withdraw for units that are not engaged, so a real
    // game never reaches the module's `invalid_withdraw`: only a degenerate
    // contact (one with no enemy to break from) falls through to it.
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const unit = own[0];
    unit.engaged = { unitId: own[1].id, edge: 'front', aspect: 'front', frontageM: 8, files: 8 };
    const rejection = rejectedVerdict(validateOne(battle, { unitId: unit.id, kind: 'Withdraw' }));
    assert.equal(rejection.code, 'invalid_withdraw');
    assert.deepEqual(rejection.details, { unitId: unit.id, reason: 'not-engaged' });
  });

  it('invalid_withdraw names a missing engagement and a missing pose', () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    const battlefield = battle.scenario.battlefield;
    let planned = validateWithdrawOnField({
      unit,
      from: { position: { ...unit.position }, facing: unit.facing },
      brokenIds: [],
      params: battle.parameters.movement,
      withdrawParams: battle.parameters.withdraw,
      battlefield,
      others: [],
      terrainFeatures: [],
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'invalid_withdraw');
    assert.deepEqual(planned.details, { unitId: HOPLITE_A, reason: 'not-engaged' });

    planned = validateWithdrawOnField({
      unit,
      from: { position: null, facing: unit.facing },
      brokenIds: [HOPLITE_B],
      params: battle.parameters.movement,
      withdrawParams: battle.parameters.withdraw,
      battlefield,
      others: [],
      terrainFeatures: [],
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'invalid_withdraw');
    assert.deepEqual(planned.details, { unitId: HOPLITE_A, reason: 'bad-pose' });
  });

  it('whole-submission refusals carry their code and no verdicts', () => {
    const battle = freshBattle();
    let result = validateTurn(battle, submissionFor(battle, [], { turnNumber: battle.turnNumber + 1 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'stale_turn');
    assert.deepEqual(result.verdicts, []);

    const idle = battle.scenario.sides.map((side) => side.id).find((id) => id !== battle.activeSide);
    result = validateTurn(battle, submissionFor(battle, [], { side: idle }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_active_side');
    assert.deepEqual(result.verdicts, []);

    result = validateTurn(battle, submissionFor(battle, [], { battleId: 'elsewhere' }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unknown_battle');
    assert.deepEqual(result.verdicts, []);
  });
});

describe('Random player', () => {
  function decideWith(battle, player) {
    return player.decide({
      view: buildPlayerView(battle),
      availableActions: availableActions(battle, battle.activeSide),
      validate: (submission) => validateTurn(battle, submission),
    });
  }

  it('owns a seed separate from the battle generator', async () => {
    const battle = freshBattle();
    const before = battle.rngState;
    const player = createRandomPlayer({ seed: 42 });
    assert.equal(player.kind, 'random');
    assert.equal(player.seed, 42);
    const decision = await decideWith(battle, player);
    assert.equal(decision.type, 'commit');
    assert.equal(battle.rngState, before, 'thinking never draws the battle generator');
    const view = buildPlayerView(battle);
    const keys = JSON.stringify(view);
    assert.ok(!keys.includes('"seed"'), 'the player view carries no seed');
  });

  it('proposes the same orders from the same seed', async () => {
    const first = await decideWith(freshBattle(7), createRandomPlayer({ seed: 99 }));
    const second = await decideWith(freshBattle(7), createRandomPlayer({ seed: 99 }));
    assert.deepEqual(second.submission, first.submission);
  });

  it('draws every order from the available actions inside the movement allowance', async () => {
    const battle = freshBattle(7);
    const actions = availableActions(battle, battle.activeSide);
    const permitted = new Map(actions.units.map((entry) => [entry.unitId, new Set(entry.permitted.map((item) => item.kind))]));
    const allowance = new Map(actions.units.map((entry) => [entry.unitId, entry.movementAllowanceM]));
    const decision = await decideWith(battle, createRandomPlayer({ seed: 7 }));
    const result = validateTurn(battle, decision.submission);
    assert.equal(result.ok, true, 'whatever is proposed is accepted as-is');
    for (const order of decision.submission.orders) {
      assert.ok(permitted.has(order.unitId), `order for own unit ${order.unitId}`);
      assert.ok(permitted.get(order.unitId).has(order.kind), `${order.kind} is permitted for ${order.unitId}`);
    }
    for (const verdict of result.verdicts) {
      if (verdict.movement) {
        assert.ok(
          verdict.movement.requiredM <= verdict.movement.availableM,
          `unit ${verdict.unitId} moves inside its allowance`,
        );
        assert.ok(
          verdict.movement.requiredM <= allowance.get(verdict.unitId),
          `unit ${verdict.unitId} moves inside the shown allowance`,
        );
      }
    }
  });

  it('drops whatever validate rejects: a routed unit rallies or holds by omission', async () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.cohesion = 'Routed';
    unit.cohesionState = 'Routed';
    unit.cohesionValue = 0;
    const decision = await decideWith(battle, createRandomPlayer({ seed: 3 }));
    assert.equal(validateTurn(battle, decision.submission).ok, true);
    assert.ok(
      decision.submission.orders.every(
        (order) => order.unitId !== HOPLITE_A || order.kind === 'Rally',
      ),
      'the routed unit either rallies or holds by omission (only Rally is permitted)',
    );
  });

  it('never concedes and resolves through the controller factory', async () => {
    const battle = freshBattle();
    const player = createPlayerForController('random', { seed: 5 });
    assert.equal(player.kind, 'random');
    const decision = await decideWith(battle, player);
    assert.equal(decision.type, 'commit');
    assert.throws(() => createPlayerForController('oracle'), /No automated player/);
  });
});

describe('runner fallbacks', () => {
  function playersFor(battle, player) {
    const idle = battle.scenario.sides.map((side) => side.id).find((id) => id !== battle.activeSide);
    return { [battle.activeSide]: player, [idle]: createPassivePlayer() };
  }

  it('asks again within a bounded number of attempts, feeding each refusal back', async () => {
    const battle = freshBattle();
    const seen = [];
    const player = {
      kind: 'flaky',
      async decide(input) {
        seen.push(input);
        if (input.attempt === 1) {
          assert.equal(input.previousResult, null, 'the first attempt carries no refusal');
          return {
            type: 'commit',
            submission: submissionFor(battle, [{ unitId: 'missing-unit', kind: 'Hold' }]),
          };
        }
        assert.ok(input.previousResult, 'the retry carries the refusal');
        assert.equal(input.previousResult.code, 'orders_rejected');
        assert.deepEqual(
          input.previousResult.verdicts.filter((verdict) => !verdict.accepted).map((verdict) => verdict.rejection.code),
          ['unknown_unit'],
        );
        return { type: 'commit', submission: submissionFor(battle, []) };
      },
    };
    const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 3, timeoutMs: 0 });
    assert.equal(step.attempts, 2);
    assert.equal(step.decision.type, 'commit');
    assert.equal(step.fallback, null, 'a retry that lands needs no fallback');
    assert.deepEqual(step.substitutions, []);
    assert.ok(
      step.battle.events.some((event) => event.type === 'player-attempt-refused' && event.code === 'orders_rejected'),
      'the refused attempt is recorded in the battle events',
    );
    const order = step.battle.events.map((event) => event.type);
    assert.ok(
      order.indexOf('player-attempt-refused') < order.indexOf('turn-resolved'),
      'the refusal sorts before the resolution in causal order',
    );
    assert.deepEqual(
      step.battle.events.map((event) => event.seq),
      step.battle.events.map((_, index) => index),
      'event sequence numbers stay consecutive',
    );
    assert.equal(step.battle.turnNumber, battle.turnNumber + 1);
  });

  it('salvages by removing the first rejected order when the attempts are exhausted', async () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    let calls = 0;
    const player = {
      kind: 'stubborn',
      async decide() {
        calls += 1;
        return {
          type: 'commit',
          submission: submissionFor(battle, [
            { unitId: 'missing-unit', kind: 'Hold' },
            { unitId: own[0].id, kind: 'Hold' },
          ]),
        };
      },
    };
    const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 2, timeoutMs: 0 });
    assert.equal(calls, 2, 'both attempts run before the salvage');
    assert.equal(step.decision.type, 'commit');
    assert.equal(validateTurn(battle, step.decision.submission).ok, true);
    assert.deepEqual(step.decision.submission.orders, [{ unitId: own[0].id, kind: 'Hold' }]);
    assert.equal(step.substitutions.length, 1);
    assert.equal(step.substitutions[0].code, 'unknown_unit');
    assert.ok(step.fallback && step.fallback.includes('salvaged'), 'the salvage is a recorded fallback');
    assert.ok(step.battle.events.some((event) => event.type === 'order-substituted'));
    assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'));
  });

  it('holds when an envelope-level refusal leaves nothing to salvage', async () => {
    const battle = freshBattle();
    const player = {
      kind: 'stale',
      async decide() {
        return {
          type: 'commit',
          submission: submissionFor(battle, [{ unitId: HOPLITE_A, kind: 'Hold' }], {
            turnNumber: battle.turnNumber + 9,
          }),
        };
      },
    };
    const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 2, timeoutMs: 0 });
    assert.deepEqual(step.decision.submission.orders, []);
    assert.deepEqual(step.substitutions, []);
    assert.ok(step.fallback && step.fallback.includes('stale_turn'));
    assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'));
    assert.equal(step.battle.turnNumber, battle.turnNumber + 1);
  });

  it('holds on a missing, unparseable, or thrown answer, and never concedes', async () => {
    for (const [name, player] of [
      ['missing', { kind: 'silent', async decide() { return null; } }],
      ['unparseable', { kind: 'noisy', async decide() { return { type: 'retreat' }; } }],
      ['throwing', { kind: 'loud', async decide() { throw new Error('boom'); } }],
    ]) {
      const battle = freshBattle();
      const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 3, timeoutMs: 0 });
      assert.equal(step.attempts, 1, `${name}: no retry after a missing answer`);
      assert.equal(step.decision.type, 'commit', `${name}: the fallback commits, never concedes`);
      assert.deepEqual(step.decision.submission.orders, [], `${name}: every unit holds`);
      assert.ok(step.fallback, `${name}: the fallback is recorded`);
      assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'), name);
      assert.equal(step.battle.status, 'ongoing', `${name}: the battle is never conceded automatically`);
    }
  });

  it('holds when the player outlasts the timeout', async () => {
    const battle = freshBattle();
    const player = {
      kind: 'slow',
      async decide() {
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        return { type: 'commit', submission: submissionFor(battle, []) };
      },
    };
    const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 3, timeoutMs: 10 });
    assert.equal(step.decision.type, 'commit');
    assert.deepEqual(step.decision.submission.orders, []);
    assert.ok(step.fallback && step.fallback.includes('timed out'));
    assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'));
  });

  it('honours an explicit concede but never invents one', async () => {
    const battle = freshBattle();
    const step = await runTurn(
      battle,
      playersFor(battle, { kind: 'yielding', async decide() { return { type: 'concede' }; } }),
      { timeoutMs: 0 },
    );
    assert.equal(step.decision.type, 'concede');
    assert.equal(step.battle.status, 'conceded');
  });

  it('treats the attempt count and the timeout as configuration', () => {
    assert.deepEqual(resolveRunnerOptions({}), RUNNER_DEFAULTS);
    assert.deepEqual(resolveRunnerOptions({ maxAttempts: 1, timeoutMs: 0 }), { maxAttempts: 1, timeoutMs: 0 });
    assert.throws(() => resolveRunnerOptions({ maxAttempts: 0 }), /attempt count/);
    assert.throws(() => resolveRunnerOptions({ timeoutMs: -1 }), /timeout/);
  });

  it('salvages through a misbehaving wrapper around the Random player', async () => {
    const battle = freshBattle();
    const random = createRandomPlayer({ seed: 11 });
    const wrapper = {
      kind: 'random',
      async decide(input) {
        const decision = await random.decide(input);
        return {
          type: 'commit',
          submission: { ...decision.submission, orders: [{ unitId: 'missing-unit', kind: 'Hold' }, ...decision.submission.orders] },
        };
      },
    };
    const step = await runTurn(battle, playersFor(battle, wrapper), { maxAttempts: 2, timeoutMs: 0 });
    assert.ok(step.substitutions.length >= 1);
    assert.equal(step.substitutions[0].code, 'unknown_unit', 'the injected first order is salvaged away');
    assert.equal(validateTurn(battle, step.decision.submission).ok, true);
    assert.ok(step.battle.events.some((event) => event.type === 'order-substituted'));
  });

  it('holds on timeout through a delayed wrapper around the Random player', async () => {
    const battle = freshBattle();
    const random = createRandomPlayer({ seed: 11 });
    const wrapper = {
      kind: 'random',
      async decide(input) {
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        return random.decide(input);
      },
    };
    const step = await runTurn(battle, playersFor(battle, wrapper), { maxAttempts: 2, timeoutMs: 10 });
    assert.deepEqual(step.decision.submission.orders, []);
    assert.ok(step.fallback && step.fallback.includes('timed out'));
    assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'));
  });

  it('passes the runner configuration through runRounds', async () => {
    const battle = freshBattle();
    const players = {
      [battle.activeSide]: createPassivePlayer(),
      [battle.scenario.sides.map((side) => side.id).find((id) => id !== battle.activeSide)]: createPassivePlayer(),
    };
    const { battle: final, turns } = await runRounds(battle, players, 1, { maxAttempts: 1, timeoutMs: 0 });
    assert.equal(turns.length, 2);
    assert.ok(turns.every((step) => step.attempts === 1));
    assert.equal(final.turnNumber, battle.turnNumber + 2);
  });
});

// Shared fuzzing helpers, used by both the Engine I and the Engine II gates:
// the water lookup, the Engine I invariant checker, one Random player per
// side from one game seed, and the reference scenarios.
function watersOf(battle) {
  return (battle.scenario.terrainFeatures || []).filter(
    (feature) => feature
      && feature.kind === 'ground'
      && feature.category === 'water'
      && Array.isArray(feature.polygon)
      && feature.polygon.length >= 3,
  );
}

function checkInvariants(before, step) {
  const after = step.battle;
  // The event log stays in causal order with consecutive sequence numbers.
  assert.deepEqual(
    after.events.map((event) => event.seq),
    after.events.map((_, index) => index),
    `event sequence stays consecutive on turn ${before.turnNumber}`,
  );
  // No partial commit: the resolved decision validates against the
  // pre-turn battle, and the resolved turn applies exactly its orders.
  assert.equal(validateTurn(before, step.decision.submission).ok, true, 'the committed decision is whole');
  const resolved = after.events.find(
    (event) => event.type === 'turn-resolved' && event.turnNumber === before.turnNumber,
  );
  assert.ok(resolved || after.status !== 'ongoing', 'the turn resolves or the battle ends');
  if (resolved) {
    assert.equal(resolved.ordersApplied, step.decision.submission.orders.length);
  }
  // No footprint overlap anywhere on the field.
  const cornersOf = new Map(after.units.map((unit) => {
    const derived = deriveFootprint(unit);
    return [unit.id, derived.corners];
  }));
  const units = after.units;
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      assert.equal(
        polygonsOverlapPositiveArea(cornersOf.get(units[i].id), cornersOf.get(units[j].id)),
        false,
        `units ${units[i].id} and ${units[j].id} overlap on turn ${before.turnNumber}`,
      );
    }
  }
  // No unit outside the battlefield (Engine I removes nothing from the
  // field, so the "unless it fled" exception is vacuous here), and no
  // footprint touching water.
  const { width, height } = after.scenario.battlefield;
  const waters = watersOf(after);
  for (const unit of units) {
    for (const corner of cornersOf.get(unit.id)) {
      assert.ok(corner.x >= -1e-9 && corner.x <= width + 1e-9, `unit ${unit.id} stays on the field in x`);
      assert.ok(corner.y >= -1e-9 && corner.y <= height + 1e-9, `unit ${unit.id} stays on the field in y`);
    }
    for (const water of waters) {
      assert.equal(
        ringsTouch(cornersOf.get(unit.id), water.polygon),
        false,
        `unit ${unit.id} touches no water on turn ${before.turnNumber}`,
      );
    }
  }
}

// One Random player per side from one game seed: the side index offsets
// the player seeds so the two sides draw differently while the game stays
// reproducible from its seed.
function randomPlayers(scenario, seed) {
  return Object.fromEntries(
    scenario.sides.map((side, index) => [side.id, createRandomPlayer({ seed: seed * 1000 + index + 1 })]),
  );
}

// Reference scenarios for the fuzzing gate: the two playable references,
// plus a meadow variant with a water pond far from both units. Neither
// reference holds water, so without the pond the "no footprint touching
// water" invariant would pass vacuously; the pond exercises the
// forbidden-ground sweep every turn without refusing battle start.
function fuzzScenarios() {
  const plain = loadScenario('acceptance-plain.json');
  const meadow = loadScenario('playable-meadow.json');
  const pond = JSON.parse(JSON.stringify(meadow));
  pond.id = '10000000-0000-4000-8000-000000000099';
  pond.title = 'Playable Meadow with pond';
  pond.terrainFeatures.push({
    id: 'pond-fuzz',
    kind: 'ground',
    category: 'water',
    polygon: [{ x: 800, y: 400 }, { x: 900, y: 400 }, { x: 900, y: 500 }, { x: 800, y: 500 }],
  });
  return [plain, meadow, pond];
}

describe('Engine I gate: Random vs Random fuzzing', () => {
  it('plays Random vs Random across many seeds for N turns with no invariant violations', async () => {
    const scenarios = fuzzScenarios();
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const turns = 6;
    let played = 0;
    for (const scenario of scenarios) {
      for (const seed of seeds) {
        const controllers = Object.fromEntries(scenario.sides.map((side) => [side.id, 'random']));
        let battle = startBattle(JSON.parse(JSON.stringify(scenario)), { seed, controllers });
        const players = randomPlayers(scenario, seed);
        for (let turn = 0; turn < turns; turn += 1) {
          const before = battle;
          const step = await runTurn(battle, players, { timeoutMs: 0 });
          assert.equal(step.decision.type, 'commit', 'the Random game never concedes');
          checkInvariants(before, step);
          battle = step.battle;
          played += 1;
        }
      }
    }
    assert.equal(played, scenarios.length * seeds.length * turns);
  });

  it('replays the same seeds to the identical battle', async () => {
    async function play(seed) {
      const scenario = loadScenario('acceptance-plain.json');
      const controllers = Object.fromEntries(scenario.sides.map((side) => [side.id, 'random']));
      let battle = startBattle(JSON.parse(JSON.stringify(scenario)), { seed, controllers });
      const players = randomPlayers(scenario, seed);
      for (let turn = 0; turn < 4; turn += 1) {
        battle = (await runTurn(battle, players, { timeoutMs: 0 })).battle;
      }
      return battle;
    }
    const first = await play(20260714);
    const second = await play(20260714);
    assert.deepEqual(second.events, first.events);
    assert.deepEqual(second.units, first.units);
    assert.equal(first.rngState, second.rngState);
  });

  it('keeps the battle generator draws reproducible: Random draws add no battle events', async () => {
    const scenario = loadScenario('playable-meadow.json');
    const controllers = Object.fromEntries(scenario.sides.map((side) => [side.id, 'random']));
    let battle = startBattle(JSON.parse(JSON.stringify(scenario)), { seed: 9, controllers });
    const draws = battle.events.filter((event) => event.type === 'random-draw').length;
    const players = Object.fromEntries(
      scenario.sides.map((side, index) => [side.id, createRandomPlayer({ seed: 901 + index })]),
    );
    const step = await runTurn(battle, players, { timeoutMs: 0 });
    const randomDraws = step.battle.events
      .filter((event) => event.type === 'random-draw')
      .length;
    assert.equal(randomDraws, draws, 'thinking adds no engine draws');
  });
});

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
