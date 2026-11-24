// PÓLIS engine — player view (framework-free).
//
// Moved verbatim from `../turn.js` (#140): what a player may know when
// deciding. Pure: the battle is never changed.

import { deriveFootprint } from '../geometry.js';
import { TROOP_TYPE_CATALOGUE } from '../polis-classical.js';
import {
  cohesionParamsOf,
  isActiveUnit,
  unitCohesionState,
  unitCohesionValue,
} from '../cohesion.js';
import { PLAYER_VIEW_FORMAT_VERSION } from './constants.js';
import { assertBattle, cloneValue } from './shared.js';

// --- Player view ------------------------------------------------------------
// Everything a player may know when deciding: the whole current situation,
// the ruleset and its parameter values, and what has happened so far. It is
// the same for both sides. It never contains the seed or the generator
// state — only the battle's chance outcomes are withheld, and Hold needs
// none.

function frontEdge(unit) {
  const derived = deriveFootprint(unit);
  return {
    midpoint: { ...unit.position },
    left: { ...derived.corners[0] },
    right: { ...derived.corners[1] },
  };
}

function formationOf(unit) {
  const ranks = Math.ceil(unit.soldiers / unit.files);
  return {
    files: unit.files,
    ranks,
    lateralInterval: unit.lateralInterval,
    rankDepth: unit.rankDepth,
    frontageM: unit.files * unit.lateralInterval,
    depthM: ranks * unit.rankDepth,
  };
}

function statusOf(unit, params = null) {
  if (unit?.status === 'destroyed') {
    return 'destroyed';
  }
  if (unit?.status === 'fled') {
    return 'fled';
  }
  if (!isActiveUnit(unit)) {
    return 'inactive';
  }
  return unitCohesionState(unit, params) === 'Routed' ? 'routed' : 'active';
}

// The engaged contact of a unit for the player view: what it is engaged with
// and on which edge, with the aspect, the engaged frontage, and its own
// fighting files. Unengaged units carry nulls (the Charge slice sets the
// contact on resolution).
function engagedOf(unit) {
  const contact = unit?.engaged;
  if (!contact || typeof contact !== 'object' || typeof contact.unitId !== 'string') {
    return { unitId: null, edge: null };
  }
  return {
    unitId: contact.unitId,
    edge: contact.edge ?? null,
    aspect: contact.aspect ?? null,
    frontageM: contact.frontageM ?? null,
    files: contact.files ?? null,
  };
}

// Build the player view for the battle's current turn. Pure: the battle is
// never changed, and the view shares no references with it.
export function buildPlayerView(battle) {
  assertBattle(battle);
  const cohesion = cohesionParamsOf(battle.parameters);
  return {
    formatVersion: PLAYER_VIEW_FORMAT_VERSION,
    battleId: battle.id,
    battlefield: { ...battle.scenario.battlefield },
    terrain: cloneValue(battle.scenario.terrainFeatures || []),
    sides: battle.scenario.sides.map((side) => ({ id: side.id, name: side.name })),
    units: battle.units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      side: unit.side,
      troopType: unit.troopType,
      position: { ...unit.position },
      facing: unit.facing,
      front: frontEdge(unit),
      soldiers: unit.soldiers,
      files: unit.files,
      formation: formationOf(unit),
      cohesion: { value: unitCohesionValue(unit, cohesion), state: unitCohesionState(unit, cohesion) },
      engaged: engagedOf(unit),
      status: statusOf(unit, cohesion),
      startingSoldiers: Number.isFinite(unit.startingSoldiers) ? unit.startingSoldiers : unit.soldiers,
    })),
    round: battle.round,
    turnNumber: battle.turnNumber,
    activeSide: battle.activeSide,
    phase: battle.phase,
    status: battle.status,
    winner: battle.winner ?? null,
    result: cloneValue(battle.result ?? null),
    ruleset: { ...battle.ruleset },
    parameters: cloneValue(battle.parameters),
    catalogue: cloneValue(TROOP_TYPE_CATALOGUE),
    events: cloneValue(battle.events),
  };
}
