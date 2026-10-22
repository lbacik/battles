// PÓLIS provisional ruleset package `polis-classical` 0.1 (framework-free).
//
// The scenario editor binds every scenario to a ruleset from the start, but
// the first ruleset with mechanics does not exist yet. This package is the
// provisional catalogue-only ruleset the editor is built against: it holds
// the six stable troop-type keys, their display names, the spacing presets
// (close, normal, open) that pre-fill a unit's lateral interval and rank
// depth in the editor, the permitted spacing ranges, the spacing-class
// thresholds, and the missile range where a troop type has one.
//
// All numbers are placeholders. Quality variants (veterans, levies) would be
// further keys; none exist in the first ruleset. Catalogue membership is a
// playability concern, never a structural one: structural validation must
// not consult this package.
//
// A parameter change bumps the ruleset minor version; removing a key or
// changing a mechanism bumps the major version. The first ruleset with
// mechanics is `1.0` and keeps these keys.

import { RULESET_ID, RULESET_VERSION } from './scenario.js';

export { RULESET_ID, RULESET_VERSION };

export const TROOP_TYPE_KEYS = Object.freeze([
  'hoplite',
  'peltast',
  'archer',
  'slinger',
  'light_cavalry',
  'cavalry',
]);

// Spacing presets in metres: { lateralInterval, rankDepth }. The editor
// copies the chosen preset into the unit; the scenario stores the metres
// (ADR 0002), so later catalogue changes never reshape saved scenarios.
const TROOP_TYPES = {
  hoplite: {
    key: 'hoplite',
    displayName: 'Hoplites',
    role: 'close spacing, strong frontal fighter, depth endures',
    presets: {
      close: { lateralInterval: 0.9, rankDepth: 0.9 },
      normal: { lateralInterval: 1.8, rankDepth: 1.8 },
      open: { lateralInterval: 3.0, rankDepth: 3.0 },
    },
    permittedRanges: {
      lateralInterval: { min: 0.7, max: 4.0 },
      rankDepth: { min: 0.7, max: 4.0 },
    },
    spacingThresholds: { closeMax: 1.0, openMin: 2.5 },
    missileRange: null,
  },
  peltast: {
    key: 'peltast',
    displayName: 'Peltasts',
    role: 'open spacing, javelins, good in rough ground and forest',
    presets: {
      close: { lateralInterval: 0.9, rankDepth: 0.9 },
      normal: { lateralInterval: 1.5, rankDepth: 1.5 },
      open: { lateralInterval: 3.0, rankDepth: 3.0 },
    },
    permittedRanges: {
      lateralInterval: { min: 0.7, max: 5.0 },
      rankDepth: { min: 0.7, max: 5.0 },
    },
    spacingThresholds: { closeMax: 1.0, openMin: 2.5 },
    missileRange: 50,
  },
  archer: {
    key: 'archer',
    displayName: 'Archers',
    role: 'long range, very weak in melee',
    presets: {
      close: { lateralInterval: 0.9, rankDepth: 0.9 },
      normal: { lateralInterval: 1.5, rankDepth: 1.5 },
      open: { lateralInterval: 3.0, rankDepth: 3.0 },
    },
    permittedRanges: {
      lateralInterval: { min: 0.7, max: 5.0 },
      rankDepth: { min: 0.7, max: 5.0 },
    },
    spacingThresholds: { closeMax: 1.0, openMin: 2.5 },
    missileRange: 150,
  },
  slinger: {
    key: 'slinger',
    displayName: 'Slingers',
    role: 'medium range, weak in melee',
    presets: {
      close: { lateralInterval: 0.9, rankDepth: 0.9 },
      normal: { lateralInterval: 1.5, rankDepth: 1.5 },
      open: { lateralInterval: 3.0, rankDepth: 3.0 },
    },
    permittedRanges: {
      lateralInterval: { min: 0.7, max: 5.0 },
      rankDepth: { min: 0.7, max: 5.0 },
    },
    spacingThresholds: { closeMax: 1.0, openMin: 2.5 },
    missileRange: 120,
  },
  light_cavalry: {
    key: 'light_cavalry',
    displayName: 'Light cavalry',
    role: 'fast, javelins, avoids a hoplite front',
    presets: {
      close: { lateralInterval: 1.2, rankDepth: 2.0 },
      normal: { lateralInterval: 2.0, rankDepth: 3.0 },
      open: { lateralInterval: 3.5, rankDepth: 4.5 },
    },
    permittedRanges: {
      lateralInterval: { min: 1.0, max: 6.0 },
      rankDepth: { min: 1.5, max: 6.0 },
    },
    spacingThresholds: { closeMax: 1.5, openMin: 3.0 },
    missileRange: 40,
  },
  cavalry: {
    key: 'cavalry',
    displayName: 'Cavalry',
    role: 'fast, charge bonus, poor in forest, rough ground, and settlement',
    presets: {
      close: { lateralInterval: 1.0, rankDepth: 2.0 },
      normal: { lateralInterval: 1.8, rankDepth: 2.8 },
      open: { lateralInterval: 3.0, rankDepth: 4.0 },
    },
    permittedRanges: {
      lateralInterval: { min: 0.8, max: 6.0 },
      rankDepth: { min: 1.5, max: 6.0 },
    },
    spacingThresholds: { closeMax: 1.2, openMin: 2.5 },
    missileRange: null,
  },
};

