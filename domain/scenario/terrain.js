// PÓLIS scenario model — terrain-feature editing (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

import {
  clipPathToRect,
  clipPolygonToRect,
  dedupePoints,
  isSimplePolygon,
  locatePoint,
  polygonArea,
  polygonInsideOrOn,
  polygonsOverlapPositiveArea,
  round1,
  segmentsProperlyCross,
} from '../geometry.js';

import { GROUND_COVER_CATEGORIES, LINEAR_FEATURE_CATEGORIES, cloneScenario, generateId } from './document.js';

import { roundScenarioToTenth } from './rounding.js';

// --- Ground cover editing (Terrain mode) --------------------------------------
// The editor draws and edits ground cover areas (forest, rough ground, water,
// settlement; open ground is the default and needs no feature) through these
// pure helpers, so the browser editor, the browser end-to-end test, and Node
// unit tests share one rules boundary (decisions #2 item 7, #4 items 7, 14):
//
// - drawn vertices are rounded to 0.1 m and clipped to the battlefield; the
//   stored vertices are exactly the clipped boundary (#2 item 8, #4 item 7);
// - a self-intersecting polygon, or one overlapping an existing ground cover
//   area, is refused — never auto-clipped (#4 item 14). The refusal carries
//   the candidate ring so the editor can highlight the conflicting area;
// - touching edge to edge stays legal: only positive-area overlap is refused.
function roundRing(points) {
  return points.map((point) => ({ x: round1(point.x), y: round1(point.y) }));
}

function groundCoverById(document, id) {
  return (document.terrainFeatures || []).find(
    (feature) => feature && feature.kind === 'ground' && feature.id === id,
  );
}

// Check a candidate ground cover polygon against the document without mutating
// anything. Returns { ok: true, ring } with the exact vertices to store, or
// { ok: false, reason, ring, conflictId? } describing the refusal. `ring` is
// the highlight the editor shows: the clipped candidate for overlaps, the
// drawn shape for self-intersections, and whatever survived for degenerate
// input. `ignoreId` exempts one feature, so moving a vertex of a feature never
// conflicts with the feature itself.
export function validateGroundCoverCandidate(document, points, options = {}) {
  const { ignoreId = null } = options;
  const battlefield = document?.battlefield;
  if (
    !battlefield ||
    !Number.isFinite(battlefield.width) ||
    !Number.isFinite(battlefield.height)
  ) {
    return { ok: false, reason: 'the battlefield size is missing', ring: [] };
  }
  if (!Array.isArray(points) || points.length < 3) {
    return { ok: false, reason: 'a ground cover area needs at least 3 vertices', ring: [] };
  }
  if (points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    return {
      ok: false,
      reason: 'a ground cover area must hold finite x and y metre coordinates',
      ring: [],
    };
  }
  const drawn = dedupePoints(roundRing(points));
  if (drawn.length < 3) {
    return {
      ok: false,
      reason: 'a ground cover area needs at least 3 distinct vertices',
      ring: drawn,
    };
  }
  if (!isSimplePolygon(drawn)) {
    return {
      ok: false,
      reason: 'the polygon must be simple (no self-intersection)',
      ring: drawn,
    };
  }
  const clipped = dedupePoints(
    roundRing(clipPolygonToRect(drawn, battlefield.width, battlefield.height)),
  );
  if (clipped.length < 3 || !(polygonArea(clipped) > 0)) {
    return { ok: false, reason: 'the polygon lies outside the battlefield', ring: drawn };
  }
  if (!isSimplePolygon(clipped)) {
    return {
      ok: false,
      reason: 'the polygon must be simple (no self-intersection)',
      ring: clipped,
    };
  }
  const grounds = (document.terrainFeatures || []).filter(
    (feature) => feature && feature.kind === 'ground' && feature.id !== ignoreId,
  );
  for (const other of grounds) {
    if (
      Array.isArray(other.polygon) &&
      other.polygon.length >= 3 &&
      polygonsOverlapPositiveArea(clipped, other.polygon)
    ) {
      return {
        ok: false,
        reason: `the polygon overlaps the existing ${other.category || 'ground cover'} area`,
        ring: clipped,
        conflictId: other.id,
      };
    }
  }
  return { ok: true, ring: clipped };
}

