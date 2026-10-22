// PÓLIS engine — turn contract: player view, available actions, order
// validation, and turn resolution (framework-free).
//
// The second slice of the framework-free engine package: two Passive players
// can play a battle turn after turn through the shared player contract and a
// runner (see `./players.js`), with Hold as the only order. This module is
// the tracer bullet for the whole turn contract of ADR 0005. It imports only
// the domain model, the ruleset package, and the plane geometry helpers —
// no React, no Next.js, no DOM, no Node APIs — so it runs unchanged in the
// browser, in Node unit tests, and in any future shell.
//
// The contract, per ADR 0005:
//
// - The player receives the player view, the available actions, and a
//   `validate` function, then returns one turn decision asynchronously:
//   commit a set of orders, or concede. The engine alone decides legality.
// - A commit is all or nothing: the engine re-validates every order against
//   the authoritative state and refuses the whole commit when any order is
//   rejected; it never silently drops an order.
// - The envelope (submission, player view, turn decision, rejection
//   structure) carries its own format version. The order kinds, their
//   parameters, and the rejection codes belong to the ruleset and change
//   with its major version.
//
// Turns alternate between the two sides (ADR 0004): one side gives its
// orders and has them resolved, then the other side does the same, and a
// pair of turns forms a round. Resolution runs the Movement, Shooting,
// Combat, and Cohesion phases — empty in this slice, because Hold is the
// only order — then passes the turn and counts rounds as pairs of turns.

import { deriveFootprint } from './geometry.js';
import { TROOP_TYPE_CATALOGUE } from './polis-classical.js';
import {
  BATTLE_STATUS_CONCEDED,
  BATTLE_STATUS_ONGOING,
  TURN_PHASE_ORDERS,
} from './battle.js';

// The format version carried by every contract envelope: the submission,
// the player view, the turn decision, and the available actions. Bump it
// when any envelope shape changes.
export const TURN_CONTRACT_VERSION = 1;
export const SUBMISSION_FORMAT_VERSION = TURN_CONTRACT_VERSION;
export const PLAYER_VIEW_FORMAT_VERSION = TURN_CONTRACT_VERSION;
export const AVAILABLE_ACTIONS_FORMAT_VERSION = TURN_CONTRACT_VERSION;

// Order kinds. Hold is the only permitted order in this slice; Move, Charge,
// and Shoot are known kinds the engine reports as unavailable until their
// slices land.
export const ORDER_KIND_HOLD = 'Hold';
export const ORDER_KINDS = Object.freeze([ORDER_KIND_HOLD]);
export const KNOWN_ORDER_KINDS = Object.freeze(['Hold', 'Move', 'Charge', 'Shoot']);

// Resolution phases, in order. Each runs every turn, even while empty.
export const TURN_PHASES = Object.freeze(['Movement', 'Shooting', 'Combat', 'Cohesion']);

// Rejection codes. The first three are the contract minimum; the rest belong
// to this ruleset slice and grow with its major version.
export const REJECTION_UNKNOWN_UNIT = 'unknown_unit';
export const REJECTION_NOT_OWN_UNIT = 'not_own_unit';
export const REJECTION_DUPLICATE_UNIT_ORDER = 'duplicate_unit_order';
export const REJECTION_UNSUPPORTED_ORDER_KIND = 'unsupported_order_kind';

// Whole-submission refusal codes: a stale turn number or a side that is not
// active refuses the submission before any order is examined.
export const REFUSAL_STALE_TURN = 'stale_turn';
export const REFUSAL_NOT_ACTIVE_SIDE = 'not_active_side';
export const REFUSAL_UNKNOWN_BATTLE = 'unknown_battle';
export const REFUSAL_ORDERS_REJECTED = 'orders_rejected';

// Numeric cohesion values behind the three cohesion states. The battle stores
// the state string; the player view carries both the value and the state.
const COHESION_VALUES = Object.freeze({ Steady: 2, Disordered: 1, Routed: 0 });

function cohesionValue(state) {
  return Object.hasOwn(COHESION_VALUES, state) ? COHESION_VALUES[state] : null;
}

