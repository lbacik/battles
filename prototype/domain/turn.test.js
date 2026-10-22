// Unit tests for the turn contract: player view, available actions, order
// validation, turn resolution, the Passive player, and the runner.
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startBattle } from './battle.js';
import {
  AVAILABLE_ACTIONS_FORMAT_VERSION,
  ORDER_KIND_HOLD,
  PLAYER_VIEW_FORMAT_VERSION,
  REFUSAL_NOT_ACTIVE_SIDE,
  REFUSAL_STALE_TURN,
  REFUSAL_UNKNOWN_BATTLE,
  REJECTION_DUPLICATE_UNIT_ORDER,
  REJECTION_NOT_OWN_UNIT,
  REJECTION_UNKNOWN_UNIT,
  REJECTION_UNSUPPORTED_ORDER_KIND,
  SUBMISSION_FORMAT_VERSION,
  SUBMISSION_SCHEMA,
  TURN_CONTRACT_VERSION,
  TURN_PHASES,
  SubmissionParseError,
  TurnRejectedError,
  availableActions,
  buildPlayerView,
  otherSide,
  parseSubmission,
  resolveTurn,
  validateTurn,
} from './turn.js';
import { createPassivePlayer, runRounds, runTurn } from './players.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, '..', 'scenarios');

function loadReference() {
  return JSON.parse(readFileSync(path.join(scenarioDir, 'acceptance-plain.json'), 'utf8'));
}

function freshBattle(seed = 2026) {
  const stored = loadReference();
  const controllers = {
    [stored.sides[0].id]: 'passive',
    [stored.sides[1].id]: 'passive',
  };
  return startBattle(stored, { seed, controllers });
}

function submissionFor(battle, orders = [], overrides = {}) {
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
    ...overrides,
  };
}

function collectKeys(value, out = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectKeys(entry, out));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      out.add(key);
      collectKeys(entry, out);
    }
  }
  return out;
}

describe('player view', () => {
  it('carries the battlefield, terrain, and every unit with its situation', () => {
    const battle = freshBattle();
    const view = buildPlayerView(battle);
    assert.equal(view.formatVersion, PLAYER_VIEW_FORMAT_VERSION);
    assert.equal(view.battleId, battle.id);
    assert.deepEqual(view.battlefield, battle.scenario.battlefield);
    assert.deepEqual(view.terrain, battle.scenario.terrainFeatures);
    assert.equal(view.units.length, battle.units.length);
    for (const unit of view.units) {
      const source = battle.units.find((entry) => entry.id === unit.id);
      assert.ok(source, `view unit ${unit.id} matches a battle unit`);
      assert.equal(unit.side, source.side);
      assert.equal(unit.troopType, source.troopType);
      assert.deepEqual(unit.position, source.position);
      assert.equal(unit.facing, source.facing);
      assert.deepEqual(unit.front.midpoint, source.position);
      assert.ok(unit.front.left && unit.front.right, 'front edge endpoints are present');
      assert.equal(unit.soldiers, source.soldiers);
      assert.equal(unit.files, source.files);
      assert.equal(unit.formation.files, source.files);
      assert.equal(unit.formation.ranks, Math.ceil(source.soldiers / source.files));
      assert.ok(unit.formation.frontageM > 0 && unit.formation.depthM > 0);
      assert.equal(unit.cohesion.state, source.cohesion);
      assert.ok(Number.isInteger(unit.cohesion.value), 'cohesion carries a numeric value');
      assert.deepEqual(unit.engaged, { unitId: null, edge: null });
      assert.equal(unit.status, 'active');
    }
  });

  it('carries the round, active side, phase, ruleset, parameters, catalogue, and past events', () => {
    const battle = freshBattle();
    const view = buildPlayerView(battle);
    assert.equal(view.round, battle.round);
    assert.equal(view.turnNumber, battle.turnNumber);
    assert.equal(view.activeSide, battle.activeSide);
    assert.equal(view.phase, battle.phase);
    assert.deepEqual(view.ruleset, battle.ruleset);
    assert.ok(view.ruleset.id && view.ruleset.version, 'ruleset identifier and version are present');
    assert.deepEqual(view.parameters, battle.parameters);
    assert.ok(view.catalogue.hoplite, 'catalogue carries the troop types');
    assert.deepEqual(view.events, battle.events);
    assert.ok(view.events.length >= 1, 'the starting-side draw is among the past events');
  });

  it('never contains the seed or the generator state', () => {
    const battle = freshBattle();
    const view = buildPlayerView(battle);
    const keys = collectKeys(view);
    assert.ok(!keys.has('seed'), 'no seed key anywhere in the view');
    assert.ok(!keys.has('rngState'), 'no generator state key anywhere in the view');
  });

  it('shares no references with the battle', () => {
    const battle = freshBattle();
    const before = JSON.stringify(battle);
    const view = buildPlayerView(battle);
    view.units[0].position.x += 100;
    view.units[0].cohesion.state = 'Routed';
    view.events.push({ seq: 999, type: 'probe' });
    view.terrain.push({ id: 'probe' });
    assert.equal(JSON.stringify(battle), before);
  });
});

