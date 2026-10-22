// PÓLIS tracer bullet — battle player: setup, Begin, and turn-by-turn play.
//
// A player starts a battle from a saved scenario, assigns controllers, and
// plays turns on one shared device, handing over after each resolved turn.
// Only empty commits (all units hold) exist in this slice. The battle screen
// is separate from the editor and follows layout A: order of battle on the
// left, the map in the centre, the turn panel on the right, plus a permanent
// turn bar. The map is read-only with the editor's navigation (zoom, pan,
// grid, fit); only the Orders phase is interactive.
//
// The UI holds no legality rules: playability comes from
// `validatePlayability`, the orders summary from `availableActions`, and every
// commit is validated by `validateTurn` / resolved by `resolveTurn` (human) or
// the runner's `runTurn` (automated). The seed is drawn at Begin and never
// shown; tests and the end-to-end harness set it programmatically through the
// `?seed=` query parameter (there is no seed field in the UI).
import {
  BattleStartError,
  TURN_PHASE_ORDERS,
  startBattle,
  validatePlayability,
} from './domain/battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  availableActions,
  buildPlayerView,
  resolveTurn,
  validateTurn,
} from './domain/turn.js';
import { createPlayerForController, runTurn } from './domain/players.js';
import {
  RULESET_ID,
  RULESET_VERSION,
  getTroopType,
  isKnownTroopType,
} from './domain/polis-classical.js';
import {
  clampMapZoom,
  fitMapView,
  mapViewBox,
  panMapViewByPixels,
  toScreenPoint,
  unitFacingDeg,
  unitFootprint,
  unitPosition,
  zoomViewAroundCursor,
} from './domain/scenario.js';
import { IndexedDBScenarioStore } from './library/idb.js';

// Controllers offered per side. Random and Passive are labelled as test
// players; the engine accepts `human`, `random`, `passive`, and `automated`.
const CONTROLLER_OPTIONS = [
  { value: 'human', label: 'Human' },
  { value: 'random', label: 'Random (test player)' },
  { value: 'passive', label: 'Passive (test player)' },
];

const state = {
  store: new IndexedDBScenarioStore(),
  scenarioId: null,
  seedOverride: null,
  scenario: null,
  loadError: '',
  // Setup-screen controller choice per side id.
  controllers: {},
  // Playability refusal: every problem from `validatePlayability`.
  problems: [],
  // The live battle once Begin succeeds. The seed is drawn at Begin and is
  // never rendered.
  battle: null,
  announcement: '',
  // After each resolution the next side waits for the device handoff: the
  // "<Side> — begin your turn" press unlocks drafting (human) or resolves
  // the turn at once (automated). The first turn is announced at once and
  // needs no handoff.
  awaitingHandoff: false,
  handoffSide: null,
  confirming: false,
  resolving: false,
  resolveToken: 0,
  status: '',
  statusError: false,
  mapView: null,
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

function sideOf(document, id) {
  return (document?.sides || []).find((side) => side?.id === id) || null;
}

function sideName(document, id) {
  return sideOf(document, id)?.name || id;
}

function sideColorOf(document, id) {
  return sideOf(document, id)?.color || '#666666';
}

function roundLimitOf(battle) {
  const limit = battle?.parameters?.battle?.roundLimit;
  return Number.isInteger(limit) && limit > 0 ? limit : 12;
}

function controllerOf(battle, side) {
  return battle?.controllers?.[side] || 'human';
}

function isAutomatedController(controller) {
  return controller !== 'human';
}

function drawSeed() {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return bytes[0];
}

function parseSeedParam(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    return null;
  }
  const text = String(raw).trim();
  if (/^-?\d+$/.test(text)) {
    return Number(text) >>> 0;
  }
  return text;
}

// --- Read-only map (editor navigation, no editing) ---------------------------
// The renderer below mirrors the editor's true-scale drawing (ADR 0001): map
// coordinates (origin south-west, metres) flip to screen through
// `toScreenPoint`, and unit footprints are never enlarged for display. Only
// the camera (zoom, pan, grid, fit) is interactive; units and terrain carry no
// editing handles.
const GROUND_STYLES = {
  forest: { fill: '#9db38f', stroke: '#7a8f6d' },
  rough: { fill: '#d8d2b8', stroke: '#a89f83' },
  water: { fill: '#aecfd0', stroke: '#7fa8a9' },
  settlement: { fill: '#ddcfae', stroke: '#a08c66' },
};