// Draw a new ground cover area: validates the candidate, clips it to the
// battlefield, and returns a new document with the feature appended. Throws a
// human-readable error when the category is unknown or the candidate is
// refused. Never mutates its input.
export function addGroundCoverFeature(document, { category, polygon } = {}) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot add a ground cover area: the scenario must be an object.');
  }
  if (!GROUND_COVER_CATEGORIES.includes(category)) {
    throw new Error(
      `Cannot add a ground cover area: category must be one of ${GROUND_COVER_CATEGORIES.join(', ')}.`,
    );
  }
  const candidate = validateGroundCoverCandidate(document, polygon);
  if (!candidate.ok) {
    throw new Error(`Cannot add a ground cover area: ${candidate.reason}.`);
  }
  const copy = cloneScenario(document);
  copy.terrainFeatures = Array.isArray(copy.terrainFeatures) ? copy.terrainFeatures : [];
  copy.terrainFeatures.push({
    id: generateId(),
    kind: 'ground',
    category,
    polygon: candidate.ring,
  });
  return roundScenarioToTenth(copy);
}

// Change the category and/or polygon of one ground cover area. A polygon edit
// is checked against every other ground cover area but never against the
// feature itself. Throws when the feature is missing, the category is unknown,
// or the candidate polygon is refused. Never mutates its input.
export function updateGroundCoverFeature(document, id, patch = {}) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot edit a ground cover area: the scenario must be an object.');
  }
  const existing = groundCoverById(document, id);
  if (!existing) {
    throw new Error('Cannot edit a ground cover area: no ground cover area with that id.');
  }
  const category = patch.category === undefined ? existing.category : patch.category;
  if (!GROUND_COVER_CATEGORIES.includes(category)) {
    throw new Error(
      `Cannot edit a ground cover area: category must be one of ${GROUND_COVER_CATEGORIES.join(', ')}.`,
    );
  }
  let polygon = existing.polygon;
  if (patch.polygon !== undefined) {
    const candidate = validateGroundCoverCandidate(document, patch.polygon, { ignoreId: id });
    if (!candidate.ok) {
      throw new Error(`Cannot edit a ground cover area: ${candidate.reason}.`);
    }
    polygon = candidate.ring;
  }
  const copy = cloneScenario(document);
  const index = copy.terrainFeatures.findIndex(
    (feature) => feature && feature.kind === 'ground' && feature.id === id,
  );
  copy.terrainFeatures[index] = { ...copy.terrainFeatures[index], category, polygon };
  return roundScenarioToTenth(copy);
}

// Delete a whole ground cover area. Throws when the feature is missing. Never
// mutates its input.
export function removeGroundCoverFeature(document, id) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot delete a ground cover area: the scenario must be an object.');
  }
  if (!groundCoverById(document, id)) {
    throw new Error('Cannot delete a ground cover area: no ground cover area with that id.');
  }
  const copy = cloneScenario(document);
  copy.terrainFeatures = copy.terrainFeatures.filter(
    (feature) => !(feature && feature.kind === 'ground' && feature.id === id),
  );
  return copy;
}

// --- Elevation editing (Terrain mode) ------------------------------------------
// The author draws hills as nested elevation polygons; levels follow from
// nesting and are never typed (decisions #2 item 7, #4 items 7, 14). Elevation
// is independent of ground cover: these helpers never consult ground features.
//
// - drawn vertices are rounded to 0.1 m and clipped to the battlefield; the
//   stored vertices are exactly the clipped boundary, as for ground cover;
// - a self-intersecting polygon, one crossing an existing elevation boundary,
//   one only partly inside a parent (straddling a sibling or a parent edge),
//   or one duplicating an existing ring is refused — never auto-adjusted. The
//   refusal carries the candidate ring so the editor can highlight it;
// - the level is derived from containment depth: a polygon outside every other
//   is level 1, one wholly inside a level n polygon is level n + 1. Touching
//   edge to edge stays legal;
// - every mutating helper re-derives the levels of all surviving elevation
//   features from containment, so deleting a level promotes its nested
//   children (a level 2 peak inside a deleted level 1 hill becomes level 1)
//   and drawing an outer ring around existing hills bumps them down.
function elevationFeatureById(document, id) {
  return (document.terrainFeatures || []).find(
    (feature) => feature && feature.kind === 'elevation' && feature.id === id,
  );
}

function elevationList(document, ignoreId = null) {
  return (document?.terrainFeatures || []).filter(
    (feature) =>
      feature &&
      feature.kind === 'elevation' &&
      feature.id !== ignoreId &&
      Array.isArray(feature.polygon) &&
      feature.polygon.length >= 3,
  );
}

