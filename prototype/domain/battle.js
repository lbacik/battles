// PÓLIS engine — battle start: playability validation and the initial battle
// state (framework-free).
//
// This module is the first slice of the framework-free engine package: it
// decides whether a structurally valid scenario may start a battle under the
// installed `polis-classical` ruleset and, if so, creates the battle's initial
// state. It imports only the domain model, the ruleset package, and the plane
// geometry helpers — no React, no Next.js, no DOM, no Node APIs — so it runs
// unchanged in the browser editor, in Node unit tests, and in any future
// shell.
//
// Playability validation (CONTEXT.md) checks, by the ruleset, whether a
// structurally valid scenario can start a battle: an incompatible ruleset
// reference, an unknown troop-type key, a spacing outside the troop type's
// permitted range, a footprint touching water, opposing footprints touching,
// or a side with no units. Touching friendly footprints stays legal. It is
// pure: it never changes the scenario and lists every problem, naming the
// unit (or side) and the reason.
//
// Starting a battle snapshots the scenario, records the ruleset identifier,
// the version actually used, and a parameter snapshot, the seed and the
// generator state, the starting side drawn from the seed, the controller of
// each side, and round 1. The battle reuses the scenario's id as its battle
// id, opens on turn 1 with the starting side active in the `orders` phase,
// and stays `ongoing` until a side concedes. Every unit starts Steady. The
// scenario's own ruleset reference is never changed.
//
// The seeded random generator belongs to the engine: `createRng` builds it
// from the battle seed, and every draw is recorded as an event on the battle.

import {
  deriveFootprint,
  locatePoint,
  segmentsIntersect,
} from './geometry.js';
import {
  RULESET_ID as INSTALLED_RULESET_ID,
  RULESET_VERSION as INSTALLED_RULESET_VERSION,
  RULESET_PARAMETERS,
  TROOP_TYPE_CATALOGUE,
  isCompatibleScenarioRuleset,
  isKnownTroopType,
} from './polis-classical.js';
import { cloneScenario, validateScenario } from './scenario.js';

export const BATTLE_KIND = 'battle';
export const STARTING_ROUND = 1;
export const STARTING_TURN_NUMBER = 1;

// The phase a battle rests in while it waits for the active side's orders.
// Resolution runs the Movement, Shooting, Combat, and Cohesion phases and
// returns to `orders` for the next turn.
export const TURN_PHASE_ORDERS = 'orders';

export const BATTLE_STATUS_ONGOING = 'ongoing';
export const BATTLE_STATUS_CONCEDED = 'conceded';

export const STEADY_COHESION = 'Steady';
export const COHESION_STATES = Object.freeze(['Steady', 'Disordered', 'Routed']);

// Controllers assignable per side at battle start: human players and the
// automated test players of #8 item 4 (`random`, `passive`; `automated` is the
// ADR 0005 term for a non-human player). A future LLM player arrives later.
export const CONTROLLERS = Object.freeze(['human', 'random', 'passive', 'automated']);

export const RANDOM_DRAW_EVENT = 'random-draw';

// --- Seeded random generator (engine-owned) ----------------------------------
// Mulberry32: small, deterministic, and framework-free. The battle seed fixes
// the whole sequence, so replaying the seed reproduces every draw. Every draw
// the engine makes is recorded as an event on the battle; the generator state
// travels in the battle so resolution can continue the same sequence.

function hashSeedString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Normalise a battle seed to an unsigned 32-bit integer. An integer seed is
// used as-is; a decimal string is read as an integer; any other non-empty
// string is hashed. The seed is always set programmatically — by tests,
// fuzzing, and the end-to-end harness, or by the setup screen drawing it
// before the call — so an omitted seed throws instead of touching ambient
// randomness and breaking replay. Throws on anything else.
export function normalizeSeed(seed) {
  if (seed === undefined) {
    throw new Error(
      'Starting a battle requires a seed (set programmatically by tests, fuzzing, the harness, or the setup screen).',
    );
  }
  if (typeof seed === 'number') {
    if (!Number.isInteger(seed)) {
      throw new Error('Battle seed must be an integer or a string.');
    }
    return seed >>> 0;
  }
  if (typeof seed === 'string') {
    const trimmed = seed.trim();
    if (trimmed === '') {
      throw new Error('Battle seed must be an integer or a non-empty string.');
    }
    if (/^-?\d+$/.test(trimmed)) {
      return Number(trimmed) >>> 0;
    }
    return hashSeedString(seed);
  }
  throw new Error('Battle seed must be an integer or a string.');
}

