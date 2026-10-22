// PÓLIS domain core — the complete scenario model, structural validation,
// and file exchange (framework-free).
//
// This module is the framework-free domain package: it imports nothing —
// no React, no Next.js, no DOM, no Node APIs — so it runs unchanged in the
// browser editor, in Node unit tests, and in any future shell. Geometry
// helpers live in `./geometry.js`; the provisional ruleset catalogue lives
// in `./polis-classical.js` and is never consulted here (catalogue
// membership is a playability concern, not a structural one).
//
// Map convention (ADR 0001): the battlefield uses a map convention with the
// origin at the south-west corner, x east, y north, measured in metres.
// Stored values are rounded to 0.1 m. Only rendering flips the vertical
// axis for the screen (see toScreenPoint).
//
// Scenario document (format version 1):
//   kind, formatVersion, id, title, description,
//   battlefield { width, height },
//   sides [exactly two: { id, name, color }],
//   ruleset { id, version },
//   units [{ id, name, side, troopType, soldiers, files,
//             lateralInterval, rankDepth, position { x, y }, facing }],
//   terrainFeatures [{ id, kind, ... }],
//   createdAt, updatedAt.
// A unit's position is the midpoint of its front edge; facing is a compass
// bearing in degrees (0 = north, clockwise). Terrain features are ground
// cover polygons (kind 'ground', category forest | rough | water |
// settlement; open ground is the default and needs no feature), elevation
// level polygons (kind 'elevation', level >= 1, nesting derived from
// containment), and linear features (kind 'linear', category river | road,
// path polyline plus width in metres).

import {
  clipPathToRect,
  clipPolygonToRect,
  dedupePoints,
  deriveFootprint,
  isSimplePolygon,
  locatePoint,
  polygonArea,
  polygonInsideOrOn,
  polygonsOverlapPositiveArea,
  pointsWithinBounds,
  round1,
  segmentsProperlyCross,
  shrinkFootprint,
} from './geometry.js';

export const SCENARIO_KIND = 'scenario';
export const SCENARIO_FORMAT_VERSION = 1;

export const RULESET_ID = 'polis-classical';
export const RULESET_VERSION = '0.1';

// ADR 0001: true-scale footprints stay legible on a tactical battlefield of
// up to about 1-2 km. New scenarios default well inside that envelope.
export const MAX_BATTLEFIELD_WIDTH_M = 2000;
export const MAX_BATTLEFIELD_HEIGHT_M = 2000;
export const DEFAULT_BATTLEFIELD = Object.freeze({ width: 1200, height: 800 });

// A formation spacing above this application limit is structurally invalid
// (issue #3: both spacings are > 0 and no larger than an application limit).
export const MAX_SPACING_M = 10;

export const DEFAULT_SIDES = Object.freeze([
  Object.freeze({ id: 'side-a', name: 'Athenians', color: '#1d4ed8' }),
  Object.freeze({ id: 'side-b', name: 'Spartans', color: '#b91c1c' }),
]);

export const GROUND_COVER_CATEGORIES = Object.freeze([
  'forest',
  'rough',
  'water',
  'settlement',
]);

export const LINEAR_FEATURE_CATEGORIES = Object.freeze(['river', 'road']);

