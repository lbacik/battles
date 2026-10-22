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
  deriveFootprint,
  isSimplePolygon,
  locatePoint,
  polygonArea,
  polygonInsideOrOn,
  polygonsOverlapPositiveArea,
  pointsWithinBounds,
  round1,
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
// `polis-classical 0.1` the editor is built against. The editor badges it so
// authors know battles cannot start under it yet.
export function isProvisionalRulesetVersion(version) {
  return typeof version === 'string' && /^0(\.|$)/.test(version.trim());
}

export function isProvisionalRuleset(ruleset) {
  return !!ruleset && isProvisionalRulesetVersion(ruleset?.version);
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
