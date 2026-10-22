// PÓLIS engine — players and the turn runner (framework-free).
//
// The runner lives outside the engine (ADR 0005): the pure turn contract in
// `./turn.js` never knows about time, attempts, or who is playing, while this
// module drives turns — it builds the player view and the available actions,
// hands the player a `validate` function bound to the authoritative state,
// awaits the asynchronous `Player.decide({ view, availableActions, validate
// })`, and resolves the returned turn decision. It imports only the domain
// model and the turn contract, so it runs unchanged in the browser, in Node
// tests, and in any future shell.
//
// Retries and fallbacks for players that are not human live here, never in
// the engine: after a bounded number of refused attempts the runner removes
// the first rejected order and re-validates until the rest is accepted, and a
// missing or unparseable answer means every unit holds. Every substitution
// and fallback is recorded in the battle's events, so a battle stays
// reproducible from its seed and its committed orders. A player is never
// conceded automatically.
//
// The Passive player always commits no orders. It is the tracer-bullet
// opponent for the whole turn contract: Passive vs Passive must play round
// after round without exceptions.

import {
  SUBMISSION_FORMAT_VERSION,
  availableActions,
  buildPlayerView,
  resolveTurn,
  validateTurn,
} from './turn.js';

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
// The Random test player of #8 item 4. In this slice only Hold exists, so
// there is nothing to randomise yet: it commits no orders through the shared
// contract exactly like the Passive player, and the engine alone decides
// legality. Later slices give it real choices; the `kind` already records
// which test player was chosen.
export function createRandomPlayer() {
  return {
    kind: 'random',
    async decide({ view, availableActions: actions, validate }) {
      if (!isRecord(view) || !isRecord(actions) || typeof validate !== 'function') {
        throw new Error('The Random player needs { view, availableActions, validate }.');
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
          `The Random player's empty submission was refused: ${result?.message ?? 'no verdict'}.`,
        );
      }
      return { type: 'commit', submission };
    },
  };
}

// Build the player for a battle controller name. `human` has no automated
// player (the battle UI drafts the empty commit through the same contract),
// while `random`, `passive`, and the generic ADR 0005 `automated` name all
// resolve through the runner. Throws for an unknown controller.
export function createPlayerForController(controller) {
  const name = String(controller ?? '').toLowerCase();
  if (name === 'passive' || name === 'automated') {
    return createPassivePlayer();
  }
  if (name === 'random') {
    return createRandomPlayer();
  }
  throw new Error(
    `No automated player for controller "${controller}" (one of: random, passive, automated).`,
  );
}

// --- Runner ------------------------------------------------------------------

// Drive one turn: ask the active side's player for a decision and resolve it.
// Returns `{ battle, decision, substitutions, fallback }`. Retries a refused
// commit by removing the first rejected order and re-validating until the
// rest is accepted; a missing or unparseable answer, a thrown player, or an
// envelope-level refusal falls back to every unit holding. Substitutions and
// fallbacks are appended to the new battle's events. Never changes the input
// battle.
export async function runTurn(battle, players) {
  if (!battle || typeof battle !== 'object') {
    throw new Error('The runner needs a battle state object.');
  }
  if (battle.status !== 'ongoing') {
    throw new Error(`The battle is over (status "${battle.status}").`);
  }
  const side = battle.activeSide;
  const player = players?.[side];
  if (!player || typeof player.decide !== 'function') {
    throw new Error(`No player for side "${String(side)}".`);
  }
  const view = buildPlayerView(battle);
  const actions = availableActions(battle, side);
  const validate = (submission) => validateTurn(battle, submission);

  let decision = null;
  let fallback = null;
  try {
    decision = await player.decide({ view, availableActions: actions, validate });
  } catch (error) {
    fallback = `player threw: ${error?.message ?? String(error)}`;
  }
  if (!isDecision(decision)) {
    fallback ??= 'missing or unparseable answer from the player';
    decision = { type: 'commit', submission: emptySubmission(battle) };
  }

  const substitutions = [];
  if (decision.type === 'commit') {
    let current = decision.submission;
    let guard = (Array.isArray(current.orders) ? current.orders.length : 0) + 1;
    let result = validateTurn(battle, current);
    while (!result.ok && guard > 0) {
      guard -= 1;
      if (result.verdicts.length === 0) {
        substitutions.push({
          orderIndex: -1,
          unitId: null,
          code: result.code,
          message: result.message,
        });
        current = emptySubmission(battle);
      } else {
        const rejected = result.verdicts.find((verdict) => !verdict.accepted);
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
      }
      result = validateTurn(battle, current);
    }
    decision = { type: 'commit', submission: current };
  }

  const next = resolveTurn(battle, decision);
  for (const entry of substitutions) {
    next.events.push({
      seq: next.events.length,
      type: 'order-substituted',
      turnNumber: battle.turnNumber,
      side,
      ...entry,
    });
  }
  if (fallback) {
    next.events.push({
      seq: next.events.length,
      type: 'player-fallback',
      turnNumber: battle.turnNumber,
      side,
      reason: fallback,
    });
  }
  return { battle: next, decision, substitutions, fallback };
}

// Play `rounds` rounds (two turns each) of Passive-style play through the
// runner, stopping early when the battle ends. Returns
// `{ battle, turns }`, where each turn entry is the `runTurn` result.
// Rejects for a negative round count.
export async function runRounds(battle, players, rounds) {
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
      const step = await runTurn(current, players);
      current = step.battle;
      turns.push(step);
    }
  }
  return { battle: current, turns };
}
