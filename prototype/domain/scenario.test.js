// Unit tests for the framework-free scenario model. Run with: npm test
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
  ScenarioImportError,
  cloneScenario,
  createScenario,
  exportScenario,
  fitScale,
  fromScreenPoint,
  generateId,
  importScenarioDocument,
  isUuid,
  isValidScenario,
  parseScenarioImport,
  roundScenarioToTenth,
  scenarioFileName,
  toScreenPoint,
  validateScenario,
} from './scenario.js';
import { MemoryScenarioStore } from './store.js';

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
      const source = readFileSync(path.join(here, file), 'utf8');
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

const freshDocument = () => createScenario({ title: 'Validation probe' });

const probeUnit = (overrides = {}) => ({
  id: generateId(),
  name: 'Probe taxis',
  side: 'side-a',
  troopType: 'hoplite',
  soldiers: 100,
  files: 10,
  lateralInterval: 1,
  rankDepth: 1,
  position: { x: 600, y: 400 },
  facing: 0,
  ...overrides,
});

describe('structural validation: units', () => {
  it('accepts a well-formed unit', () => {
    const document = freshDocument();
    document.units.push(probeUnit());
    assert.deepEqual(validateScenario(document), []);
  });

  it('checks soldiers, files, and spacings', () => {
    for (const [overrides, pattern] of [
      [{ soldiers: 0 }, /soldiers/],
      [{ soldiers: 2.5 }, /soldiers/],
      [{ files: 0 }, /files/],
      [{ files: 101 }, /must not exceed soldiers/],
      [{ lateralInterval: 0 }, /lateralInterval/],
      [{ lateralInterval: 10.1 }, /application limit/],
      [{ rankDepth: -1 }, /rankDepth/],
      [{ rankDepth: 10.5 }, /application limit/],
    ]) {
      const document = freshDocument();
      document.units.push(probeUnit(overrides));
      assert.match(validateScenario(document).join(' '), pattern, JSON.stringify(overrides));
    }
  });

  it('requires side, troop type, and a unique name', () => {
    const missing = freshDocument();
    missing.units.push(probeUnit({ side: '', troopType: '', name: '  ' }));
    assert.match(validateScenario(missing).join(' '), /side is required/);
    assert.match(validateScenario(missing).join(' '), /troop type is required/);
    assert.match(validateScenario(missing).join(' '), /name is required/);

    const unknownSide = freshDocument();
    unknownSide.units.push(probeUnit({ side: 'side-c' }));
    assert.match(validateScenario(unknownSide).join(' '), /does not match any side/);

    const duplicateNames = freshDocument();
    duplicateNames.units.push(probeUnit({ name: 'Taxis' }));
    duplicateNames.units.push(probeUnit({ name: 'taxis ' }));
    assert.match(validateScenario(duplicateNames).join(' '), /already used/);

    const duplicateIds = freshDocument();
    duplicateIds.units.push(probeUnit({ id: 'same', name: 'First' }));
    duplicateIds.units.push(probeUnit({ id: 'same', name: 'Second' }));
    assert.match(validateScenario(duplicateIds).join(' '), /must be unique/);
  });

  it('does not treat catalogue membership as structural', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ troopType: 'cataphract' }));
    assert.deepEqual(validateScenario(document), []);
  });

  it('keeps footprints wholly inside the battlefield', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ position: { x: 2, y: 400 } }));
    assert.match(validateScenario(document).join(' '), /outside the battlefield/);
  });

  it('rejects overlapping footprints but accepts touching ones', () => {
    const overlapping = freshDocument();
    overlapping.units.push(probeUnit({ name: 'First', position: { x: 600, y: 400 } }));
    overlapping.units.push(probeUnit({ name: 'Second', position: { x: 605, y: 400 } }));
    assert.match(validateScenario(overlapping).join(' '), /overlap/);

    // Edge to edge: the first spans x 595-605, the second x 605-615.
    const touching = freshDocument();
    touching.units.push(probeUnit({ name: 'First', position: { x: 600, y: 400 } }));
    touching.units.push(probeUnit({ name: 'Second', position: { x: 610, y: 400 } }));
    assert.deepEqual(validateScenario(touching), []);

    // A 0.05 m overlap is within the 0.1 m tolerance; 0.5 m is not.
    const sliver = freshDocument();
    sliver.units.push(probeUnit({ name: 'First', position: { x: 600, y: 400 } }));
    sliver.units.push(probeUnit({ name: 'Second', position: { x: 609.95, y: 400 } }));
    assert.deepEqual(validateScenario(sliver), []);

    const real = freshDocument();
    real.units.push(probeUnit({ name: 'First', position: { x: 600, y: 400 } }));
    real.units.push(probeUnit({ name: 'Second', position: { x: 609.5, y: 400 } }));
    assert.match(validateScenario(real).join(' '), /overlap/);
  });
});

