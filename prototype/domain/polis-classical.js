// PÓLIS ruleset package `polis-classical` 1.0 (framework-free).
//
// The first ruleset with mechanics. It keeps the six stable troop-type keys of
// the provisional catalogue-only `0.1`, with the same presets, permitted
// ranges, spacing thresholds, and missile ranges. A parameter change bumps the
// minor version; removing a key or changing a mechanism bumps the major
// version.
//
// Parameters live in the versioned data file
// `./polis-classical-parameters-1.0.json` (placeholder values; the Engine II
// gate sets them). The `RULESET_PARAMETERS` constant below mirrors that file
// so the browser build and the engine share one snapshot without file access;
// unit tests assert the two stay identical. Battle start snapshots the
// parameters and records the version actually used.
//
// Compatibility: the installed ruleset declares which scenario ruleset
// versions it can start. By default this is the same identifier and the same
// major version; `polis-classical` `1.x` also accepts the provisional `0.1`,
// because it keeps the same troop-type keys. Anything else is refused as an
// incompatible ruleset reference. Starting a battle never changes the
// scenario's own ruleset reference.
//
// Catalogue membership stays a playability concern, never a structural one:
// structural validation must not consult this package.

export const RULESET_ID = 'polis-classical';
export const RULESET_VERSION = '1.0';

// The provisional catalogue-only version the editor was built against. The
// only `0.x` version the installed `1.x` ruleset can start.
export const PROVISIONAL_SCENARIO_VERSION = '0.1';

// Versioned parameter snapshot (placeholder values; the Engine II gate sets
// them). Mirrors `./polis-classical-parameters-1.0.json`, which is canonical.
export const RULESET_PARAMETERS_FILE = 'polis-classical-parameters-1.0.json';

export const RULESET_PARAMETERS = Object.freeze({
  ruleset: Object.freeze({ id: 'polis-classical', version: '1.0' }),
  status: 'placeholder',
  note: 'Placeholder values. Battle start only snapshots them; the Engine II gate sets them.',
  battle: Object.freeze({
    roundLimit: 12,
    breakLossShare: 0.5,
    drawMarginShare: 0.05,
  }),
  cohesion: Object.freeze({
    start: 'Steady',
    states: Object.freeze(['Steady', 'Disordered', 'Routed']),
  }),
  // Manoeuvre on open ground (Engine I slice). A unit marches with 1-3 legs
  // per Move; displacements within `forwardArcDeg` of the facing bill at the
  // full rate, steeper, sideways, and backward steps bill
  // `1 / restrictedRateFactor` per metre, and a facing change about the front
  // midpoint bills `frontageM * angleRad * wheelFactor` metres. `allowanceM`
  // is the distance one turn buys on open ground, per troop type. `terrain`
  // adjusts that billing for ground cover (see below). Initial values for the
  // manoeuvre slice; the Engine II gate sets the fighting parameters.
  //
  // Terrain and movement (decision #6 items 14-15). The terrain that applies
  // to a unit is the worst ground cover its footprint touches, ranked
  // open < rough < forest = settlement < water. Water is impassable; any other
  // cover bills a factor per metre marched or wheeled: open bills 1, rough
  // bills `roughFactor`, forest and settlement bill `forestFactor`. A road
  // bills `roadFactor` instead, but only for units in column (files at or
  // below `columnMaxFiles`); out of column the road is ignored and the ground
  // cover decides. A river is crossable everywhere: a move whose swept
  // footprint touches a river feature adds `riverCostM` once per feature
  // touched, on top of the factored distance, however many legs the crossing
  // is split across. Elevation imposes no movement penalty and is never
  // consulted here.
  //
  // How cost accumulates along a leg that crosses terrain boundaries: a march
  // is split into 1 m subsegments and each subsegment bills
  // `(length / directionalRate) * factorAtMidpoint`, where `directionalRate`
  // is 1 inside the frontal arc and `restrictedRateFactor` outside it, and
  // `factorAtMidpoint` is the worst-cover factor (or the road factor, when
  // eligible) of the footprint centred on that subsegment's midpoint. A wheel
  // bills `frontageM * angleRad * wheelFactor * factorAtStart`, with the
  // factor read from the footprint before the rotation. The required total is
  // rounded to 0.1 m and billed against the open-ground `allowanceM`; the
  // movement allowance shown in the available actions is the open-ground
  // allowance divided by the factor at the unit's current footprint
  // (`base / factor`, rounded to 0.1 m, 0 on water), so a unit standing in
  // rough ground shows less reach. The flat river fee is not part of that
  // allowance: it is added per move at validation time.
  movement: Object.freeze({
    maxLegs: 3,
    forwardArcDeg: 45,
    restrictedRateFactor: 0.5,
    wheelFactor: 0.5,
    allowanceM: Object.freeze({
      hoplite: 90,
      peltast: 140,
      archer: 110,
      slinger: 110,
      light_cavalry: 240,
      cavalry: 200,
    }),
    terrain: Object.freeze({
      roughFactor: 1.5,
      forestFactor: 2.5,
      roadFactor: 0.7,
      columnMaxFiles: 4,
      riverCostM: 30,
    }),
  }),
});

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

// --- Ruleset version compatibility ------------------------------------------
// The installed ruleset declares which scenario ruleset versions it can
// start: the same identifier and the same major version, plus the provisional
// `0.1` for `polis-classical` `1.x`. Anything else is refused as an
// incompatible ruleset reference.

// The major version of a ruleset version string, or null when it cannot be
// read. Never throws.
export function rulesetMajor(version) {
  if (typeof version !== 'string') {
    return null;
  }
  const match = /^\s*(\d+)\b/.exec(version);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

// True when a scenario carrying `reference` ({ id, version }) may start a
// battle under the installed ruleset. Pure. Never throws.
export function isCompatibleScenarioRuleset(reference) {
  if (!reference || typeof reference !== 'object') {
    return false;
  }
  if (reference.id !== RULESET_ID) {
    return false;
  }
  if (typeof reference.version !== 'string') {
    return false;
  }
  const installedMajor = rulesetMajor(RULESET_VERSION);
  if (reference.version.trim() === PROVISIONAL_SCENARIO_VERSION) {
    // Only `1.x` extends compatibility to the provisional catalogue.
    return installedMajor === 1;
  }
  const scenarioMajor = rulesetMajor(reference.version);
  if (scenarioMajor === null) {
    return false;
  }
  return scenarioMajor === installedMajor;
}
