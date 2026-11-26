// PÓLIS engine — turn shared helpers (framework-free).
//
// Moved verbatim from `../turn.js` (#140): the JSON clone, the battle
// guard, the record guard, the numeric-cohesion helpers, and `otherSide`.
// Only `otherSide` is part of the public turn contract; the rest are
// shared inside `domain/turn/`.

import {
  cohesionParamsOf,
  unitCohesionState,
  unitCohesionValue,
} from '../cohesion.js';

// Numeric cohesion behind the three states. The battle stores both the numeric
// `cohesionValue` (0 to the troop-type maximum) and the derived state string;
// the player view carries both. A withdraw that fails its cohesion test steps
// the value down to the next state: Steady falls to just below the Disordered
// threshold, Disordered falls to 0 (Routed).
function cohesionValueOf(unit, params = null) {
  return unitCohesionValue(unit, params ?? cohesionParamsOf({}));
}

function cohesionStateOf(unit, params = null) {
  return unitCohesionState(unit, params ?? cohesionParamsOf({}));
}

export function stepDownCohesionValue(unit, params = null) {
  const resolved = params ?? cohesionParamsOf({});
  const state = unitCohesionState(unit, resolved);
  if (state === 'Steady') {
    const threshold = Number.isFinite(resolved?.disorderedBelow) ? resolved.disorderedBelow : 4;
    return Math.max(0, threshold - 1);
  }
  if (state === 'Disordered') {
    return 0;
  }
  return unitCohesionValue(unit, resolved);
}

// Deep clone a JSON-shaped value. Battle state, views, and submissions are
// plain data, so a JSON round trip is a faithful copy.
export function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function assertBattle(battle) {
  if (!battle || typeof battle !== 'object' || Array.isArray(battle)) {
    throw new Error('A turn needs a battle state object.');
  }
  if (!Array.isArray(battle.scenario?.sides) || battle.scenario.sides.length !== 2) {
    throw new Error('A turn needs a battle with exactly two sides.');
  }
  if (!Array.isArray(battle.units) || !Array.isArray(battle.events)) {
    throw new Error('A turn needs a battle with units and events.');
  }
}

// The id of the side opposing `side` in this battle. Throws for a side that

export function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}


// The id of the side opposing `side` in this battle. Throws for a side that
// is not playing.
export function otherSide(battle, side) {
  assertBattle(battle);
  const ids = battle.scenario.sides.map((entry) => entry.id);
  if (!ids.includes(side)) {
    throw new Error(`Unknown side "${side}" (one of: ${ids.join(', ')}).`);
  }
  return ids.find((id) => id !== side);
}
