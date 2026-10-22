// PÓLIS engine — Withdraw orders: an Engaged unit breaks contact (framework-free).
//
// The manoeuvre slice of the framework-free engine package: a unit that is
// Engaged moves straight back by a set distance, without turning, and breaks
// contact with every enemy it was engaged with. This module imports only the
// plane geometry helpers and the movement geometry — no React, no Next.js,
// no DOM, no Node APIs — so it runs unchanged in the browser, in Node unit
// tests, and in any future shell.
//
// Mechanics (decisions #6 item 13, #7 item 5):
//
// - A Withdraw carries no parameters: its direction (straight back from the
//   current facing) and its distance are fixed by the ruleset (`withdraw`
//   parameters: `distanceM`, the set step back, and `rateFactor`, the reduced
//   rate the step bills at).
// - Only an Engaged unit may withdraw. Permission is gated by the turn
//   contract (`./turn.js` refuses Withdraw for any other unit); this module
//   checks the path back only. The caller names the enemies being broken in
//   `brokenIds`: contacts already held at the start of the path are the
//   coming break, not a collision.
// - The unit does not turn: the facing is unchanged and the footprint
//   translates straight back. The billed distance is the set step at the
//   reduced rate (`distanceM / rateFactor`), factored per 1 m subsegment by
//   the terrain at that subsegment's midpoint exactly as for Move, plus the
//   river fee per river feature touched. The enemy neither pursues nor gets a
//   free attack: no enemy footprint moves.
// - After withdrawing the unit tests cohesion by chance at resolution time
//   (see `./turn.js`): the draw is recorded in the events and failure costs
//   cohesion. Validation never draws — the preview is deterministic.
//
// Checks, in order (the first failure wins, so each rejection is
// unambiguous), mirroring the swept-footprint checks of Move:
//
// 1. `invalid_withdraw`: the unit has no engaged enemies to break from or no
//    pose to withdraw from. `details` names the reason (`not-engaged` or
//    `bad-pose`).
// 2. `battlefield_edge`: the swept footprint leaves the battlefield.
// 3. `collision`: the swept footprint touches another unit. Transit poses and
//    hull overlaps collide outright; a hull that merely touches is attributed
//    first — pre-existing adjacency from the starting pose, the resting pose,
//    and any contact being broken is not a transit collision. An overlap with
//    anyone, broken enemies included, still collides.
// 4. `forbidden_ground`: the swept footprint touches water.
// 5. `out_of_reach`: the billed distance exceeds the allowance.
// 6. `contact_with_enemy`: the resting footprint merely touches an enemy
//    other than the ones being broken.
//
// An accepted plan returns a deterministic preview — the footprint after the
// Movement phase with positions rounded to 0.1 m — plus the billed movement
// and the broken contacts. Validation simulates on snapped poses and commits
// exactly the preview, so re-validating a verdict can never disagree with it.

import {
  EPS,
  isFinitePoint,
  polygonsOverlapPositiveArea,
  ringsTouch,
  round1,
} from './geometry.js';
import {
  convexHull,
  footprintAt,
  footprintPreview,
  groundFeaturesOf,
  movementAllowanceM,
  riversTouching,
  terrainFactorAt,
  terrainOf,
} from './movement.js';

const TRANSIT_SAMPLE_M = 1;

function roundPoint(point) {
  return { x: round1(point.x), y: round1(point.y) };
}

// The default withdraw parameters when the battle snapshot carries no
// `withdraw` block. The Engine II gate owns the real values; the snapshot
// mirrors them exactly like the movement parameters.
export const DEFAULT_WITHDRAW_DISTANCE_M = 20;
export const DEFAULT_WITHDRAW_RATE_FACTOR = 0.5;
export const DEFAULT_WITHDRAW_COHESION_PASS_CHANCE = 0.5;

