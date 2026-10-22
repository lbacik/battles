// PÓLIS tracer bullet — scenario library and battlefield editor.
//
// Structure follows prototype layout A: order of battle on the left, the map
// in the centre, the inspector on the right. The visual style is not decided.
// The editor talks to browser storage only through the narrow scenario store
// interface (ADR 0003); the domain model stays framework-free.
import {
  MAX_BATTLEFIELD_HEIGHT_M,
  MAX_BATTLEFIELD_WIDTH_M,
  clampMapZoom,
  cloneScenario,
  collectWarnings,
  createScenario,
  deriveFootprint,
  exportScenario,
  fitMapView,
  importScenarioDocument,
  mapViewBox,
  niceScaleBarMetres,
  panMapViewByPixels,
  resizeBattlefield,
  toScreenPoint,
  unitFacingDeg,
  unitFootprint,
  unitPosition,
  validateScenario,
  zoomViewAroundCursor,
} from './domain/scenario.js';
import { getTroopType } from './domain/polis-classical.js';
import { IndexedDBScenarioStore, ensurePersistentStorage } from './library/idb.js';

const NARROW_NOTICE_WIDTH = 1280;

// Map navigation state is display-only: zooming, panning, fitting, toggling
// the grid, switching tools, and moving the cursor never mutate the scenario
// document and never mark the scenario as unsaved.
const state = {
  store: new IndexedDBScenarioStore(),
  library: [],
  view: 'library',
  document: null,
  // The last saved version of the open scenario: the unsaved-changes
  // indicator compares the working document against it. Timestamps are
  // ignored by the comparison (saving refreshes them).
  savedDocument: null,
  revision: null,
  status: '',
  statusError: false,
  // Rejected form values, keyed by field: the value is never committed to
  // the document, the field reverts, and the message is shown inline.
  fieldErrors: {},
  // Undo history for the editing session: snapshots of the document before
  // each committed change. Unbounded, never saved, reset on every open.
  // View navigation and selection are not recorded (the map has neither).
  history: { past: [], future: [] },
  persistent: null,
  newTitle: '',
  mapView: null,
  spaceHeld: false,
};

function ensureMapView(document) {
  const fitted = fitMapView(document.battlefield);
  if (!state.mapView) {
    state.mapView = { ...fitted, showGrid: true, tool: 'select', viewportW: 800 };
  }
  return state.mapView;
}

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

// --- Editing session ------------------------------------------------------
// Every scenario change goes through commitEdit, which pushes the previous
// document onto the undo stack and clears the redo stack. Undo and redo
// restore whole-document snapshots, so every tool that plugs into
// commitEdit later (terrain, units) is undoable with no extra work.

function comparisonCopy(document) {
  const copy = cloneScenario(document);
  delete copy.updatedAt;
  return copy;
}

function documentsMatch(left, right) {
  if (!left || !right) {
    return left === right;
  }
  return JSON.stringify(comparisonCopy(left)) === JSON.stringify(comparisonCopy(right));
}

// The scenario differs from the last saved version.
function isDirty() {
  return (
    !!state.document && !!state.savedDocument && !documentsMatch(state.document, state.savedDocument)
  );
}

function commitEdit(nextDocument, refocusSelector) {
  if (!state.document) {
    return;
  }
  state.fieldErrors = {};
  if (documentsMatch(nextDocument, state.document)) {
    render();
    return;
  }
  state.history.past.push(cloneScenario(state.document));
  state.history.future = [];
  state.document = nextDocument;
  state.status = '';
  state.statusError = false;
  render(refocusSelector);
}

function undoEdit(refocusSelector) {
  if (!state.document || state.history.past.length === 0) {
    return;
  }
  state.history.future.push(cloneScenario(state.document));
  state.document = state.history.past.pop();
  state.fieldErrors = {};
  // Undoing back to the saved version clears the transient message so the
  // header falls back to the saved state; anything else stays marked dirty.
  state.status = isDirty() ? 'Undone.' : '';
  state.statusError = false;
  render(refocusSelector);
}

function redoEdit(refocusSelector) {
  if (!state.document || state.history.future.length === 0) {
    return;
  }
  state.history.past.push(cloneScenario(state.document));
  state.document = state.history.future.pop();
  state.fieldErrors = {};
  state.status = isDirty() ? 'Redone.' : '';
  state.statusError = false;
  render(refocusSelector);
}

// Reject a form value: it is never committed, the field reverts on render,
// and the reason is shown in the status line and under the field.
function failCommit(field, message) {
  state.fieldErrors = { [field]: message };
  state.status = message;
  state.statusError = true;
  render();
}

function defaultStatus() {
  if (!state.document || isDirty()) {
    return '';
  }
  return state.revision === null ? '' : `Saved · rev. ${state.revision}`;
}