// Derive the level of every elevation feature from containment depth: level 1
// for polygons contained by no other elevation polygon, level n + 1 for polygons
// wholly inside a level n polygon. Mutates the passed feature array in place;
// callers pass a fresh clone. Assumes the set is laminar (checked separately
// by validateElevationCandidate and validateScenario).
function relabelElevationLevels(features) {
  const rings = features.filter(
    (feature) => feature && feature.kind === 'elevation' && Array.isArray(feature.polygon),
  );
  for (const feature of rings) {
    let depth = 0;
    for (const other of rings) {
      if (other === feature) {
        continue;
      }
      if (
        polygonArea(other.polygon) - polygonArea(feature.polygon) > 1e-6 &&
        polygonInsideOrOn(feature.polygon, other.polygon)
      ) {
        depth += 1;
      }
    }
    feature.level = depth + 1;
  }
}

// Check a candidate elevation polygon against the document without mutating
// anything. Returns { ok: true, ring, level, parentId? } with the exact
// vertices to store and the derived level, or
// { ok: false, reason, ring, conflictId? } describing the refusal. `ring` is
// the highlight the editor shows: the clipped candidate for nesting refusals,
// the drawn shape for self-intersections, and whatever survived for degenerate
// input. `ignoreId` exempts one feature, so moving a vertex of a feature never
// conflicts with the feature itself.
export function validateElevationCandidate(document, points, options = {}) {
  const { ignoreId = null } = options;
  const battlefield = document?.battlefield;
  if (
    !battlefield ||
    !Number.isFinite(battlefield.width) ||
    !Number.isFinite(battlefield.height)
  ) {
    return { ok: false, reason: 'the battlefield size is missing', ring: [] };
  }
  if (!Array.isArray(points) || points.length < 3) {
    return { ok: false, reason: 'a hill needs at least 3 vertices', ring: [] };
  }
  if (points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    return {
      ok: false,
      reason: 'a hill must hold finite x and y metre coordinates',
      ring: [],
    };
  }
  const drawn = dedupePoints(roundRing(points));
  if (drawn.length < 3) {
    return {
      ok: false,
      reason: 'a hill needs at least 3 distinct vertices',
      ring: drawn,
    };
  }
  if (!isSimplePolygon(drawn)) {
    return {
      ok: false,
      reason: 'the polygon must be simple (no self-intersection)',
      ring: drawn,
    };
  }
  const clipped = dedupePoints(
    roundRing(clipPolygonToRect(drawn, battlefield.width, battlefield.height)),
  );
  if (clipped.length < 3 || !(polygonArea(clipped) > 0)) {
    return { ok: false, reason: 'the polygon lies outside the battlefield', ring: drawn };
  }
  if (!isSimplePolygon(clipped)) {
    return {
      ok: false,
      reason: 'the polygon must be simple (no self-intersection)',
      ring: clipped,
    };
  }
  const others = elevationList(document, ignoreId);
  const containers = [];
  for (const other of others) {
    let crosses = false;
    for (let i = 0; i < clipped.length; i += 1) {
      const a = clipped[i];
      const b = clipped[(i + 1) % clipped.length];
      for (let j = 0; j < other.polygon.length; j += 1) {
        const c = other.polygon[j];
        const d = other.polygon[(j + 1) % other.polygon.length];
        if (segmentsProperlyCross(a, b, c, d)) {
          crosses = true;
          break;
        }
      }
      if (crosses) {
        break;
      }
    }
    if (crosses) {
      return {
        ok: false,
        reason: 'the polygon crosses the boundary of an existing elevation level (siblings must never cross)',
        ring: clipped,
        conflictId: other.id,
      };
    }
    const candidateInside = polygonInsideOrOn(clipped, other.polygon);
    const otherInside = polygonInsideOrOn(other.polygon, clipped);
    if (candidateInside && otherInside) {
      return {
        ok: false,
        reason: 'the polygon duplicates an existing elevation level',
        ring: clipped,
        conflictId: other.id,
      };
    }
    if (candidateInside) {
      if (!(polygonArea(other.polygon) - polygonArea(clipped) > 1e-6)) {
        return {
          ok: false,
          reason: 'the polygon duplicates an existing elevation level',
          ring: clipped,
          conflictId: other.id,
        };
      }
      containers.push(other);
      continue;
    }
    if (otherInside) {
      if (!(polygonArea(clipped) - polygonArea(other.polygon) > 1e-6)) {
        return {
          ok: false,
          reason: 'the polygon duplicates an existing elevation level',
          ring: clipped,
          conflictId: other.id,
        };
      }
      continue;
    }
    const candidateVertexInside = clipped.some(
      (point) => locatePoint(other.polygon, point) === 'inside',
    );
    const otherVertexInside = other.polygon.some(
      (point) => locatePoint(clipped, point) === 'inside',
    );
    if (candidateVertexInside || otherVertexInside) {
      return {
        ok: false,
        reason: 'the polygon must sit wholly inside one elevation level (it straddles a boundary)',
        ring: clipped,
        conflictId: other.id,
      };
    }
  }
  let parent = null;
  for (const container of containers) {
    if (!parent || polygonArea(container.polygon) < polygonArea(parent.polygon)) {
      parent = container;
    }
  }
  return {
    ok: true,
    ring: clipped,
    level: containers.length + 1,
    parentId: parent ? parent.id : null,
  };
}