const LINEAR_STYLES = { river: '#7fb3c8', road: '#c9b98f' };

function groundCoverLabel(category) {
  return (
    { forest: 'Forest', rough: 'Rough ground', water: 'Water', settlement: 'Settlement' }[
      category
    ] || String(category || 'Ground cover')
  );
}

function troopDisplayName(troopType) {
  return getTroopType(troopType)?.displayName || troopType;
}

function battleUnitSvg(document, unit, mapView, mpp) {
  const position = unitPosition(unit);
  const footprint = unitFootprint(unit);
  if (!position || !footprint) return '';
  const { height: heightM } = document.battlefield;
  const centre = toScreenPoint(position, heightM);
  const facing = unitFacingDeg(unit);
  const unknownTroop = !isKnownTroopType(unit?.troopType);
  const color = unknownTroop ? '#6b7280' : sideColorOf(document, unit?.side);
  const frontW = footprint.frontageM;
  const depthH = footprint.depthM;
  const name = String(unit?.name || 'Unit');
  const dims = `${Math.round(frontW)} × ${Math.round(depthH)} m`;
  const zoom = clampMapZoom(mapView?.zoom);
  const labelSize = 13 / zoom;
  const dimsSize = 10.5 / zoom;
  const minEdgePx = Math.min(frontW, depthH) / mpp;
  const helperM = 16 * mpp;
  const helperBox = Math.max(frontW, depthH, helperM);
  const helperCy = depthH / 2;
  const helper =
    minEdgePx < 10
      ? `<rect x="${-helperBox / 2}" y="${helperCy - helperBox / 2}" width="${helperBox}" height="${helperBox}" rx="${4 * mpp}" fill="none" stroke="${esc(color)}" stroke-width="${1.5 * mpp}" stroke-dasharray="${6 * mpp} ${4 * mpp}" opacity="0.85"/>`
      : '';
  return `<g class="unit" transform="translate(${centre.x} ${centre.y})">
    <g transform="rotate(${facing})">
      ${helper}
      <rect x="${-frontW / 2}" y="0" width="${frontW}" height="${depthH}" fill="${esc(color)}" fill-opacity="0.32" stroke="${esc(color)}" stroke-width="${1.6 * mpp}"/>
      <line x1="${-frontW / 2}" y1="0" x2="${frontW / 2}" y2="0" stroke="${esc(color)}" stroke-width="${3 * mpp}"/>
    </g>
    <text x="0" y="${depthH + 8 * mpp + labelSize * 0.9}" text-anchor="middle" font-size="${labelSize}" class="unit-label">${esc(name)}</text>
    <text x="0" y="${depthH + 8 * mpp + labelSize * 0.9 + dimsSize * 1.25}" text-anchor="middle" font-size="${dimsSize}" class="unit-dims">${esc(dims)}</text>
    <title>${esc(name)} · ${esc(dims)}</title>
  </g>`;
}

