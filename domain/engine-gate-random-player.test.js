// Engine I acceptance gate (#27): the Random test player. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableActions,
  buildPlayerView,
  validateTurn,
} from './turn.js';
import {
  createPlayerForController,
  createRandomPlayer,
} from './players.js';
import { HOPLITE_A, freshBattle } from './engine-gate-helpers.js';

describe('Random player', () => {
  function decideWith(battle, player) {
    return player.decide({
      view: buildPlayerView(battle),
      availableActions: availableActions(battle, battle.activeSide),
      validate: (submission) => validateTurn(battle, submission),
    });
  }

  it('owns a seed separate from the battle generator', async () => {
    const battle = freshBattle();
    const before = battle.rngState;
    const player = createRandomPlayer({ seed: 42 });
    assert.equal(player.kind, 'random');
    assert.equal(player.seed, 42);
    const decision = await decideWith(battle, player);
    assert.equal(decision.type, 'commit');
    assert.equal(battle.rngState, before, 'thinking never draws the battle generator');
    const view = buildPlayerView(battle);
    const keys = JSON.stringify(view);
    assert.ok(!keys.includes('"seed"'), 'the player view carries no seed');
  });

  it('proposes the same orders from the same seed', async () => {
    const first = await decideWith(freshBattle(7), createRandomPlayer({ seed: 99 }));
    const second = await decideWith(freshBattle(7), createRandomPlayer({ seed: 99 }));
    assert.deepEqual(second.submission, first.submission);
  });

  it('draws every order from the available actions inside the movement allowance', async () => {
    const battle = freshBattle(7);
    const actions = availableActions(battle, battle.activeSide);
    const permitted = new Map(actions.units.map((entry) => [entry.unitId, new Set(entry.permitted.map((item) => item.kind))]));
    const allowance = new Map(actions.units.map((entry) => [entry.unitId, entry.movementAllowanceM]));
    const decision = await decideWith(battle, createRandomPlayer({ seed: 7 }));
    const result = validateTurn(battle, decision.submission);
    assert.equal(result.ok, true, 'whatever is proposed is accepted as-is');
    for (const order of decision.submission.orders) {
      assert.ok(permitted.has(order.unitId), `order for own unit ${order.unitId}`);
      assert.ok(permitted.get(order.unitId).has(order.kind), `${order.kind} is permitted for ${order.unitId}`);
    }
    for (const verdict of result.verdicts) {
      if (verdict.movement) {
        assert.ok(
          verdict.movement.requiredM <= verdict.movement.availableM,
          `unit ${verdict.unitId} moves inside its allowance`,
        );
        assert.ok(
          verdict.movement.requiredM <= allowance.get(verdict.unitId),
          `unit ${verdict.unitId} moves inside the shown allowance`,
        );
      }
    }
  });

  it('drops whatever validate rejects: a routed unit rallies or holds by omission', async () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.cohesion = 'Routed';
    unit.cohesionState = 'Routed';
    unit.cohesionValue = 0;
    const decision = await decideWith(battle, createRandomPlayer({ seed: 3 }));
    assert.equal(validateTurn(battle, decision.submission).ok, true);
    assert.ok(
      decision.submission.orders.every(
        (order) => order.unitId !== HOPLITE_A || order.kind === 'Rally',
      ),
      'the routed unit either rallies or holds by omission (only Rally is permitted)',
    );
  });

  it('never concedes and resolves through the controller factory', async () => {
    const battle = freshBattle();
    const player = createPlayerForController('random', { seed: 5 });
    assert.equal(player.kind, 'random');
    const decision = await decideWith(battle, player);
    assert.equal(decision.type, 'commit');
    assert.throws(() => createPlayerForController('oracle'), /No automated player/);
  });
});