export const KNOWN_RULESET_IDS = Object.freeze([RULESET_ID]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function generateId() {
  const cryptoObject = globalThis.crypto;
  if (cryptoObject && typeof cryptoObject.randomUUID === 'function') {
    return cryptoObject.randomUUID();
  }
  // Fallback for runtimes without crypto.randomUUID: 128 random bits,
  // rendered in UUID shape. Uniqueness is probabilistic, as with v4 UUIDs.
  const bytes = new Uint8Array(16);
  if (cryptoObject && typeof cryptoObject.getRandomValues === 'function') {
    cryptoObject.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}` +
    `-${hex.slice(16, 20)}-${hex.slice(20)}`
  );
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function cloneBattlefield(battlefield) {
  if (!battlefield) return { ...DEFAULT_BATTLEFIELD };
  return { width: battlefield.width, height: battlefield.height };
}

function cloneSides(sides) {
  if (!sides) return DEFAULT_SIDES.map((side) => ({ ...side }));
  return sides.map((side) => ({ id: side.id, name: side.name, color: side.color }));
}

function roundPoint(point) {
  return { x: round1(point.x), y: round1(point.y) };
}

// Round every stored metre value to 0.1 m. Returns a new document; the
// input is never mutated.
export function roundScenarioToTenth(document) {
  const copy = cloneScenario(document);
  if (copy.battlefield) {
    copy.battlefield.width = round1(copy.battlefield.width);
    copy.battlefield.height = round1(copy.battlefield.height);
  }
  for (const unit of copy.units || []) {
    unit.lateralInterval = round1(unit.lateralInterval);
    unit.rankDepth = round1(unit.rankDepth);
    if (unit.position) {
      unit.position = roundPoint(unit.position);
    }
    if (Number.isFinite(unit.facing)) {
      // A facing is a compass bearing in degrees: wrap it into [0, 360)
      // so every stored value is one. Rounding can still produce 360.0,
      // which is the same bearing as 0.
      const wrapped = ((unit.facing % 360) + 360) % 360;
      unit.facing = round1(wrapped);
      if (unit.facing >= 360) {
        unit.facing = 0;
      }
    }
  }
  for (const feature of copy.terrainFeatures || []) {
    if (Array.isArray(feature.polygon)) {
      feature.polygon = feature.polygon.map(roundPoint);
    }
    if (Array.isArray(feature.path)) {
      feature.path = feature.path.map(roundPoint);
    }
    if (Number.isFinite(feature.width)) {
      feature.width = round1(feature.width);
    }
  }
  return copy;
}

// Create a new scenario document. The identifier is generated and immutable:
// it is assigned here and never changed afterwards. The title is required.
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

function checkNamesUnique(items, label, errors) {
  const seen = new Map();
  items.forEach((item, index) => {
    if (!item || !isNonEmptyString(item.name)) {
      return;
    }
    const key = item.name.trim().toLowerCase();
    if (seen.has(key)) {
      errors.push(
        `${label}[${index}] name "${item.name.trim()}" is already used by ${label}[${seen.get(key)}] (names must be unique)`,
      );
    } else {
      seen.set(key, index);
    }
  });
}

function checkIds(items, label, errors) {
  const seen = new Map();
  items.forEach((item, index) => {
    if (!item || !isNonEmptyString(item.id)) {
      errors.push(`${label}[${index}].id is required`);
      return;
    }
    if (seen.has(item.id)) {
      errors.push(`${label}[${index}].id "${item.id}" is already used (identifiers must be unique)`);
    } else {
      seen.set(item.id, index);
    }
  });
}

function unitLabel(unit, index) {
  return isNonEmptyString(unit?.name)
    ? `units[${index}] "${unit.name.trim()}"`
    : `units[${index}]`;
}

function featureLabel(feature, index) {
  return isNonEmptyString(feature?.id)
    ? `terrainFeatures[${index}] "${feature.id}"`
    : `terrainFeatures[${index}]`;
}

function validateUnit(unit, index, sideIds, battlefield, errors) {
  const label = unitLabel(unit, index);
  if (!unit || typeof unit !== 'object') {
    errors.push(`${label} must be an object`);
    return null;
  }
  if (!isNonEmptyString(unit.name)) {
    errors.push(`${label}.name is required`);
  }
  if (!isNonEmptyString(unit.side)) {
    errors.push(`${label}.side is required`);
  } else if (!sideIds.includes(unit.side)) {
    errors.push(
      `${label}.side "${unit.side}" does not match any side (one of: ${sideIds.join(', ') || 'none'})`,
    );
  }
  if (!isNonEmptyString(unit.troopType)) {
    errors.push(`${label}.troop type is required`);
  }
  // Catalogue membership is deliberately not structural: an unknown
  // troop-type key stays preserved verbatim and is rejected only by
  // playability validation at battle start.
  if (!Number.isInteger(unit.soldiers) || unit.soldiers < 1) {
    errors.push(`${label}: soldiers must be an integer of at least 1`);
  }
  if (!Number.isInteger(unit.files) || unit.files < 1) {
    errors.push(`${label}: files must be an integer of at least 1`);
  } else if (Number.isInteger(unit.soldiers) && unit.files > unit.soldiers) {
    errors.push(
      `${label}: files (${unit.files}) must not exceed soldiers (${unit.soldiers})`,
    );
  }
  for (const field of ['lateralInterval', 'rankDepth']) {
    const value = unit[field];
    if (!Number.isFinite(value) || value <= 0) {
      errors.push(`${label}: ${field} must be a positive number of metres`);
    } else if (value > MAX_SPACING_M) {
      errors.push(
        `${label}: ${field} must not exceed the application limit of ${MAX_SPACING_M} m`,
      );
    }
  }
  if (!unit.position || !Number.isFinite(unit.position?.x) || !Number.isFinite(unit.position?.y)) {
    errors.push(`${label}: position must hold finite x and y metre coordinates`);
  } else if (
    battlefield &&
    !pointsWithinBounds([unit.position], battlefield.width, battlefield.height)
  ) {
    errors.push(
      `${label}: front midpoint (${unit.position.x}, ${unit.position.y}) lies outside the battlefield`,
    );
  }
  if (!Number.isFinite(unit.facing)) {
    errors.push(`${label}: facing must be a finite compass bearing in degrees`);
  }
  const validNumbers =
    Number.isInteger(unit.soldiers) &&
    unit.soldiers >= 1 &&
    Number.isInteger(unit.files) &&
    unit.files >= 1 &&
    unit.files <= unit.soldiers &&
    Number.isFinite(unit.lateralInterval) &&
    unit.lateralInterval > 0 &&
    unit.lateralInterval <= MAX_SPACING_M &&
    Number.isFinite(unit.rankDepth) &&
    unit.rankDepth > 0 &&
    unit.rankDepth <= MAX_SPACING_M &&
    Number.isFinite(unit.position?.x) &&
    Number.isFinite(unit.position?.y) &&
    Number.isFinite(unit.facing);
  if (!validNumbers || !battlefield) {
    return null;
  }
  const footprint = deriveFootprint(unit);
  if (!pointsWithinBounds(footprint.corners, battlefield.width, battlefield.height)) {
    const outside = footprint.corners
      .map((corner) => `(${corner.x.toFixed(1)}, ${corner.y.toFixed(1)})`)
      .join(' ');
    errors.push(
      `${label}: footprint extends outside the battlefield (corners ${outside})`,
    );
  }
  return footprint;
}

function validateRing(points, what, errors) {
  if (!Array.isArray(points)) {
    errors.push(`${what} must be an array of { x, y } metre points`);
    return false;
  }
  if (points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
    errors.push(`${what} must hold finite x and y metre coordinates`);
    return false;
  }
  return true;
}

function validateTerrainFeature(feature, index, battlefield, errors) {
  const label = featureLabel(feature, index);
  if (!feature || typeof feature !== 'object') {
    errors.push(`${label} must be an object`);
    return null;
  }
  const kinds = ['ground', 'elevation', 'linear'];
  if (!kinds.includes(feature.kind)) {
    errors.push(`${label}: kind must be one of ${kinds.join(', ')}`);
    return null;
  }
  if (feature.kind === 'ground') {
    if (!GROUND_COVER_CATEGORIES.includes(feature.category)) {
      errors.push(
        `${label}: category must be one of ${GROUND_COVER_CATEGORIES.join(', ')}`,
      );
    }
    if (!validateRing(feature.polygon, `${label}.polygon`, errors)) {
      return null;
    }
    if (feature.polygon.length < 3) {
      errors.push(`${label}.polygon must hold at least 3 points`);
      return null;
    }
    if (!isSimplePolygon(feature.polygon)) {
      errors.push(`${label}.polygon must be a simple polygon (no self-intersection)`);
      return null;
    }
    if (!(polygonArea(feature.polygon) > 0)) {
      errors.push(`${label}.polygon must have a positive area`);
      return null;
    }
    if (battlefield && !pointsWithinBounds(feature.polygon, battlefield.width, battlefield.height)) {
      errors.push(`${label}.polygon lies outside the battlefield`);
    }
    return { ...feature, index };
  }
  if (feature.kind === 'elevation') {
    if (!Number.isInteger(feature.level) || feature.level < 1) {
      errors.push(`${label}: level must be an integer of at least 1`);
    }
    if (!validateRing(feature.polygon, `${label}.polygon`, errors)) {
      return null;
    }
    if (feature.polygon.length < 3) {
      errors.push(`${label}.polygon must hold at least 3 points`);
      return null;
    }
    if (!isSimplePolygon(feature.polygon)) {
      errors.push(`${label}.polygon must be a simple polygon (no self-intersection)`);
      return null;
    }
    if (!(polygonArea(feature.polygon) > 0)) {
      errors.push(`${label}.polygon must have a positive area`);
      return null;
    }
    if (battlefield && !pointsWithinBounds(feature.polygon, battlefield.width, battlefield.height)) {
      errors.push(`${label}.polygon lies outside the battlefield`);
    }
    return { ...feature, index };
  }
  if (!LINEAR_FEATURE_CATEGORIES.includes(feature.category)) {
    errors.push(
      `${label}: category must be one of ${LINEAR_FEATURE_CATEGORIES.join(', ')}`,
    );
  }
  if (!validateRing(feature.path, `${label}.path`, errors)) {
    return null;
  }
  if (feature.path.length < 2) {
    errors.push(`${label}.path must hold at least 2 points`);
    return null;
  }
  if (!Number.isFinite(feature.width) || feature.width <= 0) {
    errors.push(`${label}: width must be a positive number of metres`);
  }
  if (battlefield && !pointsWithinBounds(feature.path, battlefield.width, battlefield.height)) {
    errors.push(`${label}.path lies outside the battlefield`);
  }
  return { ...feature, index };
}

// Structural validation (CONTEXT.md): well-formedness on the scenario's own
// terms, without consulting any ruleset mechanics. Returns a list of human
// readable problems; an empty list means the document is structurally valid.
// Pure: it never mutates the document and never touches storage or the DOM.
export function validateScenario(document) {
  const errors = [];
  if (!document || typeof document !== 'object') {
    return ['scenario must be an object'];
  }
  if (document.kind !== SCENARIO_KIND) {
    errors.push(`kind must be "${SCENARIO_KIND}"`);
  }
  if (!Number.isInteger(document.formatVersion)) {
    errors.push('formatVersion must be an integer');
  } else if (document.formatVersion !== SCENARIO_FORMAT_VERSION) {
    errors.push(`formatVersion must be ${SCENARIO_FORMAT_VERSION}`);
  }
  if (!isNonEmptyString(document.id)) {
    errors.push('id must be a non-empty string');
  }
  if (!isNonEmptyString(document.title)) {
    errors.push('title is required');
  }
  if (
    document.description !== undefined &&
    document.description !== null &&
    typeof document.description !== 'string'
  ) {
    errors.push('description must be plain text');
  }
  const battlefield = document.battlefield;
  let battlefieldOk = false;
  if (!battlefield || typeof battlefield !== 'object') {
    errors.push('battlefield is required');
  } else {
    battlefieldOk = true;
    for (const dimension of ['width', 'height']) {
      const value = battlefield[dimension];
      const limit =
        dimension === 'width' ? MAX_BATTLEFIELD_WIDTH_M : MAX_BATTLEFIELD_HEIGHT_M;
      if (!Number.isFinite(value) || value <= 0) {
        errors.push(`battlefield.${dimension} must be a positive number of metres`);
        battlefieldOk = false;
      } else if (value > limit) {
        errors.push(`battlefield.${dimension} must not exceed ${limit} m`);
        battlefieldOk = false;
      }
    }
  }
  const sides = document.sides;
  let sideIds = [];
  if (!Array.isArray(sides) || sides.length !== 2) {
    errors.push('scenario must have exactly two sides');
  } else {
    checkIds(sides, 'sides', errors);
    checkNamesUnique(sides, 'sides', errors);
    sides.forEach((side, index) => {
      if (!side || !isNonEmptyString(side.name)) {
        errors.push(`sides[${index}].name is required`);
      }
      if (!side || !isNonEmptyString(side.color)) {
        errors.push(`sides[${index}].color is required`);
      }
    });
    const colors = sides
      .filter((side) => side && isNonEmptyString(side.color))
      .map((side) => String(side.color).toLowerCase());
    if (new Set(colors).size !== colors.length) {
      errors.push('sides must have distinct colours');
    }
    sideIds = sides.map((side) => side?.id).filter((id) => isNonEmptyString(id));
  }
  const ruleset = document.ruleset;
  if (!ruleset || typeof ruleset !== 'object') {
    errors.push('ruleset reference is required');
  } else {
    if (!isNonEmptyString(ruleset.id)) {
      errors.push('ruleset.id is required');
    }
    if (!isNonEmptyString(ruleset.version)) {
      errors.push('ruleset.version is required');
    }
  }
  if (!Array.isArray(document.units)) {
    errors.push('units must be an array');
  } else {
    checkIds(document.units, 'units', errors);
    checkNamesUnique(document.units, 'units', errors);
    const footprints = battlefieldOk
      ? document.units.map((unit, index) =>
          validateUnit(unit, index, sideIds, battlefield, errors),
        )
      : document.units.map((unit, index) => {
          validateUnit(unit, index, sideIds, null, errors);
          return null;
        });
    // Footprints must not overlap with positive area. The 0.1 m tolerance
    // is applied by shrinking each footprint by 0.1 m before comparing, so
    // touching footprints stay legal.
    for (let i = 0; i < document.units.length; i += 1) {
      for (let j = i + 1; j < document.units.length; j += 1) {
        const a = document.units[i];
        const b = document.units[j];
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
          continue;
        }
        if (!footprints[i] || !footprints[j]) {
          continue;
        }
        const shrunkA = shrinkFootprint(a);
        const shrunkB = shrinkFootprint(b);
        const ringA = shrunkA ? shrunkA.corners : footprints[i].corners;
        const ringB = shrunkB ? shrunkB.corners : footprints[j].corners;
        if (polygonsOverlapPositiveArea(ringA, ringB)) {
          errors.push(
            `${unitLabel(a, i)} and ${unitLabel(b, j)}: footprints overlap (touching is legal, overlap is not)`,
          );
        }
      }
    }
  }
  if (!Array.isArray(document.terrainFeatures)) {
    errors.push('terrainFeatures must be an array');
  } else if (battlefieldOk) {
    checkIds(document.terrainFeatures, 'terrainFeatures', errors);
    const checked = document.terrainFeatures.map((feature, index) =>
      validateTerrainFeature(feature, index, battlefield, errors),
    );
    const grounds = checked.filter(Boolean).filter((feature) => feature.kind === 'ground');
    const elevations = checked.filter(Boolean).filter((feature) => feature.kind === 'elevation');
    // Ground cover areas are disjoint: every point has exactly one category.
    for (let i = 0; i < grounds.length; i += 1) {
      for (let j = i + 1; j < grounds.length; j += 1) {
        if (polygonsOverlapPositiveArea(grounds[i].polygon, grounds[j].polygon)) {
          errors.push(
            `${featureLabel(grounds[i], grounds[i].index)} and ${featureLabel(grounds[j], grounds[j].index)}: ground cover areas overlap (every point has exactly one ground cover)`,
          );
        }
      }
    }
    // Elevation nests correctly: level 1 polygons are disjoint siblings,
    // and every level n > 1 polygon sits wholly inside exactly one level
    // n - 1 polygon and never crosses a sibling.
    const byLevel = new Map();
    for (const feature of elevations) {
      if (!Number.isInteger(feature.level) || feature.level < 1) {
        continue;
      }
      if (!byLevel.has(feature.level)) {
        byLevel.set(feature.level, []);
      }
      byLevel.get(feature.level).push(feature);
    }
    for (const [level, group] of byLevel) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          if (polygonsOverlapPositiveArea(group[i].polygon, group[j].polygon)) {
            errors.push(
              `${featureLabel(group[i], group[i].index)} and ${featureLabel(group[j], group[j].index)}: elevation level ${level} areas overlap (siblings must never cross)`,
            );
          }
        }
      }
      if (level === 1) {
        continue;
      }
      const parents = byLevel.get(level - 1) || [];
      for (const feature of group) {
        const containers = parents.filter((parent) =>
          polygonInsideOrOn(feature.polygon, parent.polygon),
        );
        if (containers.length === 0) {
          errors.push(
            `${featureLabel(feature, feature.index)}: elevation level ${level} must sit wholly inside one level ${level - 1} polygon`,
          );
        } else if (containers.length > 1) {
          errors.push(
            `${featureLabel(feature, feature.index)}: elevation level ${level} sits inside more than one level ${level - 1} polygon`,
          );
        } else {
          const parent = containers[0];
          if (!(polygonArea(parent.polygon) - polygonArea(feature.polygon) > 1e-6)) {
            errors.push(
              `${featureLabel(feature, feature.index)}: elevation level ${level} must be smaller than its level ${level - 1} parent`,
            );
          }
        }
      }
    }
  } else {
    document.terrainFeatures.forEach((feature, index) => {
      validateTerrainFeature(feature, index, null, errors);
    });
  }
  // Library metadata (such as the revision counter) is kept apart from the
  // document (ADR 0003): a stored document must never carry it.
  if (Object.hasOwn(document, 'revision')) {
    errors.push('revision is library metadata and must not be stored in the document');
  }
  return errors;
}

export function isValidScenario(document) {
  return validateScenario(document).length === 0;
}

export function assertValidScenario(document) {
  const errors = validateScenario(document);
  if (errors.length > 0) {
    throw new Error(`Invalid scenario: ${errors.join('; ')}`);
  }
}

// Completeness warnings (non-blocking): a scenario can be structurally
// valid yet incomplete — in this release, a side fielding no units. Warnings
// never block saving; only the errors from validateScenario do. Pure.
export function collectWarnings(document) {
  const warnings = [];
  if (!document || typeof document !== 'object') {
    return warnings;
  }
  if (!Array.isArray(document.sides)) {
    return warnings;
  }
  const units = Array.isArray(document.units) ? document.units : [];
  for (const side of document.sides) {
    const count = units.filter((unit) => unit && unit.side === side?.id).length;
    if (count === 0) {
      const name = isNonEmptyString(side?.name)
        ? side.name.trim()
        : String(side?.id ?? 'unknown');
      warnings.push(`Side "${name}" has no units`);
    }
  }
  return warnings;
}

// Clip one terrain feature to the given bounds. Returns the clipped feature,
// or null when nothing of it survives (fully outside, or left degenerate:
// fewer than three polygon points, no positive area, fewer than two path
// points). Never mutates its input.
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
export function validateLinearCandidate(document, path, options = {}) {
  const { ignoreId = null } = options;
  void ignoreId;
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
  copy.terrainFeatures[index] = { ...copy.terrainFeatures[index], category, path, width };
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

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Deep clone a scenario document. Used by stores so callers can never
// mutate (or observe mutations of) the stored copy.
export function cloneScenario(document) {
  return JSON.parse(JSON.stringify(document));
}

// --- File exchange (ADR 0003) -------------------------------------------
// Export writes the stored document; import adds it back as a new copy
// with a new identifier. A failed import rejects the whole file and adds
// nothing: callers only save after parsing succeeds.

export class ScenarioImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScenarioImportError';
    this.code = code;
  }
}

// File name for an exported scenario, after its title.
export function scenarioFileName(title) {
  const clean = String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${clean || 'scenario'}.json`;
}

// Serialize the stored document for export: kind, format version, and
// ruleset reference travel with it; library metadata never does.
export function exportScenario(document) {
  assertValidScenario(document);
  const copy = cloneScenario(document);
  delete copy.revision;
  const rounded = roundScenarioToTenth(copy);
  return {
    fileName: scenarioFileName(copy.title),
    json: `${JSON.stringify(rounded, null, 2)}\n`,
  };
}

// Parse an exported file without assigning a new identifier. Throws a
// ScenarioImportError with a specific message for: a non-JSON file,
// another document kind, a higher format version, an unknown ruleset
// identifier, and structurally invalid content (naming the problem).
export function parseScenarioImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ScenarioImportError(
      'not-json',
      'Import failed: the file is not valid JSON.',
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ScenarioImportError(
      'invalid-content',
      'Import failed: the file does not hold a scenario document.',
    );
  }
  if (data.kind !== SCENARIO_KIND) {
    const actual = isNonEmptyString(data.kind) ? `"${data.kind}"` : 'unknown';
    throw new ScenarioImportError(
      'not-scenario-kind',
      `Import failed: this file holds a ${actual} document, not a scenario.`,
    );
  }
  if (!Number.isInteger(data.formatVersion)) {
    throw new ScenarioImportError(
      'invalid-content',
      'Import failed: formatVersion must be an integer.',
    );
  }
  if (data.formatVersion > SCENARIO_FORMAT_VERSION) {
    throw new ScenarioImportError(
      'unsupported-version',
      `Import failed: format version ${data.formatVersion} is newer than the supported version ${SCENARIO_FORMAT_VERSION}.`,
    );
  }
  const rulesetId = data.ruleset?.id;
  if (!isNonEmptyString(rulesetId) || !KNOWN_RULESET_IDS.includes(rulesetId)) {
    throw new ScenarioImportError(
      'unknown-ruleset',
      `Import failed: unknown ruleset "${isNonEmptyString(rulesetId) ? rulesetId : 'missing'}". This editor supports "${RULESET_ID}".`,
    );
  }
  // An older version of the same ruleset opens (keys resolve against the
  // current catalogue; an explicit Save rebinds the reference). A newer
  // version is refused, and the library is left unchanged.
  if (isNonEmptyString(data.ruleset?.version)) {
    const classification = classifyRulesetReference(data.ruleset);
    if (classification.status === 'newer') {
      throw new ScenarioImportError(
        'unsupported-ruleset-version',
        `Import failed: ruleset ${data.ruleset.id} ${data.ruleset.version} is newer than the installed ${RULESET_VERSION}.`,
      );
    }
  }
  const normalized = roundScenarioToTenth(cloneScenario(data));
  const errors = validateScenario(normalized);
  if (errors.length > 0) {
    throw new ScenarioImportError(
      'invalid-content',
      `Import failed: ${errors.join('; ')}`,
    );
  }
  return normalized;
}

