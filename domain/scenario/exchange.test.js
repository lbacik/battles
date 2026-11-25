// Unit tests for file exchange and the release gate. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  RULESET_ID,
  RULESET_VERSION,
  ScenarioImportError,
  addGroundCoverFeature,
  cloneScenario,
  createHistory,
  createScenario,
  exportScenario,
  generateId,
  historyCommit,
  historyRedo,
  historyUndo,
  importScenarioDocument,
  isUuid,
  parseScenarioImport,
  proposeUnitPatch,
  scenarioFileName,
  validateScenario,
  valuesOffTenthGrid,
} from '../scenario.js';
import { MemoryScenarioStore } from '../store.js';
import { freshDocument, probeUnit, square } from './test-helpers.js';

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

describe('editor release gate: save, export, and import round-trips', () => {
  it('keeps every value identical to 0.1 m across save, export, and import', async () => {
    const store = new MemoryScenarioStore();
    const authored = createScenario({
      title: 'Acceptance plain',
      description: 'Gate probe: every metre value identical to 0.1 m.',
      battlefield: { width: 1400.04, height: 899.96 },
      units: [
        {
          id: generateId(),
          name: 'Probe taxis',
          side: 'side-a',
          troopType: 'hoplite',
          soldiers: 100,
          files: 10,
          lateralInterval: 1.05,
          rankDepth: 0.94,
          position: { x: 600.04, y: 400.05 },
          facing: 30.05,
        },
      ],
      terrainFeatures: [
        {
          id: 'river',
          kind: 'linear',
          category: 'river',
          path: [
            { x: 0.04, y: 100 },
            { x: 200.05, y: 300 },
          ],
          width: 12.06,
        },
      ],
    });
    // Stored documents round every metre value to 0.1 m.
    assert.deepEqual(valuesOffTenthGrid(authored), []);
    await store.save(authored);
    const saved = await store.load(authored.id);
    const { json } = exportScenario(saved);
    const imported = importScenarioDocument(json);
    // Import assigns a new identifier; every other value survives verbatim.
    assert.notEqual(imported.id, saved.id);
    assert.deepEqual(
      { ...imported, id: saved.id, createdAt: saved.createdAt, updatedAt: saved.updatedAt },
      { ...saved, id: saved.id },
    );
    assert.deepEqual(valuesOffTenthGrid(imported), []);
  });

  it('undoes and redoes terrain, unit, and property edits in one session', () => {
    const original = freshDocument();
    let current = cloneScenario(original);
    let history = createHistory();

    // 1. Property edit: retitle the scenario.
    history = historyCommit(history, cloneScenario(current));
    current = { ...current, title: 'Acceptance plain' };

    // 2. Terrain edit: draw a ground cover area.
    history = historyCommit(history, cloneScenario(current));
    current = addGroundCoverFeature(current, { category: 'forest', polygon: square(100, 100) });

    // 3. Unit edit: place a unit, then move it through a proposal.
    history = historyCommit(history, cloneScenario(current));
    const withUnit = cloneScenario(current);
    withUnit.units.push(probeUnit({ position: { x: 600, y: 400 } }));
    current = withUnit;
    const moved = proposeUnitPatch(current, current.units[0].id, {
      position: { x: 620, y: 400 },
    });
    assert.equal(moved.ok, true);
    history = historyCommit(history, cloneScenario(current));
    current = moved.document;

    // Undo all four commits back to the original document.
    for (let step = 0; step < 4; step += 1) {
      const undone = historyUndo(history, cloneScenario(current));
      assert.ok(undone, `expected undo step ${step + 1}`);
      history = undone.history;
      current = undone.document;
    }
    assert.deepEqual(current, original);
    assert.equal(historyUndo(history, cloneScenario(current)), null);

    // Redo all four commits forward again.
    for (let step = 0; step < 4; step += 1) {
      const redone = historyRedo(history, cloneScenario(current));
      assert.ok(redone, `expected redo step ${step + 1}`);
      history = redone.history;
      current = redone.document;
    }
    assert.equal(current.title, 'Acceptance plain');
    assert.equal(current.terrainFeatures.length, 1);
    assert.deepEqual(current.units[0].position, { x: 620, y: 400 });
    assert.deepEqual(validateScenario(current), []);
  });
});
