// Unit tests for battle start: playability validation and the initial battle
// state. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  BATTLE_KIND,
  BattleStartError,
  CONTROLLERS,
  COHESION_STATES,
  RANDOM_DRAW_EVENT,
  STARTING_ROUND,
  STEADY_COHESION,
  createRng,
  isPlayable,
  normalizeSeed,
  startBattle,
  validatePlayability,
} from './battle.js';
import {
  RULESET_ID,
  RULESET_PARAMETERS,
  RULESET_VERSION,
} from './polis-classical.js';
import {
  cloneScenario,
  createScenario,
  exportScenario,
  generateId,
  validateScenario,
} from './scenario.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, '..', 'scenarios');

function loadFixture(name) {
  return JSON.parse(readFileSync(path.join(scenarioDir, name), 'utf8'));
}

const probeUnit = (overrides = {}) => ({
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
});

// A minimal playable scenario: one hoplite unit per side, far apart, on open
// ground under the provisional 0.1 reference the editor writes.
function freshPlayable() {
  const document = createScenario({ title: 'Probe battle' });
  document.units.push(probeUnit({ name: 'First', side: 'side-a' }));
  document.units.push(
    probeUnit({ name: 'Second', side: 'side-b', position: { x: 300, y: 200 }, facing: 0 }),
  );
  assert.deepEqual(validateScenario(document), []);
  return document;
}

function snapshot(document) {
  return JSON.stringify(document);
}

describe('seeded random generator (engine-owned)', () => {
  it('replays the same sequence from the same seed', () => {
    const first = createRng(42);
    const second = createRng(42);
    const draws = Array.from({ length: 5 }, () => first.next());
    assert.deepEqual(
      Array.from({ length: 5 }, () => second.next()),
      draws,
    );
    assert.ok(draws.every((value) => value >= 0 && value < 1));
  });

  it('advances its state with every draw', () => {
    const rng = createRng(7);
    const before = rng.state;
    rng.next();
    assert.notEqual(rng.state, before);
    assert.ok(Number.isInteger(rng.state));
  });

  it('normalises integer, numeric-string, and text seeds to uint32', () => {
    assert.equal(normalizeSeed(1234), 1234);
    assert.equal(normalizeSeed('1234'), 1234);
    assert.equal(normalizeSeed(' 1234 '), 1234);
    assert.equal(normalizeSeed(-1), 4294967295);
    assert.equal(normalizeSeed('meadow'), normalizeSeed('meadow'));
    assert.ok(Number.isInteger(normalizeSeed('meadow')));
  });

  it('rejects empty and non-numeric seeds, and requires an explicit seed', () => {
    assert.throws(() => normalizeSeed(1.5), /integer or a string/);
    assert.throws(() => normalizeSeed('  '), /non-empty string/);
    assert.throws(() => normalizeSeed(null), /integer or a string/);
    assert.throws(() => normalizeSeed(undefined), /requires a seed/);
    assert.throws(
      () => startBattle(freshPlayable(), { controllers: { 'side-a': 'human', 'side-b': 'random' } }),
      /requires a seed/,
    );
  });
});

