// Unit tests for the battle log: grouping, English lines, the turn summary,
// and the map highlights. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startBattle } from './battle.js';
import { resolveTurn } from './turn.js';
import { runTurn, createPassivePlayer } from './players.js';
import {
  changedUnitsForTurn,
  describeBattleEvent,
  groupLogEvents,
  lastResolvedTurnNumber,
  phaseOfEvent,
  roundOfTurn,
  summarizeTurn,
} from './battle-log.js';
import { createScenario, generateId } from './scenario.js';

function probeUnit(overrides = {}) {
  return {
    id: generateId(),
    name: 'Probe taxis',
    side: 'side-a',
    troopType: 'hoplite',
    soldiers: 100,
    files: 10,
    lateralInterval: 1,
    rankDepth: 1,
    position: { x: 300, y: 600 },
    facing: 180,
    ...overrides,
  };
}

function freshPlayable() {
  const document = createScenario({ title: 'Probe battle' });
  document.units.push(probeUnit({ name: 'First', side: 'side-a' }));
  document.units.push(
    probeUnit({ name: 'Second', side: 'side-b', position: { x: 300, y: 200 }, facing: 0 }),
  );
  return document;
}

function submissionFor(battle, orders) {
  return {
    formatVersion: 1,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
  };
}

function startHumanBattle(seed = 7) {
  return startBattle(freshPlayable(), {
    seed,
    controllers: { 'side-a': 'human', 'side-b': 'human' },
  });
}

describe('roundOfTurn', () => {
  it('counts rounds as pairs of turns', () => {
    assert.equal(roundOfTurn(1), 1);
    assert.equal(roundOfTurn(2), 1);
    assert.equal(roundOfTurn(3), 2);
    assert.equal(roundOfTurn(4), 2);
  });
});

describe('groupLogEvents', () => {
  it('opens with the starting draw and groups each turn with its round', async () => {
    let battle = startHumanBattle();
    battle = resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) });
    const groups = groupLogEvents(battle);
    assert.equal(groups[0].turnNumber, 0);
    assert.equal(groups[0].phase, 'Battle start');
    const turn = groups.find((group) => group.turnNumber === 1);
    assert.ok(turn);
    assert.equal(turn.round, 1);
    assert.equal(turn.side, battle.activeSide === 'side-a' ? 'side-b' : 'side-a');
    assert.ok(turn.sections.length > 0);
    assert.ok(turn.sections.every((section) => section.events.length > 0));
  });

  it('keeps causal order across several turns', async () => {
    let battle = startHumanBattle();
    for (let turn = 0; turn < 3; turn += 1) {
      battle = resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) });
    }
    const groups = groupLogEvents(battle).filter((group) => group.turnNumber > 0);
    assert.deepEqual(groups.map((group) => group.turnNumber), [1, 2, 3]);
    assert.deepEqual(groups.map((group) => group.round), [1, 1, 2]);
  });
});

describe('describeBattleEvent', () => {
  it('reads in English and names every chance outcome with its draw', () => {
    const battle = startHumanBattle();
    const line = describeBattleEvent(
      { seq: 1, type: 'random-draw', purpose: 'combat-loss', unitId: 'x', opponentId: 'y', value: 0.412, result: 6 },
      battle,
    );
    assert.match(line, /0\.412/);
    assert.match(line, /6/);
    const fallback = describeBattleEvent(
      { seq: 2, type: 'player-fallback', side: 'side-a', reason: 'player timed out after 1000 ms' },
      battle,
    );
    assert.match(fallback, /holds every unit/);
    assert.match(fallback, /timed out/);
    const salvaged = describeBattleEvent(
      { seq: 3, type: 'order-substituted', side: 'side-a', unitId: 'u', code: 'invalid_move' },
      battle,
    );
    assert.match(salvaged, /Salvaged/);
  });

  it('describes contacts, losses, cohesion, routs, and the battle end', () => {
    const battle = startHumanBattle();
    assert.match(
      describeBattleEvent({ type: 'unit-charged', unitId: 'a', targetId: 'b', edge: 'front', aspect: 'front' }, battle),
      /charged/,
    );
    assert.match(
      describeBattleEvent({ type: 'units-shot', unitId: 'a', targetId: 'b', losses: 3, soldiers: { before: 100, after: 97 } }, battle),
      /3 soldiers lost/,
    );
    assert.match(
      describeBattleEvent({ type: 'unit-cohesion', unitId: 'a', cohesionBefore: 'Steady', cohesionAfter: 'Disordered' }, battle),
      /Steady → Disordered/,
    );
    assert.match(describeBattleEvent({ type: 'unit-fled', unitId: 'a' }, battle), /fled the battlefield/);
    assert.match(
      describeBattleEvent({ type: 'battle-ended', reason: 'concede', winner: 'side-a' }, battle),
      /wins/,
    );
  });
});

