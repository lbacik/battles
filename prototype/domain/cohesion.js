// PÓLIS engine — Cohesion: disorder, rout, flight, rally, and removals (framework-free).
//
// The cohesion slice of the framework-free engine package: numeric cohesion
// from 0 to a per-troop-type maximum, threshold states, rout on reaching 0 or
// on failing a chance test after losing a flank/rear fight, immediate and
// repeated rout flights, destruction when blocked or attacked while Routed or
// worn below a soldier share, terrain strain for close spacing, and rally.
// This module imports only the domain model, the ruleset package, and the
// plane geometry — no React, no Next.js, no DOM, no Node APIs — so it runs
// unchanged in the browser, in Node unit tests, and in any future shell.
//
// Mechanics (decision #6 items 12, 15-16, 20-22):
//
// - Cohesion runs from 0 to a per-troop-type maximum (`cohesionMax` on the
//   troop-type entry, defaulting to `maxByTroop`). Thresholds place the unit:
//   0 is Routed, below `disorderedBelow` (but above 0) is Disordered with
//   combat and shooting penalties and no Charge, otherwise Steady.
// - A unit routs at 0 cohesion, or on failing a chance-based test after losing
//   a fight to a flank or rear contact (losing means it inflicted fewer losses
//   than it took on that fight). Routing breaks every engagement it held.
// - A Routed unit flees directly away from the threat by `flightM` at once and
//   again in each of its side's Cohesion phases. A flight whose footprint would
//   leave the battlefield makes the unit leave the battlefield (status `fled`,
//   counted as lost). A flight blocked by another unit or by water destroys the
//   unit. A Routed unit that is attacked (part of a Combat fight) is destroyed.
// - A unit reduced below `destructionShare` of its starting soldiers is removed
//   as destroyed (`status` `destroyed`). There is no panic contagion.
// - Units in close spacing whose footprint touches rough ground, forest, or
//   settlement lose `terrainLoss` cohesion in each of their side's Cohesion
//   phases.
// - Rally: a Disordered unit regains `rallyRegain` (capped at its maximum) and
//   does not move. A Routed unit may attempt only with no active enemy within
//   `rallyClearM` (otherwise rejected with details); success is by chance
//   (`rallyChance`) and returns the unit as Disordered at `rallyTo`; the unit
//   does not move.
// - Every state change and every draw is recorded in the events.

import { EPS, isFinitePoint, ringsTouch } from './geometry.js';
import { getTroopType, spacingClass } from './polis-classical.js';
import { footprintAt, groundCoverAt, groundFeaturesOf } from './movement.js';

// Default cohesion parameters when the battle snapshot carries no `cohesion`
// block. Initial values for this slice; the ruleset file owns the tuned ones.
export const DEFAULT_COHESION = Object.freeze({
  maxByTroop: Object.freeze({
    hoplite: 12,
    peltast: 8,
    archer: 6,
    slinger: 6,
    light_cavalry: 8,
    cavalry: 10,
  }),
  disorderedBelow: 4,
  rallyRegain: 2,
  rallyTo: 2,
  rallyChance: 0.5,
  rallyClearM: 100,
  flightM: 60,
  flankRoutPassChance: 0.5,
  terrainLoss: 1,
  destructionShare: 0.25,
});

// Read the cohesion parameters from the battle snapshot, in either the outer
// shape (`parameters.cohesion`) or the inner shape (the cohesion block itself).
// Missing values fall back to the defaults; the per-troop maxima merge per
// troop type. Never throws.
export function cohesionParamsOf(parameters) {
  const inner = parameters && typeof parameters === 'object' && parameters.cohesion
    && typeof parameters.cohesion === 'object'
    ? parameters.cohesion
    : parameters && typeof parameters === 'object' ? parameters : {};
  const pick = (key) => (Number.isFinite(inner[key]) ? inner[key] : DEFAULT_COHESION[key]);
  const maxRaw = inner.maxByTroop && typeof inner.maxByTroop === 'object' ? inner.maxByTroop : {};
  const maxByTroop = { ...DEFAULT_COHESION.maxByTroop };
  for (const key of Object.keys(maxByTroop)) {
    if (Number.isFinite(maxRaw[key]) && maxRaw[key] > 0) {
      maxByTroop[key] = maxRaw[key];
    }
  }
  // Unknown troop keys in the snapshot are preserved so custom types keep
  // their maxima.
  for (const key of Object.keys(maxRaw)) {
    if (!Object.hasOwn(maxByTroop, key) && Number.isFinite(maxRaw[key]) && maxRaw[key] > 0) {
      maxByTroop[key] = maxRaw[key];
    }
  }
  return {
    maxByTroop,
    disorderedBelow: pick('disorderedBelow'),
    rallyRegain: pick('rallyRegain'),
    rallyTo: pick('rallyTo'),
    rallyChance: Number.isFinite(inner.rallyChance) && inner.rallyChance >= 0 && inner.rallyChance <= 1
      ? inner.rallyChance
      : DEFAULT_COHESION.rallyChance,
    rallyClearM: pick('rallyClearM'),
    flightM: pick('flightM'),
    flankRoutPassChance: Number.isFinite(inner.flankRoutPassChance)
      && inner.flankRoutPassChance >= 0 && inner.flankRoutPassChance <= 1
      ? inner.flankRoutPassChance
      : DEFAULT_COHESION.flankRoutPassChance,
    terrainLoss: pick('terrainLoss'),
    destructionShare: Number.isFinite(inner.destructionShare)
      && inner.destructionShare >= 0 && inner.destructionShare <= 1
      ? inner.destructionShare
      : DEFAULT_COHESION.destructionShare,
  };
}

