// PÓLIS tracer bullet — scenario library and battlefield editor.
//
// Structure follows prototype layout A: order of battle on the left, the map
// in the centre, the inspector on the right. The visual style is not decided.
// The editor talks to browser storage only through the narrow scenario store
// interface (ADR 0003); the domain model stays framework-free.
import {
  MAX_BATTLEFIELD_HEIGHT_M,
  MAX_BATTLEFIELD_WIDTH_M,
  createScenario,
  deriveFootprint,
  exportScenario,
  importScenarioDocument,
  toScreenPoint,
  validateScenario,
} from './domain/scenario.js';
import { getTroopType } from './domain/polis-classical.js';
import { IndexedDBScenarioStore, ensurePersistentStorage } from './library/idb.js';

const NARROW_NOTICE_WIDTH = 1280;

const state = {
  store: new IndexedDBScenarioStore(),
  library: [],
  view: 'library',
  document: null,
  revision: null,
  status: '',
  statusError: false,
  problems: [],
  persistent: null,
  newTitle: '',
};

const $ = (selector, root = document) => root.querySelector(selector);

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

const metres = (value) => `${Number(value).toLocaleString('en')} m`;

let toastTimer;
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3200);
}

function setStatus(message, isError = false) {
  state.status = message;
  state.statusError = isError;
  const element = $('.status');
  if (element) {
    element.textContent = message;
    element.classList.toggle('error', isError);
  }
}

// --- Map rendering (ADR 0001) -------------------------------------------
// The model uses map coordinates (origin south-west, x east, y north,
// metres). Only rendering flips the vertical axis for the screen, through
// toScreenPoint: screenY = battlefieldHeight - mapY. Terrain outlines and
// unit footprints are drawn at true scale from the stored vertices: rendering
// never moves outlines (no smoothing, no enlarged symbols).
const GROUND_STYLES = {
  forest: { fill: '#9db38f', stroke: '#7a8f6d' },
  rough: { fill: '#d8d2b8', stroke: '#a89f83' },
  water: { fill: '#aecfd0', stroke: '#7fa8a9' },
  settlement: { fill: '#ddcfae', stroke: '#a08c66' },
};

const LINEAR_STYLES = {
  river: '#7fb3c8',
  road: '#c9b98f',
};

function sideColor(document, sideId) {
  const side = (document.sides || []).find((entry) => entry.id === sideId);
  return side && side.color ? side.color : '#666666';
}

function troopDisplayName(troopType) {
  return getTroopType(troopType)?.displayName || troopType;
}