describe('playability validation', () => {
  it('accepts a playable scenario and names no problems', () => {
    assert.deepEqual(validatePlayability(freshPlayable()), []);
    assert.equal(isPlayable(freshPlayable()), true);
  });

  it('is pure and never changes the scenario', () => {
    const document = freshPlayable();
    const before = snapshot(document);
    validatePlayability(document);
    assert.equal(snapshot(document), before);
  });

  it('refuses an incompatible ruleset reference', () => {
    const nextMajor = freshPlayable();
    nextMajor.ruleset = { id: 'polis-classical', version: '2.0' };
    const [problem] = validatePlayability(nextMajor);
    assert.equal(problem.code, 'incompatible-ruleset');
    assert.match(problem.message, /incompatible/);
    assert.equal(problem.unitId, null);

    const otherRules = freshPlayable();
    otherRules.ruleset = { id: 'other-rules', version: '1.0' };
    assert.ok(
      validatePlayability(otherRules).some((entry) => entry.code === 'incompatible-ruleset'),
    );
    assert.equal(isPlayable(nextMajor), false);
  });

  it('accepts the same major version and the provisional 0.1 reference', () => {
    const sameMajor = freshPlayable();
    sameMajor.ruleset = { id: RULESET_ID, version: '1.3' };
    assert.deepEqual(validatePlayability(sameMajor), []);
    assert.deepEqual(validatePlayability(freshPlayable()), []);
  });

  it('refuses an unknown troop-type key, naming the unit', () => {
    const document = freshPlayable();
    document.units[1].troopType = 'cataphract';
    const problems = validatePlayability(document);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'unknown-troop-type');
    assert.equal(problems[0].unitId, document.units[1].id);
    assert.match(problems[0].message, /Second/);
    assert.match(problems[0].message, /cataphract/);
  });

  it('refuses spacings outside the troop type permitted range', () => {
    const document = freshPlayable();
    document.units[0].lateralInterval = 5;
    document.units[1].rankDepth = 0.5;
    const problems = validatePlayability(document);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((entry) => entry.code === 'spacing-out-of-range'));
    assert.match(problems[0].message, /First/);
    assert.match(problems[0].message, /lateralInterval/);
    assert.match(problems[1].message, /rankDepth/);
  });

  it('refuses a footprint touching water, naming the feature', () => {
    const document = freshPlayable();
    document.terrainFeatures.push({
      id: 'lake-west',
      kind: 'ground',
      category: 'water',
      polygon: [
        { x: 285, y: 580 },
        { x: 315, y: 580 },
        { x: 315, y: 610 },
        { x: 285, y: 610 },
      ],
    });
    assert.deepEqual(validateScenario(document), []);
    const problems = validatePlayability(document);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'footprint-in-water');
    assert.equal(problems[0].unitId, document.units[0].id);
    assert.match(problems[0].message, /First/);
    assert.match(problems[0].message, /lake-west/);
  });

  it('reports every water feature a footprint touches', () => {
    const document = freshPlayable();
    // Two disjoint lakes (sharing only an edge, so structurally valid) that
    // both touch the same footprint: the left half and the right half.
    document.terrainFeatures.push(
      {
        id: 'lake-west',
        kind: 'ground',
        category: 'water',
        polygon: [
          { x: 285, y: 580 },
          { x: 300, y: 580 },
          { x: 300, y: 610 },
          { x: 285, y: 610 },
        ],
      },
      {
        id: 'lake-east',
        kind: 'ground',
        category: 'water',
        polygon: [
          { x: 300, y: 580 },
          { x: 315, y: 580 },
          { x: 315, y: 610 },
          { x: 300, y: 610 },
        ],
      },
    );
    assert.deepEqual(validateScenario(document), []);
    const problems = validatePlayability(document);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((entry) => entry.code === 'footprint-in-water'));
    assert.deepEqual(
      problems.map((entry) => entry.message.match(/feature "([^"]+)"/)[1]).sort(),
      ['lake-east', 'lake-west'],
    );
  });

  it('refuses opposing footprints touching but allows friendly contact', () => {
    // Opposing edge-to-edge contact: 10 m frontages meeting at x 605.
    const opposing = freshPlayable();
    opposing.units[0].position = { x: 600, y: 400 };
    opposing.units[0].facing = 0;
    opposing.units[1].position = { x: 610, y: 400 };
    opposing.units[1].facing = 180;
    assert.deepEqual(validateScenario(opposing), []);
    const problems = validatePlayability(opposing);
    assert.equal(problems.length, 1);
    assert.equal(problems[0].code, 'opposing-footprints-touch');
    assert.match(problems[0].message, /First/);
    assert.match(problems[0].message, /Second/);

    // The same geometry between friends is legal.
    const friendly = freshPlayable();
    friendly.units[1].side = 'side-a';
    friendly.units[1].name = 'Friendly second';
    friendly.units[0].position = { x: 600, y: 400 };
    friendly.units[0].facing = 0;
    friendly.units[1].position = { x: 610, y: 400 };
    friendly.units[1].facing = 180;
    assert.deepEqual(validateScenario(friendly), []);
    const sideProblems = validatePlayability(friendly);
    assert.ok(
      sideProblems.some((entry) => entry.code === 'side-without-units'),
      'expected the empty side to be the only refusal',
    );
    assert.ok(
      sideProblems.every((entry) => entry.code === 'side-without-units'),
      `friendly contact must stay legal, got: ${sideProblems.map((entry) => entry.code)}`,
    );
  });

  it('refuses a side with no units, naming the side', () => {
    const empty = createScenario({ title: 'Probe battle' });
    const problems = validatePlayability(empty);
    assert.equal(problems.length, 2);
    assert.ok(problems.every((entry) => entry.code === 'side-without-units'));
    assert.ok(problems.some((entry) => entry.message.includes('Athenians')));
    assert.ok(problems.some((entry) => entry.message.includes('Spartans')));

    const half = freshPlayable();
    half.units.pop();
    const [problem] = validatePlayability(half);
    assert.equal(problem.code, 'side-without-units');
    assert.equal(problem.side, 'side-b');
  });

  it('lists every problem at once', () => {
    const document = freshPlayable();
    document.ruleset = { id: 'polis-classical', version: '3.0' };
    document.units[0].troopType = 'cataphract';
    document.units.pop();
    document.units.push(
      probeUnit({ name: 'Lonely', side: 'side-c', position: { x: 900, y: 400 }, facing: 90 }),
    );
    document.units[1].lateralInterval = 9;
    const codes = validatePlayability(document).map((entry) => entry.code);
    assert.ok(codes.includes('incompatible-ruleset'));
    assert.ok(codes.includes('unknown-troop-type'));
    assert.ok(codes.includes('spacing-out-of-range'));
    assert.ok(codes.includes('side-without-units'));
  });
});