// Parse an exported file and return it as a new copy: same content, new
// identifier. The caller saves the copy; nothing is stored on failure.
export function importScenarioDocument(text) {
  const parsed = parseScenarioImport(text);
  const copy = cloneScenario(parsed);
  copy.id = generateId();
  return copy;
}

// Map convention helpers (ADR 0001). The model keeps y-up metres; only
// rendering flips the vertical axis for the screen, via these functions.
export function toScreenPoint(point, battlefieldHeight) {
  return { x: point.x, y: battlefieldHeight - point.y };
}

export function fromScreenPoint(point, battlefieldHeight) {
  // Screen↔map conversion is its own inverse (a single vertical flip).
  return toScreenPoint(point, battlefieldHeight);
}

// Largest uniform scale that fits the battlefield into a viewport of the
// given size (both in the same units), keeping the true-scale aspect ratio.
export function fitScale(battlefieldWidth, battlefieldHeight, viewportWidth, viewportHeight) {
  if (
    !Number.isFinite(battlefieldWidth) ||
    !Number.isFinite(battlefieldHeight) ||
    battlefieldWidth <= 0 ||
    battlefieldHeight <= 0 ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return 1;
  }
  return Math.min(viewportWidth / battlefieldWidth, viewportHeight / battlefieldHeight);
}

