// Unit tests for the cohesion slice: disorder, rout, flight, rally, and
// removals (decision #6 items 12, 15-16, 20-22).
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRng, startBattle } from './battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  availableActions,
  resolveTurn,
  validateTurn,
} from './turn.js';
import { combatParamsOf, resolveCombatPhase } from './combat.js';
import {
  DEFAULT_COHESION,
  breakEngagements,
  cohesionMaxFor,
  cohesionParamsOf,
  cohesionStateForValue,
  distanceBetween,
  flightDestination,
  flightOutcomeFor,
  isActiveUnit,
  loseCohesion,
  nearestEnemyOf,
  resolveCohesionPhase,
  syncCohesion,
  unitCohesionState,
  unitCohesionValue,
} from './cohesion.js';
import { getTroopType } from './polis-classical.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, 'fixtures');

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

function ownUnits(battle) {
  return battle.units.filter((unit) => unit.side === battle.activeSide);
}

function foreignUnits(battle) {
  return battle.units.filter((unit) => unit.side !== battle.activeSide);
}

function hopliteOf(battle) {
  return ownUnits(battle).find((unit) => unit.troopType === 'hoplite');
}

function place(battle, unitId, position, facing) {
  const unit = battle.units.find((entry) => entry.id === unitId);
  unit.position = { ...position };
  if (facing !== undefined) {
    unit.facing = facing;
  }
  return unit;
}

function engage(battle, firstId, secondId, aspect = 'front', frontageM = 16, files = 16) {
  const first = battle.units.find((entry) => entry.id === firstId);
  const second = battle.units.find((entry) => entry.id === secondId);
  first.engaged = { unitId: second.id, edge: 'front', aspect, frontageM, files };
  second.engaged = {
    unitId: first.id,
    edge: aspect === 'front' ? 'front' : 'left',
    aspect,
    frontageM,
    files,
  };
  return { first, second };
}

