// Unit tests for Shoot orders: missile fire at enemy units (decisions #6
// items 11, 19, #7 items 3, 5, 8).
//
// A Shoot names one enemy target; the engine aims at the nearest point of
// the target footprint from the shooter's front edge, checks range, the
// front arc, and the line of fire, and the Shooting phase resolves the
// active side's Shoot orders with seeded losses, target modifiers, and
// cohesion loss. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRng, startBattle } from './battle.js';
import { SUBMISSION_FORMAT_VERSION, availableActions, resolveTurn, validateTurn } from './turn.js';
import {
  aimAtTarget,
  lineBlocker,
  missileRangeOf,
  resolveShootingPhase,
  shootingParamsOf,
  shootCandidatesFor,
  shotModifiersOf,
  validateShootOnField,
} from './shoot.js';
import { footprintAt } from './movement.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, 'fixtures');

const HOPLITE_A = '11111111-1111-4111-8111-111111111111';
const PELT_A = '22222222-2222-4222-8222-222222222222';
const HOPLITE_B = '44444444-4444-4444-8444-444444444444';

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
// battle directly: shooting reads the battle state as-is and never re-checks
// playability, so arranging footprints by hand is legitimate.
function place(battle, unitId, position, facing) {
  const unit = battle.units.find((entry) => entry.id === unitId);
  unit.position = { ...position };
  if (facing !== undefined) {
    unit.facing = facing;
  }
  return unit;
}

// Park every unit except the named ones far away so only the arranged
// footprints interact.
function isolate(battle, ...keepIds) {
  for (const unit of battle.units) {
    if (!keepIds.includes(unit.id)) {
      place(battle, unit.id, { x: 100, y: 100 }, 0);
      unit.engaged = null;
    }
  }
}

// Mark two units engaged with each other, as a committed charge would leave
// them after a frontal contact.
function engage(battle, firstId, secondId) {
  const first = battle.units.find((entry) => entry.id === firstId);
  const second = battle.units.find((entry) => entry.id === secondId);
  first.engaged = { unitId: second.id, edge: 'front', aspect: 'front', frontageM: 16, files: 16 };
  second.engaged = { unitId: first.id, edge: 'front', aspect: 'front', frontageM: 16, files: 16 };
  return { first, second };
}

function groundRect(id, category, minX, minY, maxX, maxY) {
  return {
    id,
    kind: 'ground',
    category,
    polygon: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
  };
}

// A tiny 4-soldier unit for exact geometry: frontage 4 m, depth 1 m.
function tinyShooter(position = { x: 0, y: 10 }, facing = 180, troopType = 'peltast') {
  return {
    id: 'shooter-test',
    side: 'athens',
    troopType,
    soldiers: 4,
    files: 4,
    lateralInterval: 1,
    rankDepth: 1,
    position: { ...position },
    facing,
  };
}

function tinyTarget(position = { x: 0, y: 0 }, facing = 0, side = 'sparta') {
  return {
    id: 'target-test',
    side,
    troopType: 'hoplite',
    soldiers: 4,
    files: 4,
    lateralInterval: 1,
    rankDepth: 1,
    position: { ...position },
    facing,
  };
}

function cornersOf(unit) {
  return footprintAt(unit, { ...unit.position }, unit.facing).corners;
}

