// PÓLIS scenario model — creation and property editing (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

import {
  clipPathToRect,
  clipPolygonToRect,
  deriveFootprint,
  polygonArea,
  pointsWithinBounds,
  round1,
} from '../geometry.js';

import { MAX_BATTLEFIELD_HEIGHT_M, MAX_BATTLEFIELD_WIDTH_M, RULESET_ID, RULESET_VERSION, SCENARIO_FORMAT_VERSION, SCENARIO_KIND, cloneBattlefield, cloneScenario, cloneSides, generateId, isNonEmptyString } from './document.js';

import { roundScenarioToTenth } from './rounding.js';

import { unitLabel, validateScenario } from './validation.js';

export function createScenario(input = {}) {
  const { title, description, battlefield, sides, ruleset, units, terrainFeatures } = input;
  if (!isNonEmptyString(title)) {
    throw new Error('Scenario title is required.');
  }
  const document = {
    kind: SCENARIO_KIND,
    formatVersion: SCENARIO_FORMAT_VERSION,
    id: generateId(),
    title: title.trim(),
    description: description === undefined ? '' : description,
    battlefield: cloneBattlefield(battlefield),
    sides: cloneSides(sides),
    ruleset: ruleset ? { id: ruleset.id, version: ruleset.version } : { id: RULESET_ID, version: RULESET_VERSION },
    units: units ? JSON.parse(JSON.stringify(units)) : [],
    terrainFeatures: terrainFeatures
      ? JSON.parse(JSON.stringify(terrainFeatures))
      : [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const rounded = roundScenarioToTenth(document);
  Object.assign(document, {
    battlefield: rounded.battlefield,
    units: rounded.units,
    terrainFeatures: rounded.terrainFeatures,
  });
  const errors = validateScenario(document);
  if (errors.length > 0) {
    throw new Error(`Invalid scenario: ${errors.join('; ')}`);
  }
  return document;
}

export function clipTerrainFeatureToBounds(feature, width, height) {
  if (!feature || typeof feature !== 'object') {
    return null;
  }
  if (Array.isArray(feature.polygon)) {
    const clipped = clipPolygonToRect(feature.polygon, width, height);
    if (clipped.length < 3 || !(polygonArea(clipped) > 0)) {
      return null;
    }
    return { ...feature, polygon: clipped };
  }
  if (Array.isArray(feature.path)) {
    const clipped = clipPathToRect(feature.path, width, height);
    if (clipped.length < 2) {
      return null;
    }
    return { ...feature, path: clipped };
  }
  return { ...feature };
}

// Resize the battlefield of a scenario: growing keeps every feature, while
// shrinking clips terrain geometry to the new bounds (features left fully
// outside are dropped). Shrinking past a unit is refused — the error names
// every unit whose footprint would fall outside — because unit positions are
// never silently moved. Dimensions are rounded to 0.1 m and must stay
// within the application limit. Returns a new document; the input is never
// mutated. Throws when the dimensions are invalid or a unit would fall out.
export function resizeBattlefield(document, width, height) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot resize the battlefield: the scenario must be an object.');
  }
  const nextWidth = round1(Number(width));
  const nextHeight = round1(Number(height));
  for (const [value, dimension, limit] of [
    [nextWidth, 'width', MAX_BATTLEFIELD_WIDTH_M],
    [nextHeight, 'height', MAX_BATTLEFIELD_HEIGHT_M],
  ]) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`Battlefield ${dimension} must be a positive number of metres.`);
    }
    if (value > limit) {
      throw new Error(
        `Battlefield ${dimension} must not exceed the application limit of ${limit} m.`,
      );
    }
  }
  const units = Array.isArray(document.units) ? document.units : [];
  const unitsOutside = [];
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
    const footprint = deriveFootprint(unit);
    if (!pointsWithinBounds(footprint.corners, nextWidth, nextHeight)) {
      unitsOutside.push(unitLabel(unit, index));
    }
  });
  if (unitsOutside.length > 0) {
    throw new Error(
      `Cannot shrink the battlefield: ${unitsOutside.join(', ')} would fall outside the new bounds.`,
    );
  }
  const copy = cloneScenario(document);
  copy.battlefield = { width: nextWidth, height: nextHeight };
  copy.terrainFeatures = (copy.terrainFeatures || [])
    .map((feature) => clipTerrainFeatureToBounds(feature, nextWidth, nextHeight))
    .filter(Boolean);
  return roundScenarioToTenth(copy);
}

// --- Scenario property editing (inspector) ------------------------------------
// The inspector commits scenario properties through these pure helpers, so the
// app editor and the Node unit tests share one rules boundary:
// - the title is required (a blank title is refused, never cleared);
// - the description is optional plain text;
// - battlefield size goes through resizeBattlefield: growing keeps every
//   feature, shrinking clips terrain to the new bounds, and shrinking past a
//   unit is refused with the blocking units named;
// - sides are never added or removed (the scenario always has exactly two):
//   names are required and unique (compared case-insensitively on the trimmed
//   name), colours are required and distinct (compared case-insensitively).
// Every helper returns a new document and never mutates its input. A refused
// value throws a human-readable error naming the cause; the caller keeps the
// old document and shows the message inline.

function sideAt(document, index, verb) {
  const sides = Array.isArray(document?.sides) ? document.sides : [];
  if (!Number.isInteger(index) || index < 0 || index >= sides.length) {
    throw new Error(
      `Cannot ${verb} the side: the scenario has exactly ${sides.length} sides.`,
    );
  }
  return sides[index];
}

export function updateScenarioTitle(document, title) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot rename the scenario: the scenario must be an object.');
  }
  const value = String(title ?? '').trim();
  if (!value) {
    throw new Error('Scenario title is required.');
  }
  const copy = cloneScenario(document);
  copy.title = value;
  return copy;
}

export function updateScenarioDescription(document, description) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot edit the scenario description: the scenario must be an object.');
  }
  if (description !== undefined && description !== null && typeof description !== 'string') {
    throw new Error('Scenario description must be plain text.');
  }
  const copy = cloneScenario(document);
  copy.description = description === undefined || description === null ? '' : description;
  return copy;
}

export function updateSideName(document, index, name) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot rename the side: the scenario must be an object.');
  }
  sideAt(document, index, 'rename');
  const value = String(name ?? '').trim();
  if (!value) {
    throw new Error(`Side ${index + 1} name is required.`);
  }
  const clash = document.sides.some(
    (other, otherIndex) =>
      otherIndex !== index &&
      String(other?.name || '').trim().toLowerCase() === value.toLowerCase(),
  );
  if (clash) {
    throw new Error(
      `Side name "${value}" is already used by the other side (names must be unique).`,
    );
  }
  const copy = cloneScenario(document);
  copy.sides[index].name = value;
  return copy;
}

export function updateSideColor(document, index, color) {
  if (!document || typeof document !== 'object') {
    throw new Error('Cannot recolour the side: the scenario must be an object.');
  }
  sideAt(document, index, 'recolour');
  const value = String(color ?? '').trim().toLowerCase();
  if (!value) {
    throw new Error(`Side ${index + 1} colour is required.`);
  }
  const clash = document.sides.some(
    (other, otherIndex) =>
      otherIndex !== index && String(other?.color || '').trim().toLowerCase() === value,
  );
  if (clash) {
    throw new Error('Sides must have distinct colours.');
  }
  const copy = cloneScenario(document);
  copy.sides[index].color = value;
  return copy;
}