function battlefieldSvg(document) {
  const { width: widthM, height: heightM } = document.battlefield;
  const toScreen = (x, y) => toScreenPoint({ x, y }, heightM);
  const padLeft = 70;
  const pad = 60;
  const viewBox = `${-padLeft} ${-pad} ${widthM + padLeft + pad} ${heightM + pad * 2}`;

  let grid = '';
  for (let x = 0; x <= widthM; x += 100) {
    const major = x % 500 === 0;
    grid += `<line x1="${x}" y1="0" x2="${x}" y2="${heightM}" stroke="#7d8a76" stroke-width="${major ? 1 : 0.5}" opacity="${major ? 0.35 : 0.18}"/>`;
  }
  for (let y = 0; y <= heightM; y += 100) {
    const major = y % 500 === 0;
    const screenY = heightM - y;
    grid += `<line x1="0" y1="${screenY}" x2="${widthM}" y2="${screenY}" stroke="#7d8a76" stroke-width="${major ? 1 : 0.5}" opacity="${major ? 0.35 : 0.18}"/>`;
  }
  let xLabels = '';
  for (let x = 0; x <= widthM; x += 200) {
    xLabels += `<text x="${x}" y="${heightM + 22}" text-anchor="middle" font-size="13" fill="#8a947c">${x}</text>`;
  }
  let yLabels = '';
  for (let y = 0; y <= heightM; y += 200) {
    yLabels += `<text x="-12" y="${heightM - y + 4}" text-anchor="end" font-size="13" fill="#8a947c">${y}</text>`;
  }
  const origin = toScreen(0, 0);
  const centre = toScreen(widthM / 2, heightM / 2);
  const project = (points) =>
    points
      .map((point) => {
        const screen = toScreen(point.x, point.y);
        return `${screen.x},${screen.y}`;
      })
      .join(' ');

  const terrain = (document.terrainFeatures || [])
    .map((feature) => {
      if (feature.kind === 'ground') {
        const style = GROUND_STYLES[feature.category] || { fill: '#cccccc', stroke: '#999999' };
        return `<polygon points="${project(feature.polygon)}" fill="${style.fill}" fill-opacity="0.7" stroke="${style.stroke}" stroke-width="1.5"><title>${esc(feature.category)}</title></polygon>`;
      }
      if (feature.kind === 'elevation') {
        const middle = toScreen(
          feature.polygon.reduce((sum, point) => sum + point.x, 0) / feature.polygon.length,
          feature.polygon.reduce((sum, point) => sum + point.y, 0) / feature.polygon.length,
        );
        return `<g><polygon points="${project(feature.polygon)}" fill="#c6c8a4" fill-opacity="0.25" stroke="#8a7a5c" stroke-width="1.5" stroke-dasharray="7 4"/><text x="${middle.x}" y="${middle.y}" text-anchor="middle" font-size="13" fill="#6b6247">L${esc(feature.level)}</text></g>`;
      }
      if (feature.kind === 'linear') {
        const color = LINEAR_STYLES[feature.category] || '#888888';
        return `<polyline points="${project(feature.path)}" fill="none" stroke="${color}" stroke-width="${feature.width}" stroke-linecap="round" stroke-linejoin="round"><title>${esc(feature.category)} · ${esc(feature.width)} m</title></polyline>`;
      }
      return '';
    })
    .join('');

  const units = (document.units || [])
    .map((unit) => {
      const color = sideColor(document, unit.side);
      const footprint = deriveFootprint(unit);
      const [frontLeft, frontRight] = footprint.corners.map((corner) =>
        toScreen(corner.x, corner.y),
      );
      const middle = toScreen(
        footprint.corners.reduce((sum, corner) => sum + corner.x, 0) / 4,
        footprint.corners.reduce((sum, corner) => sum + corner.y, 0) / 4,
      );
      return `<g><polygon points="${project(footprint.corners)}" fill="${esc(color)}" fill-opacity="0.45" stroke="${esc(color)}" stroke-width="1.5"><title>${esc(unit.name)} · ${esc(troopDisplayName(unit.troopType))} · ${esc(unit.soldiers)} soldiers</title></polygon><line x1="${frontLeft.x}" y1="${frontLeft.y}" x2="${frontRight.x}" y2="${frontRight.y}" stroke="${esc(color)}" stroke-width="3.5"/><text x="${middle.x}" y="${middle.y}" text-anchor="middle" font-size="14" fill="#303a32" paint-order="stroke" stroke="#f4f3e9" stroke-width="3">${esc(unit.name)}</text></g>`;
    })
    .join('');

  const empty =
    (document.units || []).length === 0 && (document.terrainFeatures || []).length === 0;

  return `<svg viewBox="${viewBox}" role="img" aria-label="Battlefield, ${widthM} by ${heightM} metres, origin south-west">
    <rect x="${-padLeft}" y="${-pad}" width="${widthM + padLeft + pad}" height="${heightM + pad * 2}" fill="#dfddce"/>
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="#e8e5d5"/>
    ${grid}
    ${terrain}
    ${units}
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="none" stroke="#6f7a65" stroke-width="2"/>
    ${xLabels}${yLabels}
    <circle cx="${origin.x}" cy="${origin.y}" r="5" fill="#4e6047"/>
    <text x="${origin.x + 10}" y="${origin.y - 10}" font-size="13" fill="#4e6047">origin (0, 0) · SW</text>
    ${empty ? `<text x="${centre.x}" y="${centre.y}" text-anchor="middle" font-size="17" fill="#9aa08b">Empty battlefield — no units yet</text>` : ''}
    <g>
      <line x1="60" y1="${heightM - 34}" x2="260" y2="${heightM - 34}" stroke="#6f7a65" stroke-width="3"/>
      <line x1="60" y1="${heightM - 40}" x2="60" y2="${heightM - 28}" stroke="#6f7a65" stroke-width="2"/>
      <line x1="260" y1="${heightM - 40}" x2="260" y2="${heightM - 28}" stroke="#6f7a65" stroke-width="2"/>
      <text x="160" y="${heightM - 44}" text-anchor="middle" font-size="13" fill="#6f7a65">200 m</text>
    </g>
    <g>
      <text x="${widthM - 14}" y="30" text-anchor="end" font-size="15" fill="#6f7a65">N ↑</text>
    </g>
  </svg>`;
}