function isolate(battle, ...keepIds) {
  for (const unit of battle.units) {
    if (!keepIds.includes(unit.id)) {
      place(battle, unit.id, { x: 100, y: 100 }, 0);
      unit.engaged = null;
    }
  }
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

// An rng state whose next `count` draws each fall inside the wanted ranges.
function rngStateForDraws(ranges) {
  for (let state = 0; state < 200000; state += 1) {
    const rng = createRng(state);
    const values = ranges.map(() => rng.next());
    if (ranges.every((range, index) => values[index] >= range.lo && values[index] < range.hi)) {
      return { state, values };
    }
  }
  throw new Error('No rng state found for the wanted draw ranges.');
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

describe('cohesion values and thresholds', () => {
  it('runs from 0 to a per-troop-type maximum', () => {
    assert.equal(cohesionMaxFor('hoplite'), getTroopType('hoplite').cohesionMax);
    assert.equal(cohesionMaxFor('archer'), getTroopType('archer').cohesionMax);
    assert.ok(cohesionMaxFor('hoplite') > cohesionMaxFor('archer'));
    const battle = freshBattle();
    for (const unit of battle.units) {
      assert.equal(unit.cohesionValue, cohesionMaxFor(unit.troopType));
      assert.ok(unit.cohesionValue > 0 && unit.cohesionValue <= cohesionMaxFor(unit.troopType));
    }
  });

  it('places 0 in Routed, values below the threshold in Disordered, the rest Steady', () => {
    const params = cohesionParamsOf({});
    assert.equal(cohesionStateForValue(0, params), 'Routed');
    assert.equal(cohesionStateForValue(-1, params), 'Routed');
    assert.equal(cohesionStateForValue(params.disorderedBelow - 1, params), 'Disordered');
    assert.equal(cohesionStateForValue(1, params), 'Disordered');
    assert.equal(cohesionStateForValue(params.disorderedBelow, params), 'Steady');
    assert.equal(cohesionStateForValue(cohesionMaxFor('hoplite'), params), 'Steady');
  });

  it('keeps the state string in sync with the numeric value and clamps it', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    unit.cohesionValue = 999;
    syncCohesion(unit, battle.parameters);
    assert.equal(unit.cohesionValue, cohesionMaxFor('hoplite'));
    assert.equal(unit.cohesion, 'Steady');
    unit.cohesionValue = -5;
    syncCohesion(unit, battle.parameters);
    assert.equal(unit.cohesionValue, 0);
    assert.equal(unit.cohesion, 'Routed');
    const transition = loseCohesion({ ...unit, cohesionValue: 12, cohesion: 'Steady' }, 10, battle.parameters);
    assert.equal(transition.stateAfter, 'Disordered');
  });

  it('reads legacy string cohesion for older saves', () => {
    const params = cohesionParamsOf({});
    assert.equal(unitCohesionState({ cohesion: 'Routed' }, params), 'Routed');
    assert.equal(unitCohesionState({ cohesion: 'Disordered' }, params), 'Disordered');
    assert.equal(unitCohesionValue({ cohesion: 'Routed' }, params), 0);
    assert.ok(unitCohesionValue({ cohesion: 'Steady', troopType: 'hoplite' }, params) > 0);
  });
});

describe('rout at zero cohesion', () => {
  it('routs at 0, breaks every engagement, and flees at once', () => {
    const battle = freshBattle();
    const charger = hopliteOf(battle);
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    isolate(battle, charger.id, target.id);
    place(battle, charger.id, { x: 500, y: 600 }, 180);
    place(battle, target.id, { x: 500, y: 560 }, 0);
    engage(battle, charger.id, target.id);
    const victim = battle.units.find((unit) => unit.id === target.id);
    victim.cohesionValue = 1;
    syncCohesion(victim, battle.parameters);
    assert.equal(unitCohesionState(victim, battle.parameters), 'Disordered');
    battle.parameters.combat = { ...combatParamsOf({}), lethality: 1 };
    battle.parameters.cohesion = { ...cohesionParamsOf({}), flankRoutPassChance: 1 };
    battle.rngState = rngStateForDraws([{ lo: 0.9, hi: 1 }, { lo: 0, hi: 0.001 }]).state;
    const before = { ...victim.position };
    resolveCombatPhase(battle);
    const routed = battle.units.find((unit) => unit.id === target.id);
    assert.equal(unitCohesionState(routed, battle.parameters), 'Routed');
    assert.equal(routed.cohesionValue, 0);
    assert.equal(routed.engaged, null, 'routing breaks its own contact');
    const chargerAfter = battle.units.find((unit) => unit.id === charger.id);
    assert.notEqual(chargerAfter.engaged?.unitId, target.id, 'routing breaks the enemy contact too');
    const cohesionEvent = battle.events.find(
      (event) => event.type === 'unit-cohesion' && event.unitId === target.id,
    );
    assert.ok(cohesionEvent, 'the state change is recorded');
    assert.equal(cohesionEvent.cohesionAfter, 'Routed');
    assert.equal(cohesionEvent.valueAfter, 0);
    const flight = battle.events.find(
      (event) => (event.type === 'unit-routed' || event.type === 'unit-fled') && event.unitId === target.id,
    );
    assert.ok(flight, 'the immediate flight is recorded');
    if (flight.type === 'unit-routed') {
      assert.notDeepEqual(routed.position, before, 'the unit flees at once');
      assert.equal(Math.round(distanceBetween(before, routed.position)), DEFAULT_COHESION.flightM);
    }
  });
});

describe('flank and rear rout tests', () => {
  function flankedPair(passChance) {
    const battle = freshBattle();
    const charger = hopliteOf(battle);
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    isolate(battle, charger.id, target.id);
    place(battle, charger.id, { x: 500, y: 600 }, 180);
    place(battle, target.id, { x: 500, y: 560 }, 0);
    engage(battle, charger.id, target.id, 'flank');
    battle.parameters.combat = {
      ...combatParamsOf({}),
      lethality: 0.05,
      cohesionPerCasualty: 0.08,
      depthReduction: 0,
    };
    battle.parameters.cohesion = { ...cohesionParamsOf({}), flankRoutPassChance: passChance };
    battle.rngState = rngStateForDraws([
      { lo: 0.9, hi: 1 },
      { lo: 0, hi: 0.001 },
      { lo: 0, hi: 1 },
    ]).state;
    return { battle, charger, target };
  }

  it('routs the loser of a flank fight when the chance test fails', () => {
    const { battle, target } = flankedPair(0);
    resolveCombatPhase(battle);
    const victim = battle.units.find((unit) => unit.id === target.id);
    assert.equal(unitCohesionState(victim, battle.parameters), 'Routed');
    const draw = battle.events.find(
      (event) => event.type === 'random-draw' && event.purpose === 'rout-test' && event.unitId === target.id,
    );
    assert.ok(draw, 'the draw is recorded');
    assert.equal(draw.result, 'failed');
    assert.equal(draw.aspect, 'flank');
    const marked = battle.events.find(
      (event) => event.type === 'unit-cohesion' && event.unitId === target.id && event.cause === 'flank-test',
    );
    assert.ok(marked, 'the flank-test rout is recorded');
    assert.equal(victim.engaged, null, 'routing breaks engagements');
  });

  it('holds the loser when the chance test passes', () => {
    const { battle, target } = flankedPair(1);
    resolveCombatPhase(battle);
    const survivor = battle.units.find((unit) => unit.id === target.id);
    assert.notEqual(unitCohesionState(survivor, battle.parameters), 'Routed');
    const draw = battle.events.find(
      (event) => event.type === 'random-draw' && event.purpose === 'rout-test' && event.unitId === target.id,
    );
    assert.ok(draw, 'the draw is recorded');
    assert.equal(draw.result, 'passed');
  });

  it('never tests the winner of the fight', () => {
    const { battle, charger } = flankedPair(0);
    resolveCombatPhase(battle);
    const draws = battle.events.filter(
      (event) => event.type === 'random-draw' && event.purpose === 'rout-test',
    );
    assert.ok(draws.every((draw) => draw.unitId !== charger.id), 'only the loser tests');
  });
});

describe('rout flights', () => {
  it('flees directly away from the threat by the flight distance', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    const threat = { x: 500, y: 400 };
    const destination = flightDestination(unit, threat, 60);
    assert.deepEqual(destination, { x: 500, y: 560 });
  });

  it('moves the resting footprint when the way is clear', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    isolate(battle, unit.id);
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    const outcome = flightOutcomeFor(unit, { x: 500, y: 400 }, battle, battle.parameters);
    assert.equal(outcome.outcome, 'moved');
    assert.deepEqual(outcome.destination, { x: 500, y: 560 });
  });

  it('leaves the battlefield when the flight touches the edge, counted as lost', () => {
    const battle = freshBattle();
    const charger = hopliteOf(battle);
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    isolate(battle, charger.id, target.id);
    place(battle, charger.id, { x: 500, y: 700 }, 180);
    place(battle, target.id, { x: 500, y: 850 }, 0);
    engage(battle, charger.id, target.id);
    const victim = battle.units.find((unit) => unit.id === target.id);
    victim.cohesionValue = 0;
    syncCohesion(victim, battle.parameters);
    resolveCohesionPhase(battle, target.side);
    const fled = battle.units.find((unit) => unit.id === target.id);
    assert.equal(fled.status, 'fled');
    const event = battle.events.find((event) => event.type === 'unit-fled' && event.unitId === target.id);
    assert.ok(event, 'the flight off the edge is recorded');
    assert.equal(event.cause, 'cohesion-phase');
  });

  it('destroys the unit when another unit blocks the flight', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const foe = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    const blocker = ownUnits(battle).find((entry) => entry.id !== unit.id);
    isolate(battle, unit.id, foe.id, blocker.id);
    place(battle, foe.id, { x: 500, y: 400 }, 0);
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    // The flight from (500,500) away from (500,400) lands at (500,560):
    // park a friend across the landing footprint.
    place(battle, blocker.id, { x: 500, y: 560 }, 0);
    const outcome = flightOutcomeFor(unit, { ...foe.position }, battle, battle.parameters);
    assert.equal(outcome.outcome, 'destroyed');
    assert.equal(outcome.reason, 'flight-blocked');
  });

  it('destroys the unit when water blocks the flight', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    isolate(battle, unit.id);
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    battle.scenario.terrainFeatures = [groundRect('lake', 'water', 480, 550, 520, 580)];
    const outcome = flightOutcomeFor(unit, { x: 500, y: 400 }, battle, battle.parameters);
    assert.equal(outcome.outcome, 'destroyed');
    assert.equal(outcome.reason, 'flight-blocked-water');
  });

  it('flees again in each of its side’s Cohesion phases', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const foe = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    isolate(battle, unit.id, foe.id);
    place(battle, foe.id, { x: 500, y: 300 }, 0);
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    unit.cohesionValue = 0;
    syncCohesion(unit, battle.parameters);
    const first = { ...unit.position };
    resolveCohesionPhase(battle, unit.side);
    const afterFirst = battle.units.find((entry) => entry.id === unit.id);
    assert.notDeepEqual(afterFirst.position, first, 'the first phase flees');
    assert.equal(unitCohesionState(afterFirst, battle.parameters), 'Routed', 'still Routed');
    const second = { ...afterFirst.position };
    resolveCohesionPhase(battle, unit.side);
    const afterSecond = battle.units.find((entry) => entry.id === unit.id);
    assert.notDeepEqual(afterSecond.position, second, 'the next phase flees again');
    const flights = battle.events.filter(
      (event) => event.type === 'unit-routed' && event.unitId === unit.id,
    );
    assert.equal(flights.length, 2, 'each flight is recorded');
  });

  it('never flees the other side’s Routed units', () => {
    const battle = freshBattle();
    const foe = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    isolate(battle, foe.id);
    foe.cohesionValue = 0;
    syncCohesion(foe, battle.parameters);
    const before = { ...foe.position };
    resolveCohesionPhase(battle, battle.activeSide);
    const after = battle.units.find((entry) => entry.id === foe.id);
    assert.deepEqual(after.position, before, 'the enemy waits for its own phase');
  });

  it('destroys a Routed unit that is attacked', () => {
    const battle = freshBattle();
    const charger = hopliteOf(battle);
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    isolate(battle, charger.id, target.id);
    place(battle, charger.id, { x: 500, y: 600 }, 180);
    place(battle, target.id, { x: 500, y: 560 }, 0);
    engage(battle, charger.id, target.id);
    const victim = battle.units.find((unit) => unit.id === target.id);
    victim.cohesionValue = 0;
    syncCohesion(victim, battle.parameters);
    const drawsBefore = battle.events.length;
    resolveCombatPhase(battle);
    const destroyed = battle.units.find((unit) => unit.id === target.id);
    assert.equal(destroyed.status, 'destroyed');
    const event = battle.events.find(
      (event) => event.type === 'unit-destroyed' && event.unitId === target.id,
    );
    assert.ok(event, 'the destruction is recorded');
    assert.equal(event.reason, 'attacked-while-routed');
    const pairDraws = battle.events
      .slice(drawsBefore)
      .filter((event) => event.type === 'random-draw' && event.purpose === 'combat-loss');
    assert.equal(pairDraws.length, 0, 'no fight draws for the destroyed unit');
  });
});

