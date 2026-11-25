// Unit tests for scenario property editing, resizing, and unsaved changes. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BATTLEFIELD_HEIGHT_M,
  MAX_BATTLEFIELD_WIDTH_M,
  cloneScenario,
  createHistory,
  historyCommit,
  historyRedo,
  historyUndo,
  resizeBattlefield,
  scenarioContentEquals,
  updateScenarioDescription,
  updateScenarioTitle,
  updateSideColor,
  updateSideName,
  validateScenario,
} from '../scenario.js';
import { freshDocument, probeUnit, square } from './test-helpers.js';

describe('scenario property editing', () => {
  it('requires a non-blank title and trims it', () => {
    assert.throws(() => updateScenarioTitle(freshDocument(), ''), /title is required/i);
    assert.throws(() => updateScenarioTitle(freshDocument(), '   '), /title is required/i);
    const renamed = updateScenarioTitle(freshDocument(), '  Mantinea  ');
    assert.equal(renamed.title, 'Mantinea');
    assert.deepEqual(validateScenario(renamed), []);
  });

  it('stores the description as optional plain text', () => {
    const noted = updateScenarioDescription(freshDocument(), 'Plain-text notes.');
    assert.equal(noted.description, 'Plain-text notes.');
    assert.deepEqual(validateScenario(noted), []);
    const cleared = updateScenarioDescription(noted, '');
    assert.equal(cleared.description, '');
    assert.deepEqual(validateScenario(cleared), []);
    assert.throws(() => updateScenarioDescription(freshDocument(), 42), /plain text/i);
  });

  it('requires side names and keeps them unique', () => {
    assert.throws(() => updateSideName(freshDocument(), 0, ''), /name is required/i);
    assert.throws(() => updateSideName(freshDocument(), 0, '   '), /name is required/i);
    assert.throws(() => updateSideName(freshDocument(), 0, 'Spartans'), /unique/i);
    assert.throws(() => updateSideName(freshDocument(), 1, 'athenians '), /unique/i);
    assert.throws(() => updateSideName(freshDocument(), 2, 'Corinthians'), /side/i);
    const renamed = updateSideName(freshDocument(), 0, '  Athens  ');
    assert.equal(renamed.sides[0].name, 'Athens');
    assert.equal(renamed.sides[1].name, 'Spartans');
    assert.deepEqual(validateScenario(renamed), []);
  });

  it('keeps side colours distinct regardless of letter case', () => {
    assert.throws(() => updateSideColor(freshDocument(), 0, ''), /colour/i);
    assert.throws(() => updateSideColor(freshDocument(), 0, '#B91C1C'), /distinct colours/i);
    assert.throws(() => updateSideColor(freshDocument(), 1, '#1D4ED8'), /distinct colours/i);
    assert.throws(() => updateSideColor(freshDocument(), 9, '#123456'), /side/i);
    const recoloured = updateSideColor(freshDocument(), 0, '#ABCDEF');
    assert.equal(recoloured.sides[0].color, '#abcdef');
    assert.deepEqual(validateScenario(recoloured), []);
  });

  it('never mutates the input document', () => {
    const before = freshDocument();
    const snapshot = cloneScenario(before);
    updateScenarioTitle(before, 'Mantinea');
    updateScenarioDescription(before, 'Plain-text notes.');
    updateSideName(before, 0, 'Athens');
    updateSideColor(before, 1, '#166534');
    assert.deepEqual(before, snapshot);
  });

  it('walks every property kind through undo and redo', () => {
    const original = freshDocument();
    let current = cloneScenario(original);
    let history = createHistory();
    const commit = (next) => {
      history = historyCommit(history, cloneScenario(current));
      current = next;
    };
    commit(updateScenarioTitle(current, 'Mantinea'));
    commit(updateScenarioDescription(current, 'Plain-text notes.'));
    commit(resizeBattlefield(current, 1400, 900));
    commit(updateSideName(current, 0, 'Athens'));
    commit(updateSideColor(current, 1, '#166534'));

    assert.equal(current.title, 'Mantinea');
    assert.equal(current.description, 'Plain-text notes.');
    assert.deepEqual(current.battlefield, { width: 1400, height: 900 });
    assert.equal(current.sides[0].name, 'Athens');
    assert.equal(current.sides[1].color, '#166534');
    assert.deepEqual(validateScenario(current), []);

    for (let step = 0; step < 5; step += 1) {
      const undone = historyUndo(history, cloneScenario(current));
      assert.ok(undone, `expected undo step ${step + 1}`);
      history = undone.history;
      current = undone.document;
    }
    assert.deepEqual(current, original);
    assert.equal(historyUndo(history, cloneScenario(current)), null);

    for (let step = 0; step < 5; step += 1) {
      const redone = historyRedo(history, cloneScenario(current));
      assert.ok(redone, `expected redo step ${step + 1}`);
      history = redone.history;
      current = redone.document;
    }
    assert.equal(current.title, 'Mantinea');
    assert.equal(current.description, 'Plain-text notes.');
    assert.deepEqual(current.battlefield, { width: 1400, height: 900 });
    assert.equal(current.sides[0].name, 'Athens');
    assert.equal(current.sides[1].color, '#166534');
    assert.equal(historyRedo(history, cloneScenario(current)), null);
  });

  it('drops the redo stack when a new change commits after undo', () => {
    const original = freshDocument();
    let history = historyCommit(createHistory(), cloneScenario(original));
    const renamed = updateScenarioTitle(original, 'Mantinea');
    const undone = historyUndo(history, cloneScenario(renamed));
    assert.ok(undone, 'expected an undo step');
    history = historyCommit(undone.history, cloneScenario(undone.document));
    assert.equal(historyRedo(history, cloneScenario(undone.document)), null);
  });
});

