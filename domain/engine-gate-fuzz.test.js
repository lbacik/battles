// Engine I gate: Random vs Random fuzzing on the reference scenarios
// (N turns with no invariant violations). Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startBattle } from './battle.js';
import { createRandomPlayer, runTurn } from './players.js';
import {
  checkInvariants,
  fuzzScenarios,
  loadScenario,
  randomPlayers,
} from './engine-gate-helpers.js';

describe('Engine I gate: Random vs Random fuzzing', () => {
  it('plays Random vs Random across many seeds for N turns with no invariant violations', async () => {
    const scenarios = fuzzScenarios();
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const turns = 6;
    let played = 0;
    for (const scenario of scenarios) {
      for (const seed of seeds) {
        const controllers = Object.fromEntries(scenario.sides.map((side) => [side.id, 'random']));
        let battle = startBattle(JSON.parse(JSON.stringify(scenario)), { seed, controllers });
        const players = randomPlayers(scenario, seed);
        for (let turn = 0; turn < turns; turn += 1) {
          const before = battle;
          const step = await runTurn(battle, players, { timeoutMs: 0 });
          assert.equal(step.decision.type, 'commit', 'the Random game never concedes');
          checkInvariants(before, step);
          battle = step.battle;
          played += 1;
        }
      }
    }
    assert.equal(played, scenarios.length * seeds.length * turns);
  });

  it('replays the same seeds to the identical battle', async () => {
    async function play(seed) {
      const scenario = loadScenario('acceptance-plain.json');
      const controllers = Object.fromEntries(scenario.sides.map((side) => [side.id, 'random']));
      let battle = startBattle(JSON.parse(JSON.stringify(scenario)), { seed, controllers });
      const players = randomPlayers(scenario, seed);
      for (let turn = 0; turn < 4; turn += 1) {
        battle = (await runTurn(battle, players, { timeoutMs: 0 })).battle;
      }
      return battle;
    }
    const first = await play(20260714);
    const second = await play(20260714);
    assert.deepEqual(second.events, first.events);
    assert.deepEqual(second.units, first.units);
    assert.equal(first.rngState, second.rngState);
  });

  it('keeps the battle generator draws reproducible: Random draws add no battle events', async () => {
    const scenario = loadScenario('playable-meadow.json');
    const controllers = Object.fromEntries(scenario.sides.map((side) => [side.id, 'random']));
    let battle = startBattle(JSON.parse(JSON.stringify(scenario)), { seed: 9, controllers });
    const draws = battle.events.filter((event) => event.type === 'random-draw').length;
    const players = Object.fromEntries(
      scenario.sides.map((side, index) => [side.id, createRandomPlayer({ seed: 901 + index })]),
    );
    const step = await runTurn(battle, players, { timeoutMs: 0 });
    const randomDraws = step.battle.events
      .filter((event) => event.type === 'random-draw')
      .length;
    assert.equal(randomDraws, draws, 'thinking adds no engine draws');
  });
});
