// PÓLIS scenario model — document constants, identity, and comparison (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

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

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function cloneBattlefield(battlefield) {
  if (!battlefield) return { ...DEFAULT_BATTLEFIELD };
  return { width: battlefield.width, height: battlefield.height };
}

export function cloneSides(sides) {
  if (!sides) return DEFAULT_SIDES.map((side) => ({ ...side }));
  return sides.map((side) => ({ id: side.id, name: side.name, color: side.color }));
}

// True when the working document holds no changes relative to the last saved
// version: the predicate behind the unsaved-changes indicator. Key order is
// ignored, and volatile save metadata (createdAt, updatedAt) is ignored —
// saving refreshes it without marking the scenario dirty — but every scenario
// property (title, description, battlefield, sides, units, terrain) counts.
const VOLATILE_METADATA_KEYS = new Set(['createdAt', 'updatedAt']);

function stripVolatile(value) {
  if (Array.isArray(value)) {
    return value.map(stripVolatile);
  }
  if (value && typeof value === 'object') {
    const entries = [];
    for (const [key, entry] of Object.entries(value)) {
      if (VOLATILE_METADATA_KEYS.has(key)) {
        continue;
      }
      entries.push([key, stripVolatile(entry)]);
    }
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return Object.fromEntries(entries);
  }
  return value;
}

export function scenarioContentEquals(left, right) {
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  return JSON.stringify(stripVolatile(left)) === JSON.stringify(stripVolatile(right));
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// Deep clone a scenario document. Used by stores so callers can never
// mutate (or observe mutations of) the stored copy.
export function cloneScenario(document) {
  return JSON.parse(JSON.stringify(document));
}
