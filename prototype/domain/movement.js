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
// Checks, in order (the first failure wins, so each rejection is unambiguous).
// The spec lists collision first, but the resting touch with an enemy would
// be unreachable under a literal collision-first sweep — the sweep covers the
// resting footprint too — so the resting place is classified after the path:
//
// 1. `invalid_move`: the legs are not 1-3 `{face?, to?}` legs with finite
//    numbers, or a leg carries neither a rotation nor a destination. Legs
//    are snapped to the stored 0.1 m / 0.1 degree precision up front.
// 2. `battlefield_edge`: a swept corner leaves the battlefield. `details.at`
//    is the first footprint corner found outside, in metres.
// 3. `collision`: the swept footprint touches another unit. Transit poses
//    (rotation intermediates, march intermediates every 1 m) and hull
//    overlaps collide outright; a hull that merely touches is attributed
//    first — pre-existing adjacency from the starting pose, or the resting
//    pose, is not a transit collision. `details` names the unit
//    (`withUnitId`) and the mover's front-midpoint position where the touch
//    first occurs (`at`): the sample pose for a transit touch, the resting
//    position for a resting touch. The starting pose itself never collides,
//    so a unit deployed touching a friend stays free to march away.
// 4. `out_of_reach`: the billed distance exceeds the allowance. `details`
//    carries `availableM`, `requiredM`, and the `shortfallM`, all billed to
//    0.1 m — the shown `requiredM` is what is compared, so the details always
//    explain the verdict.
// 5. `contact_with_enemy`: the resting footprint merely touches (boundary
//    contact without positive-area overlap) an enemy footprint. `details`
//    names the enemy `withUnitId`. Ending adjacent is a matter for Charge,
//    so Move refuses it; a resting overlap, or a resting touch with a
//    friend, already collided at step 3.
//
// An accepted plan returns a deterministic preview: the footprint after the
// Movement phase with positions rounded to 0.1 m and the facing normalised to
// [0, 360). Validation simulates on snapped poses and commits exactly the
// preview, so re-validating a verdict can never disagree with it.

