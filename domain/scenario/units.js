// PÓLIS scenario model — unit editing, picking, and placement (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

import {
  deriveFootprint,
  locatePoint,
  polygonsOverlapPositiveArea,
  pointsWithinBounds,
  round1,
  shrinkFootprint,
} from '../geometry.js';

import { MAX_SPACING_M, cloneScenario, generateId, isNonEmptyString } from './document.js';

import { roundScenarioToTenth } from './rounding.js';

import { validateScenario } from './validation.js';

import { defaultFacingForSide, suggestUnitName, unitFootprint } from './ruleset.js';

// --- Unit placement and rotation on the map (framework-free) -----------------
// The editor moves and rotates units by proposing a geometry patch and
// committing it only when structural validation stays silent, so a refused
// drop or rotation never touches the document. These helpers are pure and
// framework-free so the browser editor and the Node unit tests share them.

// Screen-pixel tolerance for battlefield selection, applied by the editor:
// the caller converts it to metres (pixels x metres-per-pixel) for the hit
// test below.
export const UNIT_PICK_TOLERANCE_PX = 8;

// Snap step for rotation-handle drags, in degrees.
export const FACING_SNAP_DEG = 15;

// Wrap a facing into the stored compass range [0, 360).
export function normalizeFacing(facing) {
  const value = Number(facing);
  if (!Number.isFinite(value)) {
    return 0;
  }
  const wrapped = ((value % 360) + 360) % 360;
  // Rounding noise can produce 360 for bearings like 359.9999999; it is 0.
  return wrapped >= 360 - 1e-9 ? 0 : wrapped;
}

// Snap a facing to the nearest multiple of `snap` degrees (15 by default).
export function snapFacing(facing, snap = FACING_SNAP_DEG) {
  const step = Number(snap);
  if (!Number.isFinite(step) || step <= 0 || !Number.isFinite(Number(facing))) {
    return normalizeFacing(facing);
  }
  return normalizeFacing(Math.round(Number(facing) / step) * step);
}

function distToSegmentSquared(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (!(lengthSquared > 0)) {
    const ex = point.x - a.x;
    const ey = point.y - a.y;
    return ex * ex + ey * ey;
  }
  const t = Math.min(
    1,
    Math.max(0, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared),
  );
  const ex = point.x - (a.x + t * dx);
  const ey = point.y - (a.y + t * dy);
  return ex * ex + ey * ey;
}

// The derived footprint corners of a unit, or null when the unit cannot
// derive one. Never throws.
export function footprintCorners(unit) {
  try {
    const derived = deriveFootprint(unit);
    if (derived && Array.isArray(derived.corners) && derived.corners.length === 4) {
      return derived.corners;
    }
    return null;
  } catch {
    return null;
  }
}

// True when a battlefield point hits a unit's real footprint: inside it, on
// its boundary, or within `toleranceM` of its edges (the editor passes the
// screen-pixel tolerance converted to metres). Never throws.
export function footprintHitTest(unit, point, toleranceM = 0) {
  const corners = footprintCorners(unit);
  if (!corners) {
    return false;
  }
  if (!point || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
    return false;
  }
  if (locatePoint(corners, point) !== 'outside') {
    return true;
  }
  const tolerance = Number(toleranceM);
  if (!(tolerance > 0)) {
    return false;
  }
  const squared = tolerance * tolerance;
  for (let i = 0; i < corners.length; i += 1) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    if (distToSegmentSquared(point, a, b) <= squared) {
      return true;
    }
  }
  return false;
}

// The id of the topmost unit whose real footprint is hit by a battlefield
// point, or null. Units render in document order, so the last matching unit
// wins; units without an identifier never match, so selection falls through
// to the unit below. Never throws.
export function pickUnitIdAtPoint(document, point, toleranceM = 0) {
  const units = Array.isArray(document?.units) ? document.units : [];
  for (let i = units.length - 1; i >= 0; i -= 1) {
    const unit = units[i];
    if (!unit || typeof unit !== 'object' || !unit.id) {
      continue;
    }
    if (footprintHitTest(unit, point, toleranceM)) {
      return unit.id;
    }
  }
  return null;
}

