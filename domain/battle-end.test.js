// Unit tests for the battle end: army break, the round limit, and concession
// (decision #6 items 24-26). Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BATTLE_STATUS_BROKEN,
  BATTLE_STATUS_CONCEDED,
  BATTLE_STATUS_ONGOING,
  BATTLE_STATUS_ROUND_LIMIT,
  startBattle,
} from './battle.js';
import {
  BATTLE_ENDED_EVENT,
  DEFAULT_BATTLE_END,
  END_REASON_BREAK,
  END_REASON_CONCEDE,
  END_REASON_ROUND_LIMIT,
  applyBattleEnd,
  battleEndParamsOf,
  battleSideIds,
  checkArmyBreak,
  decideRoundLimit,
  isLostUnit,
  isRoundLimitReached,
  lossesOf,
  lostSharesOf,
  sideLosses,
  sideLostShare,
  sideLostStartingSoldiers,
  sideStartingSoldiers,
} from './battle-end.js';
import {
  REFUSAL_BATTLE_FINISHED,
  REFUSAL_NOT_ACTIVE_SIDE,
  SUBMISSION_FORMAT_VERSION,
  TurnRejectedError,
  buildPlayerView,
  otherSide,
  resolveTurn,
  validateTurn,
} from './turn.js';
import { createPassivePlayer, runTurn } from './players.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, 'fixtures');

const ATHENS_HOPLITE = '11111111-1111-4111-8111-111111111111';
const ATHENS_PELTAST = '22222222-2222-4222-8222-222222222222';
const ATHENS_CAVALRY = '33333333-3333-4333-8333-333333333333';
const SPARTA_HOPLITE = '44444444-4444-4444-8444-444444444444';
const SPARTA_ARCHER = '55555555-5555-4555-8555-555555555555';
const SPARTA_PELTAST = '66666666-6666-4666-8666-666666666666';

function loadReference() {
  return JSON.parse(readFileSync(path.join(scenarioDir, 'acceptance-plain.json'), 'utf8'));
}

function freshBattle(seed = 2026) {
  const stored = loadReference();
  const controllers = {
    [stored.sides[0].id]: 'passive',
    [stored.sides[1].id]: 'passive',
  };
  const battle = startBattle(stored, { seed, controllers });
  assert.equal(battle.activeSide, 'athens');
  return battle;
}

function submissionFor(battle, orders = []) {
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
  };
}

function unitOf(battle, unitId) {
  return battle.units.find((unit) => unit.id === unitId);
}

function destroy(battle, unitId, soldiers = 10) {
  const unit = unitOf(battle, unitId);
  unit.status = 'destroyed';
  unit.soldiers = soldiers;
  return unit;
}

function rout(battle, unitId) {
  const unit = unitOf(battle, unitId);
  unit.cohesion = 'Routed';
  unit.cohesionState = 'Routed';
  unit.cohesionValue = 0;
  return unit;
}

function holdTurn(battle) {
  return resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) });
}

describe('battle-end parameters', () => {
  it('reads the battle block with fallbacks for missing values', () => {
    assert.deepEqual(battleEndParamsOf(null), DEFAULT_BATTLE_END);
    assert.deepEqual(battleEndParamsOf({}), DEFAULT_BATTLE_END);
    assert.deepEqual(
      battleEndParamsOf({ battle: { roundLimit: 6, breakLossShare: 0.4, drawMarginShare: 0.1 } }),
      { roundLimit: 6, breakLossShare: 0.4, drawMarginShare: 0.1 },
    );
    assert.deepEqual(
      battleEndParamsOf({ battle: { roundLimit: 0, breakLossShare: 9, drawMarginShare: -1 } }),
      DEFAULT_BATTLE_END,
    );
  });

  it('knows the two sides of a battle', () => {
    assert.deepEqual(battleSideIds(freshBattle()), ['athens', 'sparta']);
    assert.throws(() => battleSideIds({}), /exactly two sides/);
  });
});

