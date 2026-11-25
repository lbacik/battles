// Unit tests for the tethered unit context card geometry (issue #123).
// Run with: node --test domain/unit-card-geometry.test.js
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  UNIT_CARD_ESTIMATED_H,
  UNIT_CARD_GAP,
  UNIT_CARD_MARGIN,
  anchorUnitCard,
  layoutUnitCard,
  layoutUnitContextCard,
  projectUnitBounds,
} from './unit-card-geometry.js';

const battlefield = { width: 1200, height: 800 };

const unitAt = (overrides = {}) => ({
  id: 'u1',
  soldiers: 100,
  files: 10,
  lateralInterval: 1,
  rankDepth: 1,
  position: { x: 600, y: 400 },
  facing: 0,
  ...overrides,
});

const fitView = { zoom: 1, center: { x: 600, y: 400 } };

describe('projectUnitBounds', () => {
  it('projects the rotated true-scale footprint to pixel bounds', () => {
    const bounds = projectUnitBounds(unitAt(), fitView, battlefield, 800, 600);
    assert.ok(bounds);
    assert.equal(bounds.viewportW, 800);
    assert.equal(bounds.viewportH, 600);
    // 10 m frontage over a ~1330 m viewBox mapped into 800 px.
    const widthPx = bounds.maxX - bounds.minX;
    const heightPx = bounds.maxY - bounds.minY;
    assert.ok(widthPx > 0 && heightPx > 0);
    assert.ok(Math.abs(widthPx - heightPx) < 1.5, `square footprint stays square: ${widthPx}x${heightPx}`);
    // Centre sits midway between front and rear; front is north of centre.
    assert.ok(bounds.centerX > bounds.minX && bounds.centerX < bounds.maxX);
    assert.ok(bounds.centerY > bounds.minY && bounds.centerY < bounds.maxY);
    assert.ok(bounds.frontY < bounds.centerY, 'front (north) is above the centre on screen');
    assert.ok(bounds.radiusPx >= Math.hypot(widthPx, heightPx) / 2 - 1e-6);
  });

  it('scales with zoom and shifts with pan', () => {
    const base = projectUnitBounds(unitAt(), fitView, battlefield, 800, 600);
    const zoomed = projectUnitBounds(
      unitAt(),
      { zoom: 2, center: { x: 600, y: 400 } },
      battlefield,
      800,
      600,
    );
    const baseW = base.maxX - base.minX;
    const zoomW = zoomed.maxX - zoomed.minX;
    assert.ok(Math.abs(zoomW - baseW * 2) < 0.5, `zoom 2x doubles width: ${baseW} -> ${zoomW}`);
    // Panning the camera east moves the unit west on screen.
    const panned = projectUnitBounds(
      unitAt(),
      { zoom: 1, center: { x: 700, y: 400 } },
      battlefield,
      800,
      600,
    );
    assert.ok(panned.centerX < base.centerX, 'pan east shifts the unit left');
    assert.ok(Math.abs(panned.centerY - base.centerY) < 0.5, 'vertical centre unchanged');
  });

  it('letterboxes under xMidYMid meet when aspects differ', () => {
    // Very wide viewport: height limits, so the map is centred horizontally.
    const wide = projectUnitBounds(unitAt(), fitView, battlefield, 1600, 300);
    assert.ok(wide.minX > 0, 'side gutters keep the footprint inside');
    assert.ok(wide.maxX < 1600, 'footprint stays inside the wide viewport');
    assert.ok(wide.minY >= 0 && wide.maxY <= 300);
  });
});

describe('layoutUnitCard', () => {
  const bounds = (overrides = {}) => ({
    unitId: 'u1',
    centerX: 200,
    centerY: 300,
    frontX: 200,
    frontY: 290,
    minX: 190,
    maxX: 210,
    minY: 290,
    maxY: 310,
    radiusPx: 15,
    viewportW: 800,
    viewportH: 600,
    ...overrides,
  });

  it('places the card to the right of the unit', () => {
    const layout = layoutUnitCard(bounds(), { cardW: 300, measuredH: 0, estimatedH: 340 });
    assert.equal(layout.placedLeft, false);
    assert.equal(layout.left, 210 + UNIT_CARD_GAP);
    assert.equal(layout.maxCardH, 600 - UNIT_CARD_MARGIN * 2);
    assert.equal(layout.effectiveH, 340);
    assert.ok(layout.top >= UNIT_CARD_MARGIN);
    assert.ok(layout.top + layout.effectiveH <= 600 - UNIT_CARD_MARGIN + 1e-9);
  });

  it('flips to the left near the right edge', () => {
    const nearRight = bounds({ minX: 590, maxX: 610, centerX: 600, frontX: 600 });
    const layout = layoutUnitCard(nearRight, { cardW: 300, measuredH: 0, estimatedH: 340 });
    assert.equal(layout.placedLeft, true);
    assert.equal(layout.left, 590 - UNIT_CARD_GAP - 300);
  });

  it('clamps vertically and horizontally when the measured height approaches the viewport', () => {
    // Tall card near the top clamps to the margin.
    const topUnit = bounds({ centerY: 20, minY: 10, maxY: 30 });
    const topLayout = layoutUnitCard(topUnit, { cardW: 300, measuredH: 500, estimatedH: 340 });
    assert.equal(topLayout.effectiveH, 500);
    assert.equal(topLayout.top, UNIT_CARD_MARGIN);

    // Tall card near the bottom clamps inside the viewport.
    const bottomUnit = bounds({ centerY: 590, minY: 580, maxY: 600 });
    const bottomLayout = layoutUnitCard(bottomUnit, { cardW: 300, measuredH: 500, estimatedH: 340 });
    assert.ok(bottomLayout.top + bottomLayout.effectiveH <= 600 - UNIT_CARD_MARGIN + 1e-9);

    // A measured height taller than the viewport caps at maxCardH.
    const huge = layoutUnitCard(bounds(), { cardW: 300, measuredH: 2000, estimatedH: 340 });
    assert.ok(huge.effectiveH <= huge.maxCardH + 1e-9);
    assert.ok(huge.top >= UNIT_CARD_MARGIN);
    assert.ok(huge.top + huge.effectiveH <= 600 - UNIT_CARD_MARGIN + 1e-9);
  });
});

