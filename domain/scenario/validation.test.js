// Unit tests for structural validation and completeness warnings. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  collectWarnings,
  isValidScenario,
  validateScenario,
} from '../scenario.js';
import { freshDocument, probeUnit, square } from './test-helpers.js';

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

describe('completeness warnings', () => {
  it('warns for every side without units', () => {
    const warnings = collectWarnings(freshDocument());
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => /has no units/.test(warning)));
  });

  it('names the side in the warning', () => {
    const warnings = collectWarnings(freshDocument());
    assert.ok(warnings.some((warning) => warning.includes('Athenians')));
    assert.ok(warnings.some((warning) => warning.includes('Spartans')));
  });

  it('stays silent for sides that field units', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ name: 'First', side: 'side-a' }));
    document.units.push(probeUnit({ name: 'Second', side: 'side-b' }));
    assert.deepEqual(collectWarnings(document), []);
  });

  it('warns only for the empty side', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ side: 'side-a' }));
    const warnings = collectWarnings(document);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('Spartans'));
  });

  it('never turns a valid scenario invalid: warnings do not block saving', () => {
    const document = freshDocument();
    assert.deepEqual(validateScenario(document), []);
    assert.ok(collectWarnings(document).length > 0);
    assert.ok(isValidScenario(document));
  });
});
