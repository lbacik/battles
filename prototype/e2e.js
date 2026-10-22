// PÓLIS tracer bullet — browser end-to-end test.
//
// Covers create → save → reload → reopen against the real IndexedDB scenario
// store (its own test database, so the author's library is untouched):
//   phase "save":   create a scenario, save it, verify it is listed,
//                   snapshot the stored document, then reload the page;
//   phase "reopen": with a fresh store instance, list the library, reopen
//                   the scenario by id, and assert every value is identical.
// Progress survives the reload in sessionStorage. Results are rendered into
// the page and logged to the console for headless collection.
import { createScenario } from './domain/scenario.js';
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

async function phaseSave() {
  const store = new IndexedDBScenarioStore({ dbName: DB_NAME });
  logStep('clear the end-to-end test database', 'running');
  await store.clear();
  logStep('clear the end-to-end test database', 'pass');

  const title = `E2E probe ${new Date().toISOString()}`;
  logStep('create a new scenario with a required title', 'running');
  const created = createScenario({ title });
  if (!created.id || created.title !== title) throw new Error('created scenario is incomplete');
  if (created.sides.length !== 2) throw new Error('expected two default sides');
  logStep('create a new scenario with a required title', 'pass', title);

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
