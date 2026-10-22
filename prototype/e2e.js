// PÓLIS tracer bullet — browser end-to-end test.
//
// Covers unit placement plus create → save → reload → reopen against the real
// IndexedDB scenario store (its own test database, so the author's library is
// untouched):
//   phase "units":  editor acceptance steps 5–7 (six units, a spacing preset,
//                   a rotation to 30°, a refused overlapping drop, accepted
//                   edge-to-edge touching, and a refused battlefield shrink);
//   phase "save":   create a scenario, draw ground cover areas (acceptance
//                   step 2: forest, rough ground, settlement; an overlapping
//                   area is refused with a highlight ring), save it, verify it
//                   is listed, snapshot the stored document, then reload;
//   phase "reopen": with a fresh store instance, list the library, reopen
//                   the scenario by id, and assert every value is identical.
// Progress survives the reload in sessionStorage. Results are rendered into
// the page and logged to the console for headless collection.
import { deriveFootprint } from './domain/geometry.js';
import {
  addElevationFeature,
  addGroundCoverFeature,
  cloneScenario,
  createScenario,
  exportScenario,
  importScenarioDocument,
  normalizeFacing,
  pickUnitIdAtPoint,
  proposeUnitPatch,
  resizeBattlefield,
  roundScenarioToTenth,
  snapFacing,
  unitsBlockingResize,
  validateElevationCandidate,
  validateGroundCoverCandidate,
  validateScenario,
} from './domain/scenario.js';
import { collectUnknownTroopTypeWarnings } from './domain/polis-classical.js';
import { BattleStartError, startBattle, validatePlayability } from './domain/battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
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
async function phaseUnitPlacement() {
  logStep('acceptance step 5: build "Acceptance plain" at 1400 x 900 m', 'running');
  const document = createScenario({
    title: 'Acceptance plain',
    battlefield: { width: 1400, height: 900 },
    description: 'Editor acceptance probe: steps 5-7.',
  });
  if (document.battlefield.width !== 1400 || document.battlefield.height !== 900) {
    throw new Error('battlefield size was not kept');
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
  // A shrink that keeps every footprint still succeeds.
  resizeBattlefield(document, 1400, 700);
  logStep('acceptance step 7: shrinking past a unit is refused', 'pass', shrinkError);
}

async function phaseSave() {
  const store = new IndexedDBScenarioStore({ dbName: DB_NAME });
  logStep('clear the end-to-end test database', 'running');
  await store.clear();
  logStep('clear the end-to-end test database', 'pass');

  const title = `E2E probe ${new Date().toISOString()}`;
  logStep('create a new scenario with a required title', 'running');
  let created = createScenario({ title });
  if (!created.id || created.title !== title) throw new Error('created scenario is incomplete');
  if (created.sides.length !== 2) throw new Error('expected two default sides');
  logStep('create a new scenario with a required title', 'pass', title);

  logStep('set the battlefield to 1400 × 900 m', 'running');
  created = resizeBattlefield(created, ACCEPTANCE_BATTLEFIELD.width, ACCEPTANCE_BATTLEFIELD.height);
  logStep('set the battlefield to 1400 × 900 m', 'pass');

  logStep('draw forest, rough ground, and a settlement', 'running');
  for (const ground of ACCEPTANCE_GROUNDS) {
    created = addGroundCoverFeature(created, ground);
  }
  const grounds = created.terrainFeatures.filter((feature) => feature.kind === 'ground');
  if (grounds.length !== 3) throw new Error(`expected 3 ground cover areas, got ${grounds.length}`);
  if (validateScenario(created).length > 0) {
    throw new Error(`drawn areas are invalid: ${validateScenario(created).join('; ')}`);
  }
  logStep('draw forest, rough ground, and a settlement', 'pass', '3 areas');

  logStep('refuse an area overlapping the forest with a highlight', 'running');
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
  logStep('refuse an area overlapping the forest with a highlight', 'pass', overlapping.reason);

  logStep('clip an area reaching past the edge to the battlefield', 'running');
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
  logStep('clip an area reaching past the edge to the battlefield', 'pass');

  logStep('draw a hill with two nested levels (levels 1 and 2 derived)', 'running');
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
  logStep('draw a hill with two nested levels (levels 1 and 2 derived)', 'pass', 'levels 1, 2');

  logStep('refuse a hill crossing a sibling with a highlight', 'running');
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
  logStep('refuse a hill crossing a sibling with a highlight', 'pass', crossingHill.reason);

  logStep('save it through the scenario store', 'running');
  const metadata = await store.save(created);
  const snapshot = await store.load(created.id);
  if (!snapshot) throw new Error('saved scenario cannot be loaded back');
  logStep('save it through the scenario store', 'pass', `rev. ${metadata.revision}`);

  logStep('list the scenario in the library', 'running');
  const listed = await store.list();
  if (!listed.some((entry) => entry.id === created.id && entry.title === title)) {
    throw new Error('saved scenario is missing from the library');
  }
  logStep('list the scenario in the library', 'pass', `${listed.length} in library`);

  sessionStorage.setItem(PHASE_KEY, JSON.stringify({ phase: 'reopen', id: created.id, snapshot }));
  logStep('reload the browser', 'running', 'reloading…');
  store.close();
  location.reload();
}

async function phaseReopen(phase) {
  // Fresh store instance, as after a real reload: nothing is reused.
  const store = new IndexedDBScenarioStore({ dbName: DB_NAME });
  logStep('create a new scenario with a required title', 'pass', '(before reload)');
  logStep('save it through the scenario store', 'pass', '(before reload)');
  logStep('list the scenario in the library', 'pass', '(before reload)');
  logStep('reload the browser', 'pass', 'done');

  logStep('list the scenario library after reload', 'running');
  const listed = await store.list();
  const entry = listed.find((item) => item.id === phase.id);
  if (!entry) throw new Error('scenario missing from the library after reload');
  logStep('list the scenario library after reload', 'pass', `${listed.length} in library`);

  logStep('reopen the scenario with identical values', 'running');
  const reopened = await store.load(phase.id);
  if (!reopened) throw new Error('scenario cannot be reopened after reload');
  assertSameDocument(phase.snapshot, reopened);
  logStep('reopen the scenario with identical values', 'pass', reopened.title);

  logStep('keep the drawn ground cover identical and valid', 'running');
  const grounds = (reopened.terrainFeatures || []).filter((feature) => feature.kind === 'ground');
  if (grounds.length !== 4) throw new Error(`expected 4 ground cover areas, got ${grounds.length}`);
  if (validateScenario(reopened).length > 0) {
    throw new Error(`reopened terrain is invalid: ${validateScenario(reopened).join('; ')}`);
  }
  logStep('keep the drawn ground cover identical and valid', 'pass', '4 areas');

  logStep('keep the nested hills identical with derived levels', 'running');
  const reopenedHills = (reopened.terrainFeatures || []).filter((feature) => feature.kind === 'elevation');
  if (reopenedHills.length !== 2) throw new Error(`expected 2 hills, got ${reopenedHills.length}`);
  if (reopenedHills[0].level !== 1 || reopenedHills[1].level !== 2) {
    throw new Error(`hill levels changed across reload: ${reopenedHills.map((hill) => hill.level).join(', ')}`);
  }
  logStep('keep the nested hills identical with derived levels', 'pass', 'levels 1, 2');

  await phasePersistenceStep6(store);

  await phaseBattleTurns();

  store.close();
  await phaseBattlePersistence(reopened, entry);
}

// Persistence acceptance step 6 (#5): a file carrying a unit whose
// troop-type key is unknown to the catalogue. It opens (validates), the unit
// is marked (the warning helper names it, which is what the editor's issues
// panel shows), it saves, and the key is preserved verbatim after reopening.
async function phasePersistenceStep6(store) {
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
    await phaseUnitPlacement();
    const phase = readPhase();
    if (phase?.phase === 'reopen') {
      await phaseReopen(phase);
    } else {
      await phaseSave();
    }
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
