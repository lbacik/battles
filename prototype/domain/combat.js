// PÓLIS engine — Combat between engaged units (framework-free).
//
// The fighting slice of the framework-free engine package: every engaged pair
// fights once per Combat phase, on both sides, with seeded losses and cohesion
// loss, and losses visibly shrink the footprints from the rear. This module
// imports only the domain model, the ruleset package, the plane geometry, and
// the movement terrain helpers — no React, no Next.js, no DOM, no Node APIs —
// so it runs unchanged in the browser, in Node unit tests, and in any future
// shell.
//
// Mechanics (decisions #6 items 14-15, 17-18, 23):
//
// - Every engaged pair fights once per Combat phase, on both sides. Pairs are
//   collected from the directed engagement records, so a unit engaged with
//   several enemies (a target charged twice keeps its first contact while the
//   second charger records its own) fights each enemy separately.
// - A unit engaged with several enemies splits its files by contact length: its
//   share of each fight is the smaller of the files that fit on that contact
//   (engaged frontage ÷ own lateral interval) and its proportional share of
//   its files (files × contact frontage ÷ total engaged frontage). Each share
//   is rounded down; the leftover from rounding fights nowhere.
// - Each side's strength is its fighting files × the troop type's combat
//   factor, with one multiplier per modifier: the charge bonus while the
//   charger's fresh-charge flag holds (set on charge resolution, consumed by
//   the first Combat phase after the charge), the flank or rear aspect for the
//   flanking side, the higher elevation (the highest level touching each
//   combatant's footprint), the terrain under the combatant (the worst ground
//   cover its footprint touches, as for movement), the Disordered penalty, and
//   the river penalty while the footprint touches a river. The strength and
//   every applied modifier are recorded on the fight.
// - Losses are strength × a seeded random factor × the lethality parameter,
//   rounded to whole soldiers and capped at the soldiers still standing. Each
//   side draws once per fight; every draw is recorded as a `random-draw` event
//   with purpose `combat-loss`, and each pair records one `units-fought`
//   event. Units whose state changes record one `unit-cohesion` event each.
// - Cohesion loss is proportional to losses taken: casualties × the
//   per-casualty strain, times the loser factor for the side that inflicted
//   fewer losses (ties pay none), plus a flat extra for flanked or rear
//   contact. Depth (ranks beyond the first, up to a cap, for troop types with
//   the depth trait) multiplies the strain down and never increases losses
//   inflicted. A unit in several fights adds its strains up; the total is kept
//   on `unit.cohesionStrain` and steps the state down (never up) at the
//   Disordered and Routed thresholds.
// - Losses come off the rear: soldiers drop while files stay, so ranks shrink
//   while the front edge (the position front midpoint) and the frontage stay.
//   When soldiers fall below files, files become equal to soldiers and the
//   front narrows symmetrically about the front midpoint (the footprint is
//   anchored there). No other reshaping, recoil, or pursuit: positions and
//   facings never change. A wiped-out unit keeps one file so its footprint
//   stays valid geometry; destruction and removal belong to the Cohesion
//   slice.
//
// All fights in one phase resolve simultaneously: every strength is computed
// from the pre-phase footprints, and cohesion states step only after every
// pair has fought.

import { EPS, isFinitePoint, ringsTouch } from './geometry.js';
import { createRng } from './battle.js';
import { getTroopType } from './polis-classical.js';
import {
  footprintAt,
  groundCoverAt,
  riversTouching,
} from './movement.js';

// The combat parameters when the battle snapshot carries no `combat` block.
// Initial values for this slice; the ruleset file owns the tuned ones.
export const DEFAULT_COMBAT = Object.freeze({
  lethality: 0.06,
  chargeBonus: 1.5,
  flankFactor: 1.5,
  rearFactor: 2.0,
  elevationFactor: 1.2,
  disorderedFactor: 0.7,
  riverFactor: 0.7,
  terrainFactor: Object.freeze({ open: 1, rough: 0.9, forest: 0.75, settlement: 0.9 }),
  cohesionPerCasualty: 0.08,
  loserFactor: 1.5,
  flankStrain: 1.0,
  rearStrain: 2.0,
  depthCap: 4,
  depthReduction: 0.1,
  disorderedAt: 2.0,
  routedAt: 4.0,
});

