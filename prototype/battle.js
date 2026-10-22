// PÓLIS tracer bullet — battle player: setup, Begin, and turn-by-turn play.
//
// A player starts a battle from a saved scenario, assigns controllers, and
// plays turns on one shared device, handing over after each resolved turn.
// A human side drafts Move orders on the map with live engine validation,
// ghost previews, and inline rejections, then commits the turn. The battle
// screen is separate from the editor and follows layout A: order of battle
// and the turn draft on the left, the map in the centre, the turn panel with
// the unit inspector on the right, plus a permanent turn bar. The map keeps
// the editor's navigation (zoom, pan, grid, fit); only the Orders phase is
// interactive.
//
// The UI holds no legality rules: playability comes from
// `validatePlayability`, the orders summary and the per-unit inspector from
// `availableActions`, and every draft change and every commit is validated by
// `validateTurn` / resolved by `resolveTurn` (human) or the runner's `runTurn`
// (automated). The seed is drawn at Begin and never shown; tests and the
// end-to-end harness set it programmatically through the `?seed=` query
// parameter (there is no seed field in the UI).
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
import { isBattleFinished } from './domain/battles.js';
import { generateId } from './domain/scenario.js';
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
  normalizeFacing,
  panMapViewByPixels,
  pickUnitIdAtPoint,
  snapFacing,
  toScreenPoint,
  unitFacingDeg,
  unitFootprint,
  unitPosition,
  zoomViewAroundCursor,
  UNIT_PICK_TOLERANCE_PX,
} from './domain/scenario.js';
import { round1 } from './domain/geometry.js';
import { IndexedDBScenarioStore } from './library/idb.js';
import { IndexedDBBattleStore } from './library/battles-idb.js';

// Controllers offered per side. Random and Passive are labelled as test
// players; the engine accepts `human`, `random`, `passive`, and `automated`.
const CONTROLLER_OPTIONS = [
  { value: 'human', label: 'Human' },
  { value: 'random', label: 'Random (test player)' },
  { value: 'passive', label: 'Passive (test player)' },
];

const state = {
  store: new IndexedDBScenarioStore(),
  battleStore: new IndexedDBBattleStore(),
  scenarioId: null,
  battleResumeId: null,
  seedOverride: null,
  scenario: null,
  loadError: '',
  battleLoadError: '',
  // Setup-screen controller choice per side id.
  controllers: {},
  // Playability refusal: every problem from `validatePlayability`.
  problems: [],
  // The live battle once Begin succeeds. The seed is drawn at Begin and is
  // never rendered.
  battle: null,
  // The durable battle id (the Battles list keys battles by this id) and the
  // committed turn decisions that produced the stored battle state. Every
  // committed turn appends its decision and re-saves both together.
  battleId: null,
  decisions: [],
  // Battles already stored on this device, for the setup-screen resume list.
  battles: [],
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
  // Move drafting (human side, Orders phase only). `drafts` is the ordered
  // turn draft: [{ key, unitId, legs: [{ face | null, to | null }] }], at most
  // one draft per unit, re-validated by `validateTurn` on every change.
  // `selectedUnitId` drives the inspector and the active draft; both are
  // display-only and reset on Begin, handoff, commit, and resume.
  selectedUnitId: null,
  drafts: [],
  draftSeq: 1,
  validation: null,
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

// --- Move drafting (human side, Orders phase only) ---------------------------
// The draft is an ordered list of Move orders, at most one per unit. Every
// mutation rebuilds a turn submission in draft order and calls `validateTurn`
// against the authoritative battle state, so the verdicts (accepted previews
// and inline rejections with `details` highlights) always describe the current
// draft. Units without a draft hold implicitly: the submission carries only
// the drafted Moves, and an empty draft list is the empty turn.

function canDraftOrders() {
  const battle = state.battle;
  if (!battle || state.awaitingHandoff || state.resolving || state.confirming) return false;
  if (isBattleFinished(battle)) return false;
  if (battle.phase !== TURN_PHASE_ORDERS) return false;
  return !isAutomatedController(controllerOf(battle, battle.activeSide));
}

function ownBattleUnit(unitId) {
  const battle = state.battle;
  if (!battle) return null;
  return (battle.units || []).find((unit) => unit?.id === unitId && unit?.side === battle.activeSide) || null;
}

function draftForUnit(unitId) {
  return state.drafts.find((draft) => draft.unitId === unitId) || null;
}

function pruneDraftSelection() {
  if (!state.battle) {
    state.selectedUnitId = null;
    state.drafts = [];
    state.validation = null;
    return;
  }
  const ownIds = new Set((state.battle.units || []).filter((unit) => unit?.side === state.battle.activeSide).map((unit) => unit?.id));
  state.drafts = state.drafts.filter((draft) => ownIds.has(draft.unitId));
  if (state.selectedUnitId && !ownIds.has(state.selectedUnitId)) {
    state.selectedUnitId = null;
  }
}

function buildDraftSubmission() {
  const battle = state.battle;
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders: state.drafts.map((draft) => ({
      unitId: draft.unitId,
      kind: 'Move',
      legs: draft.legs.map((leg) => ({ ...(leg.face === null || leg.face === undefined ? {} : { face: leg.face }), ...(leg.to ? { to: { ...leg.to } } : {}) })),
    })),
  };
}

// Every change to the draft calls `validate`: pure, never throws for a
// missing battle, and stores the per-order verdicts for the panels and the
// map ghosts/highlights.
function revalidateDrafts() {
  if (!state.battle) {
    state.validation = null;
    return state.validation;
  }
  try {
    state.validation = validateTurn(state.battle, buildDraftSubmission());
  } catch {
    state.validation = null;
  }
  return state.validation;
}

function verdictForDraftIndex(index) {
  const verdicts = state.validation?.verdicts;
  if (!Array.isArray(verdicts)) return null;
  return verdicts.find((verdict) => verdict?.orderIndex === index) || null;
}

// Units named as the conflict by a rejection (`details.withUnitId`), plus the
// mover-side points (`details.at`) drawn as map markers.
function conflictUnitIds() {
  const ids = new Set();
  for (const verdict of state.validation?.verdicts || []) {
    const details = verdict?.accepted === false ? verdict?.rejection?.details : null;
    if (details && typeof details.withUnitId === 'string') ids.add(details.withUnitId);
    if (details && typeof details.unitId === 'string' && verdict?.accepted === false) {
      // The rejected mover itself is outlined by its draft row; only the other
      // unit is a map conflict. Keep the mover out unless it is someone else's
      // conflict partner.
    }
  }
  return ids;
}