// An rng state whose next `count` draws each fall inside the wanted ranges:
// `ranges` is [{ lo, hi }] per draw, half-open. Scans linearly; every
// non-degenerate range is hit quickly by the deterministic generator.
function rngStateForDraws(ranges) {
  for (let state = 0; state < 200000; state += 1) {
    const rng = createRng(state);
    const values = ranges.map(() => rng.next());
    if (values.every((value, index) => value >= ranges[index].lo && value < ranges[index].hi)) {
      return { state, values };
    }
  }
  throw new Error('no rng state found for the wanted draws');
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

describe('missile ranges', () => {
  it('reads the range from the troop-type catalogue', () => {
    assert.equal(missileRangeOf({ troopType: 'peltast' }), 50);
    assert.equal(missileRangeOf({ troopType: 'archer' }), 150);
    assert.equal(missileRangeOf({ troopType: 'slinger' }), 120);
    assert.equal(missileRangeOf({ troopType: 'light_cavalry' }), 40);
  });

  it('is null for close fighters and unknown keys', () => {
    assert.equal(missileRangeOf({ troopType: 'hoplite' }), null);
    assert.equal(missileRangeOf({ troopType: 'cavalry' }), null);
    assert.equal(missileRangeOf({ troopType: 'catapult' }), null);
    assert.equal(missileRangeOf({}), null);
    assert.equal(missileRangeOf(null), null);
  });
});

describe('shooting parameters', () => {
  it('resolves from the battle snapshot with documented defaults', () => {
    const params = shootingParamsOf({ shooting: { lethality: 0.05 } });
    assert.equal(params.lethality, 0.05);
    assert.ok(params.openSpacingFactor < 1, 'open spacing softens the volley');
    assert.ok(params.coverFactor.forest < 1 && params.coverFactor.settlement < 1, 'cover softens the volley');
    assert.ok(params.disorderedFactor < 1, 'disorder softens the volley');
    assert.ok(params.cohesionPerCasualty > 0, 'casualties cost cohesion');
    assert.ok(params.routedAt > params.disorderedAt, 'rout follows disorder');
    const fallback = shootingParamsOf(undefined);
    assert.equal(fallback.lethality, shootingParamsOf({}).lethality);
  });

  it('merges the cover table per category', () => {
    const params = shootingParamsOf({ coverFactor: { forest: 0.25 } });
    assert.equal(params.coverFactor.forest, 0.25);
    assert.equal(params.coverFactor.settlement, shootingParamsOf({}).coverFactor.settlement);
  });
});

describe('aiming at the target footprint', () => {
  it('aims at the nearest point of the target from the front edge', () => {
    const shooter = tinyShooter({ x: 0, y: 10 }, 180);
    const target = tinyTarget({ x: 0, y: 0 }, 0);
    const { distance, aim } = aimAtTarget(cornersOf(shooter), cornersOf(target));
    assert.equal(distance, 10);
    assert.deepEqual(aim, { x: -2, y: 0 });
  });

  it('aims at the nearest corner for an offset target', () => {
    const shooter = tinyShooter({ x: 5, y: 10 }, 180);
    const target = tinyTarget({ x: 0, y: 0 }, 0);
    const { distance, aim } = aimAtTarget(cornersOf(shooter), cornersOf(target));
    assert.deepEqual(aim, { x: 2, y: 0 });
    assert.ok(Math.abs(distance - Math.sqrt(101)) < 1e-9);
  });

  it('reads distance 0 for touching footprints', () => {
    const shooter = tinyShooter({ x: 0, y: 0 }, 0);
    const target = tinyTarget({ x: 0, y: 0 }, 180);
    const { distance, aim } = aimAtTarget(cornersOf(shooter), cornersOf(target));
    assert.equal(distance, 0);
    assert.equal(aim.x, 2);
    assert.ok(Math.abs(aim.y) < 1e-9, 'the aim sits on the shared edge');
  });
});

describe('line of fire', () => {
  const start = { x: 500, y: 600 };
  const aim = { x: 500, y: 500 };

  function hopliteRing(position, facing = 0) {
    return footprintAt(
      { soldiers: 256, files: 16, lateralInterval: 0.9, rankDepth: 0.9 },
      { ...position },
      facing,
    ).corners;
  }

  it('is clear over open ground', () => {
    assert.equal(lineBlocker(start, aim, [], []), null);
    assert.equal(
      lineBlocker(start, aim, [], [groundRect('rough-test', 'rough', 490, 540, 510, 560)]),
      null,
    );
  });

  it('is blocked by any unit of either side on the line', () => {
    const friend = { id: 'friend-test', corners: hopliteRing({ x: 500, y: 550 }) };
    assert.equal(lineBlocker(start, aim, [friend], []), 'friend-test');
    const foe = { id: 'foe-test', corners: hopliteRing({ x: 500, y: 550 }) };
    assert.equal(lineBlocker(start, aim, [foe], []), 'foe-test');
  });

  it('ignores units standing clear of the line', () => {
    const clear = { id: 'clear-test', corners: hopliteRing({ x: 100, y: 100 }) };
    assert.equal(lineBlocker(start, aim, [clear], []), null);
  });

  it('is blocked by a forest or a settlement between shooter and target', () => {
    assert.equal(
      lineBlocker(start, aim, [], [groundRect('forest-test', 'forest', 490, 540, 510, 560)]),
      'forest-test',
    );
    assert.equal(
      lineBlocker(start, aim, [], [groundRect('houses-test', 'settlement', 490, 540, 510, 560)]),
      'houses-test',
    );
  });

  it('is not blocked by the target cover the line ends in', () => {
    assert.equal(
      lineBlocker(start, aim, [], [groundRect('forest-test', 'forest', 480, 480, 520, 520)]),
      null,
    );
  });

  it('is not blocked by the shooter ground the line starts in', () => {
    assert.equal(
      lineBlocker(start, aim, [], [groundRect('forest-test', 'forest', 480, 580, 520, 620)]),
      null,
    );
  });

  it('names the first unit before the terrain in document order', () => {
    const friend = { id: 'friend-test', corners: hopliteRing({ x: 500, y: 570 }) };
    const forest = groundRect('forest-test', 'forest', 490, 540, 510, 560);
    assert.equal(lineBlocker(start, aim, [friend], [forest]), 'friend-test');
  });
});

describe('shoot validation', () => {
  function field(overrides = {}) {
    const battle = freshBattle();
    const shooter = battle.units.find((unit) => unit.id === PELT_A);
    const target = battle.units.find((unit) => unit.id === HOPLITE_B);
    return {
      battle,
      args: {
        unit: shooter,
        from: { position: { ...shooter.position }, facing: shooter.facing },
        target,
        targetPose: { position: { ...target.position }, facing: target.facing },
        targetEngaged: false,
        others: battle.units
          .filter((unit) => unit.id !== shooter.id)
          .map((unit) => ({ ...unit, position: { ...unit.position }, facing: unit.facing })),
        terrainFeatures: battle.scenario.terrainFeatures,
        parameters: battle.parameters,
        orderIndex: 0,
        ...overrides,
      },
    };
  }

  function arranged() {
    const { battle, args } = field();
    const shooter = battle.units.find((unit) => unit.id === PELT_A);
    const target = battle.units.find((unit) => unit.id === HOPLITE_B);
    isolate(battle, shooter.id, target.id);
    battle.scenario.terrainFeatures = [];
    place(battle, shooter.id, { x: 500, y: 560 }, 180);
    place(battle, target.id, { x: 500, y: 520 }, 0);
    args.from = { position: { x: 500, y: 560 }, facing: 180 };
    args.targetPose = { position: { x: 500, y: 520 }, facing: 0 };
    args.others = battle.units
      .filter((unit) => unit.id !== shooter.id)
      .map((unit) => ({ ...unit, position: { ...unit.position }, facing: unit.facing }));
    args.terrainFeatures = [];
    return { battle, args, shooter, target };
  }

  it('accepts a clear shot with the same-pose preview', () => {
    const { args } = arranged();
    const planned = validateShootOnField(args);
    assert.equal(planned.ok, true);
    assert.equal(planned.shoot.targetId, HOPLITE_B);
    assert.equal(planned.shoot.distanceM, 40);
    assert.deepEqual(planned.shoot.aimPoint, { x: 492, y: 520 });
    assert.deepEqual(planned.preview.position, { x: 500, y: 560 });
    assert.equal(planned.preview.facing, 180);
  });

  it('invalid_shoot names an unknown target', () => {
    const { args } = field();
    const planned = validateShootOnField({ ...args, target: undefined, targetPose: undefined });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'invalid_shoot');
    assert.deepEqual(planned.details, { unitId: PELT_A, reason: 'unknown-target' });
  });

  it('invalid_shoot names a friendly target and the shooter itself', () => {
    const { battle, args } = arranged();
    const friend = battle.units.find((unit) => unit.id === HOPLITE_A);
    let planned = validateShootOnField({ ...args, target: friend });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'invalid_shoot');
    assert.deepEqual(planned.details, { unitId: PELT_A, targetId: HOPLITE_A, reason: 'not-enemy' });

    planned = validateShootOnField({ ...args, target: args.unit });
    assert.equal(planned.code, 'invalid_shoot');
    assert.deepEqual(planned.details, { unitId: PELT_A, targetId: PELT_A, reason: 'not-enemy' });
  });

  it('invalid_shoot names an engaged target', () => {
    const { battle, args } = arranged();
    engage(battle, args.target.id, HOPLITE_A);
    const planned = validateShootOnField({ ...args, targetEngaged: true });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'invalid_shoot');
    assert.deepEqual(planned.details, { unitId: PELT_A, targetId: HOPLITE_B, reason: 'engaged-target' });
  });

  it('invalid_shoot names a shooter without missiles', () => {
    const { battle, args } = arranged();
    const hoplite = battle.units.find((unit) => unit.id === HOPLITE_A);
    const planned = validateShootOnField({ ...args, unit: hoplite });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'invalid_shoot');
    assert.deepEqual(planned.details, { unitId: HOPLITE_A, reason: 'no-missiles' });
  });

  it('out_of_range names the range, the distance, and the shortfall', () => {
    const { battle, args, shooter, target } = arranged();
    place(battle, shooter.id, { x: 500, y: 600 }, 180);
    args.from = { position: { x: 500, y: 600 }, facing: 180 };
    const planned = validateShootOnField(args);
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'out_of_range');
    assert.deepEqual(planned.details, {
      unitId: PELT_A,
      targetId: target.id,
      rangeM: 50,
      distanceM: 80,
      shortfallM: 30,
    });
  });

  it('outside_front_arc names the shooter and the target', () => {
    const { args, shooter } = arranged();
    // The shooter faces north, away from the target to its south.
    const archer = { ...shooter, troopType: 'archer', soldiers: 100, files: 14 };
    const planned = validateShootOnField({
      ...args,
      unit: archer,
      from: { position: { x: 500, y: 560 }, facing: 0 },
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'outside_front_arc');
    assert.deepEqual(planned.details, { unitId: PELT_A, targetId: HOPLITE_B });
  });

  it('no_line_of_fire names a forest, a settlement, and a unit on the line', () => {
    const { battle, args } = arranged();
    let planned = validateShootOnField({
      ...args,
      terrainFeatures: [groundRect('forest-test', 'forest', 490, 535, 510, 545)],
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'no_line_of_fire');
    assert.deepEqual(planned.details, { unitId: PELT_A, targetId: HOPLITE_B, blockedBy: 'forest-test' });

    planned = validateShootOnField({
      ...args,
      terrainFeatures: [groundRect('houses-test', 'settlement', 490, 535, 510, 545)],
    });
    assert.equal(planned.code, 'no_line_of_fire');
    assert.deepEqual(planned.details, { unitId: PELT_A, targetId: HOPLITE_B, blockedBy: 'houses-test' });

    const blocker = {
      id: 'blocker-test',
      side: 'athens',
      troopType: 'hoplite',
      soldiers: 64,
      files: 8,
      lateralInterval: 0.9,
      rankDepth: 0.9,
      position: { x: 496, y: 540 },
      facing: 0,
    };
    planned = validateShootOnField({ ...args, others: [...args.others, blocker] });
    assert.equal(planned.code, 'no_line_of_fire');
    assert.deepEqual(planned.details, { unitId: PELT_A, targetId: HOPLITE_B, blockedBy: 'blocker-test' });
  });

  it('accepts a shot at a target standing in cover', () => {
    const { args } = arranged();
    const planned = validateShootOnField({
      ...args,
      terrainFeatures: [groundRect('forest-test', 'forest', 480, 505, 520, 525)],
    });
    assert.equal(planned.ok, true);
  });
});

