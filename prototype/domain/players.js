// PÓLIS engine — players and the turn runner (framework-free).
//
// The runner lives outside the engine (ADR 0005): the pure turn contract in
// `./turn.js` never knows about time, attempts, or who is playing, while this
// module drives turns — it builds the player view and the available actions,
// hands the player a `validate` function bound to the authoritative state,
// awaits the asynchronous `Player.decide({ view, availableActions, validate,
// attempt, maxAttempts, previousResult })`, and resolves the returned turn
// decision. It imports only the domain model, the turn contract, and the engine
// generator — no React, no Next.js, no DOM, no Node APIs — so it runs unchanged
// in the browser, in Node tests, and in any future shell.
//
// Retries and fallbacks for players that are not human live here, never in
// the engine: after a bounded number of refused attempts (each refusal fed back
// with its rejections) the runner salvages by removing the first rejected
// order and re-validating until the rest is accepted, and a missing, timed-out,
// or unparseable answer means every unit holds. Every substitution and
// fallback is recorded in the battle's events, so a battle stays reproducible
// from its seed and its committed orders. A player is never conceded
// automatically: only an explicit concede decision from the player concedes,
// and every fallback commits (possibly empty) orders instead.
//
// The Passive player always commits no orders. It is the tracer-bullet
// opponent for the whole turn contract: Passive vs Passive must play round
// after round without exceptions.
//
// The Random player is the fuzzing test player of #8 item 4. It owns a
// generator built from its own seed — never the battle's generator — draws one
// order per unit from the available actions, picks parameters inside the
// movement allowance, checks each candidate through `validate`, and drops
// whatever is rejected.

import {
  SUBMISSION_FORMAT_VERSION,
  availableActions,
  buildPlayerView,
  resolveTurn,
  validateTurn,
} from './turn.js';
import { createRng, normalizeSeed } from './battle.js';

// --- Runner configuration ----------------------------------------------------
// The attempt count and the per-attempt timeout are configuration: pass
// `{ maxAttempts, timeoutMs }` to `runTurn` (and through `runRounds`), or rely
// on these defaults. `timeoutMs` of 0 disables the timeout. Attempts beyond
// the first only happen after a refusal, and the timeout races a single
// `decide` call — it never aborts the battle, it only falls back to Hold.
export const RUNNER_DEFAULTS = Object.freeze({ maxAttempts: 3, timeoutMs: 1000 });

// Resolve the runner options against the defaults. Throws on a non-positive
// integer attempt count or a negative timeout so a misconfigured harness fails
// loudly instead of silently never retrying (or never timing out).
export function resolveRunnerOptions(options = {}) {
  const merged = { ...RUNNER_DEFAULTS, ...options };
  if (!Number.isInteger(merged.maxAttempts) || merged.maxAttempts < 1) {
    throw new Error(`The runner needs a positive integer attempt count (got ${String(merged.maxAttempts)}).`);
  }
  if (typeof merged.timeoutMs !== 'number' || !(merged.timeoutMs >= 0)) {
    throw new Error(`The runner needs a non-negative timeout in ms (got ${String(merged.timeoutMs)}).`);
  }
  return merged;
}

function emptySubmission(battle) {
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders: [],
  };
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isDecision(value) {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === 'concede') {
    return true;
  }
  if (value.type !== 'commit') {
    return false;
  }
  return isRecord(value.submission) && Array.isArray(value.submission.orders);
}

// --- Passive player ----------------------------------------------------------

// Create the Passive player: it always commits no orders, so every unit
// holds. It still runs its (empty) submission through `validate`, so the
// shared contract — not the player's word — decides legality.
export function createPassivePlayer() {
  return {
    kind: 'passive',
    async decide({ view, availableActions: actions, validate }) {
      if (!isRecord(view) || !isRecord(actions) || typeof validate !== 'function') {
        throw new Error('The Passive player needs { view, availableActions, validate }.');
      }
      const submission = {
        formatVersion: SUBMISSION_FORMAT_VERSION,
        battleId: view.battleId,
        turnNumber: view.turnNumber,
        side: view.activeSide,
        orders: [],
      };
      const result = validate(submission);
      if (!result || result.ok !== true) {
        throw new Error(
          `The Passive player's empty submission was refused: ${result?.message ?? 'no verdict'}.`,
        );
      }
      return { type: 'commit', submission };
    },
  };
}

