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
// Mechanics (decision #6 items 8, 14-15; parameters live in `polis-classical`):
//
// - A unit advances front-first, obliquely up to `forwardArcDeg` (45) of its
//   facing, at the full rate. Steeper, sideways, and backward steps cost
//   `1 / restrictedRateFactor` per metre (double distance at 0.5).
// - A change of facing rotates the footprint about the front midpoint and
//   costs `frontageM * angleRad * wheelFactor` metres: a wide formation
//   wheels expensively.
// - Ground cover multiplies every billed metre by the factor of the worst
//   cover the footprint touches (open 1, rough `terrain.roughFactor`, forest
//   and settlement `terrain.forestFactor`; elevation is ignored). A road
//   bills `terrain.roadFactor` instead, but only for units in column (files at
//   or below `terrain.columnMaxFiles`). A translation leg whose swept
//   footprint touches a river adds `terrain.riverCostM` per river feature
//   touched. Water is impassable (see `forbidden_ground` below).
// - Every leg is billed against a single movement allowance in metres; a move
//   that does not fit is rejected, never truncated.
//
// Cost accumulation along a leg that crosses terrain boundaries: a march is
// split into 1 m subsegments and each subsegment bills
// `(length / directionalRate) * factorAtMidpoint`, with the factor read from
// the footprint centred on that subsegment's midpoint. A wheel bills
// `frontageM * angleRad * wheelFactor * factorAtStart`, with the factor read
// from the footprint before the rotation. The full ruleset account lives in
// `polis-classical.js`; this module implements it.
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
// 4. `forbidden_ground`: the swept footprint touches water. `details` carries
//    the water `featureId`, `groundCover: 'water'`, and the mover's
//    front-midpoint position `at` where the touch first occurs. Every transit
//    pose, every hull, and the resting footprint is checked: a sweep that
//    touches water anywhere is rejected, including a hull covering the
//    starting pose. Playability already refuses a setup in water, so a legal
//    unit only ever meets water on its path.
// 5. `out_of_reach`: the billed distance exceeds the allowance. `details`
//    carries `availableM`, `requiredM`, and the `shortfallM`, all billed to
//    0.1 m — the shown `requiredM` is what is compared, so the details always
//    explain the verdict. `availableM` is the open-ground allowance; the
//    terrain-adjusted allowance shown in the available actions is documented
//    in `movementAllowanceM`.
// 6. `contact_with_enemy`: the resting footprint merely touches (boundary
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
  locatePoint,
  polygonsOverlapPositiveArea,
  ringsTouch,
  round1,
  segmentsIntersect,
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

// --- Terrain: worst ground cover, roads, rivers, water -----------------------
// Ground cover categories are fixed by the scenario model; this module only
// gives them effects (decision #6 items 14-15). Elevation is independent of
// ground cover and imposes no movement penalty, so elevation features are
// never consulted here.

// Severity of each ground cover: the terrain that applies to a unit is the
// worst (highest) cover its footprint touches. Settlement acts as forest;
// water is impassable and handled as `forbidden_ground`, never as a factor.
const GROUND_RANK = Object.freeze({
  open: 0,
  rough: 1,
  forest: 2,
  settlement: 2,
  water: 3,
});

const DEFAULT_TERRAIN = Object.freeze({
  roughFactor: 1.5,
  forestFactor: 2.5,
  roadFactor: 0.7,
  columnMaxFiles: 4,
  riverCostM: 30,
});

function terrainOf(params) {
  const raw = params?.terrain && typeof params.terrain === 'object' ? params.terrain : {};
  const pick = (key) => (Number.isFinite(raw[key]) ? raw[key] : DEFAULT_TERRAIN[key]);
  return {
    roughFactor: pick('roughFactor'),
    forestFactor: pick('forestFactor'),
    roadFactor: pick('roadFactor'),
    columnMaxFiles: Number.isInteger(raw.columnMaxFiles) && raw.columnMaxFiles >= 0
      ? raw.columnMaxFiles
      : DEFAULT_TERRAIN.columnMaxFiles,
    riverCostM: pick('riverCostM'),
  };
}

function groundFeaturesOf(terrainFeatures) {
  return (Array.isArray(terrainFeatures) ? terrainFeatures : []).filter(
    (feature) => feature && feature.kind === 'ground'
      && Array.isArray(feature.polygon) && feature.polygon.length >= 3,
  );
}

function linearFeaturesOf(terrainFeatures, category) {
  return (Array.isArray(terrainFeatures) ? terrainFeatures : []).filter(
    (feature) => feature && feature.kind === 'linear' && feature.category === category
      && Array.isArray(feature.path) && feature.path.length >= 2
      && Number.isFinite(feature.width) && feature.width > 0,
  );
}