const square = (x, y, size = 100) => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];

describe('structural validation: terrain', () => {
  it('accepts disjoint simple polygons and well-nested elevation', () => {
    const document = freshDocument();
    document.terrainFeatures.push(
      { id: 'forest', kind: 'ground', category: 'forest', polygon: square(100, 100) },
      { id: 'rough', kind: 'ground', category: 'rough', polygon: square(300, 100) },
      { id: 'hill', kind: 'elevation', level: 1, polygon: square(100, 400, 200) },
      { id: 'peak', kind: 'elevation', level: 2, polygon: square(150, 450, 60) },
      {
        id: 'river',
        kind: 'linear',
        category: 'river',
        path: [
          { x: 0, y: 700 },
          { x: 600, y: 750 },
        ],
        width: 12,
      },
    );
    assert.deepEqual(validateScenario(document), []);
  });

  it('rejects overlapping ground cover areas', () => {
    const document = freshDocument();
    document.terrainFeatures.push(
      { id: 'first', kind: 'ground', category: 'forest', polygon: square(100, 100) },
      { id: 'second', kind: 'ground', category: 'water', polygon: square(150, 150, 100) },
    );
    assert.match(validateScenario(document).join(' '), /overlap/);
  });

  it('rejects self-intersecting polygons', () => {
    const document = freshDocument();
    document.terrainFeatures.push({
      id: 'bowtie',
      kind: 'ground',
      category: 'forest',
      polygon: [
        { x: 100, y: 100 },
        { x: 200, y: 200 },
        { x: 200, y: 100 },
        { x: 100, y: 200 },
      ],
    });
    assert.match(validateScenario(document).join(' '), /simple polygon/);
  });

  it('rejects badly nested elevation levels', () => {
    const stray = freshDocument();
    stray.terrainFeatures.push({
      id: 'peak',
      kind: 'elevation',
      level: 2,
      polygon: square(500, 500, 60),
    });
    assert.match(validateScenario(stray).join(' '), /wholly inside/);

    const crossing = freshDocument();
    crossing.terrainFeatures.push(
      { id: 'hill-a', kind: 'elevation', level: 1, polygon: square(100, 100, 200) },
      { id: 'hill-b', kind: 'elevation', level: 1, polygon: square(200, 200, 200) },
    );
    assert.match(validateScenario(crossing).join(' '), /must never cross/);
  });

  it('rejects non-positive widths and out-of-bounds terrain', () => {
    const width = freshDocument();
    width.terrainFeatures.push({
      id: 'river',
      kind: 'linear',
      category: 'river',
      path: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
      width: 0,
    });
    assert.match(validateScenario(width).join(' '), /positive/);

    const bounds = freshDocument();
    bounds.terrainFeatures.push({
      id: 'far',
      kind: 'ground',
      category: 'forest',
      polygon: square(5000, 5000, 50),
    });
    assert.match(validateScenario(bounds).join(' '), /outside the battlefield/);
  });
});