// Accepts either the outer parameters shape (`{ withdraw: {...} }`) or the
// inner withdraw block itself (which is what the turn contract passes), so a
// customised `distanceM`/`rateFactor`/`cohesionPassChance` is honoured
// wherever it is configured. Anything else falls back to the defaults.
export function withdrawParamsOf(params) {
  const inner = params && typeof params === 'object' ? params : {};
  const raw = inner.withdraw && typeof inner.withdraw === 'object' ? inner.withdraw : inner;
  const distanceM = Number.isFinite(raw.distanceM) && raw.distanceM > 0
    ? raw.distanceM
    : DEFAULT_WITHDRAW_DISTANCE_M;
  const rateFactor = Number.isFinite(raw.rateFactor) && raw.rateFactor > 0
    ? raw.rateFactor
    : DEFAULT_WITHDRAW_RATE_FACTOR;
  const cohesionPassChance = Number.isFinite(raw.cohesionPassChance)
    && raw.cohesionPassChance >= 0 && raw.cohesionPassChance <= 1
    ? raw.cohesionPassChance
    : DEFAULT_WITHDRAW_COHESION_PASS_CHANCE;
  return { distanceM, rateFactor, cohesionPassChance };
}

// The pose straight back from `from` by `distanceM`: the facing is unchanged
// and the front midpoint steps backwards along the facing, snapped to the
// stored 0.1 m precision.
export function withdrawDestination(from, distanceM) {
  const radians = (from.facing * Math.PI) / 180;
  return roundPoint({
    x: from.position.x - Math.sin(radians) * distanceM,
    y: from.position.y - Math.cos(radians) * distanceM,
  });
}