describe('summarizeTurn and changedUnitsForTurn', () => {
  it('summarises an empty turn with no losses and no highlights', () => {
    let battle = startHumanBattle();
    battle = resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) });
    const summary = summarizeTurn(battle, 1);
    assert.equal(summary.turnNumber, 1);
    assert.equal(summary.round, 1);
    assert.ok(typeof summary.side === 'string');
    assert.deepEqual(summary.losses, []);
    assert.deepEqual(changedUnitsForTurn(battle, 1), []);
    assert.equal(lastResolvedTurnNumber(battle), 1);
  });

  it('records the runner fallbacks of a non-human player', async () => {
    const battle = startBattle(freshPlayable(), {
      seed: 11,
      controllers: { 'side-a': 'passive', 'side-b': 'passive' },
    });
    const players = { 'side-a': createPassivePlayer(), 'side-b': createPassivePlayer() };
    const step = await runTurn(battle, players, { timeoutMs: 0 });
    assert.equal(step.fallback, null);
    const groups = groupLogEvents(step.battle);
    assert.ok(groups.some((group) => group.turnNumber === 1));
  });

  it('flags losses, cohesion changes, routs, and removals after a fight', () => {
    const battle = startHumanBattle();
    const shoved = JSON.parse(JSON.stringify(battle));
    shoved.events.push({
      seq: shoved.events.length,
      type: 'units-fought',
      turnNumber: 1,
      side: 'side-a',
      pair: ['u-a', 'u-b'],
      aspect: 'front',
      frontageM: 10,
      fights: [
        { unitId: 'u-a', opponentId: 'u-b', lossesInflicted: 6, lossesTaken: 2 },
        { unitId: 'u-b', opponentId: 'u-a', lossesInflicted: 2, lossesTaken: 6 },
      ],
      soldiers: { 'u-a': { before: 100, after: 98 }, 'u-b': { before: 100, after: 94 } },
    });
    shoved.events.push({
      seq: shoved.events.length,
      type: 'unit-cohesion',
      turnNumber: 1,
      side: 'side-b',
      unitId: 'u-b',
      cohesionBefore: 'Steady',
      cohesionAfter: 'Disordered',
      valueBefore: 8,
      valueAfter: 3,
    });
    shoved.events.push({
      seq: shoved.events.length,
      type: 'unit-routed',
      turnNumber: 1,
      side: 'side-b',
      unitId: 'u-b',
      cause: 'flank-test',
      position: { x: 1, y: 1 },
    });
    const summary = summarizeTurn(shoved, 1);
    assert.equal(summary.losses.length, 2);
    assert.equal(summary.cohesion.length, 1);
    assert.equal(summary.routs.length, 1);
    const changed = changedUnitsForTurn(shoved, 1);
    const flagged = new Map(changed.map((entry) => [entry.unitId, entry.reasons]));
    assert.ok(flagged.get('u-b').includes('losses'));
    assert.ok(flagged.get('u-b').includes('cohesion'));
    assert.ok(flagged.get('u-b').includes('routed'));
  });

  it('places shooting, combat, and cohesion events in their phases', () => {
    assert.equal(phaseOfEvent({ type: 'units-shot', turnNumber: 1 }), 'Shooting');
    assert.equal(phaseOfEvent({ type: 'units-fought', turnNumber: 1 }), 'Combat');
    assert.equal(phaseOfEvent({ type: 'unit-cohesion', turnNumber: 1, cause: 'terrain' }), 'Cohesion');
    assert.equal(phaseOfEvent({ type: 'player-fallback', turnNumber: 1 }), 'Orders');
    assert.equal(phaseOfEvent({ type: 'random-draw', purpose: 'starting-side' }), 'Battle start');
  });
});
