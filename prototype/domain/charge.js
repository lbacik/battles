// PÓLIS engine — Charge orders to flush contact (framework-free).
//
// The contact slice of the framework-free engine package: a unit charges an
// enemy unit so that its front ends flush against one named edge of the
// target, putting both units into the Engaged state. This module imports only
// the plane geometry helpers and the movement geometry — no React, no
// Next.js, no DOM, no Node APIs — so it runs unchanged in the browser, in
// Node unit tests, and in any future shell.
//
// Mechanics (decisions #6 items 9 and 17, #7 item 5):
//
// - A Charge names `{ targetId, edge: front | left | right | rear, approach }`
//   where `approach` holds 0 to 2 legs shaped as in Move. The target must lie
//   within the charger's ±45° front arc at the start of the turn: the bearing
//   from the charger's front midpoint to the target's front midpoint, measured
//   against the charger's facing, decides (`outside_front_arc`).
// - The engine derives the final leg deterministically: the charger turns
//   parallel to the named edge (its front facing into the target, so the two
//   front edges are collinear) and advances straight to flush contact. Its
//   position along the edge is the projection of the charger's front midpoint
//   after the approach legs, clamped onto the edge segment, so contact always
//   exists. There is no engine pathfinding; the named edge makes the intent
//   unambiguous and lets a rejection name it.
// - Reach and collisions are checked as for Move (`./movement.js`): the same
//   wheel cost for the turns (with the terrain factor at the turning
//   footprint), the same full/reduced billing for the marches (per 1 m
//   subsegment at the terrain factor there, plus the river fee per crossing),
//   the same swept-footprint transit checks, the same battlefield edge, the
//   same forbidden ground, and the same allowance. The one difference is the
//   resting place: touching the target is required, not refused. A transit or
//   resting overlap with the target still collides, and any resting touch with
//   anyone else is reported exactly as Move would report it (`collision` with
//   a friend at rest, `contact_with_enemy` with another enemy).
// - Contact records the aspect from the touched edge (front, flank, or rear),
//   the engaged frontage (the common length of the two edges), and the
//   fighting files of each side (engaged frontage ÷ own lateral interval,
//   rounded down, capped at files). Both units become Engaged.
//
// Checks, in order (the first failure wins, so each rejection is
// unambiguous):
//
// 1. `invalid_charge`: the target id, the edge name, or the approach legs are
//    malformed; the target is unknown or not an enemy.
// 2. `outside_front_arc`: the target lies outside the charger's ±45° front
//    arc. `details` names the charger (`unitId`) and the target (`targetId`).
// 3. `battlefield_edge`: as for Move.
// 4. `collision`: as for Move, except a mere touch with the target on the
//    path is the coming contact, not a collision. An overlap with the target
//    still collides, as does any touch with anyone else.
// 5. `forbidden_ground`: as for Move.
// 6. `out_of_reach`: as for Move, billed over the approach legs plus the
//    derived final leg (terrain factors and river fees included).
// 7. `contact_with_enemy`: the resting footprint touches an enemy other than
//    the target (a friend at rest collides, as for Move).
//
// An accepted plan returns a deterministic preview — the footprint at flush
// contact with positions rounded to 0.1 m and the facing normalised — plus
// the contact record. Validation simulates on snapped poses and commits
// exactly the preview, so re-validating a verdict can never disagree with it.

import {
  EPS,
  isFinitePoint,
  polygonsOverlapPositiveArea,
  ringsTouch,
  round1,
} from './geometry.js';
import {
  FORWARD_ARC_DEG,
  convexHull,
  displacementBearing,
  footprintAt,
  frontageOf,
  groundFeaturesOf,
  movementAllowanceM,
  normalizeFacing,
  normalizeLegs,
  riversTouching,
  terrainFactorAt,
  terrainOf,
  signedAngleDiff,
} from './movement.js';

// The named edges a Charge may target, and the aspect each one counts as.
export const CHARGE_EDGES = Object.freeze(['front', 'left', 'right', 'rear']);
export const CHARGE_ASPECT_OF_EDGE = Object.freeze({
  front: 'front',
  left: 'flank',
  right: 'flank',
  rear: 'rear',
});