describe('below-strength removal', () => {
  it('removes a unit worn below its share of starting soldiers', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    isolate(battle, unit.id);
    const starting = unit.startingSoldiers;
    assert.ok(starting > 0);
    unit.soldiers = Math.floor(starting * 0.24);
    resolveCohesionPhase(battle, unit.side);
    const removed = battle.units.find((entry) => entry.id === unit.id);
    assert.equal(removed.status, 'destroyed');
    const event = battle.events.find(
      (entry) => entry.type === 'unit-destroyed' && entry.unitId === unit.id,
    );
    assert.ok(event, 'the removal is recorded');
    assert.equal(event.reason, 'below-strength');
  });

  it('holds a unit exactly at its share', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    isolate(battle, unit.id);
    const share = cohesionParamsOf(battle.parameters).destructionShare;
    unit.soldiers = Math.ceil(unit.startingSoldiers * share);
    resolveCohesionPhase(battle, unit.side);
    assert.equal(unit.status, 'active', 'below means strictly below');
  });

  it('spreads no panic: neighbours pay nothing', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const neighbour = ownUnits(battle).find((entry) => entry.id !== unit.id);
    isolate(battle, unit.id, neighbour.id);
    const neighbourValue = unitCohesionValue(neighbour, battle.parameters);
    unit.soldiers = 0;
    resolveCohesionPhase(battle, unit.side);
    assert.equal(unit.status, 'destroyed');
    assert.equal(unitCohesionValue(neighbour, battle.parameters), neighbourValue);
    assert.ok(
      !battle.events.some(
        (event) => event.type === 'unit-cohesion' && event.unitId === neighbour.id,
      ),
      'no contagion event for the neighbour',
    );
  });
});

