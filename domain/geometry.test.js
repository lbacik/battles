// Unit tests for the plane geometry helpers. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  clipPathToRect,
  clipPolygonToRect,
  dedupePoints,
  deriveFootprint,
  isSimplePolygon,
  locatePoint,
  polygonArea,
  polygonInsideOrOn,
  polygonsOverlapPositiveArea,
  pointsWithinBounds,
  round1,
  shrinkFootprint,
} from './geometry.js';

const unit = (overrides = {}) => ({
  soldiers: 256,
  files: 16,
  lateralInterval: 1,
  rankDepth: 1,
  position: { x: 500, y: 600 },
  facing: 180,
  ...overrides,
});

describe('round1', () => {
  it('rounds stored metre values to 0.1 m', () => {
    assert.equal(round1(16.05), 16.1);
    assert.equal(round1(16.04), 16);
    assert.equal(round1(100), 100);
  });
});

describe('deriveFootprint', () => {
  it('derives ranks, frontage, and depth from soldiers, files, and spacings', () => {
    // 256 soldiers in 16 files: 16 ranks; 16 x 1 m frontage, 16 x 1 m depth.
    assert.deepEqual(
      (({ ranks, frontage, depth }) => ({ ranks, frontage, depth }))(
        deriveFootprint(unit()),
      ),
      { ranks: 16, frontage: 16, depth: 16 },
    );
    // A partial last rank still occupies full depth: 100 soldiers in 14
    // files need 8 ranks.
    const partial = deriveFootprint(unit({ soldiers: 100, files: 14 }));
    assert.equal(partial.ranks, 8);
    assert.equal(partial.frontage, 14);
    assert.equal(partial.depth, 8);
  });

  it('anchors the footprint at the front midpoint', () => {
    const { corners } = deriveFootprint(unit());
    const midpoint = {
      x: (corners[0].x + corners[1].x) / 2,
      y: (corners[0].y + corners[1].y) / 2,
    };
    assert.ok(Math.abs(midpoint.x - 500) < 1e-9);
    assert.ok(Math.abs(midpoint.y - 600) < 1e-9);
  });

  it('extends depth backwards from the facing direction', () => {
    // Facing north (0): the front edge is at y = 600, the rear at y = 584.
    const north = deriveFootprint(unit({ facing: 0 }));
    const ys = north.corners.map((corner) => corner.y);
    assert.deepEqual([...ys].sort((a, b) => a - b), [584, 584, 600, 600]);
    // Facing south (180): mirrored.
    const south = deriveFootprint(unit({ facing: 180 }));
    const southYs = south.corners.map((corner) => corner.y);
    assert.deepEqual([...southYs].sort((a, b) => a - b), [600, 600, 616, 616]);
  });

  it('rotates the footprint about the front midpoint', () => {
    const before = deriveFootprint(unit({ facing: 0 }));
    const after = deriveFootprint(unit({ facing: 90 }));
    const mid = (corners) => ({
      x: (corners[0].x + corners[1].x) / 2,
      y: (corners[0].y + corners[1].y) / 2,
    });
    assert.deepEqual(mid(before.corners), mid(after.corners));
    // Facing east (90): frontage runs north-south, depth extends west.
    const xs = after.corners.map((corner) => corner.x);
    assert.deepEqual([...xs].sort((a, b) => a - b), [484, 484, 500, 500]);
  });
});

describe('shrinkFootprint', () => {
  it('removes 0.1 m overall so the overlap tolerance is explicit', () => {
    const shrunk = shrinkFootprint(unit());
    assert.equal(shrunk.frontage, 15.9);
    assert.equal(shrunk.depth, 15.9);
    // The shrunk footprint keeps the same front-midpoint anchor, moved back
    // by half the margin.
    const midpoint = {
      x: (shrunk.corners[0].x + shrunk.corners[1].x) / 2,
      y: (shrunk.corners[0].y + shrunk.corners[1].y) / 2,
    };
    assert.ok(Math.abs(midpoint.x - 500) < 1e-9);
    assert.ok(Math.abs(midpoint.y - 600.05) < 1e-9);
  });

  it('returns null when the unit is too small to shrink', () => {
    assert.equal(
      shrinkFootprint(unit({ soldiers: 1, files: 1, lateralInterval: 0.05, rankDepth: 0.05 })),
      null,
    );
  });
});