// The most approach legs a Charge may hold. The final leg is derived, so the
// approach stays below the Move maximum.
export const MAX_APPROACH_LEGS = 2;

// The final contact may sit up to this far off the target edge: rounding the
// contact position to the stored 0.1 m precision can open a sliver gap of at
// most half a decimetre, which still counts as flush. Anything further apart
// is not contact.
const CONTACT_TOUCH_TOL = 0.06;

const DEG = Math.PI / 180;
const SWEEP_STEP_DEG = 2;
const TRANSIT_SAMPLE_M = 1;

function roundPoint(point) {
  return { x: round1(point.x), y: round1(point.y) };
}

// The facing the charger must hold for flush contact with the named edge of
// a target facing `targetFacing`: its front ends up parallel to the edge,
// facing into the target.
export function chargeFinalFacing(targetFacing, edge) {
  switch (edge) {
    case 'front':
      return normalizeFacing(targetFacing + 180);
    case 'rear':
      return normalizeFacing(targetFacing);
    case 'left':
      return normalizeFacing(targetFacing + 90);
    case 'right':
      return normalizeFacing(targetFacing + 270);
    default:
      return null;
  }
}

// The endpoints of the named edge of a footprint at `pose`, in corner order
// direction: front runs front-left to front-right, right runs front-right to
// rear-right, rear runs rear-right to rear-left, left runs rear-left to
// front-left. All four run clockwise as seen from above (the footprint ring
// itself runs counter-clockwise starting at the front-left... each edge is
// returned so that the measured overlap length is direction-independent).
export function targetEdgeEndpoints(template, pose, edge) {
  const corners = footprintAt(template, pose.position, pose.facing).corners;
  switch (edge) {
    case 'front':
      return { a: corners[0], b: corners[1] };
    case 'right':
      return { a: corners[1], b: corners[2] };
    case 'rear':
      return { a: corners[2], b: corners[3] };
    case 'left':
      return { a: corners[3], b: corners[0] };
    default:
      return null;
  }
}

// True when the target position lies within `arcDeg` of the facing held at
// `from` (the ±45° front arc by default). The target is read at its front
// midpoint.
export function inFrontArc(from, targetPosition, arcDeg = FORWARD_ARC_DEG) {
  const bearing = displacementBearing(from.position, targetPosition);
  if (bearing === null) {
    return true;
  }
  return Math.abs(signedAngleDiff(from.facing, bearing)) <= arcDeg + EPS;
}

// Derive the deterministic final leg of a charge: the facing parallel to the
// named edge plus the contact position along it. The contact is the
// projection of the charger's front midpoint (`from.position`, already past
// the approach legs) onto the edge segment, clamped onto the segment so
// contact exists; the facing turns the charger into the target. Positions are
// snapped to the stored 0.1 m precision.
export function deriveChargeContact({ charger, from, target, targetPose, edge }) {
  const finalFacing = chargeFinalFacing(targetPose.facing, edge);
  if (finalFacing === null) {
    return null;
  }
  const segment = targetEdgeEndpoints(target, targetPose, edge);
  if (!segment) {
    return null;
  }
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const length = Math.hypot(dx, dy);
  if (!(length > EPS)) {
    return null;
  }
  const projected = ((from.position.x - segment.a.x) * dx + (from.position.y - segment.a.y) * dy) / length;
  const clamped = Math.min(Math.max(projected, 0), length);
  const position = roundPoint({
    x: segment.a.x + (dx * clamped) / length,
    y: segment.a.y + (dy * clamped) / length,
  });
  const half = frontageOf(charger) / 2;
  const frontageM = round1(
    Math.max(0, Math.min(clamped + half, length) - Math.max(clamped - half, 0)),
  );
  return {
    facing: normalizeFacing(round1(finalFacing)),
    position,
    frontageM,
  };
}

// Fighting files for one side of a contact: the engaged frontage shared with
// the enemy divided by the unit's own lateral interval, rounded down and
// capped at files. A point contact fights no files.
export function fightingFiles(unit, frontageM) {
  if (!Number.isFinite(unit?.lateralInterval) || unit.lateralInterval <= 0) {
    return 0;
  }
  if (!Number.isFinite(unit?.files) || unit.files <= 0) {
    return 0;
  }
  const raw = Math.floor(frontageM / unit.lateralInterval + EPS);
  return Math.max(0, Math.min(unit.files, raw));
}