// Every unit whose footprint would fall outside the given bounds, in document
// order: [{ index, id, name }]. Pure; invalid dimensions block everything.
export function unitsBlockingResize(document, width, height) {
  const nextWidth = round1(Number(width));
  const nextHeight = round1(Number(height));
  if (!Number.isFinite(nextWidth) || nextWidth <= 0 || !Number.isFinite(nextHeight) || nextHeight <= 0) {
    return [];
  }
  const blockers = [];
  const units = Array.isArray(document?.units) ? document.units : [];
  units.forEach((unit, index) => {
    if (!unit || typeof unit !== 'object') {
      return;
    }
    if (
      !Number.isFinite(unit.lateralInterval) ||
      !Number.isFinite(unit.rankDepth) ||
      !Number.isFinite(unit.position?.x) ||
      !Number.isFinite(unit.position?.y) ||
      !Number.isFinite(unit.facing)
    ) {
      return;
    }
    const corners = footprintCorners(unit);
    if (!corners) {
      return;
    }
    if (!pointsWithinBounds(corners, nextWidth, nextHeight)) {
      blockers.push({ index, id: unit.id, name: unit.name });
    }
  });
  return blockers;
}

// Propose moving and/or rotating a unit (`patch` holds an optional
// `position` { x, y } and/or a `facing` in degrees). Positions round to the
// stored 0.1 m precision and facings wrap into [0, 360), exactly as stored.
// Returns { ok: true, document, errors: [], conflictIds: [] } when the
// patched document stays structurally valid, otherwise
// { ok: false, document: null, errors, conflictIds }: the errors naming the
// edited unit, and the edited unit plus every overlap partner to highlight.
// Pure: the input is never mutated.
export function proposeUnitPatch(document, unitId, patch = {}) {
  const units = Array.isArray(document?.units) ? document.units : [];
  const index = units.findIndex((unit) => unit?.id === unitId);
  if (index < 0) {
    return { ok: false, document: null, errors: ['Unit not found.'], conflictIds: [] };
  }
  const editedId = units[index]?.id;
  const copy = cloneScenario(document);
  const target = copy.units[index];
  if (patch.position !== undefined) {
    const x = Number(patch.position?.x);
    const y = Number(patch.position?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return {
        ok: false,
        document: null,
        errors: [`units[${index}]: position must hold finite x and y metre coordinates`],
        conflictIds: [editedId].filter(Boolean),
      };
    }
    target.position = { x, y };
  }
  if (patch.facing !== undefined) {
    const facing = Number(patch.facing);
    if (!Number.isFinite(facing)) {
      return {
        ok: false,
        document: null,
        errors: [`units[${index}]: facing must be a finite compass bearing in degrees`],
        conflictIds: [editedId].filter(Boolean),
      };
    }
    target.facing = facing;
  }
  const next = roundScenarioToTenth(copy);
  const errors = validateScenario(next);
  const relevant = errors.filter((error) => error.includes(`units[${index}]`));
  if (relevant.length === 0) {
    return { ok: true, document: next, errors: [], conflictIds: [] };
  }
  const conflictIds = [editedId];
  for (const error of relevant) {
    for (const match of error.matchAll(/units\[(\d+)\]/g)) {
      const other = next.units[Number(match[1])];
      if (other?.id) {
        conflictIds.push(other.id);
      }
    }
  }
  return {
    ok: false,
    document: null,
    errors: relevant,
    conflictIds: [...new Set(conflictIds.filter(Boolean))],
  };
}

// --- Unit add, edit, duplicate, and delete (order of battle) -----------------
// Every change returns a new document (the input is never mutated) and is
// validated structurally before it is returned: a change whose footprint
// would overlap another unit or leave the battlefield throws, so refused
// values never reach the document. The app commits each return through the
// undo history, making every unit change undoable with no extra work.
// Spacing presets live in the ruleset catalogue (`./polis-classical.js`),
// which this module never consults (catalogue membership is a playability
// concern, not a structural one): callers pass preset metres in, and the
// scenario stores only metres (ADR 0002).

function unitIndexById(document, unitId) {
  const units = Array.isArray(document?.units) ? document.units : [];
  const index = units.findIndex((unit) => unit?.id === unitId);
  if (index < 0) {
    throw new Error('Unit not found.');
  }
  return index;
}

// Throw the first structural error naming the edited unit, mirroring the
// editor: the value is refused and the document keeps its last valid values.
function refuseConflictingUnitEdit(next, index) {
  const errors = validateScenario(next);
  const relevant = errors.filter((error) => error.includes(`units[${index}]`));
  if (relevant.length > 0) {
    throw new Error(relevant[0]);
  }
  return next;
}