// --- Random player (test player) ----------------------------------------------
// The Random test player of #8 item 4. It owns a generator built from its own
// seed — separate from the battle's generator, which it never reads — and
// draws one order per unit from the available actions:
//
// - the order kind is drawn uniformly from the unit's permitted kinds;
// - a Move aims at a random point inside the unit's movement allowance (the
//   same allowance the available actions show), keeping the facing;
// - a Charge names a random charge candidate with no approach legs;
// - a Shoot names a random shoot candidate;
// - a Reform draws files and spacings inside the troop type's permitted range;
// - a Withdraw (or Hold, or Rally where permitted) carries no parameters.
//
// Every candidate is checked through `validate` against the orders accepted so
// far, and whatever is rejected is dropped: the submission the player returns
// is always accepted as-is, and an empty draw means every unit holds. Because
// the generator is the player's own, two players built from the same seed
// propose the same orders for the same turn, and the battle's `rngState` never
// moves while the player thinks.

// A random unsigned 32-bit seed for a Random player built without one. This is
// player-side impurity (the engine stays pure): the UI's test players need no
// reproducibility, while tests and fuzzing always pass an explicit seed.
function randomSeed32() {
  return Math.floor(Math.random() * 4294967296);
}

// Create the Random player from `{ seed }`, or from nothing (a fresh random
// seed). The seed is normalised exactly like a battle seed, so any integer or
// non-empty string works. The player records it as `seed`.
export function createRandomPlayer(options = {}) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('The Random player takes { seed } (or nothing for a fresh random seed).');
  }
  const seed = normalizeSeed(options.seed === undefined ? randomSeed32() : options.seed);
  const rng = createRng(seed);
  return {
    kind: 'random',
    seed,
    async decide({ view, availableActions: actions, validate }) {
      if (!isRecord(view) || !isRecord(actions) || typeof validate !== 'function') {
        throw new Error('The Random player needs { view, availableActions, validate }.');
      }
      const base = {
        formatVersion: SUBMISSION_FORMAT_VERSION,
        battleId: view.battleId,
        turnNumber: view.turnNumber,
        side: view.activeSide,
      };
      const byId = new Map((view.units || []).map((unit) => [unit.id, unit]));
      const orders = [];
      for (const entry of actions.units || []) {
        const kinds = (entry.permitted || []).map((item) => item.kind).filter((kind) => typeof kind === 'string');
        if (kinds.length === 0) {
          continue;
        }
        const kind = kinds[Math.floor(rng.next() * kinds.length)];
        const proposed = proposeOrder(kind, entry, view, byId, rng);
        if (!proposed) {
          continue;
        }
        let result = null;
        try {
          result = validate({ ...base, orders: [...orders, proposed] });
        } catch {
          continue;
        }
        if (!result || result.ok !== true || !Array.isArray(result.verdicts) || result.verdicts.length === 0) {
          continue;
        }
        const verdict = result.verdicts[result.verdicts.length - 1];
        if (verdict?.accepted) {
          orders.push(proposed);
        }
        // Anything else is rejected and dropped: the unit holds by omission.
      }
      const submission = { ...base, orders };
      const result = validate(submission);
      if (!result || result.ok !== true) {
        throw new Error(
          `The Random player's submission was refused: ${result?.message ?? 'no verdict'}.`,
        );
      }
      return { type: 'commit', submission };
    },
  };
}

// Round to the stored 0.1 m precision, as the engine snaps parameters.
function round1(value) {
  return Math.round(value * 10) / 10;
}

// Propose one order of `kind` for the available-actions `entry`, drawing
// parameters from the player's `rng`. Returns null when there is nothing
// sensible to propose (no charge candidate). The caller validates and drops
// whatever the engine rejects, so impossible proposals (a Move that collides,
// a Charge out of reach) are safe to make.
function proposeOrder(kind, entry, view, byId, rng) {
  const unitId = entry.unitId;
  if (kind === 'Hold') {
    return { unitId, kind: 'Hold' };
  }
  if (kind === 'Withdraw') {
    return { unitId, kind: 'Withdraw' };
  }
  if (kind === 'Charge') {
    const candidates = entry.chargeCandidates || [];
    if (candidates.length === 0) {
      return { unitId, kind: 'Hold' };
    }
    const candidate = candidates[Math.floor(rng.next() * candidates.length)];
    return {
      unitId,
      kind: 'Charge',
      targetId: candidate.targetId,
      edge: candidate.edge,
      approach: [],
    };
  }
  if (kind === 'Shoot') {
    const candidates = entry.shootCandidates || [];
    if (candidates.length === 0) {
      return { unitId, kind: 'Hold' };
    }
    const candidate = candidates[Math.floor(rng.next() * candidates.length)];
    return { unitId, kind: 'Shoot', targetId: candidate.targetId };
  }
  if (kind === 'Reform') {
    const seen = byId.get(unitId);
    const catalogue = view.catalogue?.[seen?.troopType];
    const ranges = catalogue?.permittedRanges;
    if (!seen || !ranges) {
      return { unitId, kind: 'Hold' };
    }
    const pickIn = (range) => round1(range.min + rng.next() * (range.max - range.min));
    return {
      unitId,
      kind: 'Reform',
      files: 1 + Math.floor(rng.next() * seen.soldiers),
      lateralInterval: pickIn(ranges.lateralInterval),
      rankDepth: pickIn(ranges.rankDepth),
    };
  }
  if (kind === 'Move') {
    const seen = byId.get(unitId);
    const allowance = entry.movementAllowanceM;
    if (!seen || !Number.isFinite(allowance) || allowance <= 0) {
      return { unitId, kind: 'Hold' };
    }
    const battlefield = view.battlefield || {};
    const width = Number.isFinite(battlefield.width) ? battlefield.width : 0;
    const height = Number.isFinite(battlefield.height) ? battlefield.height : 0;
    const angle = rng.next() * Math.PI * 2;
    const distance = rng.next() * allowance;
    const to = {
      x: round1(Math.min(Math.max(seen.position.x + Math.sin(angle) * distance, 1), Math.max(width - 1, 1))),
      y: round1(Math.min(Math.max(seen.position.y + Math.cos(angle) * distance, 1), Math.max(height - 1, 1))),
    };
    return { unitId, kind: 'Move', legs: [{ to }] };
  }
  // Any other permitted kind (Rally in a later slice) carries no parameters
  // the Random player knows: name the kind and let `validate` decide.
  return { unitId, kind };
}