// Distance between two footprint rings (0 when they touch or overlap).
function ringsGap(a, b) {
  if (ringsTouch(a, b)) {
    return 0;
  }
  // Exact segment-to-segment distance over both rings.
  let best = Number.POSITIVE_INFINITY;
  const distancePointToSegment = (point, s, t) => {
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const squared = dx * dx + dy * dy;
    const projected = squared > EPS
      ? ((point.x - s.x) * dx + (point.y - s.y) * dy) / squared
      : 0;
    const clamped = Math.min(Math.max(projected, 0), 1);
    return Math.hypot(point.x - (s.x + dx * clamped), point.y - (s.y + dy * clamped));
  };
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j += 1) {
      const s = b[j];
      const t = b[(j + 1) % b.length];
      // Segment-to-segment distance via endpoint projections; exact for the
      // near-parallel flush edges this module compares.
      best = Math.min(
        best,
        distancePointToSegment(p, s, t),
        distancePointToSegment(q, s, t),
        distancePointToSegment(s, p, q),
        distancePointToSegment(t, p, q),
      );
    }
  }
  return best;
}

// True when the charger's resting footprint counts as flush contact with the
// target: boundary touch, or a rounding sliver of at most half a decimetre.
function restingTouchesTarget(restingCorners, targetCorners) {
  if (ringsTouch(restingCorners, targetCorners)) {
    return true;
  }
  return ringsGap(restingCorners, targetCorners) <= CONTACT_TOUCH_TOL;
}

