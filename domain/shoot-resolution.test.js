// Unit tests for Shoot orders: modifiers, resolution, and candidates
// (decisions #6 items 11, 19, #7 items 3, 5, 8). Split from
// `domain/shoot.test.js` (issue #142); validation lives in
// `domain/shoot-validation.test.js`. Shared fixtures live in
// `domain/shoot-test-helpers.js`. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { availableActions, resolveTurn, validateTurn } from './turn.js';
import { resolveShootingPhase, shotModifiersOf } from './shoot.js';
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
  rngStateForDraws,
} from './shoot-test-helpers.js';

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
