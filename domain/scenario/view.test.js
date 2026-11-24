// Unit tests for map view and ruleset references. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAP_VIEW_MAX_ZOOM,
  MAP_VIEW_MIN_ZOOM,
  RULESET_ID,
  RULESET_VERSION,
  ScenarioImportError,
  clampMapZoom,
  classifyRulesetReference,
  cloneScenario,
  compareRulesetVersions,
  createScenario,
  exportScenario,
  fitMapView,
  importScenarioDocument,
  isOpenableRulesetReference,
  mapViewBox,
  metresPerPixel,
  niceScaleBarMetres,
  panMapViewByPixels,
  parseScenarioImport,
  rebindRulesetToCurrent,
  rulesetCompatibilityNotice,
  validateScenario,
  zoomViewAroundCursor,
} from '../scenario.js';
import { probeUnit } from './test-helpers.js';

describe('map navigation view (display only)', () => {
  it('fits the battlefield centre at zoom 1', () => {
    const view = fitMapView({ width: 1200, height: 800 });
    assert.equal(view.zoom, 1);
    assert.deepEqual(view.center, { x: 600, y: 400 });
  });

  it('clamps zoom to the supported range', () => {
    assert.equal(clampMapZoom(1000), MAP_VIEW_MAX_ZOOM);
    assert.equal(clampMapZoom(0.001), MAP_VIEW_MIN_ZOOM);
    assert.equal(clampMapZoom(Number.NaN), 1);
  });

  it('keeps the map point under the cursor fixed while zooming', () => {
    const view = { zoom: 1, center: { x: 600, y: 400 } };
    const cursor = { x: 700, y: 450 };
    const next = zoomViewAroundCursor(view, cursor, 2);
    assert.equal(next.zoom, 2);
    assert.deepEqual(next.center, { x: 650, y: 425 });
    const back = zoomViewAroundCursor(next, cursor, 1);
    assert.ok(Math.abs(back.center.x - 600) < 1e-9);
    assert.ok(Math.abs(back.center.y - 400) < 1e-9);
  });

  it('pans the centre opposite the drag in screen space', () => {
    const view = { zoom: 1, center: { x: 600, y: 400 } };
    // Drag 40 px right and 10 px down at 2 m/px: content follows the pointer.
    assert.deepEqual(panMapViewByPixels(view, 40, 10, 2).center, { x: 520, y: 420 });
  });

  it('renders the fitted viewBox around the battlefield centre', () => {
    const box = mapViewBox(fitMapView({ width: 1200, height: 800 }), {
      width: 1200,
      height: 800,
    });
    assert.equal(box.width, 1330);
    assert.equal(box.height, 920);
    // Centre of the viewBox matches the battlefield centre in screen space.
    assert.ok(Math.abs(box.x + box.width / 2 - 600) < 1e-9);
    assert.ok(Math.abs(box.y + box.height / 2 - 400) < 1e-9);
  });

  it('derives metres per pixel from the viewBox and viewport width', () => {
    const view = fitMapView({ width: 1200, height: 800 });
    assert.equal(metresPerPixel(view, { width: 1200, height: 800 }, 1330), 1);
  });

  it('picks a readable scale bar length', () => {
    assert.equal(niceScaleBarMetres(1, 120), 200);
    assert.equal(niceScaleBarMetres(0.5, 120), 100);
  });
});

