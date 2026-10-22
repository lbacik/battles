// PÓLIS engine — battle end: army break, the round limit, and concession
// (framework-free).
//
// The end-condition slice of the framework-free engine package: how a battle
// stops being `ongoing` and what it records when it does. This module imports
// only the domain model, the ruleset package, and the cohesion helpers — no
// React, no Next.js, no DOM, no Node APIs — so it runs unchanged in the
// browser, in Node unit tests, and in any future shell.
//
// Mechanics (decision #6 items 24-26):
//
// - **Army break:** a side breaks when the starting soldiers of its units that
//   are destroyed, fled, or currently Routed reach the threshold share
//   (`battle.breakLossShare`) of its starting soldiers. It is checked after
//   every Cohesion phase (both sides at once, since a turn's Combat phase can
//   rout either side's units). A break ends the battle at once with the other
//   side's victory; both sides breaking together is a draw.
// - **Round limit** (the `battle.roundLimit` ruleset parameter; scenarios
//   store none): after the last turn of the limit round, the side with the
//   lower lost share — by the same measure as the break — wins when the
//   difference exceeds the margin (`battle.drawMarginShare`); otherwise the
//   battle is a draw.
// - **Concession:** a player may concede during their own turn; the other side
//   wins. The concede path lives in `./turn.js`; this module only records it.
//
// A finished battle records `winner` (null for a draw) and a `result`:
// `{ winner, draw, reason, lostShares, losses, margin, brokenSides }`. The
// reason is one of `break`, `round-limit`, or `concede`; both lost shares and
// both sides' losses (soldiers lost: starting minus current, floored at zero)
// are always recorded, while `margin` is set only for the round limit and
// `brokenSides` only for a break. The end is recorded in the events as
// `battle-ended` (a concede keeps its `turn-conceded` event first). Every
// helper here is pure apart from `applyBattleEnd`, which mutates the battle it
// finishes.

import {
  BATTLE_STATUS_BROKEN,
  BATTLE_STATUS_CONCEDED,
  BATTLE_STATUS_ROUND_LIMIT,
} from './battle.js';
import {
  cohesionParamsOf,
  isActiveUnit,
  unitCohesionState,
} from './cohesion.js';

// Why a battle ended. The status names the terminal state (`broken`,
// `round-limit`, or the earlier `conceded`); the reason names the mechanism.
export const END_REASON_BREAK = 'break';
export const END_REASON_ROUND_LIMIT = 'round-limit';
export const END_REASON_CONCEDE = 'concede';
export const END_REASONS = Object.freeze([END_REASON_BREAK, END_REASON_ROUND_LIMIT, END_REASON_CONCEDE]);

// The event recorded when a battle ends.
export const BATTLE_ENDED_EVENT = 'battle-ended';

// Battle-end parameters when the snapshot carries no `battle` block. The
// tuned values live in the versioned ruleset file
// (`./polis-classical-parameters-1.0.json`); these are the fallback shape.
export const DEFAULT_BATTLE_END = Object.freeze({
  roundLimit: 12,
  breakLossShare: 0.5,
  drawMarginShare: 0.05,
});