describe('shoot validation through the contract', () => {
  function arranged() {
    const battle = freshBattle();
    const shooter = battle.units.find((unit) => unit.id === PELT_A);
    const target = battle.units.find((unit) => unit.id === HOPLITE_B);
    isolate(battle, shooter.id, target.id);
    battle.scenario.terrainFeatures = [];
    place(battle, shooter.id, { x: 500, y: 560 }, 180);
    place(battle, target.id, { x: 500, y: 520 }, 0);
    return { battle, shooter, target };
  }

  it('accepts a clear Shoot with the same-pose preview', () => {
    const { battle, shooter, target } = arranged();
    const result = validateTurn(
      battle,
      submissionFor(battle, [{ unitId: shooter.id, kind: 'Shoot', targetId: target.id }]),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.verdicts[0].preview.position, { x: 500, y: 560 });
    assert.deepEqual(result.verdicts[0].shoot, {
      targetId: target.id,
      distanceM: 40,
      aimPoint: { x: 492, y: 520 },
    });
  });

  it('order_not_permitted refuses a Shoot for an engaged shooter', () => {
    const { battle, shooter, target } = arranged();
    engage(battle, shooter.id, HOPLITE_A);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: shooter.id, kind: 'Shoot', targetId: target.id }),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, {
      unitId: shooter.id,
      reason: 'engaged',
      permitted: ['Hold', 'Withdraw'],
    });
  });

  it('order_not_permitted refuses a Shoot for a routed shooter', () => {
    const { battle, shooter, target } = arranged();
    shooter.cohesion = 'Routed';
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: shooter.id, kind: 'Shoot', targetId: target.id }),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, { unitId: shooter.id, reason: 'routed', permitted: ['Rally'] });
  });

  it('order_not_permitted refuses a Shoot for a troop type without missiles', () => {
    const { battle, target } = arranged();
    const hoplite = battle.units.find((unit) => unit.id === HOPLITE_A);
    place(battle, hoplite.id, { x: 500, y: 590 }, 180);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: hoplite.id, kind: 'Shoot', targetId: target.id }),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, {
      unitId: hoplite.id,
      reason: 'no-missiles',
      permitted: ['Hold', 'Move', 'Charge', 'Reform'],
    });
  });

  it('accepts a Shoot for a disordered missile unit', () => {
    const { battle, shooter, target } = arranged();
    shooter.cohesion = 'Disordered';
    const result = validateTurn(
      battle,
      submissionFor(battle, [{ unitId: shooter.id, kind: 'Shoot', targetId: target.id }]),
    );
    assert.equal(result.ok, true);
  });

  it('invalid_shoot refuses an engaged target', () => {
    const { battle, shooter, target } = arranged();
    engage(battle, target.id, HOPLITE_A);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: shooter.id, kind: 'Shoot', targetId: target.id }),
    );
    assert.equal(rejection.code, 'invalid_shoot');
    assert.deepEqual(rejection.details, {
      unitId: shooter.id,
      targetId: target.id,
      reason: 'engaged-target',
    });
  });

  it('reads the field sequentially: a move onto the line blocks a later shot', () => {
    const battle = freshBattle();
    const shooter = battle.units.find((unit) => unit.id === PELT_A);
    const mover = battle.units.find((unit) => unit.id === HOPLITE_A);
    const target = battle.units.find((unit) => unit.id === HOPLITE_B);
    isolate(battle, shooter.id, mover.id, target.id);
    battle.scenario.terrainFeatures = [];
    place(battle, shooter.id, { x: 500, y: 560 }, 180);
    place(battle, mover.id, { x: 450, y: 532 }, 90);
    place(battle, target.id, { x: 500, y: 520 }, 0);
    const move = { unitId: mover.id, kind: 'Move', legs: [{ to: { x: 500, y: 532 } }] };
    const shoot = { unitId: shooter.id, kind: 'Shoot', targetId: target.id };
    const blocked = validateTurn(battle, submissionFor(battle, [move, shoot]));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.verdicts[0].accepted, true);
    assert.equal(blocked.verdicts[1].accepted, false);
    assert.equal(blocked.verdicts[1].rejection.code, 'no_line_of_fire');
    assert.deepEqual(blocked.verdicts[1].rejection.details, {
      unitId: shooter.id,
      targetId: target.id,
      blockedBy: mover.id,
    });
    const clear = validateTurn(battle, submissionFor(battle, [shoot, move]));
    assert.equal(clear.ok, true, 'the shot resolves before the move crosses the line');
  });
});