function battleMapSvg(document, mapView) {
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
        return `<polygon points="${project(feature.polygon)}" fill="${style.fill}" fill-opacity="0.7" stroke="${style.stroke}" stroke-width="1.5"><title>${esc(groundCoverLabel(feature.category))}</title></polygon>`;
      }
      if (feature.kind === 'elevation') {
        const middle = toScreen(
          feature.polygon.reduce((sum, point) => sum + point.x, 0) / feature.polygon.length,
          feature.polygon.reduce((sum, point) => sum + point.y, 0) / feature.polygon.length,
        );
        return `<g><polygon points="${project(feature.polygon)}" fill="#c6c8a4" fill-opacity="0.25" stroke="#8a7a5c" stroke-width="1.5" stroke-dasharray="7 4"><title>Hill · level ${esc(feature.level)}</title></polygon><text x="${middle.x}" y="${middle.y}" text-anchor="middle" font-size="13" fill="#6b6247">L${esc(feature.level)}</text></g>`;
      }
      if (feature.kind === 'linear') {
        const color = LINEAR_STYLES[feature.category] || '#888888';
        return `<polyline points="${project(feature.path)}" fill="none" stroke="${color}" stroke-width="${feature.width}" stroke-linecap="round" stroke-linejoin="round"><title>${esc(feature.category)} · ${esc(feature.width)} m</title></polyline>`;
      }
      return '';
    })
    .join('');

  const scenarioUnits = Array.isArray(document.units) ? document.units : [];
  const battleUnits = Array.isArray(state.battle?.units) ? state.battle.units : scenarioUnits;
  const placed = battleUnits.filter((unit) => unitPosition(unit) && unitFootprint(unit));
  const unplaced = battleUnits.length - placed.length;

  return `<svg id="battle-svg" viewBox="${viewBox}" role="img" aria-label="Battlefield, ${widthM} by ${heightM} metres, origin south-west" data-zoom="${zoom}">
    <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#dfddce"/>
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="#e8e5d5"/>
    <g id="map-grid-group" style="display:${showGrid ? 'block' : 'none'}">${grid}</g>
    ${terrain}
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="none" stroke="#6f7a65" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${xLabels}${yLabels}
    <g id="map-units-group">${placed.map((unit) => battleUnitSvg(document, unit, mapView, mpp)).join('')}</g>
    <circle cx="${origin.x}" cy="${origin.y}" r="${5 * mpp}" fill="#4e6047"/>
    <text x="${origin.x + 10 * mpp}" y="${origin.y - 10 * mpp}" font-size="${axisSize}" fill="#4e6047">origin (0, 0) · SW</text>
    ${battleUnits.length === 0 ? `<text x="${centre.x}" y="${centre.y}" text-anchor="middle" font-size="${17 / zoom}" fill="#9aa08b">Empty battlefield — no units yet</text>` : ''}
    ${unplaced > 0 ? `<text x="${centre.x}" y="${centre.y - 30 / zoom}" text-anchor="middle" font-size="${12 / zoom}" fill="#a46c5b">${unplaced} unit${unplaced === 1 ? '' : 's'} without a map position</text>` : ''}
    <g>
      <text x="${widthM - 14 / zoom}" y="${30 / zoom}" text-anchor="end" font-size="${15 / zoom}" fill="#6f7a65">N ↑</text>
    </g>
  </svg>`;
}

// --- Views -------------------------------------------------------------------

function setupView() {
  const scenario = state.scenario;
  if (!scenario) {
    return `<div class="setup">
      <span class="eyebrow">PÓLIS · BATTLE SETUP</span>
      <h1>Scenario not found</h1>
      <p class="lede">${esc(state.loadError || 'The requested scenario could not be loaded.')}</p>
      <div class="setup-actions"><a class="btn-secondary" href="editor.html">← Library</a></div>
    </div>`;
  }
  const sideRows = (scenario.sides || [])
    .map((side) => {
      const options = CONTROLLER_OPTIONS.map(
        (option) =>
          `<option value="${option.value}"${state.controllers[side.id] === option.value ? ' selected' : ''}>${esc(option.label)}</option>`,
      ).join('');
      return `<div class="side-row">
        <span class="swatch" style="background:${esc(side.color)}"></span>
        <span><span class="side-name">${esc(side.name)}</span><br><span class="side-id">${esc(side.id)}</span></span>
        <label>Controller
          <select data-testid="controller-${esc(side.id)}" data-controller-side="${esc(side.id)}" aria-label="Controller for ${esc(side.name)}">${options}</select>
        </label>
      </div>`;
    })
    .join('');
  const refusal = state.problems.length
    ? `<div class="refusal" data-testid="playability-refusal">
        <h2>Cannot begin: this scenario is unplayable under the installed ruleset</h2>
        <p>Every problem is listed below. No battle was created.</p>
        <ul class="problem-list" data-testid="problem-list">
          ${state.problems.map((problem) => `<li>${esc(problem.message)}</li>`).join('')}
        </ul>
        <div class="setup-actions">
          <a class="btn-secondary" data-testid="open-in-editor" href="editor.html?id=${encodeURIComponent(scenario.id)}">Open in editor</a>
        </div>
      </div>`
    : '';
  return `<div class="setup">
    <span class="eyebrow">PÓLIS · BATTLE SETUP</span>
    <h1>${esc(scenario.title)}</h1>
    <p class="lede">Assign a controller per side, then Begin. Begin runs playability
      validation under the installed ruleset; the seed is drawn at Begin and never shown.</p>
    <div class="setup-card" data-testid="setup-screen">
      <h2>Sides</h2>
      <p class="setup-meta">${metres(scenario.battlefield.width)} × ${metres(scenario.battlefield.height)} · ${(scenario.units || []).length} units</p>
      ${sideRows}
      <div class="kv" style="margin-top:16px"><dt>Ruleset</dt><dd class="mono" data-testid="ruleset-version">${esc(scenario.ruleset.id)} ${esc(scenario.ruleset.version)} (installed: ${esc(RULESET_ID)} ${esc(RULESET_VERSION)})</dd></div>
      <div class="setup-actions">
        <button class="btn-primary" data-testid="begin-battle" data-action="begin">Begin</button>
        <a class="btn-quiet" href="editor.html?id=${encodeURIComponent(scenario.id)}">Back to editor</a>
        <a class="btn-quiet" href="editor.html">Library</a>
      </div>
    </div>
    ${refusal}
  </div>`;
}