// Read the battle-end parameters from the snapshot, in either the outer shape
// (`parameters.battle`) or the inner shape (the battle block itself). Missing
// or out-of-range values fall back to the defaults. Never throws.
export function battleEndParamsOf(parameters) {
  const inner = parameters && typeof parameters === 'object' && parameters.battle
    && typeof parameters.battle === 'object'
    ? parameters.battle
    : parameters && typeof parameters === 'object' ? parameters : {};
  const roundLimit = Number.isInteger(inner.roundLimit) && inner.roundLimit >= 1
    ? inner.roundLimit
    : DEFAULT_BATTLE_END.roundLimit;
  const breakLossShare = Number.isFinite(inner.breakLossShare)
    && inner.breakLossShare >= 0 && inner.breakLossShare <= 1
    ? inner.breakLossShare
    : DEFAULT_BATTLE_END.breakLossShare;
  const drawMarginShare = Number.isFinite(inner.drawMarginShare) && inner.drawMarginShare >= 0
    ? inner.drawMarginShare
    : DEFAULT_BATTLE_END.drawMarginShare;
  return { roundLimit, breakLossShare, drawMarginShare };
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The two side ids of a battle, in scenario order. Throws for a battle that
// does not field exactly two sides.
export function battleSideIds(battle) {
  const sides = battle?.scenario?.sides;
  if (!Array.isArray(sides) || sides.length !== 2 || sides.some((side) => typeof side?.id !== 'string')) {
    throw new Error('Battle end needs a battle with exactly two sides.');
  }
  return [sides[0].id, sides[1].id];
}

// A unit's starting soldiers: the snapshot taken at battle start, falling back
// to its current soldiers for older saves. Never negative, never NaN.
function startingOf(unit) {
  const starting = Number.isFinite(unit?.startingSoldiers)
    ? unit.startingSoldiers
    : unit?.soldiers;
  return Number.isFinite(starting) && starting > 0 ? starting : 0;
}

// --- Side summaries -----------------------------------------------------------
// One pass over the units: for every side, its starting soldiers, its lost
// starting soldiers (destroyed, fled, or currently Routed), and its losses in
// soldiers (starting minus current, floored at zero). Every share and loss
// below derives from this summary so the end-condition measure cannot drift
// between helpers. Pure; never throws.

function summarizeSides(battle) {
  const cohesion = cohesionParamsOf(battle?.parameters);
  const summary = new Map();
  for (const unit of battle?.units || []) {
    if (!unit || typeof unit !== 'object' || typeof unit.side !== 'string') {
      continue;
    }
    let entry = summary.get(unit.side);
    if (!entry) {
      entry = { starting: 0, lost: 0, losses: 0 };
      summary.set(unit.side, entry);
    }
    const starting = startingOf(unit);
    entry.starting += starting;
    if (isLostUnit(unit, cohesion)) {
      entry.lost += starting;
    }
    const soldiers = Number.isFinite(unit.soldiers) && unit.soldiers > 0 ? unit.soldiers : 0;
    entry.losses += Math.max(0, starting - soldiers);
  }
  return summary;
}

function summaryEntry(battle, side) {
  return summarizeSides(battle).get(side) ?? { starting: 0, lost: 0, losses: 0 };
}

// The raw (unrounded) lost share of a side. Every comparison below uses this,
// so a share just under the threshold never breaks on rounding; the records
// round it for readability (see `roundShare`).
function rawLostShare(battle, side) {
  const entry = summaryEntry(battle, side);
  return entry.starting > 0 ? entry.lost / entry.starting : 0;
}

// Assess both sides at once: the raw shares for the comparisons, the rounded
// shares and the losses for the records. Pure: the battle is never changed.
function assessBattle(battle) {
  const [first, second] = battleSideIds(battle);
  const raw = { [first]: rawLostShare(battle, first), [second]: rawLostShare(battle, second) };
  return {
    first,
    second,
    raw,
    shares: { [first]: roundShare(raw[first]), [second]: roundShare(raw[second]) },
    losses: {
      [first]: summaryEntry(battle, first).losses,
      [second]: summaryEntry(battle, second).losses,
    },
  };
}

// True when the unit counts as lost for the end-condition measure: destroyed,
// fled, or — while still on the field — currently Routed. Pure.
export function isLostUnit(unit, cohesionParams = null) {
  if (!unit || typeof unit !== 'object') {
    return false;
  }
  if (unit.status === 'destroyed' || unit.status === 'fled') {
    return true;
  }
  if (!isActiveUnit(unit)) {
    return false;
  }
  return unitCohesionState(unit, cohesionParams) === 'Routed';
}

// A side's starting soldiers: the sum over its units. Pure.
export function sideStartingSoldiers(battle, side) {
  return summaryEntry(battle, side).starting;
}

// A side's lost starting soldiers by the end-condition measure: the starting
// soldiers of its destroyed, fled, or currently Routed units. Pure.
export function sideLostStartingSoldiers(battle, side) {
  return summaryEntry(battle, side).lost;
}

// Round a share for the record: four decimals keep the events readable. The
// break and margin comparisons always use the raw shares, never these.
function roundShare(value) {
  return Math.round(value * 10000) / 10000;
}

// A side's lost share: lost starting soldiers over starting soldiers, 0 when
// the side fields no soldiers. Pure.
export function sideLostShare(battle, side) {
  return roundShare(rawLostShare(battle, side));
}

// Both sides' lost shares, keyed by side id. Pure.
export function lostSharesOf(battle) {
  const { first, second, shares } = assessBattle(battle);
  return { [first]: shares[first], [second]: shares[second] };
}

// A side's losses in soldiers: starting minus current per unit, floored at
// zero so reinforcements (none in this ruleset) could never hide casualties.
// Pure.
export function sideLosses(battle, side) {
  return summaryEntry(battle, side).losses;
}

// Both sides' losses in soldiers, keyed by side id. Pure.
export function lossesOf(battle) {
  const { first, second, losses } = assessBattle(battle);
  return { [first]: losses[first], [second]: losses[second] };
}

// Check the army break for both sides at once: a side breaks when its lost
// share reaches the threshold share of its starting soldiers. Returns
// `{ broken, brokenSides, shares, losses, threshold }`. Pure: the battle is
// never changed.
export function checkArmyBreak(battle, params = null) {
  const resolved = params ?? battleEndParamsOf(battle?.parameters);
  const threshold = resolved.breakLossShare;
  const { first, second, raw, shares, losses } = assessBattle(battle);
  const brokenSides = [first, second].filter((side) => raw[side] >= threshold);
  return { broken: brokenSides.length > 0, brokenSides, shares, losses, threshold };
}

// Decide the battle at the round limit by lost share: the side with the lower
// raw share wins when the raw difference exceeds the margin, otherwise the
// battle is a draw. Returns `{ winner, draw, difference, margin, shares,
// losses }` (`difference` is the rounded raw difference, for the record).
// Pure: the battle is never changed.
export function decideRoundLimit(battle, params = null) {
  const resolved = params ?? battleEndParamsOf(battle?.parameters);
  const { first, second, raw, shares, losses } = assessBattle(battle);
  const rawDifference = Math.abs(raw[first] - raw[second]);
  const difference = roundShare(rawDifference);
  const margin = resolved.drawMarginShare;
  if (!(rawDifference > margin)) {
    return { winner: null, draw: true, difference, margin, shares, losses };
  }
  const winner = raw[first] < raw[second] ? first : second;
  return { winner, draw: false, difference, margin, shares, losses };
}

// True when the just-resolved turn completes the limit round: turns pair into
// rounds, so the round ends on an even turn number at or past twice the
// limit. Pure.
export function isRoundLimitReached(resolvedTurnNumber, params) {
  const resolved = params ?? DEFAULT_BATTLE_END;
  return Number.isInteger(resolvedTurnNumber)
    && resolvedTurnNumber % 2 === 0
    && resolvedTurnNumber / 2 >= resolved.roundLimit;
}

function statusForReason(reason) {
  if (reason === END_REASON_BREAK) {
    return BATTLE_STATUS_BROKEN;
  }
  if (reason === END_REASON_ROUND_LIMIT) {
    return BATTLE_STATUS_ROUND_LIMIT;
  }
  return BATTLE_STATUS_CONCEDED;
}

// Finish the battle: record the status, the winner (null for a draw), and the
// result (the reason, both lost shares, the margin where relevant, and both
// sides' losses), and append the `battle-ended` event. Mutates the battle and
// returns the appended event. Throws for an unknown reason or a winner that is
// not playing.
export function applyBattleEnd(battle, { reason, winner = null }) {
  if (!isRecord(battle) || !Array.isArray(battle.units) || !Array.isArray(battle.events)) {
    throw new Error('Battle end needs a battle with units and events.');
  }
  if (!END_REASONS.includes(reason)) {
    throw new Error(`Unknown battle-end reason "${String(reason)}" (one of: ${END_REASONS.join(', ')}).`);
  }
  const { first, second, raw, shares, losses } = assessBattle(battle);
  if (winner !== null && winner !== first && winner !== second) {
    throw new Error(`Battle-end winner "${String(winner)}" is not playing (one of: ${first}, ${second}).`);
  }
  const params = battleEndParamsOf(battle.parameters);
  let margin = null;
  let brokenSides = [];
  const draw = winner === null;
  if (reason === END_REASON_BREAK) {
    brokenSides = [first, second].filter((side) => raw[side] >= params.breakLossShare);
  }
  if (reason === END_REASON_ROUND_LIMIT) {
    margin = params.drawMarginShare;
  }
  battle.status = statusForReason(reason);
  battle.winner = winner;
  battle.phase = 'ended';
  battle.result = {
    winner,
    draw,
    reason,
    lostShares: { ...shares },
    losses: { ...losses },
    margin,
    brokenSides: [...brokenSides],
  };
  const event = {
    seq: battle.events.length,
    type: BATTLE_ENDED_EVENT,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    reason,
    winner,
    draw,
    lostShares: { ...shares },
    losses: { ...losses },
    margin,
    brokenSides: [...brokenSides],
  };
  battle.events.push(event);
  return event;
}
