// Engine I acceptance gate (#27): one case per Engine I rejection code with
// the expected `details`, the Random test player, the runner fallbacks, and
// Random vs Random fuzzing on the reference scenarios.
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

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, '..', 'scenarios');

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
    const rejection = rejectedVerdict(validateOne(battle, { unitId: own[0].id, kind: 'Shoot', targetId: 'x' }));
    assert.equal(rejection.code, 'unsupported_order_kind');
    assert.deepEqual(rejection.details, { unitId: own[0].id, kind: 'Shoot' });
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

  it('drops whatever validate rejects: a routed unit holds by omission', async () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.cohesion = 'Routed';
    const decision = await decideWith(battle, createRandomPlayer({ seed: 3 }));
    assert.equal(validateTurn(battle, decision.submission).ok, true);
    assert.ok(
      decision.submission.orders.every((order) => order.unitId !== HOPLITE_A),
      'the unsupported Rally for the routed unit is dropped, not committed',
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

describe('Engine I gate: Random vs Random fuzzing', () => {
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
    // No partial commit: the resolved decision validates against the
    // pre-turn battle, and the resolved turn applies exactly its orders.
    assert.equal(validateTurn(before, step.decision.submission).ok, true, 'the committed decision is whole');
    const resolved = after.events.find(
      (event) => event.type === 'turn-resolved' && event.turnNumber === before.turnNumber,
    );
    assert.ok(resolved, 'the turn resolves');
    assert.equal(resolved.ordersApplied, step.decision.submission.orders.length);
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
    // No unit outside the battlefield, and no footprint touching water.
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

  // Reference scenarios for the fuzzing gate: the two playable references,
  // plus a meadow variant with a water pond far from both units so the
  // forbidden-ground sweep runs every turn without refusing battle start.
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

  it('plays Random vs Random across many seeds for N turns with no invariant violations', async () => {
    const scenarios = fuzzScenarios();
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const turns = 6;
    let played = 0;
    for (const scenario of scenarios) {
      for (const seed of seeds) {
        const controllers = Object.fromEntries(scenario.sides.map((side) => [side.id, 'random']));
        let battle = startBattle(JSON.parse(JSON.stringify(scenario)), { seed, controllers });
        const players = Object.fromEntries(
          scenario.sides.map((side, index) => [side.id, createRandomPlayer({ seed: seed * 1000 + index + 1 })]),
        );
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
      const players = Object.fromEntries(
        scenario.sides.map((side, index) => [side.id, createRandomPlayer({ seed: seed * 1000 + index + 1 })]),
      );
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