describe('ruleset reference compatibility (decision #5 items 10-12)', () => {
  it('compares dotted versions numerically per chunk', () => {
    assert.equal(compareRulesetVersions('0.1', '0.1'), 0);
    assert.equal(compareRulesetVersions('0.1', '0.1.0'), 0);
    assert.equal(compareRulesetVersions('0.0', '0.1'), -1);
    assert.equal(compareRulesetVersions('0.2', '0.1'), 1);
    assert.equal(compareRulesetVersions('0.10', '0.2'), 1);
    assert.equal(compareRulesetVersions('1.0', '0.1'), 1);
    assert.equal(compareRulesetVersions(' 0.1 ', '0.1'), 0);
  });

  it('classifies the current reference as openable', () => {
    const classification = classifyRulesetReference({ id: RULESET_ID, version: RULESET_VERSION });
    assert.equal(classification.status, 'current');
    assert.equal(isOpenableRulesetReference({ id: RULESET_ID, version: RULESET_VERSION }), true);
    assert.equal(rulesetCompatibilityNotice({ id: RULESET_ID, version: RULESET_VERSION }), null);
  });

  it('opens a synthetic older version of the same ruleset with a rebind notice', () => {
    // A synthetic older catalogue version: the installed catalogue is 0.1.
    const older = { id: RULESET_ID, version: '0.0' };
    const classification = classifyRulesetReference(older);
    assert.equal(classification.status, 'older');
    assert.equal(isOpenableRulesetReference(older), true);
    const notice = rulesetCompatibilityNotice(older);
    assert.ok(notice, 'an older reference needs an informational issues-panel entry');
    assert.match(notice, /0\.0/);
    assert.match(notice, /Saving rebinds/);
    // Troop-type keys resolve against the current catalogue either way.
    const document = createScenario({ title: 'Older ruleset' });
    document.ruleset = { ...older };
    document.units.push(probeUnit({ troopType: 'hoplite' }));
    assert.deepEqual(validateScenario(document), []);
  });

  it('refuses a newer version of the same ruleset without opening', () => {
    const newer = { id: RULESET_ID, version: '99.0' };
    const classification = classifyRulesetReference(newer);
    assert.equal(classification.status, 'newer');
    assert.equal(isOpenableRulesetReference(newer), false);
    assert.equal(rulesetCompatibilityNotice(newer), null);
    assert.match(classification.cause, /left untouched/);
  });

  it('refuses an unknown ruleset identifier without opening', () => {
    const classification = classifyRulesetReference({ id: 'other-rules', version: '1.0' });
    assert.equal(classification.status, 'unknown-ruleset');
    assert.equal(isOpenableRulesetReference({ id: 'other-rules', version: '1.0' }), false);
    assert.match(classification.cause, /unknown ruleset/);
    assert.equal(classifyRulesetReference(null).status, 'invalid');
    assert.equal(classifyRulesetReference({ id: RULESET_ID }).status, 'invalid');
  });

  it('rebinds an older reference to the installed version only on explicit save', () => {
    const document = createScenario({ title: 'Rebind probe' });
    document.ruleset = { id: RULESET_ID, version: '0.0' };
    const before = cloneScenario(document);
    const rebound = rebindRulesetToCurrent(document);
    assert.deepEqual(rebound.ruleset, { id: RULESET_ID, version: RULESET_VERSION });
    // The input is never mutated: opening leaves the stored reference alone.
    assert.deepEqual(document.ruleset, { id: RULESET_ID, version: '0.0' });
    assert.deepEqual(document, before);
    assert.deepEqual(rebound.units, document.units);
  });

  it('imports an older ruleset version preserved, and refuses a newer one', () => {
    const document = createScenario({ title: 'Mantinea' });
    const older = JSON.stringify({
      ...JSON.parse(exportScenario(document).json),
      ruleset: { id: RULESET_ID, version: '0.0' },
    });
    const parsed = parseScenarioImport(older);
    assert.deepEqual(parsed.ruleset, { id: RULESET_ID, version: '0.0' });
    const copied = importScenarioDocument(older);
    assert.deepEqual(copied.ruleset, { id: RULESET_ID, version: '0.0' });

    const newer = JSON.stringify({
      ...JSON.parse(exportScenario(document).json),
      ruleset: { id: RULESET_ID, version: '99.0' },
    });
    assert.throws(() => parseScenarioImport(newer), /newer than the installed/);
    try {
      parseScenarioImport(newer);
    } catch (error) {
      assert.ok(error instanceof ScenarioImportError);
      assert.equal(error.code, 'unsupported-ruleset-version');
      return;
    }
    assert.fail('expected a ScenarioImportError');
  });

  it('imports a unit with an unknown troop-type key and preserves it verbatim', () => {
    const document = createScenario({ title: 'Mantinea' });
    document.units.push(probeUnit({ name: 'Strangers', troopType: 'cataphract' }));
    assert.deepEqual(validateScenario(document), []);
    const { json } = exportScenario(document);
    assert.match(json, /cataphract/);
    const copy = importScenarioDocument(json);
    assert.equal(copy.units[0].troopType, 'cataphract');
    assert.deepEqual(validateScenario(copy), []);
  });
});
