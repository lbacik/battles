// Engine I acceptance gate (#27): the runner fallbacks. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTurn } from './turn.js';
import {
  RUNNER_DEFAULTS,
  createPassivePlayer,
  createRandomPlayer,
  resolveRunnerOptions,
  runRounds,
  runTurn,
} from './players.js';
import {
  HOPLITE_A,
  freshBattle,
  submissionFor,
} from './engine-gate-helpers.js';

describe('runner fallbacks', () => {
  function playersFor(battle, player) {
    const idle = battle.scenario.sides.map((side) => side.id).find((id) => id !== battle.activeSide);
    return { [battle.activeSide]: player, [idle]: createPassivePlayer() };
  }

  it('asks again within a bounded number of attempts, feeding each refusal back', async () => {
    const battle = freshBattle();
    const seen = [];
    const player = {
      kind: 'flaky',
      async decide(input) {
        seen.push(input);
        if (input.attempt === 1) {
          assert.equal(input.previousResult, null, 'the first attempt carries no refusal');
          return {
            type: 'commit',
            submission: submissionFor(battle, [{ unitId: 'missing-unit', kind: 'Hold' }]),
          };
        }
        assert.ok(input.previousResult, 'the retry carries the refusal');
        assert.equal(input.previousResult.code, 'orders_rejected');
        assert.deepEqual(
          input.previousResult.verdicts.filter((verdict) => !verdict.accepted).map((verdict) => verdict.rejection.code),
          ['unknown_unit'],
        );
        return { type: 'commit', submission: submissionFor(battle, []) };
      },
    };
    const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 3, timeoutMs: 0 });
    assert.equal(step.attempts, 2);
    assert.equal(step.decision.type, 'commit');
    assert.equal(step.fallback, null, 'a retry that lands needs no fallback');
    assert.deepEqual(step.substitutions, []);
    assert.ok(
      step.battle.events.some((event) => event.type === 'player-attempt-refused' && event.code === 'orders_rejected'),
      'the refused attempt is recorded in the battle events',
    );
    const order = step.battle.events.map((event) => event.type);
    assert.ok(
      order.indexOf('player-attempt-refused') < order.indexOf('turn-resolved'),
      'the refusal sorts before the resolution in causal order',
    );
    assert.deepEqual(
      step.battle.events.map((event) => event.seq),
      step.battle.events.map((_, index) => index),
      'event sequence numbers stay consecutive',
    );
    assert.equal(step.battle.turnNumber, battle.turnNumber + 1);
  });

  it('salvages by removing the first rejected order when the attempts are exhausted', async () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    let calls = 0;
    const player = {
      kind: 'stubborn',
      async decide() {
        calls += 1;
        return {
          type: 'commit',
          submission: submissionFor(battle, [
            { unitId: 'missing-unit', kind: 'Hold' },
            { unitId: own[0].id, kind: 'Hold' },
          ]),
        };
      },
    };
    const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 2, timeoutMs: 0 });
    assert.equal(calls, 2, 'both attempts run before the salvage');
    assert.equal(step.decision.type, 'commit');
    assert.equal(validateTurn(battle, step.decision.submission).ok, true);
    assert.deepEqual(step.decision.submission.orders, [{ unitId: own[0].id, kind: 'Hold' }]);
    assert.equal(step.substitutions.length, 1);
    assert.equal(step.substitutions[0].code, 'unknown_unit');
    assert.ok(step.fallback && step.fallback.includes('salvaged'), 'the salvage is a recorded fallback');
    assert.ok(step.battle.events.some((event) => event.type === 'order-substituted'));
    assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'));
  });

  it('holds when an envelope-level refusal leaves nothing to salvage', async () => {
    const battle = freshBattle();
    const player = {
      kind: 'stale',
      async decide() {
        return {
          type: 'commit',
          submission: submissionFor(battle, [{ unitId: HOPLITE_A, kind: 'Hold' }], {
            turnNumber: battle.turnNumber + 9,
          }),
        };
      },
    };
    const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 2, timeoutMs: 0 });
    assert.deepEqual(step.decision.submission.orders, []);
    assert.deepEqual(step.substitutions, []);
    assert.ok(step.fallback && step.fallback.includes('stale_turn'));
    assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'));
    assert.equal(step.battle.turnNumber, battle.turnNumber + 1);
  });

  it('holds on a missing, unparseable, or thrown answer, and never concedes', async () => {
    for (const [name, player] of [
      ['missing', { kind: 'silent', async decide() { return null; } }],
      ['unparseable', { kind: 'noisy', async decide() { return { type: 'retreat' }; } }],
      ['throwing', { kind: 'loud', async decide() { throw new Error('boom'); } }],
    ]) {
      const battle = freshBattle();
      const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 3, timeoutMs: 0 });
      assert.equal(step.attempts, 1, `${name}: no retry after a missing answer`);
      assert.equal(step.decision.type, 'commit', `${name}: the fallback commits, never concedes`);
      assert.deepEqual(step.decision.submission.orders, [], `${name}: every unit holds`);
      assert.ok(step.fallback, `${name}: the fallback is recorded`);
      assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'), name);
      assert.equal(step.battle.status, 'ongoing', `${name}: the battle is never conceded automatically`);
    }
  });

  it('holds when the player outlasts the timeout', async () => {
    const battle = freshBattle();
    const player = {
      kind: 'slow',
      async decide() {
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        return { type: 'commit', submission: submissionFor(battle, []) };
      },
    };
    const step = await runTurn(battle, playersFor(battle, player), { maxAttempts: 3, timeoutMs: 10 });
    assert.equal(step.decision.type, 'commit');
    assert.deepEqual(step.decision.submission.orders, []);
    assert.ok(step.fallback && step.fallback.includes('timed out'));
    assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'));
  });

  it('honours an explicit concede but never invents one', async () => {
    const battle = freshBattle();
    const step = await runTurn(
      battle,
      playersFor(battle, { kind: 'yielding', async decide() { return { type: 'concede' }; } }),
      { timeoutMs: 0 },
    );
    assert.equal(step.decision.type, 'concede');
    assert.equal(step.battle.status, 'conceded');
  });

  it('treats the attempt count and the timeout as configuration', () => {
    assert.deepEqual(resolveRunnerOptions({}), RUNNER_DEFAULTS);
    assert.deepEqual(resolveRunnerOptions({ maxAttempts: 1, timeoutMs: 0 }), { maxAttempts: 1, timeoutMs: 0 });
    assert.throws(() => resolveRunnerOptions({ maxAttempts: 0 }), /attempt count/);
    assert.throws(() => resolveRunnerOptions({ timeoutMs: -1 }), /timeout/);
  });

  it('salvages through a misbehaving wrapper around the Random player', async () => {
    const battle = freshBattle();
    const random = createRandomPlayer({ seed: 11 });
    const wrapper = {
      kind: 'random',
      async decide(input) {
        const decision = await random.decide(input);
        return {
          type: 'commit',
          submission: { ...decision.submission, orders: [{ unitId: 'missing-unit', kind: 'Hold' }, ...decision.submission.orders] },
        };
      },
    };
    const step = await runTurn(battle, playersFor(battle, wrapper), { maxAttempts: 2, timeoutMs: 0 });
    assert.ok(step.substitutions.length >= 1);
    assert.equal(step.substitutions[0].code, 'unknown_unit', 'the injected first order is salvaged away');
    assert.equal(validateTurn(battle, step.decision.submission).ok, true);
    assert.ok(step.battle.events.some((event) => event.type === 'order-substituted'));
  });

  it('holds on timeout through a delayed wrapper around the Random player', async () => {
    const battle = freshBattle();
    const random = createRandomPlayer({ seed: 11 });
    const wrapper = {
      kind: 'random',
      async decide(input) {
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        return random.decide(input);
      },
    };
    const step = await runTurn(battle, playersFor(battle, wrapper), { maxAttempts: 2, timeoutMs: 10 });
    assert.deepEqual(step.decision.submission.orders, []);
    assert.ok(step.fallback && step.fallback.includes('timed out'));
    assert.ok(step.battle.events.some((event) => event.type === 'player-fallback'));
  });

  it('passes the runner configuration through runRounds', async () => {
    const battle = freshBattle();
    const players = {
      [battle.activeSide]: createPassivePlayer(),
      [battle.scenario.sides.map((side) => side.id).find((id) => id !== battle.activeSide)]: createPassivePlayer(),
    };
    const { battle: final, turns } = await runRounds(battle, players, 1, { maxAttempts: 1, timeoutMs: 0 });
    assert.equal(turns.length, 2);
    assert.ok(turns.every((step) => step.attempts === 1));
    assert.equal(final.turnNumber, battle.turnNumber + 2);
  });
});