// Distance from a point to a segment.
function distPointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  if (!(squared > 0)) {
    return Math.hypot(point.x - a.x, point.y - a.y);
  }
  const t = Math.min(1, Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

// Distance between two segments: zero when they intersect.
function distSegmentToSegment(a, b, c, d) {
  if (segmentsIntersect(a, b, c, d)) {
    return 0;
  }
  return Math.min(
    distPointToSegment(a, c, d),
    distPointToSegment(b, c, d),
    distPointToSegment(c, a, b),
    distPointToSegment(d, a, b),
  );
}

// True when a footprint ring touches a linear corridor (a path with a width):
// a path vertex inside the ring, or any ring edge within half the width of
// any path segment. Boundary contact counts, as for ground cover.
export function footprintTouchesPath(corners, path, width) {
  if (!Array.isArray(corners) || corners.length < 3) {
    return false;
  }
  if (!Array.isArray(path) || path.length < 2 || !(width > 0)) {
    return false;
  }
  const radius = width / 2;
  for (const vertex of path) {
    if (locatePoint(corners, vertex) !== 'outside') {
      return true;
    }
  }
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    for (let j = 0; j < path.length - 1; j += 1) {
      const c = path[j];
      const d = path[j + 1];
      if (distSegmentToSegment(a, b, c, d) <= radius + EPS) {
        return true;
      }
    }
  }
  return false;
}

// The worst ground cover a footprint ring touches, or 'open' when it touches
// none. Every ground feature the ring touches (boundary contact counts via
// `ringsTouch`, which also covers containment) is ranked, and the worst wins.
export function groundCoverAt(corners, terrainFeatures) {
  let worst = 'open';
  let worstRank = GROUND_RANK.open;
  for (const feature of groundFeaturesOf(terrainFeatures)) {
    const category = feature.category;
    if (!Object.hasOwn(GROUND_RANK, category)) {
      continue;
    }
    if (!ringsTouch(corners, feature.polygon)) {
      continue;
    }
    if (GROUND_RANK[category] > worstRank) {
      worst = category;
      worstRank = GROUND_RANK[category];
    }
  }
  return worst;
}

// True when the footprint touches a road corridor.
export function footprintOnRoad(corners, terrainFeatures) {
  for (const road of linearFeaturesOf(terrainFeatures, 'road')) {
    if (footprintTouchesPath(corners, road.path, road.width)) {
      return true;
    }
  }
  return false;
}

// Every river feature a footprint ring touches, in document order.
export function riversTouching(corners, terrainFeatures) {
  const touched = [];
  for (const river of linearFeaturesOf(terrainFeatures, 'river')) {
    if (footprintTouchesPath(corners, river.path, river.width)) {
      touched.push(river);
    }
  }
  return touched;
}

// The movement cost factor for a footprint: the worst-cover factor, or the
// road factor when the unit is in column and the footprint touches a road
// (the road can only help, never hurt, and never applies on water).
// Water has no factor: it forbids.
export function terrainFactorAt(corners, files, terrainFeatures, params) {
  const terrain = terrainOf(params);
  const cover = groundCoverAt(corners, terrainFeatures);
  let factor = 1;
  if (cover === 'rough') {
    factor = terrain.roughFactor;
  } else if (cover === 'forest' || cover === 'settlement') {
    factor = terrain.forestFactor;
  } else if (cover === 'water') {
    factor = Number.POSITIVE_INFINITY;
  }
  if (
    cover !== 'water'
    && Number.isInteger(files)
    && files >= 1
    && files <= terrain.columnMaxFiles
    && footprintOnRoad(corners, terrainFeatures)
    && terrain.roadFactor < factor
  ) {
    factor = terrain.roadFactor;
  }
  return { cover, factor };
}