// Deep clone a JSON-shaped value. Battle state, views, and submissions are
// plain data, so a JSON round trip is a faithful copy.
function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertBattle(battle) {
  if (!battle || typeof battle !== 'object' || Array.isArray(battle)) {
    throw new Error('A turn needs a battle state object.');
  }
  if (!Array.isArray(battle.scenario?.sides) || battle.scenario.sides.length !== 2) {
    throw new Error('A turn needs a battle with exactly two sides.');
  }
  if (!Array.isArray(battle.units) || !Array.isArray(battle.events)) {
    throw new Error('A turn needs a battle with units and events.');
  }
}

// The id of the side opposing `side` in this battle. Throws for a side that
// is not playing.
export function otherSide(battle, side) {
  assertBattle(battle);
  const ids = battle.scenario.sides.map((entry) => entry.id);
  if (!ids.includes(side)) {
    throw new Error(`Unknown side "${side}" (one of: ${ids.join(', ')}).`);
  }
  return ids.find((id) => id !== side);
}

// --- Player view ------------------------------------------------------------
// Everything a player may know when deciding: the whole current situation,
// the ruleset and its parameter values, and what has happened so far. It is
// the same for both sides. It never contains the seed or the generator
// state — only the battle's chance outcomes are withheld, and Hold needs
// none.

function frontEdge(unit) {
  const derived = deriveFootprint(unit);
  return {
    midpoint: { ...unit.position },
    left: { ...derived.corners[0] },
    right: { ...derived.corners[1] },
  };
}

function formationOf(unit) {
  const ranks = Math.ceil(unit.soldiers / unit.files);
  return {
    files: unit.files,
    ranks,
    lateralInterval: unit.lateralInterval,
    rankDepth: unit.rankDepth,
    frontageM: unit.files * unit.lateralInterval,
    depthM: ranks * unit.rankDepth,
  };
}

function statusOf(unit) {
  return unit.cohesion === 'Routed' ? 'routed' : 'active';
}

// Build the player view for the battle's current turn. Pure: the battle is
// never changed, and the view shares no references with it.
export function buildPlayerView(battle) {
  assertBattle(battle);
  return {
    formatVersion: PLAYER_VIEW_FORMAT_VERSION,
    battleId: battle.id,
    battlefield: { ...battle.scenario.battlefield },
    terrain: cloneValue(battle.scenario.terrainFeatures || []),
    sides: battle.scenario.sides.map((side) => ({ id: side.id, name: side.name })),
    units: battle.units.map((unit) => ({
      id: unit.id,
      name: unit.name,
      side: unit.side,
      troopType: unit.troopType,
      position: { ...unit.position },
      facing: unit.facing,
      front: frontEdge(unit),
      soldiers: unit.soldiers,
      files: unit.files,
      formation: formationOf(unit),
      cohesion: { value: cohesionValue(unit.cohesion), state: unit.cohesion },
      engaged: { unitId: null, edge: null },
      status: statusOf(unit),
    })),
    round: battle.round,
    turnNumber: battle.turnNumber,
    activeSide: battle.activeSide,
    phase: battle.phase,
    status: battle.status,
    ruleset: { ...battle.ruleset },
    parameters: cloneValue(battle.parameters),
    catalogue: cloneValue(TROOP_TYPE_CATALOGUE),
    events: cloneValue(battle.events),
  };
}

// --- Available actions ------------------------------------------------------
// Computed per unit at the start of the turn: the permitted order kinds,
// with reasons for the unavailable ones, the Charge and Shoot candidates,
// and the movement allowance. Only Hold is permitted in this slice, so no
// unit may move and both candidate lists stay empty.

const UNAVAILABLE_REASONS = Object.freeze({
  Move: 'Move is not available in this slice: only Hold is permitted.',
  Charge: 'Charge is not available in this slice: only Hold is permitted.',
  Shoot: 'Shoot is not available in this slice: only Hold is permitted.',
});

