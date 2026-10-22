// Unit tests for the framework-free scenario model. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_BATTLEFIELD,
  FACING_SNAP_DEG,
  LINEAR_FEATURE_CATEGORIES,
  MAP_VIEW_MAX_ZOOM,
  MAP_VIEW_MIN_ZOOM,
  MAX_BATTLEFIELD_HEIGHT_M,
  MAX_BATTLEFIELD_WIDTH_M,
  RULESET_ID,
  RULESET_VERSION,
  SCENARIO_FORMAT_VERSION,
  SCENARIO_KIND,
  ScenarioImportError,
  UNIT_PICK_TOLERANCE_PX,
  addElevationFeature,
  addGroundCoverFeature,
  addLinearFeature,
  clampMapZoom,
  classifyRulesetReference,
  cloneScenario,
  collectWarnings,
  compareRulesetVersions,
  createHistory,
  createScenario,
  defaultFacingForSide,
  exportScenario,
  findFreeUnitPosition,
  fitMapView,
  fitScale,
  footprintHitTest,
  fromScreenPoint,
  generateId,
  historyCommit,
  historyRedo,
  historyUndo,
  importScenarioDocument,
  isOpenableRulesetReference,
  isProvisionalRuleset,
  isProvisionalRulesetVersion,
  isUuid,
  isValidScenario,
  mapViewBox,
  metresPerPixel,
  niceScaleBarMetres,
  normalizeFacing,
  panMapViewByPixels,
  parseScenarioImport,
  pickUnitIdAtPoint,
  proposeUnitPatch,
  rebindRulesetToCurrent,
  removeElevationFeature,
  removeGroundCoverFeature,
  removeLinearFeature,
  resizeBattlefield,
  roundScenarioToTenth,
  rulesetCompatibilityNotice,
  scenarioFileName,
  snapFacing,
  suggestUnitName,
  toScreenPoint,
  unitFacingDeg,
  unitFootprint,
  unitPosition,
  unitsBlockingResize,
  updateElevationFeature,
  updateGroundCoverFeature,
  updateLinearFeature,
  validateElevationCandidate,
  validateGroundCoverCandidate,
  validateLinearCandidate,
  validateScenario,
  zoomViewAroundCursor,
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

describe('unit footprint (ADR 0001, ADR 0002)', () => {
  it('derives ranks, frontage, and depth from soldiers, files, and spacings', () => {
    const footprint = unitFootprint({
      soldiers: 256,
      files: 16,
      lateralIntervalM: 1,
      rankDepthM: 1,
    });
    assert.deepEqual(footprint, { ranks: 16, frontageM: 16, depthM: 16 });
  });

  it('rounds ranks up when soldiers do not fill the last rank', () => {
    const footprint = unitFootprint({
      soldiers: 100,
      files: 16,
      lateralIntervalM: 1,
      rankDepthM: 2,
    });
    assert.equal(footprint.ranks, 7);
    assert.equal(footprint.frontageM, 16);
    assert.equal(footprint.depthM, 14);
  });

  it('never invents a footprint from incomplete data', () => {
    assert.equal(unitFootprint({ soldiers: 100, files: 16 }), null);
    assert.equal(unitFootprint(null), null);
  });

  it('reads tolerant positions and compass facings', () => {
    assert.deepEqual(unitPosition({ position: { x: 10, y: 20 } }), { x: 10, y: 20 });
    assert.deepEqual(unitPosition({ x: 5, y: 6 }), { x: 5, y: 6 });
    assert.equal(unitPosition({ x: 'a', y: 1 }), null);
    assert.equal(unitFacingDeg({ facingDeg: 30 }), 30);
    assert.equal(unitFacingDeg({ angle: 270 }), -90);
    assert.equal(unitFacingDeg({}), 0);
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

describe('order of battle helpers', () => {
  it('badges provisional 0.x ruleset versions only', () => {
    assert.equal(isProvisionalRulesetVersion('0.1'), true);
    assert.equal(isProvisionalRulesetVersion('0.10'), true);
    assert.equal(isProvisionalRulesetVersion('1.0'), false);
    assert.equal(isProvisionalRulesetVersion(' 0.1 '), true);
    assert.equal(isProvisionalRulesetVersion(''), false);
    assert.equal(isProvisionalRulesetVersion(null), false);
    assert.equal(isProvisionalRuleset({ id: 'polis-classical', version: '0.1' }), true);
    assert.equal(isProvisionalRuleset({ id: 'polis-classical', version: '1.0' }), false);
  });

  it('suggests a unique unit name', () => {
    const document = freshDocument();
    assert.equal(suggestUnitName(document), 'New Unit');
    document.units.push(probeUnit({ name: 'New Unit' }));
    assert.equal(suggestUnitName(document), 'New Unit 2');
    document.units.push(probeUnit({ name: 'new unit 2' }));
    assert.equal(suggestUnitName(document), 'New Unit 3');
  });

  it('faces the first side south and the second side north', () => {
    const document = freshDocument();
    assert.equal(defaultFacingForSide(document, 'side-a'), 180);
    assert.equal(defaultFacingForSide(document, 'side-b'), 0);
    assert.equal(defaultFacingForSide(document, 'unknown'), 0);
  });

  it('finds the first free spot from the north-west of the search rect', () => {
    const document = freshDocument();
    const position = findFreeUnitPosition(document, { frontage: 10, depth: 10, facing: 0 });
    assert.ok(position);
    assert.deepEqual(validateScenario({
      ...document,
      units: [probeUnit({ position, facing: 0 })],
    }), []);
  });

  it('avoids overlapping footprints and returns null when the view is full', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ name: 'First', position: { x: 600, y: 400 } }));
    const overlapping = findFreeUnitPosition(
      document,
      { frontage: 10, depth: 10, facing: 0 },
      { minX: 595, maxX: 605, minY: 395, maxY: 405 },
    );
    assert.equal(overlapping, null);
    const clear = findFreeUnitPosition(
      document,
      { frontage: 10, depth: 10, facing: 0 },
      { minX: 100, maxX: 200, minY: 100, maxY: 200 },
    );
    assert.ok(clear);
    assert.ok(clear.x >= 100 && clear.x <= 200);
    assert.ok(clear.y >= 100 && clear.y <= 200);
  });
});

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