describe('terrain strain for close spacing', () => {
  function closeHopliteOn(category) {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    isolate(battle, unit.id);
    unit.lateralInterval = 0.9;
    unit.rankDepth = 0.9;
    const rect = category === 'rough'
      ? [1150, 620, 1250, 700]
      : category === 'settlement'
        ? [150, 130, 290, 220]
        : [130, 590, 270, 690];
    battle.scenario.terrainFeatures = [groundRect(`${category}-probe`, category, ...rect)];
    place(battle, unit.id, { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2 }, 0);
    return { battle, unit };
  }

  for (const category of ['rough', 'forest', 'settlement']) {
    it(`loses cohesion in close spacing on ${category}`, () => {
      const { battle, unit } = closeHopliteOn(category);
      const before = unitCohesionValue(unit, battle.parameters);
      resolveCohesionPhase(battle, unit.side);
      const after = battle.units.find((entry) => entry.id === unit.id);
      assert.equal(
        unitCohesionValue(after, battle.parameters),
        before - cohesionParamsOf(battle.parameters).terrainLoss,
      );
      const event = battle.events.find(
        (entry) => entry.type === 'unit-cohesion' && entry.unitId === unit.id,
      );
      assert.ok(event, 'the strain is recorded');
      assert.equal(event.cause, 'terrain');
      assert.equal(event.cover, category);
    });
  }

  it('spares open spacing and open ground', () => {
    const { battle, unit } = closeHopliteOn('forest');
    unit.lateralInterval = 3.0;
    const before = unitCohesionValue(unit, battle.parameters);
    resolveCohesionPhase(battle, unit.side);
    assert.equal(unitCohesionValue(unit, battle.parameters), before, 'open spacing is spared');

    const plain = freshBattle();
    const foot = hopliteOf(plain);
    isolate(plain, foot.id);
    foot.lateralInterval = 0.9;
    const valueBefore = unitCohesionValue(foot, plain.parameters);
    resolveCohesionPhase(plain, foot.side);
    assert.equal(unitCohesionValue(foot, plain.parameters), valueBefore, 'open ground is spared');
  });
});

