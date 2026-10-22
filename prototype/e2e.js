// PÓLIS tracer bullet — browser end-to-end test.
//
// Runs the ten-step editor acceptance scenario (#4) plus persistence steps
// 1–6 and 8 (#5) against the real IndexedDB scenario store (its own test
// database, so the author's library is untouched):
// One "Acceptance plain" scenario runs through every phase, in acceptance
// order, so the saved, reopened, duplicated, exported, and imported document
// is the one built in steps 1–8:
//   phase "setup":     acceptance steps 1–3 (titled scenario at 1400 × 900 m
//                       with a description; forest, rough ground, and a
//                       settlement with a refused overlap; a two-level hill and
//                       a river crossed by a road);
//   phase "units":     editor acceptance steps 4–8 on that same scenario
//                       (renamed sides with warnings, six units, a spacing
//                       preset, a rotation to 30°, a refused overlapping drop,
//                       accepted edge-to-edge touching, a refused battlefield
//                       shrink, and multi-kind undo/redo);
//   phase "save":      acceptance step 9: save, list, snapshot, and reload;
//   phase "reopen":    with a fresh store instance, list the library, reopen
//                       the scenario by id with every value identical to 0.1 m
//                       and an empty undo history, duplicate and delete the
//                       duplicate (step 10), then persistence steps 1–6 and 8
//                       (save/quit/reopen, export/import copies, two-tab
//                       conflict, five rejected imports, the unknown troop-type
//                       key, and a simulated quota failure).
// Progress survives the reload in sessionStorage. Results are rendered into
// the page and logged to the console for headless collection.
import { deriveFootprint } from './domain/geometry.js';
import {
  RULESET_ID,
  SCENARIO_FORMAT_VERSION,
  addElevationFeature,
  addGroundCoverFeature,
  addLinearFeature,
  collectWarnings,
  cloneScenario,
  createHistory,
  createScenario,
  exportScenario,
  historyCommit,
  historyRedo,
  historyUndo,
  importScenarioDocument,
  normalizeFacing,
  parseScenarioImport,
  pickUnitIdAtPoint,
  proposeUnitPatch,
  resizeBattlefield,
  roundScenarioToTenth,
  snapFacing,
  unitsBlockingResize,
  validateElevationCandidate,
  valuesOffTenthGrid,
  updateLinearFeature,
  validateGroundCoverCandidate,
  validateLinearCandidate,
  validateScenario,
} from './domain/scenario.js';
import {
  SaveConflictError,
  detectSaveConflict,
  duplicateScenario,
  isQuotaError,
  performSave,
} from './domain/library.js';
import { collectUnknownTroopTypeWarnings } from './domain/polis-classical.js';
import { BattleStartError, startBattle, validatePlayability } from './domain/battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  availableActions,
  buildPlayerView,
  resolveTurn,
  validateTurn,
} from './domain/turn.js';
import { createPassivePlayer, runTurn } from './domain/players.js';
import { IndexedDBScenarioStore } from './library/idb.js';
import { IndexedDBBattleStore } from './library/battles-idb.js';

const DB_NAME = 'polis-scenarios-e2e';
const BATTLE_DB_NAME = 'polis-battles-e2e';
const PHASE_KEY = 'polis-tracer-e2e';
const AUTOSTART_PARAM = 'autostart';

const steps = document.querySelector('#steps');
const verdict = document.querySelector('#verdict');
const details = document.querySelector('#details');

function logStep(name, status, extra = '') {
  let item = [...steps.children].find((child) => child.dataset.name === name);
  if (!item) {
    item = document.createElement('li');
    item.dataset.name = name;
    steps.appendChild(item);
  }
  item.className = status;
  item.textContent = `${status === 'pass' ? '✓' : status === 'fail' ? '✗' : '…'} ${name}${extra ? ` — ${extra}` : ''}`;
  console.info(`[e2e] ${status}: ${name}${extra ? ` (${extra})` : ''}`);
  return item;
}

function fail(message, cause) {
  logStep(message, 'fail', cause?.message || '');
  verdict.textContent = 'FAIL';
  verdict.className = 'fail';
  details.textContent = [message, cause?.stack || ''].filter(Boolean).join('\n');
  sessionStorage.removeItem(PHASE_KEY);
  console.error('[e2e] FAIL', message, cause);
}

function readPhase() {
  try {
    return JSON.parse(sessionStorage.getItem(PHASE_KEY) || 'null');
  } catch {
    return null;
  }
}

function assertSameDocument(expected, actual) {
  const fields = [
    'kind',
    'formatVersion',
    'id',
    'title',
    'battlefield',
    'sides',
    'ruleset',
    'units',
    'terrainFeatures',
    'createdAt',
    'updatedAt',
  ];
  for (const field of fields) {
    const left = JSON.stringify(expected[field]);
    const right = JSON.stringify(actual[field]);
    if (left !== right) {
      throw new Error(`field "${field}" differs after reload: ${left} vs ${right}`);
    }
  }
}

// Every stored metre value keeps 0.1 m precision. The save/export/import
// round-trip gate (#20) fails when any value drifts off that grid, using the
// same off-grid walk the unit tests assert against.
function assertMetresToTenth(document) {
  const off = valuesOffTenthGrid(document);
  if (off.length > 0) {
    throw new Error(`value ${off[0]} is not on the 0.1 m grid`);
  }
}

// Battles survive reloads: the stored battle state and its committed turn
// decisions resume identically. State is also isolated from later scenario
// edits because the battle keeps its own scenario snapshot.
function assertSameBattle(expected, actual) {
  for (const field of ['battle', 'decisions']) {
    const left = JSON.stringify(expected[field]);
    const right = JSON.stringify(actual[field]);
    if (left !== right) {
      throw new Error(`battle ${field} differs after reload`);
    }
  }
  const battle = actual.battle;
  for (const field of ['scenario', 'ruleset', 'parameters', 'seed', 'controllers']) {
    if (JSON.stringify(battle[field]) === undefined) {
      throw new Error(`resumed battle is missing "${field}"`);
    }
  }
}

// Acceptance scenario step 2: forest, rough ground, and a settlement on a
// 1400 × 900 m battlefield. The same ground-cover helpers back the editor's
// Terrain mode, so this exercises the rules boundary the author draws with.
const ACCEPTANCE_BATTLEFIELD = { width: 1400, height: 900 };
const ACCEPTANCE_GROUNDS = [
  {
    category: 'forest',
    polygon: [
      { x: 120, y: 580 },
      { x: 280, y: 580 },
      { x: 300, y: 700 },
      { x: 180, y: 740 },
      { x: 110, y: 680 },
    ],
  },
  {
    category: 'rough',
    polygon: [
      { x: 1150, y: 600 },
      { x: 1300, y: 620 },
      { x: 1280, y: 740 },
      { x: 1140, y: 720 },
    ],
  },
  {
    category: 'settlement',
    polygon: [
      { x: 150, y: 120 },
      { x: 300, y: 120 },
      { x: 310, y: 230 },
      { x: 220, y: 260 },
      { x: 140, y: 210 },
    ],
  },
];