function conflictPoints() {
  const points = [];
  for (const verdict of state.validation?.verdicts || []) {
    if (verdict?.accepted !== false) continue;
    const details = verdict?.rejection?.details;
    if (details && details.at && Number.isFinite(details.at?.x) && Number.isFinite(details.at?.y)) {
      points.push({ x: details.at.x, y: details.at.y, unitId: verdict.unitId });
    }
  }
  return points;
}

function actionsEntryFor(unitId) {
  if (!state.battle) return null;
  try {
    const actions = availableActions(state.battle, state.battle.activeSide);
    return (actions.units || []).find((entry) => entry.unitId === unitId) || null;
  } catch {
    return null;
  }
}

function startMoveDraft(unitId) {
  if (!canDraftOrders()) return false;
  const unit = ownBattleUnit(unitId);
  if (!unit) return false;
  if (draftForUnit(unitId)) {
    state.selectedUnitId = unitId;
    return true;
  }
  state.drafts = [...state.drafts, { key: `draft-${state.draftSeq++}`, unitId, legs: [] }];
  state.selectedUnitId = unitId;
  state.confirming = false;
  revalidateDrafts();
  render();
  return true;
}

function removeMoveDraft(unitId) {
  const next = state.drafts.filter((draft) => draft.unitId !== unitId);
  if (next.length === state.drafts.length) return false;
  state.drafts = next;
  state.confirming = false;
  revalidateDrafts();
  render();
  return true;
}

function moveDraft(unitId, direction) {
  const index = state.drafts.findIndex((draft) => draft.unitId === unitId);
  const other = index + direction;
  if (index < 0 || other < 0 || other >= state.drafts.length) return false;
  const next = [...state.drafts];
  [next[index], next[other]] = [next[other], next[index]];
  state.drafts = next;
  state.confirming = false;
  revalidateDrafts();
  render();
  return true;
}

function appendDraftLeg(unitId, point) {
  if (!canDraftOrders()) return false;
  const draft = draftForUnit(unitId);
  if (!draft) return false;
  if (draft.legs.length >= 3) return false;
  const snapped = { x: round1(point.x), y: round1(point.y) };
  if (!Number.isFinite(snapped.x) || !Number.isFinite(snapped.y)) return false;
  draft.legs = [...draft.legs, { face: null, to: snapped }];
  state.confirming = false;
  revalidateDrafts();
  render();
  return true;
}

function removeLastDraftLeg(unitId) {
  const draft = draftForUnit(unitId);
  if (!draft || draft.legs.length === 0) return false;
  draft.legs = draft.legs.slice(0, -1);
  state.confirming = false;
  revalidateDrafts();
  render();
  return true;
}

function clearDraftLegs(unitId) {
  const draft = draftForUnit(unitId);
  if (!draft) return false;
  draft.legs = [];
  state.confirming = false;
  revalidateDrafts();
  render();
  return true;
}