for (const entry of Object.values(TROOP_TYPES)) {
  Object.freeze(entry.presets.close);
  Object.freeze(entry.presets.normal);
  Object.freeze(entry.presets.open);
  Object.freeze(entry.presets);
  Object.freeze(entry.permittedRanges.lateralInterval);
  Object.freeze(entry.permittedRanges.rankDepth);
  Object.freeze(entry.permittedRanges);
  Object.freeze(entry.spacingThresholds);
  Object.freeze(entry);
}

export const TROOP_TYPE_CATALOGUE = Object.freeze({ ...TROOP_TYPES });

export function getTroopType(key) {
  return TROOP_TYPE_CATALOGUE[key] || null;
}

export function isKnownTroopType(key) {
  return Object.hasOwn(TROOP_TYPE_CATALOGUE, key);
}

// --- Units whose troop type has left the catalogue (decision #5 item 13) -----
// Catalogue membership is a ruleset concern, never a structural one: structural
// validation stays silent (see scenario.js), and these helpers report what the
// editor must mark. The scenario opens, the unknown key is preserved verbatim
// in the document, the unit is shown with a neutral marking, the issues panel
// warns, the author may reassign a troop type, and saving stays allowed.
// Playability validation rejects such units at battle start. Pure.

// Every unit whose troop-type key is unknown to the installed catalogue, in
// document order: [{ index, id, name, troopType }]. Units without a troop-type
// string are structurally invalid, not unknown, so they are skipped here.
export function findUnknownTroopTypeUnits(document) {
  const units = Array.isArray(document?.units) ? document.units : [];
  const unknown = [];
  units.forEach((unit, index) => {
    if (!unit || typeof unit !== 'object') {
      return;
    }
    const key = unit.troopType;
    if (typeof key !== 'string' || key.trim() === '') {
      return;
    }
    if (!isKnownTroopType(key)) {
      unknown.push({ index, id: unit.id ?? null, name: unit.name ?? null, troopType: key });
    }
  });
  return unknown;
}

// One issues-panel warning per unit whose troop-type key is unknown. The key
// is quoted verbatim because it is preserved verbatim in the document.
export function collectUnknownTroopTypeWarnings(document) {
  return findUnknownTroopTypeUnits(document).map(({ name, troopType }) => {
    const label =
      typeof name === 'string' && name.trim() !== '' ? `"${name.trim()}"` : 'An unnamed unit';
    return (
      `${label} uses unknown troop type "${troopType}" (preserved verbatim). ` +
      `Reassign a troop type, or battle start will refuse it.`
    );
  });
}

// Spacing class derived from the lateral interval and the troop type's
// thresholds (never stored on the unit).
export function spacingClass(troopKey, lateralInterval) {
  const entry = getTroopType(troopKey);
  if (!entry || !Number.isFinite(lateralInterval)) {
    return null;
  }
  if (lateralInterval <= entry.spacingThresholds.closeMax) {
    return 'close';
  }
  if (lateralInterval >= entry.spacingThresholds.openMin) {
    return 'open';
  }
  return 'normal';
}