// Build the engine generator from an unsigned 32-bit seed. `next()` draws a
// float in [0, 1) and advances the state, readable at any time via `state`.
export function createRng(seed) {
  let state = seed >>> 0;
  return {
    get state() {
      return state >>> 0;
    },
    next() {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
  };
}

// --- Playability validation ---------------------------------------------------

function unitLabel(unit, index) {
  const name =
    unit && typeof unit.name === 'string' && unit.name.trim().length > 0
      ? unit.name.trim()
      : 'unnamed';
  return `units[${index}] "${name}"`;
}

function sideLabel(side) {
  const name =
    side && typeof side.name === 'string' && side.name.trim().length > 0
      ? side.name.trim()
      : 'unnamed';
  return `side "${name}" (${side?.id ?? 'missing id'})`;
}

function describeRuleset(reference) {
  if (!reference || typeof reference !== 'object') {
    return 'missing';
  }
  const id = typeof reference.id === 'string' && reference.id ? reference.id : 'missing id';
  const version =
    typeof reference.version === 'string' && reference.version ? reference.version : 'missing version';
  return `"${id} ${version}"`;
}

function unitRef(unit, index) {
  return {
    unitIndex: index,
    unitId: typeof unit?.id === 'string' ? unit.id : null,
    unitName:
      typeof unit?.name === 'string' && unit.name.trim().length > 0 ? unit.name.trim() : null,
  };
}

// Deep clone a JSON-shaped value. `cloneScenario` stays reserved for whole
// scenario documents; this helper covers units, parameters, and other parts.
function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function footprintCorners(unit) {
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

// True when two footprint rings touch in any way: overlapping with positive
// area, sharing an edge, or meeting at a point. Boundary contact counts,
// because playability refuses any opposing touch while structural validation
// already tolerates sub-0.1 m overlaps as touching.
function ringsTouch(a, b) {
  for (let i = 0; i < a.length; i += 1) {
    const p = a[i];
    const q = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j += 1) {
      if (segmentsIntersect(p, q, b[j], b[(j + 1) % b.length])) {
        return true;
      }
    }
  }
  if (a.some((point) => locatePoint(b, point) !== 'outside')) {
    return true;
  }
  if (b.some((point) => locatePoint(a, point) !== 'outside')) {
    return true;
  }
  return false;
}

// Ground cover water areas: every place whose category is `water`. Linear
// river features are not water here: they have their own category and their
// own future mechanics; only ground cover `water` refuses a battle start.
function waterAreas(scenario) {
  return (scenario.terrainFeatures || []).filter(
    (feature) =>
      feature &&
      feature.kind === 'ground' &&
      feature.category === 'water' &&
      Array.isArray(feature.polygon) &&
      feature.polygon.length >= 3,
  );
}

// Check, by the ruleset, whether a scenario can start a battle. Returns a
// list of problems, each naming the unit (or side) and the reason; an empty
// list means the scenario is playable. Pure: it never mutates the scenario.
// A problem is `{ code, unitIndex, unitId, unitName, side, message }`; global
// problems (the ruleset reference, an empty side) carry no unit.
export function validatePlayability(scenario) {
  const problems = [];
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    return [
      {
        code: 'invalid-scenario',
        unitIndex: -1,
        unitId: null,
        unitName: null,
        side: null,
        message: 'Cannot start a battle: the scenario must be an object.',
      },
    ];
  }
  if (!isCompatibleScenarioRuleset(scenario.ruleset)) {
    problems.push({
      code: 'incompatible-ruleset',
      unitIndex: -1,
      unitId: null,
      unitName: null,
      side: null,
      message:
        `Cannot start a battle: ruleset ${describeRuleset(scenario.ruleset)} is incompatible ` +
        `with the installed ruleset "${INSTALLED_RULESET_ID} ${INSTALLED_RULESET_VERSION}".`,
    });
  }
  const units = Array.isArray(scenario.units) ? scenario.units : [];
  const sides = Array.isArray(scenario.sides) ? scenario.sides : [];
  const footprints = units.map((unit, index) => {
    if (!unit || typeof unit !== 'object') {
      return null;
    }
    const label = unitLabel(unit, index);
    const ref = unitRef(unit, index);
    if (!isKnownTroopType(unit.troopType)) {
      problems.push({
        code: 'unknown-troop-type',
        ...ref,
        side: typeof unit.side === 'string' ? unit.side : null,
        message: `${label}: unknown troop-type key "${String(unit.troopType)}".`,
      });
    } else {
      const entry = TROOP_TYPE_CATALOGUE[unit.troopType];
      for (const field of ['lateralInterval', 'rankDepth']) {
        const value = unit[field];
        const range = entry.permittedRanges[field];
        if (!Number.isFinite(value) || value < range.min || value > range.max) {
          const shown = Number.isFinite(value) ? `${value} m` : String(value);
          problems.push({
            code: 'spacing-out-of-range',
            ...ref,
            side: typeof unit.side === 'string' ? unit.side : null,
            message:
              `${label}: ${field} ${shown} is outside the permitted range ` +
              `${range.min}-${range.max} m for troop type "${unit.troopType}".`,
          });
        }
      }
    }
    return footprintCorners(unit);
  });
  const waters = waterAreas(scenario);
  units.forEach((unit, index) => {
    const ring = footprints[index];
    if (!unit || typeof unit !== 'object' || !ring) {
      return;
    }
    for (const water of waters) {
      if (ringsTouch(ring, water.polygon)) {
        problems.push({
          code: 'footprint-in-water',
          ...unitRef(unit, index),
          side: typeof unit.side === 'string' ? unit.side : null,
          message: `${unitLabel(unit, index)}: footprint touches water (feature "${water.id}").`,
        });
      }
    }
  });
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      const a = units[i];
      const b = units[j];
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
        continue;
      }
      if (a.side === b.side) {
        continue;
      }
      if (!footprints[i] || !footprints[j]) {
        continue;
      }
      if (ringsTouch(footprints[i], footprints[j])) {
        problems.push({
          code: 'opposing-footprints-touch',
          ...unitRef(a, i),
          side: typeof a.side === 'string' ? a.side : null,
          otherUnitIndex: j,
          otherUnitId: typeof b.id === 'string' ? b.id : null,
          message:
            `${unitLabel(a, i)} and ${unitLabel(b, j)}: ` +
            'opposing footprints touch (touching friendly footprints is legal).',
        });
      }
    }
  }
  for (const side of sides) {
    const count = units.filter((unit) => unit && unit.side === side?.id).length;
    if (count === 0) {
      problems.push({
        code: 'side-without-units',
        unitIndex: -1,
        unitId: null,
        unitName: null,
        side: side?.id ?? null,
        message: `${sideLabel(side)} fields no units.`,
      });
    }
  }
  return problems;
}