export { deriveFootprint };
// --- Map navigation view model (display only) -------------------------------
// The editor map keeps its camera apart from the scenario document: zooming,
// panning, fitting, toggling the grid, and moving the cursor never mutate the
// document and never mark the scenario as unsaved. These helpers are pure and
// framework-free so the editor and the unit tests share them.
//
// A map view is { zoom, center } where zoom 1 fits the battlefield (plus the
// fixed editorial margin below) and center is a map-convention point
// { x, y } in metres (origin south-west, x east, y north).
export const MAP_VIEW_MIN_ZOOM = 0.2;
export const MAP_VIEW_MAX_ZOOM = 32;

// Fixed editorial margin around the battlefield, in metres. It frames axis
// labels only; it is not stored and never affects validation.
export const MAP_VIEW_PAD_LEFT_M = 70;
export const MAP_VIEW_PAD_RIGHT_M = 60;
export const MAP_VIEW_PAD_TOP_M = 60;
export const MAP_VIEW_PAD_BOTTOM_M = 60;

function baseViewSize(battlefield) {
  const width = Number(battlefield?.width);
  const height = Number(battlefield?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return {
    width: width + MAP_VIEW_PAD_LEFT_M + MAP_VIEW_PAD_RIGHT_M,
    height: height + MAP_VIEW_PAD_TOP_M + MAP_VIEW_PAD_BOTTOM_M,
  };
}

export function clampMapZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAP_VIEW_MAX_ZOOM, Math.max(MAP_VIEW_MIN_ZOOM, zoom));
}