// Acceptance scenario steps 5-7 (issue #4) at the domain level: the same
// invariants the map editor enforces on drops, rotations, and resizes.
// Step 5: three units per side with two troop types, a spacing preset change,
// a rotation to 30 degrees, and inspector ranks/frontage/depth. Step 6: an
// overlapping drop is refused with a highlight, edge-to-edge touching is
// accepted. Step 7: shrinking the battlefield past a unit is refused, naming
// the blocking units.
// Acceptance scenario steps 4–8 (issue #4) build on the scenario steps 1–3
// drafted: the same document is renamed, fielded, edited, and undone, then
// handed to step 9 so the saved scenario carries the sides and units.
async function phaseUnitPlacement(drafted) {
  logStep('acceptance step 4: rename the sides Athens and Sparta', 'running');
  const renamed = drafted;
  renamed.sides[0].name = 'Athens';
  renamed.sides[1].name = 'Sparta';
  renamed.sides[0].color = '#1d4ed8';
  renamed.sides[1].color = '#b91c1c';
  if (renamed.sides[0].name === renamed.sides[1].name) {
    throw new Error('side names must differ');
  }
  if (renamed.sides[0].color.toLowerCase() === renamed.sides[1].color.toLowerCase()) {
    throw new Error('side colours must differ');
  }
  const emptyWarnings = collectWarnings(renamed);
  if (emptyWarnings.length !== 2 || !emptyWarnings.every((warning) => /has no units/.test(warning))) {
    throw new Error(`expected two empty-side warnings, got: ${JSON.stringify(emptyWarnings)}`);
  }
  logStep('acceptance step 4: rename the sides Athens and Sparta', 'pass', '2 empty-side warnings');

  logStep('acceptance step 5: build "Acceptance plain" at 1400 x 900 m', 'running');
  const document = renamed;
  if (document.battlefield.width !== 1400 || document.battlefield.height !== 900) {
    throw new Error('battlefield size was not kept');
  }
  if (document.description !== 'Editor acceptance probe: steps 1-10.') {
    throw new Error('description was not kept');
  }
  const sides = document.sides.map((side) => side.id);
  const specs = [
    { name: 'I Athenian taxis', side: sides[0], troopType: 'hoplite', soldiers: 256, files: 16, lateralInterval: 1, rankDepth: 1, position: { x: 500, y: 600 }, facing: 180 },
    { name: 'Athenian peltasts', side: sides[0], troopType: 'peltast', soldiers: 120, files: 12, lateralInterval: 1.5, rankDepth: 1.5, position: { x: 750, y: 620 }, facing: 180 },
    { name: 'Athenian cavalry', side: sides[0], troopType: 'cavalry', soldiers: 80, files: 10, lateralInterval: 1.5, rankDepth: 3, position: { x: 1000, y: 600 }, facing: 150 },
    { name: 'I Spartan mora', side: sides[1], troopType: 'hoplite', soldiers: 320, files: 16, lateralInterval: 1, rankDepth: 1, position: { x: 550, y: 300 }, facing: 0 },
    { name: 'Spartan archers', side: sides[1], troopType: 'archer', soldiers: 100, files: 14, lateralInterval: 1.5, rankDepth: 1.5, position: { x: 800, y: 280 }, facing: 0 },
    { name: 'Skiritae peltasts', side: sides[1], troopType: 'peltast', soldiers: 120, files: 12, lateralInterval: 2, rankDepth: 2, position: { x: 1050, y: 300 }, facing: 30 },
  ];
  let counter = 1;
  document.units = specs.map((spec) => ({ ...spec, id: `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}` }));
  const structural = validateScenario(document);
  if (structural.length > 0) {
    throw new Error(`acceptance units are invalid: ${structural.join('; ')}`);
  }
  if (collectWarnings(document).length !== 0) {
    throw new Error(`empty-side warnings persist with units fielded: ${collectWarnings(document).join('; ')}`);
  }
  logStep('acceptance step 4: warnings clear once both sides field units', 'pass', 'no issues');
  const troopTypes = new Set(document.units.map((unit) => unit.troopType));
  if (troopTypes.size < 2) {
    throw new Error('acceptance units must use at least two troop types');
  }
  logStep('acceptance step 5: build "Acceptance plain" at 1400 x 900 m', 'pass', '6 units, 2+ troop types');

  logStep('acceptance step 5: spacing preset, rotation, and inspector values', 'running');
  // Spacing preset change: open peltasts (3.0 m spacings) reshape the footprint.
  const peltasts = document.units.find((unit) => unit.name === 'Athenian peltasts');
  const opened = roundScenarioToTenth(
    (() => {
      const copy = cloneScenario(document);
      const target = copy.units.find((unit) => unit.id === peltasts.id);
      target.lateralInterval = 3;
      target.rankDepth = 3;
      return copy;
    })(),
  );
  if (validateScenario(opened).length > 0) {
    throw new Error('spacing preset change was refused on open ground');
  }
  const before = deriveFootprint(peltasts);
  const after = deriveFootprint(opened.units.find((unit) => unit.id === peltasts.id));
  if (!(after.frontage > before.frontage && after.depth > before.depth)) {
    throw new Error('spacing preset change did not reshape the footprint');
  }
  // Rotation through the same proposal the handle drag uses: the snapped
  // handle value for a 33° pointer angle is 30°.
  const rotated = proposeUnitPatch(document, peltasts.id, { facing: snapFacing(33) });
  if (!rotated.ok || rotated.document.units.find((unit) => unit.id === peltasts.id).facing !== 30) {
    throw new Error('rotation to 30 degrees was refused on open ground');
  }
  if (snapFacing(33) !== 30 || snapFacing(38) !== 45 || normalizeFacing(-45) !== 315) {
    throw new Error('facing snap/normalize behaves unexpectedly');
  }
  // Inspector values: ranks, frontage, and depth from the footprint.
  const taxis = document.units.find((unit) => unit.name === 'I Athenian taxis');
  const footprint = deriveFootprint(taxis);
  if (footprint.ranks !== 16 || footprint.frontage !== 16 || footprint.depth !== 16) {
    throw new Error(`inspector values are wrong: ${JSON.stringify(footprint)}`);
  }
  logStep(
    'acceptance step 5: spacing preset, rotation, and inspector values',
    'pass',
    '16 ranks · 16.0 m frontage · 16.0 m depth',
  );

  logStep('acceptance step 6: overlapping drops are refused, touching is accepted', 'running');
  const droppedSnapshot = JSON.stringify(document);
  const overlapped = proposeUnitPatch(document, peltasts.id, { position: { ...taxis.position } });
  if (overlapped.ok) {
    throw new Error('dropping a unit onto another was accepted');
  }
  if (!overlapped.conflictIds.includes(taxis.id) || !overlapped.conflictIds.includes(peltasts.id)) {
    throw new Error('refused drop does not highlight both units');
  }
  if (JSON.stringify(document) !== droppedSnapshot) {
    throw new Error('a refused drop mutated the document');
  }
  // Edge to edge: the peltasts (18 m frontage) east of the taxis (16 m).
  const touching = proposeUnitPatch(document, peltasts.id, {
    position: { x: taxis.position.x + (16 + 18) / 2, y: taxis.position.y },
  });
  if (!touching.ok) {
    throw new Error(`touching edge to edge was refused: ${touching.errors.join('; ')}`);
  }
  for (const unit of document.units) {
    if (unit.id === peltasts.id) {
      continue;
    }
    const kept = touching.document.units.find((entry) => entry.id === unit.id);
    if (JSON.stringify(kept) !== JSON.stringify(unit)) {
      throw new Error(`a successful patch touched uninvolved unit "${unit.name}"`);
    }
  }
  // Selection uses the real footprint: inside hits, empty ground misses.
  if (pickUnitIdAtPoint(document, { x: 500, y: 608 }, 0) !== taxis.id) {
    throw new Error('footprint hit test misses the inside of a unit');
  }
  if (pickUnitIdAtPoint(document, { x: 100, y: 100 }, 0) !== null) {
    throw new Error('footprint hit test hits empty ground');
  }
  if (pickUnitIdAtPoint(document, { x: 500, y: 598 }, 0) !== null) {
    throw new Error('footprint hit test hits outside without tolerance');
  }
  if (pickUnitIdAtPoint(document, { x: 500, y: 598 }, 5) !== taxis.id) {
    throw new Error('screen-pixel tolerance does not extend the hit');
  }
  logStep(
    'acceptance step 6: overlapping drops are refused, touching is accepted',
    'pass',
    overlapped.errors[0],
  );

  logStep('acceptance step 7: shrinking past a unit is refused', 'running');
  const blockers = unitsBlockingResize(document, 400, 900);
  if (blockers.length === 0 || !blockers.some((blocker) => blocker.name === 'I Athenian taxis')) {
    throw new Error('shrink blockers do not name the unit that would fall outside');
  }
  let shrinkError = '';
  try {
    resizeBattlefield(document, 400, 900);
  } catch (error) {
    shrinkError = error.message;
  }
  if (!shrinkError.includes('I Athenian taxis')) {
    throw new Error('shrink refusal does not name the blocking unit');
  }
  // A shrink that keeps every footprint still succeeds. resizeBattlefield
  // returns a new document, so the draft keeps its 1400 × 900 m battlefield
  // for step 9; only the refusal-free return matters here.
  resizeBattlefield(document, 1400, 700);
  logStep('acceptance step 7: shrinking past a unit is refused', 'pass', shrinkError);

  logStep('acceptance step 8: undo and redo terrain, unit, and property edits', 'running');
  let session = cloneScenario(document);
  let sessionHistory = createHistory();
  sessionHistory = historyCommit(sessionHistory, cloneScenario(session));
  session = { ...session, title: 'Acceptance plain (edited)' };
  sessionHistory = historyCommit(sessionHistory, cloneScenario(session));
  session = addGroundCoverFeature(session, {
    category: 'forest',
    polygon: [
      { x: 100, y: 100 },
      { x: 200, y: 100 },
      { x: 200, y: 200 },
      { x: 100, y: 200 },
    ],
  });
  sessionHistory = historyCommit(sessionHistory, cloneScenario(session));
  const placed = probeUnitForUndo(session);
  session = { ...session, units: [...session.units, placed] };
  const shifted = proposeUnitPatch(session, placed.id, { position: { x: 620, y: 400 } });
  if (!shifted.ok) {
    throw new Error(`undo-probe move refused: ${shifted.errors.join('; ')}`);
  }
  sessionHistory = historyCommit(sessionHistory, cloneScenario(session));
  session = shifted.document;
  for (let step = 0; step < 4; step += 1) {
    const undone = historyUndo(sessionHistory, cloneScenario(session));
    if (!undone) throw new Error(`undo step ${step + 1} is missing`);
    sessionHistory = undone.history;
    session = undone.document;
  }
  if (JSON.stringify(session) !== JSON.stringify(document)) {
    throw new Error('undoing every step did not restore the session start');
  }
  for (let step = 0; step < 4; step += 1) {
    const redone = historyRedo(sessionHistory, cloneScenario(session));
    if (!redone) throw new Error(`redo step ${step + 1} is missing`);
    sessionHistory = redone.history;
    session = redone.document;
  }
  if (session.terrainFeatures.length !== document.terrainFeatures.length + 1) {
    throw new Error('redoing every step did not restore the terrain edit');
  }
  logStep(
    'acceptance step 8: undo and redo terrain, unit, and property edits',
    'pass',
    '4 undo steps · 4 redo steps',
  );
  return document;
}

