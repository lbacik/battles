// Unit tests for Shoot orders: missile ranges, aiming, and validation
// (decisions #6 items 11, 19, #7 items 3, 5, 8). Split from
// `domain/shoot.test.js` (issue #142); resolution lives in
// `domain/shoot-resolution.test.js`. Shared fixtures live in
// `domain/shoot-test-helpers.js`. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTurn } from './turn.js';
import {
  aimAtTarget,
  lineBlocker,
  missileRangeOf,
  shootingParamsOf,
  validateShootOnField,
} from './shoot.js';
import { footprintAt } from './movement.js';
import {
  HOPLITE_A,
  PELT_A,
  HOPLITE_B,
  freshBattle,
  submissionFor,
  place,
  isolate,
  engage,
  groundRect,
  tinyShooter,
  tinyTarget,
  cornersOf,
  rejectedVerdict,
  validateOne,
} from './shoot-test-helpers.js';

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