// The fitted view: the whole battlefield plus the editorial margin is
// visible, centred on the battlefield centre.
export function fitMapView(battlefield) {
  const width = Number(battlefield?.width);
  const height = Number(battlefield?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return { zoom: 1, center: { x: 0, y: 0 } };
  }
  return { zoom: 1, center: { x: width / 2, y: height / 2 } };
}

// Zoom keeping the map point under the cursor fixed on the screen. The cursor
// and the previous centre are map-convention points in metres.
export function zoomViewAroundCursor(view, cursorMap, newZoom) {
  const zoom = clampMapZoom(newZoom);
  const center = view?.center;
  const cursor = cursorMap;
  if (
    !center ||
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !cursor ||
    !Number.isFinite(cursor.x) ||
    !Number.isFinite(cursor.y)
  ) {
    return { zoom, center: { x: cursor?.x ?? 0, y: cursor?.y ?? 0 } };
  }
  const previousZoom = clampMapZoom(view?.zoom);
  const ratio = previousZoom / zoom;
  return {
    zoom,
    center: {
      x: cursor.x + (center.x - cursor.x) * ratio,
      y: cursor.y + (center.y - cursor.y) * ratio,
    },
  };
}

// Pan by a screen drag. Positive dxPx moves the pointer right, positive dyPx
// moves it down; the content follows the pointer, so the centre moves the
// opposite way in screen space (map y is flipped: down on screen is south).
export function panMapViewByPixels(view, dxPx, dyPx, metresPerPixel) {
  const zoom = clampMapZoom(view?.zoom);
  const center = view?.center;
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    return { zoom, center: { x: 0, y: 0 } };
  }
  const mpp = Number.isFinite(metresPerPixel) && metresPerPixel > 0 ? metresPerPixel : 1;
  const dx = Number.isFinite(dxPx) ? dxPx : 0;
  const dy = Number.isFinite(dyPx) ? dyPx : 0;
  return {
    zoom,
    center: { x: center.x - dx * mpp, y: center.y + dy * mpp },
  };
}

