// Unit tests for scenario documents: creation, identity, and conventions. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_BATTLEFIELD,
  MAX_BATTLEFIELD_HEIGHT_M,
  MAX_BATTLEFIELD_WIDTH_M,
  RULESET_ID,
  RULESET_VERSION,
  SCENARIO_FORMAT_VERSION,
  SCENARIO_KIND,
  cloneScenario,
  createScenario,
  exportScenario,
  fitScale,
  fromScreenPoint,
  generateId,
  importScenarioDocument,
  isUuid,
  isValidScenario,
  roundScenarioToTenth,
  toScreenPoint,
  validateScenario,
} from '../scenario.js';
import { probeUnit } from './test-helpers.js';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('createScenario', () => {
  it('assigns a generated, immutable UUID identifier', () => {
    const first = createScenario({ title: 'Mantinea' });
    const second = createScenario({ title: 'Mantinea' });
    assert.ok(isUuid(first.id), `expected UUID, got ${first.id}`);
    assert.notEqual(first.id, second.id);
    assert.equal(first.id, cloneScenario(first).id);
  });

  it('requires a title', () => {
    assert.throws(() => createScenario({}), /title is required/i);
    assert.throws(() => createScenario({ title: '   ' }), /title is required/i);
  });

  it('defaults to a battlefield within the application limit', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    assert.deepEqual(scenario.battlefield, { ...DEFAULT_BATTLEFIELD });
    assert.ok(scenario.battlefield.width <= MAX_BATTLEFIELD_WIDTH_M);
    assert.ok(scenario.battlefield.height <= MAX_BATTLEFIELD_HEIGHT_M);
  });

  it('rejects battlefields outside the application limit', () => {
    assert.throws(
      () =>
        createScenario({
          title: 'Too big',
          battlefield: { width: MAX_BATTLEFIELD_WIDTH_M + 1, height: 800 },
        }),
      /must not exceed/,
    );
  });

  it('creates two sides with default names and distinct colours', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    assert.equal(scenario.sides.length, 2);
    assert.ok(scenario.sides.every((side) => side.name.trim().length > 0));
    assert.notEqual(scenario.sides[0].name, scenario.sides[1].name);
    assert.notEqual(
      scenario.sides[0].color.toLowerCase(),
      scenario.sides[1].color.toLowerCase(),
    );
  });

  it('rejects sides with identical colours', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    scenario.sides[1].color = scenario.sides[0].color;
    assert.match(validateScenario(scenario).join(' '), /distinct colours/);
  });

  it('rejects sides with duplicate names', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    scenario.sides[1].name = scenario.sides[0].name;
    assert.match(validateScenario(scenario).join(' '), /already used/);
  });

  it('wraps facings into a 0-360 compass bearing when rounding', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    const probe = {
      ...scenario,
      units: [
        { ...probeUnit(), facing: 720 },
        { ...probeUnit(), id: generateId(), name: 'Second taxis', facing: -45 },
      ],
    };
    const rounded = roundScenarioToTenth(probe);
    assert.equal(rounded.units[0].facing, 0);
    assert.equal(rounded.units[1].facing, 315);
  });

  it('references the polis-classical ruleset', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    assert.deepEqual(scenario.ruleset, { id: RULESET_ID, version: RULESET_VERSION });
    assert.equal(scenario.ruleset.id, 'polis-classical');
    assert.equal(scenario.ruleset.version, '0.1');
  });

  it('carries the document kind and an integer format version', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    assert.equal(scenario.kind, SCENARIO_KIND);
    assert.equal(scenario.kind, 'scenario');
    assert.ok(Number.isInteger(scenario.formatVersion));
    assert.equal(scenario.formatVersion, SCENARIO_FORMAT_VERSION);
  });

  it('keeps library metadata apart from the document', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    assert.ok(!Object.hasOwn(scenario, 'revision'));
    const withRevision = { ...scenario, revision: 3 };
    assert.match(validateScenario(withRevision).join(' '), /must not be stored/);
  });

  it('starts with empty forces and an empty battlefield', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    assert.deepEqual(scenario.units, []);
    assert.deepEqual(scenario.terrainFeatures, []);
    assert.ok(isValidScenario(scenario));
  });
});