// True when `validatePlayability` reports no problems. Pure.
export function isPlayable(scenario) {
  return validatePlayability(scenario).length === 0;
}

// --- Battle start -------------------------------------------------------------

// Thrown by `startBattle` when playability validation refuses the scenario.
// Carries every problem so the caller can list them and offer "Open in
// editor". No battle is created.
export class BattleStartError extends Error {
  constructor(problems) {
    super(`Cannot start battle: ${problems.map((problem) => problem.message).join('; ')}`);
    this.name = 'BattleStartError';
    this.code = 'unplayable-scenario';
    this.problems = problems;
  }
}

function normalizeControllers(scenario, controllers) {
  if (!controllers || typeof controllers !== 'object' || Array.isArray(controllers)) {
    throw new Error(
      'Starting a battle requires a controller per side (an object mapping side id to controller).',
    );
  }
  const sideIds = (scenario.sides || []).map((side) => side?.id);
  const normalized = {};
  for (const id of sideIds) {
    if (controllers[id] === undefined) {
      throw new Error(`Starting a battle requires a controller for side "${id}".`);
    }
    const value = String(controllers[id]).toLowerCase();
    if (!CONTROLLERS.includes(value)) {
      throw new Error(
        `Unknown controller "${controllers[id]}" for side "${id}" (one of: ${CONTROLLERS.join(', ')}).`,
      );
    }
    normalized[id] = value;
  }
  for (const key of Object.keys(controllers)) {
    if (!sideIds.includes(key)) {
      throw new Error(`Unknown side "${key}" in controllers.`);
    }
  }
  return normalized;
}

// Start a battle from a scenario, a seed, and a controller per side. Returns
// the battle's initial state: a scenario snapshot, the ruleset identifier,
// the version actually used, and a parameter snapshot, the seed and the
// generator state, the starting side drawn from the seed, the controllers,
// round 1, and the turn tracking (`turnNumber` 1, `activeSide` the starting
// side, phase `orders`, status `ongoing`). Every unit starts Steady. Pure
// apart from drawing an omitted seed: the scenario is never changed, and its
// ruleset reference keeps whatever version it carried. Throws when the
// scenario is structurally invalid, when a controller is missing or unknown,
// or — with a `BattleStartError` carrying every problem — when the scenario
// is unplayable.
export function startBattle(scenario, options = {}) {
  const { seed, controllers } = options;
  const normalizedControllers = normalizeControllers(scenario, controllers);
  const structural = validateScenario(scenario);
  if (structural.length > 0) {
    throw new Error(`Cannot start battle: ${structural.join('; ')}`);
  }
  const problems = validatePlayability(scenario);
  if (problems.length > 0) {
    throw new BattleStartError(problems);
  }
  const seed32 = normalizeSeed(seed);
  const rng = createRng(seed32);
  const draw = rng.next();
  const sides = scenario.sides;
  // Structural validation (checked above) guarantees exactly two sides.
  const startingSide = draw < 0.5 ? sides[0].id : sides[1].id;
  const events = [
    {
      seq: 0,
      type: RANDOM_DRAW_EVENT,
      purpose: 'starting-side',
      value: draw,
      result: startingSide,
    },
  ];
  return {
    kind: BATTLE_KIND,
    id: scenario.id,
    scenario: cloneScenario(scenario),
    ruleset: { id: INSTALLED_RULESET_ID, version: INSTALLED_RULESET_VERSION },
    parameters: cloneValue(RULESET_PARAMETERS),
    seed: seed32,
    rngState: rng.state,
    startingSide,
    controllers: normalizedControllers,
    round: STARTING_ROUND,
    turnNumber: 1,
    activeSide: startingSide,
    phase: TURN_PHASE_ORDERS,
    status: BATTLE_STATUS_ONGOING,
    units: scenario.units.map((unit) => ({ ...cloneValue(unit), cohesion: STEADY_COHESION })),
    events,
  };
}