function orderOfBattleView(document) {
  const units = Array.isArray(state.battle?.units) ? state.battle.units : document.units || [];
  const unitsOf = (sideId) => units.filter((unit) => unit?.side === sideId);
  return `<div class="panel"><span class="eyebrow">FORCES IN THE FIELD</span><h2>Order of battle</h2>
    ${(document.sides || [])
      .map((side) => {
        const sideUnits = unitsOf(side.id);
        const soldiers = sideUnits.reduce((sum, unit) => sum + (Number(unit?.soldiers) || 0), 0);
        return `<div class="side">
          <div class="side-name"><span class="swatch" style="background:${esc(side.color)}"></span>${esc(side.name)}</div>
          <p class="side-count">${sideUnits.length} ${sideUnits.length === 1 ? 'unit' : 'units'} · ${soldiers.toLocaleString('en')} soldiers</p>
          ${sideUnits
            .map((unit) => `<div class="unit-row"><span class="swatch" style="background:${esc(side.color)}"></span><div><div class="unit-name">${esc(unit?.name || 'Unit')}</div><div class="unit-detail">${esc(troopDisplayName(unit?.troopType))} · ${esc(unit?.soldiers)} soldiers · ${esc(unit?.cohesion || '')}</div></div></div>`)
            .join('')}
        </div>`;
      })
      .join('')}
    <p class="readonly-note">Read-only: the battle keeps the scenario's units throughout.</p>
  </div>`;
}

