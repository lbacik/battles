// Unit tests for terrain-feature editing. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LINEAR_FEATURE_CATEGORIES,
  addElevationFeature,
  addGroundCoverFeature,
  addLinearFeature,
  isUuid,
  removeElevationFeature,
  removeGroundCoverFeature,
  removeLinearFeature,
  updateElevationFeature,
  updateGroundCoverFeature,
  updateLinearFeature,
  validateElevationCandidate,
  validateGroundCoverCandidate,
  validateLinearCandidate,
  validateScenario,
} from '../scenario.js';
import { freshDocument, square } from './test-helpers.js';

describe('ground cover editing', () => {
  it('adds an area with a generated id and rounds vertices to 0.1 m', () => {
    const document = freshDocument();
    const added = addGroundCoverFeature(document, {
      category: 'forest',
      polygon: [
        { x: 100.04, y: 100.06 },
        { x: 200.04, y: 100.06 },
        { x: 150.04, y: 180.06 },
      ],
    });
    assert.equal(added.terrainFeatures.length, 1);
    const [feature] = added.terrainFeatures;
    assert.ok(isUuid(feature.id));
    assert.equal(feature.kind, 'ground');
    assert.equal(feature.category, 'forest');
    assert.deepEqual(feature.polygon, [
      { x: 100, y: 100.1 },
      { x: 200, y: 100.1 },
      { x: 150, y: 180.1 },
    ]);
    assert.deepEqual(validateScenario(added), []);
    // The input document is never mutated.
    assert.deepEqual(document.terrainFeatures, []);
  });

  it('clips a partly-outside polygon to the battlefield and stores the clipped boundary', () => {
    const document = freshDocument();
    const candidate = validateGroundCoverCandidate(document, [
      { x: -50, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 300 },
      { x: -50, y: 300 },
    ]);
    assert.equal(candidate.ok, true);
    assert.ok(candidate.ring.every((point) => point.x >= 0 && point.y >= 0));
    assert.ok(candidate.ring.some((point) => point.x === 0));
    const added = addGroundCoverFeature(document, {
      category: 'rough',
      polygon: [
        { x: -50, y: 100 },
        { x: 200, y: 100 },
        { x: 200, y: 300 },
        { x: -50, y: 300 },
      ],
    });
    assert.deepEqual(added.terrainFeatures[0].polygon, candidate.ring);
    assert.deepEqual(validateScenario(added), []);
  });

  it('refuses a polygon left empty by clipping', () => {
    const document = freshDocument();
    const candidate = validateGroundCoverCandidate(document, square(5000, 5000, 50));
    assert.equal(candidate.ok, false);
    assert.match(candidate.reason, /outside the battlefield/);
    assert.throws(
      () =>
        addGroundCoverFeature(document, { category: 'forest', polygon: square(5000, 5000, 50) }),
      /outside the battlefield/,
    );
  });

  it('refuses a self-intersecting polygon with a highlight ring', () => {
    const document = freshDocument();
    const bowtie = [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
      { x: 200, y: 100 },
      { x: 100, y: 200 },
    ];
    const candidate = validateGroundCoverCandidate(document, bowtie);
    assert.equal(candidate.ok, false);
    assert.match(candidate.reason, /self-intersection/);
    assert.ok(Array.isArray(candidate.ring) && candidate.ring.length >= 3);
    assert.throws(
      () => addGroundCoverFeature(document, { category: 'forest', polygon: bowtie }),
      /self-intersection/,
    );
  });

  it('refuses an area overlapping an existing one and names the conflict', () => {
    const withForest = addGroundCoverFeature(freshDocument(), {
      category: 'forest',
      polygon: square(100, 100),
    });
    const candidate = validateGroundCoverCandidate(withForest, square(150, 150, 100));
    assert.equal(candidate.ok, false);
    assert.match(candidate.reason, /overlap/);
    assert.equal(candidate.conflictId, withForest.terrainFeatures[0].id);
    assert.ok(Array.isArray(candidate.ring) && candidate.ring.length >= 3);
    assert.throws(
      () =>
        addGroundCoverFeature(withForest, { category: 'water', polygon: square(150, 150, 100) }),
      /overlap/,
    );
    // Touching edge to edge stays legal.
    const touching = validateGroundCoverCandidate(withForest, [
      { x: 200, y: 100 },
      { x: 300, y: 100 },
      { x: 300, y: 200 },
      { x: 200, y: 200 },
    ]);
    assert.equal(touching.ok, true);
  });

  it('updates the category and moves a vertex without conflicting with itself', () => {
    const withForest = addGroundCoverFeature(freshDocument(), {
      category: 'forest',
      polygon: square(100, 100),
    });
    const id = withForest.terrainFeatures[0].id;
    const recategorised = updateGroundCoverFeature(withForest, id, { category: 'water' });
    assert.equal(recategorised.terrainFeatures[0].category, 'water');
    assert.deepEqual(validateScenario(recategorised), []);
    const moved = updateGroundCoverFeature(withForest, id, {
      polygon: [
        { x: 100, y: 100 },
        { x: 210, y: 100 },
        { x: 200, y: 200 },
        { x: 100, y: 200 },
      ],
    });
    assert.deepEqual(validateScenario(moved), []);
    assert.throws(
      () => updateGroundCoverFeature(withForest, id, { category: 'lava' }),
      /category must be one of/,
    );
  });

  it('refuses an edit that would overlap a sibling area', () => {
    let document = addGroundCoverFeature(freshDocument(), {
      category: 'forest',
      polygon: square(100, 100),
    });
    document = addGroundCoverFeature(document, { category: 'rough', polygon: square(400, 100) });
    const roughId = document.terrainFeatures[1].id;
    const candidate = validateGroundCoverCandidate(document, square(150, 150, 100), {
      ignoreId: document.terrainFeatures[0].id,
    });
    assert.equal(candidate.ok, true);
    assert.throws(
      () => updateGroundCoverFeature(document, roughId, { polygon: square(150, 150, 100) }),
      /overlap/,
    );
    assert.throws(() => updateGroundCoverFeature(document, 'missing-id', {}), /no ground cover area/);
  });

  it('refuses a polygon with fewer than three distinct vertices', () => {
    const document = freshDocument();
    assert.throws(
      () =>
        addGroundCoverFeature(document, {
          category: 'forest',
          polygon: [
            { x: 100, y: 100 },
            { x: 200, y: 100 },
          ],
        }),
      /at least 3/,
    );
    assert.throws(
      () =>
        addGroundCoverFeature(document, {
          category: 'forest',
          polygon: [
            { x: 100, y: 100 },
            { x: 100, y: 100 },
            { x: 100, y: 100 },
          ],
        }),
      /at least 3/,
    );
  });

  it('removes a whole area', () => {
    let document = addGroundCoverFeature(freshDocument(), {
      category: 'settlement',
      polygon: square(100, 100),
    });
    const id = document.terrainFeatures[0].id;
    document = removeGroundCoverFeature(document, id);
    assert.deepEqual(document.terrainFeatures, []);
    assert.deepEqual(validateScenario(document), []);
    assert.throws(() => removeGroundCoverFeature(document, id), /no ground cover area/);
  });
});