describe('unit placement and rotation on the map', () => {
  // Probe footprint: 100 soldiers in 10 files at 1 m spacings is 10 ranks,
  // a 10 m frontage, and a 10 m depth. Facing north (0), the front midpoint
  // (600, 400) spans x 595-605 and extends south to y 390.
  const placed = (overrides = {}) =>
    probeUnit({ position: { x: 600, y: 400 }, facing: 0, ...overrides });

  it('normalizes facings into [0, 360) and snaps the handle to 15 degrees', () => {
    assert.equal(normalizeFacing(720), 0);
    assert.equal(normalizeFacing(-45), 315);
    assert.equal(normalizeFacing(360), 0);
    assert.equal(normalizeFacing(30), 30);
    assert.equal(FACING_SNAP_DEG, 15);
    assert.equal(snapFacing(33), 30);
    assert.equal(snapFacing(38), 45);
    assert.equal(snapFacing(7.5), 15);
    assert.equal(UNIT_PICK_TOLERANCE_PX, 8);
  });

  it('hit-tests the real footprint with a metre tolerance', () => {
    const unit = placed();
    assert.equal(footprintHitTest(unit, { x: 600, y: 395 }), true);
    assert.equal(footprintHitTest(unit, { x: 600, y: 400 }), true);
    assert.equal(footprintHitTest(unit, { x: 600, y: 401 }), false);
    assert.equal(footprintHitTest(unit, { x: 600, y: 401 }, 2), true);
    assert.equal(footprintHitTest(unit, { x: 100, y: 100 }), false);
    assert.equal(footprintHitTest(unit, { x: 100, y: 100 }, 5), false);
    assert.equal(footprintHitTest(unit, null), false);
  });

  it('picks the topmost unit at a point and nothing on empty ground', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'Lower' }));
    document.units.push(placed({ name: 'Upper' }));
    const [, upper] = document.units;
    assert.equal(pickUnitIdAtPoint(document, { x: 600, y: 395 }, 0), upper.id);
    assert.equal(pickUnitIdAtPoint(document, { x: 100, y: 100 }, 0), null);
    assert.equal(pickUnitIdAtPoint(document, { x: 600, y: 402 }, 5), upper.id);
  });

  it('moves a unit through the proposal and keeps the input untouched', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'First' }));
    const before = cloneScenario(document);
    const proposal = proposeUnitPatch(document, document.units[0].id, {
      position: { x: 610.04, y: 400 },
    });
    assert.equal(proposal.ok, true);
    assert.deepEqual(proposal.document.units[0].position, { x: 610, y: 400 });
    assert.deepEqual(document, before);
  });

  it('refuses an overlapping drop and names both units as the conflict', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'First', position: { x: 600, y: 400 } }));
    document.units.push(placed({ name: 'Second', position: { x: 630, y: 400 } }));
    assert.deepEqual(validateScenario(document), []);
    const [first, second] = document.units;
    const refused = proposeUnitPatch(document, second.id, { position: { x: 600, y: 400 } });
    assert.equal(refused.ok, false);
    assert.equal(refused.document, null);
    assert.ok(refused.conflictIds.includes(first.id));
    assert.ok(refused.conflictIds.includes(second.id));
    assert.match(refused.errors.join(' '), /overlap/);
  });

  it('accepts touching edge to edge and refuses leaving the battlefield', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'First', position: { x: 600, y: 400 } }));
    document.units.push(placed({ name: 'Second', position: { x: 630, y: 400 } }));
    const [, second] = document.units;
    // 10 m frontages: 595-605 beside 605-615 touch at x 605.
    const touching = proposeUnitPatch(document, second.id, { position: { x: 610, y: 400 } });
    assert.equal(touching.ok, true);
    assert.deepEqual(validateScenario(touching.document), []);
    const outside = proposeUnitPatch(document, second.id, { position: { x: 2, y: 400 } });
    assert.equal(outside.ok, false);
    assert.deepEqual(outside.conflictIds, [second.id]);
    assert.match(outside.errors.join(' '), /outside the battlefield/);
    const invalid = proposeUnitPatch(document, second.id, { position: { x: Number.NaN, y: 400 } });
    assert.equal(invalid.ok, false);
    const missing = proposeUnitPatch(document, 'no-such-unit', { position: { x: 600, y: 400 } });
    assert.equal(missing.ok, false);
  });

  it('rotates a unit about its facing and wraps the bearing', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'First' }));
    const [unit] = document.units;
    const rotated = proposeUnitPatch(document, unit.id, { facing: 30 });
    assert.equal(rotated.ok, true);
    assert.equal(rotated.document.units[0].facing, 30);
    const wrapped = proposeUnitPatch(document, unit.id, { facing: 370 });
    assert.equal(wrapped.ok, true);
    assert.equal(wrapped.document.units[0].facing, 10);
    const invalid = proposeUnitPatch(document, unit.id, { facing: Number.NaN });
    assert.equal(invalid.ok, false);
  });

  it('names the units blocking a battlefield shrink', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'Probe taxis', position: { x: 1150, y: 400 } }));
    const blockers = unitsBlockingResize(document, 1000, 800);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].name, 'Probe taxis');
    assert.equal(blockers[0].index, 0);
    assert.deepEqual(unitsBlockingResize(document, 1400, 900), []);
    assert.deepEqual(unitsBlockingResize(document, 0, 800), []);
  });

  it('skips units without an id when picking', () => {
    const document = freshDocument();
    document.units.push(placed({ id: undefined, name: 'Ghost' }));
    document.units.push(placed({ name: 'Lower' }));
    const [, lower] = document.units;
    assert.equal(pickUnitIdAtPoint(document, { x: 600, y: 395 }, 0), lower.id);
    const ghostsOnly = freshDocument();
    ghostsOnly.units.push(placed({ id: undefined, name: 'Ghost' }));
    assert.equal(pickUnitIdAtPoint(ghostsOnly, { x: 600, y: 395 }, 0), null);
  });

  it('round-trips a placement patch through commit, undo, and redo', () => {
    const before = freshDocument();
    before.units.push(placed({ name: 'First' }));
    const proposal = proposeUnitPatch(before, before.units[0].id, { position: { x: 620, y: 400 } });
    assert.equal(proposal.ok, true);
    let history = createHistory();
    history = historyCommit(history, cloneScenario(before));
    let current = proposal.document;
    assert.deepEqual(current.units[0].position, { x: 620, y: 400 });
    const undone = historyUndo(history, cloneScenario(current));
    assert.ok(undone, 'expected an undo step');
    history = undone.history;
    current = undone.document;
    assert.deepEqual(current.units[0].position, { x: 600, y: 400 });
    const redone = historyRedo(history, cloneScenario(current));
    assert.ok(redone, 'expected a redo step');
    current = redone.document;
    assert.deepEqual(current.units[0].position, { x: 620, y: 400 });
    const undoneAgain = historyUndo(redone.history, cloneScenario(current));
    assert.ok(undoneAgain, 'expected undo to be available after redo');
    assert.deepEqual(undoneAgain.document.units[0].position, { x: 600, y: 400 });
    assert.equal(historyUndo(createHistory(), cloneScenario(current)), null);
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