// Validate one Withdraw against the field: the withdrawing unit's footprint
// template, its current `{ position, facing }`, the ids of the engaged
// enemies being broken, the ruleset movement and withdraw parameters, the
// battlefield `{ width, height }`, every other unit as `{ id, side, corners }`
// at its simulated footprint, and the scenario's `terrainFeatures`. Pure:
// nothing is changed.
export function validateWithdrawOnField({
  unit,
  from,
  brokenIds = [],
  params,
  withdrawParams,
  battlefield,
  others,
  terrainFeatures = [],
  orderIndex = 0,
}) {
  const unitId = unit?.id ?? null;
  const fail = (code, details, message) => ({ ok: false, code, details, message });
  const broken = new Set(Array.isArray(brokenIds) ? brokenIds : []);

  if (broken.size === 0) {
    return fail(
      'invalid_withdraw',
      { unitId, reason: 'not-engaged' },
      `Order ${orderIndex}: unit "${unitId}" is not engaged and cannot withdraw.`,
    );
  }
  if (!isFinitePoint(from?.position) || !Number.isFinite(from?.facing)) {
    return fail(
      'invalid_withdraw',
      { unitId, reason: 'bad-pose' },
      `Order ${orderIndex}: unit "${unitId}" has no position to withdraw from.`,
    );
  }

  const movement = params && typeof params === 'object' ? params : {};
  const { distanceM, rateFactor } = withdrawParamsOf(withdrawParams ?? movement);
  const terrain = terrainOf(movement);
  const features = Array.isArray(terrainFeatures) ? terrainFeatures : [];

  const position = roundPoint(from.position);
  const { facing } = from;
  const end = withdrawDestination({ position, facing }, distanceM);
  const step = Math.hypot(end.x - position.x, end.y - position.y);

  // Simulate the straight step back on snapped poses: march intermediates
  // every 1 m plus the exact swept hull, each with the mover's front-midpoint
  // position (`at`). March billing accumulates per 1 m subsegment at the
  // terrain factor of the footprint centred on that subsegment's midpoint, at
  // the reduced withdraw rate. The starting pose is validated history, so it
  // takes part in no collision check.
  let moveCost = 0;
  const startCorners = footprintAt(unit, position, facing).corners;
  const samples = [];
  const hulls = [];
  const riversCrossed = new Set();
  if (step > EPS) {
    const strides = Math.max(1, Math.ceil(step / TRANSIT_SAMPLE_M));
    const stepLength = step / strides;
    for (let stride = 1; stride <= strides; stride += 1) {
      const midpoint = {
        x: position.x + ((end.x - position.x) * (stride - 0.5)) / strides,
        y: position.y + ((end.y - position.y) * (stride - 0.5)) / strides,
      };
      const midCorners = footprintAt(unit, midpoint, facing).corners;
      const { factor } = terrainFactorAt(midCorners, unit?.files, features, movement);
      moveCost += Number.isFinite(factor)
        ? stepLength / rateFactor * factor
        : Number.POSITIVE_INFINITY;
    }
    const start = footprintAt(unit, position, facing).corners;
    const resting = footprintAt(unit, end, facing).corners;
    hulls.push({ corners: convexHull([...start, ...resting]), at: { ...position } });
    for (const ring of [hulls[0].corners, start, resting]) {
      for (const river of riversTouching(ring, features)) {
        riversCrossed.add(river.id);
      }
    }
    for (let stride = 1; stride < strides; stride += 1) {
      const waypoint = roundPoint({
        x: position.x + ((end.x - position.x) * stride) / strides,
        y: position.y + ((end.y - position.y) * stride) / strides,
      });
      samples.push({
        pose: { position: { ...waypoint }, facing },
        corners: footprintAt(unit, waypoint, facing).corners,
        at: { ...waypoint },
      });
    }
    samples.push({
      pose: { position: { ...end }, facing },
      corners: resting,
      at: { ...end },
    });
  }
  moveCost += riversCrossed.size * terrain.riverCostM;
  const finalCorners = footprintAt(unit, end, facing).corners;
  const samePose = (a, b) => a.position.x === b.position.x
    && a.position.y === b.position.y
    && a.facing === b.facing;
  const finalPose = { position: { ...end }, facing };
  const transit = samples.filter((entry) => !samePose(entry.pose, finalPose));
  const lineup = others || [];
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

  // The swept footprint touches no other unit — except that contact already
  // held at the start of the path is the coming break, not a collision. An
  // overlap with anyone, broken enemies included, still collides.
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
  const isBroken = (other) => broken.has(other.id);
  for (const entry of transit) {
    for (const other of lineup) {
      if (!touches(entry.corners, other)) {
        continue;
      }
      if (!isBroken(other)) {
        return collide(other, entry.at, 'on its path');
      }
      if (overlaps(entry.corners, other)) {
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
        && !isBroken(other)
        && !startAdjacent.has(other.id)
        && !(finalTouches(other) && !finalOverlaps(other))) {
        return collide(other, entry.at, 'on its path');
      }
    }
  }

  // The swept footprint touches no water.
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
      return forbid(water.id, end);
    }
  }

  // The billed distance fits the allowance, billed to the stored 0.1 m.
  const requiredM = round1(moveCost);
  const availableM = movementAllowanceM(unit, movement);
  if (requiredM > availableM) {
    return fail(
      'out_of_reach',
      { unitId, availableM, requiredM, shortfallM: round1(requiredM - availableM) },
      `Order ${orderIndex}: unit "${unitId}" needs ${requiredM} m but has ${availableM} m ` +
        `(shortfall ${round1(requiredM - availableM)} m).`,
    );
  }

  // The resting footprint ends clear of everyone else. A resting touch with a
  // broken enemy is the contact just left, not a collision; any other resting
  // touch is classified exactly as Move would classify it.
  for (const other of lineup) {
    if (overlaps(finalCorners, other)) {
      return collide(other, end, 'at its resting place');
    }
    if (touches(finalCorners, other) && !isBroken(other)) {
      if (other.side !== unit.side) {
        return fail(
          'contact_with_enemy',
          { unitId, withUnitId: other.id },
          `Order ${orderIndex}: unit "${unitId}" would end in contact with enemy unit "${other.id}".`,
        );
      }
      return collide(other, end, 'at its resting place');
    }
  }

  return {
    ok: true,
    preview: footprintPreview(unit, end, facing),
    requiredM,
    availableM,
    distanceM,
    brokeContactWith: [...broken],
  };
}