// Read the combat parameters from the battle snapshot, in either the outer
// shape (`parameters.combat`) or the inner shape (the combat block itself, as
// the withdraw helper allows). Missing values fall back to the defaults;
// the terrain table merges per cover. Never throws.
export function combatParamsOf(parameters) {
  const inner = parameters && typeof parameters === 'object' && parameters.combat
    && typeof parameters.combat === 'object'
    ? parameters.combat
    : parameters && typeof parameters === 'object' ? parameters : {};
  const pick = (key) => (Number.isFinite(inner[key]) ? inner[key] : DEFAULT_COMBAT[key]);
  const terrain = inner.terrainFactor && typeof inner.terrainFactor === 'object'
    ? inner.terrainFactor
    : {};
  const terrainFactor = { ...DEFAULT_COMBAT.terrainFactor };
  for (const cover of Object.keys(terrainFactor)) {
    if (Number.isFinite(terrain[cover])) {
      terrainFactor[cover] = terrain[cover];
    }
  }
  return {
    lethality: pick('lethality'),
    chargeBonus: pick('chargeBonus'),
    flankFactor: pick('flankFactor'),
    rearFactor: pick('rearFactor'),
    elevationFactor: pick('elevationFactor'),
    disorderedFactor: pick('disorderedFactor'),
    riverFactor: pick('riverFactor'),
    terrainFactor,
    cohesionPerCasualty: pick('cohesionPerCasualty'),
    loserFactor: pick('loserFactor'),
    flankStrain: pick('flankStrain'),
    rearStrain: pick('rearStrain'),
    depthCap: pick('depthCap'),
    depthReduction: pick('depthReduction'),
    disorderedAt: pick('disorderedAt'),
    routedAt: pick('routedAt'),
  };
}

// The highest elevation level touching a footprint ring, or 0 on open ground.
// Elevation features that merely touch count, as for ground cover: what the
// footprint touches is what applies.
function levelUnderCorners(corners, terrainFeatures) {
  let highest = 0;
  for (const feature of Array.isArray(terrainFeatures) ? terrainFeatures : []) {
    if (!feature || feature.kind !== 'elevation' || !Number.isFinite(feature.level)) {
      continue;
    }
    if (!Array.isArray(feature.polygon) || feature.polygon.length < 3) {
      continue;
    }
    if (ringsTouch(corners, feature.polygon) && feature.level > highest) {
      highest = feature.level;
    }
  }
  return highest;
}

// The highest elevation level under the unit at `pose` (`{ position, facing }`
// or, for tests, a bare `{ x, y, facing }` point). Pure.
export function elevationLevelAt(pose, battle, unit) {
  const position = pose && isFinitePoint(pose.position) ? pose.position : pose;
  const facing = Number.isFinite(pose?.facing) ? pose.facing : unit?.facing;
  const features = battle?.scenario?.terrainFeatures || [];
  let corners;
  try {
    corners = footprintAt(
      {
        soldiers: unit?.soldiers,
        files: unit?.files,
        lateralInterval: unit?.lateralInterval,
        rankDepth: unit?.rankDepth,
      },
      { ...position },
      facing,
    ).corners;
  } catch {
    return 0;
  }
  return levelUnderCorners(corners, features);
}