// The per-troop-type cohesion maximum: the catalogue entry's `cohesionMax`
// when present, otherwise the parameter table, otherwise the hoplite default.
// Never throws; always positive.
export function cohesionMaxFor(troopType, params = null) {
  const entry = getTroopType(troopType);
  if (entry && Number.isFinite(entry.cohesionMax) && entry.cohesionMax > 0) {
    return entry.cohesionMax;
  }
  const table = params?.maxByTroop ?? DEFAULT_COHESION.maxByTroop;
  if (table && Number.isFinite(table?.[troopType]) && table[troopType] > 0) {
    return table[troopType];
  }
  return 10;
}

// The cohesion state for a numeric value: 0 is Routed, below `disorderedBelow`
// (but above 0) is Disordered, otherwise Steady. Pure.
export function cohesionStateForValue(value, params = null) {
  const threshold = Number.isFinite(params?.disorderedBelow)
    ? params.disorderedBelow
    : DEFAULT_COHESION.disorderedBelow;
  if (!Number.isFinite(value) || value <= 0) {
    return 'Routed';
  }
  if (value < threshold) {
    return 'Disordered';
  }
  return 'Steady';
}

// Numeric cohesion for a unit. Prefers an explicit finite `cohesionValue` (the
// new canonical field), then a numeric `cohesion`, then maps a legacy state
// string (Steady to its maximum, Disordered to just below the threshold,
// Routed to 0). Never throws.
export function unitCohesionValue(unit, params = null) {
  if (Number.isFinite(unit?.cohesionValue)) {
    return unit.cohesionValue;
  }
  if (Number.isFinite(unit?.cohesion)) {
    return unit.cohesion;
  }
  const state = typeof unit?.cohesion === 'string' ? unit.cohesion
    : typeof unit?.cohesionState === 'string' ? unit.cohesionState : 'Steady';
  if (state === 'Routed') {
    return 0;
  }
  if (state === 'Disordered') {
    const threshold = Number.isFinite(params?.disorderedBelow)
      ? params.disorderedBelow
      : DEFAULT_COHESION.disorderedBelow;
    return Math.max(0, threshold - 1);
  }
  return cohesionMaxFor(unit?.troopType, params);
}

// The cohesion state for a unit: an explicit legacy string wins (so tests and
// saves that set `cohesion: 'Routed'` keep meaning what they say), otherwise
// the numeric value maps through the thresholds. Pure.
export function unitCohesionState(unit, params = null) {
  if (typeof unit?.cohesion === 'string') {
    return unit.cohesion;
  }
  if (typeof unit?.cohesionState === 'string') {
    return unit.cohesionState;
  }
  return cohesionStateForValue(unitCohesionValue(unit, params), params);
}

// True when the unit is still on the field: no `destroyed` or `fled` status.
// Units without a status (older saves) count as active. Pure.
export function isActiveUnit(unit) {
  return unit?.status === undefined || unit?.status === null || unit?.status === 'active';
}

// Keep the state's string fields in sync with the numeric value: sets
// `cohesionValue` to the clamped numeric and `cohesion` to the matching state.
// Returns `{ valueBefore, valueAfter, stateBefore, stateAfter }`. Mutates.
export function syncCohesion(unit, params = null) {
  const max = cohesionMaxFor(unit?.troopType, params);
  const valueBefore = unitCohesionValue(unit, params);
  const stateBefore = unitCohesionState(unit, params);
  let value = valueBefore;
  if (!Number.isFinite(value)) {
    value = max;
  }
  value = Math.max(0, Math.min(max, Math.round(value * 1000) / 1000));
  const stateAfter = cohesionStateForValue(value, params);
  unit.cohesionValue = value;
  unit.cohesion = stateAfter;
  unit.cohesionState = stateAfter;
  return { valueBefore, valueAfter: value, stateBefore, stateAfter: stateAfter };
}

// Reduce cohesion by `amount` (never below 0), sync the state, and report the
// transition. Mutates. Pure apart from the mutation.
export function loseCohesion(unit, amount, params = null) {
  const before = unitCohesionValue(unit, params);
  const stateBefore = unitCohesionState(unit, params);
  const loss = Number.isFinite(amount) && amount > 0 ? amount : 0;
  unit.cohesionValue = Math.max(0, before - loss);
  syncCohesion(unit, params);
  return {
    valueBefore: before,
    valueAfter: unit.cohesionValue,
    stateBefore,
    stateAfter: unitCohesionState(unit, params),
    loss,
  };
}