function checkUnitNumbers(soldiers, files) {
  if (!Number.isInteger(soldiers) || soldiers < 1) {
    throw new Error('Soldiers must be a whole number of at least 1.');
  }
  if (!Number.isInteger(files) || files < 1) {
    throw new Error('Files must be a whole number of at least 1.');
  }
  if (files > soldiers) {
    throw new Error(`Files (${files}) must not exceed soldiers (${soldiers}).`);
  }
}

function checkUnitSpacing(lateralInterval, rankDepth) {
  for (const [value, label] of [
    [lateralInterval, 'Lateral interval'],
    [rankDepth, 'Rank depth'],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${label} must be a positive number of metres.`);
    }
    if (value > MAX_SPACING_M) {
      throw new Error(`${label} must not exceed the application limit of ${MAX_SPACING_M} m.`);
    }
  }
}

function sideIdOrThrow(document, sideId) {
  const sides = Array.isArray(document?.sides) ? document.sides : [];
  const side = sides.find((entry) => entry?.id === sideId) || null;
  if (!side && sides.length > 0 && (sideId === undefined || sideId === null)) {
    return sides[0].id;
  }
  if (!side) {
    throw new Error('Side is required.');
  }
  return side.id;
}

// The derived ranks, frontage, and depth in metres from the same footprint
// the map draws, or null when the unit cannot derive one. The inspector
// reads this helper so its numbers always match the true-scale rectangle.
export function unitDerived(unit) {
  try {
    const footprint = unitFootprint(unit);
    if (
      !footprint ||
      !Number.isFinite(footprint.ranks) ||
      footprint.ranks < 1 ||
      !Number.isFinite(footprint.frontageM) ||
      !Number.isFinite(footprint.depthM)
    ) {
      return null;
    }
    return {
      ranks: footprint.ranks,
      frontageM: footprint.frontageM,
      depthM: footprint.depthM,
    };
  } catch {
    return null;
  }
}

// Add a unit with editor defaults (100 soldiers in 10 files at the given
// preset spacings) at the first free spot inside `searchRect` (the current
// view; the whole battlefield when null). Returns { document, unitId }.
// Throws when the view has no free spot, so the author can pan or zoom out
// and try again. Never mutates the input.
export function createUnit(document, options = {}) {
  const side = sideIdOrThrow(document, options.sideId ?? null);
  const soldiers = options.soldiers ?? 100;
  const files = options.files ?? 10;
  checkUnitNumbers(soldiers, files);
  const lateralInterval = round1(options.lateralInterval ?? 1.8);
  const rankDepth = round1(options.rankDepth ?? 1.8);
  checkUnitSpacing(lateralInterval, rankDepth);
  const facing = Number.isFinite(Number(options.facing))
    ? Number(options.facing)
    : defaultFacingForSide(document, side);
  const position = findFreeUnitPosition(
    document,
    {
      frontage: files * lateralInterval,
      depth: Math.ceil(soldiers / files) * rankDepth,
      facing,
    },
    options.searchRect ?? null,
  );
  if (!position) {
    throw new Error('No free space in the current view: pan or zoom out, then add the Unit again.');
  }
  const next = cloneScenario(document);
  const unit = {
    id: generateId(),
    name: suggestUnitName(next, options.name ?? 'New Unit'),
    side,
    troopType: isNonEmptyString(options.troopType) ? options.troopType.trim() : 'hoplite',
    soldiers,
    files,
    lateralInterval,
    rankDepth,
    position,
    facing,
  };
  next.units.push(unit);
  return { document: refuseConflictingUnitEdit(next, next.units.length - 1), unitId: unit.id };
}

// Duplicate a unit under a unique name at the first free spot inside
// `searchRect` (the current view; the whole battlefield when null). Returns
// { document, unitId }. Throws when the view has no free spot. Never mutates
// the input.
export function duplicateUnit(document, unitId, searchRect = null) {
  const units = Array.isArray(document?.units) ? document.units : [];
  const source = units.find((unit) => unit?.id === unitId) || null;
  if (!source) {
    throw new Error('Unit not found.');
  }
  const derived = unitDerived(source);
  const frontage = derived ? derived.frontageM : 1;
  const depth = derived ? derived.depthM : 1;
  const position = findFreeUnitPosition(
    document,
    { frontage, depth, facing: source.facing },
    searchRect,
  );
  if (!position) {
    throw new Error(
      'No free space in the current view: pan or zoom out, then duplicate the Unit again.',
    );
  }
  const next = cloneScenario(document);
  const copy = JSON.parse(JSON.stringify(source));
  copy.id = generateId();
  copy.name = suggestUnitName(next, `${source.name} copy`);
  copy.position = position;
  next.units.push(copy);
  return { document: refuseConflictingUnitEdit(next, next.units.length - 1), unitId: copy.id };
}

// Delete a unit. Throws for an unknown id. Never mutates the input.
export function deleteUnit(document, unitId) {
  const index = unitIndexById(document, unitId);
  const next = cloneScenario(document);
  next.units = next.units.filter((unit, other) => other !== index);
  return next;
}

// Rename a unit. Names are required and unique (case-insensitive on the
// trimmed name). Never mutates the input.
export function updateUnitName(document, unitId, name) {
  const index = unitIndexById(document, unitId);
  const value = String(name ?? '');
  if (!value.trim()) {
    throw new Error('Unit name is required.');
  }
  const units = Array.isArray(document?.units) ? document.units : [];
  const clash = units.some(
    (other) =>
      other?.id !== unitId &&
      String(other?.name || '').trim().toLowerCase() === value.trim().toLowerCase(),
  );
  if (clash) {
    throw new Error(`Unit name "${value.trim()}" is already used (names must be unique).`);
  }
  const next = cloneScenario(document);
  next.units[index].name = value.trim();
  return refuseConflictingUnitEdit(next, index);
}

// Move a unit to a side. The side must exist. Never mutates the input.
export function updateUnitSide(document, unitId, sideId) {
  const index = unitIndexById(document, unitId);
  const next = cloneScenario(document);
  next.units[index].side = sideIdOrThrow(next, sideId);
  return refuseConflictingUnitEdit(next, index);
}

// Change a unit's troop type. The key is required; unknown keys stay
// preserved verbatim (catalogue membership is a playability concern). When
// `preset` ({ lateralInterval, rankDepth }) is given, both spacings are
// pre-filled from it in the same undo step — the editor passes the new type's
// normal preset so the form follows the catalogue. Never mutates the input.
export function updateUnitTroopType(document, unitId, troopType, preset = null) {
  const index = unitIndexById(document, unitId);
  const value = String(troopType ?? '');
  if (!value.trim()) {
    throw new Error('Troop type is required.');
  }
  const next = cloneScenario(document);
  next.units[index].troopType = value;
  if (preset !== null && preset !== undefined) {
    checkUnitSpacing(Number(preset.lateralInterval), Number(preset.rankDepth));
    next.units[index].lateralInterval = round1(Number(preset.lateralInterval));
    next.units[index].rankDepth = round1(Number(preset.rankDepth));
  }
  return refuseConflictingUnitEdit(next, index);
}

// Change a unit's soldier and file counts. Counts are whole numbers of at
// least 1 and files must not exceed soldiers. Never mutates the input.
export function updateUnitNumbers(document, unitId, patch = {}) {
  const index = unitIndexById(document, unitId);
  const current = (Array.isArray(document?.units) ? document.units : [])[index];
  const soldiers = patch.soldiers === undefined ? current.soldiers : patch.soldiers;
  const files = patch.files === undefined ? current.files : patch.files;
  checkUnitNumbers(soldiers, files);
  const next = cloneScenario(document);
  next.units[index].soldiers = soldiers;
  next.units[index].files = files;
  return refuseConflictingUnitEdit(next, index);
}

// Change a unit's spacings in metres. Both are positive and bounded by the
// structural application limit; values round to the stored 0.1 m precision.
// Never mutates the input.
export function updateUnitSpacing(document, unitId, patch = {}) {
  const index = unitIndexById(document, unitId);
  const current = (Array.isArray(document?.units) ? document.units : [])[index];
  const lateralInterval =
    patch.lateralInterval === undefined ? current.lateralInterval : Number(patch.lateralInterval);
  const rankDepth = patch.rankDepth === undefined ? current.rankDepth : Number(patch.rankDepth);
  checkUnitSpacing(lateralInterval, rankDepth);
  const next = cloneScenario(document);
  next.units[index].lateralInterval = round1(lateralInterval);
  next.units[index].rankDepth = round1(rankDepth);
  return refuseConflictingUnitEdit(next, index);
}

// Find the first free front-midpoint for a footprint of the given size and
// facing inside `searchRect` ({ minX, maxX, minY, maxY } in map metres,
// clamped to the battlefield; defaults to the whole battlefield). Candidates
// are tried north to south, west to east on a 5 m grid, rounded to the stored
// 0.1 m precision. A candidate is free when its footprint lies wholly inside
// the battlefield and does not overlap any existing unit (using the same
// 0.1 m shrink tolerance as structural validation, so touching stays legal).
// Returns the position or null when no candidate fits. Pure.
export function findFreeUnitPosition(
  document,
  { frontage, depth, facing = 0 } = {},
  searchRect = null,
) {
  const battlefield = document?.battlefield;
  const width = Number(battlefield?.width);
  const height = Number(battlefield?.height);
  if (
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(height) ||
    height <= 0 ||
    !Number.isFinite(frontage) ||
    frontage <= 0 ||
    !Number.isFinite(depth) ||
    depth <= 0 ||
    !Number.isFinite(facing)
  ) {
    return null;
  }
  const rect = {
    minX: Math.max(0, Number(searchRect?.minX) || 0),
    minY: Math.max(0, Number(searchRect?.minY) || 0),
    maxX: Math.min(width, Number.isFinite(Number(searchRect?.maxX)) ? Number(searchRect.maxX) : width),
    maxY: Math.min(height, Number.isFinite(Number(searchRect?.maxY)) ? Number(searchRect.maxY) : height),
  };
  if (rect.minX > rect.maxX || rect.minY > rect.maxY) {
    return null;
  }
  // Existing footprints, shrunk exactly as structural validation shrinks them,
  // so placement accepts what validation accepts. Units without valid numbers
  // are skipped: they cannot overlap a candidate geometrically.
  const blockers = [];
  for (const unit of Array.isArray(document?.units) ? document.units : []) {
    if (
      !unit ||
      typeof unit !== 'object' ||
      !Number.isInteger(unit.soldiers) ||
      unit.soldiers < 1 ||
      !Number.isInteger(unit.files) ||
      unit.files < 1 ||
      unit.files > unit.soldiers ||
      !Number.isFinite(unit.lateralInterval) ||
      unit.lateralInterval <= 0 ||
      !Number.isFinite(unit.rankDepth) ||
      unit.rankDepth <= 0 ||
      !Number.isFinite(unit.position?.x) ||
      !Number.isFinite(unit.position?.y) ||
      !Number.isFinite(unit.facing)
    ) {
      continue;
    }
    try {
      const shrunk = shrinkFootprint(unit);
      const derived = shrunk ? null : deriveFootprint(unit);
      const corners = shrunk ? shrunk.corners : derived.corners;
      if (Array.isArray(corners) && corners.length === 4) {
        blockers.push(corners);
      }
    } catch {
      // A unit that cannot derive a footprint blocks nothing.
    }
  }
  const STEP_M = 5;
  for (let y = rect.maxY; y >= rect.minY - 1e-9; y -= STEP_M) {
    for (let x = rect.minX; x <= rect.maxX + 1e-9; x += STEP_M) {
      const candidate = { x: round1(Math.min(x, rect.maxX)), y: round1(Math.min(y, rect.maxY)) };
      let corners;
      try {
        const derived = deriveFootprint({
          soldiers: 1,
          files: 1,
          lateralInterval: frontage,
          rankDepth: depth,
          position: candidate,
          facing,
        });
        corners = derived.corners;
      } catch {
        continue;
      }
      if (
        !pointsWithinBounds([candidate], width, height) ||
        !pointsWithinBounds(corners, width, height)
      ) {
        continue;
      }
      let probeCorners = corners;
      try {
        const shrunk = shrinkFootprint({
          soldiers: 1,
          files: 1,
          lateralInterval: frontage,
          rankDepth: depth,
          position: candidate,
          facing,
        });
        if (shrunk) {
          probeCorners = shrunk.corners;
        }
      } catch {
        // Keep the unshrunk corners.
      }
      let blocked = false;
      for (const ring of blockers) {
        if (polygonsOverlapPositiveArea(probeCorners, ring)) {
          blocked = true;
          break;
        }
      }
      if (!blocked) {
        return candidate;
      }
    }
    // The grid step rarely divides the rect edge exactly: the clamped edge
    // value above already covers the remainder, so no extra pass is needed.
  }
  return null;
}