describe('battle start', () => {
  const controllers = { 'side-a': 'human', 'side-b': 'random' };

  it('produces the initial battle state from a scenario, a seed, and controllers', () => {
    const document = freshPlayable();
    const before = snapshot(document);
    const battle = startBattle(document, { seed: 1234, controllers });

    assert.equal(battle.kind, BATTLE_KIND);
    assert.deepEqual(battle.scenario, JSON.parse(before));
    assert.deepEqual(battle.ruleset, { id: RULESET_ID, version: RULESET_VERSION });
    assert.deepEqual(battle.parameters, RULESET_PARAMETERS);
    assert.equal(battle.seed, 1234);
    assert.ok(Number.isInteger(battle.rngState));
    assert.ok(['side-a', 'side-b'].includes(battle.startingSide));
    assert.deepEqual(battle.controllers, controllers);
    assert.equal(battle.round, STARTING_ROUND);
    assert.equal(battle.round, 1);
    assert.equal(battle.units.length, 2);
    assert.ok(battle.units.every((unit) => unit.cohesion === STEADY_COHESION));
    assert.ok(battle.units.every((unit) => unit.cohesion === 'Steady'));
    assert.deepEqual(
      battle.units.map((unit) => unit.id).sort(),
      document.units.map((unit) => unit.id).sort(),
    );
  });

  it('records every draw as an event and draws the starting side from the seed', () => {
    const first = startBattle(freshPlayable(), { seed: 99, controllers });
    const second = startBattle(freshPlayable(), { seed: 99, controllers });
    assert.equal(first.events.length, 1);
    const [event] = first.events;
    assert.equal(event.seq, 0);
    assert.equal(event.type, RANDOM_DRAW_EVENT);
    assert.equal(event.type, 'random-draw');
    assert.equal(event.purpose, 'starting-side');
    assert.ok(event.value >= 0 && event.value < 1);
    assert.equal(event.result, first.startingSide);
    // Same seed, same battle: the draw and its record replay exactly.
    assert.deepEqual(second.events, first.events);
    assert.equal(second.startingSide, first.startingSide);
    assert.equal(second.rngState, first.rngState);
  });

  it('never changes the scenario or its ruleset reference', () => {
    const document = freshPlayable();
    const before = snapshot(document);
    const battle = startBattle(document, { seed: 5, controllers });
    assert.equal(snapshot(document), before);
    assert.deepEqual(document.ruleset, { id: 'polis-classical', version: '0.1' });
    assert.notEqual(battle.scenario, document);
    battle.scenario.title = 'Edited snapshot';
    battle.units[0].cohesion = 'Routed';
    assert.equal(snapshot(document), before);
  });

  it('normalises controller names and keeps them on the battle', () => {
    const battle = startBattle(freshPlayable(), {
      seed: 5,
      controllers: { 'side-a': 'Human', 'side-b': 'PASSIVE' },
    });
    assert.deepEqual(battle.controllers, { 'side-a': 'human', 'side-b': 'passive' });
    assert.ok(CONTROLLERS.includes('human'));
  });

  it('requires a known controller for every side', () => {
    assert.throws(
      () => startBattle(freshPlayable(), { seed: 1, controllers: { 'side-a': 'human' } }),
      /controller for side "side-b"/,
    );
    assert.throws(
      () =>
        startBattle(freshPlayable(), {
          seed: 1,
          controllers: { 'side-a': 'human', 'side-b': 'oracle' },
        }),
      /Unknown controller/,
    );
    assert.throws(
      () =>
        startBattle(freshPlayable(), {
          seed: 1,
          controllers: { 'side-a': 'human', 'side-b': 'random', 'side-c': 'human' },
        }),
      /Unknown side/,
    );
    assert.throws(() => startBattle(freshPlayable(), { seed: 1 }), /controller per side/);
  });

  it('creates no battle for an unplayable scenario and lists every problem', () => {
    const document = freshPlayable();
    document.units[0].troopType = 'cataphract';
    document.units.pop();
    try {
      startBattle(document, { seed: 1, controllers });
      assert.fail('expected startBattle to throw');
    } catch (error) {
      assert.ok(error instanceof BattleStartError);
      assert.equal(error.code, 'unplayable-scenario');
      assert.ok(error.problems.length >= 2);
      assert.ok(error.problems.some((entry) => entry.code === 'unknown-troop-type'));
      assert.ok(error.problems.some((entry) => entry.code === 'side-without-units'));
      assert.match(error.message, /cataphract/);
    }
  });

  it('refuses a structurally invalid scenario without a playability report', () => {
    const document = freshPlayable();
    document.units[1].files = 500;
    assert.throws(() => startBattle(document, { seed: 1, controllers }), /must not exceed soldiers/);
    try {
      startBattle(document, { seed: 1, controllers });
      assert.fail('expected startBattle to throw');
    } catch (error) {
      assert.ok(!(error instanceof BattleStartError));
    }
  });

  it('knows the three cohesion states units start Steady in', () => {
    assert.deepEqual([...COHESION_STATES].sort(), ['Disordered', 'Routed', 'Steady']);
    assert.equal(STEADY_COHESION, 'Steady');
  });
});