describe('unsaved-changes indicator', () => {
  it('treats a clean reopen as saved', () => {
    const saved = freshDocument();
    assert.equal(scenarioContentEquals(cloneScenario(saved), saved), true);
  });

  it('ignores key order and save-metadata refreshes', () => {
    const saved = freshDocument();
    const reordered = {};
    for (const key of Object.keys(saved).reverse()) {
      reordered[key] = saved[key];
    }
    assert.equal(scenarioContentEquals(reordered, saved), true);
    const refreshed = cloneScenario(saved);
    refreshed.updatedAt = new Date(Date.parse(saved.updatedAt) + 1000).toISOString();
    assert.equal(scenarioContentEquals(refreshed, saved), true);
  });

  it('notices a change to any scenario property', () => {
    const saved = freshDocument();
    assert.equal(scenarioContentEquals(updateScenarioTitle(saved, 'Mantinea'), saved), false);
    assert.equal(scenarioContentEquals(updateScenarioDescription(saved, 'Notes.'), saved), false);
    assert.equal(scenarioContentEquals(resizeBattlefield(saved, 1400, 900), saved), false);
    assert.equal(scenarioContentEquals(updateSideName(saved, 0, 'Athens'), saved), false);
    assert.equal(scenarioContentEquals(updateSideColor(saved, 1, '#166534'), saved), false);
  });

  it('needs both versions to compare', () => {
    const saved = freshDocument();
    assert.equal(scenarioContentEquals(null, saved), false);
    assert.equal(scenarioContentEquals(saved, null), false);
    assert.equal(scenarioContentEquals(null, null), false);
  });
});

describe('resizeBattlefield', () => {
  it('grows the battlefield without touching terrain', () => {
    const document = freshDocument();
    document.terrainFeatures.push({
      id: 'forest',
      kind: 'ground',
      category: 'forest',
      polygon: square(100, 100),
    });
    const resized = resizeBattlefield(document, 1400, 900);
    assert.deepEqual(resized.battlefield, { width: 1400, height: 900 });
    assert.deepEqual(resized.terrainFeatures[0].polygon, square(100, 100));
    assert.deepEqual(validateScenario(resized), []);
  });

  it('clips overlapping terrain when shrinking', () => {
    const document = freshDocument();
    document.terrainFeatures.push({
      id: 'forest',
      kind: 'ground',
      category: 'forest',
      polygon: square(1000, 100, 300),
    });
    const resized = resizeBattlefield(document, 1200, 800);
    assert.equal(resized.terrainFeatures.length, 1);
    assert.ok(
      resized.terrainFeatures[0].polygon.every((point) => point.x <= 1200 && point.y <= 800),
    );
    assert.deepEqual(validateScenario(resized), []);
  });

  it('drops terrain left fully outside the new bounds', () => {
    const document = freshDocument();
    document.terrainFeatures.push(
      { id: 'near', kind: 'ground', category: 'forest', polygon: square(100, 100) },
      { id: 'far', kind: 'ground', category: 'rough', polygon: square(1000, 100) },
    );
    const resized = resizeBattlefield(document, 500, 800);
    assert.deepEqual(
      resized.terrainFeatures.map((feature) => feature.id),
      ['near'],
    );
    assert.deepEqual(validateScenario(resized), []);
  });

  it('clamps linear paths into the new bounds', () => {
    const document = freshDocument();
    document.terrainFeatures.push({
      id: 'river',
      kind: 'linear',
      category: 'river',
      path: [
        { x: 100, y: 100 },
        { x: 1500, y: 700 },
      ],
      width: 12,
    });
    const resized = resizeBattlefield(document, 1200, 800);
    assert.equal(resized.terrainFeatures.length, 1);
    assert.ok(
      resized.terrainFeatures[0].path.every((point) => point.x <= 1200 && point.y <= 800),
    );
    assert.deepEqual(validateScenario(resized), []);
  });

  it('refuses to shrink past a unit and names it', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ position: { x: 1150, y: 400 } }));
    assert.deepEqual(validateScenario(document), []);
    assert.throws(() => resizeBattlefield(document, 1000, 800), /Probe taxis/);
  });

  it('rejects non-positive and over-limit dimensions', () => {
    assert.throws(() => resizeBattlefield(freshDocument(), 0, 800), /positive/);
    assert.throws(() => resizeBattlefield(freshDocument(), 1200, -5), /positive/);
    assert.throws(
      () => resizeBattlefield(freshDocument(), MAX_BATTLEFIELD_WIDTH_M + 1, 800),
      /application limit/,
    );
    assert.throws(
      () => resizeBattlefield(freshDocument(), 1200, MAX_BATTLEFIELD_HEIGHT_M + 1),
      /application limit/,
    );
  });

  it('rounds dimensions to 0.1 m and never mutates its input', () => {
    const document = freshDocument();
    const before = cloneScenario(document);
    const resized = resizeBattlefield(document, 1000.06, 799.94);
    assert.deepEqual(resized.battlefield, { width: 1000.1, height: 799.9 });
    assert.deepEqual(document, before);
  });
});