function setDraftFacing(unitId, raw) {
  const draft = draftForUnit(unitId);
  if (!draft) return false;
  if (String(raw ?? '').trim() === '') {
    // Clearing the facing removes the rotation from every leg.
    draft.legs = draft.legs.map((leg) => ({ face: null, ...(leg.to ? { to: { ...leg.to } } : {}) }));
    state.confirming = false;
    revalidateDrafts();
    render();
    return true;
  }
  if (!Number.isFinite(Number(raw))) return false;
  const face = normalizeFacing(round1(Number(raw)));
  if (draft.legs.length === 0) {
    draft.legs = [{ face, to: null }];
  } else {
    draft.legs = draft.legs.map((leg, index) => (
      index === draft.legs.length - 1 ? { face, ...(leg.to ? { to: { ...leg.to } } : {}) } : leg
    ));
  }
  state.confirming = false;
  revalidateDrafts();
  render();
  return true;
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

// --- Map (editor navigation plus Move drafting) -------------------------------
// The renderer mirrors the editor's true-scale drawing (ADR 0001): map
// coordinates (origin south-west, metres) flip to screen through
// `toScreenPoint`, and unit footprints are never enlarged for display. The
// camera (zoom, pan, grid, fit) stays display-only; during a human Orders
// phase the map is also the drafting surface: clicking an own unit selects
// it, clicking open ground appends a leg point (up to three) to the selected
// unit's Move draft, and the rotation handle pivots the draft's facing.
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

function battleUnitSvg(document, unit, mapView, mpp, flags = {}) {
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
  // Rotation handle for the selected drafting unit: a stem forward of the
  // front edge with a grab circle. Dragging pivots the draft facing about the
  // front midpoint (15° snapping, Shift for free rotation); the facing field
  // in the turn panel edits the same value.
  const reach = 20 * mpp;
  const gripR = 7 * mpp;
  const handle = flags.drafting
    ? `<line x1="0" y1="0" x2="0" y2="${-reach}" stroke="${esc(color)}" stroke-width="${1.6 * mpp}" stroke-dasharray="${4 * mpp} ${3 * mpp}" class="rotate-stem"/>` +
      `<circle cx="0" cy="${-reach}" r="${12 * mpp}" fill="transparent" class="rotate-hit" data-rotate-handle="${esc(unit.id || '')}"><title>Drag to rotate the draft (snaps to 15°, hold Shift for free rotation)</title></circle>` +
      `<circle cx="0" cy="${-reach}" r="${gripR}" fill="#f8f9f0" stroke="${esc(color)}" stroke-width="${2 * mpp}" class="rotate-grip" data-rotate-handle="${esc(unit.id || '')}"><title>Drag to rotate the draft (snaps to 15°, hold Shift for free rotation)</title></circle>`
    : '';
  const classes = ['unit'];
  if (flags.selected) classes.push('selected');
  if (flags.conflict) classes.push('conflict');
  const outline = flags.conflict ? '#b91c1c' : esc(color);
  return `<g class="${classes.join(' ')}" transform="translate(${centre.x} ${centre.y})" data-unit-id="${esc(unit.id || '')}">
    <g class="unit-rotor" transform="rotate(${facing})">
      ${helper}
      <rect x="${-frontW / 2}" y="0" width="${frontW}" height="${depthH}" fill="${esc(color)}" fill-opacity="0.32" stroke="${outline}" stroke-width="${(flags.selected || flags.conflict ? 3 : 1.6) * mpp}" class="unit-footprint"/>
      <line x1="${-frontW / 2}" y1="0" x2="${frontW / 2}" y2="0" stroke="${outline}" stroke-width="${3 * mpp}"/>
      ${handle}
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
  const conflicts = conflictUnitIds();
  const drafting = canDraftOrders();
  const activeDraft = state.selectedUnitId ? draftForUnit(state.selectedUnitId) : null;

  // Ghost footprints for accepted drafts (Movement-phase previews) and leg
  // paths for every draft; rejected drafts draw in red with their message in
  // the draft list. Conflict points from `details.at` draw as red markers.
  let draftSvg = '';
  if (state.battle && state.validation?.verdicts) {
    state.validation.verdicts.forEach((verdict) => {
      if (!verdict?.accepted || !verdict.preview?.corners) return;
      const corners = verdict.preview.corners;
      if (!Array.isArray(corners) || corners.length < 3) return;
      draftSvg += `<polygon points="${project(corners)}" fill="#4e6047" fill-opacity="0.14" stroke="#4e6047" stroke-width="${2 * mpp}" stroke-dasharray="${7 * mpp} ${4 * mpp}" class="draft-ghost" data-ghost-unit="${esc(verdict.unitId || '')}"><title>Ghost: ${esc(verdict.unitId || '')} Movement-phase preview</title></polygon>`;
    });
  }
  for (const draft of state.drafts) {
    const mover = battleUnits.find((unit) => unit?.id === draft.unitId);
    const start = mover ? unitPosition(mover) : null;
    const stops = (draft.legs || []).filter((leg) => leg.to).map((leg) => leg.to);
    if (start && stops.length > 0) {
      const line = [start, ...stops].map((point) => {
        const screen = toScreen(point.x, point.y);
        return `${screen.x},${screen.y}`;
      }).join(' ');
      const index = state.drafts.indexOf(draft);
      const verdict = verdictForDraftIndex(index);
      const rejected = verdict && verdict.accepted === false;
      draftSvg += `<polyline points="${line}" fill="none" stroke="${rejected ? '#b91c1c' : '#4e6047'}" stroke-width="${2 * mpp}" stroke-dasharray="${rejected ? `${3 * mpp} ${3 * mpp}` : `${7 * mpp} ${4 * mpp}`}" class="draft-path${rejected ? ' rejected' : ''}"/>`;
      draftSvg += stops.map((stop, legIndex) => {
        const screen = toScreen(stop.x, stop.y);
        return `<circle cx="${screen.x}" cy="${screen.y}" r="${5 * mpp}" fill="${rejected ? '#b91c1c' : '#4e6047'}" stroke="#f8f9f0" stroke-width="${1.5 * mpp}" class="draft-vertex"><title>Leg ${legIndex + 1} · (${stop.x.toFixed(1)}, ${stop.y.toFixed(1)})</title></circle>`;
      }).join('');
    }
  }
  for (const point of conflictPoints()) {
    const screen = toScreen(point.x, point.y);
    draftSvg += `<circle cx="${screen.x}" cy="${screen.y}" r="${8 * mpp}" fill="none" stroke="#b91c1c" stroke-width="${2.5 * mpp}" class="conflict-marker"><title>Conflict at (${point.x.toFixed(1)}, ${point.y.toFixed(1)})</title></circle>`;
  }

  return `<svg id="battle-svg" viewBox="${viewBox}" role="img" aria-label="Battlefield, ${widthM} by ${heightM} metres, origin south-west" data-zoom="${zoom}">
    <rect x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}" fill="#dfddce"/>
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="#e8e5d5"/>
    <g id="map-grid-group" style="display:${showGrid ? 'block' : 'none'}">${grid}</g>
    ${terrain}
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="none" stroke="#6f7a65" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${xLabels}${yLabels}
    <g id="map-drafts-group">${draftSvg}</g>
    <g id="map-units-group">${placed.map((unit) => battleUnitSvg(document, unit, mapView, mpp, { selected: unit?.id === state.selectedUnitId, conflict: conflicts.has(unit?.id), drafting: drafting && unit?.id === state.selectedUnitId && !!activeDraft })).join('')}</g>
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

// Battles already stored on this device: reloading the page mid-battle and
// choosing a battle here resumes the identical state. Finished battles stay
// on the list as read-only and can be deleted from the library.
function battlesListView() {
  const battles = Array.isArray(state.battles) ? state.battles : [];
  if (battles.length === 0) {
    return `<section class="setup-card" data-testid="battles-list">
      <h2>Battles</h2>
      <p class="setup-meta">No battles yet. Begin a battle above and every committed turn is saved here.</p>
    </section>`;
  }
  const items = battles
    .map((entry) => {
      const finished = entry.status !== 'ongoing';
      const detail = `turn ${entry.turnNumber ?? '—'} · ${esc(entry.status)}${finished ? ' · read-only' : ''}`;
      const action = finished ? 'View' : 'Resume';
      return `<li>
        <span><strong>${esc(entry.title)}</strong><br><span class="side-id">${detail}</span></span>
        <span class="handoff-actions">
          <a class="btn-secondary" data-testid="resume-${esc(entry.id)}" href="battle.html?battle=${encodeURIComponent(entry.id)}">${action}</a>
          <button class="btn-quiet" data-testid="delete-${esc(entry.id)}" data-action="delete-battle" data-id="${esc(entry.id)}">Delete</button>
        </span>
      </li>`;
    })
    .join('');
  return `<section class="setup-card" data-testid="battles-list">
    <h2>Battles</h2>
    <p class="setup-meta">Battles survive reloads: every committed turn is saved. Finished battles stay read-only.</p>
    <ul class="problem-list">${items}</ul>
  </section>`;
}

function setupView() {
  const scenario = state.scenario;
  if (!scenario) {
    const resumeError = state.battleLoadError
      ? `<div class="refusal" data-testid="battle-load-error"><p>${esc(state.battleLoadError)}</p></div>`
      : '';
    return `<div class="setup">
      <span class="eyebrow">PÓLIS · BATTLE SETUP</span>
      <h1>${state.battleResumeId ? 'Battle not found' : 'Scenario not found'}</h1>
      <p class="lede">${esc(state.battleLoadError || state.loadError || 'The requested scenario could not be loaded.')}</p>
      ${resumeError}
      <div class="setup-actions"><a class="btn-secondary" href="editor.html">← Library</a></div>
      ${battlesListView()}
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
    ${battlesListView()}
  </div>`;
}

function draftLegSummary(draft) {
  const stops = (draft.legs || []).filter((leg) => leg.to);
  const faces = (draft.legs || []).filter((leg) => leg.face !== null && leg.face !== undefined);
  const parts = [];
  parts.push(`${stops.length} ${stops.length === 1 ? 'leg' : 'legs'}`);
  if (faces.length > 0) {
    parts.push(`face ${faces[faces.length - 1].face}°`);
  }
  return parts.join(' · ');
}

function draftListView() {
  const battle = state.battle;
  if (!battle || isAutomatedController(controllerOf(battle, battle.activeSide))) return '';
  if (state.awaitingHandoff) {
    return `<section class="draft-list" aria-label="Turn draft" data-testid="draft-list">
      <span class="eyebrow">TURN DRAFT</span>
      <h3>Draft (${state.drafts.length})</h3>
      <p class="readonly-note">Turn committed — the draft is locked until ${esc(sideName(state.scenario, state.handoffSide || battle.activeSide))} begins their turn.</p>
    </section>`;
  }
  if (state.drafts.length === 0) {
    return `<section class="draft-list" aria-label="Turn draft" data-testid="draft-list">
      <span class="eyebrow">TURN DRAFT</span>
      <h3>Draft (0)</h3>
      <p class="empty-draft">No Move orders yet. Select one of your units, then click the map for up to three leg points.</p>
    </section>`;
  }
  const rows = state.drafts.map((draft, index) => {
    const unit = (battle.units || []).find((entry) => entry?.id === draft.unitId);
    const verdict = verdictForDraftIndex(index);
    const accepted = verdict?.accepted === true;
    const rejection = verdict && verdict.accepted === false ? verdict.rejection : null;
    const classes = ['draft-row'];
    if (draft.unitId === state.selectedUnitId) classes.push('selected');
    if (rejection) classes.push('rejected');
    else if (accepted) classes.push('accepted');
    const status = rejection
      ? `<p class="field-error" role="alert" data-testid="draft-rejection-${esc(draft.unitId)}">${esc(rejection.message)}</p>`
      : accepted && verdict?.movement
        ? `<p class="draft-ok" data-testid="draft-accepted-${esc(draft.unitId)}">Accepted · needs ${esc(String(verdict.movement.requiredM))} m of ${esc(String(verdict.movement.availableM))} m.</p>`
        : accepted
          ? `<p class="draft-ok" data-testid="draft-accepted-${esc(draft.unitId)}">Accepted.</p>`
          : `<p class="draft-pending">Validating…</p>`;
    return `<li class="${classes.join(' ')}" data-testid="draft-${esc(draft.unitId)}">
      <div class="draft-head">
        <button class="draft-select" data-action="select-unit" data-id="${esc(draft.unitId)}" title="Edit this order">${esc(unit?.name || draft.unitId)}</button>
        <span class="draft-meta">${esc(draftLegSummary(draft))} · order ${index + 1}</span>
      </div>
      ${status}
      <div class="draft-actions">
        <button class="btn-quiet" data-action="move-draft-up" data-id="${esc(draft.unitId)}"${index === 0 ? ' disabled' : ''} title="Move earlier (re-validates)">↑</button>
        <button class="btn-quiet" data-action="move-draft-down" data-id="${esc(draft.unitId)}"${index === state.drafts.length - 1 ? ' disabled' : ''} title="Move later (re-validates)">↓</button>
        <button class="btn-quiet btn-danger" data-action="remove-draft" data-id="${esc(draft.unitId)}" title="Remove this order (re-validates)">Remove</button>
      </div>
    </li>`;
  }).join('');
  return `<section class="draft-list" aria-label="Turn draft" data-testid="draft-list">
    <span class="eyebrow">TURN DRAFT</span>
    <h3>Draft (${state.drafts.length})</h3>
    <ol class="draft-rows">${rows}</ol>
    <p class="readonly-note">Order matters: each Move validates against the state left by the orders before it. Reordering re-validates.</p>
  </section>`;
}

function orderOfBattleView(document) {
  const battle = state.battle;
  const units = Array.isArray(battle?.units) ? battle.units : document.units || [];
  const unitsOf = (sideId) => units.filter((unit) => unit?.side === sideId);
  const conflicts = conflictUnitIds();
  const drafting = battle ? canDraftOrders() : false;
  return `<div class="panel"><span class="eyebrow">FORCES IN THE FIELD</span><h2>Order of battle</h2>
    ${(document.sides || [])
      .map((side) => {
        const sideUnits = unitsOf(side.id);
        const soldiers = sideUnits.reduce((sum, unit) => sum + (Number(unit?.soldiers) || 0), 0);
        const own = battle ? side.id === battle.activeSide : false;
        return `<div class="side">
          <div class="side-name"><span class="swatch" style="background:${esc(side.color)}"></span>${esc(side.name)}${own && drafting ? ' · your turn' : ''}</div>
          <p class="side-count">${sideUnits.length} ${sideUnits.length === 1 ? 'unit' : 'units'} · ${soldiers.toLocaleString('en')} soldiers</p>
          ${sideUnits
            .map((unit) => {
              const hasDraft = state.drafts.some((draft) => draft.unitId === unit?.id);
              const classes = ['unit-row', own && drafting ? 'selectable' : 'readonly'];
              if (unit?.id === state.selectedUnitId) classes.push('selected');
              if (conflicts.has(unit?.id)) classes.push('conflict');
              const detail = `${esc(troopDisplayName(unit?.troopType))} · ${esc(unit?.soldiers)} soldiers · ${esc(unit?.cohesion || '')}${unit?.engaged?.unitId ? ` · Engaged (${esc(unit.engaged.aspect || unit.engaged.edge || '')})` : ''}${hasDraft ? ' · has draft' : ''}`;
              if (own && drafting) {
                return `<button class="${classes.join(' ')}" data-action="select-unit" data-id="${esc(unit?.id || '')}" aria-pressed="${String(unit?.id === state.selectedUnitId)}" data-testid="oob-${esc(unit?.id || '')}"><span class="swatch" style="background:${esc(side.color)}"></span><span><span class="unit-name">${esc(unit?.name || 'Unit')}</span><span class="unit-detail">${detail}</span></span></button>`;
              }
              return `<div class="${classes.join(' ')}"><span class="swatch" style="background:${esc(side.color)}"></span><div><div class="unit-name">${esc(unit?.name || 'Unit')}</div><div class="unit-detail">${detail}</div></div></div>`;
            })
            .join('')}
        </div>`;
      })
      .join('')}
    ${draftListView()}
    <p class="readonly-note">The battle keeps the scenario's units throughout. Select one of your units to inspect its orders and draft a Move.</p>
  </div>`;
}

function inspectorView() {
  const battle = state.battle;
  if (!battle || !state.selectedUnitId) return '';
  const unit = (battle.units || []).find((entry) => entry?.id === state.selectedUnitId);
  if (!unit || unit.side !== battle.activeSide) return '';
  const entry = actionsEntryFor(unit.id);
  if (!entry) return '';
  const permitted = (entry.permitted || []).map((item) => esc(item.kind)).join(', ') || '—';
  const unavailable = (entry.unavailable || [])
    .map((item) => `<li><strong>${esc(item.kind)}</strong> — ${esc(item.reason || item.code || 'unavailable')}</li>`)
    .join('');
  const allowance = Number.isFinite(entry.movementAllowanceM) ? `${entry.movementAllowanceM.toLocaleString('en')} m` : '—';
  return `<section class="inspector" aria-label="Selected unit" data-testid="inspector-${esc(unit.id)}">
    <span class="eyebrow">INSPECTOR · YOUR UNIT</span>
    <h3>${esc(unit.name || 'Unit')}</h3>
    <div class="kv"><dt>Permitted orders</dt><dd data-testid="permitted-${esc(unit.id)}">${permitted}</dd></div>
    <div class="kv"><dt>Movement allowance</dt><dd data-testid="allowance-${esc(unit.id)}">${allowance}</dd></div>
    ${unavailable ? `<ul class="unavailable" data-testid="unavailable-${esc(unit.id)}">${unavailable}</ul>` : ''}
  </section>`;
}

function draftEditorView() {
  const battle = state.battle;
  if (!battle || !canDraftOrders() || !state.selectedUnitId) return '';
  const unit = ownBattleUnit(state.selectedUnitId);
  if (!unit) return '';
  const entry = actionsEntryFor(unit.id);
  const movePermitted = (entry?.permitted || []).some((item) => item.kind === 'Move');
  const draft = draftForUnit(unit.id);
  const legs = draft ? draft.legs : [];
  const lastFace = [...legs].reverse().find((leg) => leg.face !== null && leg.face !== undefined)?.face;
  const legRows = legs.length === 0
    ? '<li class="leg-empty">No legs yet — click the map for leg 1.</li>'
    : legs.map((leg, index) => `<li>Leg ${index + 1}: ${leg.to ? `(${leg.to.x.toFixed(1)}, ${leg.to.y.toFixed(1)})` : 'rotation only'}${leg.face !== null && leg.face !== undefined ? ` · face ${leg.face}°` : ''}</li>`).join('');
  const draftButton = draft
    ? ''
    : `<button class="btn-primary" data-action="start-draft" data-id="${esc(unit.id)}" data-testid="start-draft-${esc(unit.id)}"${movePermitted ? '' : ' disabled'}>Draft Move</button>`;
  return `<section class="draft-editor" aria-label="Move draft" data-testid="draft-editor-${esc(unit.id)}">
    <span class="eyebrow">MOVE DRAFT</span>
    ${draftButton}
    ${draft ? `<ol class="leg-list">${legRows}</ol>
    <p class="draft-hint">Click the map for leg ${legs.length + 1} (up to 3) · drag the round handle or type a facing to rotate about the front midpoint.</p>
    <label class="field">Facing (°)<input type="number" data-draft-facing data-id="${esc(unit.id)}" min="0" max="360" step="1" value="${lastFace ?? ''}" placeholder="—"></label>
    <div class="draft-actions">
      <button class="btn-secondary" data-action="remove-last-leg" data-id="${esc(unit.id)}"${legs.length === 0 ? ' disabled' : ''}>Undo leg</button>
      <button class="btn-secondary" data-action="clear-legs" data-id="${esc(unit.id)}"${legs.length === 0 ? ' disabled' : ''}>Clear legs</button>
      <button class="btn-quiet btn-danger" data-action="remove-draft" data-id="${esc(unit.id)}">Remove order</button>
    </div>` : `${movePermitted ? '<p class="draft-hint">Drafting adds one Move order for this unit; every map click re-validates.</p>' : '<p class="field-error">Move is not permitted for this unit (see inspector).</p>'}`}
  </section>`;
}

function turnPanelView() {
  const battle = state.battle;
  const document = state.scenario;
  const finished = isBattleFinished(battle);
  const events = (battle.events || []).slice(-8).reverse();
  const logList = `<hr class="panel-divider">
    <span class="eyebrow">BATTLE LOG</span>
    <ol class="log-list" data-testid="battle-log">
      ${events.map((event) => `<li>${esc(event.type)} · turn ${esc(event.turnNumber ?? '—')} · ${esc(event.side ?? event.result ?? '')}</li>`).join('')}
    </ol>`;
  // Finished battles stay on the list as read-only: no orders, no commits,
  // only the outcome and the log. Deletion happens from the library.
  if (finished) {
    const winner = battle.winner ? sideName(document, battle.winner) : null;
    const result = battle.result && typeof battle.result === 'object' ? battle.result : null;
    const outcome = winner ? ` · winner ${esc(winner)}` : ' · draw';
    // The engine records machine reasons; the panel shows words.
    const reasonLabels = { break: 'Army break', 'round-limit': 'Round limit', concede: 'Concession' };
    const reasonLabel = result && result.reason ? reasonLabels[result.reason] || result.reason : null;
    const reason = reasonLabel ? `<div class="kv"><dt>Ended by</dt><dd>${esc(reasonLabel)}</dd></div>` : '';
    return `<div class="panel" data-testid="turn-panel">
    <span class="eyebrow">BATTLE OVER</span><h2>${esc(battle.status)}</h2>
    <div class="kv"><dt>Status</dt><dd data-testid="battle-status">${esc(battle.status)}${outcome}</dd></div>
    ${reason}
    <div class="handoff" data-testid="battle-finished">
      <p>This battle is finished and read-only. It stays on the Battles list; delete it from the library.</p>
    </div>
    ${logList}
  </div>`;
  }
  const activeSide = battle.activeSide;
  const controller = controllerOf(battle, activeSide);
  const automated = isAutomatedController(controller);
  // The orders summary comes from the engine, not from UI rules: undrafted
  // units hold, while the summary reports the engine's charge hints and
  // engagements alongside the draft count.
  let ordersSummary = '';
  try {
    const actions = availableActions(battle, activeSide);
    const ownCount = actions.units.length;
    const hints = actions.units.reduce((sum, entry) => sum + entry.chargeCandidates.length, 0);
    const engagedCount = battle.units.filter(
      (unit) => unit.side === activeSide && unit?.engaged?.unitId,
    ).length;
    const extra = [
      hints === 1 ? '1 charge hint' : `${hints} charge hints`,
      engagedCount === 1 ? '1 engaged' : `${engagedCount} engaged`,
    ].join(' · ');
    const draftNote = state.drafts.length === 0
      ? `All ${ownCount} ${ownCount === 1 ? 'unit holds' : 'units hold'} (empty turn)`
      : `${state.drafts.length} Move ${state.drafts.length === 1 ? 'order' : 'orders drafted'}, rest hold`;
    ordersSummary = `<div class="kv"><dt>Orders</dt><dd data-testid="orders-summary">${draftNote} · ${extra}</dd></div>`;
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
    const verdicts = state.validation?.verdicts || [];
    const rejected = verdicts.filter((verdict) => verdict?.accepted === false);
    const allAccepted = state.validation?.ok === true;
    const commitLabel = state.drafts.length === 0 ? 'Commit empty turn' : `Commit turn (${state.drafts.length} Move${state.drafts.length === 1 ? '' : 's'})`;
    const commitTestId = state.drafts.length === 0 ? 'commit-empty' : 'commit-draft';
    const commitAction = state.drafts.length === 0 ? 'commit-empty' : 'commit-draft';
    const commitDisabled = !interactive || !allAccepted;
    const commitHint = !interactive
      ? '<p class="field-error">Only the Orders phase is interactive.</p>'
      : rejected.length > 0
        ? `<p class="field-error" role="alert" data-testid="commit-blocked">${rejected.length} of ${verdicts.length} orders rejected — fix or remove them to commit.</p>`
        : state.drafts.length === 0
          ? '<p class="commit-hint">An empty commit needs confirmation; a committed turn cannot be taken back.</p>'
          : '<p class="commit-hint">Every order is accepted. A committed turn cannot be taken back.</p>';
    actionBox = `${inspectorView()}${draftEditorView()}<div class="handoff-actions">
      <button class="btn-primary" data-testid="${commitTestId}" data-action="${commitAction}"${commitDisabled ? ' disabled' : ''}>${commitLabel}</button>
    </div>
    ${commitHint}`;
  }
  return `<div class="panel" data-testid="turn-panel">
    <span class="eyebrow">TURN ${battle.turnNumber}</span><h2>${esc(sideName(document, activeSide))}</h2>
    <div class="kv"><dt>Controller</dt><dd>${esc(controller)}${automated ? ' (test player)' : ''}</dd></div>
    <div class="kv"><dt>Phase</dt><dd data-testid="phase">${esc(battle.phase)}</dd></div>
    ${ordersSummary}
    ${actionBox}
    ${logList}
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
      <span class="phase">Drafting: Move orders with live validation (Hold, Move, Charge, Reform, and Withdraw validate in the engine)</span>
    </div>
    <main class="workspace">
      <aside class="left-panel">${orderOfBattleView(document)}</aside>
      <section class="map-panel">
        <div class="map-caption">${metres(document.battlefield.width)} × ${metres(document.battlefield.height)} · origin south-west · metres · ${canDraftOrders() ? 'click a unit, then the map for legs' : 'read-only'}</div>
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
        <p class="map-hint">Select your unit · click the map for up to 3 leg points · drag the round handle to rotate · scroll to zoom · drag to pan</p>
      </section>
      <aside class="right-panel">${announcement}${turnPanelView()}</aside>
    </main>`;
}

function render() {
  if (state.battle) {
    pruneDraftSelection();
    revalidateDrafts();
  }
  $('#app').innerHTML = state.battle ? battleView() : setupView();
  if (state.battle) {
    bindBattleMap();
    updateBattleMapDom();
  }
}

// --- Battle persistence --------------------------------------------------------
// Every committed turn is saved to the separate battles collection with the
// scenario snapshot, the ruleset identifier, version, and parameter snapshot,
// the seed, the controller of each side, and the committed turn decisions.
// Reloading mid-battle and choosing the battle from the Battles list resumes
// the identical state; editing the scenario never changes a started battle
// because the battle keeps its own snapshot.
async function saveBattle() {
  if (!state.battle) return null;
  try {
    const metadata = await state.battleStore.save(state.battle, state.decisions);
    state.battles = await state.battleStore.list();
    return metadata;
  } catch (error) {
    toast(`Could not save the battle: ${error.message}`);
    return null;
  }
}

async function refreshBattles() {
  try {
    state.battles = await state.battleStore.list();
  } catch {
    state.battles = [];
  }
}

// --- Setup: Begin ------------------------------------------------------------
// Begin runs playability validation first. A refusal lists every problem
// (each names the unit and the reason, from the engine) and offers "Open in
// editor"; no battle is created. On success the seed is drawn and never shown,
// and the starting side is announced at once.
async function beginBattle(seedOverride = null) {
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
  // The Battles list keys battles by a durable id distinct from the scenario
  // id, so two battles from one scenario never overwrite each other. The
  // battle keeps the scenario id inside its snapshot.
  const battleId = generateId();
  try {
    state.battle = startBattle(scenario, { seed, controllers, battleId });
  } catch (error) {
    if (error instanceof BattleStartError) {
      state.problems = error.problems;
      setStatus(`Cannot begin: ${error.problems.length} playability problem${error.problems.length === 1 ? '' : 's'}.`, true);
      render();
      return;
    }
    throw error;
  }
  state.battleId = battleId;
  state.decisions = [];
  state.problems = [];
  state.awaitingHandoff = false;
  state.handoffSide = null;
  state.confirming = false;
  state.selectedUnitId = null;
  state.drafts = [];
  state.draftSeq = 1;
  state.validation = null;
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
  await saveBattle();
  render();
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
  if (isBattleFinished(battle)) return;
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
    state.decisions = [...state.decisions, step.decision];
    state.resolving = false;
    state.awaitingHandoff = true;
    state.handoffSide = step.battle.activeSide;
    state.announcement = '';
    state.selectedUnitId = null;
    state.drafts = [];
    state.validation = null;
    state.confirming = false;
    setStatus(`Turn resolved · ${sideName(state.scenario, step.battle.activeSide)} to move.`);
    render();
    await saveBattle();
    render();
  } catch (error) {
    if (state.resolveToken !== token) return;
    state.resolving = false;
    setStatus(`Automated turn failed: ${error.message}`, true);
    render();
  }
}

async function commitHumanTurn() {
  const battle = state.battle;
  if (!battle || state.awaitingHandoff) return;
  if (isBattleFinished(battle)) return;
  if (!canDraftOrders()) return;
  // The draft submission is validated by the engine before it is committed;
  // the UI adds no legality of its own. Commit is enabled only when every
  // order is accepted; an empty commit needs its confirmation step, while a
  // committed turn cannot be taken back (the draft locks behind the handoff).
  const submission = buildDraftSubmission();
  const verdict = validateTurn(battle, submission);
  state.validation = verdict;
  if (!verdict.ok) {
    setStatus(`Commit refused: ${verdict.message} (${verdict.code}).`, true);
    state.confirming = false;
    render();
    return;
  }
  const decision = { type: 'commit', submission };
  const next = resolveTurn(battle, decision);
  state.battle = next;
  state.decisions = [...state.decisions, decision];
  state.confirming = false;
  state.awaitingHandoff = true;
  state.handoffSide = next.activeSide;
  state.announcement = '';
  state.selectedUnitId = null;
  state.drafts = [];
  state.validation = null;
  setStatus(`Turn resolved · ${sideName(state.scenario, next.activeSide)} to move.`);
  render();
  toast(`Turn ${battle.turnNumber} resolved.`);
  await saveBattle();
  render();
}

// --- Map navigation and Move drafting ------------------------------------------
// Display-only camera (zoom, pan, fit, grid) plus the drafting surface: during
// a human Orders phase clicking an own unit selects it, clicking open ground
// appends a leg point (up to three) to the selected unit's Move draft, and the
// rotation handle pivots the draft facing. Every draft mutation re-validates
// through `validateTurn`.
let battleRotateDrag = null;

function battleMpp() {
  const viewport = $('#map-viewport');
  if (!viewport || !state.scenario) return 1;
  const rect = viewport.getBoundingClientRect();
  const widthPx = rect.width > 0 ? rect.width : state.mapView?.viewportW || 800;
  if (state.mapView) state.mapView.viewportW = widthPx;
  return mapViewBox(state.mapView, state.scenario.battlefield).width / widthPx;
}

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
  const capturePointer = (event) => {
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  };
  svg.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 && event.button !== 1) return;
    const handle = event.target?.closest?.('[data-rotate-handle]');
    const handleId = handle?.dataset?.rotateHandle;
    if (handle && handleId && event.button === 0 && canDraftOrders()) {
      const unit = ownBattleUnit(handleId);
      if (unit && unitPosition(unit)) {
        event.preventDefault();
        battleRotateDrag = {
          unitId: handleId,
          pointerId: event.pointerId,
          startClient: { x: event.clientX, y: event.clientY },
          origin: { ...unitPosition(unit) },
          moved: false,
          previewFacing: undefined,
        };
        capturePointer(event);
        return;
      }
    }
    const cursor = svgToMap(svg, event.clientX, event.clientY);
    if (!cursor) return;
    pan = { x: event.clientX, y: event.clientY, moved: false };
    capturePointer(event);
  });
  svg.addEventListener('pointermove', (event) => {
    const coords = $('#cursor-coords');
    if (coords && !battleRotateDrag?.moved) {
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
    if (battleRotateDrag && event.pointerId === battleRotateDrag.pointerId) {
      if (
        !battleRotateDrag.moved &&
        Math.hypot(event.clientX - battleRotateDrag.startClient.x, event.clientY - battleRotateDrag.startClient.y) <= 4
      ) {
        return;
      }
      battleRotateDrag.moved = true;
      const cursor = svgToMap(svg, event.clientX, event.clientY);
      if (!cursor) return;
      const dx = cursor.x - battleRotateDrag.origin.x;
      const dy = cursor.y - battleRotateDrag.origin.y;
      if (Math.hypot(dx, dy) <= 1e-9) return;
      const raw = (Math.atan2(dx, dy) * 180) / Math.PI;
      const facing = event.shiftKey ? normalizeFacing(raw) : snapFacing(raw);
      battleRotateDrag.previewFacing = facing;
      const rotor = svg.querySelector(
        `g.unit[data-unit-id="${CSS.escape(battleRotateDrag.unitId)}"] .unit-rotor`,
      );
      if (rotor) {
        const display = facing > 180 ? facing - 360 : facing;
        rotor.setAttribute('transform', `rotate(${display})`);
      }
      if (coords) {
        coords.textContent = event.shiftKey
          ? `Facing ${facing.toFixed(1)}° (free rotation)`
          : `Facing ${facing.toFixed(0)}° (snaps to 15°, hold Shift for free)`;
        coords.classList.remove('outside');
      }
      return;
    }
    if (!pan) return;
    if (Math.hypot(event.clientX - pan.x, event.clientY - pan.y) > 3) pan.moved = true;
    if (!pan.moved) return;
    viewport.classList.add('panning');
    const rectNow = viewport.getBoundingClientRect();
    const widthPx = rectNow.width > 0 ? rectNow.width : state.mapView.viewportW || 800;
    const box = mapViewBox(state.mapView, state.scenario.battlefield);
    const mpp = box.width / widthPx;
    setBattleMapView(
      panMapViewByPixels(state.mapView, -(event.clientX - pan.x), event.clientY - pan.y, mpp),
    );
    pan = { x: event.clientX, y: event.clientY, moved: true };
  });
  const endGesture = (event) => {
    if (battleRotateDrag && event.pointerId === battleRotateDrag.pointerId) {
      const drag = battleRotateDrag;
      battleRotateDrag = null;
      if (!drag.moved) {
        render();
        return;
      }
      if (drag.previewFacing !== undefined) {
        setDraftFacing(drag.unitId, drag.previewFacing);
        return;
      }
      render();
      return;
    }
    if (!pan) return;
    const wasClick = !pan.moved;
    pan = null;
    viewport.classList.remove('panning');
    if (!wasClick) return;
    // A click (no drag): unit selection first, then leg drafting on open ground.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const cursor = svgToMap(svg, event.clientX, event.clientY);
    if (!cursor) return;
    const mpp = battleMpp();
    const picked = state.battle
      ? pickUnitIdAtPoint({ units: state.battle.units }, cursor, UNIT_PICK_TOLERANCE_PX * mpp)
      : null;
    if (picked) {
      const unit = (state.battle.units || []).find((entry) => entry?.id === picked);
      if (unit && unit.side === state.battle.activeSide && canDraftOrders()) {
        state.selectedUnitId = picked;
        state.confirming = false;
        render();
        return;
      }
      state.selectedUnitId = null;
      render();
      return;
    }
    if (canDraftOrders() && state.selectedUnitId) {
      const draft = draftForUnit(state.selectedUnitId);
      if (draft && draft.legs.length < 3) {
        appendDraftLeg(state.selectedUnitId, cursor);
        return;
      }
    }
  };
  svg.addEventListener('pointerup', endGesture);
  svg.addEventListener('pointercancel', (event) => {
    if (battleRotateDrag && event.pointerId === battleRotateDrag.pointerId) {
      battleRotateDrag = null;
      render();
      return;
    }
    const wasActive = !!pan;
    pan = null;
    viewport.classList.remove('panning');
    if (wasActive) render();
  });
  svg.addEventListener('pointerleave', () => {
    const coords = $('#cursor-coords');
    if (coords && !pan && !battleRotateDrag?.moved) coords.textContent = 'X — · Y —';
  });
}