function actionsForUnit(unit) {
  return {
    unitId: unit.id,
    permitted: [{ kind: ORDER_KIND_HOLD }],
    unavailable: KNOWN_ORDER_KINDS.filter((kind) => kind !== ORDER_KIND_HOLD).map(
      (kind) => ({
        kind,
        code: REJECTION_UNSUPPORTED_ORDER_KIND,
        reason: UNAVAILABLE_REASONS[kind],
      }),
    ),
    chargeCandidates: [],
    shootCandidates: [],
    movementAllowanceM: 0,
  };
}

// Compute the available actions for `side` on the battle's current turn.
// Pure: the battle is never changed.
export function availableActions(battle, side) {
  assertBattle(battle);
  const ids = battle.scenario.sides.map((entry) => entry.id);
  if (!ids.includes(side)) {
    throw new Error(`Unknown side "${side}" (one of: ${ids.join(', ')}).`);
  }
  return {
    formatVersion: AVAILABLE_ACTIONS_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side,
    units: battle.units.filter((unit) => unit.side === side).map(actionsForUnit),
  };
}

// --- Submission envelope and JSON Schema ------------------------------------
// A submission is `{ formatVersion, battleId, turnNumber, side, orders[] }`
// and an order is `{ unitId, kind, ...parameters }` (Hold takes no
// parameters). The schema below parses untrusted input: `parseSubmission`
// enforces it by hand — the prototype has no dependencies — and returns a
// deep copy, throwing a `SubmissionParseError` that names the first problem.

// JSON Schema (draft 2020-12) for a turn submission. Kept as data so the
// editor, the harness, and future validators can share it.
export const SUBMISSION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://polis.example/schemas/turn-submission/v1',
  title: 'Turn submission',
  type: 'object',
  required: ['formatVersion', 'battleId', 'turnNumber', 'side', 'orders'],
  additionalProperties: false,
  properties: Object.freeze({
    formatVersion: Object.freeze({ const: SUBMISSION_FORMAT_VERSION }),
    battleId: Object.freeze({ type: 'string', minLength: 1 }),
    turnNumber: Object.freeze({ type: 'integer', minimum: 1 }),
    side: Object.freeze({ type: 'string', minLength: 1 }),
    orders: Object.freeze({
      type: 'array',
      items: Object.freeze({
        type: 'object',
        required: Object.freeze(['unitId', 'kind']),
        additionalProperties: true,
        properties: Object.freeze({
          unitId: Object.freeze({ type: 'string', minLength: 1 }),
          kind: Object.freeze({ type: 'string', minLength: 1 }),
        }),
      }),
    }),
  }),
});

export class SubmissionParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SubmissionParseError';
    this.code = 'invalid-submission';
  }
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Parse untrusted input against `SUBMISSION_SCHEMA`. Returns a deep copy of
// the submission; throws a `SubmissionParseError` naming the first problem.
export function parseSubmission(untrusted) {
  if (!isRecord(untrusted)) {
    throw new SubmissionParseError('A submission must be an object.');
  }
  const allowed = new Set(Object.keys(SUBMISSION_SCHEMA.properties));
  for (const key of Object.keys(untrusted)) {
    if (!allowed.has(key)) {
      throw new SubmissionParseError(`A submission must not hold "${key}".`);
    }
  }
  for (const key of SUBMISSION_SCHEMA.required) {
    if (untrusted[key] === undefined) {
      throw new SubmissionParseError(`A submission requires "${key}".`);
    }
  }
  if (untrusted.formatVersion !== SUBMISSION_FORMAT_VERSION) {
    throw new SubmissionParseError(
      `Unsupported submission format version ${JSON.stringify(untrusted.formatVersion)} ` +
        `(this engine reads version ${SUBMISSION_FORMAT_VERSION}).`,
    );
  }
  if (typeof untrusted.battleId !== 'string' || untrusted.battleId.trim() === '') {
    throw new SubmissionParseError('A submission requires a non-empty battle id.');
  }
  if (!Number.isInteger(untrusted.turnNumber) || untrusted.turnNumber < 1) {
    throw new SubmissionParseError('A submission requires a turn number of at least 1.');
  }
  if (typeof untrusted.side !== 'string' || untrusted.side.trim() === '') {
    throw new SubmissionParseError('A submission requires a non-empty side.');
  }
  if (!Array.isArray(untrusted.orders)) {
    throw new SubmissionParseError('A submission requires an orders array.');
  }
  untrusted.orders.forEach((order, index) => {
    if (!isRecord(order)) {
      throw new SubmissionParseError(`Order ${index} must be an object.`);
    }
    if (typeof order.unitId !== 'string' || order.unitId.trim() === '') {
      throw new SubmissionParseError(`Order ${index} requires a non-empty unit id.`);
    }
    if (typeof order.kind !== 'string' || order.kind.trim() === '') {
      throw new SubmissionParseError(`Order ${index} requires a non-empty order kind.`);
    }
  });
  return cloneValue(untrusted);
}

