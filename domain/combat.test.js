// Unit tests for Combat between engaged units (decisions #6 items 17, 18, 23).
//
// Every engaged pair fights once per Combat phase, on both sides, with seeded
// losses and cohesion loss; losses visibly shrink the footprints from the rear.
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRng, startBattle } from './battle.js';
import { SUBMISSION_FORMAT_VERSION, resolveTurn } from './turn.js';
import {
  collectEngagedPairs,
  combatParamsOf,
  elevationLevelAt,
  footprintAfterLosses,
  lossesOf,
  resolveCombatPhase,
  splitFightingFiles,
  strainOf,
  strengthOf,
} from './combat.js';

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

// Move a battle unit to a new position/facing. Tests mutate the started
// battle directly: combat reads the battle state as-is and never re-checks
// playability, so arranging footprints by hand is legitimate.
function place(battle, unitId, position, facing) {
  const unit = battle.units.find((entry) => entry.id === unitId);
  unit.position = { ...position };
  if (facing !== undefined) {
    unit.facing = facing;
  }
  return unit;
}

// Mark two units engaged with each other, as a committed charge would leave
// them after a frontal contact.
function engage(battle, firstId, secondId, frontageM = 16, files = 16) {
  const first = battle.units.find((entry) => entry.id === firstId);
  const second = battle.units.find((entry) => entry.id === secondId);
  first.engaged = { unitId: second.id, edge: 'front', aspect: 'front', frontageM, files };
  second.engaged = { unitId: first.id, edge: 'front', aspect: 'front', frontageM, files };
  return { first, second };
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

function hillRect(id, level, minX, minY, maxX, maxY) {
  return {
    id,
    kind: 'elevation',
    level,
    polygon: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
  };
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

describe('combat parameters', () => {
  it('resolves from the battle snapshot with documented defaults', () => {
    const params = combatParamsOf({ combat: { lethality: 0.1 } });
    assert.equal(params.lethality, 0.1);
    assert.ok(params.chargeBonus > 1, 'a charge bonus is configured');
    assert.ok(params.rearFactor >= params.flankFactor, 'rear beats flank');
    assert.ok(params.routedAt > params.disorderedAt, 'rout follows disorder');
    const fallback = combatParamsOf(undefined);
    assert.equal(fallback.lethality, combatParamsOf({}).lethality);
  });
});

describe('collectEngagedPairs', () => {
  it('lists each engaged pair once, on both sides of the contact', () => {
    const battle = freshBattle();
    const charger = hopliteOf(battle);
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    isolate(battle, charger.id, target.id);
    engage(battle, charger.id, target.id);
    const pairs = collectEngagedPairs(battle.units);
    assert.equal(pairs.length, 1);
    assert.deepEqual([pairs[0].aId, pairs[0].bId].sort(), [charger.id, target.id].sort());
    assert.equal(pairs[0].aspect, 'front');
    assert.equal(pairs[0].frontageM, 16);
  });

  it('keeps a one-sided charge contact as its own pair', () => {
    const battle = freshBattle();
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    const first = hopliteOf(battle);
    const second = ownUnits(battle).find((unit) => unit.troopType === 'peltast');
    isolate(battle, target.id, first.id, second.id);
    engage(battle, first.id, target.id);
    // A second charger takes the target's flank; the target keeps its first
    // contact, exactly as charge resolution leaves it.
    const charger = battle.units.find((unit) => unit.id === second.id);
    charger.engaged = { unitId: target.id, edge: 'front', aspect: 'flank', frontageM: 8, files: 8 };
    const pairs = collectEngagedPairs(battle.units);
    assert.equal(pairs.length, 2);
    const flanker = pairs.find((pair) => pair.aspect === 'flank');
    assert.ok(flanker, 'the flank contact is fought as its own pair');
    assert.deepEqual([flanker.aId, flanker.bId].sort(), [second.id, target.id].sort());
  });

  it('ignores contacts pointing at unknown units', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    isolate(battle, unit.id);
    unit.engaged = { unitId: 'missing', edge: 'front', aspect: 'front', frontageM: 8, files: 8 };
    assert.deepEqual(collectEngagedPairs(battle.units), []);
  });
});

describe('strengthOf', () => {
  const base = {
    files: 10,
    combatFactor: 2,
    params: combatParamsOf({}),
    terrainFactor: 1,
  };

  it('is fighting files times the troop-type combat factor', () => {
    const { strength, modifiers } = strengthOf({ ...base });
    assert.equal(strength, 20);
    assert.deepEqual(modifiers, []);
  });

  it('applies the charge bonus in the first fight', () => {
    const plain = strengthOf({ ...base });
    const charged = strengthOf({ ...base, chargeFresh: true });
    assert.equal(charged.strength, plain.strength * combatParamsOf({}).chargeBonus);
    assert.ok(charged.modifiers.some((entry) => entry.key === 'charge'));
  });

  it('applies the flank and rear aspects to the flanker', () => {
    const params = combatParamsOf({});
    const flank = strengthOf({ ...base, flankerAspect: 'flank' });
    const rear = strengthOf({ ...base, flankerAspect: 'rear' });
    assert.equal(flank.strength, 20 * params.flankFactor);
    assert.equal(rear.strength, 20 * params.rearFactor);
  });

  it('rewards the higher elevation', () => {
    const params = combatParamsOf({});
    const high = strengthOf({ ...base, elevationHigher: true });
    assert.equal(high.strength, 20 * params.elevationFactor);
    assert.ok(high.modifiers.some((entry) => entry.key === 'elevation'));
  });

  it('scales with terrain, the river penalty, and the Disordered penalty', () => {
    const params = combatParamsOf({});
    const forest = strengthOf({ ...base, terrainFactor: params.terrainFactor.forest });
    assert.ok(forest.strength < 20);
    const river = strengthOf({ ...base, rivered: true });
    assert.equal(river.strength, 20 * params.riverFactor);
    const disordered = strengthOf({ ...base, disordered: true });
    assert.equal(disordered.strength, 20 * params.disorderedFactor);
  });
});

describe('lossesOf and strainOf', () => {
  it('scales strength by the draw and the lethality parameter', () => {
    assert.equal(lossesOf({ strength: 48, draw: 0.5, lethality: 0.1 }), 2);
    assert.equal(lossesOf({ strength: 48, draw: 0, lethality: 0.1 }), 0);
  });

  it('charges the loser more cohesion strain, with flank and rear extras', () => {
    const params = combatParamsOf({});
    const winner = strainOf({ taken: 4, inflicted: 10, ranks: 1, params });
    const loser = strainOf({ taken: 10, inflicted: 4, ranks: 1, params });
    assert.ok(loser > winner, 'the side that inflicted fewer losses loses more');
    const tied = strainOf({ taken: 6, inflicted: 6, ranks: 1, params });
    assert.ok(tied < loser, 'no loser multiplier on a tied exchange');
    const flanked = strainOf({ taken: 6, inflicted: 6, ranks: 1, flankedAspect: 'flank', params });
    const reared = strainOf({ taken: 6, inflicted: 6, ranks: 1, flankedAspect: 'rear', params });
    assert.ok(flanked > tied, 'flank contact adds cohesion loss');
    assert.ok(reared > flanked, 'rear contact adds more than flank');
  });

  it('lets depth reduce cohesion loss, never increase losses', () => {
    const params = combatParamsOf({});
    const shallow = strainOf({ taken: 10, inflicted: 10, ranks: 1, depthTrait: true, params });
    const deep = strainOf({ taken: 10, inflicted: 10, ranks: 6, depthTrait: true, params });
    assert.ok(deep < shallow, 'ranks beyond the first reduce cohesion loss');
    const capped = strainOf({ taken: 10, inflicted: 10, ranks: 60, depthTrait: true, params });
    const atCap = strainOf({
      taken: 10,
      inflicted: 10,
      ranks: 1 + params.depthCap,
      depthTrait: true,
      params,
    });
    assert.equal(capped, atCap, 'extra ranks past the cap change nothing');
    const noTrait = strainOf({ taken: 10, inflicted: 10, ranks: 6, depthTrait: false, params });
    assert.equal(noTrait, shallow, 'ranks without the trait change nothing');
  });
});

describe('splitFightingFiles', () => {
  it('fights the whole frontage in a single contact', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    assert.equal(splitFightingFiles(unit, 16, 16), 16);
    assert.equal(splitFightingFiles(unit, 0, 0), 0);
  });

  it('splits files by contact length across several enemies', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    unit.files = 12;
    unit.lateralInterval = 1;
    // 12 m of front contact and 6 m of flank contact: 8 and 4 files.
    assert.equal(splitFightingFiles(unit, 12, 18), 8);
    assert.equal(splitFightingFiles(unit, 6, 18), 4);
  });
});