describe('available actions', () => {
  it('permits Hold, Move, Charge, and Reform per unit, and Shoot for missile troops', () => {
    const battle = freshBattle();
    const actions = availableActions(battle, battle.activeSide);
    assert.equal(actions.formatVersion, AVAILABLE_ACTIONS_FORMAT_VERSION);
    assert.equal(actions.side, battle.activeSide);
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    assert.equal(actions.units.length, own.length);
    const missileTroops = new Set(['peltast', 'archer', 'slinger', 'light_cavalry']);
    for (const entry of actions.units) {
      const source = battle.units.find((unit) => unit.id === entry.unitId);
      const missiles = missileTroops.has(source.troopType);
      assert.deepEqual(
        entry.permitted,
        missiles
          ? [{ kind: ORDER_KIND_HOLD }, { kind: 'Move' }, { kind: 'Charge' }, { kind: 'Reform' }, { kind: 'Shoot' }]
          : [{ kind: ORDER_KIND_HOLD }, { kind: 'Move' }, { kind: 'Charge' }, { kind: 'Reform' }],
      );
      const kinds = entry.unavailable.map((item) => item.kind).sort();
      assert.deepEqual(kinds, missiles ? ['Rally'] : ['Rally', 'Shoot']);
      for (const item of entry.unavailable) {
        assert.ok(item.code && item.reason, 'unavailable kinds name a reason');
      }
      assert.ok(Array.isArray(entry.chargeCandidates), 'charge hints are listed');
      if (missiles) {
        assert.ok(Array.isArray(entry.shootCandidates), 'shoot hints are listed for missile troops');
      } else {
        assert.deepEqual(entry.shootCandidates, []);
      }
      assert.ok(
        Number.isFinite(entry.movementAllowanceM) && entry.movementAllowanceM > 0,
        `unit ${entry.unitId} (${source.troopType}) names a positive allowance in metres`,
      );
    }
  });

  it('covers only the requested side and refuses unknown sides', () => {
    const battle = freshBattle();
    const actions = availableActions(battle, battle.activeSide);
    const ids = new Set(battle.units.filter((unit) => unit.side === battle.activeSide).map((unit) => unit.id));
    assert.ok(actions.units.every((entry) => ids.has(entry.unitId)));
    assert.throws(() => availableActions(battle, 'no-such-side'), /Unknown side/);
  });
});