// Every engaged pair, once: the unordered unit ids, the shared frontage, the
// shared aspect, and each side's own edge (`null` when that side records no
// contact with the other, as for a second charger). Contacts pointing at
// unknown units are skipped. Sorted by unit id so draws run deterministically.
export function collectEngagedPairs(units) {
  const list = Array.isArray(units) ? units : [];
  const byId = new Map(list.map((unit) => [unit?.id, unit]));
  const seen = new Set();
  const pairs = [];
  for (const unit of list) {
    const contact = unit?.engaged;
    if (!contact || typeof contact !== 'object' || typeof contact.unitId !== 'string') {
      continue;
    }
    if (!byId.has(contact.unitId)) {
      continue;
    }
    const [aId, bId] = [unit.id, contact.unitId].sort();
    const key = `${aId} ${bId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const recordOf = (id) => {
      const other = id === aId ? bId : aId;
      const entry = byId.get(id)?.engaged;
      return entry && typeof entry === 'object' && entry.unitId === other ? entry : null;
    };
    const recordA = recordOf(aId);
    const recordB = recordOf(bId);
    const frontage = Number.isFinite(recordA?.frontageM)
      ? recordA.frontageM
      : Number.isFinite(recordB?.frontageM) ? recordB.frontageM : 0;
    const aspect = typeof (recordA?.aspect ?? recordB?.aspect) === 'string'
      ? recordA?.aspect ?? recordB?.aspect
      : 'front';
    pairs.push({
      aId,
      bId,
      frontageM: frontage,
      aspect,
      edgeA: recordA?.edge ?? null,
      edgeB: recordB?.edge ?? null,
    });
  }
  pairs.sort((left, right) => {
    if (left.aId !== right.aId) {
      return left.aId < right.aId ? -1 : 1;
    }
    if (left.bId !== right.bId) {
      return left.bId < right.bId ? -1 : 1;
    }
    return 0;
  });
  return pairs;
}

// Fighting files for one contact of a unit whose total engaged frontage is
// `totalFrontageM`: the smaller of the files that fit on the contact
// (frontage ÷ own lateral interval) and the proportional share of the unit's
// files (files × contact frontage ÷ total frontage), rounded down. A single
// contact fights the whole frontage; a point contact fights no files.
export function splitFightingFiles(unit, frontageM, totalFrontageM) {
  const files = Number.isFinite(unit?.files) && unit.files > 0 ? unit.files : 0;
  const interval = unit?.lateralInterval;
  if (!(files > 0) || !Number.isFinite(interval) || !(interval > 0)) {
    return 0;
  }
  if (!Number.isFinite(frontageM) || !(frontageM > 0)) {
    return 0;
  }
  if (!Number.isFinite(totalFrontageM) || !(totalFrontageM > EPS)) {
    return 0;
  }
  const physical = Math.floor(frontageM / interval + EPS);
  const share = Math.floor((files * frontageM) / totalFrontageM + EPS);
  return Math.max(0, Math.min(files, physical, share));
}

// One side's strength for one fight: fighting files × the combat factor, with
// one multiplier per modifier. `flankerAspect` is the pair aspect when this
// side flanks (`null` otherwise); `terrainFactor` is the cover factor under
// this side. Returns the strength and the applied `{ key, factor }` modifiers
// for the fight record. Pure.
export function strengthOf({
  files,
  combatFactor,
  chargeFresh = false,
  flankerAspect = null,
  elevationHigher = false,
  terrainFactor = 1,
  rivered = false,
  disordered = false,
  params = null,
}) {
  const resolved = params ?? combatParamsOf({});
  let strength = Math.max(0, Number.isFinite(files) ? files : 0)
    * Math.max(0, Number.isFinite(combatFactor) ? combatFactor : 1);
  const modifiers = [];
  const apply = (key, factor) => {
    if (!Number.isFinite(factor) || factor === 1 || !(factor > 0)) {
      return;
    }
    strength *= factor;
    modifiers.push({ key, factor });
  };
  if (chargeFresh) {
    apply('charge', resolved.chargeBonus);
  }
  if (flankerAspect === 'flank') {
    apply('flank', resolved.flankFactor);
  } else if (flankerAspect === 'rear') {
    apply('rear', resolved.rearFactor);
  }
  if (elevationHigher) {
    apply('elevation', resolved.elevationFactor);
  }
  if (Number.isFinite(terrainFactor) && terrainFactor !== 1 && terrainFactor > 0) {
    apply('terrain', terrainFactor);
  }
  if (rivered) {
    apply('river', resolved.riverFactor);
  }
  if (disordered) {
    apply('disordered', resolved.disorderedFactor);
  }
  return { strength, modifiers };
}

// Whole soldiers lost for one fight: strength × draw × lethality, rounded.
// Pure.
export function lossesOf({ strength, draw, lethality }) {
  if (!Number.isFinite(strength) || !(strength > 0)) {
    return 0;
  }
  if (!Number.isFinite(draw) || !(draw > 0)) {
    return 0;
  }
  if (!Number.isFinite(lethality) || !(lethality > 0)) {
    return 0;
  }
  return Math.max(0, Math.round(strength * draw * lethality));
}

// Cohesion strain for one fight: casualties taken × the per-casualty strain,
// times the loser factor for the side that inflicted fewer losses, plus the
// flanked or rear extra; depth then multiplies the strain down for trait
// holders with ranks beyond the first, up to the cap. Pure.
export function strainOf({
  taken,
  inflicted,
  ranks = 1,
  depthTrait = false,
  flankedAspect = null,
  params = null,
}) {
  const resolved = params ?? combatParamsOf({});
  let strain = Math.max(0, Number.isFinite(taken) ? taken : 0) * resolved.cohesionPerCasualty;
  if (Number.isFinite(inflicted) && inflicted < taken) {
    strain *= resolved.loserFactor;
  }
  if (flankedAspect === 'flank') {
    strain += resolved.flankStrain;
  } else if (flankedAspect === 'rear') {
    strain += resolved.rearStrain;
  }
  if (depthTrait && Number.isFinite(ranks) && ranks > 1) {
    const counted = Math.min(ranks - 1, resolved.depthCap);
    strain *= Math.max(0, 1 - resolved.depthReduction * counted);
  }
  return strain;
}

// Soldiers and files after taking `losses`: soldiers drop while files stay,
// so ranks shrink; when soldiers fall below files, files become equal to
// soldiers. A wiped-out unit keeps one file so the footprint stays valid
// geometry. Pure.
export function footprintAfterLosses({ soldiers, files }, losses) {
  const before = Number.isFinite(soldiers) && soldiers > 0 ? Math.floor(soldiers) : 0;
  const after = Math.max(0, before - Math.max(0, Math.round(losses)));
  const filesBefore = Number.isFinite(files) && files > 0 ? Math.floor(files) : 1;
  return {
    soldiers: after,
    files: after < filesBefore ? Math.max(1, after) : filesBefore,
  };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// Resolve the Combat phase against the mutable battle: every engaged pair
// fights once, on both sides, drawing from the engine generator. Mutates the
// units (soldiers, files, cohesion, strain, fresh-charge flags), the generator
// state, and the events. No fights means no draws and no events, apart from
// clearing spent fresh-charge flags.
export function resolveCombatPhase(battle) {
  if (!battle || typeof battle !== 'object' || Array.isArray(battle)) {
    throw new Error('Combat needs a battle state object.');
  }
  if (!Array.isArray(battle.units) || !Array.isArray(battle.events)) {
    throw new Error('Combat needs a battle with units and events.');
  }
  const params = combatParamsOf(battle.parameters);
  const features = battle.scenario?.terrainFeatures || [];
  const pairs = collectEngagedPairs(battle.units);
  if (pairs.length === 0) {
    for (const unit of battle.units) {
      if (unit && typeof unit === 'object' && unit.freshCharge) {
        delete unit.freshCharge;
      }
    }
    return;
  }
  const byId = new Map(battle.units.map((unit) => [unit?.id, unit]));
  // Pre-phase snapshots: every strength is computed from the footprints the
  // phase started with, so fights resolve simultaneously.
  const snapshot = new Map();
  const cornersOf = new Map();
  const levelOf = new Map();
  const coverOf = new Map();
  const riverOf = new Map();
  for (const unit of battle.units) {
    if (!unit || typeof unit !== 'object') {
      continue;
    }
    const files = Number.isFinite(unit.files) && unit.files > 0 ? Math.floor(unit.files) : 0;
    const soldiers = Number.isFinite(unit.soldiers) && unit.soldiers > 0
      ? Math.floor(unit.soldiers)
      : 0;
    snapshot.set(unit.id, {
      files,
      soldiers,
      ranks: Math.max(1, Math.ceil(soldiers / Math.max(1, files))),
      strain: Number.isFinite(unit.cohesionStrain) && unit.cohesionStrain > 0
        ? unit.cohesionStrain
        : 0,
    });
    let corners = null;
    try {
      corners = footprintAt(unit, { ...unit.position }, unit.facing).corners;
    } catch {
      corners = null;
    }
    cornersOf.set(unit.id, corners);
    levelOf.set(unit.id, corners ? levelUnderCorners(corners, features) : 0);
    coverOf.set(unit.id, corners ? groundCoverAt(corners, features) : 'open');
    riverOf.set(unit.id, corners ? riversTouching(corners, features).length > 0 : false);
  }
  const contactsOf = new Map(battle.units.map((unit) => [unit?.id, []]));
  for (const pair of pairs) {
    contactsOf.get(pair.aId)?.push(pair);
    contactsOf.get(pair.bId)?.push(pair);
  }
  const totalFrontageOf = (id) => (contactsOf.get(id) || []).reduce(
    (sum, pair) => sum + (Number.isFinite(pair.frontageM) ? pair.frontageM : 0),
    0,
  );

  const rng = createRng(battle.rngState);
  const pushEvent = (fields) => {
    battle.events.push({ seq: battle.events.length, ...fields });
  };
  const strainAdded = new Map();

  for (const pair of pairs) {
    const sides = [pair.aId, pair.bId];
    const results = new Map();
    for (const side of sides) {
      const opponent = side === pair.aId ? pair.bId : pair.aId;
      const unit = byId.get(side);
      const snap = snapshot.get(side);
      const edge = side === pair.aId ? pair.edgeA : pair.edgeB;
      const flanker = (pair.aspect === 'flank' || pair.aspect === 'rear') && edge === 'front';
      const troop = getTroopType(unit?.troopType);
      const combatFactor = Number.isFinite(troop?.combatFactor) ? troop.combatFactor : 1;
      const cover = coverOf.get(side) ?? 'open';
      const coverFactor = Number.isFinite(params.terrainFactor[cover])
        ? params.terrainFactor[cover]
        : 1;
      const files = splitFightingFiles(
        { files: snap.files, lateralInterval: unit?.lateralInterval },
        pair.frontageM,
        totalFrontageOf(side),
      );
      const { strength, modifiers } = strengthOf({
        files,
        combatFactor,
        chargeFresh: unit?.freshCharge === true,
        flankerAspect: flanker ? pair.aspect : null,
        elevationHigher: (levelOf.get(side) ?? 0) > (levelOf.get(opponent) ?? 0),
        terrainFactor: coverFactor,
        rivered: riverOf.get(side) === true,
        disordered: unit?.cohesion === 'Disordered' || unit?.cohesion === 'Routed',
        params,
      });
      const value = rng.next();
      battle.rngState = rng.state;
      const inflicted = lossesOf({ strength, draw: value, lethality: params.lethality });
      results.set(side, { opponent, files, strength: round3(strength), modifiers, value, inflicted });
    }
    // Cap each side's taken losses at the soldiers still standing and apply
    // them from the rear. Strengths above already used the pre-phase state.
    const fights = [];
    for (const side of sides) {
      const opponent = side === pair.aId ? pair.bId : pair.aId;
      const suffered = byId.get(opponent);
      const dealt = Math.min(
        Math.max(0, suffered?.soldiers ?? 0),
        results.get(side).inflicted,
      );
      const before = { soldiers: suffered.soldiers, files: suffered.files };
      const after = footprintAfterLosses(before, dealt);
      suffered.soldiers = after.soldiers;
      suffered.files = after.files;
      results.get(side).dealt = dealt;
      results.get(opponent).taken = dealt;
    }
    for (const side of sides) {
      const opponent = side === pair.aId ? pair.bId : pair.aId;
      const unit = byId.get(side);
      const result = results.get(side);
      const edge = side === pair.aId ? pair.edgeA : pair.edgeB;
      const flanker = (pair.aspect === 'flank' || pair.aspect === 'rear') && edge === 'front';
      const strain = strainOf({
        taken: result.taken ?? 0,
        inflicted: result.dealt ?? 0,
        ranks: snapshot.get(side).ranks,
        depthTrait: getTroopType(unit?.troopType)?.depthEndures === true,
        flankedAspect: !flanker && (pair.aspect === 'flank' || pair.aspect === 'rear')
          ? pair.aspect
          : null,
        params,
      });
      strainAdded.set(side, (strainAdded.get(side) ?? 0) + strain);
      pushEvent({
        type: 'random-draw',
        purpose: 'combat-loss',
        turnNumber: battle.turnNumber,
        side: unit?.side ?? null,
        unitId: side,
        opponentId: opponent,
        value: result.value,
        result: result.dealt ?? 0,
      });
      fights.push({
        unitId: side,
        opponentId: opponent,
        files: result.files,
        strength: result.strength,
        modifiers: result.modifiers,
        lossesInflicted: result.dealt ?? 0,
        lossesTaken: result.taken ?? 0,
        strain: round3(strain),
      });
    }
    const soldiers = {};
    for (const side of sides) {
      const live = byId.get(side);
      soldiers[side] = { before: snapshot.get(side).soldiers, after: live.soldiers };
    }
    pushEvent({
      type: 'units-fought',
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      pair: [pair.aId, pair.bId],
      aspect: pair.aspect,
      frontageM: pair.frontageM,
      fights,
      soldiers,
    });
  }

  // Cohesion steps down (never up) once per phase, after every pair has
  // fought, so simultaneous fights share one threshold check.
  for (const [id, added] of strainAdded) {
    const unit = byId.get(id);
    if (!unit || !(added > 0)) {
      continue;
    }
    const before = unit.cohesion;
    const total = round3((snapshot.get(id)?.strain ?? 0) + added);
    unit.cohesionStrain = total;
    if (total >= params.routedAt) {
      unit.cohesion = 'Routed';
    } else if (total >= params.disorderedAt && unit.cohesion === 'Steady') {
      unit.cohesion = 'Disordered';
    }
    if (unit.cohesion !== before) {
      pushEvent({
        type: 'unit-cohesion',
        turnNumber: battle.turnNumber,
        side: unit.side ?? null,
        unitId: id,
        cohesionBefore: before,
        cohesionAfter: unit.cohesion,
        strain: total,
      });
    }
  }

  for (const unit of battle.units) {
    if (unit && typeof unit === 'object' && unit.freshCharge) {
      delete unit.freshCharge;
    }
  }
}