function turnPanelView() {
  const battle = state.battle;
  const document = state.scenario;
  const activeSide = battle.activeSide;
  const controller = controllerOf(battle, activeSide);
  const automated = isAutomatedController(controller);
  // The orders summary comes from the engine, not from UI rules: the only
  // permitted order in this slice is Hold, so an empty commit holds every unit.
  let ordersSummary = '';
  try {
    const actions = availableActions(battle, activeSide);
    const ownCount = actions.units.length;
    ordersSummary = `<div class="kv"><dt>Orders</dt><dd data-testid="orders-summary">All ${ownCount} ${ownCount === 1 ? 'unit holds' : 'units hold'} (empty turn)</dd></div>`;
  } catch {
    ordersSummary = '';
  }
  let actionBox = '';
  if (state.awaitingHandoff && state.handoffSide) {
    actionBox = `<div class="handoff" data-testid="handoff-panel">
      <p>Turn ${battle.turnNumber} resolved. Pass the device, then begin the next turn.</p>
      <div class="handoff-actions">
        <button class="btn-primary" data-testid="handoff" data-action="handoff">${esc(sideName(document, state.handoffSide))} — begin your turn</button>
      </div>
    </div>`;
  } else if (automated) {
    actionBox = state.resolving
      ? `<p class="field-error" role="status" data-testid="resolving">Resolving the ${esc(sideName(document, activeSide))} turn…</p>`
      : `<div class="handoff" data-testid="automated-turn">
          <p>${esc(sideName(document, activeSide))} is automated (${esc(controller)} test player). Its turn resolves at once through the runner.</p>
          <div class="handoff-actions"><button class="btn-primary" data-testid="resolve-automated" data-action="resolve-automated">Continue</button></div>
        </div>`;
  } else if (state.confirming) {
    actionBox = `<div class="confirm-box" data-testid="commit-confirm">
      <p>Commit an empty turn for ${esc(sideName(document, activeSide))}? All units hold.</p>
      <div class="confirm-actions">
        <button class="btn-primary" data-testid="confirm-commit" data-action="confirm-commit">Confirm commit</button>
        <button class="btn-secondary" data-action="cancel-commit">Cancel</button>
      </div>
    </div>`;
  } else {
    const interactive = battle.phase === TURN_PHASE_ORDERS;
    actionBox = `<div class="handoff-actions">
      <button class="btn-primary" data-testid="commit-empty" data-action="commit-empty"${interactive ? '' : ' disabled'}>Commit empty turn</button>
    </div>
    ${interactive ? '' : '<p class="field-error">Only the Orders phase is interactive.</p>'}`;
  }
  const events = (battle.events || []).slice(-8).reverse();
  return `<div class="panel" data-testid="turn-panel">
    <span class="eyebrow">TURN ${battle.turnNumber}</span><h2>${esc(sideName(document, activeSide))}</h2>
    <div class="kv"><dt>Controller</dt><dd>${esc(controller)}${automated ? ' (test player)' : ''}</dd></div>
    <div class="kv"><dt>Phase</dt><dd data-testid="phase">${esc(battle.phase)}</dd></div>
    ${ordersSummary}
    ${actionBox}
    <hr class="panel-divider">
    <span class="eyebrow">BATTLE LOG</span>
    <ol class="log-list" data-testid="battle-log">
      ${events.map((event) => `<li>${esc(event.type)} · turn ${esc(event.turnNumber ?? '—')} · ${esc(event.side ?? event.result ?? '')}</li>`).join('')}
    </ol>
  </div>`;
}

function battleView() {
  const battle = state.battle;
  const document = state.scenario;
  const activeSide = battle.activeSide;
  const limit = roundLimitOf(battle);
  const announcement = state.announcement
    ? `<div class="announcement" data-testid="starting-announcement">${state.announcement}</div>`
    : '';
  return `<div class="topbar">
      <span class="brand">PÓLIS<small>BATTLE PLAYER</small></span>
      <span class="doc-title">${esc(document.title)}</span>
      <span class="spacer"></span>
      <span class="status${state.statusError ? ' error' : ''}">${esc(state.status || '')}</span>
      <a class="btn-secondary" href="editor.html?id=${encodeURIComponent(document.id)}">Open in editor</a>
      <a class="btn-quiet" href="editor.html">Library</a>
    </div>
    <div class="turnbar" data-testid="turn-bar">
      <span class="round" data-testid="round">Round ${battle.round} / ${limit} · Turn ${battle.turnNumber}</span>
      <span class="active-side" data-testid="active-side"><span class="swatch" style="background:${esc(sideColorOf(document, activeSide))}"></span>${esc(sideName(document, activeSide))}</span>
      <span class="phase">Phase: ${esc(battle.phase)}</span>
      <span class="spacer"></span>
      <span class="phase">All units hold · empty turns only</span>
    </div>
    <main class="workspace">
      <aside class="left-panel">${orderOfBattleView(document)}</aside>
      <section class="map-panel">
        <div class="map-caption">${metres(document.battlefield.width)} × ${metres(document.battlefield.height)} · origin south-west · metres · read-only</div>
        <div class="map-toolbar" role="toolbar" aria-label="Map navigation">
          <button class="map-tool" data-action="zoom-out" aria-label="Zoom out (−)">−</button>
          <span id="zoom-level">${Math.round(clampMapZoom(state.mapView?.zoom) * 100)}%</span>
          <button class="map-tool" data-action="zoom-in" aria-label="Zoom in (+)">+</button>
          <button class="map-tool" data-action="fit-view" title="Fit to battlefield (0)">Fit</button>
          <button class="map-tool${state.mapView?.showGrid !== false ? ' active' : ''}" data-action="toggle-grid" aria-pressed="${String(state.mapView?.showGrid !== false)}" title="Toggle display-only grid (G)">Grid</button>
        </div>
        <div class="map-viewport" id="map-viewport">${battleMapSvg(document, state.mapView)}
          <div class="map-status">
            <span class="scale-bar" aria-label="Scale bar"><span id="scale-bar"></span><span id="scale-bar-label">—</span></span>
            <span id="cursor-coords" class="cursor-coords" aria-label="Cursor coordinates in metres">X — · Y —</span>
          </div>
        </div>
        <p class="map-hint">Read-only map: scroll to zoom · drag to pan · the battle keeps the scenario's positions.</p>
      </section>
      <aside class="right-panel">${announcement}${turnPanelView()}</aside>
    </main>`;
}