describe('submission envelope and JSON Schema', () => {
  it('parses a valid submission into a copy', () => {
    const battle = freshBattle();
    const submission = submissionFor(battle, [{ unitId: battle.units[0].id, kind: 'Hold' }]);
    const parsed = parseSubmission(submission);
    assert.deepEqual(parsed, submission);
    assert.notEqual(parsed, submission);
    assert.notEqual(parsed.orders, submission.orders);
  });

  it('exposes a JSON Schema for the envelope', () => {
    assert.equal(SUBMISSION_SCHEMA.type, 'object');
    assert.ok(SUBMISSION_SCHEMA.required.includes('turnNumber'));
    assert.equal(SUBMISSION_SCHEMA.properties.formatVersion.const, SUBMISSION_FORMAT_VERSION);
    assert.equal(TURN_CONTRACT_VERSION, SUBMISSION_FORMAT_VERSION);
  });

  it('refuses untrusted input with a named error', () => {
    const battle = freshBattle();
    const valid = submissionFor(battle, []);
    assert.throws(() => parseSubmission(null), SubmissionParseError);
    assert.throws(() => parseSubmission([]), SubmissionParseError);
    assert.throws(
      () => parseSubmission({ ...valid, formatVersion: 999 }),
      /format version/,
    );
    assert.throws(() => parseSubmission({ ...valid, orders: {} }), /orders array/);
    assert.throws(
      () => parseSubmission(submissionFor(battle, [{ kind: 'Hold' }])),
      /unit id/,
    );
    assert.throws(
      () => parseSubmission(submissionFor(battle, [{ unitId: battle.units[0].id }])),
      /order kind/,
    );
    assert.throws(
      () => parseSubmission({ ...valid, battleId: '   ' }),
      /battle id/,
    );
    assert.throws(
      () => parseSubmission({ ...valid, extra: true }),
      /must not hold/,
    );
  });
});

describe('validation', () => {
  it('accepts an empty commit and a Hold for every own unit', () => {
    const battle = freshBattle();
    assert.equal(validateTurn(battle, submissionFor(battle, [])).ok, true);
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const orders = own.map((unit) => ({ unitId: unit.id, kind: 'Hold' }));
    const result = validateTurn(battle, submissionFor(battle, orders));
    assert.equal(result.ok, true);
    assert.ok(result.verdicts.every((verdict) => verdict.accepted));
    assert.equal(result.acceptedOrders.length, orders.length);
  });

  it('returns a verdict per order in sequence', () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const orders = [
      { unitId: own[0].id, kind: 'Hold' },
      { unitId: 'missing-unit', kind: 'Hold' },
      { unitId: own[1].id, kind: 'Hold' },
    ];
    const result = validateTurn(battle, submissionFor(battle, orders));
    assert.equal(result.ok, false);
    assert.equal(result.verdicts.length, 3);
    assert.deepEqual(
      result.verdicts.map((verdict) => verdict.orderIndex),
      [0, 1, 2],
    );
    assert.equal(result.verdicts[0].accepted, true);
    assert.equal(result.verdicts[1].accepted, false);
    assert.equal(result.verdicts[1].rejection.code, REJECTION_UNKNOWN_UNIT);
    assert.equal(result.verdicts[2].accepted, true);
    assert.equal(result.acceptedOrders.length, 2);
  });

  it('rejects unknown units, foreign units, and duplicate orders with the contract shape', () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const foreign = battle.units.find((unit) => unit.side !== battle.activeSide);
    const submission = submissionFor(battle, [
      { unitId: 'missing-unit', kind: 'Hold' },
      { unitId: foreign.id, kind: 'Hold' },
      { unitId: own[0].id, kind: 'Hold' },
      { unitId: own[0].id, kind: 'Hold' },
    ]);
    const result = validateTurn(battle, submission);
    assert.equal(result.ok, false);
    const codes = result.verdicts.filter((verdict) => !verdict.accepted).map((verdict) => verdict.rejection.code);
    assert.deepEqual(codes, [REJECTION_UNKNOWN_UNIT, REJECTION_NOT_OWN_UNIT, REJECTION_DUPLICATE_UNIT_ORDER]);
    assert.equal(REJECTION_UNKNOWN_UNIT, 'unknown_unit');
    assert.equal(REJECTION_NOT_OWN_UNIT, 'not_own_unit');
    assert.equal(REJECTION_DUPLICATE_UNIT_ORDER, 'duplicate_unit_order');
    for (const verdict of result.verdicts.filter((entry) => !entry.accepted)) {
      const { rejection } = verdict;
      assert.equal(rejection.orderIndex, verdict.orderIndex);
      assert.ok(rejection.unitId !== undefined, 'rejection names the unit');
      assert.ok(rejection.details && typeof rejection.details === 'object');
      assert.ok(typeof rejection.message === 'string' && rejection.message.length > 0);
    }
    const duplicate = result.verdicts[3].rejection;
    assert.equal(duplicate.code, 'duplicate_unit_order');
    assert.equal(duplicate.details.firstOrderIndex, 2);
  });

  it('rejects order kinds outside this slice', () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const result = validateTurn(
      battle,
      submissionFor(battle, [{ unitId: own[0].id, kind: 'Rally' }]),
    );
    assert.equal(result.ok, false);
    assert.equal(result.verdicts[0].rejection.code, REJECTION_UNSUPPORTED_ORDER_KIND);
  });

  it('refuses a stale turn number and a side that is not active for the whole submission', () => {
    const battle = freshBattle();
    const stale = validateTurn(battle, submissionFor(battle, [], { turnNumber: battle.turnNumber + 1 }));
    assert.equal(stale.ok, false);
    assert.equal(stale.code, REFUSAL_STALE_TURN);
    assert.equal(REFUSAL_STALE_TURN, 'stale_turn');
    assert.deepEqual(stale.verdicts, []);

    const idle = otherSide(battle, battle.activeSide);
    const wrong = validateTurn(battle, submissionFor(battle, [], { side: idle }));
    assert.equal(wrong.ok, false);
    assert.equal(wrong.code, REFUSAL_NOT_ACTIVE_SIDE);
    assert.equal(REFUSAL_NOT_ACTIVE_SIDE, 'not_active_side');
    assert.deepEqual(wrong.verdicts, []);

    const foreign = validateTurn(
      battle,
      submissionFor(battle, [{ unitId: battle.units[0].id, kind: 'Hold' }], { battleId: 'elsewhere' }),
    );
    assert.equal(foreign.ok, false);
    assert.equal(foreign.code, REFUSAL_UNKNOWN_BATTLE);
  });

  it('never changes the battle or the submission', () => {
    const battle = freshBattle();
    const submission = submissionFor(battle, [{ unitId: 'missing-unit', kind: 'Hold' }]);
    const beforeBattle = JSON.stringify(battle);
    const beforeSubmission = JSON.stringify(submission);
    validateTurn(battle, submission);
    assert.equal(JSON.stringify(battle), beforeBattle);
    assert.equal(JSON.stringify(submission), beforeSubmission);
  });
});