// Draw a new hill: validates the candidate, clips it to the battlefield, and
// returns a new document with the feature appended at its derived level.
// Levels of pre-existing hills fully inside the new ring are re-derived, so a
// new outer ring bumps them down. Throws a human-readable error when the
// candidate is refused. Never mutates its input.
export function addElevationFeature(document, { polygon } = {}) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot add a hill: the scenario must be an object.');
  }
  const candidate = validateElevationCandidate(document, polygon);
  if (!candidate.ok) {
    throw new Error(`Cannot add a hill: ${candidate.reason}.`);
  }
  const copy = cloneScenario(document);
  copy.terrainFeatures = Array.isArray(copy.terrainFeatures) ? copy.terrainFeatures : [];
  copy.terrainFeatures.push({
    id: generateId(),
    kind: 'elevation',
    level: candidate.level,
    polygon: candidate.ring,
  });
  relabelElevationLevels(copy.terrainFeatures);
  return roundScenarioToTenth(copy);
}

// Change the polygon of one hill. The candidate is checked against every other
// elevation feature but never against the feature itself, and every surviving
// level is re-derived. Throws when the feature is missing or the candidate
// polygon is refused. Never mutates its input.
export function updateElevationFeature(document, id, patch = {}) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot edit a hill: the scenario must be an object.');
  }
  const existing = elevationFeatureById(document, id);
  if (!existing) {
    throw new Error('Cannot edit a hill: no hill with that id.');
  }
  let polygon = existing.polygon;
  if (patch.polygon !== undefined) {
    const candidate = validateElevationCandidate(document, patch.polygon, { ignoreId: id });
    if (!candidate.ok) {
      throw new Error(`Cannot edit a hill: ${candidate.reason}.`);
    }
    polygon = candidate.ring;
  }
  const copy = cloneScenario(document);
  const index = copy.terrainFeatures.findIndex(
    (feature) => feature && feature.kind === 'elevation' && feature.id === id,
  );
  copy.terrainFeatures[index] = { ...copy.terrainFeatures[index], polygon };
  relabelElevationLevels(copy.terrainFeatures);
  return roundScenarioToTenth(copy);
}

// Delete a whole hill. Nested children survive and are promoted: their levels
// are re-derived from the remaining containment, so deleting a level 1 hill
// leaves its former level 2 peak as level 1 and every nesting invariant stays
// true. Throws when the feature is missing. Never mutates its input.
export function removeElevationFeature(document, id) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot delete a hill: the scenario must be an object.');
  }
  if (!elevationFeatureById(document, id)) {
    throw new Error('Cannot delete a hill: no hill with that id.');
  }
  const copy = cloneScenario(document);
  copy.terrainFeatures = copy.terrainFeatures.filter(
    (feature) => !(feature && feature.kind === 'elevation' && feature.id === id),
  );
  relabelElevationLevels(copy.terrainFeatures);
  return copy;
}

// --- Linear features editing (Terrain mode) ---------------------------------
// The editor draws rivers and roads as polylines with a width in metres
// (decisions #2 item 7, #4 item 7) through these pure helpers, so the browser
// editor, the browser end-to-end test, and Node unit tests share one rules
// boundary:
//
// - drawn vertices are rounded to 0.1 m and clamped to the battlefield; the
//   stored vertices are exactly the clamped boundary (#2 item 8, #4 item 7);
// - polylines may cross ground cover areas, elevation levels, and each other:
//   crossings are never refused — only degenerate input is;
// - a width must be a positive number of metres (> 0), set in the inspector.

function linearFeatureById(document, id) {
  return (document.terrainFeatures || []).find(
    (feature) => feature && feature.kind === 'linear' && feature.id === id,
  );
}

function roundPath(points) {
  return points.map((point) => ({ x: round1(point.x), y: round1(point.y) }));
}