// --- Views ---------------------------------------------------------------
function libraryView() {
  const items = state.library
    .map(
      (entry) => `<li>
        <div><div class="title">${esc(entry.title)}</div>
        <div class="meta">revision ${entry.revision} · updated ${esc(entry.updatedAt)}</div></div>
        <div class="actions">
          <button class="btn-secondary" data-action="open" data-id="${esc(entry.id)}">Open</button>
          <button class="btn-secondary" data-action="export" data-id="${esc(entry.id)}">Export</button>
          <button class="btn-quiet btn-danger" data-action="delete" data-id="${esc(entry.id)}">Delete</button>
        </div>
      </li>`,
    )
    .join('');
  return `<div class="library">
    <span class="eyebrow">PÓLIS · SCENARIO LIBRARY</span>
    <h1>Scenarios</h1>
    <p class="lede">Create a scenario, open its battlefield in the editor,
      save it, and reopen it after a reload. Export a scenario to a JSON file
      to move or back it up; importing a file always adds a new copy. Stored in this browser.</p>
    <form id="new-form" class="new-scenario">
      <input name="title" placeholder="New scenario title (required)" value="${esc(state.newTitle)}" maxlength="120" aria-label="New scenario title">
      <button type="submit" class="btn-primary" ${state.newTitle.trim() ? '' : 'disabled'}>New scenario</button>
      <label class="btn-secondary import-label" for="import-file">Import JSON</label>
      <input type="file" id="import-file" accept=".json,application/json" hidden>
    </form>
    ${state.library.length ? `<ul class="scenario-list">${items}</ul>` : '<div class="empty-library">No scenarios yet. Give the new scenario a title above to create the first one, or import an exported JSON file.</div>'}
    <p class="storage-note">${state.persistent === false ? 'Browser persistent storage was refused: scenarios may be evicted, so export is the only backup. ' : ''}Library lives in IndexedDB on this device; clearing site data removes it.</p>
  </div>`;
}

function orderOfBattleView(document) {
  const unitsOf = (sideId) => (document.units || []).filter((unit) => unit.side === sideId);
  return `<div class="panel"><span class="eyebrow">FORCES IN THE FIELD</span><h2>Order of battle</h2>
    ${document.sides
      .map((side) => {
        const sideUnits = unitsOf(side.id);
        const soldiers = sideUnits.reduce((sum, unit) => sum + unit.soldiers, 0);
        return `<div class="side">
          <div class="side-name"><span class="swatch" style="background:${esc(side.color)}"></span>${esc(side.name)}</div>
          <p class="side-count">${sideUnits.length} ${sideUnits.length === 1 ? 'unit' : 'units'} · ${soldiers.toLocaleString('en')} soldiers</p>
          ${sideUnits
            .map((unit) => {
              const footprint = deriveFootprint(unit);
              return `<div class="unit-row"><span class="swatch" style="background:${esc(side.color)}"></span><div><div class="unit-name">${esc(unit.name)}</div><div class="unit-detail">${esc(troopDisplayName(unit.troopType))} · ${esc(unit.soldiers)} soldiers · ${esc(unit.files)} files × ${footprint.ranks} ranks</div></div></div>`;
            })
            .join('')}
        </div>`;
      })
      .join('')}
    <p class="readonly-note">Positions, terrain, and forces are read-only in this release: import a scenario file to see them drawn at true scale.</p>
  </div>`;
}