describe('elevation editing', () => {
  it('derives level 1 outside every other and level 2 wholly inside level 1', () => {
    let document = addElevationFeature(freshDocument(), { polygon: square(100, 400, 200) });
    assert.equal(document.terrainFeatures.length, 1);
    assert.equal(document.terrainFeatures[0].kind, 'elevation');
    assert.equal(document.terrainFeatures[0].level, 1);
    assert.ok(isUuid(document.terrainFeatures[0].id));
    assert.deepEqual(validateScenario(document), []);

    document = addElevationFeature(document, { polygon: square(150, 450, 60) });
    const levels = document.terrainFeatures.map((feature) => feature.level).sort();
    assert.deepEqual(levels, [1, 2]);
    assert.deepEqual(validateScenario(document), []);
    // The input document is never mutated.
    assert.equal(document.terrainFeatures.length, 2);
  });

  it('rounds vertices to 0.1 m and clips a partly-outside hill to the battlefield', () => {
    const document = freshDocument();
    const candidate = validateElevationCandidate(document, [
      { x: -50.04, y: 100.06 },
      { x: 200.04, y: 100.06 },
      { x: 200.04, y: 300.06 },
      { x: -50.04, y: 300.06 },
    ]);
    assert.equal(candidate.ok, true);
    assert.equal(candidate.level, 1);
    assert.ok(candidate.ring.every((point) => point.x >= 0 && point.y >= 0));
    assert.ok(candidate.ring.some((point) => point.x === 0));
    const added = addElevationFeature(document, {
      polygon: [
        { x: -50.04, y: 100.06 },
        { x: 200.04, y: 100.06 },
        { x: 200.04, y: 300.06 },
        { x: -50.04, y: 300.06 },
      ],
    });
    assert.deepEqual(added.terrainFeatures[0].polygon, candidate.ring);
    assert.equal(added.terrainFeatures[0].level, 1);
    assert.deepEqual(validateScenario(added), []);
  });

  it('refuses a self-intersecting hill with a highlight ring', () => {
    const bowtie = [
      { x: 100, y: 100 },
      { x: 200, y: 200 },
      { x: 200, y: 100 },
      { x: 100, y: 200 },
    ];
    const candidate = validateElevationCandidate(freshDocument(), bowtie);
    assert.equal(candidate.ok, false);
    assert.match(candidate.reason, /self-intersection/);
    assert.ok(Array.isArray(candidate.ring) && candidate.ring.length >= 3);
    assert.throws(() => addElevationFeature(freshDocument(), { polygon: bowtie }), /self-intersection/);
  });

  it('refuses a hill crossing a sibling with a highlight and a conflict', () => {
    let document = addElevationFeature(freshDocument(), { polygon: square(100, 100, 200) });
    const candidate = validateElevationCandidate(document, square(200, 200, 200));
    assert.equal(candidate.ok, false);
    assert.match(candidate.reason, /cross/);
    assert.equal(candidate.conflictId, document.terrainFeatures[0].id);
    assert.ok(Array.isArray(candidate.ring) && candidate.ring.length >= 3);
    assert.throws(
      () => addElevationFeature(document, { polygon: square(200, 200, 200) }),
      /cross/,
    );
  });

  it('refuses a hill straddling a parent boundary (only partly inside)', () => {
    let document = addElevationFeature(freshDocument(), { polygon: square(100, 100, 300) });
    const candidate = validateElevationCandidate(document, square(250, 250, 200));
    assert.equal(candidate.ok, false);
    assert.match(candidate.reason, /wholly inside|cross/);
    assert.ok(Array.isArray(candidate.ring) && candidate.ring.length >= 3);
    assert.throws(
      () => addElevationFeature(document, { polygon: square(250, 250, 200) }),
      /wholly inside|cross/,
    );
  });

  it('refuses a vertex edit that would break nesting', () => {
    let document = addElevationFeature(freshDocument(), { polygon: square(100, 100, 300) });
    document = addElevationFeature(document, { polygon: square(150, 150, 60) });
    const peakId = document.terrainFeatures.find((feature) => feature.level === 2).id;
    const candidate = validateElevationCandidate(document, square(250, 250, 200), {
      ignoreId: peakId,
    });
    assert.equal(candidate.ok, false);
    assert.throws(
      () => updateElevationFeature(document, peakId, { polygon: square(250, 250, 200) }),
      /wholly inside|cross/,
    );
    assert.throws(() => updateElevationFeature(document, 'missing-id', {}), /no hill/);
  });

  it('moves a vertex within its parent without conflicting with itself', () => {
    let document = addElevationFeature(freshDocument(), { polygon: square(100, 100, 300) });
    document = addElevationFeature(document, { polygon: square(150, 150, 60) });
    const peakId = document.terrainFeatures.find((feature) => feature.level === 2).id;
    const moved = updateElevationFeature(document, peakId, {
      polygon: [
        { x: 150, y: 150 },
        { x: 220, y: 150 },
        { x: 210, y: 210 },
        { x: 150, y: 210 },
      ],
    });
    assert.deepEqual(validateScenario(moved), []);
    assert.equal(moved.terrainFeatures.find((feature) => feature.id === peakId).level, 2);
  });

  it('promotes nested children when a parent level is deleted', () => {
    let document = addElevationFeature(freshDocument(), { polygon: square(100, 100, 300) });
    document = addElevationFeature(document, { polygon: square(150, 150, 60) });
    const parentId = document.terrainFeatures.find((feature) => feature.level === 1).id;
    const childId = document.terrainFeatures.find((feature) => feature.level === 2).id;
    document = removeElevationFeature(document, parentId);
    assert.equal(document.terrainFeatures.length, 1);
    assert.equal(document.terrainFeatures[0].id, childId);
    assert.equal(document.terrainFeatures[0].level, 1);
    assert.deepEqual(validateScenario(document), []);
    assert.throws(() => removeElevationFeature(document, parentId), /no hill/);
  });

  it('bumps existing hills down when an outer ring is drawn around them', () => {
    let document = addElevationFeature(freshDocument(), { polygon: square(150, 150, 60) });
    document = addElevationFeature(document, { polygon: square(100, 100, 300) });
    assert.deepEqual(
      document.terrainFeatures.map((feature) => feature.level).sort(),
      [1, 2],
    );
    assert.deepEqual(validateScenario(document), []);
  });

  it('treats elevation as independent of ground cover', () => {
    let document = addGroundCoverFeature(freshDocument(), {
      category: 'forest',
      polygon: square(100, 100),
    });
    document = addElevationFeature(document, { polygon: square(100, 100) });
    assert.equal(document.terrainFeatures.filter((feature) => feature.kind === 'elevation')[0].level, 1);
    assert.deepEqual(validateScenario(document), []);
  });
});

