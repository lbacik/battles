// PÓLIS tracer bullet — browser end-to-end test.
//
// Covers create → save → reload → reopen against the real IndexedDB scenario
// store (its own test database, so the author's library is untouched):
//   phase "save":   create a scenario, draw ground cover areas (acceptance
//                   step 2: forest, rough ground, settlement; an overlapping
//                   area is refused with a highlight ring), save it, verify it
//                   is listed, snapshot the stored document, then reload;
//   phase "reopen": with a fresh store instance, list the library, reopen
//                   the scenario by id, and assert every value is identical.
// Progress survives the reload in sessionStorage. Results are rendered into
// the page and logged to the console for headless collection.
import {
  addGroundCoverFeature,
  createScenario,
  resizeBattlefield,
  validateGroundCoverCandidate,
  validateScenario,
} from './domain/scenario.js';
import { IndexedDBScenarioStore } from './library/idb.js';

const DB_NAME = 'polis-scenarios-e2e';
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

  details.textContent = JSON.stringify(
    {
      document: reopened,
      metadata: { id: entry.id, title: entry.title, revision: entry.revision },
    },
    null,
    2,
  );
  verdict.textContent = 'PASS';
  verdict.className = 'pass';
  sessionStorage.removeItem(PHASE_KEY);
  store.close();
  console.info('[e2e] PASS');
}

async function run() {
  steps.innerHTML = '';
  verdict.textContent = '';
  verdict.className = '';
  details.textContent = '';
  try {
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
if (readPhase()?.phase === 'reopen') {
  run();
} else if (new URLSearchParams(location.search).get(AUTOSTART_PARAM) === '1') {
  run();
}