describe('reference scenarios', () => {
  const playable = ['acceptance-plain.json', 'playable-meadow.json'];
  const unplayable = [
    ['unplayable-unknown-troop.json', 'unknown-troop-type'],
    ['unplayable-spacing.json', 'spacing-out-of-range'],
    ['unplayable-water.json', 'footprint-in-water'],
    ['unplayable-opposing-touch.json', 'opposing-footprints-touch'],
    ['unplayable-empty-side.json', 'side-without-units'],
    ['unplayable-ruleset.json', 'incompatible-ruleset'],
  ];

  it('ships playable references that pass structural and playability validation', () => {
    for (const name of playable) {
      const stored = loadFixture(name);
      assert.deepEqual(validateScenario(stored), [], `${name} must be structurally valid`);
      assert.deepEqual(validatePlayability(stored), [], `${name} must be playable`);
      assert.equal(cloneScenario(stored).id, stored.id);
    }
  });

  it('ships an unplayable reference covering each refusal rule', () => {
    for (const [name, code] of unplayable) {
      const stored = loadFixture(name);
      assert.deepEqual(validateScenario(stored), [], `${name} must be structurally valid`);
      const codes = validatePlayability(stored).map((entry) => entry.code);
      assert.ok(codes.includes(code), `${name} should report ${code}, got [${codes}]`);
    }
  });

  it('commits every reference as an exported file', () => {
    for (const name of [...playable, ...unplayable.map(([file]) => file)]) {
      const stored = loadFixture(name);
      assert.equal(exportScenario(stored).json, readFileSync(path.join(scenarioDir, name), 'utf8'));
    }
  });

  it('starts battles from the playable references', () => {
    for (const name of playable) {
      const stored = loadFixture(name);
      const controllers = {
        [stored.sides[0].id]: 'human',
        [stored.sides[1].id]: 'random',
      };
      const battle = startBattle(stored, { seed: 2026, controllers });
      assert.equal(battle.kind, 'battle');
      assert.ok(battle.units.every((unit) => unit.cohesion === 'Steady'));
    }
  });

  it('starts no battle from the unplayable references', () => {
    for (const [name, code] of unplayable) {
      const stored = loadFixture(name);
      const controllers = {
        [stored.sides[0].id]: 'human',
        [stored.sides[1].id]: 'random',
      };
      try {
        startBattle(stored, { seed: 2026, controllers });
        assert.fail(`expected ${name} to refuse battle start`);
      } catch (error) {
        assert.ok(error instanceof BattleStartError, `${name} should raise BattleStartError`);
        assert.ok(
          error.problems.some((entry) => entry.code === code),
          `${name} should report ${code}`,
        );
      }
    }
  });
});
