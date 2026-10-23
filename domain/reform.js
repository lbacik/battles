// PÓLIS engine — Reform orders: change formation in place (framework-free).
//
// The manoeuvre slice of the framework-free engine package: a unit changes
// its files and/or spacing without moving, anchored at the front midpoint.
// A Reform takes the whole turn. This module imports only the plane geometry
// helpers and the movement footprint helpers — no React, no Next.js, no DOM,
// no Node APIs — so it runs unchanged in the browser, in Node unit tests,
// and in any future shell.
//
// Mechanics (decisions #6 item 10, #7 item 5):
//
// - A Reform names `{ files?, lateralInterval?, rankDepth? }` in metres. Every
//   field left out keeps the unit's current value; at least one field must be
//   present. The position and facing never change: the footprint is anchored
//   at the front midpoint, so widening grows symmetrically about it and
//   deepening grows backwards from it.
// - An Engaged unit cannot reform. Permission is gated by the turn contract
//   (`./turn.js` only lets an engaged unit Hold or Withdraw); this module
//   checks the geometry of the new footprint only.
// - There is no movement billing: the reform takes the whole turn and is
//   never truncated. The new footprint must still be valid.
//
// Checks, in order (the first failure wins, so each rejection is
// unambiguous), mirroring the resting-state checks of Move (`./movement.js`):
//
// 1. `invalid_formation`: no field is present; files is not an integer in
//    1..soldiers; a spacing is not a positive finite number (after snapping
//    to the stored 0.1 m precision); a spacing leaves the troop type's
//    permitted range; or the troop type is unknown. `details` names the
//    reason (`no-change`, `bad-files`, `bad-spacing`, `spacing-out-of-range`,
//    or `unknown-troop-type`).
// 2. `battlefield_edge`: a corner of the new footprint leaves the
//    battlefield. `details.at` is the first footprint corner found outside.
// 3. `collision`: the new footprint touches another unit. Overlap with anyone
//    collides; a mere touch with a friend collides too (the reform must clear
//    its neighbours, even ones the old footprint touched).
// 4. `forbidden_ground`: the new footprint touches water. `details` carries
//    the water `featureId`, `groundCover: 'water'`, and the unit position.
// 5. `contact_with_enemy`: the new footprint merely touches an enemy
//    footprint. `details` names the enemy `withUnitId`.
//
// An accepted plan returns a deterministic preview — the footprint after the
// Movement phase with positions rounded to 0.1 m — plus the reformed
// formation. Validation simulates on snapped values and commits exactly the
// preview, so re-validating a verdict can never disagree with it.

import {
  isFinitePoint,
  polygonsOverlapPositiveArea,
  ringsTouch,
  round1,
} from './geometry.js';
import { footprintAt, footprintPreview } from './movement.js';
import { TROOP_TYPE_CATALOGUE } from './polis-classical.js';

function roundPoint(point) {
  return { x: round1(point.x), y: round1(point.y) };
}

// Resolve the reformed formation from the unit and the raw reform parameters
// (snapped to the stored 0.1 m precision), or return `{ error: reason }` for
// the `invalid_formation` rejection. Snapping up front keeps validation, the
// preview, and resolution on exactly the same values.
export function normalizeReform(unit, reform) {
  if (!reform || typeof reform !== 'object' || Array.isArray(reform)) {
    return { error: 'bad-reform' };
  }
  const wantsFiles = reform.files !== undefined && reform.files !== null;
  const wantsLateral = reform.lateralInterval !== undefined && reform.lateralInterval !== null;
  const wantsDepth = reform.rankDepth !== undefined && reform.rankDepth !== null;
  if (!wantsFiles && !wantsLateral && !wantsDepth) {
    return { error: 'no-change' };
  }
  let files = unit?.files;
  if (wantsFiles) {
    if (!Number.isInteger(reform.files)) {
      return { error: 'bad-files' };
    }
    files = reform.files;
  }
  const soldiers = unit?.soldiers;
  if (!Number.isInteger(files) || !Number.isInteger(soldiers) || soldiers < 1) {
    return { error: 'bad-files' };
  }
  if (files < 1 || files > soldiers) {
    return { error: 'bad-files' };
  }
  let lateralInterval = unit?.lateralInterval;
  if (wantsLateral) {
    if (!Number.isFinite(reform.lateralInterval)) {
      return { error: 'bad-spacing' };
    }
    lateralInterval = round1(reform.lateralInterval);
  }
  let rankDepth = unit?.rankDepth;
  if (wantsDepth) {
    if (!Number.isFinite(reform.rankDepth)) {
      return { error: 'bad-spacing' };
    }
    rankDepth = round1(reform.rankDepth);
  }
  if (!Number.isFinite(lateralInterval) || lateralInterval <= 0
    || !Number.isFinite(rankDepth) || rankDepth <= 0) {
    return { error: 'bad-spacing' };
  }
  const entry = TROOP_TYPE_CATALOGUE[unit?.troopType];
  if (!entry) {
    return { error: 'unknown-troop-type' };
  }
  for (const [field, value] of [['lateralInterval', lateralInterval], ['rankDepth', rankDepth]]) {
    const range = entry.permittedRanges[field];
    if (value < range.min || value > range.max) {
      return { error: 'spacing-out-of-range', field, value, range: { ...range } };
    }
  }
  return { formation: { files, lateralInterval, rankDepth } };
}