function probeUnitForUndo(document) {
  const side = document.sides[0].id;
  let counter = 900;
  const taken = new Set((document.units || []).map((unit) => unit.id));
  let id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  while (taken.has(id)) {
    counter += 1;
    id = `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
  }
  return {
    id,
    name: 'Undo probe taxis',
    side,
    troopType: 'hoplite',
    soldiers: 100,
    files: 10,
    lateralInterval: 1,
    rankDepth: 1,
    position: { x: 600, y: 400 },
    facing: 0,
  };
}

// Acceptance scenario steps 1–3 (issue #4): draft the scenario the later
// steps build on. Returns the unsaved document.
async function phaseSetup() {
  const store = new IndexedDBScenarioStore({ dbName: DB_NAME });
  logStep('clear the end-to-end test database', 'running');
  await store.clear();
  logStep('clear the end-to-end test database', 'pass');

  logStep('acceptance step 1: create "Acceptance plain" with a required title', 'running');
  let created = createScenario({
    title: 'Acceptance plain',
    description: 'Editor acceptance probe: steps 1-10.',
  });
  if (!created.id || created.title !== 'Acceptance plain') {
    throw new Error('created scenario is incomplete');
  }
  if (created.sides.length !== 2) throw new Error('expected two default sides');
  try {
    createScenario({ title: '   ' });
    throw new Error('a blank title was accepted');
  } catch (error) {
    if (!/title is required/i.test(error.message)) throw error;
  }
  logStep('acceptance step 1: create "Acceptance plain" with a required title', 'pass', created.title);

  logStep('acceptance step 1: set the battlefield to 1400 × 900 m with a description', 'running');
  created = resizeBattlefield(created, ACCEPTANCE_BATTLEFIELD.width, ACCEPTANCE_BATTLEFIELD.height);
  if (created.description !== 'Editor acceptance probe: save, reload, and reopen.') {
    throw new Error('description was not kept');
  }
  logStep('acceptance step 1: set the battlefield to 1400 × 900 m with a description', 'pass');

  logStep('acceptance step 2: draw forest, rough ground, and a settlement', 'running');
  for (const ground of ACCEPTANCE_GROUNDS) {
    created = addGroundCoverFeature(created, ground);
  }
  const grounds = created.terrainFeatures.filter((feature) => feature.kind === 'ground');
  if (grounds.length !== 3) throw new Error(`expected 3 ground cover areas, got ${grounds.length}`);
  if (validateScenario(created).length > 0) {
    throw new Error(`drawn areas are invalid: ${validateScenario(created).join('; ')}`);
  }
  logStep('acceptance step 2: draw forest, rough ground, and a settlement', 'pass', '3 areas');

  logStep('acceptance step 2: refuse an area overlapping the forest with a highlight', 'running');
  const overlapping = validateGroundCoverCandidate(created, [
    { x: 200, y: 650 },
    { x: 350, y: 650 },
    { x: 350, y: 780 },
    { x: 200, y: 780 },
  ]);
  if (overlapping.ok) throw new Error('an overlapping area was accepted');
  if (!/overlap/.test(overlapping.reason)) {
    throw new Error(`unexpected refusal reason: ${overlapping.reason}`);
  }
  if (!Array.isArray(overlapping.ring) || overlapping.ring.length < 3) {
    throw new Error('the refusal carries no highlight ring');
  }
  logStep('acceptance step 2: refuse an area overlapping the forest with a highlight', 'pass', overlapping.reason);

  // Acceptance step 3: a river and a road crossing the river and the forest.
  // Linear features may cross ground cover, elevation, and each other, and
  // are clipped to the battlefield like every other terrain feature.
  logStep('acceptance step 3: draw a river crossing the forest', 'running');
  created = addLinearFeature(created, {
    category: 'river',
    width: 18,
    path: [
      { x: 0, y: 690 },
      { x: 165, y: 630 },
      { x: 245, y: 670 },
      { x: 300, y: 765 },
      { x: 410, y: 780 },
      { x: 540, y: 840 },
      { x: 610, y: 900 },
    ],
  });
  logStep('acceptance step 3: draw a river crossing the forest', 'pass', '7 vertices · 18 m');

  logStep('acceptance step 3: draw a road crossing the river and the forest', 'running');
  created = addLinearFeature(created, {
    category: 'road',
    width: 6,
    path: [
      { x: 150, y: 0 },
      { x: 250, y: 250 },
      { x: 330, y: 500 },
      { x: 380, y: 700 },
      { x: 450, y: 900 },
    ],
  });
  if (validateScenario(created).length > 0) {
    throw new Error(`crossing linears are invalid: ${validateScenario(created).join('; ')}`);
  }
  logStep('acceptance step 3: draw a road crossing the river and the forest', 'pass', '5 vertices · 6 m');

  logStep('acceptance step 3: move a river vertex and change the road width', 'running');
  const river = created.terrainFeatures.find(
    (feature) => feature.kind === 'linear' && feature.category === 'river',
  );
  const movedRiver = river.path.map((point, index) =>
    index === 2 ? { x: point.x + 10, y: point.y } : point,
  );
  const riverCheck = validateLinearCandidate(created, movedRiver);
  if (!riverCheck.ok) throw new Error(`moved river vertex refused: ${riverCheck.reason}`);
  created = updateLinearFeature(created, river.id, { path: riverCheck.path });
  const road = created.terrainFeatures.find(
    (feature) => feature.kind === 'linear' && feature.category === 'road',
  );
  const movedPath = road.path.map((point, index) =>
    index === 2 ? { x: point.x + 10, y: point.y } : point,
  );
  const check = validateLinearCandidate(created, movedPath);
  if (!check.ok) throw new Error(`moved road vertex refused: ${check.reason}`);
  created = updateLinearFeature(created, road.id, { path: check.path, width: 8 });
  const updatedRoad = created.terrainFeatures.find((feature) => feature.id === road.id);
  if (updatedRoad.width !== 8) throw new Error('road width change did not stick');
  if (validateScenario(created).length > 0) {
    throw new Error(`edited linears are invalid: ${validateScenario(created).join('; ')}`);
  }
  logStep('acceptance step 3: move a river vertex and change the road width', 'pass', '8 m');

  logStep('acceptance step 3: clip an area reaching past the edge to the battlefield', 'running');
  created = addGroundCoverFeature(created, {
    category: 'water',
    polygon: [
      { x: -40, y: 400 },
      { x: 120, y: 400 },
      { x: 120, y: 520 },
      { x: -40, y: 520 },
    ],
  });
  const clipped = created.terrainFeatures[created.terrainFeatures.length - 1];
  if (!clipped.polygon.every((point) => point.x >= 0 && point.y >= 0)) {
    throw new Error('the stored vertices leave the battlefield');
  }
  if (!clipped.polygon.some((point) => point.x === 0)) {
    throw new Error('the stored vertices are not the clipped boundary');
  }
  logStep('acceptance step 3: clip an area reaching past the edge to the battlefield', 'pass');

  logStep('acceptance step 3: draw a hill with two nested levels (levels 1 and 2 derived)', 'running');
  created = addElevationFeature(created, {
    polygon: [
      { x: 600, y: 300 },
      { x: 900, y: 300 },
      { x: 900, y: 550 },
      { x: 600, y: 550 },
    ],
  });
  created = addElevationFeature(created, {
    polygon: [
      { x: 700, y: 380 },
      { x: 820, y: 380 },
      { x: 820, y: 480 },
      { x: 700, y: 480 },
    ],
  });
  const hills = created.terrainFeatures.filter((feature) => feature.kind === 'elevation');
  if (hills.length !== 2) throw new Error(`expected 2 hills, got ${hills.length}`);
  if (hills[0].level !== 1 || hills[1].level !== 2) {
    throw new Error(`levels are not derived from nesting: ${hills.map((hill) => hill.level).join(', ')}`);
  }
  if (validateScenario(created).length > 0) {
    throw new Error(`drawn hills are invalid: ${validateScenario(created).join('; ')}`);
  }
  logStep('acceptance step 3: draw a hill with two nested levels (levels 1 and 2 derived)', 'pass', 'levels 1, 2');

  logStep('acceptance step 3: refuse a hill crossing a sibling with a highlight', 'running');
  const crossingHill = validateElevationCandidate(created, [
    { x: 850, y: 400 },
    { x: 1000, y: 400 },
    { x: 1000, y: 520 },
    { x: 850, y: 520 },
  ]);
  if (crossingHill.ok) throw new Error('a crossing hill was accepted');
  if (!/cross|wholly inside|sibling/.test(crossingHill.reason)) {
    throw new Error(`unexpected refusal reason: ${crossingHill.reason}`);
  }
  if (!Array.isArray(crossingHill.ring) || crossingHill.ring.length < 3) {
    throw new Error('the refusal carries no highlight ring');
  }
  logStep('acceptance step 3: refuse a hill crossing a sibling with a highlight', 'pass', crossingHill.reason);
  return created;
}

// Acceptance scenario step 9 (issue #4), which is also persistence step 1
// (issue #5): save the scenario built in steps 1–8, snapshot it, and reload
// the browser. The reopen half runs as phaseReopen after the reload.
async function phaseSaveAndReload(document) {
  const store = new IndexedDBScenarioStore({ dbName: DB_NAME });
  logStep('acceptance step 9: save it through the scenario store', 'running');
  const metadata = await store.save(document);
  const snapshot = await store.load(document.id);
  if (!snapshot) throw new Error('saved scenario cannot be loaded back');
  logStep('acceptance step 9: save it through the scenario store', 'pass', `rev. ${metadata.revision}`);

  logStep('acceptance step 9: list the scenario in the library', 'running');
  const listed = await store.list();
  if (!listed.some((entry) => entry.id === document.id && entry.title === document.title)) {
    throw new Error('saved scenario is missing from the library');
  }
  logStep('acceptance step 9: list the scenario in the library', 'pass', `${listed.length} in library`);

  sessionStorage.setItem(PHASE_KEY, JSON.stringify({ phase: 'reopen', id: document.id, snapshot }));
  logStep('acceptance step 9: reload the browser', 'running', 'reloading…');
  store.close();
  location.reload();
}

async function phaseReopen(phase) {
  // Fresh store instance, as after a real reload: nothing is reused.
  const store = new IndexedDBScenarioStore({ dbName: DB_NAME });
  logStep('acceptance step 1: create "Acceptance plain" with a required title', 'pass', '(before reload)');
  logStep('acceptance step 9: save it through the scenario store', 'pass', '(before reload)');
  logStep('acceptance step 9: list the scenario in the library', 'pass', '(before reload)');
  logStep('acceptance step 9: reload the browser', 'pass', 'done');

  logStep('acceptance step 9: list the scenario library after reload', 'running');
  const listed = await store.list();
  const entry = listed.find((item) => item.id === phase.id);
  if (!entry) throw new Error('scenario missing from the library after reload');
  logStep('acceptance step 9: list the scenario library after reload', 'pass', `${listed.length} in library`);

  logStep('acceptance step 9: reopen the scenario with identical values', 'running');
  const reopened = await store.load(phase.id);
  if (!reopened) throw new Error('scenario cannot be reopened after reload');
  assertSameDocument(phase.snapshot, reopened);
  logStep('acceptance step 9: reopen the scenario with identical values', 'pass', reopened.title);

  logStep('acceptance step 9: renamed sides and placed units survive the reload', 'running');
  if (reopened.sides[0].name !== 'Athens' || reopened.sides[1].name !== 'Sparta') {
    throw new Error(
      `renamed sides did not survive the reload: ${reopened.sides.map((side) => side.name).join(', ')}`,
    );
  }
  if ((reopened.units || []).length !== 6) {
    throw new Error(`expected 6 placed units after reload, got ${(reopened.units || []).length}`);
  }
  if (collectWarnings(reopened).length !== 0) {
    throw new Error(`empty-side warnings persist with units fielded: ${collectWarnings(reopened).join('; ')}`);
  }
  logStep(
    'acceptance step 9: renamed sides and placed units survive the reload',
    'pass',
    'Athens/Sparta · 6 units',
  );

  logStep('keep the drawn ground cover identical and valid', 'running');
  const grounds = (reopened.terrainFeatures || []).filter((feature) => feature.kind === 'ground');
  if (grounds.length !== 4) throw new Error(`expected 4 ground cover areas, got ${grounds.length}`);
  if (validateScenario(reopened).length > 0) {
    throw new Error(`reopened terrain is invalid: ${validateScenario(reopened).join('; ')}`);
  }
  logStep('keep the drawn ground cover identical and valid', 'pass', '4 areas');

  logStep('keep the river and the road crossing them', 'running');
  const linears = (reopened.terrainFeatures || []).filter((feature) => feature.kind === 'linear');
  if (linears.length !== 2) throw new Error(`expected 2 rivers/roads, got ${linears.length}`);
  const river = linears.find((feature) => feature.category === 'river');
  const road = linears.find((feature) => feature.category === 'road');
  if (!river || river.width !== 18) throw new Error('the river did not survive the reload');
  if (!road || road.width !== 8) throw new Error('the edited road width did not survive the reload');
  logStep('keep the river and the road crossing them', 'pass', 'river 18 m · road 8 m');

  logStep('keep the nested hills identical with derived levels', 'running');
  const reopenedHills = (reopened.terrainFeatures || []).filter((feature) => feature.kind === 'elevation');
  if (reopenedHills.length !== 2) throw new Error(`expected 2 hills, got ${reopenedHills.length}`);
  if (reopenedHills[0].level !== 1 || reopenedHills[1].level !== 2) {
    throw new Error(`hill levels changed across reload: ${reopenedHills.map((hill) => hill.level).join(', ')}`);
  }
  logStep('keep the nested hills identical with derived levels', 'pass', 'levels 1, 2');

  logStep('acceptance step 9: every value is identical to 0.1 m', 'running');
  assertMetresToTenth(reopened);
  const { json: reopenedJson } = exportScenario(reopened);
  const reimported = importScenarioDocument(reopenedJson);
  assertMetresToTenth(reimported);
  // Import assigns a new identifier; every other value must survive verbatim.
  assertSameDocument({ ...reopened, id: reimported.id }, reimported);
  logStep('acceptance step 9: every value is identical to 0.1 m', 'pass', 'save/export/import agree');

  logStep('acceptance step 9: the undo history is empty after reopening', 'running');
  const freshHistory = createHistory();
  if (historyUndo(freshHistory, cloneScenario(reopened)) !== null) {
    throw new Error('a fresh editing session must have nothing to undo');
  }
  if (historyRedo(freshHistory, cloneScenario(reopened)) !== null) {
    throw new Error('a fresh editing session must have nothing to redo');
  }
  logStep('acceptance step 9: the undo history is empty after reopening', 'pass', 'nothing to undo or redo');
  logStep(
    'persistence step 1: save, quit, and reopen keeps every value identical to 0.1 m',
    'pass',
    'library hit · 0.1 m · empty history',
  );

  logStep('acceptance step 10: duplicate the scenario, then delete the duplicate', 'running');
  const duplicate = duplicateScenario(reopened);
  if (duplicate.id === reopened.id) throw new Error('the duplicate kept the original identifier');
  const duplicateMetadata = await store.save(duplicate);
  if (duplicateMetadata.revision !== 1) {
    throw new Error(`expected the duplicate to start at rev. 1, got rev. ${duplicateMetadata.revision}`);
  }
  const withDuplicate = await store.list();
  if (!withDuplicate.some((item) => item.id === duplicate.id)) {
    throw new Error('the duplicate is missing from the library');
  }
  await store.remove(duplicate.id);
  const afterDelete = await store.list();
  if (afterDelete.some((item) => item.id === duplicate.id)) {
    throw new Error('the deleted duplicate is still listed');
  }
  if (!afterDelete.some((item) => item.id === reopened.id)) {
    throw new Error('deleting the duplicate removed the original');
  }
  logStep(
    'acceptance step 10: duplicate the scenario, then delete the duplicate',
    'pass',
    'duplicate rev. 1 removed, original kept',
  );

  await phasePersistenceExportImportCopies(store, reopened);
  await phasePersistenceTwoTabConflict(store, reopened);
  await phasePersistenceRejectBadFiles(store);
  await phasePersistenceQuotaFailure(store, reopened);
  await phasePersistenceUnknownTroopKey(store);

  await phaseBattleTurns();

  store.close();
  await phaseBattlePersistence(reopened, entry);
}

// Persistence acceptance steps 2–3 (#5): export the scenario, delete it,
// import the file as a new copy with a new identifier and identical content,
// import the same file again, and prove the two copies are independent.
async function phasePersistenceExportImportCopies(store, reopened) {
  logStep('persistence step 2: export, delete, and import as a new copy', 'running');
  const countBefore = (await store.list()).length;
  const { json } = exportScenario(reopened);
  await store.remove(reopened.id);
  if ((await store.list()).some((item) => item.id === reopened.id)) {
    throw new Error('the deleted scenario is still listed');
  }
  const firstCopy = importScenarioDocument(json);
  if (firstCopy.id === reopened.id) throw new Error('the import kept the original identifier');
  await store.save(firstCopy);
  const reloadedFirst = await store.load(firstCopy.id);
  // Timestamps refresh on save; every other value survives verbatim.
  assertSameDocument(
    {
      ...reopened,
      id: reloadedFirst.id,
      createdAt: reloadedFirst.createdAt,
      updatedAt: reloadedFirst.updatedAt,
    },
    reloadedFirst,
  );
  logStep('persistence step 2: export, delete, and import as a new copy', 'pass', 'new id, identical content');

  logStep('persistence step 3: import the same file again as an independent copy', 'running');
  const secondCopy = importScenarioDocument(json);
  if (secondCopy.id === firstCopy.id) throw new Error('the second import reused the first copy identifier');
  await store.save(secondCopy);
  const edited = cloneScenario(await store.load(firstCopy.id));
  edited.title = 'Edited without touching the sibling copy';
  await store.save(edited);
  const sibling = await store.load(secondCopy.id);
  if (sibling.title === edited.title) {
    throw new Error('editing one copy changed the other');
  }
  if ((await store.list()).length !== countBefore + 1) {
    throw new Error('expected the two imports minus the deleted original in the library');
  }
  // Restore the reopened scenario for the steps that follow.
  await store.remove(firstCopy.id);
  await store.remove(secondCopy.id);
  const restored = importScenarioDocument(json);
  restored.id = reopened.id;
  await store.save(restored);
  logStep('persistence step 3: import the same file again as an independent copy', 'pass', 'copies are independent');
}

// Persistence acceptance step 4 (#5): two tabs. A second tab saves first, so
// the first tab's save raises a save conflict instead of silently
// overwriting; overwriting only on request and saving as a copy both work.
async function phasePersistenceTwoTabConflict(store, reopened) {
  logStep('persistence step 4: a stale second-tab save asks Overwrite or Save as copy', 'running');
  const firstTab = await store.load(reopened.id);
  const secondTab = await store.load(reopened.id);
  const listed = await store.list();
  const storedRevision = listed.find((item) => item.id === reopened.id)?.revision ?? 1;
  // Both tabs save through the editor's save path: the first tab to save wins,
  // so the second save below raises a conflict instead of overwriting silently.
  await performSave(store, { ...secondTab, description: 'Second tab wins first.' }, {
    loadedRevision: storedRevision,
    storedRevision,
  });
  let conflicted = null;
  try {
    await performSave(store, { ...firstTab, description: 'First tab.' }, {
      loadedRevision: storedRevision,
      storedRevision: storedRevision + 1,
    });
  } catch (error) {
    conflicted = error;
  }
  if (!(conflicted instanceof SaveConflictError)) {
    throw new Error('a stale save did not raise a save conflict');
  }
  if (!detectSaveConflict(storedRevision, storedRevision + 1)) {
    throw new Error('stale revisions do not detect a conflict');
  }
  await performSave(store, { ...firstTab, description: 'First tab overwrites.' }, {
    loadedRevision: storedRevision,
    storedRevision: storedRevision + 1,
    overwrite: true,
  });
  if ((await store.load(reopened.id)).description !== 'First tab overwrites.') {
    throw new Error('overwrite did not store the first tab version');
  }
  const copy = duplicateScenario(await store.load(reopened.id));
  await performSave(store, copy, { loadedRevision: null, storedRevision: null });
  await store.remove(copy.id);
  await store.save({ ...reopened, description: reopened.description });
  logStep('persistence step 4: a stale second-tab save asks Overwrite or Save as copy', 'pass', 'overwrite and copy work');
}

// Persistence acceptance step 5 (#5): each bad file is rejected with its
// specific cause and the library is unchanged.
async function phasePersistenceRejectBadFiles(store) {
  logStep('persistence step 5: reject bad files with a specific cause', 'running');
  const countBefore = (await store.list()).length;
  const probe = createScenario({ title: 'Persistence step 5 probe' });
  const exported = JSON.parse(exportScenario(probe).json);
  const badFiles = [
    { label: 'non-JSON', json: 'this is not json {', pattern: /not valid JSON/ },
    {
      label: 'another document kind',
      json: JSON.stringify({ kind: 'battle', formatVersion: 1 }),
      pattern: /not a scenario/,
    },
    {
      label: 'higher format version',
      json: JSON.stringify({ ...exported, formatVersion: SCENARIO_FORMAT_VERSION + 1 }),
      pattern: /newer than the supported/,
    },
    {
      label: 'unknown ruleset',
      json: JSON.stringify({ ...exported, ruleset: { id: 'other-rules', version: '1.0' } }),
      pattern: /unknown ruleset/,
    },
    {
      label: 'overlapping units',
      json: JSON.stringify({
        ...exported,
        units: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            name: 'First',
            side: exported.sides[0].id,
            troopType: 'hoplite',
            soldiers: 100,
            files: 10,
            lateralInterval: 1,
            rankDepth: 1,
            position: { x: 600, y: 400 },
            facing: 0,
          },
          {
            id: '00000000-0000-4000-8000-000000000002',
            name: 'Second',
            side: exported.sides[0].id,
            troopType: 'hoplite',
            soldiers: 100,
            files: 10,
            lateralInterval: 1,
            rankDepth: 1,
            position: { x: 600, y: 400 },
            facing: 0,
          },
        ],
      }),
      pattern: /overlap/,
    },
  ];
  for (const bad of badFiles) {
    let refused = null;
    try {
      parseScenarioImport(bad.json);
    } catch (error) {
      refused = error;
    }
    if (!refused || !bad.pattern.test(refused.message)) {
      throw new Error(`"${bad.label}" was not refused specifically: ${refused?.message || 'accepted'}`);
    }
    // The unknown-ruleset refusal names the supported catalogue.
    if (bad.label === 'unknown ruleset' && !refused.message.includes(RULESET_ID)) {
      throw new Error(`the unknown-ruleset refusal does not name "${RULESET_ID}": ${refused.message}`);
    }
  }
  if ((await store.list()).length !== countBefore) {
    throw new Error('a rejected import changed the library');
  }
  logStep('persistence step 5: reject bad files with a specific cause', 'pass', '5 files refused, library unchanged');
}

// Persistence acceptance step 8 (#5): a save that hits a simulated quota
// error shows an error, leaves the previous version intact, and keeps the
// unsaved-changes indicator (the caller stays dirty).
async function phasePersistenceQuotaFailure(store, reopened) {
  logStep('persistence step 8: a quota failure keeps the previous version and stays dirty', 'running');
  const quota = new Error('QuotaExceededError: storage is full');
  quota.name = 'QuotaExceededError';
  if (!isQuotaError(quota)) throw new Error('quota failures are not recognised');
  const failingStore = {
    save: async () => {
      throw quota;
    },
  };
  const before = await store.load(reopened.id);
  let dirty = true;
  try {
    await performSave(failingStore, { ...before, description: 'Lost write.' }, {
      loadedRevision: 1,
      storedRevision: 1,
    });
    dirty = false;
  } catch (error) {
    if (!isQuotaError(error)) throw error;
  }
  if (!dirty) throw new Error('a failed save cleared the unsaved-changes state');
  const intact = await store.load(reopened.id);
  if (JSON.stringify(intact) !== JSON.stringify(before)) {
    throw new Error('a failed save changed the stored version');
  }
  logStep('persistence step 8: a quota failure keeps the previous version and stays dirty', 'pass', 'previous version intact');
}

// Persistence acceptance step 6 (#5): a file carrying a unit whose
// troop-type key is unknown to the catalogue. It opens (validates), the unit
// is marked (the warning helper names it, which is what the editor's issues
// panel shows), it saves, and the key is preserved verbatim after reopening.
async function phasePersistenceUnknownTroopKey(store) {
  logStep('persistence step 6: import a file with an unknown troop-type key', 'running');
  const authored = createScenario({ title: 'Persistence step 6 probe' });
  authored.units.push({
    id: '00000000-0000-4000-8000-000000000006',
    name: 'Strangers',
    side: authored.sides[0].id,
    troopType: 'cataphract',
    soldiers: 100,
    files: 10,
    lateralInterval: 1,
    rankDepth: 1,
    position: { x: 600, y: 400 },
    facing: 0,
  });
  if (validateScenario(authored).length > 0) {
    throw new Error(`a probe with an unknown key is invalid: ${validateScenario(authored).join('; ')}`);
  }
  const { json } = exportScenario(authored);
  if (!json.includes('cataphract')) {
    throw new Error('the exported file lost the unknown key');
  }
  const imported = importScenarioDocument(json);
  if (imported.units[0]?.troopType !== 'cataphract') {
    throw new Error('the import did not preserve the unknown key verbatim');
  }
  logStep('persistence step 6: import a file with an unknown troop-type key', 'pass', 'key preserved on import');
  logStep('persistence step 6: the unit is marked and the issues panel warns', 'running');
  const warnings = collectUnknownTroopTypeWarnings(imported);
  if (warnings.length !== 1 || !warnings[0].includes('cataphract')) {
    throw new Error(`expected one warning naming cataphract, got: ${JSON.stringify(warnings)}`);
  }
  logStep('persistence step 6: the unit is marked and the issues panel warns', 'pass', warnings[0]);
  logStep('persistence step 6: save it and reopen with the key intact', 'running');
  const metadata = await store.save(imported);
  const reopened = await store.load(imported.id);
  if (!reopened) {
    throw new Error('the saved scenario cannot be loaded back');
  }
  if (reopened.units[0]?.troopType !== 'cataphract') {
    throw new Error(`the key changed across save/reopen: ${reopened.units[0]?.troopType}`);
  }
  if (validateScenario(reopened).length > 0) {
    throw new Error(`the reopened scenario is invalid: ${validateScenario(reopened).join('; ')}`);
  }
  logStep('persistence step 6: save it and reopen with the key intact', 'pass', `rev. ${metadata.revision}`);
}

// Battle acceptance: Human vs Passive for two turns through the engine,
// plus the playability refusal path. The human side commits an empty turn
// (validated by the engine, then resolved); the Passive side resolves through
// the runner at once. The seed is fixed in code — the UI never shows it —
// and the player view carries neither the seed nor the generator state.
async function phaseBattleTurns() {
  logStep('battle: Human vs Passive plays two turns', 'running');
  const document = createScenario({ title: 'Battle probe' });
  const [first, second] = document.sides;
  let counter = 1;
  const probeId = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
  document.units.push(
    {
      id: probeId(),
      name: 'Probe taxis',
      side: first.id,
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 400, y: 600 },
      facing: 180,
    },
    {
      id: probeId(),
      name: 'Probe mora',
      side: second.id,
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 400, y: 200 },
      facing: 0,
    },
  );
  if (validateScenario(document).length > 0) {
    throw new Error(`battle probe is invalid: ${validateScenario(document).join('; ')}`);
  }
  if (validatePlayability(document).length > 0) {
    throw new Error(
      `battle probe is unplayable: ${validatePlayability(document).map((problem) => problem.message).join('; ')}`,
    );
  }
  const controllers = { [first.id]: 'human', [second.id]: 'passive' };
  let battle = startBattle(document, { seed: 2026, controllers });
  const starter = battle.activeSide;
  if (![first.id, second.id].includes(starter)) {
    throw new Error(`starting side is unknown: ${starter}`);
  }
  const viewKeys = new Set();
  JSON.stringify(buildPlayerView(battle), (key, value) => {
    viewKeys.add(key);
    return value;
  });
  if (viewKeys.has('seed') || viewKeys.has('rngState')) {
    throw new Error('the player view leaks the seed or the generator state');
  }
  logStep(
    'battle: Human vs Passive plays two turns',
    'pass',
    `seed set in code, ${starter === first.id ? first.name : second.name} begins`,
  );

  for (let turn = 0; turn < 2; turn += 1) {
    const active = battle.activeSide;
    const label = active === first.id ? first.name : second.name;
    logStep(`battle: turn ${battle.turnNumber} (${label}) resolves`, 'running');
    if (controllers[active] === 'human') {
      const submission = {
        formatVersion: SUBMISSION_FORMAT_VERSION,
        battleId: battle.id,
        turnNumber: battle.turnNumber,
        side: active,
        orders: [],
      };
      const verdict = validateTurn(battle, submission);
      if (!verdict.ok) {
        throw new Error(`the human empty commit was refused: ${verdict.message}`);
      }
      battle = resolveTurn(battle, { type: 'commit', submission });
    } else {
      const step = await runTurn(battle, {
        [first.id]: createPassivePlayer(),
        [second.id]: createPassivePlayer(),
      });
      battle = step.battle;
    }
    logStep(`battle: turn ${battle.turnNumber - 1} (${label}) resolves`, 'pass', `now turn ${battle.turnNumber}`);
  }
  if (battle.turnNumber !== 3) {
    throw new Error(`expected turn 3 after two turns, got turn ${battle.turnNumber}`);
  }
  if (battle.round !== 2) {
    throw new Error(`expected round 2 after two turns, got round ${battle.round}`);
  }
  if (battle.status !== 'ongoing') {
    throw new Error(`expected the battle to stay ongoing, got "${battle.status}"`);
  }
  const resolved = battle.events.filter((event) => event.type === 'turn-resolved');
  if (resolved.length !== 2) {
    throw new Error(`expected 2 turn-resolved events, got ${resolved.length}`);
  }

  logStep('battle: an unplayable scenario is refused with every problem', 'running');
  const broken = cloneScenario(document);
  broken.units = broken.units.filter((unit) => unit.side === first.id);
  const problems = validatePlayability(broken);
  if (problems.length === 0) {
    throw new Error('a side without units was accepted as playable');
  }
  let refused = null;
  try {
    startBattle(broken, { seed: 1, controllers });
  } catch (error) {
    refused = error;
  }
  if (!(refused instanceof BattleStartError)) {
    throw new Error('an unplayable scenario did not raise BattleStartError (no battle may be created)');
  }
  if (refused.problems.length !== problems.length) {
    throw new Error('the refusal does not carry every problem');
  }
  logStep(
    'battle: an unplayable scenario is refused with every problem',
    'pass',
    refused.problems[0].message,
  );
  await phaseBattleMoveDrafting();
}

// Move-order drafting through the engine: the same `validateTurn` calls the
// battle screen makes on every draft change. On open ground two hoplites of
// the active side draft Moves to one resting spot: the first validates with a
// Movement-phase ghost preview, the second is rejected with a `collision`
// naming the resting unit and the touch point (the map highlight), swapping
// the order flips the culprit, removing the colliding draft validates, and
// the surviving Move commits and advances the turn.
async function phaseBattleMoveDrafting() {
  logStep('battle drafting: inspector lists Move, reasons, and the 90 m allowance', 'running');
  const document = createScenario({ title: 'Move drafting probe' });
  const [first, second] = document.sides;
  let counter = 1;
  const probeId = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
  document.units.push(
    {
      id: probeId(),
      name: 'Draft taxis',
      side: first.id,
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 400, y: 600 },
      facing: 180,
    },
    {
      id: probeId(),
      name: 'Draft peltasts',
      side: first.id,
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 440, y: 600 },
      facing: 180,
    },
    {
      id: probeId(),
      name: 'Far mora',
      side: second.id,
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 400, y: 200 },
      facing: 0,
    },
    {
      id: probeId(),
      name: 'Far archers',
      side: second.id,
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 440, y: 200 },
      facing: 0,
    },
  );
  if ((document.terrainFeatures || []).length !== 0) {
    throw new Error('the drafting probe must stay on open ground');
  }
  if (validateScenario(document).length > 0) {
    throw new Error(`drafting probe is invalid: ${validateScenario(document).join('; ')}`);
  }
  if (validatePlayability(document).length > 0) {
    throw new Error(
      `drafting probe is unplayable: ${validatePlayability(document).map((problem) => problem.message).join('; ')}`,
    );
  }
  const controllers = { [first.id]: 'human', [second.id]: 'passive' };
  const battle = startBattle(document, { seed: 20260715, controllers });
  const own = battle.units.filter((unit) => unit.side === battle.activeSide);
  if (own.length !== 2) {
    throw new Error(`expected two units on the active side, got ${own.length}`);
  }
  const [mover, neighbour] = own;
  const actions = availableActions(battle, battle.activeSide);
  for (const unit of own) {
    const entry = actions.units.find((item) => item.unitId === unit.id);
    if (!entry) throw new Error(`availableActions is missing unit "${unit.id}"`);
    if (!entry.permitted.some((item) => item.kind === 'Move')) {
      throw new Error(`Move is not permitted for "${unit.id}"`);
    }
    if (!Array.isArray(entry.unavailable) || entry.unavailable.length === 0) {
      throw new Error(`availableActions names no unavailable reasons for "${unit.id}"`);
    }
    if (entry.movementAllowanceM !== 90) {
      throw new Error(`expected a 90 m hoplite allowance, got ${entry.movementAllowanceM}`);
    }
  }
  logStep(
    'battle drafting: inspector lists Move, reasons, and the 90 m allowance',
    'pass',
    'Move permitted · 90 m',
  );

  // The destination is 40 m straight ahead of the first mover: front-first,
  // inside the allowance. The neighbour reaches the same spot diagonally
  // (45° off, billed at the full rate) but collides once the mover rests there.
  const forward = { x: Math.sin((mover.facing * Math.PI) / 180), y: Math.cos((mover.facing * Math.PI) / 180) };
  const dest = {
    x: Math.round((mover.position.x + forward.x * 40) * 10) / 10,
    y: Math.round((mover.position.y + forward.y * 40) * 10) / 10,
  };
  const submissionFor = (orders) => ({
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
  });

  logStep('battle drafting: a single Move validates with a Movement-phase preview', 'running');
  const single = validateTurn(battle, submissionFor([{ unitId: mover.id, kind: 'Move', legs: [{ to: dest }] }]));
  if (!single.ok || !single.verdicts[0]?.accepted) {
    throw new Error(`the single Move was refused: ${single.message || single.verdicts[0]?.rejection?.message}`);
  }
  if (!Array.isArray(single.verdicts[0].preview?.corners) || single.verdicts[0].preview.corners.length < 3) {
    throw new Error('the accepted Move carries no ghost-preview corners');
  }
  if (single.verdicts[0].movement?.availableM !== 90) {
    throw new Error(`the accepted Move bills against the wrong allowance: ${JSON.stringify(single.verdicts[0].movement)}`);
  }
  logStep(
    'battle drafting: a single Move validates with a Movement-phase preview',
    'pass',
    `needs ${single.verdicts[0].movement.requiredM} m of 90 m`,
  );

  logStep('battle drafting: a second Move to the same spot is rejected with a highlight', 'running');
  const colliding = validateTurn(
    battle,
    submissionFor([
      { unitId: mover.id, kind: 'Move', legs: [{ to: dest }] },
      { unitId: neighbour.id, kind: 'Move', legs: [{ to: dest }] },
    ]),
  );
  if (colliding.ok) {
    throw new Error('two Moves to the same resting spot were accepted');
  }
  if (colliding.verdicts[0]?.accepted !== true) {
    throw new Error('the first Move should stay accepted while the second collides');
  }
  const rejection = colliding.verdicts[1]?.rejection;
  if (rejection?.code !== 'collision') {
    throw new Error(`expected a collision rejection, got "${rejection?.code}"`);
  }
  if (rejection.details?.withUnitId !== mover.id) {
    throw new Error(`the collision names the wrong unit: ${JSON.stringify(rejection.details)}`);
  }
  if (!Number.isFinite(rejection.details?.at?.x) || !Number.isFinite(rejection.details?.at?.y)) {
    throw new Error(`the collision carries no highlight point: ${JSON.stringify(rejection.details)}`);
  }
  logStep(
    'battle drafting: a second Move to the same spot is rejected with a highlight',
    'pass',
    rejection.message,
  );

  logStep('battle drafting: reordering flips the culprit and re-validates', 'running');
  const swapped = validateTurn(
    battle,
    submissionFor([
      { unitId: neighbour.id, kind: 'Move', legs: [{ to: dest }] },
      { unitId: mover.id, kind: 'Move', legs: [{ to: dest }] },
    ]),
  );
  if (swapped.ok) {
    throw new Error('the swapped Moves to the same resting spot were accepted');
  }
  if (swapped.verdicts[0]?.accepted !== true || swapped.verdicts[1]?.accepted !== false) {
    throw new Error('the swapped draft should accept the first order and reject the second');
  }
  if (swapped.verdicts[1].rejection.code !== 'collision') {
    throw new Error(`the swapped rejection is not a collision: "${swapped.verdicts[1].rejection.code}"`);
  }
  if (swapped.verdicts[1].rejection.details?.withUnitId !== neighbour.id) {
    throw new Error(
      `reordering did not flip the culprit: ${JSON.stringify(swapped.verdicts[1].rejection.details)}`,
    );
  }
  logStep('battle drafting: reordering flips the culprit and re-validates', 'pass', 'culprit flipped');

  logStep('battle drafting: removing the colliding draft validates; commit advances the turn', 'running');
  const removed = validateTurn(battle, submissionFor([{ unitId: mover.id, kind: 'Move', legs: [{ to: dest }] }]));
  if (!removed.ok) {
    throw new Error(`the draft without the colliding order was refused: ${removed.message}`);
  }
  const turnBefore = battle.turnNumber;
  const activeBefore = battle.activeSide;
  const committed = resolveTurn(battle, {
    type: 'commit',
    submission: submissionFor([{ unitId: mover.id, kind: 'Move', legs: [{ to: dest }] }]),
  });
  if (committed.turnNumber !== turnBefore + 1) {
    throw new Error(`expected turn ${turnBefore + 1} after commit, got turn ${committed.turnNumber}`);
  }
  if (committed.activeSide === activeBefore) {
    throw new Error('the commit did not pass the turn to the other side');
  }
  const placed = committed.units.find((unit) => unit.id === mover.id);
  if (placed.position.x !== dest.x || placed.position.y !== dest.y) {
    throw new Error(`the committed Move did not land on the draft destination: ${JSON.stringify(placed.position)}`);
  }
  logStep(
    'battle drafting: removing the colliding draft validates; commit advances the turn',
    'pass',
    `now turn ${committed.turnNumber}`,
  );
  await phaseBattleFullOrdersDrafting();
}

// Full-orders drafting through the engine: the same `validateTurn` calls the
// battle screen makes on every draft change. On open ground the active side
// drafts a Move, a Charge (direct and with an approach leg), and a Shoot, all
// accepted with their previews; a Reform accepted with its new-formation
// footprint; a Rally accepted for a Disordered unit; then every kind's
// rejection with the highlight its map marker reads; then the step-4 core —
// a Move, a Charge, and a deliberately colliding third order, the collision
// rejected inline with its highlight, the draft reordered so the culprit
// flips, the colliding order removed, and the surviving Move plus Charge
// committed — and finally a Withdraw for the engaged target on the next turn.
async function phaseBattleFullOrdersDrafting() {
  logStep('battle drafting (full orders): inspector lists every kind with candidates', 'running');
  const document = createScenario({ title: 'Full orders probe' });
  const [first, second] = document.sides;
  let counter = 1;
  const probeId = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
  const mk = (name, side, troopType, soldiers, files, li, rd, x, y, facing) => ({
    id: probeId(), name, side, troopType, soldiers, files,
    lateralInterval: li, rankDepth: rd, position: { x, y }, facing,
  });
  const mover1 = mk('Full mover one', first.id, 'hoplite', 100, 10, 1, 1, 400, 600, 180);
  const mover2 = mk('Full mover two', first.id, 'hoplite', 100, 10, 1, 1, 440, 600, 180);
  const charger = mk('Full charger', first.id, 'hoplite', 100, 10, 1, 1, 600, 600, 0);
  const archer = mk('Full archer', first.id, 'archer', 100, 14, 1.5, 1.5, 800, 600, 0);
  const reformer = mk('Full reformer', first.id, 'hoplite', 100, 10, 1, 1, 1000, 600, 0);
  const target = mk('Full target', second.id, 'hoplite', 100, 10, 1, 1, 600, 680, 180);
  const victim = mk('Full victim', second.id, 'hoplite', 100, 10, 1, 1, 800, 700, 180);
  const extra = mk('Full extra', second.id, 'hoplite', 100, 10, 1, 1, 400, 300, 0);
  document.units.push(mover1, mover2, charger, archer, reformer, target, victim, extra);
  if ((document.terrainFeatures || []).length !== 0) {
    throw new Error('the full-orders probe must stay on open ground');
  }
  if (validateScenario(document).length > 0) {
    throw new Error(`full-orders probe is invalid: ${validateScenario(document).join('; ')}`);
  }
  if (validatePlayability(document).length > 0) {
    throw new Error(
      `full-orders probe is unplayable: ${validatePlayability(document).map((problem) => problem.message).join('; ')}`,
    );
  }
  const controllers = { [first.id]: 'human', [second.id]: 'passive' };
  const battle = startBattle(document, { seed: 7, controllers });
  if (battle.activeSide !== first.id) {
    throw new Error(`seed 7 must start the first side, got "${battle.activeSide}"`);
  }
  const actions = availableActions(battle, battle.activeSide);
  const entryOf = (unit) => {
    const entry = actions.units.find((item) => item.unitId === unit.id);
    if (!entry) throw new Error(`availableActions is missing unit "${unit.id}"`);
    return entry;
  };
  for (const unit of [mover1, mover2, charger, archer, reformer]) {
    const entry = entryOf(unit);
    if (!entry.permitted.some((item) => item.kind === 'Move')) {
      throw new Error(`Move is not permitted for "${unit.name}"`);
    }
  }
  if (entryOf(archer).movementAllowanceM !== 110) {
    throw new Error(`expected a 110 m archer allowance, got ${entryOf(archer).movementAllowanceM}`);
  }
  const chargeHint = entryOf(charger).chargeCandidates.find((hint) => hint.targetId === target.id);
  if (!chargeHint || chargeHint.edge !== 'front') {
    throw new Error(`expected a front charge hint at the target, got: ${JSON.stringify(chargeHint)}`);
  }
  const shootHint = entryOf(archer).shootCandidates.find((hint) => hint.targetId === victim.id);
  if (!shootHint) {
    throw new Error('expected a shoot hint at the victim');
  }
  if (!entryOf(reformer).permitted.some((item) => item.kind === 'Reform')) {
    throw new Error('Reform is not permitted for the reformer');
  }
  logStep(
    'battle drafting (full orders): inspector lists every kind with candidates',
    'pass',
    'Move/Charge/Shoot/Reform · 90/110 m',
  );
  const sub = (orders) => ({
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
  });

  logStep('battle drafting (full orders): a Charge validates with a contact preview', 'running');
  const direct = validateTurn(battle, sub([{ unitId: charger.id, kind: 'Charge', targetId: target.id, edge: 'front', approach: [] }]));
  if (!direct.ok || !direct.verdicts[0]?.accepted) {
    throw new Error(`the direct Charge was refused: ${direct.message}`);
  }
  if (direct.verdicts[0].charge?.aspect !== 'front' || !Array.isArray(direct.verdicts[0].preview?.corners)) {
    throw new Error(`the accepted Charge carries no contact preview: ${JSON.stringify(direct.verdicts[0].charge)}`);
  }
  const approached = validateTurn(battle, sub([{ unitId: charger.id, kind: 'Charge', targetId: target.id, edge: 'front', approach: [{ to: { x: 600, y: 620 } }] }]));
  if (!approached.ok || !approached.verdicts[0]?.accepted) {
    throw new Error(`the Charge with an approach leg was refused: ${approached.message}`);
  }
  logStep(
    'battle drafting (full orders): a Charge validates with a contact preview',
    'pass',
    `front contact, ${direct.verdicts[0].charge.frontageM} m`,
  );

  logStep('battle drafting (full orders): a Shoot validates with its shot', 'running');
  const shot = validateTurn(battle, sub([{ unitId: archer.id, kind: 'Shoot', targetId: victim.id }]));
  if (!shot.ok || !shot.verdicts[0]?.accepted) {
    throw new Error(`the Shoot was refused: ${shot.message}`);
  }
  if (shot.verdicts[0].shoot?.distanceM !== 100) {
    throw new Error(`the accepted Shoot carries the wrong distance: ${JSON.stringify(shot.verdicts[0].shoot)}`);
  }
  logStep('battle drafting (full orders): a Shoot validates with its shot', 'pass', '100 m');

  logStep('battle drafting (full orders): a Reform validates with the new footprint', 'running');
  const reformed = validateTurn(battle, sub([{ unitId: reformer.id, kind: 'Reform', files: 8 }]));
  if (!reformed.ok || !reformed.verdicts[0]?.accepted) {
    throw new Error(`the Reform was refused: ${reformed.message}`);
  }
  if (reformed.verdicts[0].reform?.files !== 8 || !Array.isArray(reformed.verdicts[0].preview?.corners)) {
    throw new Error(`the accepted Reform carries no footprint preview: ${JSON.stringify(reformed.verdicts[0].reform)}`);
  }
  logStep('battle drafting (full orders): a Reform validates with the new footprint', 'pass', '8 files');

  logStep('battle drafting (full orders): a Rally validates for a Disordered unit', 'running');
  const disordered = JSON.parse(JSON.stringify(battle));
  disordered.units.find((unit) => unit.id === mover1.id).cohesion = 'Disordered';
  const rallied = validateTurn(disordered, sub([{ unitId: mover1.id, kind: 'Rally' }]));
  if (!rallied.ok || !rallied.verdicts[0]?.accepted) {
    throw new Error(`the Disordered Rally was refused: ${rallied.message}`);
  }
  if (rallied.verdicts[0].rally?.state !== 'Disordered') {
    throw new Error(`the accepted Rally carries no rally record: ${JSON.stringify(rallied.verdicts[0].rally)}`);
  }
  logStep('battle drafting (full orders): a Rally validates for a Disordered unit', 'pass', 'rallies from Disordered');

  logStep('battle drafting (full orders): every kind is rejected with its highlight', 'running');
  const rejectionCases = [
    {
      order: { unitId: charger.id, kind: 'Charge', targetId: target.id, edge: 'bogus', approach: [] },
      code: 'invalid_charge',
      highlight: (details) => details?.reason === 'bad-edge',
    },
    {
      order: { unitId: archer.id, kind: 'Shoot', targetId: extra.id },
      code: 'out_of_range',
      highlight: (details) => Number.isFinite(details?.distanceM) && Number.isFinite(details?.shortfallM),
    },
    {
      order: { unitId: archer.id, kind: 'Shoot', targetId: mover1.id },
      code: 'invalid_shoot',
      highlight: (details) => details?.reason === 'not-enemy',
    },
    {
      order: { unitId: reformer.id, kind: 'Reform', files: 0 },
      code: 'invalid_formation',
      highlight: (details) => details?.reason === 'bad-files',
    },
    {
      order: { unitId: reformer.id, kind: 'Reform', files: 8, lateralInterval: 99 },
      code: 'invalid_formation',
      highlight: (details) => details?.reason === 'spacing-out-of-range',
    },
    {
      order: { unitId: mover1.id, kind: 'Withdraw' },
      code: 'order_not_permitted',
      highlight: (details) => details?.reason === 'not-engaged',
    },
    {
      order: { unitId: mover1.id, kind: 'Rally' },
      code: 'order_not_permitted',
      highlight: (details) => details?.reason === 'not-disordered',
    },
  ];
  for (const { order, code, highlight } of rejectionCases) {
    const checked = validateTurn(battle, sub([order]));
    if (checked.ok) {
      throw new Error(`a ${order.kind} that must fail was accepted`);
    }
    const rejection = checked.verdicts[0]?.rejection;
    if (rejection?.code !== code) {
      throw new Error(`expected ${code} for ${order.kind}, got "${rejection?.code}"`);
    }
    if (!highlight(rejection.details)) {
      throw new Error(`the ${code} rejection carries no highlight: ${JSON.stringify(rejection.details)}`);
    }
  }
  logStep(
    'battle drafting (full orders): every kind is rejected with its highlight',
    'pass',
    `${rejectionCases.length} rejections`,
  );

  // Step 4 of the local battle gate (#39): a Move, a Charge, and a deliberately
  // colliding order; the collision is rejected inline with its highlight, the
  // draft is reordered so the culprit flips, and the surviving orders commit.
  logStep('battle drafting (full orders): Move, Charge, and a colliding order', 'running');
  const dest = { x: 400, y: 560 };
  const triple = validateTurn(battle, sub([
    { unitId: mover1.id, kind: 'Move', legs: [{ to: dest }] },
    { unitId: charger.id, kind: 'Charge', targetId: target.id, edge: 'front', approach: [] },
    { unitId: mover2.id, kind: 'Move', legs: [{ to: dest }] },
  ]));
  if (triple.ok) {
    throw new Error('a Move, a Charge, and a colliding Move were all accepted');
  }
  if (triple.verdicts[0]?.accepted !== true || triple.verdicts[1]?.accepted !== true) {
    throw new Error('the Move and the Charge should stay accepted while the third order collides');
  }
  const collision = triple.verdicts[2]?.rejection;
  if (collision?.code !== 'collision') {
    throw new Error(`expected a collision rejection, got "${collision?.code}"`);
  }
  if (collision.details?.withUnitId !== mover1.id) {
    throw new Error(`the collision names the wrong unit: ${JSON.stringify(collision.details)}`);
  }
  if (!Number.isFinite(collision.details?.at?.x) || !Number.isFinite(collision.details?.at?.y)) {
    throw new Error(`the collision carries no highlight point: ${JSON.stringify(collision.details)}`);
  }
  logStep(
    'battle drafting (full orders): Move, Charge, and a colliding order',
    'pass',
    collision.message,
  );

  logStep('battle drafting (full orders): reordering flips the culprit', 'running');
  const swapped = validateTurn(battle, sub([
    { unitId: mover2.id, kind: 'Move', legs: [{ to: dest }] },
    { unitId: charger.id, kind: 'Charge', targetId: target.id, edge: 'front', approach: [] },
    { unitId: mover1.id, kind: 'Move', legs: [{ to: dest }] },
  ]));
  if (swapped.ok || swapped.verdicts[2]?.rejection?.code !== 'collision') {
    throw new Error('the reordered draft should still reject the third order with a collision');
  }
  if (swapped.verdicts[2].rejection.details?.withUnitId !== mover2.id) {
    throw new Error(`reordering did not flip the culprit: ${JSON.stringify(swapped.verdicts[2].rejection.details)}`);
  }
  logStep('battle drafting (full orders): reordering flips the culprit', 'pass', 'culprit flipped');

  logStep('battle drafting (full orders): commit the Move and the Charge', 'running');
  const committed = resolveTurn(battle, {
    type: 'commit',
    submission: sub([
      { unitId: mover1.id, kind: 'Move', legs: [{ to: dest }] },
      { unitId: charger.id, kind: 'Charge', targetId: target.id, edge: 'front', approach: [] },
    ]),
  });
  if (committed.turnNumber !== battle.turnNumber + 1) {
    throw new Error(`expected turn ${battle.turnNumber + 1} after commit, got turn ${committed.turnNumber}`);
  }
  const landed = committed.units.find((unit) => unit.id === charger.id);
  if (landed.position.x !== 600 || landed.position.y !== 680 || !landed.engaged) {
    throw new Error(`the committed Charge did not land in contact: ${JSON.stringify(landed.position)}`);
  }
  logStep('battle drafting (full orders): commit the Move and the Charge', 'pass', `now turn ${committed.turnNumber}`);

  logStep('battle drafting (full orders): the engaged target withdraws next turn', 'running');
  const nextSub = (orders) => ({
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: committed.id,
    turnNumber: committed.turnNumber,
    side: committed.activeSide,
    orders,
  });
  const withdrawal = validateTurn(committed, nextSub([{ unitId: target.id, kind: 'Withdraw' }]));
  if (!withdrawal.ok || !withdrawal.verdicts[0]?.accepted) {
    throw new Error(`the Withdraw was refused: ${withdrawal.message}`);
  }
  if (!Number.isFinite(withdrawal.verdicts[0].withdraw?.distanceM)
    || !Array.isArray(withdrawal.verdicts[0].preview?.corners)) {
    throw new Error(`the accepted Withdraw carries no step-back preview: ${JSON.stringify(withdrawal.verdicts[0].withdraw)}`);
  }
  const withdrawn = resolveTurn(committed, {
    type: 'commit',
    submission: nextSub([{ unitId: target.id, kind: 'Withdraw' }]),
  });
  if (withdrawn.turnNumber !== committed.turnNumber + 1) {
    throw new Error('the Withdraw commit did not advance the turn');
  }
  if (withdrawn.units.find((unit) => unit.id === target.id)?.engaged) {
    throw new Error('the withdrawn unit is still engaged');
  }
  logStep('battle drafting (full orders): the engaged target withdraws next turn', 'pass', `now turn ${withdrawn.turnNumber}`);
}

// Resolve one Human vs Passive turn for the persistence probe: a human side
// commits an empty turn through the engine, an automated side resolves through
// the runner. Shared by the pre- and post-reload phases so both sides of the
// reload exercise the same commit path.
async function resolveOneProbeTurn(battle, sides, context) {
  const active = battle.activeSide;
  if (battle.controllers[active] === 'human') {
    const submission = {
      formatVersion: SUBMISSION_FORMAT_VERSION,
      battleId: battle.id,
      turnNumber: battle.turnNumber,
      side: active,
      orders: [],
    };
    const checked = validateTurn(battle, submission);
    if (!checked.ok) {
      throw new Error(`the ${context} human commit was refused: ${checked.message}`);
    }
    const decision = { type: 'commit', submission };
    return { battle: resolveTurn(battle, decision), decision };
  }
  const players = {};
  for (const side of sides) {
    players[side.id] = createPassivePlayer();
  }
  const step = await runTurn(battle, players);
  return { battle: step.battle, decision: step.decision };
}

// Battle persistence across a real reload: start a Human vs Passive battle from
// the reopened scenario, resolve one turn, save it to the separate battles
// collection, stash the stored record, and reload. After the reload a fresh
// store instance loads the battle and must see the identical state; resolving
// another turn proves the resumed battle still plays. The battle keeps its own
// scenario snapshot, so later scenario edits never change it.
async function phaseBattlePersistence(scenario) {
  logStep('battle persistence: start a battle and resolve one turn', 'running');
  const battleStore = new IndexedDBBattleStore({ dbName: BATTLE_DB_NAME });
  await battleStore.clear();
  const battleScenario = cloneScenario(scenario);
  const [first, second] = battleScenario.sides;
  let counter = 1;
  const probeId = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
  battleScenario.units.push(
    {
      id: probeId(),
      name: 'Persist taxis',
      side: first.id,
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 500, y: 600 },
      facing: 180,
    },
    {
      id: probeId(),
      name: 'Persist mora',
      side: second.id,
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 500, y: 300 },
      facing: 0,
    },
  );
  if (validateScenario(battleScenario).length > 0) {
    throw new Error(`persistence battle scenario is invalid: ${validateScenario(battleScenario).join('; ')}`);
  }
  const controllers = { [first.id]: 'human', [second.id]: 'passive' };
  const started = startBattle(battleScenario, { seed: 20260714, controllers, battleId: 'e2e-battle-probe' });
  const resolved = await resolveOneProbeTurn(started, battleScenario.sides, 'persistence');
  const battle = resolved.battle;
  const decisions = [resolved.decision];
  await battleStore.save(battle, decisions);
  const snapshot = await battleStore.load(battle.id);
  if (!snapshot) throw new Error('the saved battle cannot be loaded back');
  logStep(
    'battle persistence: start a battle and resolve one turn',
    'pass',
    `turn ${battle.turnNumber} saved (rev. 1)`,
  );
  sessionStorage.setItem(PHASE_KEY, JSON.stringify({ phase: 'battle-resume', battleId: battle.id, snapshot }));
  logStep('battle persistence: reload mid-battle', 'running', 'reloading…');
  battleStore.close();
  location.reload();
}

async function phaseBattleResume(phase) {
  const battleStore = new IndexedDBBattleStore({ dbName: BATTLE_DB_NAME });
  logStep('battle persistence: reload mid-battle', 'pass', 'done');
  logStep('battle resume: load the identical battle after reload', 'running');
  const reloaded = await battleStore.load(phase.battleId);
  if (!reloaded) throw new Error('the saved battle is missing after reload');
  assertSameBattle(phase.snapshot, reloaded);
  logStep('battle resume: load the identical battle after reload', 'pass', `turn ${reloaded.battle.turnNumber}`);
  logStep('battle resume: resolve another turn from the resumed state', 'running');
  const decisions = [...reloaded.decisions];
  const resolved = await resolveOneProbeTurn(reloaded.battle, reloaded.battle.scenario.sides, 'resumed');
  const battle = resolved.battle;
  decisions.push(resolved.decision);
  if (battle.turnNumber !== reloaded.battle.turnNumber + 1) {
    throw new Error('the resumed battle did not advance one turn');
  }
  await battleStore.save(battle, decisions);
  const reread = await battleStore.load(phase.battleId);
  assertSameBattle({ battle, decisions }, reread);
  battleStore.close();
  logStep('battle resume: resolve another turn from the resumed state', 'pass', `now turn ${battle.turnNumber}`);
  sessionStorage.removeItem(PHASE_KEY);
}

async function run() {
  steps.innerHTML = '';
  verdict.textContent = '';
  verdict.className = '';
  details.textContent = '';
  try {
    const prePhase = readPhase();
    if (prePhase?.phase === 'battle-resume') {
      await phaseBattleResume(prePhase);
      return;
    }
    const phase = readPhase();
    if (phase?.phase === 'reopen') {
      await phaseReopen(phase);
      return;
    }
    const drafted = await phaseSetup();
    const finished = await phaseUnitPlacement(drafted);
    await phaseSaveAndReload(finished);
  } catch (error) {
    fail('end-to-end run failed', error);
  }
}

document.querySelector('#run').addEventListener('click', run);

// Continue automatically after the mid-run reload, or when autostarted.
if (readPhase()?.phase === 'battle-resume' || readPhase()?.phase === 'reopen') {
  run();
} else if (new URLSearchParams(location.search).get(AUTOSTART_PARAM) === '1') {
  run();
}