describe('lost-share measure', () => {
  it('totals starting soldiers per side', () => {
    const battle = freshBattle();
    // Athens fields 256 + 120 + 80; Sparta fields 320 + 100 + 120.
    assert.equal(sideStartingSoldiers(battle, 'athens'), 456);
    assert.equal(sideStartingSoldiers(battle, 'sparta'), 540);
  });

  it('counts destroyed, fled, and currently Routed units as lost', () => {
    const battle = freshBattle();
    assert.equal(isLostUnit(unitOf(battle, ATHENS_HOPLITE)), false);
    destroy(battle, ATHENS_HOPLITE);
    assert.equal(isLostUnit(unitOf(battle, ATHENS_HOPLITE)), true);
    const fled = unitOf(battle, ATHENS_PELTAST);
    fled.status = 'fled';
    assert.equal(isLostUnit(fled), true);
    rout(battle, ATHENS_CAVALRY);
    assert.equal(isLostUnit(unitOf(battle, ATHENS_CAVALRY)), true);
    // Disordered units still fight: they count nothing.
    const steady = unitOf(battle, SPARTA_HOPLITE);
    steady.cohesion = 'Disordered';
    assert.equal(isLostUnit(steady), false);
    assert.equal(sideLostStartingSoldiers(battle, 'athens'), 256 + 120 + 80);
    assert.equal(sideLostShare(battle, 'athens'), 1);
    assert.equal(sideLostShare(battle, 'sparta'), 0);
  });

  it('counts losses in soldiers separately from the lost starting soldiers', () => {
    const battle = freshBattle();
    // A fled unit at full strength is lost from the field but no casualty.
    unitOf(battle, SPARTA_ARCHER).status = 'fled';
    assert.equal(lossesOf(battle).sparta, 0);
    assert.equal(sideLostShare(battle, 'sparta'), 0.1852);
    // Casualties are starting minus current soldiers, floored at zero.
    unitOf(battle, SPARTA_HOPLITE).soldiers = 300;
    assert.equal(sideLosses(battle, 'sparta'), 20);
  });
});

describe('army break', () => {
  it('never breaks an intact battle and never changes it when checking', () => {
    const battle = freshBattle();
    const before = JSON.stringify(battle);
    const checked = checkArmyBreak(battle);
    assert.equal(checked.broken, false);
    assert.deepEqual(checked.brokenSides, []);
    assert.deepEqual(checked.shares, { athens: 0, sparta: 0 });
    assert.equal(JSON.stringify(battle), before);
  });

  it('ends the battle at once when a side reaches the threshold share', () => {
    let battle = freshBattle();
    battle = holdTurn(battle);
    assert.equal(battle.status, BATTLE_STATUS_ONGOING);
    // Sparta loses its hoplite: 320 of 540 is above the 0.5 threshold.
    destroy(battle, SPARTA_HOPLITE, 70);
    const turnNumber = battle.turnNumber;
    const activeSide = battle.activeSide;
    battle = holdTurn(battle);
    assert.equal(battle.status, BATTLE_STATUS_BROKEN);
    assert.equal(battle.phase, 'ended');
    assert.equal(battle.winner, 'athens');
    assert.equal(battle.turnNumber, turnNumber, 'a break ends the battle at once: no turn passes');
    assert.equal(battle.activeSide, activeSide);
    assert.equal(battle.result.reason, END_REASON_BREAK);
    assert.equal(battle.result.draw, false);
    assert.deepEqual(battle.result.brokenSides, ['sparta']);
    assert.equal(battle.result.lostShares.sparta, 0.5926);
    assert.equal(battle.result.lostShares.athens, 0);
    assert.equal(battle.result.losses.sparta, 250);
    assert.equal(battle.result.margin, null);
    assert.ok(battle.events.some((event) => event.type === BATTLE_ENDED_EVENT));
    assert.ok(
      !battle.events.some((event) => event.type === 'turn-resolved' && event.turnNumber === turnNumber),
      'no turn resolves once the battle breaks',
    );
    assert.deepEqual(
      battle.events.map((event) => event.seq),
      battle.events.map((_, index) => index),
    );
  });

  it('counts currently Routed units toward the break', () => {
    const battle = freshBattle();
    // Athens routs its hoplite: 256 of 456 breaks the side even though the
    // unit still stands on the field.
    rout(battle, ATHENS_HOPLITE);
    const next = holdTurn(battle);
    assert.equal(next.status, BATTLE_STATUS_BROKEN);
    assert.equal(next.winner, 'sparta');
    assert.equal(next.result.reason, END_REASON_BREAK);
  });

  it('counts fled units toward the break', () => {
    const battle = freshBattle();
    // Sparta loses both small units from the field without casualties.
    unitOf(battle, SPARTA_ARCHER).status = 'fled';
    unitOf(battle, SPARTA_PELTAST).status = 'fled';
    // 220 of 540 is below the threshold: the battle continues.
    assert.equal(holdTurn(battle).status, BATTLE_STATUS_ONGOING);
    unitOf(battle, SPARTA_HOPLITE).status = 'fled';
    const next = holdTurn(battle);
    assert.equal(next.status, BATTLE_STATUS_BROKEN);
    assert.equal(next.winner, 'athens');
    assert.equal(next.result.losses.sparta, 0, 'fled units at full strength are no casualties');
  });

  it('draws when both sides break together', () => {
    const battle = freshBattle();
    destroy(battle, ATHENS_HOPLITE);
    destroy(battle, SPARTA_HOPLITE);
    const next = holdTurn(battle);
    assert.equal(next.status, BATTLE_STATUS_BROKEN);
    assert.equal(next.winner, null);
    assert.equal(next.result.draw, true);
    assert.deepEqual(next.result.brokenSides, ['athens', 'sparta']);
    const ended = next.events.find((event) => event.type === BATTLE_ENDED_EVENT);
    assert.equal(ended.draw, true);
    assert.equal(ended.winner, null);
  });

  it('honours a tuned break threshold', () => {
    const battle = freshBattle();
    battle.parameters.battle.breakLossShare = 0.9;
    destroy(battle, ATHENS_HOPLITE);
    // 256 of 456 breaks at 0.5 but holds at 0.9.
    assert.equal(holdTurn(battle).status, BATTLE_STATUS_ONGOING);
  });
});