// --- Field commits (invalid values never reach the document) --------------

function commitTitle(raw) {
  const value = String(raw ?? '');
  if (!value.trim()) {
    failCommit('title', 'Scenario title is required.');
    return;
  }
  if (value.trim() === state.document.title) {
    state.fieldErrors = {};
    render();
    return;
  }
  const next = cloneScenario(state.document);
  next.title = value.trim();
  commitEdit(next);
}

function commitDescription(raw) {
  const value = String(raw ?? '');
  if (value === (state.document.description || '')) {
    state.fieldErrors = {};
    render();
    return;
  }
  const next = cloneScenario(state.document);
  next.description = value;
  commitEdit(next);
}

function commitDimension(dimension, raw) {
  if (String(raw ?? '').trim() === '' || !Number.isFinite(Number(raw))) {
    failCommit(dimension, `Battlefield ${dimension} must be a number of metres.`);
    return;
  }
  let next;
  try {
    next = resizeBattlefield(
      state.document,
      dimension === 'width' ? Number(raw) : state.document.battlefield.width,
      dimension === 'height' ? Number(raw) : state.document.battlefield.height,
    );
  } catch (error) {
    failCommit(dimension, error.message);
    return;
  }
  commitEdit(next, `[data-field="${dimension}"]`);
}

function commitSideName(index, raw) {
  const field = `side-name-${index}`;
  const side = state.document.sides[index];
  if (!side) {
    return;
  }
  const value = String(raw ?? '');
  if (!value.trim()) {
    failCommit(field, `Side ${index + 1} name is required.`);
    return;
  }
  const other = state.document.sides.find((_, otherIndex) => otherIndex !== index);
  if (other && value.trim().toLowerCase() === String(other.name || '').trim().toLowerCase()) {
    failCommit(field, 'Side names must be unique.');
    return;
  }
  if (value.trim() === side.name) {
    state.fieldErrors = {};
    render();
    return;
  }
  const next = cloneScenario(state.document);
  next.sides[index].name = value.trim();
  commitEdit(next);
}

function commitSideColor(index, raw) {
  const field = `side-color-${index}`;
  const side = state.document.sides[index];
  if (!side) {
    return;
  }
  const value = String(raw || '').toLowerCase();
  const other = state.document.sides.find((_, otherIndex) => otherIndex !== index);
  if (other && value === String(other.color || '').toLowerCase()) {
    failCommit(field, 'Sides must have distinct colours.');
    return;
  }
  if (value === String(side.color || '').toLowerCase()) {
    state.fieldErrors = {};
    render();
    return;
  }
  const next = cloneScenario(state.document);
  next.sides[index].color = value;
  commitEdit(next, `[data-field="side-color"][data-index="${index}"]`);
}

function committedFieldValue(input) {
  const index = Number(input.dataset.index);
  if (input.dataset.field === 'title') {
    return state.document.title;
  }
  if (input.dataset.field === 'description') {
    return state.document.description || '';
  }
  if (input.dataset.field === 'side-name') {
    return state.document.sides[index]?.name ?? '';
  }
  return input.value;
}

// --- Map rendering (ADR 0001) -------------------------------------------
// The model uses map coordinates (origin south-west, x east, y north,
// metres). Only rendering flips the vertical axis for the screen, through
// toScreenPoint: screenY = battlefieldHeight - mapY. Terrain outlines and
// unit footprints are drawn at true scale from the stored vertices: rendering
// never moves outlines (no smoothing, no enlarged symbols), and footprints
// are never enlarged for display: at low zoom the renderer may only add
// helper outlines or icons around (never instead of) the true rectangle.
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

function sideColor(document, unitOrSideId) {
  const key =
    unitOrSideId && typeof unitOrSideId === 'object'
      ? (unitOrSideId.sideId ?? unitOrSideId.side ?? unitOrSideId.sideName)
      : unitOrSideId;
  const side = (document.sides || []).find(
    (entry) => entry.id === key || entry.name === key,
  );
  return side && side.color ? side.color : '#666666';
}

function troopDisplayName(troopType) {
  return getTroopType(troopType)?.displayName || troopType;
}

function unitLabelLines(unit, footprint) {
  const name = String(unit?.name || 'Unit');
  if (!footprint) return [name, ''];
  const dims = `${Math.round(footprint.frontageM)} × ${Math.round(footprint.depthM)} m`;
  return [name, dims];
}