describe('anchorUnitCard', () => {
  it('anchors on the card perimeter nearest to the unit centre', () => {
    // Centre vertically inside, horizontally left of the card: left edge.
    const left = anchorUnitCard(
      { centerX: 200, centerY: 300 },
      { left: 230, top: 130, cardW: 300, effectiveH: 340 },
    );
    assert.deepEqual(left, { anchorX: 230, anchorY: 300 });

    // Centre inside the card rectangle: the centre itself.
    const inside = anchorUnitCard(
      { centerX: 300, centerY: 200 },
      { left: 230, top: 130, cardW: 300, effectiveH: 340 },
    );
    assert.deepEqual(inside, { anchorX: 300, anchorY: 200 });

    // Centre below the card: bottom edge, x clamped.
    const below = anchorUnitCard(
      { centerX: 900, centerY: 590 },
      { left: 230, top: 130, cardW: 300, effectiveH: 340 },
    );
    assert.deepEqual(below, { anchorX: 530, anchorY: 470 });
  });
});

describe('manualPosition', () => {
  const bounds = (overrides = {}) => ({
    unitId: 'u1',
    centerX: 200,
    centerY: 300,
    frontX: 200,
    frontY: 290,
    minX: 190,
    maxX: 210,
    minY: 290,
    maxY: 310,
    radiusPx: 15,
    viewportW: 800,
    viewportH: 600,
    ...overrides,
  });

  it('honours a manual position inside the viewport', () => {
    const layout = layoutUnitCard(bounds(), {
      cardW: 300,
      measuredH: 0,
      estimatedH: 340,
      manualPos: { x: 100, y: 50 },
    });
    assert.equal(layout.left, 100);
    assert.equal(layout.top, 50);
    assert.equal(layout.effectiveH, 340);
  });

  it('clamps a manual position to the viewport margins', () => {
    const layout = layoutUnitCard(bounds(), {
      cardW: 300,
      measuredH: 0,
      estimatedH: 340,
      manualPos: { x: -500, y: 590 },
    });
    assert.equal(layout.left, UNIT_CARD_MARGIN);
    // 600 - 340 - 12 = 248 is the lowest fully-inside top.
    assert.equal(layout.top, 600 - 340 - UNIT_CARD_MARGIN);
    assert.ok(layout.left + 300 <= 800 - UNIT_CARD_MARGIN + 1e-9);
    assert.ok(layout.top + layout.effectiveH <= 600 - UNIT_CARD_MARGIN + 1e-9);
  });

  it('clamps a manual position past the right and bottom edges', () => {
    const layout = layoutUnitCard(bounds(), {
      cardW: 300,
      measuredH: 0,
      estimatedH: 340,
      manualPos: { x: 900, y: 900 },
    });
    assert.equal(layout.left, 800 - 300 - UNIT_CARD_MARGIN);
    assert.equal(layout.top, 600 - 340 - UNIT_CARD_MARGIN);
  });

  it('anchors the tether on the moved card perimeter', () => {
    const placed = layoutUnitContextCard(bounds(), {
      cardW: 300,
      measuredH: 0,
      estimatedH: 340,
      manualPos: { x: 400, y: 100 },
    });
    assert.equal(placed.left, 400);
    assert.equal(placed.top, 100);
    // Unit centre (200, 300) is left of the moved card and vertically inside it.
    assert.deepEqual({ anchorX: placed.anchorX, anchorY: placed.anchorY }, { anchorX: 400, anchorY: 300 });
  });
});

describe('constants', () => {
  it('matches the prototype-validated placement shape', () => {
    assert.equal(UNIT_CARD_MARGIN, 12);
    assert.equal(UNIT_CARD_GAP, 20);
    assert.equal(UNIT_CARD_ESTIMATED_H, 340);
  });
});