// SVG viewBox in screen coordinates (y down) for the current view. Rendering
// flips the vertical axis through toScreenPoint; this is the only place the
// flip happens.
export function mapViewBox(view, battlefield) {
  const base = baseViewSize(battlefield);
  const height = Number(battlefield?.height);
  if (!base || !Number.isFinite(height)) {
    return { x: 0, y: 0, width: 100, height: 100 };
  }
  const zoom = clampMapZoom(view?.zoom);
  const center = view?.center;
  const width = base.width / zoom;
  const viewHeight = base.height / zoom;
  const centerScreenX = center && Number.isFinite(center.x) ? center.x : 0;
  const centerScreenY =
    center && Number.isFinite(center.y) ? height - center.y : height / 2;
  return {
    x: centerScreenX - width / 2,
    y: centerScreenY - viewHeight / 2,
    width,
    height: viewHeight,
  };
}

export function metresPerPixel(view, battlefield, viewportWidthPx) {
  const viewport = Number(viewportWidthPx);
  if (!Number.isFinite(viewport) || viewport <= 0) return 1;
  return mapViewBox(view, battlefield).width / viewport;
}

const SCALE_BAR_STEPS_M = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

// Pick a human-readable scale bar length (metres) whose on-screen width is
// close to targetPx without exceeding maxPx.
export function niceScaleBarMetres(mpp, targetPx = 120, maxPx = 180) {
  const perPixel = Number.isFinite(mpp) && mpp > 0 ? mpp : 1;
  const target = Number.isFinite(targetPx) && targetPx > 0 ? targetPx : 120;
  const max = Number.isFinite(maxPx) && maxPx > 0 ? maxPx : 180;
  let fallback = SCALE_BAR_STEPS_M[0];
  for (const step of SCALE_BAR_STEPS_M) {
    if (step / perPixel <= max) fallback = step;
    if (step / perPixel >= target) return step;
  }
  return fallback;
}

// --- Unit footprint (ADR 0001, ADR 0002) ------------------------------------
// A unit occupies a true-scale rectangular footprint derived from its
// soldiers, files, and two spacings stored in metres on the unit: the lateral
// interval per file and the depth per rank. Ranks follow as
// ceil(soldiers / files); frontage = files x lateral interval;
// depth = ranks x rank depth. Rendering must draw exactly this rectangle:
// never enlarged for display.
function numericField(unit, names) {
  for (const name of names) {
    const value = unit?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return undefined;
}

// Read the map position of a unit. Accepts { position: { x, y } } as well as
// flat { x, y } shapes used across prototype sketches. Returns null when the
// position is missing or not finite.
export function unitPosition(unit) {
  if (!unit || typeof unit !== 'object') return null;
  const nested = unit.position;
  const x =
    nested && Number.isFinite(Number(nested.x))
      ? Number(nested.x)
      : Number.isFinite(Number(unit.x))
        ? Number(unit.x)
        : Number.NaN;
  const y =
    nested && Number.isFinite(Number(nested.y))
      ? Number(nested.y)
      : Number.isFinite(Number(unit.y))
        ? Number(unit.y)
        : Number.NaN;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x, y };
}

