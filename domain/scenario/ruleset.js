// PÓLIS scenario model — unit geometry and ruleset references (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

import { KNOWN_RULESET_IDS, RULESET_ID, RULESET_VERSION, cloneScenario, isNonEmptyString } from './document.js';

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