describe('resolution', () => {
  it('runs every phase, passes the turn, and counts rounds as pairs of turns', () => {
    let battle = freshBattle();
    assert.equal(battle.turnNumber, 1);
    assert.equal(battle.round, 1);
    const firstSide = battle.activeSide;

    battle = resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) });
    assert.equal(battle.turnNumber, 2);
    assert.equal(battle.activeSide, otherSide(freshBattle(), firstSide));
    assert.equal(battle.round, 1, 'turns 1 and 2 form round 1');
    const phases = battle.events.filter((event) => event.type === 'turn-phase').map((event) => event.phase);
    assert.deepEqual(phases, [...TURN_PHASES]);
    assert.ok(battle.events.some((event) => event.type === 'turn-resolved'));

    battle = resolveTurn(battle, { type: 'commit', submission: submissionFor(battle, []) });
    assert.equal(battle.turnNumber, 3);
    assert.equal(battle.activeSide, firstSide);
    assert.equal(battle.round, 2, 'turns 3 and 4 form round 2');
  });

  it('leaves units in place for Hold and stays pure', () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const before = JSON.stringify(battle);
    const submission = submissionFor(
      battle,
      own.map((unit) => ({ unitId: unit.id, kind: 'Hold' })),
    );
    const next = resolveTurn(battle, { type: 'commit', submission });
    assert.equal(JSON.stringify(battle), before);
    assert.deepEqual(next.units, battle.units);
    assert.ok(next.events.length > battle.events.length);
    assert.notEqual(next, battle);
  });

  it('re-validates on commit: all or nothing', () => {
    const battle = freshBattle();
    const before = JSON.stringify(battle);
    const bad = submissionFor(battle, [{ unitId: 'missing-unit', kind: 'Hold' }]);
    assert.throws(() => resolveTurn(battle, { type: 'commit', submission: bad }), TurnRejectedError);
    assert.equal(JSON.stringify(battle), before, 'a refused commit produces no battle');
  });

  it('ends the battle on concede with the other side the winner', () => {
    const battle = freshBattle();
    const next = resolveTurn(battle, { type: 'concede', side: battle.activeSide });
    assert.equal(next.status, 'conceded');
    assert.equal(next.winner, otherSide(battle, battle.activeSide));
    assert.ok(next.events.some((event) => event.type === 'turn-conceded'));
    assert.equal(JSON.stringify({ ...battle, events: battle.events }), JSON.stringify(battle));
  });
});