// Validate one Reform against the field: the unit (with its current files,
// spacings, soldiers, position, and facing), the raw reform parameters, the
// battlefield `{ width, height }`, every other unit as `{ id, side, corners }`
// at its simulated footprint, and the scenario's `terrainFeatures`. Pure:
// nothing is changed.
export function validateReformOnField({
  unit,
  reform,
  battlefield,
  others,
  terrainFeatures = [],
  orderIndex = 0,
}) {
  const unitId = unit?.id ?? null;
  const fail = (code, details, message) => ({ ok: false, code, details, message });

  const normalised = normalizeReform(unit, reform);
  if (normalised.error) {
    const details = { unitId, reason: normalised.error };
    if (normalised.field !== undefined) {
      details.field = normalised.field;
      details.value = normalised.value;
      details.range = normalised.range;
    }
    return fail(
      'invalid_formation',
      details,
      `Order ${orderIndex}: unit "${unitId}" has an invalid Reform (${normalised.error}).`,
    );
  }
  const { formation } = normalised;
  const template = {
    soldiers: unit.soldiers,
    files: formation.files,
    lateralInterval: formation.lateralInterval,
    rankDepth: formation.rankDepth,
  };
  if (!isFinitePoint(unit?.position) || !Number.isFinite(unit?.facing)) {
    return fail(
      'invalid_formation',
      { unitId, reason: 'bad-pose' },
      `Order ${orderIndex}: unit "${unitId}" has no position to reform at.`,
    );
  }
  const position = roundPoint(unit.position);
  const corners = footprintAt(template, position, unit.facing).corners;
  const lineup = others || [];
  const touches = (other) => ringsTouch(corners, other.corners);
  const overlaps = (other) => polygonsOverlapPositiveArea(corners, other.corners);
  const collide = (other) => fail(
    'collision',
    { unitId, withUnitId: other.id, at: { ...position } },
    `Order ${orderIndex}: unit "${unitId}" would collide with unit "${other.id}" ` +
      `at (${round1(position.x)}, ${round1(position.y)}).`,
  );

  // The new footprint stays inside the battlefield.
  const width = battlefield?.width;
  const height = battlefield?.height;
  const outside = (point) => !Number.isFinite(point?.x)
    || !Number.isFinite(point?.y)
    || point.x < -1e-9
    || point.x > width + 1e-9
    || point.y < -1e-9
    || point.y > height + 1e-9;
  const exit = corners.find(outside);
  if (exit) {
    return fail(
      'battlefield_edge',
      { unitId, at: roundPoint(exit) },
      `Order ${orderIndex}: unit "${unitId}" would leave the battlefield at ` +
        `(${round1(exit.x)}, ${round1(exit.y)}).`,
    );
  }

  // The new footprint touches no other unit. Overlap with anyone collides; a
  // mere touch with a friend collides while a mere touch with an enemy is
  // reported as `contact_with_enemy`, exactly as a Move resting place would.
  for (const other of lineup) {
    if (overlaps(other)) {
      return collide(other);
    }
    if (touches(other)) {
      if (other.side !== unit.side) {
        return fail(
          'contact_with_enemy',
          { unitId, withUnitId: other.id },
          `Order ${orderIndex}: unit "${unitId}" would end in contact with enemy unit "${other.id}".`,
        );
      }
      return collide(other);
    }
  }

  // The new footprint touches no water.
  const features = Array.isArray(terrainFeatures) ? terrainFeatures : [];
  const waters = features.filter((feature) => feature && feature.kind === 'ground'
    && feature.category === 'water'
    && Array.isArray(feature.polygon) && feature.polygon.length >= 3);
  for (const water of waters) {
    if (ringsTouch(corners, water.polygon)) {
      return fail(
        'forbidden_ground',
        { unitId, featureId: water.id, groundCover: 'water', at: { ...position } },
        `Order ${orderIndex}: unit "${unitId}" would enter forbidden ground ` +
          `(water feature "${water.id}") at (${round1(position.x)}, ${round1(position.y)}).`,
      );
    }
  }

  return {
    ok: true,
    preview: footprintPreview(template, position, unit.facing),
    formation,
  };
}