import {
  EPS,
  deriveFootprint,
  isFinitePoint,
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
// Sweep granularity: intermediate rotation poses every 2 degrees and
// intermediate march poses every 1 m, so a swinging corner or a passing edge
// cannot skip over a neighbouring footprint between samples. Translation
// hulls additionally back every leg with an exact overlap test.
const SWEEP_STEP_DEG = 2;
const TRANSIT_SAMPLE_M = 1;

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

function roundPoint(point) {
  return { x: round1(point.x), y: round1(point.y) };
}

// Deterministic Movement-phase footprint: the stored 0.1 m precision for the
// position and corners, the facing normalised to [0, 360). Shared by Move
// previews and Hold previews so both describe the same shape.
export function footprintPreview(template, position, facing) {
  const rounded = roundPoint(position);
  const orientation = normalizeFacing(round1(facing));
  return {
    position: rounded,
    facing: orientation,
    corners: footprintAt(template, rounded, orientation).corners.map(roundPoint),
  };
}

// Normalise raw `legs` into `[{ face | null, to | null }]`, snapped to the
// stored 0.1 m / 0.1 degree precision, or return `{ error: reason }` for the
// `invalid_move` rejection. Snapping up front keeps validation, the preview,
// and resolution on exactly the same poses: what is checked is what commits.
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
      face = normalizeFacing(round1(leg.face));
    }
    let to = null;
    if (leg.to !== undefined && leg.to !== null) {
      if (!isFinitePoint(leg.to)) {
        return { error: 'bad-to' };
      }
      to = roundPoint(leg.to);
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

  // Simulate the legs on snapped poses (see `normalizeLegs`), recording the
  // sweep in order: rotation samples and translation hulls with intermediate
  // march samples, each with the mover's front-midpoint position (`at`) for
  // the rejection details. The starting pose is validated history, so it
  // takes part in no collision check: a unit deployed touching a friend stays
  // free to march away.
  let position = roundPoint(from.position);
  let facing = normalizeFacing(round1(from.facing));
  let turnCost = 0;
  let moveCost = 0;
  const startCorners = footprintAt(unit, position, facing).corners;
  const samples = [];
  const hulls = [];
  for (const leg of normalised.legs) {
    if (leg.face !== null) {
      const delta = signedAngleDiff(facing, leg.face);
      if (Math.abs(delta) > EPS) {
        turnCost += frontage * Math.abs(delta) * DEG * wheelFactor;
        const steps = Math.max(1, Math.ceil(Math.abs(delta) / SWEEP_STEP_DEG));
        for (let step = 1; step <= steps; step += 1) {
          const intermediate = normalizeFacing(facing + (delta * step) / steps);
          samples.push({
            pose: { position: { ...position }, facing: intermediate },
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
        hulls.push({
          corners: convexHull([...start, ...end]),
          at: { ...position },
        });
        const strides = Math.max(1, Math.ceil(distance / TRANSIT_SAMPLE_M));
        for (let stride = 1; stride < strides; stride += 1) {
          const waypoint = roundPoint({
            x: position.x + ((leg.to.x - position.x) * stride) / strides,
            y: position.y + ((leg.to.y - position.y) * stride) / strides,
          });
          samples.push({
            pose: { position: { ...waypoint }, facing },
            corners: footprintAt(unit, waypoint, facing).corners,
            at: { ...waypoint },
          });
        }
        position = { x: leg.to.x, y: leg.to.y };
        samples.push({
          pose: { position: { ...position }, facing },
          corners: end,
          at: { ...position },
        });
      }
    }
  }
  const finalCorners = footprintAt(unit, position, facing).corners;
  const samePose = (a, b) => a.position.x === b.position.x
    && a.position.y === b.position.y
    && a.facing === b.facing;
  const finalPose = { position: { ...position }, facing };
  // Transit poses: every sample except the starting pose (validated history)
  // and the resting pose (classified by the final-state checks below).
  const transit = samples.filter((entry) => !samePose(entry.pose, finalPose));
  const lineup = others || [];
  const touches = (corners, other) => ringsTouch(corners, other.corners);
  const overlaps = (corners, other) => polygonsOverlapPositiveArea(corners, other.corners);
  const finalTouches = (other) => touches(finalCorners, other);
  const finalOverlaps = (other) => overlaps(finalCorners, other);

  // 2. The swept footprint stays inside the battlefield: every transit pose,
  // every hull, and the resting footprint.
  const width = battlefield?.width;
  const height = battlefield?.height;
  const outside = (point) => !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || point.x < -EPS
    || point.x > width + EPS
    || point.y < -EPS
    || point.y > height + EPS;
  for (const entry of [...samples, ...hulls, { corners: finalCorners }]) {
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

  // 3. The swept footprint touches no other unit. Transit poses and hull
  // overlaps collide outright. A hull that merely touches is attributed
  // before it collides: pre-existing adjacency from the starting pose, or
  // the resting pose (classified by the final-state checks below), is not
  // a transit collision.
  const startAdjacent = new Set(
    lineup
      .filter((other) => touches(startCorners, other) && !overlaps(startCorners, other))
      .map((other) => other.id),
  );
  const collide = (other, at, why) => fail(
    'collision',
    { unitId, withUnitId: other.id, at: roundPoint(at) },
    `Order ${orderIndex}: unit "${unitId}" would collide with unit "${other.id}" ${why} ` +
      `at (${round1(at.x)}, ${round1(at.y)}).`,
  );
  for (const entry of transit) {
    for (const other of lineup) {
      if (touches(entry.corners, other)) {
        return collide(other, entry.at, 'on its path');
      }
    }
  }
  for (const entry of hulls) {
    for (const other of lineup) {
      if (overlaps(entry.corners, other)) {
        return collide(other, entry.at, 'on its path');
      }
      if (touches(entry.corners, other)
        && !startAdjacent.has(other.id)
        && !(finalTouches(other) && !finalOverlaps(other))) {
        return collide(other, entry.at, 'on its path');
      }
    }
  }

  // 4. The billed distance fits the allowance, billed to the stored 0.1 m:
  // the shown `requiredM` is what is compared, so the details always explain
  // the verdict.
  const requiredM = round1(turnCost + moveCost);
  const availableM = movementAllowanceM(unit, params);
  if (requiredM > availableM) {
    return fail(
      'out_of_reach',
      { unitId, availableM, requiredM, shortfallM: round1(requiredM - availableM) },
      `Order ${orderIndex}: unit "${unitId}" needs ${requiredM} m but has ${availableM} m ` +
        `(shortfall ${round1(requiredM - availableM)} m).`,
    );
  }

  // 5. The resting footprint never ends in contact with an enemy: boundary
  // contact without overlap is the charger's business, so Move refuses it.
  // Overlap with anyone, or a mere touch with a friend, already collided
  // above; the resting touch with an enemy is the one case the sweep
  // attribution holds back for this check.
  for (const other of lineup) {
    if (overlaps(finalCorners, other)) {
      return collide(other, position, 'at its resting place');
    }
    if (touches(finalCorners, other)) {
      if (other.side !== unit.side) {
        return fail(
          'contact_with_enemy',
          { unitId, withUnitId: other.id },
          `Order ${orderIndex}: unit "${unitId}" would end in contact with enemy unit "${other.id}".`,
        );
      }
      return collide(other, position, 'at its resting place');
    }
  }

  return {
    ok: true,
    preview: footprintPreview(unit, position, facing),
    requiredM,
    availableM,
  };
}