// --- Actions -----------------------------------------------------------------

document.addEventListener('click', async (event) => {
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  const { action } = element.dataset;
  if (action === 'begin') {
    await beginBattle();
    return;
  }
  if (action === 'select-unit') {
    const id = element.dataset.id;
    if (!id || !canDraftOrders()) return;
    if (ownBattleUnit(id)) {
      state.selectedUnitId = id;
      state.confirming = false;
      render();
    }
    return;
  }
  if (action === 'start-draft') {
    startMoveDraft(element.dataset.id);
    return;
  }
  if (action === 'remove-draft') {
    removeMoveDraft(element.dataset.id);
    return;
  }
  if (action === 'move-draft-up') {
    moveDraft(element.dataset.id, -1);
    return;
  }
  if (action === 'move-draft-down') {
    moveDraft(element.dataset.id, 1);
    return;
  }
  if (action === 'remove-last-leg') {
    removeLastDraftLeg(element.dataset.id);
    return;
  }
  if (action === 'clear-legs') {
    clearDraftLegs(element.dataset.id);
    return;
  }
  if (action === 'commit-empty') {
    state.confirming = true;
    render();
    return;
  }
  if (action === 'commit-draft') {
    await commitHumanTurn();
    return;
  }
  if (action === 'cancel-commit') {
    state.confirming = false;
    render();
    return;
  }
  if (action === 'confirm-commit') {
    await commitHumanTurn();
    return;
  }
  if (action === 'delete-battle') {
    const id = element.dataset.id;
    if (!id) return;
    if (!window.confirm('Delete this battle? Finished and in-progress battles delete the same way.')) return;
    try {
      await state.battleStore.remove(id);
      await refreshBattles();
      render();
      toast('Battle deleted.');
    } catch (error) {
      toast(`Could not delete the battle: ${error.message}`);
    }
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
    // A committed turn cannot be taken back: the old draft is gone.
    state.awaitingHandoff = false;
    state.handoffSide = null;
    state.confirming = false;
    state.announcement = '';
    state.selectedUnitId = null;
    state.drafts = [];
    state.validation = null;
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
  if (event.target?.hasAttribute?.('data-draft-facing')) {
    const id = event.target.dataset.id;
    if (id && canDraftOrders()) {
      setDraftFacing(id, event.target.value);
    }
  }
});

window.addEventListener('resize', () => {
  if (state.battle) updateBattleMapDom();
});

// --- Init --------------------------------------------------------------------

async function init() {
  const params = new URLSearchParams(location.search);
  state.scenarioId = params.get('id');
  state.battleResumeId = params.get('battle');
  state.seedOverride = parseSeedParam(params.get('seed'));
  await refreshBattles();
  // Resuming a stored battle: reloading the page mid-battle and choosing it
  // from the Battles list resumes the identical state. The battle keeps its
  // own scenario snapshot, so later scenario edits never change it.
  if (state.battleResumeId) {
    try {
      const record = await state.battleStore.load(state.battleResumeId);
      if (!record) {
        state.battleLoadError = 'Battle not found. It may have been deleted.';
        render();
        return;
      }
      state.battle = record.battle;
      state.battleId = record.battle.id;
      state.decisions = Array.isArray(record.decisions) ? record.decisions : [];
      state.scenario = record.battle.scenario;
      state.controllers = { ...record.battle.controllers };
      state.problems = [];
      state.awaitingHandoff = false;
      state.handoffSide = null;
      state.confirming = false;
      state.selectedUnitId = null;
      state.drafts = [];
      state.draftSeq = 1;
      state.validation = null;
      state.mapView = {
        ...fitMapView(state.scenario.battlefield),
        showGrid: true,
        viewportW: 800,
      };
      state.announcement = '';
      setStatus(
        isBattleFinished(state.battle)
          ? `Battle ${state.battle.status} · read-only.`
          : `Battle resumed · ${sideName(state.scenario, state.battle.activeSide)} to move (turn ${state.battle.turnNumber}).`,
      );
    } catch (error) {
      state.battleLoadError = `Could not load the battle: ${error.message}`;
    }
    render();
    console.info('[PÓLIS battle]', { battle: state.battleResumeId });
    return;
  }
  if (!state.scenarioId) {
    state.loadError = 'No scenario was requested (missing ?id=). Start a battle from the library or the editor, or resume one below.';
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
// a field in the UI, and the seed value itself is never rendered. The drafting
// hooks drive the same state the map clicks mutate, so the harness can draft
// without a pointer.
window.__battle = {
  get state() {
    return state;
  },
  beginWithSeed(seed) {
    return beginBattle(seed);
  },
  saveBattle() {
    return saveBattle();
  },
  selectUnit(id) {
    if (!canDraftOrders() || !ownBattleUnit(id)) return false;
    state.selectedUnitId = id;
    state.confirming = false;
    render();
    return true;
  },
  startDraft(unitId) {
    return startMoveDraft(unitId);
  },
  addLeg(unitId, point) {
    return appendDraftLeg(unitId, point);
  },
  setFacing(unitId, facing) {
    return setDraftFacing(unitId, facing);
  },
  removeDraft(unitId) {
    return removeMoveDraft(unitId);
  },
  moveDraft(unitId, direction) {
    return moveDraft(unitId, direction);
  },
  draftSubmission() {
    return state.battle ? buildDraftSubmission() : null;
  },
  validateDrafts() {
    return revalidateDrafts();
  },
  commitDraft() {
    return commitHumanTurn();
  },
};