// Compass bearing of the unit's front in degrees (0 = north, 90 = east).
// Accepts `facingDeg`, `facing`, or `angle` spellings from prototype data.
export function unitFacingDeg(unit) {
  const value = numericField(unit, ['facingDeg', 'facing', 'angle', 'headingDeg']);
  if (value === undefined) return 0;
  let normalised = value % 360;
  if (normalised > 180) normalised -= 360;
  if (normalised <= -180) normalised += 360;
  return normalised;
}

export function unitFootprint(unit) {
  if (!unit || typeof unit !== 'object') return null;
  const explicitFrontage = numericField(unit, ['frontageM', 'frontage']);
  const explicitDepth = numericField(unit, ['depthM', 'depth']);
  if (explicitFrontage !== undefined && explicitDepth !== undefined) {
    if (explicitFrontage <= 0 || explicitDepth <= 0) return null;
    const ranks = numericField(unit, ['ranks']);
    return {
      ranks: ranks !== undefined && ranks > 0 ? Math.ceil(ranks) : null,
      frontageM: explicitFrontage,
      depthM: explicitDepth,
    };
  }
  const files = numericField(unit, ['files']);
  const soldiers = numericField(unit, ['soldiers', 'strength']);
  const lateral = numericField(unit, [
    'lateralIntervalM',
    'lateralInterval',
    'intervalM',
    'spacingM',
    'spacing',
  ]);
  const rankDepth = numericField(unit, ['rankDepthM', 'rankDepth', 'depthPerRankM']);
  const givenRanks = numericField(unit, ['ranks']);
  if (!Number.isFinite(files) || files <= 0) return null;
  let ranks = null;
  if (Number.isFinite(soldiers) && soldiers > 0) {
    ranks = Math.ceil(soldiers / files);
  } else if (Number.isFinite(givenRanks) && givenRanks > 0) {
    ranks = Math.ceil(givenRanks);
  }
  if (ranks === null || ranks <= 0) return null;
  if (!Number.isFinite(lateral) || lateral <= 0) return null;
  if (!Number.isFinite(rankDepth) || rankDepth <= 0) return null;
  return { ranks, frontageM: files * lateral, depthM: ranks * rankDepth };
}

// --- Order of battle editing helpers (framework-free) ------------------------
// The editor places new and duplicated units automatically: the author never
// types coordinates. These helpers stay in the domain model so unit tests
// cover them without a browser.

// A provisional ruleset version is any `0.x` version: the catalogue-only
// `polis-classical 0.1` the editor is built against. The editor badges it as
// provisional; the installed `1.x` ruleset can still start `0.1` scenarios
// (see `isCompatibleScenarioRuleset` in `polis-classical.js`).
export function isProvisionalRulesetVersion(version) {
  return typeof version === 'string' && /^0(\.|$)/.test(version.trim());
}

export function isProvisionalRuleset(ruleset) {
  return !!ruleset && isProvisionalRulesetVersion(ruleset?.version);
}

// --- Ruleset reference compatibility (decision #5 items 10-13) ----------------
// A scenario records only a reference to its ruleset ({ identifier, version });
// it never embeds the catalogue. The installed catalogue is the current
// `RULESET_ID` at `RULESET_VERSION`. These helpers are pure and catalogue-free
// (they compare references only, never troop-type membership), so they live in
// the domain model next to the reference itself.

// Compare two dotted version strings numerically per chunk (`0.10` is newer
// than `0.2`; a missing chunk is 0, so `0.1` equals `0.1.0`). Non-numeric
// chunks compare lexically and sort after numeric ones. Returns -1, 0, or 1.
export function compareRulesetVersions(left, right) {
  const chunks = (value) =>
    String(value ?? '')
      .trim()
      .split('.')
      .map((chunk) => chunk.trim());
  const leftChunks = chunks(left);
  const rightChunks = chunks(right);
  const length = Math.max(leftChunks.length, rightChunks.length);
  for (let index = 0; index < length; index += 1) {
    const leftChunk = leftChunks[index] ?? '0';
    const rightChunk = rightChunks[index] ?? '0';
    if (leftChunk === rightChunk) {
      continue;
    }
    const leftNumber = Number(leftChunk);
    const rightNumber = Number(rightChunk);
    const leftNumeric = leftChunk !== '' && Number.isInteger(leftNumber) && leftNumber >= 0;
    const rightNumeric = rightChunk !== '' && Number.isInteger(rightNumber) && rightNumber >= 0;
    if (leftNumeric && rightNumeric) {
      return leftNumber < rightNumber ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1;
    }
    return leftChunk < rightChunk ? -1 : 1;
  }
  return 0;
}