describe('linear features (rivers and roads)', () => {
  const riverPath = (dx = 0) => [
    { x: 0 + dx, y: 690 },
    { x: 165 + dx, y: 630 },
    { x: 245 + dx, y: 670 },
    { x: 410 + dx, y: 780 },
  ];

  it('knows the river and road categories', () => {
    assert.deepEqual([...LINEAR_FEATURE_CATEGORIES], ['river', 'road']);
  });

  it('adds a river with a generated id and rounds vertices and width', () => {
    const document = freshDocument();
    const added = addLinearFeature(document, {
      category: 'river',
      path: [
        { x: 100.04, y: 100.06 },
        { x: 200.04, y: 100.06 },
      ],
      width: 12.06,
    });
    assert.equal(added.terrainFeatures.length, 1);
    const [feature] = added.terrainFeatures;
    assert.ok(isUuid(feature.id));
    assert.equal(feature.kind, 'linear');
    assert.equal(feature.category, 'river');
    assert.deepEqual(feature.path, [
      { x: 100, y: 100.1 },
      { x: 200, y: 100.1 },
    ]);
    assert.equal(feature.width, 12.1);
    assert.deepEqual(validateScenario(added), []);
    assert.deepEqual(document.terrainFeatures, []);
  });

  it('clamps a partly-outside path to the battlefield', () => {
    const candidate = validateLinearCandidate(freshDocument(), [
      { x: -50, y: 100 },
      { x: 200, y: 100 },
      { x: 2000, y: 300 },
    ]);
    assert.equal(candidate.ok, true);
    assert.ok(candidate.path.every((point) => point.x >= 0 && point.y >= 0));
    assert.ok(candidate.path.some((point) => point.x === 0));
    const added = addLinearFeature(freshDocument(), {
      category: 'road',
      path: [
        { x: -50, y: 100 },
        { x: 200, y: 100 },
        { x: 2000, y: 300 },
      ],
      width: 6,
    });
    assert.deepEqual(added.terrainFeatures[0].path, candidate.path);
    assert.deepEqual(validateScenario(added), []);
  });

  it('lets polylines cross ground cover, elevation, and each other', () => {
    let document = addGroundCoverFeature(freshDocument(), {
      category: 'forest',
      polygon: square(100, 100),
    });
    document.terrainFeatures.push({
      id: 'hill',
      kind: 'elevation',
      level: 1,
      polygon: square(400, 100, 200),
    });
    document = addLinearFeature(document, { category: 'river', path: riverPath(), width: 18 });
    document = addLinearFeature(document, {
      category: 'road',
      path: [
        { x: 150, y: 0 },
        { x: 250, y: 250 },
        { x: 330, y: 500 },
      ],
      width: 6,
    });
    assert.deepEqual(validateScenario(document), []);
  });

  it('refuses a path left empty or degenerate by clipping', () => {
    const outside = validateLinearCandidate(freshDocument(), [
      { x: 5000, y: 5000 },
      { x: 5100, y: 5100 },
    ]);
    assert.equal(outside.ok, false);
    assert.match(outside.reason, /outside the battlefield/);
    assert.throws(
      () => addLinearFeature(freshDocument(), { category: 'river', path: [], width: 10 }),
      /at least 2/,
    );
    assert.throws(
      () =>
        addLinearFeature(freshDocument(), {
          category: 'river',
          path: [
            { x: 100, y: 100 },
            { x: 100, y: 100 },
          ],
          width: 10,
        }),
      /distinct/,
    );
  });

  it('refuses unknown categories and non-positive widths', () => {
    assert.throws(
      () => addLinearFeature(freshDocument(), { category: 'canal', path: riverPath(), width: 10 }),
      /category must be one of/,
    );
    for (const width of [0, -4, Number.NaN]) {
      assert.throws(
        () => addLinearFeature(freshDocument(), { category: 'river', path: riverPath(), width }),
        /positive/,
      );
    }
  });

  it('updates the category, path, and width of a road', () => {
    let document = addLinearFeature(freshDocument(), {
      category: 'road',
      path: riverPath(),
      width: 6,
    });
    const id = document.terrainFeatures[0].id;
    document = updateLinearFeature(document, id, { category: 'river', width: 12 });
    assert.equal(document.terrainFeatures[0].category, 'river');
    assert.equal(document.terrainFeatures[0].width, 12);
    document = updateLinearFeature(document, id, { path: riverPath(10) });
    assert.deepEqual(document.terrainFeatures[0].path[0], { x: 10, y: 690 });
    document = updateLinearFeature(document, id, { width: 12.06 });
    assert.equal(document.terrainFeatures[0].width, 12.1);
    assert.deepEqual(validateScenario(document), []);
    assert.throws(() => updateLinearFeature(document, id, { width: 0 }), /positive/);
    assert.throws(() => updateLinearFeature(document, id, { category: 'lava' }), /category/);
    assert.throws(() => updateLinearFeature(document, 'missing-id', {}), /no river or road/);
  });

  it('removes a whole river or road', () => {
    let document = addLinearFeature(freshDocument(), {
      category: 'river',
      path: riverPath(),
      width: 18,
    });
    const id = document.terrainFeatures[0].id;
    document = removeLinearFeature(document, id);
    assert.deepEqual(document.terrainFeatures, []);
    assert.deepEqual(validateScenario(document), []);
    assert.throws(() => removeLinearFeature(document, id), /no river or road/);
  });
});