describe('shot modifiers', () => {
  function targetAt(position, facing = 0, patch = {}) {
    return {
      id: 'target-test',
      side: 'sparta',
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1.8,
      rankDepth: 1.8,
      cohesion: 'Steady',
      position: { ...position },
      facing,
      ...patch,
    };
  }

  function shooterAt(patch = {}) {
    return {
      id: 'shooter-test',
      side: 'athens',
      troopType: 'peltast',
      soldiers: 120,
      files: 12,
      lateralInterval: 1.5,
      rankDepth: 1.5,
      cohesion: 'Steady',
      position: { x: 0, y: 0 },
      facing: 180,
      ...patch,
    };
  }

  it('shoots at full effect at close spacing on open ground', () => {
    const { product, modifiers } = shotModifiersOf({
      shooter: shooterAt(),
      target: targetAt({ x: 0, y: 0 }, 0, { lateralInterval: 0.9 }),
      terrainFeatures: [],
      parameters: freshBattle().parameters,
    });
    assert.equal(product, 1);
    assert.deepEqual(modifiers, []);
  });

  it('open spacing softens the volley', () => {
    const { product, modifiers } = shotModifiersOf({
      shooter: shooterAt(),
      target: targetAt({ x: 0, y: 0 }, 0, { lateralInterval: 3.0 }),
      terrainFeatures: [],
      parameters: freshBattle().parameters,
    });
    assert.equal(product, 0.6);
    assert.deepEqual(modifiers, [{ key: 'open-spacing', factor: 0.6 }]);
  });

  it('forest and settlement cover soften the volley, rough ground does not', () => {
    const parameters = freshBattle().parameters;
    for (const [category, factor] of [['forest', 0.5], ['settlement', 0.6]]) {
      const { product, modifiers } = shotModifiersOf({
        shooter: shooterAt(),
        target: targetAt({ x: 500, y: 500 }, 0, { lateralInterval: 0.9 }),
        terrainFeatures: [groundRect('cover-test', category, 480, 480, 520, 520)],
        parameters,
      });
      assert.equal(product, factor);
      assert.deepEqual(modifiers, [{ key: 'cover', factor }]);
    }
    const rough = shotModifiersOf({
      shooter: shooterAt(),
      target: targetAt({ x: 500, y: 500 }, 0, { lateralInterval: 0.9 }),
      terrainFeatures: [groundRect('rough-test', 'rough', 480, 480, 520, 520)],
      parameters,
    });
    assert.equal(rough.product, 1);
    assert.deepEqual(rough.modifiers, []);
  });

  it('a disordered shooter shoots with a penalty', () => {
    const { product, modifiers } = shotModifiersOf({
      shooter: shooterAt({ cohesion: 'Disordered' }),
      target: targetAt({ x: 0, y: 0 }, 0, { lateralInterval: 0.9 }),
      terrainFeatures: [],
      parameters: freshBattle().parameters,
    });
    assert.equal(product, 0.7);
    assert.deepEqual(modifiers, [{ key: 'disordered', factor: 0.7 }]);
  });

  it('multiplies every modifier down', () => {
    const { product, modifiers } = shotModifiersOf({
      shooter: shooterAt({ cohesion: 'Disordered' }),
      target: targetAt({ x: 500, y: 500 }, 0, { lateralInterval: 3.0 }),
      terrainFeatures: [groundRect('forest-test', 'forest', 480, 480, 520, 520)],
      parameters: freshBattle().parameters,
    });
    assert.ok(Math.abs(product - 0.6 * 0.5 * 0.7) < 1e-9);
    assert.deepEqual(modifiers, [
      { key: 'open-spacing', factor: 0.6 },
      { key: 'cover', factor: 0.5 },
      { key: 'disordered', factor: 0.7 },
    ]);
  });
});