// Classify a scenario's ruleset reference against the installed catalogue.
// Statuses: 'current' (same identifier and version), 'older' (same
// identifier, older version: opens, keys resolve against the current
// catalogue, an explicit Save rebinds), 'newer' (same identifier, newer
// version: not opened), 'unknown-ruleset' (another identifier: not opened),
// 'invalid' (the reference is missing or malformed). Never throws.
export function classifyRulesetReference(ruleset, options = {}) {
  const current =
    options.current && typeof options.current === 'object'
      ? options.current
      : { id: RULESET_ID, version: RULESET_VERSION };
  const currentId = current.id;
  const currentVersion = current.version;
  if (!ruleset || typeof ruleset !== 'object' || Array.isArray(ruleset)) {
    return { status: 'invalid', cause: 'ruleset reference is required' };
  }
  if (!isNonEmptyString(ruleset.id) || !isNonEmptyString(ruleset.version)) {
    return { status: 'invalid', cause: 'ruleset reference must hold an identifier and a version' };
  }
  if (!KNOWN_RULESET_IDS.includes(ruleset.id) || ruleset.id !== currentId) {
    return {
      status: 'unknown-ruleset',
      cause: `unknown ruleset "${ruleset.id}" (this editor supports "${currentId}")`,
    };
  }
  const comparison = compareRulesetVersions(ruleset.version, currentVersion);
  if (comparison === 0) {
    return { status: 'current', cause: null };
  }
  if (comparison < 0) {
    return {
      status: 'older',
      cause:
        `this scenario was written for ${ruleset.id} ${ruleset.version}; ` +
        `the installed catalogue is ${currentVersion}`,
    };
  }
  return {
    status: 'newer',
    cause:
      `this scenario needs ruleset ${ruleset.id} ${ruleset.version}, ` +
      `newer than the installed ${currentVersion}; the stored data was left untouched`,
  };
}

// True when the reference opens in this editor: the current version or an
// older version of the same ruleset. Unknown identifiers, newer versions, and
// malformed references never open.
export function isOpenableRulesetReference(ruleset, options = {}) {
  const { status } = classifyRulesetReference(ruleset, options);
  return status === 'current' || status === 'older';
}

// The informational issues-panel entry for a scenario whose ruleset reference
// is older than the installed catalogue, or null when no entry applies. The
// editor shows it alongside warnings; an explicit Save rebinds the reference.
export function rulesetCompatibilityNotice(ruleset, options = {}) {
  const classification = classifyRulesetReference(ruleset, options);
  if (classification.status !== 'older') {
    return null;
  }
  const current =
    options.current && typeof options.current === 'object'
      ? options.current
      : { id: RULESET_ID, version: RULESET_VERSION };
  return (
    `This scenario was written for ${ruleset.id} ${ruleset.version}; ` +
    `the installed catalogue is ${current.version}. Troop types resolve against ` +
    `the current catalogue. Saving rebinds the scenario to ${current.version}.`
  );
}

// Return a copy of the document whose ruleset reference is rebound to the
// installed catalogue. Used only on an explicit Save of a scenario whose
// reference is older; opening never rebinds. Never mutates its input.
export function rebindRulesetToCurrent(document, options = {}) {
  const current =
    options.current && typeof options.current === 'object'
      ? options.current
      : { id: RULESET_ID, version: RULESET_VERSION };
  const copy = cloneScenario(document);
  copy.ruleset = { id: current.id, version: current.version };
  return copy;
}

// Suggest a unit name that is unique across the document (case-insensitive on
// the trimmed name). Returns `base` when it is free, else `base 2`, `base 3`,
// and so on. Pure.
export function suggestUnitName(document, base = 'New Unit') {
  const units = Array.isArray(document?.units) ? document.units : [];
  const taken = new Set(
    units
      .filter((unit) => unit && isNonEmptyString(unit.name))
      .map((unit) => unit.name.trim().toLowerCase()),
  );
  const stem = isNonEmptyString(base) ? base.trim() : 'New Unit';
  if (!taken.has(stem.toLowerCase())) {
    return stem;
  }
  let counter = 2;
  while (taken.has(`${stem} ${counter}`.toLowerCase())) {
    counter += 1;
  }
  return `${stem} ${counter}`;
}

// Default facing for a new unit of a side: the first side faces south (180)
// and the second faces north (0), so opposing deployments face each other as
// in the acceptance scenario. Unknown sides face north.
export function defaultFacingForSide(document, sideId) {
  const sides = Array.isArray(document?.sides) ? document.sides : [];
  const index = sides.findIndex((side) => side?.id === sideId);
  if (index === 0) {
    return 180;
  }
  return 0;
}

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

// --- Undo history (framework-free) ------------------------------------------
// The editing session keeps whole-document snapshots: every committed change
// (properties, terrain, units, placements, rotations) pushes the previous
// document and clears the redo stack, so every tool that commits through
// these helpers is undoable with no extra work. View navigation and selection
// are never recorded. History is not saved with the scenario. Pure: snapshots
// are treated as opaque values and never mutated.

export function createHistory() {
  return { past: [], future: [] };
}

// Record `snapshot` (the document before a committed change) and drop the
// redo stack. Returns the next history value.
export function historyCommit(history, snapshot) {
  const past = Array.isArray(history?.past) ? history.past : [];
  return { past: [...past, snapshot], future: [] };
}

// Step back to the most recent snapshot, holding `current` for redo. Returns
// null when there is nothing to undo: { history, document } otherwise.
export function historyUndo(history, current) {
  const past = Array.isArray(history?.past) ? history.past : [];
  const future = Array.isArray(history?.future) ? history.future : [];
  if (past.length === 0) {
    return null;
  }
  const previous = past.slice(0, -1);
  return {
    history: { past: previous, future: [...future, current] },
    document: past[past.length - 1],
  };
}

// Step forward to the most recently undone snapshot, holding `current` for
// undo. Returns null when there is nothing to redo.
export function historyRedo(history, current) {
  const past = Array.isArray(history?.past) ? history.past : [];
  const future = Array.isArray(history?.future) ? history.future : [];
  if (future.length === 0) {
    return null;
  }
  const remaining = future.slice(0, -1);
  return {
    history: { past: [...past, current], future: remaining },
    document: future[future.length - 1],
  };
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