function render() {
  $('#app').innerHTML = state.battle ? battleView() : setupView();
  if (state.battle) {
    bindBattleMap();
    updateBattleMapDom();
  }
}

// --- Setup: Begin ------------------------------------------------------------
// Begin runs playability validation first. A refusal lists every problem
// (each names the unit and the reason, from the engine) and offers "Open in
// editor"; no battle is created. On success the seed is drawn and never shown,
// and the starting side is announced at once.
function beginBattle(seedOverride = null) {
  const scenario = state.scenario;
  if (!scenario) return;
  state.problems = [];
  state.statusError = false;
  let problems = [];
  try {
    problems = validatePlayability(scenario);
  } catch (error) {
    problems = [
      { message: `Cannot start a battle: ${error.message}` },
    ];
  }
  if (problems.length > 0) {
    state.problems = problems;
    setStatus(`Cannot begin: ${problems.length} playability problem${problems.length === 1 ? '' : 's'}.`, true);
    render();
    return;
  }
  const seed = seedOverride ?? state.seedOverride ?? drawSeed();
  const controllers = {};
  for (const side of scenario.sides || []) {
    controllers[side.id] = state.controllers[side.id] || 'human';
  }
  try {
    state.battle = startBattle(scenario, { seed, controllers });
  } catch (error) {
    if (error instanceof BattleStartError) {
      state.problems = error.problems;
      setStatus(`Cannot begin: ${error.problems.length} playability problem${error.problems.length === 1 ? '' : 's'}.`, true);
      render();
      return;
    }
    throw error;
  }
  state.problems = [];
  state.awaitingHandoff = false;
  state.handoffSide = null;
  state.confirming = false;
  state.mapView = {
    ...fitMapView(scenario.battlefield),
    showGrid: true,
    viewportW: 800,
  };
  const starter = sideName(scenario, state.battle.activeSide);
  state.announcement = `<strong>${esc(starter)}</strong> begins — round 1, turn 1.`;
  setStatus(`Battle started · ${starter} to move.`);
  render();
  toast(`${starter} begins.`);
  void maybeResolveAutomated();
}

// --- Turns -------------------------------------------------------------------
// A human side commits an empty turn after confirmation. An automated side's
// turn is resolved by the runner at once; the next automated turn waits for
// the handoff press ("Continue") — there is no auto-play.
function playersFor(battle) {
  const players = {};
  for (const [side, controller] of Object.entries(battle.controllers || {})) {
    if (isAutomatedController(controller)) {
      players[side] = createPlayerForController(controller);
    }
  }
  return players;
}

async function maybeResolveAutomated() {
  const battle = state.battle;
  if (!battle || state.awaitingHandoff || state.resolving) return;
  if (!isAutomatedController(controllerOf(battle, battle.activeSide))) return;
  const token = state.resolveToken + 1;
  state.resolveToken = token;
  state.resolving = true;
  render();
  try {
    // The player view, available actions, and `validate` handed to the runner
    // come from the engine; the UI never invents orders.
    buildPlayerView(battle);
    availableActions(battle, battle.activeSide);
    const step = await runTurn(battle, {
      ...playersFor(battle),
      [battle.activeSide]:
        playersFor(battle)[battle.activeSide] ||
        createPlayerForController(controllerOf(battle, battle.activeSide)),
    });
    if (state.resolveToken !== token) return;
    state.battle = step.battle;
    state.resolving = false;
    state.awaitingHandoff = true;
    state.handoffSide = step.battle.activeSide;
    state.announcement = '';
    setStatus(`Turn resolved · ${sideName(state.scenario, step.battle.activeSide)} to move.`);
    render();
  } catch (error) {
    if (state.resolveToken !== token) return;
    state.resolving = false;
    setStatus(`Automated turn failed: ${error.message}`, true);
    render();
  }
}