describe('export and import', () => {
  it('names the file after the title', () => {
    assert.equal(scenarioFileName('Acceptance Plain'), 'Acceptance-Plain.json');
    assert.equal(scenarioFileName('  '), 'scenario.json');
  });

  it('exports the stored document without library metadata', () => {
    const document = createScenario({ title: 'Mantinea', description: 'Plain.' });
    const exported = exportScenario(document);
    assert.equal(exported.fileName, 'Mantinea.json');
    const parsed = JSON.parse(exported.json);
    assert.equal(parsed.kind, 'scenario');
    assert.equal(parsed.formatVersion, 1);
    assert.deepEqual(parsed.ruleset, { id: RULESET_ID, version: RULESET_VERSION });
    assert.ok(!Object.hasOwn(parsed, 'revision'));
  });

  it('imports an export as a new copy with a new identifier', async () => {
    const store = new MemoryScenarioStore();
    const document = createScenario({ title: 'Mantinea' });
    const { json } = exportScenario(document);
    const copy = importScenarioDocument(json);
    assert.notEqual(copy.id, document.id);
    assert.ok(isUuid(copy.id));
    await store.save(copy);
    assert.deepEqual((await store.load(copy.id)).title, 'Mantinea');
  });

  it('rejects a non-JSON file', () => {
    assert.throws(() => parseScenarioImport('this is not json {'), /not valid JSON/);
    try {
      parseScenarioImport('nope');
    } catch (error) {
      assert.ok(error instanceof ScenarioImportError);
      assert.equal(error.code, 'not-json');
      return;
    }
    assert.fail('expected a ScenarioImportError');
  });

  it('rejects another document kind', () => {
    const other = JSON.stringify({ kind: 'battle', formatVersion: 1 });
    assert.throws(() => parseScenarioImport(other), /not a scenario/);
    try {
      parseScenarioImport(other);
    } catch (error) {
      assert.equal(error.code, 'not-scenario-kind');
    }
  });

  it('rejects a higher format version', () => {
    const document = createScenario({ title: 'Mantinea' });
    const newer = JSON.stringify({ ...JSON.parse(exportScenario(document).json), formatVersion: 2 });
    assert.throws(() => parseScenarioImport(newer), /newer than the supported/);
    try {
      parseScenarioImport(newer);
    } catch (error) {
      assert.equal(error.code, 'unsupported-version');
    }
  });

  it('rejects an unknown ruleset identifier', () => {
    const document = createScenario({ title: 'Mantinea' });
    const parsed = JSON.parse(exportScenario(document).json);
    parsed.ruleset = { id: 'other-rules', version: '1.0' };
    assert.throws(() => parseScenarioImport(JSON.stringify(parsed)), /unknown ruleset/);
    try {
      parseScenarioImport(JSON.stringify(parsed));
    } catch (error) {
      assert.equal(error.code, 'unknown-ruleset');
    }
  });

  it('rejects structurally invalid content and names the problem', () => {
    const document = createScenario({ title: 'Mantinea' });
    const parsed = JSON.parse(exportScenario(document).json);
    parsed.units = [
      probeUnit({ name: 'Broken', files: 500, soldiers: 100, position: { x: 600, y: 400 } }),
    ];
    assert.throws(() => parseScenarioImport(JSON.stringify(parsed)), /files/);
    try {
      parseScenarioImport(JSON.stringify(parsed));
    } catch (error) {
      assert.equal(error.code, 'invalid-content');
    }
  });

  it('leaves the library unchanged when an import fails', async () => {
    const store = new MemoryScenarioStore();
    const before = await store.list();
    for (const bad of ['nope', JSON.stringify({ kind: 'battle' })]) {
      try {
        await store.save(importScenarioDocument(bad));
        assert.fail('expected the import to fail');
      } catch {
        // Expected: nothing is stored.
      }
    }
    assert.deepEqual(await store.list(), before);
  });
});

describe('reference scenario', () => {
  it('round-trips through import and export with identical values', () => {
    const file = readFileSync(
      path.join(here, '..', 'scenarios', 'acceptance-plain.json'),
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