// --- Validation -------------------------------------------------------------
// `validateTurn` checks a submission against the authoritative battle state
// and returns a verdict per order in sequence. A stale turn number or a side
// that is not active refuses the whole submission before any order is
// examined. Rejections have the shape
// `{ orderIndex, unitId, code, details, message }`.

function wholeRefusal(code, message) {
  return { ok: false, code, message, verdicts: [], acceptedOrders: [] };
}

function reject(orderIndex, unitId, code, details, message) {
  return { orderIndex, unitId, accepted: false, rejection: { orderIndex, unitId, code, details, message } };
}

// Validate a submission against the battle state. Never throws for a
// malformed submission — it refuses it — but throws for a missing battle.
// Pure: neither the battle nor the submission is changed.
export function validateTurn(battle, submission) {
  assertBattle(battle);
  if (!isRecord(submission)) {
    return wholeRefusal('invalid-submission', 'A submission must be an object.');
  }
  if (submission.formatVersion !== TURN_CONTRACT_VERSION) {
    return wholeRefusal(
      'unsupported-format-version',
      `Unsupported submission format version ${JSON.stringify(submission.formatVersion)} ` +
        `(this engine reads version ${TURN_CONTRACT_VERSION}).`,
    );
  }
  if (submission.battleId !== battle.id) {
    return wholeRefusal(
      REFUSAL_UNKNOWN_BATTLE,
      `Submission is for battle "${String(submission.battleId)}" but this battle is "${String(battle.id)}".`,
    );
  }
  if (submission.turnNumber !== battle.turnNumber) {
    return wholeRefusal(
      REFUSAL_STALE_TURN,
      `Submission turn ${String(submission.turnNumber)} does not match the current turn ${battle.turnNumber}.`,
    );
  }
  if (submission.side !== battle.activeSide) {
    return wholeRefusal(
      REFUSAL_NOT_ACTIVE_SIDE,
      `Side "${String(submission.side)}" is not the active side ("${battle.activeSide}").`,
    );
  }
  if (!Array.isArray(submission.orders)) {
    return wholeRefusal('invalid-submission', 'A submission requires an orders array.');
  }
  const byId = new Map(battle.units.map((unit) => [unit.id, unit]));
  const seen = new Map();
  const verdicts = submission.orders.map((order, orderIndex) => {
    const unitId = isRecord(order) ? order.unitId : undefined;
    const unit = typeof unitId === 'string' ? byId.get(unitId) : undefined;
    if (!unit) {
      return reject(orderIndex, unitId ?? null, REJECTION_UNKNOWN_UNIT, { unitId: unitId ?? null },
        `Order ${orderIndex}: unknown unit "${String(unitId)}".`);
    }
    if (unit.side !== submission.side) {
      return reject(orderIndex, unit.id, REJECTION_NOT_OWN_UNIT,
        { unitId: unit.id, ownerSide: unit.side, submittingSide: submission.side },
        `Order ${orderIndex}: unit "${unit.id}" fights for "${unit.side}", not "${submission.side}".`);
    }
    if (seen.has(unit.id)) {
      return reject(orderIndex, unit.id, REJECTION_DUPLICATE_UNIT_ORDER,
        { unitId: unit.id, firstOrderIndex: seen.get(unit.id) },
        `Order ${orderIndex}: unit "${unit.id}" already holds an order (order ${seen.get(unit.id)}).`);
    }
    seen.set(unit.id, orderIndex);
    if (!isRecord(order) || order.kind !== ORDER_KIND_HOLD) {
      return reject(orderIndex, unit.id, REJECTION_UNSUPPORTED_ORDER_KIND,
        { unitId: unit.id, kind: isRecord(order) ? order.kind : undefined },
        `Order ${orderIndex}: order kind "${String(isRecord(order) ? order.kind : order)}" is not ` +
          `available in this slice (only ${ORDER_KIND_HOLD} is permitted).`);
    }
    return { orderIndex, unitId: unit.id, accepted: true };
  });
  const acceptedOrders = verdicts
    .filter((verdict) => verdict.accepted)
    .map((verdict) => cloneValue(submission.orders[verdict.orderIndex]));
  if (acceptedOrders.length < verdicts.length) {
    const rejected = verdicts.length - acceptedOrders.length;
    return {
      ok: false,
      code: REFUSAL_ORDERS_REJECTED,
      message: `${rejected} of ${verdicts.length} orders rejected.`,
      verdicts,
      acceptedOrders,
    };
  }
  return { ok: true, code: null, message: null, verdicts, acceptedOrders };
}