describe('Passive player', () => {
  it('always commits no orders through the shared contract', async () => {
    const battle = freshBattle();
    const player = createPassivePlayer();
    assert.equal(player.kind, 'passive');
    const decision = await player.decide({
      view: buildPlayerView(battle),
      availableActions: availableActions(battle, battle.activeSide),
      validate: (submission) => validateTurn(battle, submission),
    });
    assert.equal(decision.type, 'commit');
    assert.deepEqual(decision.submission.orders, []);
    assert.equal(validateTurn(battle, decision.submission).ok, true);
  });
});

describe('runner: Passive vs Passive', () => {
  it('plays N rounds on the reference scenario without exceptions', async () => {
    const players = { athens: createPassivePlayer(), sparta: createPassivePlayer() };
    const { battle: final, turns } = await runRounds(freshBattle(7), players, 3);
    assert.equal(turns.length, 6);
    assert.equal(final.turnNumber, 1 + 6);
    // Six turns complete three rounds, so the battle rests on the first turn
    // of round 4; the even turns opened rounds 2, 3, and 4 in sequence.
    assert.equal(final.round, 4);
    assert.deepEqual(
      turns.map((step) => step.battle.round),
      [1, 2, 2, 3, 3, 4],
    );
    assert.equal(final.status, 'ongoing');
    assert.ok(turns.every((step) => step.decision.type === 'commit'));
    assert.ok(turns.every((step) => step.substitutions.length === 0 && step.fallback === null));
    assert.ok(final.events.length > 0);
  });

  it('replays the same seed to the same battle', async () => {
    const players = { athens: createPassivePlayer(), sparta: createPassivePlayer() };
    const first = await runRounds(freshBattle(11), players, 2);
    const second = await runRounds(freshBattle(11), players, 2);
    assert.deepEqual(second.battle.events, first.battle.events);
    assert.deepEqual(second.battle.units, first.battle.units);
  });

  it('substitutes rejected orders and falls back to Hold instead of failing', async () => {
    const battle = freshBattle();
    const cheater = {
      kind: 'greedy',
      async decide({ view }) {
        return {
          type: 'commit',
          submission: {
            formatVersion: SUBMISSION_FORMAT_VERSION,
            battleId: view.battleId,
            turnNumber: view.turnNumber,
            side: view.activeSide,
            orders: [
              { unitId: 'missing-unit', kind: 'Hold' },
              ...view.units
                .filter((unit) => unit.side === view.activeSide)
                .map((unit) => ({ unitId: unit.id, kind: 'Hold' })),
            ],
          },
        };
      },
    };
    const players = { [battle.activeSide]: cheater, [otherSide(battle, battle.activeSide)]: createPassivePlayer() };
    const step = await runTurn(battle, players);
    assert.equal(step.battle.turnNumber, 2);
    assert.equal(step.substitutions.length, 1);
    assert.equal(step.substitutions[0].code, 'unknown_unit');
    assert.ok(step.battle.events.some((event) => event.type === 'order-substituted'));

    const silent = { kind: 'silent', async decide() { return null; } };
    const quiet = await runTurn(battle, {
      [battle.activeSide]: silent,
      [otherSide(battle, battle.activeSide)]: createPassivePlayer(),
    });
    assert.equal(quiet.battle.turnNumber, 2);
    assert.ok(quiet.fallback, 'a missing answer falls back');
    assert.ok(quiet.battle.events.some((event) => event.type === 'player-fallback'));
  });
});