describe('shooting resolution', () => {
  function arranged() {
    const battle = freshBattle();
    const shooter = battle.units.find((unit) => unit.id === PELT_A);
    const target = battle.units.find((unit) => unit.id === HOPLITE_B);
    isolate(battle, shooter.id, target.id);
    battle.scenario.terrainFeatures = [];
    place(battle, shooter.id, { x: 500, y: 560 }, 180);
    place(battle, target.id, { x: 500, y: 520 }, 0);
    return { battle, shooter, target };
  }

  it('inflicts seeded losses, records the draw, and shrinks the footprint from the rear', () => {
    const { battle, shooter, target } = arranged();
    const frontBefore = { ...target.position };
    const soldiersBefore = target.soldiers;
    const next = resolveTurn(
      battle,
      { type: 'commit', submission: submissionFor(battle, [{ unitId: shooter.id, kind: 'Shoot', targetId: target.id }]) },
    );
    const shot = next.units.find((unit) => unit.id === target.id);
    const draw = next.events.find(
      (event) => event.type === 'random-draw' && event.purpose === 'shooting-loss',
    );
    assert.ok(draw, 'the shot draws the engine generator');
    assert.equal(draw.unitId, shooter.id);
    assert.equal(draw.targetId, target.id);
    const params = next.parameters.shooting;
    const expected = Math.max(0, Math.round(shooter.soldiers * draw.value * params.lethality));
    assert.equal(draw.result, expected);
    assert.equal(shot.soldiers, soldiersBefore - expected);
    assert.deepEqual(shot.position, frontBefore, 'the front edge stays put');
    assert.equal(shot.files, target.files, 'files hold while soldiers cover them');
    const volley = next.events.find((event) => event.type === 'units-shot');
    assert.ok(volley, 'the shot is recorded');
    assert.equal(volley.unitId, shooter.id);
    assert.equal(volley.targetId, target.id);
    assert.equal(volley.shooters, shooter.soldiers);
    assert.deepEqual(volley.modifiers, []);
    assert.equal(volley.losses, expected);
    assert.deepEqual(volley.soldiers, { before: soldiersBefore, after: shot.soldiers });
  });

  it('caps the losses at the soldiers still standing and narrows the front', () => {
    const { battle, shooter, target } = arranged();
    target.soldiers = 10;
    target.files = 8;
    shooter.soldiers = 300;
    const { state } = rngStateForDraws([{ lo: 0.7, hi: 0.95 }]);
    battle.rngState = state;
    const next = resolveTurn(
      battle,
      { type: 'commit', submission: submissionFor(battle, [{ unitId: shooter.id, kind: 'Shoot', targetId: target.id }]) },
    );
    const shot = next.units.find((unit) => unit.id === target.id);
    const draw = next.events.find(
      (event) => event.type === 'random-draw' && event.purpose === 'shooting-loss',
    );
    const expected = Math.min(
      10,
      Math.max(0, Math.round(300 * draw.value * next.parameters.shooting.lethality)),
    );
    assert.ok(expected >= 3, 'the draw inflicts enough losses to narrow the front');
    assert.equal(shot.soldiers, 10 - expected);
    assert.equal(shot.files, Math.max(1, 10 - expected), 'the front narrows with the soldiers');
  });

  it('softened volleys inflict fewer losses', () => {
    function lossesWith(targetPatch, terrain) {
      const { battle, shooter, target } = arranged();
      Object.assign(target, targetPatch);
      battle.scenario.terrainFeatures = terrain;
      const { state } = rngStateForDraws([{ lo: 0.85, hi: 0.95 }]);
      battle.rngState = state;
      const next = resolveTurn(
        battle,
        { type: 'commit', submission: submissionFor(battle, [{ unitId: shooter.id, kind: 'Shoot', targetId: target.id }]) },
      );
      return next.events.find((event) => event.type === 'units-shot').losses;
    }
    const plain = lossesWith({ lateralInterval: 0.9 }, []);
    const open = lossesWith({ lateralInterval: 3.0 }, []);
    const covered = lossesWith(
      { lateralInterval: 0.9 },
      [groundRect('forest-test', 'forest', 480, 500, 520, 540)],
    );
    assert.ok(open < plain, `open spacing (${open}) softens the volley (${plain})`);
    assert.ok(covered < plain, `cover (${covered}) softens the volley (${plain})`);
  });

  it('steps cohesion down at the shooting thresholds and records it', () => {
    const { battle, shooter, target } = arranged();
    target.cohesionStrain = 1.9;
    const { state } = rngStateForDraws([{ lo: 0.5, hi: 0.6 }]);
    battle.rngState = state;
    const next = resolveTurn(
      battle,
      { type: 'commit', submission: submissionFor(battle, [{ unitId: shooter.id, kind: 'Shoot', targetId: target.id }]) },
    );
    const shot = next.units.find((unit) => unit.id === target.id);
    assert.equal(shot.cohesion, 'Disordered');
    const cohesion = next.events.find((event) => event.type === 'unit-cohesion');
    assert.ok(cohesion, 'the step down is recorded');
    assert.equal(cohesion.cohesionBefore, 'Steady');
    assert.equal(cohesion.cohesionAfter, 'Disordered');
    assert.equal(cohesion.unitId, target.id);
  });

  it('routes at the routed threshold', () => {
    const { battle, shooter, target } = arranged();
    target.cohesionStrain = 3.9;
    const { state } = rngStateForDraws([{ lo: 0.5, hi: 0.6 }]);
    battle.rngState = state;
    const next = resolveTurn(
      battle,
      { type: 'commit', submission: submissionFor(battle, [{ unitId: shooter.id, kind: 'Shoot', targetId: target.id }]) },
    );
    const shot = next.units.find((unit) => unit.id === target.id);
    assert.equal(shot.cohesion, 'Routed');
  });

  it('draws nothing and records nothing without Shoot orders', () => {
    const { battle } = arranged();
    const rngBefore = battle.rngState;
    const next = resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) });
    assert.ok(
      !next.events.some((event) => event.purpose === 'shooting-loss' || event.type === 'units-shot'),
      'no Shoot orders means no shooting events',
    );
    assert.equal(next.rngState, rngBefore, 'no Shoot orders means no shooting draws');
  });

  it('resolves shots in order against the evolving state', () => {
    const battle = freshBattle();
    const first = battle.units.find((unit) => unit.id === PELT_A);
    const second = battle.units.find((unit) => unit.id === '33333333-3333-4333-8333-333333333333');
    second.troopType = 'archer';
    const target = battle.units.find((unit) => unit.id === HOPLITE_B);
    isolate(battle, first.id, second.id, target.id);
    battle.scenario.terrainFeatures = [];
    place(battle, first.id, { x: 500, y: 560 }, 180);
    place(battle, second.id, { x: 540, y: 560 }, 180);
    place(battle, target.id, { x: 500, y: 520 }, 0);
    const orders = [
      { unitId: first.id, kind: 'Shoot', targetId: target.id },
      { unitId: second.id, kind: 'Shoot', targetId: target.id },
    ];
    assert.equal(validateTurn(battle, submissionFor(battle, orders)).ok, true);
    const next = resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, orders) });
    const volleys = next.events.filter((event) => event.type === 'units-shot');
    assert.equal(volleys.length, 2);
    assert.equal(volleys[1].soldiers.before, volleys[0].soldiers.after);
  });

  it('replays the same seed to the identical battle', () => {
    function play() {
      const { battle } = arranged();
      battle.rngState = rngStateForDraws([{ lo: 0.2, hi: 0.8 }]).state;
      return resolveTurn(
        battle,
        { type: 'commit', submission: submissionFor(battle, [{ unitId: PELT_A, kind: 'Shoot', targetId: HOPLITE_B }]) },
      );
    }
    const first = play();
    const second = play();
    assert.deepEqual(second.events, first.events);
    assert.deepEqual(second.units, first.units);
    assert.equal(second.rngState, first.rngState);
  });

  it('needs a battle with units and events', () => {
    assert.throws(() => resolveShootingPhase(null, []), /battle state object/);
    assert.throws(() => resolveShootingPhase({ units: [], events: null }, []), /units and events/);
  });
});