function unitSvg(document, unit, mapView, mpp) {
  const position = unitPosition(unit);
  const footprint = unitFootprint(unit);
  if (!position || !footprint) return '';
  const { height: heightM } = document.battlefield;
  const centre = toScreenPoint(position, heightM);
  const facing = unitFacingDeg(unit);
  const color = sideColor(document, unit);
  const frontW = footprint.frontageM;
  const depthH = footprint.depthM;
  const [name, dims] = unitLabelLines(unit, footprint);
  // Labels keep a constant screen size: font sizes are specified in metres
  // divided by the zoom so text does not grow with the battlefield.
  const zoom = clampMapZoom(mapView?.zoom);
  const labelSize = 13 / zoom;
  const dimsSize = 10.5 / zoom;
  // Low-zoom helper: when the true footprint would render below ~10 px, add
  // a dashed helper outline (and only then) so the unit stays findable. The
  // true rectangle itself is always drawn at true scale.
  const minEdgePx = Math.min(frontW, depthH) / mpp;
  const helperM = 16 * mpp;
  const helperBox = Math.max(frontW, depthH, helperM);
  const helper =
    minEdgePx < 10
      ? `<rect x="${-helperBox / 2}" y="${-helperBox / 2}" width="${helperBox}" height="${helperBox}" rx="${4 * mpp}" fill="none" stroke="${esc(color)}" stroke-width="${1.5 * mpp}" stroke-dasharray="${6 * mpp} ${4 * mpp}" opacity="0.85" class="unit-helper"/>` +
        `<path d="M0 ${-helperBox / 2 - 10 * mpp} l${5 * mpp} ${5 * mpp} l${-5 * mpp} ${5 * mpp} l${-5 * mpp} ${-5 * mpp} Z" fill="${esc(color)}" opacity="0.9" class="unit-helper"/>`
      : '';
  return `<g class="unit" transform="translate(${centre.x} ${centre.y)}">
    <g transform="rotate(${facing)}">
      ${helper}
      <rect x="${-frontW / 2}" y="${-depthH / 2}" width="${frontW}" height="${depthH}" fill="${esc(color)}" fill-opacity="0.32" stroke="${esc(color)}" stroke-width="${1.6 * mpp}" class="unit-footprint"/>
      <line x1="${-frontW / 2}" y1="${-depthH / 2}" x2="${frontW / 2}" y2="${-depthH / 2}" stroke="${esc(color)}" stroke-width="${3 * mpp}"/>
    </g>
    <text x="0" y="${depthH / 2 + 8 * mpp + labelSize * 0.9}" text-anchor="middle" font-size="${labelSize}" class="unit-label">${esc(name)}</text>
    ${dims ? `<text x="0" y="${depthH / 2 + 8 * mpp + labelSize * 0.9 + dimsSize * 1.25}" text-anchor="middle" font-size="${dimsSize}" class="unit-dims">${esc(dims)}</text>` : ''}
    <title>${esc(name)}${dims ? ` · ${esc(dims)}` : ''}</title>
  </g>`;
}