function inspectorView(document) {
  const size = document.battlefield;
  return `<div class="panel"><span class="eyebrow">SCENARIO INSPECTOR</span><h2>Scenario</h2>
    ${state.problems.length ? `<p class="validation">${state.problems.map(esc).join('<br>')}</p>` : ''}
    <dl>
      <div class="kv"><dt>Identifier</dt><dd class="mono">${esc(document.id)}</dd></div>
      <div class="kv"><dt>Format</dt><dd>${esc(document.kind)} · v${esc(document.formatVersion)}</dd></div>
      <div class="kv"><dt>Ruleset</dt><dd class="mono">${esc(document.ruleset.id)} ${esc(document.ruleset.version)}</dd></div>
      <div class="kv"><dt>Revision</dt><dd>${state.revision === null ? 'unsaved' : `rev. ${state.revision}`}</dd></div>
      <div class="kv"><dt>Updated</dt><dd>${esc(document.updatedAt)}</dd></div>
    </dl>
    <div class="field-pair">
      <label class="field">Width (m)<input type="number" data-field="width" min="1" max="${MAX_BATTLEFIELD_WIDTH_M}" value="${esc(size.width)}"></label>
      <label class="field">Height (m)<input type="number" data-field="height" min="1" max="${MAX_BATTLEFIELD_HEIGHT_M}" value="${esc(size.height)}"></label>
    </div>
    <label class="field">Description<textarea data-field="description" rows="3" maxlength="2000" placeholder="Optional plain-text description">${esc(document.description || '')}</textarea></label>
    <div class="kv"><dt>Forces</dt><dd>${(document.units || []).length} units</dd></div>
    <div class="kv"><dt>Terrain</dt><dd>${terrainSummary(document)}</dd></div>
    ${document.sides
      .map(
        (side, index) => `<div class="field-pair">
        <label class="field">Side ${index + 1} name<input data-field="side-name" data-index="${index}" value="${esc(side.name)}" maxlength="60"></label>
        <label class="field">Colour<input type="color" data-field="side-color" data-index="${index}" value="${esc(side.color)}"></label>
      </div>`,
      )
      .join('')}
  </div>`;
}

function terrainSummary(document) {
  const features = document.terrainFeatures || [];
  if (features.length === 0) {
    return 'open ground';
  }
  const counts = new Map();
  for (const feature of features) {
    const key =
      feature.kind === 'elevation'
        ? `level ${feature.level}`
        : String(feature.category || feature.kind);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts].map(([key, count]) => `${key} ${count}`).join(' · ');
}

function editorView() {
  const document = state.document;
  const { width, height } = document.battlefield;
  return `<div class="editor-head">
      <button class="btn-quiet" data-action="back">← Library</button>
      <input data-field="title" value="${esc(document.title)}" maxlength="120" aria-label="Scenario title">
      <span class="spacer"></span>
      <span class="status${state.statusError ? ' error' : ''}">${esc(state.status)}</span>
      <button class="btn-secondary" data-action="export">Export</button>
      <button class="btn-primary" data-action="save">Save</button>
    </div>
    <main class="workspace">
      <aside class="left-panel">${orderOfBattleView(document)}</aside>
      <section class="map-panel">
        <div class="map-caption">${metres(width)} × ${metres(height)} · origin south-west · metres · true scale</div>
        ${battlefieldSvg(document)}
      </section>
      <aside class="right-panel">${inspectorView(document)}</aside>
    </main>`;
}

function render() {
  $('#app').innerHTML = state.view === 'editor' ? editorView() : libraryView();
  if (state.view === 'library') {
    const input = $('input[name="title"]');
    input?.addEventListener('input', () => {
      state.newTitle = input.value;
      const button = $('#new-form button[type="submit"]');
      if (button) button.disabled = !input.value.trim();
    });
  }
}

// --- Actions --------------------------------------------------------------
async function refreshLibrary() {
  state.library = await state.store.list();
}

async function openScenario(id) {
  const document = await state.store.load(id);
  if (!document) {
    toast('Scenario not found. It may have been deleted.');
    await refreshLibrary();
    render();
    return;
  }
  const entry = (await state.store.list()).find((item) => item.id === id);
  state.document = document;
  state.revision = entry ? entry.revision : null;
  state.problems = [];
  state.view = 'editor';
  setStatusAfterRender(`Opened · rev. ${state.revision}`);
  render();
  setStatus(`Opened · rev. ${state.revision}`);
}

function setStatusAfterRender(message) {
  state.status = message;
  state.statusError = false;
}

async function saveScenario() {
  state.problems = validateScenario(state.document);
  if (state.problems.length) {
    state.status = 'Cannot save: fix the highlighted problems.';
    state.statusError = true;
    render();
    return;
  }
  try {
    const metadata = await state.store.save(state.document);
    state.document = await state.store.load(metadata.id);
    state.revision = metadata.revision;
    state.problems = [];
    state.status = `Saved · rev. ${metadata.revision} · ${new Date(metadata.updatedAt).toLocaleTimeString('en')}`;
    state.statusError = false;
    render();
    toast('Scenario saved.');
  } catch (error) {
    state.status = `Save failed: ${error.message}`;
    state.statusError = true;
    render();
  }
}

