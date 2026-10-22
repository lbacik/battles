// PÓLIS engine — Move orders on open ground (framework-free).
//
// The manoeuvre slice of the framework-free engine package: a unit moves with
// one to three legs. On each leg the unit first rotates optionally about its
// front midpoint to a new facing, then marches its front midpoint straight to
// a point; a leg with only a rotation is allowed. This module imports only
// the plane geometry helpers — no React, no Next.js, no DOM, no Node APIs —
// so it runs unchanged in the browser, in Node unit tests, and in any future
// shell.
//
// Mechanics (decision #6 item 8, parameters live in `polis-classical`):
//
// - A unit advances front-first, obliquely up to `forwardArcDeg` (45) of its
//   facing, at the full rate. Steeper, sideways, and backward steps cost
//   `1 / restrictedRateFactor` per metre (double distance at 0.5).
// - A change of facing rotates the footprint about the front midpoint and
//   costs `frontageM * angleRad * wheelFactor` metres: a wide formation
//   wheels expensively.
// - Every leg is billed against a single movement allowance in metres; a move
//   that does not fit is rejected, never truncated.
//
// Checks, in order (the first failure wins, so each rejection is unambiguous):
//
// 1. `invalid_move`: the legs are not 1-3 `{face?, to?}` legs with finite
//    numbers, or a leg carries neither a rotation nor a destination.
// 2. `battlefield_edge`: a swept corner leaves the battlefield. `details.at`
//    is the first footprint corner found outside, in metres.
// 3. `out_of_reach`: the billed distance exceeds the allowance. `details`
//    carries `availableM`, `requiredM`, and the `shortfallM`.
// 4. `contact_with_enemy`: the final footprint merely touches (boundary
//    contact without positive-area overlap) an enemy footprint. `details`
//    names the enemy `withUnitId`. Ending adjacent is a matter for Charge,
//    so Move refuses it.
// 5. `collision`: the swept footprint — every rotation sample and every
//    translation hull, including the final resting footprint — touches any
//    other unit. `details` names the unit (`withUnitId`) and the mover's
//    front-midpoint position at the start of the leg on which the touch first
//    occurs (`at`). A final footprint that overlaps (rather than touches) an
//    enemy lands here; a final footprint that touches a friend lands here
//    too, because the swept footprint must not touch other units.
//
// An accepted plan returns a deterministic preview: the footprint after the
// Movement phase with positions rounded to 0.1 m and the facing normalised to
// [0, 360). Resolution commits exactly the rounded preview, so validation and
// resolution can never disagree.

import {
  deriveFootprint,
  polygonsOverlapPositiveArea,
  ringsTouch,
  round1,
} from './geometry.js';

// The most legs a Move may hold. Mirrors `movement.maxLegs` in the ruleset
// parameters; the parameter wins when the two disagree.
export const MAX_MOVE_LEGS = 3;

// Half the frontal arc, in degrees: displacements within this angle of the
// facing march at the full rate. Mirrors `movement.forwardArcDeg`.
export const FORWARD_ARC_DEG = 45;

const DEG = Math.PI / 180;
// Rotation sweep granularity: intermediate footprints every 5 degrees, so a
// swinging corner cannot skip over a neighbouring footprint between samples.
const SWEEP_STEP_DEG = 5;
// Zero-length marches bill nothing and sweep nothing.
const EPS = 1e-9;

// Normalise a facing to [0, 360).
export function normalizeFacing(degrees) {
  return ((degrees % 360) + 360) % 360;
}

// Signed smallest turn from one facing to another, in (-180, 180].
export function signedAngleDiff(fromDeg, toDeg) {
  return ((toDeg - fromDeg + 540) % 360) - 180;
}

// Compass bearing of the displacement, in [0, 360), or null for a zero step.
export function displacementBearing(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) <= EPS) {
    return null;
  }
  return normalizeFacing(Math.atan2(dx, dy) / DEG);
}

// Frontage in metres: the width the wheel cost is proportional to.
export function frontageOf(unit) {
  return unit.files * unit.lateralInterval;
}

// Movement allowance in metres for the unit's troop type on open ground.
// Terrain modifiers arrive with the terrain slice; unknown troop types have
// no allowance. Never throws.
export function movementAllowanceM(unit, params) {
  const value = params?.allowanceM?.[unit?.troopType];
  return Number.isFinite(value) ? value : 0;
}