describe('round limit', () => {
  it('decides by lost share after the last turn of the limit round', () => {
    let battle = freshBattle();
    battle.parameters.battle.roundLimit = 1;
    battle = holdTurn(battle);
    assert.equal(battle.status, BATTLE_STATUS_ONGOING, 'the first turn of the limit round plays on');
    assert.equal(battle.turnNumber, 2);
    // Sparta took casualties on its archers: 100 of 540 lost against 0.
    destroy(battle, SPARTA_ARCHER, 60);
    const activeSide = battle.activeSide;
    battle = holdTurn(battle);
    assert.equal(battle.status, BATTLE_STATUS_ROUND_LIMIT);
    assert.equal(battle.phase, 'ended');
    assert.equal(battle.winner, 'athens');
    assert.equal(battle.result.reason, END_REASON_ROUND_LIMIT);
    assert.equal(battle.result.draw, false);
    assert.equal(battle.result.margin, battle.parameters.battle.drawMarginShare);
    assert.equal(battle.result.losses.sparta, 40);
    assert.equal(battle.activeSide, activeSide, 'a decided battle passes no further turn');
    const ended = battle.events.find((event) => event.type === BATTLE_ENDED_EVENT);
    assert.equal(ended.reason, END_REASON_ROUND_LIMIT);
    assert.equal(ended.winner, 'athens');
  });

  it('draws when the difference stays within the margin', () => {
    let battle = freshBattle();
    battle.parameters.battle.roundLimit = 1;
    battle = holdTurn(battle);
    assert.equal(battle.status, BATTLE_STATUS_ONGOING);
    const drawn = holdTurn(battle);
    assert.equal(drawn.status, BATTLE_STATUS_ROUND_LIMIT);
    assert.equal(drawn.result.draw, true);
    assert.equal(drawn.winner, null);
  });

  it('draws on an exact margin: the difference must exceed it', () => {
    let battle = freshBattle();
    battle.parameters.battle.roundLimit = 1;
    battle = holdTurn(battle);
    // Athens loses nothing; Sparta loses 100 of 540 (a 0.1852 share).
    destroy(battle, SPARTA_ARCHER, 60);
    battle.parameters.battle.drawMarginShare = 0.1852;
    const drawn = holdTurn(battle);
    assert.equal(drawn.status, BATTLE_STATUS_ROUND_LIMIT);
    assert.equal(drawn.winner, null);
    assert.equal(drawn.result.draw, true);
    // A hair under the difference decides it.
    let rematch = freshBattle();
    rematch.parameters.battle.roundLimit = 1;
    rematch = holdTurn(rematch);
    destroy(rematch, SPARTA_ARCHER, 60);
    rematch.parameters.battle.drawMarginShare = 0.1851;
    const decided = holdTurn(rematch);
    assert.equal(decided.winner, 'athens');
    assert.equal(decided.result.draw, false);
  });

  it('never changes the battle when deciding, and knows when the limit hits', () => {
    const battle = freshBattle();
    const before = JSON.stringify(battle);
    const decided = decideRoundLimit(battle);
    assert.equal(decided.draw, true);
    assert.equal(decided.winner, null);
    assert.equal(decided.difference, 0);
    assert.equal(decided.margin, DEFAULT_BATTLE_END.drawMarginShare);
    assert.equal(JSON.stringify(battle), before);
    assert.equal(isRoundLimitReached(1, { roundLimit: 1 }), false);
    assert.equal(isRoundLimitReached(2, { roundLimit: 1 }), true);
    assert.equal(isRoundLimitReached(24, { roundLimit: 12 }), true);
    assert.equal(isRoundLimitReached(23, { roundLimit: 12 }), false);
  });

  it('plays on under the default limit', () => {
    let battle = freshBattle();
    battle = holdTurn(battle);
    battle = holdTurn(battle);
    assert.equal(battle.status, BATTLE_STATUS_ONGOING);
    assert.equal(battle.turnNumber, 3);
  });
});