function commitHumanTurn() {
  const battle = state.battle;
  if (!battle || state.awaitingHandoff) return;
  // The empty submission is validated by the engine before it is committed;
  // the UI adds no legality of its own.
  const submission = {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders: [],
  };
  const verdict = validateTurn(battle, submission);
  if (!verdict.ok) {
    setStatus(`Commit refused: ${verdict.message} (${verdict.code}).`, true);
    state.confirming = false;
    render();
    return;
  }
  const next = resolveTurn(battle, { type: 'commit', submission });
  state.battle = next;
  state.confirming = false;
  state.awaitingHandoff = true;
  state.handoffSide = next.activeSide;
  state.announcement = '';
  setStatus(`Turn resolved · ${sideName(state.scenario, next.activeSide)} to move.`);
  render();
  toast(`Turn ${battle.turnNumber} resolved.`);
}

// --- Read-only map navigation ------------------------------------------------
// Display-only: zooming, panning, fitting, and toggling the grid never touch
// the battle or the scenario.
function setBattleMapView(patch) {
  state.mapView = { ...state.mapView, ...patch };
  render();
}

function svgToMap(svg, clientX, clientY) {
  const point = new DOMPoint(clientX, clientY);
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const local = point.matrixTransform(matrix.inverse());
  const height = state.scenario?.battlefield?.height;
  if (!Number.isFinite(height)) return null;
  return { x: local.x, y: height - local.y };
}

function updateBattleMapDom() {
  const svg = $('#battle-svg');
  const viewport = $('#map-viewport');
  if (!svg || !viewport || !state.scenario) return;
  const rect = viewport.getBoundingClientRect();
  if (rect.width > 0) state.mapView.viewportW = rect.width;
  const box = mapViewBox(state.mapView, state.scenario.battlefield);
  const mpp = box.width / (rect.width > 0 ? rect.width : state.mapView.viewportW || 800);
  const scaleBar = $('#scale-bar');
  const scaleLabel = $('#scale-bar-label');
  if (scaleBar && scaleLabel) {
    const targetPx = 120;
    const raw = mpp * targetPx;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const candidates = [1, 2, 5, 10];
    let best = candidates[0] * magnitude;
    for (const candidate of candidates) {
      if (Math.abs(candidate * magnitude - raw) < Math.abs(best - raw)) {
        best = candidate * magnitude;
      }
    }
    scaleBar.style.width = `${best / mpp}px`;
    scaleLabel.textContent = best >= 1000 ? `${best / 1000} km` : `${best} m`;
  }
}

function bindBattleMap() {
  const svg = $('#battle-svg');
  const viewport = $('#map-viewport');
  if (!svg || !viewport || !state.scenario) return;
  const rect = viewport.getBoundingClientRect();
  if (rect.width > 0) state.mapView.viewportW = rect.width;

  svg.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault();
      const cursor = svgToMap(svg, event.clientX, event.clientY);
      if (!cursor) return;
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      const next = zoomViewAroundCursor(state.mapView, cursor, state.mapView.zoom * factor);
      setBattleMapView(next);
    },
    { passive: false },
  );

  let pan = null;
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    const cursor = svgToMap(svg, event.clientX, event.clientY);
    if (!cursor) return;
    pan = { x: event.clientX, y: event.clientY, moved: false };
    svg.setPointerCapture?.(event.pointerId);
  });
  svg.addEventListener('pointermove', (event) => {
    const coords = $('#cursor-coords');
    if (coords) {
      const cursor = svgToMap(svg, event.clientX, event.clientY);
      if (cursor) {
        const inside =
          cursor.x >= 0 &&
          cursor.x <= state.scenario.battlefield.width &&
          cursor.y >= 0 &&
          cursor.y <= state.scenario.battlefield.height;
        coords.textContent = `X ${Math.round(cursor.x)} · Y ${Math.round(cursor.y)}`;
        coords.classList.toggle('outside', !inside);
      }
    }
    if (!pan) return;
    if (Math.hypot(event.clientX - pan.x, event.clientY - pan.y) > 3) pan.moved = true;
    if (!pan.moved) return;
    const rectNow = viewport.getBoundingClientRect();
    const widthPx = rectNow.width > 0 ? rectNow.width : state.mapView.viewportW || 800;
    const box = mapViewBox(state.mapView, state.scenario.battlefield);
    const mpp = box.width / widthPx;
    setBattleMapView(
      panMapViewByPixels(state.mapView, -(event.clientX - pan.x), event.clientY - pan.y, mpp),
    );
    pan = { x: event.clientX, y: event.clientY, moved: true };
  });
  const endPan = () => {
    pan = null;
  };
  svg.addEventListener('pointerup', endPan);
  svg.addEventListener('pointercancel', endPan);
}