function downloadFile(fileName, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportScenarioById(id) {
  const document = id ? await state.store.load(id) : state.document;
  if (!document) {
    toast('Nothing to export.');
    return;
  }
  try {
    const { fileName, json } = exportScenario(document);
    downloadFile(fileName, json);
    toast(`Exported ${fileName}.`);
  } catch (error) {
    toast(error.message);
  }
}

async function importScenarioFile(file) {
  try {
    const text = await file.text();
    // Parsing (and its specific rejection messages) runs before anything is
    // stored, so a rejected file leaves the library unchanged.
    const copy = importScenarioDocument(text);
    const metadata = await state.store.save(copy);
    await refreshLibrary();
    await openScenario(metadata.id);
    toast(`Imported as a new copy: ${copy.title}.`);
  } catch (error) {
    toast(error.message);
  }
}

document.addEventListener('click', async (event) => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  const { action, id } = element.dataset;
  if (action === 'open') await openScenario(id);
  if (action === 'back') {
    state.view = 'library';
    state.document = null;
    await refreshLibrary();
    render();
  }
  if (action === 'save') await saveScenario();
  if (action === 'export') await exportScenarioById(id || null);
  if (action === 'delete') {
    if (!window.confirm('Delete this scenario?')) return;
    await state.store.remove(id);
    await refreshLibrary();
    render();
    toast('Scenario deleted.');
  }
});

document.addEventListener('submit', async (event) => {
  if (event.target.id !== 'new-form') return;
  event.preventDefault();
  const title = new FormData(event.target).get('title');
  try {
    const created = createScenario({ title: String(title) });
    const metadata = await state.store.save(created);
    state.newTitle = '';
    await refreshLibrary();
    await openScenario(metadata.id);
    toast('Scenario created.');
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('input', (event) => {
  const field = event.target.dataset?.field;
  if (!field || !state.document) return;
  if (field === 'title') {
    state.document.title = event.target.value;
    state.status = state.document.title.trim() ? 'Unsaved changes' : 'Title is required';
    state.statusError = !state.document.title.trim();
    const statusElement = $('.status');
    if (statusElement) {
      statusElement.textContent = state.status;
      statusElement.classList.toggle('error', state.statusError);
    }
  }
  if (field === 'description') {
    state.document.description = event.target.value;
    state.status = 'Unsaved changes';
    state.statusError = false;
    const statusElement = $('.status');
    if (statusElement) {
      statusElement.textContent = state.status;
      statusElement.classList.toggle('error', false);
    }
  }
});

document.addEventListener('change', (event) => {
  if (event.target && event.target.id === 'import-file') {
    const [file] = event.target.files || [];
    if (file) {
      void importScenarioFile(file);
    }
    return;
  }
  const field = event.target.dataset?.field;
  if (!field || !state.document) return;
  if (field === 'width' || field === 'height') {
    state.document.battlefield[field] = Math.round(Number(event.target.value) * 10) / 10;
    state.problems = validateScenario(state.document).filter((problem) =>
      problem.includes(`battlefield.${field}`),
    );
    state.status = 'Unsaved changes';
    state.statusError = false;
    render();
  }
  if (field === 'side-name') {
    const side = state.document.sides[Number(event.target.dataset.index)];
    if (side) {
      side.name = event.target.value;
      state.problems = validateScenario(state.document);
      render();
    }
  }
  if (field === 'side-color') {
    const side = state.document.sides[Number(event.target.dataset.index)];
    if (side) {
      side.color = event.target.value;
      state.status = 'Unsaved changes';
      state.statusError = false;
      render();
    }
  }
});

async function init() {
  const params = new URLSearchParams(location.search);
  state.persistent = await ensurePersistentStorage();
  await refreshLibrary();
  if (params.get('id')) {
    await openScenario(params.get('id'));
  } else {
    render();
  }
  console.info('[PÓLIS editor]', { narrowNoticeWidth: NARROW_NOTICE_WIDTH });
}

init();