describe('concession', () => {
  it('ends the battle with the other side the winner and records the result', () => {
    const battle = freshBattle();
    const next = resolveTurn(battle, { type: 'concede', side: battle.activeSide });
    assert.equal(next.status, BATTLE_STATUS_CONCEDED);
    assert.equal(next.phase, 'ended');
    assert.equal(next.winner, otherSide(battle, battle.activeSide));
    assert.equal(next.result.reason, END_REASON_CONCEDE);
    assert.equal(next.result.draw, false);
    assert.equal(next.result.winner, next.winner);
    assert.deepEqual(next.result.lostShares, { athens: 0, sparta: 0 });
    assert.deepEqual(next.result.losses, { athens: 0, sparta: 0 });
    const types = next.events.map((event) => event.type);
    assert.ok(types.includes('turn-conceded'));
    assert.ok(types.includes(BATTLE_ENDED_EVENT));
    assert.ok(
      types.indexOf('turn-conceded') < types.indexOf(BATTLE_ENDED_EVENT),
      'the concede sorts before the recorded end',
    );
  });

  it('concedes without a side by defaulting to the active side', () => {
    const battle = freshBattle();
    const next = resolveTurn(battle, { type: 'concede' });
    assert.equal(next.winner, otherSide(battle, battle.activeSide));
  });

  it('refuses a concede outside one own turn', () => {
    const battle = freshBattle();
    try {
      resolveTurn(battle, { type: 'concede', side: otherSide(battle, battle.activeSide) });
      assert.fail('expected an off-turn concede to be refused');
    } catch (error) {
      assert.ok(error instanceof TurnRejectedError);
      assert.equal(error.code, REFUSAL_NOT_ACTIVE_SIDE);
    }
  });
});

describe('finished battles refuse further decisions', () => {
  function brokenBattle() {
    const battle = freshBattle();
    destroy(battle, SPARTA_HOPLITE);
    return holdTurn(battle);
  }

  it('refuses orders, commits, and concedes once finished', () => {
    const battle = brokenBattle();
    assert.equal(battle.status, BATTLE_STATUS_BROKEN);
    const refused = validateTurn(battle, submissionFor(battle, []));
    assert.equal(refused.ok, false);
    assert.equal(refused.code, REFUSAL_BATTLE_FINISHED);
    assert.deepEqual(refused.verdicts, []);
    assert.throws(
      () => resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) }),
      TurnRejectedError,
    );
    try {
      resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) });
      assert.fail('expected a refused commit');
    } catch (error) {
      assert.ok(error instanceof TurnRejectedError);
      assert.equal(error.code, REFUSAL_BATTLE_FINISHED);
    }
    assert.throws(() => resolveTurn(battle, { type: 'concede' }), TurnRejectedError);
  });

  it('stops the runner: no turn resolves on a finished battle', async () => {
    const battle = brokenBattle();
    const players = { athens: createPassivePlayer(), sparta: createPassivePlayer() };
    await assert.rejects(runTurn(battle, players), /over/);
  });

  it('carries the winner and the result in the player view', () => {
    const ongoing = buildPlayerView(freshBattle());
    assert.equal(ongoing.winner, null);
    assert.equal(ongoing.result, null);
    const finished = buildPlayerView(brokenBattle());
    assert.equal(finished.winner, 'athens');
    assert.equal(finished.result.reason, END_REASON_BREAK);
    assert.equal(finished.status, BATTLE_STATUS_BROKEN);
  });
});

describe('applyBattleEnd', () => {
  it('finishes any reason with the full record and the event', () => {
    const battle = freshBattle();
    destroy(battle, ATHENS_HOPLITE, 200);
    const event = applyBattleEnd(battle, { reason: END_REASON_BREAK, winner: 'sparta' });
    assert.equal(event.type, BATTLE_ENDED_EVENT);
    assert.equal(battle.status, BATTLE_STATUS_BROKEN);
    assert.equal(battle.winner, 'sparta');
    assert.equal(battle.phase, 'ended');
    assert.deepEqual(battle.result, {
      winner: 'sparta',
      draw: false,
      reason: END_REASON_BREAK,
      lostShares: { athens: 0.5614, sparta: 0 },
      losses: { athens: 56, sparta: 0 },
      margin: null,
      brokenSides: ['athens'],
    });
  });

  it('rejects unknown reasons and foreign winners', () => {
    assert.throws(() => applyBattleEnd(freshBattle(), { reason: 'storm' }), /Unknown battle-end reason/);
    assert.throws(
      () => applyBattleEnd(freshBattle(), { reason: END_REASON_BREAK, winner: 'thebes' }),
      /not playing/,
    );
    assert.throws(() => applyBattleEnd(null, { reason: END_REASON_BREAK }), /units and events/);
  });
});