// Build the player for a battle controller name. `human` has no automated
// player (the battle UI drafts the empty commit through the same contract),
// while `random`, `passive`, and the generic ADR 0005 `automated` name all
// resolve through the runner. `options` (such as a Random seed) is passed
// through to the Random player. Throws for an unknown controller.
export function createPlayerForController(controller, options = {}) {
  const name = String(controller ?? '').toLowerCase();
  if (name === 'passive' || name === 'automated') {
    return createPassivePlayer();
  }
  if (name === 'random') {
    return createRandomPlayer(options);
  }
  throw new Error(
    `No automated player for controller "${controller}" (one of: random, passive, automated).`,
  );
}

// --- Runner ------------------------------------------------------------------

// The marker for a `decide` call that outlasts its timeout: the race rejects
// with it so the runner can tell a timeout apart from a player that threw.
const TIMEOUT_MARK = 'player-timeout';

// Await the player's answer with a bounded wait. Resolves to
// `{ timedOut: false, value }`, rejects with the player's own error, or
// rejects with a `TIMEOUT_MARK` error when `timeoutMs` elapses first. A
// non-positive timeout waits without racing. The late answer is unobserved —
// it can no longer change the turn.
async function decideWithTimeout(player, input, timeoutMs) {
  let pending = null;
  try {
    pending = player.decide(input);
  } catch (error) {
    throw error;
  }
  if (!(timeoutMs > 0)) {
    return { timedOut: false, value: await pending };
  }
  let timer = null;
  try {
    const value = await Promise.race([
      Promise.resolve(pending),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`The player timed out after ${timeoutMs} ms.`);
          error.code = TIMEOUT_MARK;
          reject(error);
        }, timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      }),
    ]);
    return { timedOut: false, value };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
  }
}