// Euclidean distance between two points. Pure.
export function distanceBetween(a, b) {
  if (!isFinitePoint(a) || !isFinitePoint(b)) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// The nearest active enemy unit to `unit` in the battle, with its distance in
// metres measured between front midpoints (`position`). Skips the unit itself
// and any destroyed or fled unit. Returns `{ enemy, distanceM }` or
// `{ enemy: null, distanceM: Infinity }`. Pure.
export function nearestEnemyOf(battle, unit) {
  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const other of battle?.units || []) {
    if (!other || other.id === unit?.id || other.side === unit?.side) {
      continue;
    }
    if (!isActiveUnit(other)) {
      continue;
    }
    if (!isFinitePoint(other.position)) {
      continue;
    }
    const distance = distanceBetween(unit?.position, other.position);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = other;
    }
  }
  return { enemy: best, distanceM: bestDistance };
}

// Break every engagement the unit holds: clears its own contact and any enemy
// contact pointing at it. Returns the ids whose contact was cleared. Mutates.
export function breakEngagements(battle, unitId) {
  const broken = [];
  const unit = (battle?.units || []).find((entry) => entry?.id === unitId);
  if (unit && unit.engaged) {
    broken.push(unitId);
    unit.engaged = null;
  }
  for (const other of battle?.units || []) {
    if (other?.engaged && typeof other.engaged === 'object' && other.engaged.unitId === unitId) {
      if (!broken.includes(other.id)) {
        broken.push(other.id);
      }
      other.engaged = null;
    }
  }
  return broken;
}

// Destination fleeing directly away from `threat` by `distanceM`: the front
// midpoint steps along the (position − threat) bearing. When the threat is
// missing or coincides with the unit, the unit steps straight back from its
// facing (as a withdraw does). Positions round to the stored 0.1 m. Pure.
export function flightDestination(unit, threat, distanceM) {
  const from = unit?.position;
  const distance = Number.isFinite(distanceM) && distanceM > 0 ? distanceM : DEFAULT_COHESION.flightM;
  if (!isFinitePoint(from)) {
    return null;
  }
  let dx = 0;
  let dy = 0;
  if (isFinitePoint(threat)) {
    dx = from.x - threat.x;
    dy = from.y - threat.y;
  }
  if (Math.hypot(dx, dy) < EPS) {
    const radians = (Number.isFinite(unit?.facing) ? unit.facing : 0) * (Math.PI / 180);
    dx = -Math.sin(radians);
    dy = -Math.cos(radians);
  }
  const length = Math.hypot(dx, dy) || 1;
  return {
    x: Math.round((from.x + (dx / length) * distance) * 10) / 10,
    y: Math.round((from.y + (dy / length) * distance) * 10) / 10,
  };
}

// The outcome of fleeing from `threat` by `distanceM`: `fled` when the resting
// footprint leaves the battlefield, `destroyed` when the resting footprint
// touches another unit or water (a blocked flight), otherwise `moved` with the
// destination. Checks only the resting footprint: the rout flees through
// whatever it must — only where it lands decides. Pure.
export function flightOutcomeFor(unit, threat, battle, params = null) {
  const cohesion = cohesionParamsOf(params?.cohesion ?? params ?? {});
  const distanceM = cohesion.flightM;
  const destination = flightDestination(unit, threat, distanceM);
  if (!destination) {
    return { outcome: 'destroyed', destination: null, reason: 'no-pose' };
  }
  let corners;
  try {
    corners = footprintAt(unit, destination, unit?.facing ?? 0).corners;
  } catch {
    return { outcome: 'destroyed', destination, reason: 'bad-footprint' };
  }
  const battlefield = battle?.scenario?.battlefield;
  const width = battlefield?.width;
  const height = battlefield?.height;
  const outside = corners.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y)
    || point.x < -EPS || point.y < -EPS
    || (Number.isFinite(width) && point.x > width + EPS)
    || (Number.isFinite(height) && point.y > height + EPS));
  if (outside) {
    return { outcome: 'fled', destination, reason: 'battlefield-edge' };
  }
  for (const other of battle?.units || []) {
    if (!other || other.id === unit?.id || !isActiveUnit(other)) {
      continue;
    }
    let otherCorners = null;
    try {
      otherCorners = footprintAt(other, { ...other.position }, other.facing).corners;
    } catch {
      continue;
    }
    if (ringsTouch(corners, otherCorners)) {
      return { outcome: 'destroyed', destination, reason: 'flight-blocked', blockedBy: other.id };
    }
  }
  const features = battle?.scenario?.terrainFeatures || [];
  const waters = groundFeaturesOf(features).filter((feature) => feature.category === 'water');
  for (const water of waters) {
    if (ringsTouch(corners, water.polygon)) {
      return { outcome: 'destroyed', destination, reason: 'flight-blocked-water', blockedBy: water.id };
    }
  }
  return { outcome: 'moved', destination, reason: 'fled-clear' };
}
