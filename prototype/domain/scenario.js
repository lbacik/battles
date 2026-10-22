// PÓLIS tracer bullet — framework-free scenario model.
//
// This module is the framework-free domain package: it imports nothing —
// no React, no Next.js, no DOM, no Node APIs — so it runs unchanged in the
// browser editor, in Node unit tests, and in any future shell.
//
// Map convention (ADR 0001): the battlefield uses a map convention with the
// origin at the south-west corner, x east, y north, measured in metres.
// Only rendering flips the vertical axis for the screen (see toScreenPoint).

export const SCENARIO_KIND = 'scenario';
export const SCENARIO_FORMAT_VERSION = 1;

export const RULESET_ID = 'polis-classical';
export const RULESET_VERSION = '0.1';

// ADR 0001: true-scale footprints stay legible on a tactical battlefield of
// up to about 1-2 km. New scenarios default well inside that envelope.
export const MAX_BATTLEFIELD_WIDTH_M = 2000;
export const MAX_BATTLEFIELD_HEIGHT_M = 2000;
export const DEFAULT_BATTLEFIELD = Object.freeze({ width: 1200, height: 800 });

export const DEFAULT_SIDES = Object.freeze([
  Object.freeze({ id: 'side-a', name: 'Athenians', color: '#1d4ed8' }),
  Object.freeze({ id: 'side-b', name: 'Spartans', color: '#b91c1c' }),
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function generateId() {
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

// Create a new scenario document. The identifier is generated and immutable:
// it is assigned here and never changed afterwards. The title is required.
export function createScenario(input = {}) {
  const { title, battlefield, sides } = input;
  if (!isNonEmptyString(title)) {
    throw new Error('Scenario title is required.');
  }
  const document = {
    kind: SCENARIO_KIND,
    formatVersion: SCENARIO_FORMAT_VERSION,
    id: generateId(),
    title: title.trim(),
    battlefield: cloneBattlefield(battlefield),
    sides: cloneSides(sides),
    ruleset: { id: RULESET_ID, version: RULESET_VERSION },
    units: [],
    terrainFeatures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const errors = validateScenario(document);
  if (errors.length > 0) {
    throw new Error(`Invalid scenario: ${errors.join('; ')}`);
  }
  return document;
}

// Structural validation (CONTEXT.md): well-formedness on the scenario's own
// terms, without consulting any ruleset mechanics. Returns a list of human
// readable problems; an empty list means the document is structurally valid.
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
  const battlefield = document.battlefield;
  if (!battlefield || typeof battlefield !== 'object') {
    errors.push('battlefield is required');
  } else {
    for (const dimension of ['width', 'height']) {
      const value = battlefield[dimension];
      const limit =
        dimension === 'width' ? MAX_BATTLEFIELD_WIDTH_M : MAX_BATTLEFIELD_HEIGHT_M;
      if (!Number.isFinite(value) || value <= 0) {
        errors.push(`battlefield.${dimension} must be a positive number of metres`);
      } else if (value > limit) {
        errors.push(`battlefield.${dimension} must not exceed ${limit} m`);
      }
    }
  }
  if (!Array.isArray(document.sides) || document.sides.length !== 2) {
    errors.push('scenario must have exactly two sides');
  } else {
    document.sides.forEach((side, index) => {
      if (!side || !isNonEmptyString(side.name)) {
        errors.push(`sides[${index}].name is required`);
      }
      if (!side || !isNonEmptyString(side.color)) {
        errors.push(`sides[${index}].color is required`);
      }
    });
    const colors = document.sides
      .filter(Boolean)
      .map((side) => String(side.color).toLowerCase());
    if (new Set(colors).size !== colors.length) {
      errors.push('sides must have distinct colours');
    }
  }
  const ruleset = document.ruleset;
  if (!ruleset || ruleset.id !== RULESET_ID || ruleset.version !== RULESET_VERSION) {
    errors.push(`ruleset must be ${RULESET_ID} ${RULESET_VERSION}`);
  }
  if (!Array.isArray(document.units)) {
    errors.push('units must be an array');
  }
  if (!Array.isArray(document.terrainFeatures)) {
    errors.push('terrainFeatures must be an array');
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

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Deep clone a scenario document. Used by stores so callers can never
// mutate (or observe mutations of) the stored copy.
export function cloneScenario(document) {
  return JSON.parse(JSON.stringify(document));
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