// Validate one Charge against the field: the charger's footprint template,
// its current `{ position, facing }`, the target unit and its simulated pose,
// the named edge, the raw approach legs, the ruleset movement parameters,
// the battlefield, and every other unit at its simulated footprint (the
// target included). Pure: nothing is changed.
export function validateChargeOnField({
  unit,
  from,
  target,
  targetPose,
  edge,
  approachLegs,
  params,
  battlefield,
  others,
  terrainFeatures = [],
  orderIndex = 0,
}) {
  const unitId = unit?.id ?? null;
  const fail = (code, details, message) => ({ ok: false, code, details, message });

  if (!target || typeof target !== 'object' || typeof target.id !== 'string') {
    return fail(
      'invalid_charge',
      { unitId, reason: 'unknown-target' },
      `Order ${orderIndex}: unit "${unitId}" charges an unknown target.`,
    );
  }
  if (target.side === unit?.side || target.id === unitId) {
    return fail(
      'invalid_charge',
      { unitId, targetId: target.id, reason: 'not-enemy' },
      `Order ${orderIndex}: unit "${unitId}" cannot charge "${target.id}" (only enemies).`,
    );
  }
  if (!CHARGE_EDGES.includes(edge)) {
    return fail(
      'invalid_charge',
      { unitId, targetId: target.id, reason: 'bad-edge' },
      `Order ${orderIndex}: unit "${unitId}" charges with edge "${String(edge)}" ` +
        `(one of: ${CHARGE_EDGES.join(', ')}).`,
    );
  }
  const approach = approachLegs === undefined || approachLegs === null ? [] : approachLegs;
  // An empty approach is a direct charge: no legs to normalise.
  const normalised = Array.isArray(approach) && approach.length === 0
    ? { legs: [] }
    : normalizeLegs(approach, MAX_APPROACH_LEGS);
  if (normalised.error) {
    return fail(
      'invalid_charge',
      { unitId, targetId: target.id, reason: normalised.error },
      `Order ${orderIndex}: unit "${unitId}" has an invalid charge approach (${normalised.error}).`,
    );
  }
  if (!isFinitePoint(targetPose?.position) || !Number.isFinite(targetPose?.facing)) {
    return fail(
      'invalid_charge',
      { unitId, targetId: target.id, reason: 'bad-target-pose' },
      `Order ${orderIndex}: unit "${unitId}" charges "${target.id}" without a target position.`,
    );
  }

  const startPose = {
    position: roundPoint(from.position),
    facing: normalizeFacing(round1(from.facing)),
  };
  const targetSnapped = {
    position: roundPoint(targetPose.position),
    facing: normalizeFacing(round1(targetPose.facing)),
  };

  const features = Array.isArray(terrainFeatures) ? terrainFeatures : [];
  const arc = Number.isFinite(params?.forwardArcDeg) ? params.forwardArcDeg : FORWARD_ARC_DEG;

  // 2. The target must lie within the charger's front arc at the start of the
  // turn: the bearing from the charger's front midpoint to the target's front
  // midpoint, against the charger's facing.
  if (!inFrontArc(startPose, targetSnapped.position, arc)) {
    return fail(
      'outside_front_arc',
      { unitId, targetId: target.id },
      `Order ${orderIndex}: unit "${unitId}" cannot charge "${target.id}" outside its front arc.`,
    );
  }

  const contact = deriveChargeContact({
    charger: unit,
    from: simulateLegsEnd(unit, startPose, normalised.legs),
    target,
    targetPose: targetSnapped,
    edge,
  });
  if (!contact) {
    return fail(
      'invalid_charge',
      { unitId, targetId: target.id, reason: 'no-contact' },
      `Order ${orderIndex}: unit "${unitId}" cannot reach an edge of "${target.id}".`,
    );
  }

  const legs = [...normalised.legs, { face: contact.facing, to: contact.position }];
  const frontage = frontageOf(unit);
  const wheelFactor = Number.isFinite(params?.wheelFactor) ? params.wheelFactor : 0.5;
  const restricted = Number.isFinite(params?.restrictedRateFactor)
    ? params.restrictedRateFactor
    : 0.5;

  // Simulate the approach plus the derived final leg on snapped poses, as for
  // Move: rotation samples and translation hulls with intermediate march
  // samples, each with the mover's front-midpoint position (`at`). March
  // billing accumulates per 1 m subsegment at the terrain factor of the
  // footprint centred on that subsegment's midpoint; wheel billing uses the
  // factor at the footprint before the rotation. Each river crossed adds
  // `riverCostM` once per charge. The starting pose is validated history and
  // takes part in no collision check.
  const terrain = terrainOf(params);
  let position = { ...startPose.position };
  let facing = startPose.facing;
  let turnCost = 0;
  let moveCost = 0;
  const startCorners = footprintAt(unit, position, facing).corners;
  const samples = [];
  const hulls = [];
  // River fees: the ids of the river features the sweep touches, across all
  // legs. Each river crossed adds `riverCostM` once per charge, so splitting
  // one crossing across several legs still pays a single crossing.
  const riversCrossed = new Set();
  for (const leg of legs) {
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
        hulls.push({ corners: hullCorners, at: { ...position } });
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
  const transit = samples.filter((entry) => !samePose(entry.pose, finalPose));
  const lineup = others || [];
  const byId = new Map(lineup.map((entry) => [entry.id, entry]));
  const targetEntry = byId.get(target.id);
  const targetCorners = targetEntry
    ? targetEntry.corners
    : footprintAt(target, targetSnapped.position, targetSnapped.facing).corners;
  const touches = (corners, other) => ringsTouch(corners, other.corners);
  const overlaps = (corners, other) => polygonsOverlapPositiveArea(corners, other.corners);
  const finalTouches = (other) => touches(finalCorners, other);
  const finalOverlaps = (other) => overlaps(finalCorners, other);

  // The swept footprint stays inside the battlefield.
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

  // The swept footprint touches no other unit — except that a mere touch with
  // the target on the path is the coming contact, not a collision. An
  // overlap with the target still collides, as does any touch with anyone
  // else. Pre-existing adjacency from the starting pose, or the resting pose
  // (classified by the final-state checks below), is not a transit collision.
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
  const isTarget = (other) => other.id === target.id;
  for (const entry of transit) {
    for (const other of lineup) {
      if (!touches(entry.corners, other)) {
        continue;
      }
      if (isTarget(other)) {
        if (overlaps(entry.corners, other)) {
          return collide(other, entry.at, 'on its path');
        }
        continue;
      }
      return collide(other, entry.at, 'on its path');
    }
  }
  for (const entry of hulls) {
    for (const other of lineup) {
      if (overlaps(entry.corners, other)) {
        return collide(other, entry.at, 'on its path');
      }
      if (touches(entry.corners, other)) {
        if (isTarget(other)) {
          continue;
        }
        if (startAdjacent.has(other.id)) {
          continue;
        }
        if (finalTouches(other) && !finalOverlaps(other)) {
          continue;
        }
        return collide(other, entry.at, 'on its path');
      }
    }
  }

  // The swept footprint touches no water. Transit poses, hulls, and the
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

  // The billed distance fits the allowance, billed to the stored 0.1 m.
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

  // The resting footprint ends in flush contact with the target and touches
  // no one else. Overlap with anyone collides; a mere touch with a friend
  // collides while a mere touch with another enemy is reported as
  // `contact_with_enemy`, exactly as Move would report it.
  for (const other of lineup) {
    if (isTarget(other)) {
      continue;
    }
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
  if (polygonsOverlapPositiveArea(finalCorners, targetCorners)) {
    return collide({ id: target.id }, position, 'at its resting place');
  }
  if (!restingTouchesTarget(finalCorners, targetCorners)) {
    return fail(
      'invalid_charge',
      { unitId, targetId: target.id, reason: 'no-contact' },
      `Order ${orderIndex}: unit "${unitId}" would miss "${target.id}".`,
    );
  }

  const aspect = CHARGE_ASPECT_OF_EDGE[edge];
  return {
    ok: true,
    preview: {
      position: { ...position },
      facing,
      corners: finalCorners.map(roundPoint),
    },
    requiredM,
    availableM,
    contact: {
      targetId: target.id,
      edge,
      aspect,
      frontageM: contact.frontageM,
      fightingFiles: fightingFiles(unit, contact.frontageM),
    },
  };
}

// Simulate approach legs on snapped poses and return the end pose, without
// any field checks. Shared by contact derivation so the projection starts
// exactly where the march ends.
function simulateLegsEnd(template, startPose, legs) {
  let position = { ...startPose.position };
  let facing = startPose.facing;
  for (const leg of legs) {
    if (leg.face !== null) {
      facing = normalizeFacing(leg.face);
    }
    if (leg.to !== null) {
      position = { x: leg.to.x, y: leg.to.y };
    }
  }
  void template;
  return { position, facing };
}

// Suggest charge targets for a charger at its turn-start pose: every enemy
// unit within the front arc, each with the edge facing the charger (the edge
// whose outward normal most opposes the bearing from the target to the
// charger), its aspect, and the distance in metres. Hints, not guarantees:
// earlier orders in the same turn can still block the charge.
export function chargeCandidatesFor(charger, chargerPose, enemies, arcDeg = FORWARD_ARC_DEG) {
  const candidates = [];
  for (const enemy of enemies || []) {
    if (!enemy || typeof enemy.id !== 'string') {
      continue;
    }
    if (!isFinitePoint(enemy.position) || !Number.isFinite(enemy.facing)) {
      continue;
    }
    if (!inFrontArc(chargerPose, enemy.position, arcDeg)) {
      continue;
    }
    const bearing = displacementBearing(enemy.position, chargerPose.position);
    const outward = {
      front: normalizeFacing(enemy.facing),
      right: normalizeFacing(enemy.facing + 90),
      rear: normalizeFacing(enemy.facing + 180),
      left: normalizeFacing(enemy.facing + 270),
    };
    let edge = 'front';
    let best = Number.POSITIVE_INFINITY;
    for (const name of CHARGE_EDGES) {
      const gap = bearing === null
        ? 0
        : Math.abs(signedAngleDiff(outward[name], bearing));
      if (gap < best) {
        best = gap;
        edge = name;
      }
    }
    candidates.push({
      targetId: enemy.id,
      edge,
      aspect: CHARGE_ASPECT_OF_EDGE[edge],
      distanceM: round1(Math.hypot(
        chargerPose.position.x - enemy.position.x,
        chargerPose.position.y - enemy.position.y,
      )),
    });
  }
  return candidates;
}
