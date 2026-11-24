// PÓLIS scenario model — 0.1 m rounding and grid checks (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

import {
  round1,
} from '../geometry.js';

import { cloneScenario } from './document.js';

function roundPoint(point) {
  return { x: round1(point.x), y: round1(point.y) };
}

// Round every stored metre value to 0.1 m. Returns a new document; the
// input is never mutated.
export function roundScenarioToTenth(document) {
  const copy = cloneScenario(document);
  if (copy.battlefield) {
    copy.battlefield.width = round1(copy.battlefield.width);
    copy.battlefield.height = round1(copy.battlefield.height);
  }
  for (const unit of copy.units || []) {
    unit.lateralInterval = round1(unit.lateralInterval);
    unit.rankDepth = round1(unit.rankDepth);
    if (unit.position) {
      unit.position = roundPoint(unit.position);
    }
    if (Number.isFinite(unit.facing)) {
      // A facing is a compass bearing in degrees: wrap it into [0, 360)
      // so every stored value is one. Rounding can still produce 360.0,
      // which is the same bearing as 0.
      const wrapped = ((unit.facing % 360) + 360) % 360;
      unit.facing = round1(wrapped);
      if (unit.facing >= 360) {
        unit.facing = 0;
      }
    }
  }
  for (const feature of copy.terrainFeatures || []) {
    if (Array.isArray(feature.polygon)) {
      feature.polygon = feature.polygon.map(roundPoint);
    }
    if (Array.isArray(feature.path)) {
      feature.path = feature.path.map(roundPoint);
    }
    if (Number.isFinite(feature.width)) {
      feature.width = round1(feature.width);
    }
  }
  return copy;
}

// Every stored metre value stays on the 0.1 m grid: battlefield dimensions,
// spacings, facings, positions, polygon vertices, and linear widths are all
// whole multiples of 0.1 m. Returns the values that drift off that grid, so
// the browser end-to-end test and the unit tests share one gate (release
// gate, issue #20): an empty array means the document is identical to 0.1 m.
export function valuesOffTenthGrid(document) {
  const values = [document?.battlefield?.width, document?.battlefield?.height];
  for (const unit of document?.units || []) {
    values.push(
      unit.lateralInterval,
      unit.rankDepth,
      unit.facing,
      unit.position?.x,
      unit.position?.y,
    );
  }
  for (const feature of document?.terrainFeatures || []) {
    if (Array.isArray(feature.polygon)) {
      for (const point of feature.polygon) values.push(point.x, point.y);
    }
    if (Array.isArray(feature.path)) {
      for (const point of feature.path) values.push(point.x, point.y);
    }
    if (Number.isFinite(feature.width)) values.push(feature.width);
  }
  return values.filter(
    (value) => !Number.isFinite(value) || Math.abs(value * 10 - Math.round(value * 10)) > 1e-9,
  );
}

// Create a new scenario document. The identifier is generated and immutable:
// it is assigned here and never changed afterwards. The title is required.