// --- Resolution -------------------------------------------------------------
// Resolution is a pure function from the battle state and a committed
// decision to a new state and events. It runs the Movement, Shooting,
// Combat, and Cohesion phases — empty in this slice, because Hold moves
// nothing — then passes the turn and counts rounds as pairs of turns. A
// turn decision is either a commit or a concede.

export class TurnRejectedError extends Error {
  constructor(result) {
    super(`Commit refused: ${result.message} (${result.code}).`);
    this.name = 'TurnRejectedError';
    this.code = result.code;
    this.result = result;
  }
}

function nextEvent(battle, fields) {
  return { seq: battle.events.length, ...fields };
}

// Resolve a committed turn decision against the battle state. Commit
// re-validates every order against the authoritative state and is all or
// nothing: any rejection throws a `TurnRejectedError` and no battle is
// produced. Concede ends the battle with the other side the winner. Pure:
// the input battle and the decision are never changed.
export function resolveTurn(battle, decision) {
  assertBattle(battle);
  if (!isRecord(decision)) {
    throw new Error('A turn decision must be an object ({ type: "commit" | "concede", ... }).');
  }
  const next = cloneValue(battle);
  if (decision.type === 'concede') {
    const side = typeof decision.side === 'string' ? decision.side : battle.activeSide;
    const winner = otherSide(battle, side);
    next.status = BATTLE_STATUS_CONCEDED;
    next.phase = 'ended';
    next.winner = winner;
    next.events.push(
      nextEvent(next, {
        type: 'turn-conceded',
        turnNumber: battle.turnNumber,
        side,
        winner,
      }),
    );
    return next;
  }
  if (decision.type !== 'commit') {
    throw new Error(
      `Unknown turn decision type "${String(decision.type)}" (one of: commit, concede).`,
    );
  }
  const result = validateTurn(battle, decision.submission);
  if (!result.ok) {
    throw new TurnRejectedError(result);
  }
  for (const phase of TURN_PHASES) {
    next.events.push(
      nextEvent(next, {
        type: 'turn-phase',
        turnNumber: battle.turnNumber,
        side: battle.activeSide,
        phase,
        ordersApplied: result.acceptedOrders.length,
      }),
    );
  }
  const nextTurnNumber = battle.turnNumber + 1;
  const nextSide = otherSide(battle, battle.activeSide);
  next.events.push(
    nextEvent(next, {
      type: 'turn-resolved',
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      ordersApplied: result.acceptedOrders.length,
      nextTurnNumber,
      nextSide,
      nextRound: Math.ceil(nextTurnNumber / 2),
    }),
  );
  next.turnNumber = nextTurnNumber;
  next.activeSide = nextSide;
  next.round = Math.ceil(nextTurnNumber / 2);
  next.phase = TURN_PHASE_ORDERS;
  next.status = BATTLE_STATUS_ONGOING;
  return next;
}