describe('rally', () => {
  it('restores a Disordered unit without moving it', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    isolate(battle, unit.id);
    unit.cohesionValue = 3;
    syncCohesion(unit, battle.parameters);
    assert.equal(unitCohesionState(unit, battle.parameters), 'Disordered');
    const before = { ...unit.position };
    const next = resolveTurn(
      battle,
      { type: 'commit', submission: submissionFor(battle, [{ unitId: unit.id, kind: 'Rally' }]) },
    );
    const rallied = next.units.find((entry) => entry.id === unit.id);
    assert.equal(
      rallied.cohesionValue,
      Math.min(3 + cohesionParamsOf(battle.parameters).rallyRegain, cohesionMaxFor('hoplite')),
    );
    assert.deepEqual(rallied.position, before, 'rally never moves the unit');
    const event = next.events.find(
      (entry) => entry.type === 'unit-rallied' && entry.unitId === unit.id,
    );
    assert.ok(event, 'the rally is recorded');
    assert.equal(event.result, 'rallied');
    assert.equal(event.cohesionBefore, 'Disordered');
  });

  it('rejects a Routed rally with an enemy too close, naming the distance', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const foe = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    isolate(battle, unit.id, foe.id);
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    place(battle, foe.id, { x: 500, y: 550 }, 180);
    unit.cohesionValue = 0;
    syncCohesion(unit, battle.parameters);
    const result = validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Rally' }]));
    assert.equal(result.ok, false);
    const rejection = result.verdicts[0].rejection;
    assert.equal(rejection.code, 'order_not_permitted');
    assert.equal(rejection.details.reason, 'enemy-too-close');
    assert.equal(rejection.details.nearestEnemyId, foe.id);
    assert.ok(rejection.details.distanceM < cohesionParamsOf(battle.parameters).rallyClearM);
    assert.equal(rejection.details.requiredM, cohesionParamsOf(battle.parameters).rallyClearM);
  });

  it('returns a clear Routed unit as Disordered on a passed draw, without moving', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const foe = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    isolate(battle, unit.id, foe.id);
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    place(battle, foe.id, { x: 500, y: 200 }, 0);
    unit.cohesionValue = 0;
    syncCohesion(unit, battle.parameters);
    battle.parameters.cohesion = { ...cohesionParamsOf(battle.parameters), rallyChance: 1 };
    const before = { ...unit.position };
    const next = resolveTurn(
      battle,
      { type: 'commit', submission: submissionFor(battle, [{ unitId: unit.id, kind: 'Rally' }]) },
    );
    const rallied = next.units.find((entry) => entry.id === unit.id);
    assert.equal(unitCohesionState(rallied, battle.parameters), 'Disordered');
    assert.equal(rallied.cohesionValue, cohesionParamsOf(battle.parameters).rallyTo);
    assert.deepEqual(rallied.position, before, 'rally never moves the unit');
    const draw = next.events.find(
      (entry) => entry.type === 'random-draw' && entry.purpose === 'rally' && entry.unitId === unit.id,
    );
    assert.ok(draw, 'the draw is recorded');
    assert.equal(draw.result, 'passed');
    const event = next.events.find(
      (entry) => entry.type === 'unit-rallied' && entry.unitId === unit.id,
    );
    assert.ok(event, 'the rally is recorded');
    assert.equal(event.cohesionBefore, 'Routed');
    assert.equal(event.cohesionAfter, 'Disordered');
  });

  it('holds a Routed unit on a failed draw', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const foe = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    isolate(battle, unit.id, foe.id);
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    place(battle, foe.id, { x: 500, y: 200 }, 0);
    unit.cohesionValue = 0;
    syncCohesion(unit, battle.parameters);
    battle.parameters.cohesion = { ...cohesionParamsOf(battle.parameters), rallyChance: 0 };
    const next = resolveTurn(
      battle,
      { type: 'commit', submission: submissionFor(battle, [{ unitId: unit.id, kind: 'Rally' }]) },
    );
    const stayed = next.units.find((entry) => entry.id === unit.id);
    assert.equal(unitCohesionState(stayed, battle.parameters), 'Routed');
    const draw = next.events.find(
      (entry) => entry.type === 'random-draw' && entry.purpose === 'rally' && entry.unitId === unit.id,
    );
    assert.ok(draw, 'the draw is recorded');
    assert.equal(draw.result, 'failed');
    assert.ok(
      !next.events.some(
        (entry) => entry.type === 'unit-rallied' && entry.unitId === unit.id,
      ),
      'no rally event on a failed draw',
    );
  });

  it('permits only Rally for Routed units and no Rally for Steady ones', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    unit.cohesionValue = 0;
    syncCohesion(unit, battle.parameters);
    const routedActions = availableActions(battle, battle.activeSide).units.find(
      (entry) => entry.unitId === unit.id,
    );
    assert.deepEqual(routedActions.permitted, [{ kind: 'Rally' }]);

    const calm = freshBattle();
    const steady = hopliteOf(calm);
    const steadyActions = availableActions(calm, calm.activeSide).units.find(
      (entry) => entry.unitId === steady.id,
    );
    assert.ok(!steadyActions.permitted.some((entry) => entry.kind === 'Rally'));
    const refused = validateTurn(
      calm,
      submissionFor(calm, [{ unitId: steady.id, kind: 'Rally' }]),
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.verdicts[0].rejection.code, 'order_not_permitted');
  });
});

describe('helpers', () => {
  it('breaks every engagement a rout held', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const foe = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    engage(battle, unit.id, foe.id);
    const broken = breakEngagements(battle, unit.id);
    assert.ok(broken.includes(unit.id));
    assert.equal(unit.engaged, null);
    assert.equal(foe.engaged, null);
  });

  it('finds the nearest active enemy and ignores the spent', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const foes = foreignUnits(battle);
    isolate(battle, unit.id, ...foes.map((entry) => entry.id));
    place(battle, unit.id, { x: 500, y: 500 }, 0);
    place(battle, foes[0].id, { x: 500, y: 560 }, 0);
    place(battle, foes[1].id, { x: 500, y: 520 }, 0);
    foes[1].status = 'destroyed';
    const { enemy, distanceM } = nearestEnemyOf(battle, unit);
    assert.equal(enemy.id, foes[0].id);
    assert.equal(distanceM, 60);
    assert.ok(isActiveUnit(unit));
    assert.ok(!isActiveUnit(foes[1]));
  });
});