// Footprint corners for a unit template at a position and facing.
export function footprintAt(template, position, facing) {
  const derived = deriveFootprint({
    soldiers: template.soldiers,
    files: template.files,
    lateralInterval: template.lateralInterval,
    rankDepth: template.rankDepth,
    position: { ...position },
    facing,
  });
  return {
    position: { ...position },
    facing,
    frontageM: derived.frontage,
    depthM: derived.depth,
    corners: derived.corners,
  };
}

// Convex hull of points (Andrew's monotone chain), counter-clockwise, without
// collinear vertices. The sweep of a convex footprint translating straight
// from one pose to another is exactly the hull of both corner sets.
export function convexHull(points) {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = [];
  for (const point of sorted) {
    const last = unique[unique.length - 1];
    if (!last || Math.abs(last.x - point.x) > EPS || Math.abs(last.y - point.y) > EPS) {
      unique.push({ x: point.x, y: point.y });
    }
  }
  if (unique.length <= 1) {
    return unique;
  }
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const point of unique) {
    while (lower.length >= 2
      && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= EPS) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper = [];
  for (let i = unique.length - 1; i >= 0; i -= 1) {
    const point = unique[i];
    while (upper.length >= 2
      && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= EPS) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function isFinitePoint(point) {
  return !!point
    && typeof point === 'object'
    && Number.isFinite(point.x)
    && Number.isFinite(point.y);
}

function roundPoint(point) {
  return { x: round1(point.x), y: round1(point.y) };
}

// Normalise raw `legs` into `[{ face | null, to | null }]`, or return
// `{ error: reason }` for the `invalid_move` rejection.
export function normalizeLegs(legs, maxLegs = MAX_MOVE_LEGS) {
  if (!Array.isArray(legs)) {
    return { error: 'legs-missing' };
  }
  if (legs.length < 1) {
    return { error: 'no-legs' };
  }
  if (legs.length > maxLegs) {
    return { error: 'too-many-legs' };
  }
  const normalised = [];
  for (const leg of legs) {
    if (!leg || typeof leg !== 'object' || Array.isArray(leg)) {
      return { error: 'bad-leg' };
    }
    let face = null;
    if (leg.face !== undefined && leg.face !== null) {
      if (!Number.isFinite(leg.face)) {
        return { error: 'bad-face' };
      }
      face = normalizeFacing(leg.face);
    }
    let to = null;
    if (leg.to !== undefined && leg.to !== null) {
      if (!isFinitePoint(leg.to)) {
        return { error: 'bad-to' };
      }
      to = { x: leg.to.x, y: leg.to.y };
    }
    if (face === null && to === null) {
      return { error: 'empty-leg' };
    }
    normalised.push({ face, to });
  }
  return { legs: normalised };
}

// Validate one Move against the field: the mover's footprint template, its
// current `{ position, facing }`, the raw legs, the ruleset movement
// parameters, the battlefield `{ width, height }`, and every other unit as
// `{ id, side, corners }` at its simulated footprint. Pure: nothing is
// changed.
export function validateMoveOnField({
  unit,
  from,
  legs,
  params,
  battlefield,
  others,
  orderIndex = 0,
}) {
  const unitId = unit?.id ?? null;
  const fail = (code, details, message) => ({ ok: false, code, details, message });
  const maxLegs = Number.isInteger(params?.maxLegs) && params.maxLegs > 0
    ? params.maxLegs
    : MAX_MOVE_LEGS;
  const normalised = normalizeLegs(legs, maxLegs);
  if (normalised.error) {
    return fail(
      'invalid_move',
      { unitId, reason: normalised.error },
      `Order ${orderIndex}: unit "${unitId}" has an invalid Move (${normalised.error}).`,
    );
  }

  const frontage = frontageOf(unit);
  const wheelFactor = Number.isFinite(params?.wheelFactor) ? params.wheelFactor : 0.5;
  const restricted = Number.isFinite(params?.restrictedRateFactor)
    ? params.restrictedRateFactor
    : 0.5;
  const arc = Number.isFinite(params?.forwardArcDeg) ? params.forwardArcDeg : FORWARD_ARC_DEG;

  // Simulate the legs, recording the sweep in order: rotation samples and
  // translation hulls, each with the mover's front-midpoint position (`at`)
  // for the rejection details.
  let position = { x: from.position.x, y: from.position.y };
  let facing = normalizeFacing(from.facing);
  let turnCost = 0;
  let moveCost = 0;
  const sweep = [{ kind: 'sample', corners: footprintAt(unit, position, facing).corners, at: { ...position } }];
  for (const leg of normalised.legs) {
    if (leg.face !== null) {
      const delta = signedAngleDiff(facing, leg.face);
      if (Math.abs(delta) > EPS) {
        turnCost += frontage * Math.abs(delta) * DEG * wheelFactor;
        const steps = Math.max(1, Math.ceil(Math.abs(delta) / SWEEP_STEP_DEG));
        for (let step = 1; step <= steps; step += 1) {
          const intermediate = normalizeFacing(facing + (delta * step) / steps);
          sweep.push({
            kind: 'sample',
            corners: footprintAt(unit, position, intermediate).corners,
            at: { ...position },
          });
        }
        facing = normalizeFacing(leg.face);
      }
    }
    if (leg.to !== null) {
      const distance = Math.hypot(leg.to.x - position.x, leg.to.y - position.y);
      if (distance > EPS) {
        const bearing = displacementBearing(position, leg.to);
        const offAxis = Math.abs(signedAngleDiff(facing, bearing));
        const rate = offAxis <= arc + EPS ? 1 : restricted;
        moveCost += rate > 0 ? distance / rate : Number.POSITIVE_INFINITY;
        const start = footprintAt(unit, position, facing).corners;
        const end = footprintAt(unit, leg.to, facing).corners;
        sweep.push({
          kind: 'hull',
          corners: convexHull([...start, ...end]),
          at: { ...position },
        });
        position = { x: leg.to.x, y: leg.to.y };
        sweep.push({ kind: 'sample', corners: end, at: { ...position } });
      }
    }
  }

  // 2. The swept footprint stays inside the battlefield.
  const width = battlefield?.width;
  const height = battlefield?.height;
  const outside = (point) => !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || point.x < -EPS
    || point.x > width + EPS
    || point.y < -EPS
    || point.y > height + EPS;
  for (const entry of sweep) {
    const exit = entry.corners.find(outside);
    if (exit) {
      return fail(
        'battlefield_edge',
        { unitId, at: roundPoint(exit) },
        `Order ${orderIndex}: unit "${unitId}" would leave the battlefield at ` +
          `(${round1(exit.x)}, ${round1(exit.y)}).`,
      );
    }
  }

  // 3. The billed distance fits the allowance.
  const requiredM = round1(turnCost + moveCost);
  const availableM = movementAllowanceM(unit, params);
  if (requiredM > availableM + EPS) {
    return fail(
      'out_of_reach',
      { unitId, availableM, requiredM, shortfallM: round1(requiredM - availableM) },
      `Order ${orderIndex}: unit "${unitId}" needs ${requiredM} m but has ${availableM} m ` +
        `(shortfall ${round1(requiredM - availableM)} m).`,
    );
  }

  const finalCorners = footprintAt(unit, position, facing).corners;
  const enemies = (others || []).filter((other) => other.side !== unit.side);

  // 4. The final footprint never ends in contact with an enemy: boundary
  // contact without overlap is the charger's business, so Move refuses it.
  // Overlap with an enemy falls through to the collision check below.
  for (const enemy of enemies) {
    if (ringsTouch(finalCorners, enemy.corners)
      && !polygonsOverlapPositiveArea(finalCorners, enemy.corners)) {
      return fail(
        'contact_with_enemy',
        { unitId, withUnitId: enemy.id },
        `Order ${orderIndex}: unit "${unitId}" would end in contact with enemy unit "${enemy.id}".`,
      );
    }
  }

  // 5. The swept footprint touches no other unit.
  for (const entry of sweep) {
    for (const other of others || []) {
      if (ringsTouch(entry.corners, other.corners)) {
        return fail(
          'collision',
          { unitId, withUnitId: other.id, at: roundPoint(entry.at) },
          `Order ${orderIndex}: unit "${unitId}" would collide with unit "${other.id}" ` +
            `at (${round1(entry.at.x)}, ${round1(entry.at.y)}).`,
        );
      }
    }
  }

  const endPosition = roundPoint(position);
  const endFacing = normalizeFacing(round1(facing));
  return {
    ok: true,
    preview: {
      position: endPosition,
      facing: endFacing,
      corners: footprintAt(unit, endPosition, endFacing).corners.map(roundPoint),
    },
    requiredM,
    availableM,
  };
}