describe('shoot candidates in the available actions', () => {
  function arranged() {
    const battle = freshBattle();
    const shooter = battle.units.find((unit) => unit.id === PELT_A);
    const target = battle.units.find((unit) => unit.id === HOPLITE_B);
    isolate(battle, shooter.id, target.id);
    battle.scenario.terrainFeatures = [];
    place(battle, shooter.id, { x: 500, y: 560 }, 180);
    place(battle, target.id, { x: 500, y: 520 }, 0);
    return { battle, shooter, target };
  }

  it('lists enemies in range, arc, and line as hints', () => {
    const { battle, shooter, target } = arranged();
    const entry = availableActions(battle, battle.activeSide).units
      .find((item) => item.unitId === shooter.id);
    assert.deepEqual(entry.permitted.map((item) => item.kind),
      ['Hold', 'Move', 'Charge', 'Reform', 'Shoot']);
    assert.deepEqual(entry.shootCandidates, [{ targetId: target.id, distanceM: 40 }]);
  });

  it('lists no candidates for troop types without missiles', () => {
    const { battle } = arranged();
    const hoplite = battle.units.find((unit) => unit.id === HOPLITE_A);
    place(battle, hoplite.id, { x: 500, y: 590 }, 180);
    const entry = availableActions(battle, battle.activeSide).units
      .find((item) => item.unitId === hoplite.id);
    assert.deepEqual(entry.shootCandidates, []);
    const refused = entry.unavailable.find((item) => item.kind === 'Shoot');
    assert.ok(refused, 'Shoot is listed as unavailable');
    assert.equal(refused.code, 'order_not_permitted');
  });

  it('excludes engaged, distant, and blocked targets', () => {
    const { battle, shooter, target } = arranged();
    const actions = () => availableActions(battle, battle.activeSide).units
      .find((item) => item.unitId === shooter.id).shootCandidates;
    assert.equal(actions().length, 1);

    engage(battle, target.id, HOPLITE_A);
    assert.deepEqual(actions(), [], 'engaged targets are excluded');
    target.engaged = null;

    place(battle, target.id, { x: 500, y: 100 }, 0);
    assert.deepEqual(actions(), [], 'distant targets are excluded');
    place(battle, target.id, { x: 500, y: 520 }, 0);

    battle.scenario.terrainFeatures = [groundRect('forest-test', 'forest', 490, 535, 510, 545)];
    assert.deepEqual(actions(), [], 'blocked targets are excluded');
  });

  it('refuses Shoot for engaged and routed units in the permission list', () => {
    const { battle, shooter } = arranged();
    engage(battle, shooter.id, HOPLITE_A);
    let entry = availableActions(battle, battle.activeSide).units
      .find((item) => item.unitId === shooter.id);
    assert.deepEqual(entry.permitted, [{ kind: 'Hold' }, { kind: 'Withdraw' }]);
    shooter.engaged = null;
    shooter.cohesion = 'Routed';
    entry = availableActions(battle, battle.activeSide).units
      .find((item) => item.unitId === shooter.id);
    assert.deepEqual(entry.permitted, [{ kind: 'Rally' }]);
  });
});