// Drive one turn: ask the active side's player for a decision and resolve it.
// Returns `{ battle, decision, substitutions, fallback, attempts }`. The
// player is asked up to `maxAttempts` times (default 3): each refusal is fed
// back as `previousResult` (with its per-order rejections) alongside the
// `attempt` number, and only when the attempts are exhausted does the runner
// salvage — removing the first rejected order and re-validating until the rest
// is accepted. A missing, timed-out, or unparseable answer, a thrown player,
// or an envelope-level refusal with nothing to salvage falls back to every
// unit holding. The runner never concedes: only an explicit concede decision
// from the player concedes, and every fallback commits orders. Substitutions,
// refused attempts, and fallbacks are recorded in the new battle's events
// ahead of the resolution events, so the log stays in causal order.
// Never changes the input battle.
export async function runTurn(battle, players, options = {}) {
  if (!battle || typeof battle !== 'object') {
    throw new Error('The runner needs a battle state object.');
  }
  if (battle.status !== 'ongoing') {
    throw new Error(`The battle is over (status "${battle.status}").`);
  }
  const { maxAttempts, timeoutMs } = resolveRunnerOptions(options);
  const side = battle.activeSide;
  const player = players?.[side];
  if (!player || typeof player.decide !== 'function') {
    throw new Error(`No player for side "${String(side)}".`);
  }
  const view = buildPlayerView(battle);
  const actions = availableActions(battle, side);
  const validate = (submission) => validateTurn(battle, submission);

  const attemptEvents = [];
  let decision = null;
  let fallback = null;
  let previousResult = null;
  let lastSubmission = null;
  let attempts = 0;
  while (attempts < maxAttempts && !decision && !fallback) {
    attempts += 1;
    let answer = null;
    try {
      const raced = await decideWithTimeout(
        player,
        {
          view,
          availableActions: actions,
          validate,
          attempt: attempts,
          maxAttempts,
          previousResult,
        },
        timeoutMs,
      );
      answer = raced.value;
    } catch (error) {
      if (error?.code === TIMEOUT_MARK) {
        fallback = `player timed out after ${timeoutMs} ms`;
      } else {
        fallback = `player threw: ${error?.message ?? String(error)}`;
      }
      decision = { type: 'commit', submission: emptySubmission(battle) };
      break;
    }
    if (!isDecision(answer)) {
      fallback = 'missing or unparseable answer from the player';
      decision = { type: 'commit', submission: emptySubmission(battle) };
      break;
    }
    // An explicit concede is the player's own choice and passes through; the
    // runner itself never concedes (every fallback below commits orders).
    if (answer.type === 'concede') {
      decision = answer;
      break;
    }
    const result = validateTurn(battle, answer.submission);
    if (result.ok) {
      decision = { type: 'commit', submission: answer.submission };
      break;
    }
    previousResult = result;
    lastSubmission = answer.submission;
    attemptEvents.push({
      type: 'player-attempt-refused',
      turnNumber: battle.turnNumber,
      side,
      attempt: attempts,
      code: result.code,
      message: result.message,
      rejections: (result.verdicts || [])
        .filter((verdict) => !verdict.accepted)
        .map((verdict) => ({ ...verdict.rejection })),
    });
    // Otherwise the next attempt feeds this refusal back; when none remain the
    // loop ends and the salvage below runs.
  }

  const substitutions = [];
  if (!decision && !fallback) {
    // The attempts are exhausted: salvage the last refused submission by
    // removing the first rejected order and re-validating until the rest is
    // accepted. An envelope-level refusal names no order, so there is nothing
    // to remove one by one — every unit holds instead.
    let current = lastSubmission ?? emptySubmission(battle);
    if (!previousResult || previousResult.verdicts.length === 0) {
      fallback = previousResult
        ? `submission refused (${previousResult.code}); every unit holds`
        : 'no usable answer from the player; every unit holds';
      current = emptySubmission(battle);
    } else {
      let guard = current.orders.length + 1;
      let result = validateTurn(battle, current);
      while (!result.ok && guard > 0) {
        guard -= 1;
        const rejected = result.verdicts.find((verdict) => !verdict.accepted);
        if (!rejected) {
          fallback = `submission refused (${result.code}); every unit holds`;
          current = emptySubmission(battle);
          break;
        }
        substitutions.push({
          orderIndex: rejected.orderIndex,
          unitId: rejected.unitId,
          code: rejected.rejection.code,
          message: rejected.rejection.message,
        });
        current = {
          ...current,
          orders: current.orders.filter((_, index) => index !== rejected.orderIndex),
        };
        result = validateTurn(battle, current);
      }
      fallback = `attempts exhausted (${maxAttempts}); salvaged ${substitutions.length} order(s)`;
    }
    decision = { type: 'commit', submission: current };
  }

  const next = resolveTurn(battle, decision);
  // The runner's own events happened while the turn was decided, so they sort
  // before the resolution events: splice them in where resolution began and
  // renumber the log back into causal order.
  const runnerEvents = [
    ...attemptEvents,
    ...substitutions.map((entry) => ({
      type: 'order-substituted',
      turnNumber: battle.turnNumber,
      side,
      ...entry,
    })),
    ...(fallback
      ? [{
        type: 'player-fallback',
        turnNumber: battle.turnNumber,
        side,
        reason: fallback,
      }]
      : []),
  ];
  if (runnerEvents.length > 0) {
    next.events.splice(battle.events.length, 0, ...runnerEvents);
    next.events.forEach((event, index) => {
      event.seq = index;
    });
  }
  return {
    battle: next,
    decision,
    substitutions,
    fallback,
    attempts,
  };
}

// Play `rounds` rounds (two turns each) of automated play through the runner,
// stopping early when the battle ends. `options` carries the runner
// configuration through to every turn. Returns `{ battle, turns }`, where each
// turn entry is the `runTurn` result. Rejects for a negative round count.
export async function runRounds(battle, players, rounds, options = {}) {
  if (!Number.isInteger(rounds) || rounds < 0) {
    throw new Error('The runner needs a non-negative integer round count.');
  }
  let current = battle;
  const turns = [];
  for (let round = 0; round < rounds; round += 1) {
    for (let turn = 0; turn < 2; turn += 1) {
      if (current.status !== 'ongoing') {
        return { battle: current, turns };
      }
      const step = await runTurn(current, players, options);
      current = step.battle;
      turns.push(step);
    }
  }
  return { battle: current, turns };
}