describe('elevationLevelAt', () => {
  it('reads the highest level under the footprint, defaulting to open ground', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    isolate(battle, unit.id);
    assert.equal(elevationLevelAt({ x: 500, y: 600, facing: 180 }, battle, unit), 0);
    battle.scenario.terrainFeatures = [hillRect('hill-a', 1, 480, 580, 520, 640)];
    assert.equal(elevationLevelAt({ x: 500, y: 600, facing: 180 }, battle, unit), 1);
    battle.scenario.terrainFeatures.push(hillRect('hill-b', 2, 490, 590, 510, 630));
    assert.equal(elevationLevelAt({ x: 500, y: 600, facing: 180 }, battle, unit), 2);
  });
});

describe('footprintAfterLosses', () => {
  it('shrinks ranks while the front edge and frontage stay', () => {
    // 256 soldiers in 16 files: 16 ranks. Losing 32 leaves 14 ranks.
    assert.deepEqual(footprintAfterLosses({ soldiers: 256, files: 16 }, 32), {
      soldiers: 224,
      files: 16,
    });
  });

  it('narrows the front symmetrically when soldiers fall below files', () => {
    assert.deepEqual(footprintAfterLosses({ soldiers: 10, files: 16 }, 4), {
      soldiers: 6,
      files: 6,
    });
  });

  it('never drops below zero soldiers', () => {
    const after = footprintAfterLosses({ soldiers: 5, files: 16 }, 40);
    assert.equal(after.soldiers, 0);
    assert.ok(after.files >= 1, 'the footprint stays valid for the geometry');
  });
});