// Check a candidate polyline without mutating anything. Returns
// { ok: true, path } with the exact vertices to store, or
// { ok: false, reason, path } describing the refusal. `path` is the highlight
// the editor shows: the clamped candidate when it survives, else whatever
// survived of the drawn shape.
export function validateLinearCandidate(document, path) {
  const battlefield = document?.battlefield;
  if (
    !battlefield ||
    !Number.isFinite(battlefield.width) ||
    !Number.isFinite(battlefield.height)
  ) {
    return { ok: false, reason: 'the battlefield size is missing', path: [] };
  }
  if (!Array.isArray(path) || path.length < 2) {
    return { ok: false, reason: 'a river or road needs at least 2 vertices', path: [] };
  }
  if (path.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    return {
      ok: false,
      reason: 'a river or road must hold finite x and y metre coordinates',
      path: [],
    };
  }
  const drawn = dedupePoints(roundPath(path));
  if (drawn.length < 2) {
    return {
      ok: false,
      reason: 'a river or road needs at least 2 distinct vertices',
      path: drawn,
    };
  }
  const clamped = dedupePoints(
    roundPath(clipPathToRect(drawn, battlefield.width, battlefield.height)),
  );
  if (clamped.length < 2) {
    return { ok: false, reason: 'the line lies outside the battlefield', path: drawn };
  }
  return { ok: true, path: clamped };
}

function checkLinearWidth(width) {
  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('Cannot save a river or road: width must be a positive number of metres.');
  }
}

// Draw a new river or road: validates the candidate, clamps it to the
// battlefield, and returns a new document with the feature appended. Throws a
// human-readable error when the category or width is invalid or the candidate
// is refused. Never mutates its input.
export function addLinearFeature(document, { category, path, width } = {}) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot add a river or road: the scenario must be an object.');
  }
  if (!LINEAR_FEATURE_CATEGORIES.includes(category)) {
    throw new Error(
      `Cannot add a river or road: category must be one of ${LINEAR_FEATURE_CATEGORIES.join(', ')}.`,
    );
  }
  checkLinearWidth(width);
  const candidate = validateLinearCandidate(document, path);
  if (!candidate.ok) {
    throw new Error(`Cannot add a river or road: ${candidate.reason}.`);
  }
  const copy = cloneScenario(document);
  copy.terrainFeatures = Array.isArray(copy.terrainFeatures) ? copy.terrainFeatures : [];
  copy.terrainFeatures.push({
    id: generateId(),
    kind: 'linear',
    category,
    path: candidate.path,
    width: round1(width),
  });
  return roundScenarioToTenth(copy);
}

// Change the category, path, and/or width of one river or road. A path edit
// is clamped to the battlefield; crossings are never refused. Throws when the
// feature is missing, the category is unknown, the width is not positive, or
// the candidate path is refused. Never mutates its input.
export function updateLinearFeature(document, id, patch = {}) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot edit a river or road: the scenario must be an object.');
  }
  const existing = linearFeatureById(document, id);
  if (!existing) {
    throw new Error('Cannot edit a river or road: no river or road with that id.');
  }
  const category = patch.category === undefined ? existing.category : patch.category;
  if (!LINEAR_FEATURE_CATEGORIES.includes(category)) {
    throw new Error(
      `Cannot edit a river or road: category must be one of ${LINEAR_FEATURE_CATEGORIES.join(', ')}.`,
    );
  }
  const width = patch.width === undefined ? existing.width : patch.width;
  checkLinearWidth(width);
  let path = existing.path;
  if (patch.path !== undefined) {
    const candidate = validateLinearCandidate(document, patch.path);
    if (!candidate.ok) {
      throw new Error(`Cannot edit a river or road: ${candidate.reason}.`);
    }
    path = candidate.path;
  }
  const copy = cloneScenario(document);
  const index = copy.terrainFeatures.findIndex(
    (feature) => feature && feature.kind === 'linear' && feature.id === id,
  );
  copy.terrainFeatures[index] = { ...copy.terrainFeatures[index], category, path, width: round1(width) };
  return roundScenarioToTenth(copy);
}

// Delete a whole river or road. Throws when the feature is missing. Never
// mutates its input.
export function removeLinearFeature(document, id) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot delete a river or road: the scenario must be an object.');
  }
  if (!linearFeatureById(document, id)) {
    throw new Error('Cannot delete a river or road: no river or road with that id.');
  }
  const copy = cloneScenario(document);
  copy.terrainFeatures = copy.terrainFeatures.filter(
    (feature) => !(feature && feature.kind === 'linear' && feature.id === id),
  );
  return copy;
}