// Movement allowance in metres for the unit's troop type on open ground,
// divided by the factor at the unit's current footprint when terrain is
// supplied. Unknown troop types have no allowance. The river fee is per move
// and cannot be expressed as an allowance, so it is excluded here; water
// leaves no allowance at all. Never throws.
//
// Called as `movementAllowanceM(unit, params)` for the open-ground allowance
// (as before), or as `movementAllowanceM(unit, params, terrainFeatures)` for
// the terrain-adjusted allowance shown in the available actions. The unit
// must carry its current `position` and `facing` for the adjustment; without
// them the open-ground allowance is returned.
export function movementAllowanceM(unit, params, terrainFeatures = null) {
  const value = params?.allowanceM?.[unit?.troopType];
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (terrainFeatures === null || terrainFeatures === undefined) {
    return value;
  }
  const position = unit?.position;
  const facing = unit?.facing;
  if (!isFinitePoint(position) || !Number.isFinite(facing)) {
    return value;
  }
  let corners = null;
  try {
    corners = footprintAt(unit, { ...position }, facing).corners;
  } catch {
    return value;
  }
  const { cover, factor } = terrainFactorAt(corners, unit?.files, terrainFeatures, params);
  if (cover === 'water' || !(factor > 0) || !Number.isFinite(factor)) {
    return 0;
  }
  return round1(value / factor);
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
// parameters, the battlefield `{ width, height }`, every other unit as
// `{ id, side, corners }` at its simulated footprint, and the scenario's
// `terrainFeatures` (ground cover areas and linear river/road features;
// elevation is ignored). Pure: nothing is changed.
export function validateMoveOnField({
  unit,
  from,
  legs,
  params,
  battlefield,
  others,
  terrainFeatures = [],
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
  // the rejection details. March billing accumulates per 1 m subsegment at
  // the factor of the footprint centred on that subsegment's midpoint; wheel
  // billing uses the factor at the footprint before the rotation. The
  // starting pose is validated history, so it takes part in no collision
  // check: a unit deployed touching a friend stays free to march away.
  // Water, unlike units, is checked on the full sweep including hulls over
  // the starting pose (playability already refuses a setup in water).
  const terrain = terrainOf(params);
  const features = Array.isArray(terrainFeatures) ? terrainFeatures : [];
  let position = roundPoint(from.position);
  let facing = normalizeFacing(round1(from.facing));
  let turnCost = 0;
  let moveCost = 0;
  const startCorners = footprintAt(unit, position, facing).corners;
  const samples = [];
  const hulls = [];
  // River fees: the ids of the river features the sweep touches, across all
  // legs. Each river crossed adds `riverCostM` once per move, so splitting
  // one crossing across several legs still pays a single crossing. Added to
  // the billed total after the sweep checks so a river crossing is never
  // truncated.
  const riversCrossed = new Set();
  for (const leg of normalised.legs) {
    if (leg.face !== null) {
      const delta = signedAngleDiff(facing, leg.face);
      if (Math.abs(delta) > EPS) {
        const { factor } = terrainFactorAt(
          footprintAt(unit, position, facing).corners,
          unit?.files,
          features,
          params,
        );
        const wheelRate = Number.isFinite(factor) ? factor : Number.POSITIVE_INFINITY;
        turnCost += frontage * Math.abs(delta) * DEG * wheelFactor * wheelRate;
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
        const strides = Math.max(1, Math.ceil(distance / TRANSIT_SAMPLE_M));
        const stepLength = distance / strides;
        for (let stride = 1; stride <= strides; stride += 1) {
          const midpoint = {
            x: position.x + ((leg.to.x - position.x) * (stride - 0.5)) / strides,
            y: position.y + ((leg.to.y - position.y) * (stride - 0.5)) / strides,
          };
          const midCorners = footprintAt(unit, midpoint, facing).corners;
          const { factor } = terrainFactorAt(midCorners, unit?.files, features, params);
          const billedRate = rate > 0 ? rate : 0;
          moveCost += billedRate > 0 && Number.isFinite(factor)
            ? stepLength / billedRate * factor
            : Number.POSITIVE_INFINITY;
        }
        const start = footprintAt(unit, position, facing).corners;
        const end = footprintAt(unit, leg.to, facing).corners;
        const hullCorners = convexHull([...start, ...end]);
        hulls.push({
          corners: hullCorners,
          at: { ...position },
        });
        for (const ring of [hullCorners, start, end]) {
          for (const river of riversTouching(ring, features)) {
            riversCrossed.add(river.id);
          }
        }
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
  moveCost += riversCrossed.size * terrain.riverCostM;
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

  // 4. The swept footprint touches no water. Transit poses, hulls, and the
  // resting footprint are checked in sweep order against the water areas in
  // document order; the starting pose is validated history and never forbids.
  const waters = groundFeaturesOf(features).filter((feature) => feature.category === 'water');
  const forbid = (featureId, at) => fail(
    'forbidden_ground',
    { unitId, featureId, groundCover: 'water', at: roundPoint(at) },
    `Order ${orderIndex}: unit "${unitId}" would enter forbidden ground ` +
      `(water feature "${featureId}") at (${round1(at.x)}, ${round1(at.y)}).`,
  );
  for (const entry of transit) {
    for (const water of waters) {
      if (ringsTouch(entry.corners, water.polygon)) {
        return forbid(water.id, entry.at);
      }
    }
  }
  for (const entry of hulls) {
    for (const water of waters) {
      if (ringsTouch(entry.corners, water.polygon)) {
        return forbid(water.id, entry.at);
      }
    }
  }
  for (const water of waters) {
    if (ringsTouch(finalCorners, water.polygon)) {
      return forbid(water.id, position);
    }
  }

  // 5. The billed distance fits the allowance, billed to the stored 0.1 m:
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

  // 6. The resting footprint never ends in contact with an enemy: boundary
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