describe('resolveCombatPhase', () => {
  function arrangedFrontal() {
    const battle = freshBattle();
    const charger = hopliteOf(battle);
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    isolate(battle, charger.id, target.id);
    place(battle, charger.id, { x: 500, y: 600 }, 180);
    place(battle, target.id, { x: 500, y: 560 }, 0);
    engage(battle, charger.id, target.id);
    return { battle, charger, target };
  }

  it('fights every engaged pair on both sides with a draw per side', () => {
    const { battle, charger, target } = arrangedFrontal();
    battle.parameters.combat = { ...combatParamsOf({}), lethality: 0.5 };
    battle.rngState = rngStateForDraws([{ lo: 0.4, hi: 0.6 }, { lo: 0.4, hi: 0.6 }]).state;
    const before = battle.units.map((unit) => unit.soldiers);
    resolveCombatPhase(battle);
    const moved = battle.units.find((unit) => unit.id === charger.id);
    const engaged = battle.units.find((unit) => unit.id === target.id);
    assert.ok(moved.soldiers < before[0] || engaged.soldiers < before[1], 'losses are inflicted');
    const draws = battle.events.filter(
      (event) => event.type === 'random-draw' && event.purpose === 'combat-loss',
    );
    assert.equal(draws.length, 2, 'one seeded draw per side');
    assert.ok(draws.every((draw) => draw.value >= 0 && draw.value < 1));
    const fought = battle.events.filter((event) => event.type === 'units-fought');
    assert.equal(fought.length, 1, 'the pair fights once');
    assert.deepEqual([...fought[0].pair].sort(), [charger.id, target.id].sort());
  });

  it('leaves unengaged battles untouched and stays pure on the input shape', () => {
    const battle = freshBattle();
    const events = battle.events.length;
    const rngState = battle.rngState;
    resolveCombatPhase(battle);
    assert.equal(battle.events.length, events, 'no fights without engagement');
    assert.equal(battle.rngState, rngState, 'no draws without engagement');
  });

  it('replays the same seed to the same losses', () => {
    const first = arrangedFrontal();
    const second = arrangedFrontal();
    first.battle.parameters.combat = { ...combatParamsOf({}), lethality: 0.5 };
    second.battle.parameters.combat = { ...combatParamsOf({}), lethality: 0.5 };
    resolveCombatPhase(first.battle);
    resolveCombatPhase(second.battle);
    assert.deepEqual(
      second.battle.units.map((unit) => unit.soldiers),
      first.battle.units.map((unit) => unit.soldiers),
    );
  });

  it('grants the fresh charge bonus only in the first fight', () => {
    const params = { ...combatParamsOf({}), lethality: 0.5 };
    const plain = arrangedFrontal();
    plain.battle.parameters.combat = params;
    plain.battle.rngState = rngStateForDraws([{ lo: 0.9, hi: 1 }, { lo: 0, hi: 0.001 }]).state;
    const charger = plain.battle.units.find((unit) => unit.id === plain.charger.id);
    charger.freshCharge = true;
    resolveCombatPhase(plain.battle);
    const chargedLosses = plain.battle.events.find((event) => event.type === 'units-fought')
      .fights.find((fight) => fight.unitId === charger.id).lossesInflicted;
    assert.equal(charger.freshCharge ?? false, false, 'the bonus is consumed');

    const control = arrangedFrontal();
    control.battle.parameters.combat = params;
    control.battle.rngState = rngStateForDraws([{ lo: 0.9, hi: 1 }, { lo: 0, hi: 0.001 }]).state;
    resolveCombatPhase(control.battle);
    const controlLosses = control.battle.events.find((event) => event.type === 'units-fought')
      .fights.find((fight) => fight.unitId === control.charger.id).lossesInflicted;
    assert.ok(chargedLosses >= controlLosses, 'the charge bonus never hurts');
    assert.ok(
      control.battle.events
        .find((event) => event.type === 'units-fought')
        .fights.every((fight) => !fight.modifiers.some((entry) => entry.key === 'charge')),
      'no charge modifier without a fresh charge',
    );
  });

  it('rewards higher elevation and penalises terrain, rivers, and disorder', () => {
    function lossesWith(setup) {
      const { battle, charger, target } = arrangedFrontal();
      battle.parameters.combat = { ...combatParamsOf({}), lethality: 0.5 };
      setup(battle, charger, target);
      battle.rngState = rngStateForDraws([{ lo: 0.9, hi: 1 }, { lo: 0, hi: 0.001 }]).state;
      resolveCombatPhase(battle);
      return battle.events.find((event) => event.type === 'units-fought');
    }
    const open = lossesWith(() => {});
    assert.equal(open.fights.length, 2, 'both sides fight the open exchange');

    const hill = lossesWith((battle) => {
      battle.scenario.terrainFeatures = [hillRect('hill-a', 1, 480, 580, 520, 640)];
    });
    assert.ok(
      hill.fights.some((fight) => fight.modifiers.some((entry) => entry.key === 'elevation')),
      'the higher combatant records the elevation modifier',
    );

    const forest = lossesWith((battle) => {
      battle.scenario.terrainFeatures = [groundRect('forest-a', 'forest', 480, 540, 520, 640)];
    });
    assert.ok(
      forest.fights.some((fight) => fight.modifiers.some((entry) => entry.key === 'terrain')),
      'terrain records its modifier',
    );

    const river = lossesWith((battle) => {
      battle.scenario.terrainFeatures = [{
        id: 'river-a',
        kind: 'linear',
        category: 'river',
        path: [{ x: 440, y: 608 }, { x: 560, y: 608 }],
        width: 6,
      }];
    });
    assert.ok(
      river.fights.some((fight) => fight.modifiers.some((entry) => entry.key === 'river')),
      'standing in a river records its modifier',
    );

    const disordered = lossesWith((battle, charger) => {
      battle.units.find((entry) => entry.id === charger.id).cohesion = 'Disordered';
    });
    assert.ok(
      disordered.fights.some((fight) => fight.modifiers.some((entry) => entry.key === 'disordered')),
      'the Disordered penalty records its modifier',
    );
  });

  it('gives the flanker the aspect bonus and the flanked extra cohesion loss', () => {
    const battle = freshBattle();
    const charger = hopliteOf(battle);
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    isolate(battle, charger.id, target.id);
    place(battle, charger.id, { x: 440, y: 552 }, 90);
    place(battle, target.id, { x: 500, y: 540 }, 0);
    const first = battle.units.find((unit) => unit.id === charger.id);
    const second = battle.units.find((unit) => unit.id === target.id);
    first.engaged = { unitId: second.id, edge: 'front', aspect: 'flank', frontageM: 8, files: 8 };
    second.engaged = { unitId: first.id, edge: 'left', aspect: 'flank', frontageM: 8, files: 8 };
    battle.parameters.combat = {
      ...combatParamsOf({}),
      lethality: 0.5,
      cohesionPerCasualty: 1,
      disorderedAt: 100,
      routedAt: 200,
    };
    battle.rngState = rngStateForDraws([{ lo: 0.9, hi: 1 }, { lo: 0, hi: 0.001 }]).state;
    resolveCombatPhase(battle);
    const fought = battle.events.find((event) => event.type === 'units-fought');
    const flanker = fought.fights.find((fight) => fight.unitId === first.id);
    const flanked = fought.fights.find((fight) => fight.unitId === second.id);
    assert.ok(flanker.modifiers.some((entry) => entry.key === 'flank'), 'flanker strength bonus');
    assert.ok(
      !flanked.modifiers.some((entry) => entry.key === 'flank'),
      'no flank bonus for the flanked side',
    );
    assert.ok(flanked.strain > 0 && flanker.strain >= 0);
  });

  it('splits files across several enemies and adds the cohesion losses up', () => {
    const battle = freshBattle();
    const holder = hopliteOf(battle);
    const enemyA = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    const enemyB = foreignUnits(battle).find((unit) => unit.id !== enemyA.id);
    isolate(battle, holder.id, enemyA.id, enemyB.id);
    holder.files = 12;
    holder.lateralInterval = 1;
    place(battle, holder.id, { x: 500, y: 600 }, 180);
    place(battle, enemyA.id, { x: 494, y: 560 }, 0);
    place(battle, enemyB.id, { x: 506, y: 560 }, 0);
    const self = battle.units.find((unit) => unit.id === holder.id);
    const foeA = battle.units.find((unit) => unit.id === enemyA.id);
    const foeB = battle.units.find((unit) => unit.id === enemyB.id);
    self.engaged = { unitId: foeA.id, edge: 'front', aspect: 'front', frontageM: 12, files: 12 };
    foeA.engaged = { unitId: self.id, edge: 'front', aspect: 'front', frontageM: 6, files: 6 };
    foeB.engaged = { unitId: self.id, edge: 'front', aspect: 'front', frontageM: 6, files: 6 };
    battle.parameters.combat = { ...combatParamsOf({}), lethality: 0.5 };
    battle.rngState = rngStateForDraws([
      { lo: 0.4, hi: 0.6 },
      { lo: 0.4, hi: 0.6 },
      { lo: 0.4, hi: 0.6 },
      { lo: 0.4, hi: 0.6 },
    ]).state;
    resolveCombatPhase(battle);
    const fought = battle.events.filter((event) => event.type === 'units-fought');
    assert.equal(fought.length, 2, 'one fight per engaged pair');
    const ownFights = fought.flatMap((event) => event.fights).filter((fight) => fight.unitId === self.id);
    assert.equal(ownFights.length, 2, 'the shared unit fights each enemy separately');
    const filesSum = ownFights.reduce((sum, fight) => sum + fight.files, 0);
    assert.ok(filesSum <= self.files + 1, `files split by contact length (fought ${filesSum})`);
  });

  it('steps numeric cohesion down through the thresholds, never up', () => {
    const { battle, charger, target } = arrangedFrontal();
    battle.parameters.combat = {
      ...combatParamsOf({}),
      lethality: 1,
      cohesionPerCasualty: 0.2,
      loserFactor: 1,
      flankStrain: 0,
      rearStrain: 0,
      depthReduction: 0,
    };
    // The charger draws high and inflicts heavy losses; the target draws
    // nothing, takes the full blow (~48 strength x ~0.95 draw x 0.2 strain),
    // and falls from 12 into the Disordered band below 4.
    battle.rngState = rngStateForDraws([{ lo: 0.9, hi: 1 }, { lo: 0, hi: 0.001 }]).state;
    resolveCombatPhase(battle);
    const moved = battle.units.find((unit) => unit.id === charger.id);
    const engaged = battle.units.find((unit) => unit.id === target.id);
    const fought = battle.events.find((event) => event.type === 'units-fought');
    assert.ok(fought.fights.find((fight) => fight.unitId === engaged.id).lossesTaken >= 5);
    assert.equal(engaged.cohesion, 'Disordered', 'heavy losses disorder');
    assert.ok(engaged.cohesionValue < 4 && engaged.cohesionValue > 0, 'numeric value lands in the Disordered band');
    assert.equal(moved.cohesion, 'Steady', 'light losses keep the winner steady');
    assert.ok((engaged.cohesionStrain ?? 0) > (moved.cohesionStrain ?? 0));
  });

  it('lets hoplite depth endure where others waver', () => {
    const params = {
      ...combatParamsOf({}),
      lethality: 0,
      cohesionPerCasualty: 0.5,
      loserFactor: 1,
      flankStrain: 0,
      rearStrain: 0,
      disorderedAt: 4,
      routedAt: 100,
    };
    function strainFor(troopType, soldiers, files) {
      const battle = freshBattle();
      const unit = battle.units.find((entry) => entry.troopType === troopType)
        ?? hopliteOf(battle);
      const foe = foreignUnits(battle).find((entry) => entry.id !== unit.id);
      isolate(battle, unit.id, foe.id);
      unit.troopType = troopType;
      unit.soldiers = soldiers;
      unit.files = files;
      foe.soldiers = 10;
      foe.files = 10;
      engage(battle, unit.id, foe.id, 10, 10);
      battle.parameters.combat = params;
      // No losses inflicted either way (lethality 0): strain comes only from
      // the direct call below, so compare the helper on equal casualties.
      void battle;
      return strainOf({ taken: 10, inflicted: 10, ranks: Math.ceil(soldiers / files), depthTrait: troopType === 'hoplite', params });
    }
    const hoplite = strainFor('hoplite', 160, 16);
    const archer = strainFor('archer', 160, 16);
    assert.ok(hoplite < archer, 'depth endures for the trait holder only');
  });

  it('shrinks the footprint from the rear, keeping the front edge put', () => {
    const { battle, charger, target } = arrangedFrontal();
    battle.parameters.combat = { ...combatParamsOf({}), lethality: 1 };
    battle.rngState = rngStateForDraws([{ lo: 0.9, hi: 1 }, { lo: 0.9, hi: 1 }]).state;
    const before = battle.units.find((unit) => unit.id === target.id);
    const soldiersBefore = before.soldiers;
    const filesBefore = before.files;
    const positionBefore = { ...before.position };
    resolveCombatPhase(battle);
    const after = battle.units.find((unit) => unit.id === target.id);
    assert.ok(after.soldiers < soldiersBefore, 'losses come off the strength');
    assert.deepEqual(after.position, positionBefore, 'no recoil: the front midpoint stays');
    assert.equal(after.facing, before.facing, 'no turning either');
    if (after.soldiers >= after.files) {
      assert.equal(after.files, filesBefore, 'frontage stays while ranks shrink');
    } else {
      assert.equal(after.files, after.soldiers, 'files follow soldiers down');
    }
  });

  it('narrows a small unit symmetrically about the front midpoint', () => {
    const { battle, charger, target } = arrangedFrontal();
    const victim = battle.units.find((unit) => unit.id === target.id);
    victim.soldiers = 10;
    victim.files = 10;
    victim.lateralInterval = 1;
    victim.rankDepth = 1;
    const foe = battle.units.find((unit) => unit.id === charger.id);
    foe.soldiers = 200;
    foe.files = 10;
    victim.engaged = { unitId: foe.id, edge: 'front', aspect: 'front', frontageM: 10, files: 10 };
    foe.engaged = { unitId: victim.id, edge: 'front', aspect: 'front', frontageM: 10, files: 10 };
    battle.parameters.combat = { ...combatParamsOf({}), lethality: 0.3 };
    battle.rngState = rngStateForDraws([{ lo: 0.9, hi: 1 }, { lo: 0.9, hi: 1 }]).state;
    resolveCombatPhase(battle);
    assert.ok(victim.soldiers < 10 && victim.soldiers >= 1, 'the victim loses soldiers');
    assert.equal(victim.files, victim.soldiers, 'files become equal to soldiers');
  });

  it('runs inside turn resolution, after movement and before the handoff', () => {
    const battle = freshBattle();
    const charger = hopliteOf(battle);
    const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
    isolate(battle, charger.id, target.id);
    place(battle, charger.id, { x: 500, y: 600 }, 180);
    place(battle, target.id, { x: 500, y: 540 }, 0);
    const submission = {
      formatVersion: SUBMISSION_FORMAT_VERSION,
      battleId: battle.id,
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      orders: [{ unitId: charger.id, kind: 'Charge', targetId: target.id, edge: 'front', approach: [] }],
    };
    const next = resolveTurn(battle, { type: 'commit', submission });
    const fought = next.events.filter((event) => event.type === 'units-fought');
    assert.equal(fought.length, 1, 'the fresh charge fights in the same Combat phase');
    const fight = fought[0].fights.find((entry) => entry.unitId === charger.id);
    assert.ok(fight.modifiers.some((entry) => entry.key === 'charge'), 'first-fight bonus');
    const phases = next.events.filter((event) => event.type === 'turn-phase').map((event) => event.phase);
    assert.deepEqual(phases, ['Movement', 'Shooting', 'Combat', 'Cohesion']);
    assert.equal(next.turnNumber, battle.turnNumber + 1);
  });
});