describe('map convention (ADR 0001)', () => {
  it('flips only the vertical axis for the screen', () => {
    // Origin south-west: a point 100 m north of the origin on an 800 m deep
    // battlefield renders 700 px from the top of an 800 px tall view.
    assert.deepEqual(toScreenPoint({ x: 250, y: 100 }, 800), { x: 250, y: 700 });
    assert.deepEqual(toScreenPoint({ x: 0, y: 0 }, 800), { x: 0, y: 800 });
    assert.deepEqual(fromScreenPoint({ x: 250, y: 700 }, 800), { x: 250, y: 100 });
  });

  it('fits the true-scale battlefield into a viewport', () => {
    assert.equal(fitScale(1200, 800, 600, 400), 0.5);
    assert.equal(fitScale(1200, 800, 0, 400), 1);
  });
});

describe('framework independence', () => {
  it('imports nothing from React or Next.js', () => {
    for (const file of ['scenario.js', 'store.js']) {
      const source = readFileSync(path.join(here, '..', file), 'utf8');
      assert.ok(!/from\s+['"]react['"]/.test(source), `${file} imports react`);
      assert.ok(!/from\s+['"]next/.test(source), `${file} imports next`);
      assert.ok(!/require\(\s*['"]react['"]/.test(source), `${file} requires react`);
      assert.ok(!/require\(\s*['"]next/.test(source), `${file} requires next`);
    }
  });
});

describe('complete scenario model', () => {
  it('holds a description alongside the title', () => {
    const scenario = createScenario({ title: 'Mantinea', description: 'Plain of Mantinea.' });
    assert.equal(scenario.description, 'Plain of Mantinea.');
    assert.ok(isValidScenario(scenario));
  });

  it('rejects a non-text description', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    scenario.description = 42;
    assert.match(validateScenario(scenario).join(' '), /plain text/);
  });

  it('rounds stored metre values to 0.1 m', () => {
    const scenario = createScenario({
      title: 'Mantinea',
      units: [
        {
          id: generateId(),
          name: 'Taxis',
          side: 'side-a',
          troopType: 'hoplite',
          soldiers: 100,
          files: 10,
          lateralInterval: 1.05,
          rankDepth: 0.94,
          position: { x: 100.04, y: 200.05 },
          facing: 30.05,
        },
      ],
      terrainFeatures: [
        {
          id: 'river',
          kind: 'linear',
          category: 'river',
          path: [
            { x: 0.04, y: 0 },
            { x: 100, y: 200.05 },
          ],
          width: 12.06,
        },
      ],
    });
    const [unit] = scenario.units;
    assert.equal(unit.lateralInterval, 1.1);
    assert.equal(unit.rankDepth, 0.9);
    assert.deepEqual(unit.position, { x: 100, y: 200.1 });
    assert.equal(unit.facing, 30.1);
    assert.equal(scenario.terrainFeatures[0].width, 12.1);
  });

  it('roundScenarioToTenth never mutates its input', () => {
    const scenario = createScenario({ title: 'Mantinea' });
    const rounded = roundScenarioToTenth(scenario);
    assert.notEqual(rounded, scenario);
    assert.deepEqual(rounded, scenario);
  });
});

describe('reference scenario', () => {
  it('round-trips through import and export with identical values', () => {
    const file = readFileSync(
      path.join(here, '..', 'fixtures', 'acceptance-plain.json'),
      'utf8',
    );
    const stored = JSON.parse(file);
    assert.deepEqual(validateScenario(stored), []);
    const copy = importScenarioDocument(file);
    assert.notEqual(copy.id, stored.id);
    const { json } = exportScenario(copy);
    const roundTripped = JSON.parse(json);
    assert.deepEqual(
      { ...roundTripped, id: stored.id },
      { ...stored, updatedAt: roundTripped.updatedAt, createdAt: roundTripped.createdAt },
    );
    // Exporting the stored file is byte-identical: it is the exported form.
    assert.equal(exportScenario(stored).json, file);
  });
});