function battlefieldSvg(document, mapView) {
  const { width: widthM, height: heightM } = document.battlefield;
  const toScreen = (x, y) => toScreenPoint({ x, y }, heightM);
  const box = mapViewBox(mapView, document.battlefield);
  const viewBox = `${box.x} ${box.y} ${box.width} ${box.height}`;
  const viewportW = mapView?.viewportW && mapView.viewportW > 0 ? mapView.viewportW : 800;
  const mpp = box.width / viewportW;
  const zoom = clampMapZoom(mapView?.zoom);
  const axisSize = 13 / zoom;
  const showGrid = mapView?.showGrid !== false;

  let grid = '';
  if (showGrid) {
    for (let x = 0; x <= widthM; x += 100) {
      const major = x % 500 === 0;
      grid += `<line x1="${x}" y1="0" x2="${x}" y2="${heightM}" stroke="#7d8a76" stroke-width="${major ? 1.4 : 0.7}" opacity="${major ? 0.4 : 0.2}"/>`;
    }
    for (let y = 0; y <= heightM; y += 100) {
      const major = y % 500 === 0;
      const screenY = heightM - y;
      grid += `<line x1="0" y1="${screenY}" x2="${widthM}" y2="${screenY}" stroke="#7d8a76" stroke-width="${major ? 1.4 : 0.7}" opacity="${major ? 0.4 : 0.2}"/>`;
    }
  }
  let xLabels = '';
  for (let x = 0; x <= widthM; x += 200) {
    xLabels += `<text x="${x}" y="${heightM + 26 / zoom}" text-anchor="middle" font-size="${axisSize}" fill="#8a947c">${x}</text>`;
  }
  let yLabels = '';
  for (let y = 0; y <= heightM; y += 200) {
    yLabels += `<text x="${-16 / zoom}" y="${heightM - y + axisSize * 0.35}" text-anchor="end" font-size="${axisSize}" fill="#8a947c">${y}</text>`;
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

  const units = Array.isArray(document.units) ? document.units : [];
  const placed = units.filter((unit) => unitPosition(unit) && unitFootprint(unit));
  const unplaced = units.length - placed.length;

  return `<svg id="battle-svg" viewBox="${viewBox}" role="img" aria-label="Battlefield, ${widthM} by ${heightM} metres, origin south-west" data-zoom="${zoom}">
    <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#dfddce"/>
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="#e8e5d5"/>
    <g id="map-grid-group" style="display:${showGrid ? 'block' : 'none'}">${grid}</g>
    ${terrain}
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="none" stroke="#6f7a65" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${xLabels}${yLabels}
    <g id="map-units-group">${placed.map((unit) => unitSvg(document, unit, mapView, mpp)).join('')}</g>
    <circle cx="${origin.x}" cy="${origin.y}" r="${5 * mpp}" fill="#4e6047"/>
    <text x="${origin.x + 10 * mpp}" y="${origin.y - 10 * mpp}" font-size="${axisSize}" fill="#4e6047">origin (0, 0) · SW</text>
    ${units.length === 0 ? `<text x="${centre.x}" y="${centre.y}" text-anchor="middle" font-size="${17 / zoom}" fill="#9aa08b">Empty battlefield — no units yet</text>` : ''}
    ${unplaced > 0 ? `<text x="${centre.x}" y="${centre.y - 30 / zoom}" text-anchor="middle" font-size="${12 / zoom}" fill="#a46c5b">${unplaced} unit${unplaced === 1 ? '' : 's'} without a map position</text>` : ''}
    <g>
      <text x="${widthM - 14 / zoom}" y="${30 / zoom}" text-anchor="end" font-size="${15 / zoom}" fill="#6f7a65">N ↑</text>
    </g>
  </svg>`;
}

// --- Map view helpers (display-only DOM updates) ----------------------------
// Wheel zoom and hand panning update the SVG viewBox in place instead of
// re-rendering the editor, so gestures stay smooth and form focus is kept.
// None of these functions touch the scenario document or the saved status.
function currentMpp() {
  const viewport = $('.map-viewport');
  if (!viewport || !state.document) return 1;
  const rect = viewport.getBoundingClientRect();
  const widthPx = rect.width > 0 ? rect.width : state.mapView?.viewportW || 800;
  if (state.mapView) state.mapView.viewportW = widthPx;
  return mapViewBox(state.mapView, state.document.battlefield).width / widthPx;
}

function svgToMap(svg, clientX, clientY) {
  const point = new DOMPoint(clientX, clientY);
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const local = point.matrixTransform(matrix.inverse());
  const height = state.document?.battlefield?.height;
  if (!Number.isFinite(height)) return null;
  return { x: local.x, y: height - local.y };
}

function formatMetres(value) {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(1)} m`;
}

function updateScaleBar(mpp) {
  const bar = $('#scale-bar');
  const label = $('#scale-bar-label');
  if (!bar || !label) return;
  const lengthM = niceScaleBarMetres(mpp, 120);
  bar.style.width = `${Math.max(8, lengthM / mpp)}px`;
  label.textContent = lengthM >= 1000 ? `${lengthM / 1000} km` : `${lengthM} m`;
}

function updateMapDom() {
  const svg = $('#battle-svg');
  if (!svg || !state.document || !state.mapView) return;
  const box = mapViewBox(state.mapView, state.document.battlefield);
  svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  svg.dataset.zoom = String(clampMapZoom(state.mapView.zoom));
  const grid = $('#map-grid-group');
  if (grid) grid.style.display = state.mapView.showGrid ? 'block' : 'none';
  const zoomLabel = $('#zoom-level');
  if (zoomLabel) zoomLabel.textContent = `${Math.round(clampMapZoom(state.mapView.zoom) * 100)}%`;
  updateScaleBar(currentMpp());
}

function setMapView(next) {
  state.mapView = next;
  updateMapDom();
  const gridButton = $('[data-action="toggle-grid"]');
  if (gridButton) {
    gridButton.setAttribute('aria-pressed', String(next.showGrid));
    gridButton.classList.toggle('active', next.showGrid);
  }
  const handButton = $('[data-action="map-tool-hand"]');
  const selectButton = $('[data-action="map-tool-select"]');
  if (handButton) {
    handButton.setAttribute('aria-pressed', String(next.tool === 'hand'));
    handButton.classList.toggle('active', next.tool === 'hand');
  }
  if (selectButton) {
    selectButton.setAttribute('aria-pressed', String(next.tool !== 'hand'));
    selectButton.classList.toggle('active', next.tool !== 'hand');
  }
  const viewport = $('.map-viewport');
  if (viewport) {
    viewport.classList.toggle('tool-hand', next.tool === 'hand');
    viewport.classList.toggle('space-pan', state.spaceHeld);
  }
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
  const units = Array.isArray(document.units) ? document.units : [];
  const unitsOf = (side) =>
    units.filter(
      (unit) =>
        (unit?.sideId ?? unit?.side ?? unit?.sideName) === side.id ||
        (unit?.side ?? unit?.sideName) === side.name,
    );
  return `<div class="panel"><span class="eyebrow">FORCES IN THE FIELD</span><h2>Order of battle</h2>
    ${document.sides
      .map((side) => {
        const sideUnits = unitsOf(side);
        const soldiers = sideUnits.reduce((sum, unit) => sum + (Number(unit?.soldiers) || 0), 0);
        return `<div class="side">
          <div class="side-name"><span class="swatch" style="background:${esc(side.color)}"></span>${esc(side.name)}</div>
          <p class="side-count">${sideUnits.length} ${sideUnits.length === 1 ? 'unit' : 'units'} · ${soldiers.toLocaleString('en')} soldiers</p>
          ${sideUnits
            .map((unit) => {
              let footprint = null;
              try {
                footprint = deriveFootprint(unit);
              } catch {
                footprint = null;
              }
              if (!footprint || !Number.isFinite(footprint.ranks)) footprint = unitFootprint(unit);
              const detail = footprint
                ? `${esc(troopDisplayName(unit.troopType))} · ${esc(unit.soldiers)} soldiers · ${esc(unit.files)} files × ${footprint.ranks} ranks`
                : `${esc(troopDisplayName(unit.troopType))} · not placed`;
              return `<div class="unit-row"><span class="swatch" style="background:${esc(side.color)}"></span><div><div class="unit-name">${esc(unit?.name || 'Unit')}</div><div class="unit-detail">${detail}</div></div></div>`;
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
  const errors = validateScenario(document);
  const warnings = collectWarnings(document);
  const issueCount = errors.length + warnings.length;
  const fieldError = (name) =>
    state.fieldErrors[name] ? `<p class="field-error" role="alert">${esc(state.fieldErrors[name])}</p>` : '';
  const invalid = (name) => (state.fieldErrors[name] ? ' aria-invalid="true"' : '');
  return `<div class="panel"><span class="eyebrow">SCENARIO INSPECTOR</span><h2>Scenario</h2>
    <label class="field">Title (required)<input data-field="title" value="${esc(document.title)}" maxlength="120"${invalid('title')}></label>
    ${fieldError('title')}
    <div class="field-pair">
      <div><label class="field">Width (m)<input type="number" data-field="width" min="1" max="${MAX_BATTLEFIELD_WIDTH_M}" step="0.1" value="${esc(size.width)}"${invalid('width')}></label>${fieldError('width')}</div>
      <div><label class="field">Height (m)<input type="number" data-field="height" min="1" max="${MAX_BATTLEFIELD_HEIGHT_M}" step="0.1" value="${esc(size.height)}"${invalid('height')}></label>${fieldError('height')}</div>
    </div>
    <label class="field">Description<textarea data-field="description" rows="3" maxlength="2000" placeholder="Optional plain-text description">${esc(document.description || '')}</textarea></label>
    <div class="kv"><dt>Forces</dt><dd>${(document.units || []).length} units</dd></div>
    <div class="kv"><dt>Terrain</dt><dd>${terrainSummary(document)}</dd></div>
    ${document.sides
      .map(
        (side, index) => `<div class="field-pair">
        <div><label class="field">Side ${index + 1} name<input data-field="side-name" data-index="${index}" value="${esc(side.name)}" maxlength="60"${invalid(`side-name-${index}`)}></label>${fieldError(`side-name-${index}`)}</div>
        <div><label class="field">Colour<input type="color" data-field="side-color" data-index="${index}" value="${esc(side.color)}"${invalid(`side-color-${index}`)}></label>${fieldError(`side-color-${index}`)}</div>
      </div>`,
      )
      .join('')}
    <p class="readonly-note">Two sides, always: sides cannot be added or removed.</p>
    <section class="issues" aria-label="Issues">
      <h3>Issues${issueCount ? ` <span class="issue-count">${issueCount}</span>` : ''}</h3>
      ${errors.map((problem) => `<p class="issue issue-error">${esc(problem)}</p>`).join('')}
      ${warnings.map((warning) => `<p class="issue issue-warning">${esc(warning)}</p>`).join('')}
      ${issueCount === 0 ? '<p class="issues-empty">No issues.</p>' : '<p class="issues-note">Warnings never block saving; errors must be fixed before saving.</p>'}
    </section>
    <dl>
      <div class="kv"><dt>Identifier</dt><dd class="mono">${esc(document.id)}</dd></div>
      <div class="kv"><dt>Format</dt><dd>${esc(document.kind)} · v${esc(document.formatVersion)}</dd></div>
      <div class="kv"><dt>Ruleset</dt><dd class="mono">${esc(document.ruleset.id)} ${esc(document.ruleset.version)}</dd></div>
      <div class="kv"><dt>Revision</dt><dd>${state.revision === null ? 'unsaved' : `rev. ${state.revision}`}</dd></div>
      <div class="kv"><dt>Updated</dt><dd>${esc(document.updatedAt)}</dd></div>
    </dl>
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

function mapToolbarView() {
  const view = state.mapView;
  const zoom = clampMapZoom(view?.zoom);
  const isHand = view?.tool === 'hand';
  const showGrid = view?.showGrid !== false;
  return `<div class="map-toolbar" role="toolbar" aria-label="Map navigation">
    <button class="map-tool${isHand ? '' : ' active'}" data-action="map-tool-select" aria-pressed="${String(!isHand)}" title="Select (V)">Select</button>
    <button class="map-tool${isHand ? ' active' : ''}" data-action="map-tool-hand" aria-pressed="${String(isHand)}" title="Hand: drag to pan (H, or hold Space)">Hand</button>
    <span class="map-zoom-group" role="group" aria-label="Zoom">
      <button class="map-tool" data-action="zoom-out" aria-label="Zoom out (−)">−</button>
      <span id="zoom-level" aria-live="off">${Math.round(zoom * 100)}%</span>
      <button class="map-tool" data-action="zoom-in" aria-label="Zoom in (+)">+</button>
    </span>
    <button class="map-tool" data-action="fit-view" title="Fit to battlefield (0)">Fit</button>
    <button class="map-tool${showGrid ? ' active' : ''}" data-action="toggle-grid" aria-pressed="${String(showGrid)}" title="Toggle display-only grid (G)">Grid</button>
  </div>`;
}

function editorView() {
  const document = state.document;
  const { width, height } = document.battlefield;
  ensureMapView(document);
  const canUndo = state.history.past.length > 0;
  const canRedo = state.history.future.length > 0;
  return `<div class="editor-head">
      <button class="btn-quiet" data-action="back">← Library</button>
      <span class="doc-title">${esc(document.title)}</span>
      <span class="spacer"></span>
      ${isDirty() ? '<span class="dirty-pill" title="The scenario differs from the saved version."><span class="dirty-dot" aria-hidden="true"></span>Unsaved changes</span>' : ''}
      <span class="status${state.statusError ? ' error' : ''}">${esc(state.status || defaultStatus())}</span>
      <button class="btn-tool" data-action="undo"${canUndo ? '' : ' disabled'} title="Undo (Ctrl/⌘+Z)">Undo</button>
      <button class="btn-tool" data-action="redo"${canRedo ? '' : ' disabled'} title="Redo (Shift+Ctrl/⌘+Z)">Redo</button>
      <button class="btn-secondary" data-action="export">Export</button>
      <button class="btn-primary" data-action="save">Save</button>
    </div>
    <main class="workspace">
      <aside class="left-panel">${orderOfBattleView(document)}</aside>
      <section class="map-panel">
        <div class="map-caption">${metres(width)} × ${metres(height)} · origin south-west · metres</div>
        ${mapToolbarView()}
        <div class="map-viewport${state.mapView.tool === 'hand' ? ' tool-hand' : ''}${state.spaceHeld ? ' space-pan' : ''}">
          ${battlefieldSvg(document, state.mapView)}
          <div class="map-status">
            <span class="scale-bar" aria-label="Scale bar"><span id="scale-bar"></span><span id="scale-bar-label">—</span></span>
            <span id="cursor-coords" class="cursor-coords" aria-label="Cursor coordinates in metres">X — · Y —</span>
          </div>
        </div>
        <p class="map-hint">Scroll to zoom around the cursor · drag with the hand tool or while holding Space to pan · view changes never mark the scenario unsaved · grid is display-only</p>
      </section>
      <aside class="right-panel">${inspectorView(document)}</aside>
    </main>`;
}

function render(refocusSelector) {
  $('#app').innerHTML = state.view === 'editor' ? editorView() : libraryView();
  if (refocusSelector) {
    document.querySelector(refocusSelector)?.focus();
  }
  if (state.view === 'library') {
    const input = $('input[name="title"]');
    input?.addEventListener('input', () => {
      state.newTitle = input.value;
      const button = $('#new-form button[type="submit"]');
      if (button) button.disabled = !input.value.trim();
    });
  }
  if (state.view === 'editor') {
    bindMap();
    updateMapDom();
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
  // A reopened scenario starts with a clean slate: the saved version for
  // the unsaved-changes indicator and an empty undo history.
  state.savedDocument = cloneScenario(document);
  state.revision = entry ? entry.revision : null;
  state.history = { past: [], future: [] };
  state.fieldErrors = {};
  state.view = 'editor';
  // Fresh camera on the new battlefield; keep the author's grid/tool preference.
  state.mapView = {
    ...fitMapView(document.battlefield),
    showGrid: state.mapView?.showGrid !== false,
    tool: state.mapView?.tool === 'hand' ? 'hand' : 'select',
    viewportW: state.mapView?.viewportW || 800,
  };
  state.spaceHeld = false;
  setStatusAfterRender(`Opened · rev. ${state.revision}`);
  render();
  setStatus(`Opened · rev. ${state.revision}`);
}

// Display-only map navigation: none of these branches touch the scenario
// document or the saved/unsaved status.
function handleMapAction(action) {
  if (!state.document) return false;
  ensureMapView(state.document);
  const view = state.mapView;
  if (action === 'map-tool-select') {
    setMapView({ ...view, tool: 'select' });
    return true;
  }
  if (action === 'map-tool-hand') {
    setMapView({ ...view, tool: 'hand' });
    return true;
  }
  if (action === 'toggle-grid') {
    setMapView({ ...view, showGrid: !view.showGrid });
    return true;
  }
  if (action === 'zoom-in') {
    setMapView({ ...view, ...zoomViewAroundCursor(view, view.center, view.zoom * 1.25) });
    return true;
  }
  if (action === 'zoom-out') {
    setMapView({ ...view, ...zoomViewAroundCursor(view, view.center, view.zoom / 1.25) });
    return true;
  }
  if (action === 'fit-view') {
    setMapView({
      ...fitMapView(state.document.battlefield),
      showGrid: view.showGrid,
      tool: view.tool,
      viewportW: view.viewportW,
    });
    return true;
  }
  return false;
}

function bindMap() {
  const svg = $('#battle-svg');
  const viewport = $('.map-viewport');
  if (!svg || !viewport || !state.document) return;
  // Measure the real viewport so the scale bar and helper outlines match it.
  const rect = viewport.getBoundingClientRect();
  if (rect.width > 0) state.mapView.viewportW = rect.width;

  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const cursor = svgToMap(svg, event.clientX, event.clientY);
      if (!cursor) return;
      // Ctrl+wheel (trackpad pinch) sends small deltas: same path, finer step.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      const next = zoomViewAroundCursor(state.mapView, cursor, state.mapView.zoom * factor);
      setMapView({ ...state.mapView, ...next });
    },
    { passive: false },
  );

  let pan = null;
  svg.addEventListener('pointerdown', (event) => {
    const handActive = state.mapView.tool === 'hand' || state.spaceHeld || event.button === 1;
    if (!handActive || (event.button !== 0 && event.button !== 1)) return;
    event.preventDefault();
    pan = { x: event.clientX, y: event.clientY };
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
    viewport.classList.add('panning');
  });
  svg.addEventListener('pointermove', (event) => {
    const cursor = svgToMap(svg, event.clientX, event.clientY);
    const coords = $('#cursor-coords');
    if (coords) {
      if (cursor) {
        const inside =
          cursor.x >= 0 &&
          cursor.x <= state.document.battlefield.width &&
          cursor.y >= 0 &&
          cursor.y <= state.document.battlefield.height;
        coords.textContent = `X ${formatMetres(cursor.x)} · Y ${formatMetres(cursor.y)}${inside ? '' : ' · outside'}`;
        coords.classList.toggle('outside', !inside);
      } else {
        coords.textContent = 'X — · Y —';
      }
    }
    if (!pan) return;
    const dxPx = event.clientX - pan.x;
    const dyPx = event.clientY - pan.y;
    pan = { x: event.clientX, y: event.clientY };
    const next = panMapViewByPixels(state.mapView, dxPx, dyPx, currentMpp());
    setMapView({ ...state.mapView, ...next });
  });
  const endPan = () => {
    pan = null;
    viewport.classList.remove('panning');
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);
  svg.addEventListener('pointerleave', () => {
    const coords = $('#cursor-coords');
    if (coords && !pan) coords.textContent = 'X — · Y —';
  });
}

function setStatusAfterRender(message) {
  state.status = message;
  state.statusError = false;
}

async function saveScenario() {
  // Structural errors block saving; completeness warnings (the issues
  // panel) never do: a scenario with warnings still saves.
  const errors = validateScenario(state.document);
  if (errors.length) {
    state.status = 'Cannot save: fix the highlighted problems.';
    state.statusError = true;
    render();
    return;
  }
  try {
    const metadata = await state.store.save(state.document);
    state.document = await state.store.load(metadata.id);
    state.savedDocument = cloneScenario(state.document);
    state.revision = metadata.revision;
    state.fieldErrors = {};
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
  if (action === 'undo') {
    undoEdit('[data-action="undo"]');
    return;
  }
  if (action === 'redo') {
    redoEdit('[data-action="redo"]');
    return;
  }
  if (action === 'back') {
    if (isDirty() && !window.confirm('You have unsaved changes. Leave the editor without saving?')) {
      return;
    }
    state.view = 'library';
    state.document = null;
    state.savedDocument = null;
    state.history = { past: [], future: [] };
    state.fieldErrors = {};
    state.status = '';
    state.statusError = false;
    await refreshLibrary();
    render();
  }
  if (action === 'save') await saveScenario();
  if (handleMapAction(action)) return;
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

// Form values commit on change (blur, Enter, picker close): typing never
// touches the document, so every committed change is one undo step and an
// invalid value can be refused before it lands.
document.addEventListener('change', (event) => {
  if (event.target && event.target.id === 'import-file') {
    const [file] = event.target.files || [];
    if (file) {
      void importScenarioFile(file);
    }
    return;
  }
  if (state.view !== 'editor' || !state.document) {
    return;
  }
  const field = event.target.dataset?.field;
  if (!field) {
    return;
  }
  if (field === 'title') {
    commitTitle(event.target.value);
  }
  if (field === 'description') {
    commitDescription(event.target.value);
  }
  if (field === 'width' || field === 'height') {
    commitDimension(field, event.target.value);
  }
  if (field === 'side-name') {
    commitSideName(Number(event.target.dataset.index), event.target.value);
  }
  if (field === 'side-color') {
    commitSideColor(Number(event.target.dataset.index), event.target.value);
  }
});

document.addEventListener('keydown', (event) => {
  if (state.view !== 'editor' || !state.document) {
    return;
  }
  const target = event.target;
  const field = target?.dataset?.field;
  // Text fields commit on Enter (via blur) and revert on Escape. Typing
  // itself stays a draft: it is not a scenario change and is not undoable.
  // (Enter in the description keeps its newline, so only Escape applies.)
  if (
    (field === 'title' || field === 'side-name' || field === 'description') &&
    !event.ctrlKey &&
    !event.metaKey
  ) {
    if (event.key === 'Enter' && field !== 'description') {
      event.preventDefault();
      target.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      target.value = committedFieldValue(target);
      target.blur();
    }
  }
  // Unlimited session undo/redo. Native text undo keeps working inside
  // text fields and textareas; everywhere else the shortcut is the
  // scenario history, which never includes view or selection state.
  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier || event.altKey) {
    return;
  }
  const key = String(event.key || '').toLowerCase();
  const tag = target?.tagName;
  const inTextField =
    tag === 'TEXTAREA' ||
    (tag === 'INPUT' && (target.type === 'text' || target.type === 'search')) ||
    !!target?.isContentEditable;
  if (key === 'z' && !event.shiftKey && !inTextField) {
    event.preventDefault();
    undoEdit();
  } else if ((key === 'y' || (key === 'z' && event.shiftKey)) && !inTextField) {
    event.preventDefault();
    redoEdit();
  }
});

function isEditableTarget(target) {
  return Boolean(target?.closest?.('input, textarea, select, [contenteditable="true"]'));
}

// View-navigation shortcuts. Space temporarily pans like the hand tool; every
// shortcut below is display-only and never marks the scenario as unsaved.
document.addEventListener('keydown', (event) => {
  if (state.view !== 'editor' || !state.document) return;
  if (event.code === 'Space' && !isEditableTarget(event.target) && !event.repeat) {
    event.preventDefault();
    state.spaceHeld = true;
    $('.map-viewport')?.classList.add('space-pan');
    return;
  }
  if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'h') {
    ensureMapView(state.document);
    setMapView({ ...state.mapView, tool: 'hand' });
  } else if (key === 'v' || key === 'escape') {
    ensureMapView(state.document);
    setMapView({ ...state.mapView, tool: 'select' });
  } else if (key === 'g') {
    ensureMapView(state.document);
    setMapView({ ...state.mapView, showGrid: !state.mapView.showGrid });
  } else if (key === '0') {
    ensureMapView(state.document);
    handleMapAction('fit-view');
  } else if (key === '+' || key === '=') {
    ensureMapView(state.document);
    handleMapAction('zoom-in');
  } else if (key === '-' || key === '_') {
    ensureMapView(state.document);
    handleMapAction('zoom-out');
  }
});

document.addEventListener('keyup', (event) => {
  if (event.code === 'Space') {
    state.spaceHeld = false;
    if (state.mapView?.tool !== 'hand') $('.map-viewport')?.classList.remove('space-pan');
  }
});

window.addEventListener('blur', () => {
  state.spaceHeld = false;
  $('.map-viewport')?.classList.remove('space-pan');
});

window.addEventListener('resize', () => {
  if (state.view === 'editor') updateMapDom();
});

async function init() {
  const params = new URLSearchParams(location.search);
  // Leaving (reload, close, navigate) with unsaved changes asks for
  // confirmation; the in-editor back button confirms on its own.
  window.addEventListener('beforeunload', (event) => {
    if (state.view === 'editor' && isDirty()) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
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
