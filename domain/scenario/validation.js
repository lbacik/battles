// PÓLIS scenario model — structural validation (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

import {
  deriveFootprint,
  isSimplePolygon,
  polygonArea,
  polygonInsideOrOn,
  polygonsOverlapPositiveArea,
  pointsWithinBounds,
  shrinkFootprint,
} from '../geometry.js';

import { GROUND_COVER_CATEGORIES, LINEAR_FEATURE_CATEGORIES, MAX_BATTLEFIELD_HEIGHT_M, MAX_BATTLEFIELD_WIDTH_M, MAX_SPACING_M, SCENARIO_FORMAT_VERSION, SCENARIO_KIND, isNonEmptyString } from './document.js';

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

export function unitLabel(unit, index) {
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