// --- Actions -----------------------------------------------------------------

document.addEventListener('click', async (event) => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  const { action } = element.dataset;
  if (action === 'begin') {
    beginBattle();
    return;
  }
  if (action === 'commit-empty') {
    state.confirming = true;
    render();
    return;
  }
  if (action === 'cancel-commit') {
    state.confirming = false;
    render();
    return;
  }
  if (action === 'confirm-commit') {
    commitHumanTurn();
    return;
  }
  if (action === 'resolve-automated') {
    // "Continue" after the handoff wait: the automated turn resolves at once.
    state.awaitingHandoff = false;
    state.handoffSide = null;
    render();
    await maybeResolveAutomated();
    return;
  }
  if (action === 'handoff') {
    // The device handoff: pressing "<Side> — begin your turn" unlocks
    // drafting for a human side, or resolves an automated side at once.
    state.awaitingHandoff = false;
    state.handoffSide = null;
    state.confirming = false;
    state.announcement = '';
    render();
    await maybeResolveAutomated();
    return;
  }
  if (action === 'zoom-in') {
    const centre = {
      x: state.scenario.battlefield.width / 2,
      y: state.scenario.battlefield.height / 2,
    };
    setBattleMapView(zoomViewAroundCursor(state.mapView, centre, state.mapView.zoom * 1.25));
    return;
  }
  if (action === 'zoom-out') {
    const centre = {
      x: state.scenario.battlefield.width / 2,
      y: state.scenario.battlefield.height / 2,
    };
    setBattleMapView(zoomViewAroundCursor(state.mapView, centre, state.mapView.zoom / 1.25));
    return;
  }
  if (action === 'fit-view') {
    setBattleMapView({
      ...fitMapView(state.scenario.battlefield),
      showGrid: state.mapView.showGrid,
      viewportW: state.mapView.viewportW,
    });
    return;
  }
  if (action === 'toggle-grid') {
    setBattleMapView({ showGrid: !(state.mapView?.showGrid !== false) });
  }
});

document.addEventListener('change', (event) => {
  const side = event.target?.dataset?.controllerSide;
  if (side) {
    state.controllers[side] = event.target.value;
    return;
  }
});

window.addEventListener('resize', () => {
  if (state.battle) updateBattleMapDom();
});

// --- Init --------------------------------------------------------------------

async function init() {
  const params = new URLSearchParams(location.search);
  state.scenarioId = params.get('id');
  state.seedOverride = parseSeedParam(params.get('seed'));
  if (!state.scenarioId) {
    state.loadError = 'No scenario was requested (missing ?id=). Start a battle from the library or the editor.';
    render();
    return;
  }
  try {
    const scenario = await state.store.load(state.scenarioId);
    if (!scenario) {
      state.loadError = 'Scenario not found. It may have been deleted.';
      render();
      return;
    }
    state.scenario = scenario;
    const sides = scenario.sides || [];
    state.controllers = {
      [sides[0]?.id]: 'human',
      [sides[1]?.id]: sides[1] ? 'passive' : 'human',
    };
  } catch (error) {
    state.loadError = `Could not load the scenario: ${error.message}`;
  }
  render();
  console.info('[PÓLIS battle]', { scenario: state.scenarioId });
}

init();

// Programmatic hooks for tests and the end-to-end harness: the seed is always
// set through code (the `?seed=` parameter or `beginWithSeed`), never through
// a field in the UI, and the seed value itself is never rendered.
window.__battle = {
  get state() {
    return state;
  },
  beginWithSeed(seed) {
    beginBattle(seed);
  },
};