describe('polygon predicates', () => {
  const square = (x, y, size = 10) => [
    { x, y },
    { x: x + size, y },
    { x: x + size, y: y + size },
    { x, y: y + size },
  ];

  it('measures polygon area', () => {
    assert.equal(polygonArea(square(0, 0, 10)), 100);
  });

  it('accepts simple polygons and rejects self-intersecting ones', () => {
    assert.equal(isSimplePolygon(square(0, 0, 10)), true);
    const bowtie = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    assert.equal(isSimplePolygon(bowtie), false);
    const spike = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 0 },
      { x: 5, y: 10 },
    ];
    assert.equal(isSimplePolygon(spike), false);
    assert.equal(isSimplePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }]), false);
  });

  it('locates points inside, outside, and on the boundary', () => {
    const ring = square(0, 0, 10);
    assert.equal(locatePoint(ring, { x: 5, y: 5 }), 'inside');
    assert.equal(locatePoint(ring, { x: 20, y: 5 }), 'outside');
    assert.equal(locatePoint(ring, { x: 0, y: 5 }), 'boundary');
    assert.equal(locatePoint(ring, { x: 5, y: 0 }), 'boundary');
  });

  it('detects positive-area overlap and accepts touching', () => {
    assert.equal(polygonsOverlapPositiveArea(square(0, 0, 10), square(5, 5, 10)), true);
    assert.equal(polygonsOverlapPositiveArea(square(0, 0, 10), square(10, 0, 10)), false);
    assert.equal(polygonsOverlapPositiveArea(square(0, 0, 10), square(20, 20, 10)), false);
    assert.equal(polygonsOverlapPositiveArea(square(0, 0, 10), square(0, 0, 10)), true);
    assert.equal(polygonsOverlapPositiveArea(square(0, 0, 10), square(2, 2, 4)), true);
  });

  it('treats containment with every vertex on the boundary as overlap', () => {
    const outer = square(0, 0, 10);
    const same = square(0, 0, 10);
    assert.equal(polygonsOverlapPositiveArea(outer, same), true);
  });

  it('checks containment for elevation nesting', () => {
    const outer = square(0, 0, 100);
    assert.equal(polygonInsideOrOn(square(10, 10, 20), outer), true);
    assert.equal(polygonInsideOrOn(square(90, 90, 20), outer), false);
    assert.equal(polygonInsideOrOn(square(0, 0, 100), outer), true);
  });

  it('checks bounds with the map convention', () => {
    assert.equal(pointsWithinBounds([{ x: 0, y: 0 }, { x: 100, y: 50 }], 100, 50), true);
    assert.equal(pointsWithinBounds([{ x: -0.5, y: 0 }], 100, 50), false);
    assert.equal(pointsWithinBounds([{ x: 100.5, y: 0 }], 100, 50), false);
  });
});

describe('dedupePoints', () => {
  it('removes consecutive duplicates and a repeated closing point', () => {
    assert.deepEqual(
      dedupePoints([
        { x: 0, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 0 },
      ]),
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
    );
  });
});

describe('clipPolygonToRect', () => {
  const rect = (x, y, w, h) => [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];

  it('keeps a fully inside polygon unchanged', () => {
    const ring = rect(100, 100, 50, 40);
    assert.deepEqual(clipPolygonToRect(ring, 1200, 800), ring);
  });

  it('clips a partially overlapping polygon to the bounds', () => {
    const clipped = clipPolygonToRect(rect(-50, 100, 200, 100), 1200, 800);
    assert.deepEqual(clipped, rect(0, 100, 150, 100));
    assert.ok(
      clipped.every((point) => point.x >= 0 && point.x <= 1200 && point.y >= 0 && point.y <= 800),
    );
  });

  it('returns an empty ring for a fully outside polygon', () => {
    assert.deepEqual(clipPolygonToRect(rect(5000, 5000, 50, 50), 1200, 800), []);
  });

  it('keeps the clipped polygon simple with a positive area', () => {
    const clipped = clipPolygonToRect(rect(1100, 700, 200, 200), 1200, 800);
    assert.ok(clipped.length >= 3);
    assert.ok(polygonArea(clipped) > 0);
    assert.equal(isSimplePolygon(clipped), true);
  });
});

describe('clipPathToRect', () => {
  it('clamps path points into the bounds', () => {
    assert.deepEqual(
      clipPathToRect(
        [
          { x: -10, y: 100 },
          { x: 600, y: 900 },
          { x: 1300, y: 400 },
        ],
        1200,
        800,
      ),
      [
        { x: 0, y: 100 },
        { x: 600, y: 800 },
        { x: 1200, y: 400 },
      ],
    );
  });

  it('collapses points that clamp onto each other', () => {
    assert.deepEqual(
      clipPathToRect(
        [
          { x: -5, y: -5 },
          { x: -1, y: -1 },
          { x: 100, y: 100 },
        ],
        1200,
        800,
      ),
      [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    );
  });
});
