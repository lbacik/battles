// PÓLIS tracer bullet — scenario library and battlefield editor.
//
// Structure follows prototype layout A: order of battle on the left, the map
// in the centre, the inspector on the right. The visual style is not decided.
// The editor talks to browser storage only through the narrow scenario store
// interface (ADR 0003); the domain model stays framework-free.
import {
  FACING_SNAP_DEG,
  MAX_BATTLEFIELD_HEIGHT_M,
  MAX_BATTLEFIELD_WIDTH_M,
  GROUND_COVER_CATEGORIES,
  LINEAR_FEATURE_CATEGORIES,
  UNIT_PICK_TOLERANCE_PX,
  addElevationFeature,
  addGroundCoverFeature,
  addLinearFeature,
  clampMapZoom,
  classifyRulesetReference,
  cloneScenario,
  collectWarnings,
  createScenario,
  defaultFacingForSide,
  deriveFootprint,
  exportScenario,
  findFreeUnitPosition,
  fitMapView,
  generateId,
  historyCommit,
  historyRedo,
  historyUndo,
  importScenarioDocument,
  isProvisionalRuleset,
  mapViewBox,
  niceScaleBarMetres,
  normalizeFacing,
  panMapViewByPixels,
  pickUnitIdAtPoint,
  proposeUnitPatch,
  rebindRulesetToCurrent,
  removeElevationFeature,
  removeGroundCoverFeature,
  removeLinearFeature,
  resizeBattlefield,
  rulesetCompatibilityNotice,
  snapFacing,
  suggestUnitName,
  toScreenPoint,
  unitFacingDeg,
  unitFootprint,
  unitPosition,
  unitsBlockingResize,
  updateElevationFeature,
  updateGroundCoverFeature,
  validateElevationCandidate,
  updateLinearFeature,
  validateGroundCoverCandidate,
  validateLinearCandidate,
  validateScenario,
  zoomViewAroundCursor,
} from './domain/scenario.js';
import { polygonArea, round1 } from './domain/geometry.js';
import {
  SaveConflictError,
  duplicateScenario,
  exportRawRecord,
  isQuotaError,
  isUnsupportedDocument,
  performSave,
} from './domain/library.js';
import {
  TROOP_TYPE_CATALOGUE,
  TROOP_TYPE_KEYS,
  collectUnknownTroopTypeWarnings,
  getTroopType,
  isKnownTroopType,
  spacingClass,
} from './domain/polis-classical.js';
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
  persistRequested: false,
  dirty: false,
  conflict: null,
  newTitle: '',
  mapView: null,
  spaceHeld: false,
  // Order of battle selection and conflict highlight. Both are display-only:
  // selecting a unit never marks the scenario unsaved, and the conflict
  // highlight only mirrors a refused edit (the document keeps the last valid
  // values). Neither is recorded in the undo history.
  selectedUnitId: null,
  unitConflictIds: [],
  // Terrain mode (left panel): 'forces' shows the order of battle, 'terrain'
  // lists the ground cover areas and hosts the drawing tools. The map
  // interactions below key off the draft and the selection, not the tab.
  leftMode: 'forces',
  selectedTerrainId: null,
  selectedVertexIndex: null,
  // The shape being drawn: { kind, category?, width?, points, error } where
  // kind is 'ground' or 'elevation' (polygons) or 'linear' (a polyline).
  // Display-only until the author finishes it; finishing validates and
  // commits one undo step. Ground drafts carry a category; elevation drafts
  // derive their level from nesting; linear drafts carry a category and width.
  terrainDraft: null,
  draftCategory: 'forest',
  draftLinearCategory: 'river',
  draftLinearWidth: 10,
  // The last refused terrain edit: { ring, reason, conflictId? }. Transient
  // display state (like the map view): rendered as a red highlight, cleared
  // by the next committed change.
  terrainRefusal: null,
};

// A vertex drag is transient pointer state, not document state: it lives
// outside `state` so a re-render never resurrects a stale drag.
let terrainDrag = null;
let suppressMapClick = false;

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
  state.unitConflictIds = [];
  if (documentsMatch(nextDocument, state.document)) {
    render();
    return;
  }
  state.history = historyCommit(state.history, cloneScenario(state.document));
  state.document = nextDocument;
  if (state.selectedUnitId && !nextDocument.units.some((unit) => unit?.id === state.selectedUnitId)) {
    state.selectedUnitId = null;
  }
  state.status = '';
  state.statusError = false;
  // A committed change supersedes the last refusal highlight.
  state.terrainRefusal = null;
  render(refocusSelector);
}

function undoEdit(refocusSelector) {
  if (!state.document) {
    return;
  }
  const stepped = historyUndo(state.history, cloneScenario(state.document));
  if (!stepped) {
    return;
  }
  state.history = stepped.history;
  state.document = stepped.document;
  state.fieldErrors = {};
  state.unitConflictIds = [];
  if (state.selectedUnitId && !state.document.units.some((unit) => unit?.id === state.selectedUnitId)) {
    state.selectedUnitId = null;
  }
  state.terrainRefusal = null;
  // Undoing back to the saved version clears the transient message so the
  // header falls back to the saved state; anything else stays marked dirty.
  state.status = isDirty() ? 'Undone.' : '';
  state.statusError = false;
  render(refocusSelector);
}

function redoEdit(refocusSelector) {
  if (!state.document) {
    return;
  }
  const stepped = historyRedo(state.history, cloneScenario(state.document));
  if (!stepped) {
    return;
  }
  state.history = stepped.history;
  state.document = stepped.document;
  state.fieldErrors = {};
  state.unitConflictIds = [];
  if (state.selectedUnitId && !state.document.units.some((unit) => unit?.id === state.selectedUnitId)) {
    state.selectedUnitId = null;
  }
  state.terrainRefusal = null;
  state.status = isDirty() ? 'Redone.' : '';
  state.statusError = false;
  render(refocusSelector);
}

// Reject a form value: it is never committed, the field reverts on render,
// and the reason is shown in the status line and under the field.
function failCommit(field, message) {
  state.fieldErrors = { [field]: message };
  state.unitConflictIds = [];
  state.status = message;
  state.statusError = true;
  render();
}

// Reject a unit form value. Like failCommit, but it can also highlight the
// units the refused edit would conflict with (overlap or outside): those ids
// are drawn with a conflict outline on the map and in the order of battle
// until the next successful commit or selection change.
function failUnitCommit(field, message, conflictIds = []) {
  state.fieldErrors = { [field]: message };
  state.unitConflictIds = [...new Set(conflictIds.filter(Boolean))];
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
  const candidateWidth = dimension === 'width' ? Number(raw) : state.document.battlefield.width;
  const candidateHeight = dimension === 'height' ? Number(raw) : state.document.battlefield.height;
  let next;
  try {
    next = resizeBattlefield(state.document, candidateWidth, candidateHeight);
  } catch (error) {
    // Shrinking past a unit is refused: the message names the blocking units
    // and they are highlighted on the map and in the order of battle, like a
    // refused unit drop.
    const blockers = unitsBlockingResize(state.document, candidateWidth, candidateHeight);
    if (blockers.length > 0) {
      state.fieldErrors = { [dimension]: error.message };
      state.unitConflictIds = blockers.map((blocker) => blocker.id).filter(Boolean);
      state.status = error.message;
      state.statusError = true;
      render();
      return;
    }
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

// --- Unit commits (invalid values never reach the document) -----------------
// Every unit change goes through commitEdit, so adding, editing, duplicating,
// and deleting units are all undoable. Geometry-changing edits are validated
// against the whole document: an edit whose footprint would overlap another
// unit or leave the battlefield is refused and the conflict is highlighted.

function unitById(document, id) {
  return (document?.units || []).find((unit) => unit?.id === id) || null;
}

function selectedUnit() {
  if (!state.document || !state.selectedUnitId) {
    return null;
  }
  return unitById(state.document, state.selectedUnitId);
}

// Which spacing preset the unit's spacings match, or 'custom' when they match
// none of the troop type's presets.
function currentPresetKey(unit) {
  const entry = getTroopType(unit?.troopType);
  if (!entry || !Number.isFinite(unit?.lateralInterval) || !Number.isFinite(unit?.rankDepth)) {
    return 'custom';
  }
  for (const key of ['close', 'normal', 'open']) {
    const preset = entry.presets[key];
    if (
      preset &&
      Math.abs(preset.lateralInterval - unit.lateralInterval) < 1e-9 &&
      Math.abs(preset.rankDepth - unit.rankDepth) < 1e-9
    ) {
      return key;
    }
  }
  return 'custom';
}

// The map rectangle (in metres, map convention) currently in view, clipped to
// the battlefield. New and duplicated units are placed at the first free spot
// inside it; view navigation never touches the document, so this only reads
// the display-only camera.
function visibleSearchRect() {
  const battlefield = state.document?.battlefield;
  const width = Number(battlefield?.width);
  const height = Number(battlefield?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  if (!state.mapView) {
    return { minX: 0, minY: 0, maxX: width, maxY: height };
  }
  const box = mapViewBox(state.mapView, battlefield);
  if (!Number.isFinite(box?.x) || !Number.isFinite(box?.width)) {
    return { minX: 0, minY: 0, maxX: width, maxY: height };
  }
  return {
    minX: Math.max(0, box.x),
    minY: Math.max(0, height - (box.y + box.height)),
    maxX: Math.min(width, box.x + box.width),
    maxY: Math.min(height, height - box.y),
  };
}

function describeFootprintSize(frontage, depth) {
  return `${frontage.toFixed(1)} × ${depth.toFixed(1)} m`;
}

// Refuse the edited unit when structural validation names it: the value is
// never committed, the field reverts, and every other unit named alongside it
// (an overlap partner) is highlighted as the conflict.
function refuseIfConflicting(nextDocument, editedIndex, field) {
  const errors = validateScenario(nextDocument);
  const relevant = errors.filter((error) => error.includes(`units[${editedIndex}]`));
  if (relevant.length === 0) {
    return false;
  }
  const editedId = nextDocument.units[editedIndex]?.id;
  const conflictIds = [editedId];
  for (const error of relevant) {
    for (const match of error.matchAll(/units\[(\d+)\]/g)) {
      const other = nextDocument.units[Number(match[1])];
      if (other?.id) {
        conflictIds.push(other.id);
      }
    }
  }
  failUnitCommit(field, relevant[0], conflictIds);
  return true;
}

function commitAddUnit(sideId) {
  if (!state.document) {
    return;
  }
  const side = (state.document.sides || []).find((entry) => entry.id === sideId)
    || state.document.sides[0];
  if (!side) {
    return;
  }
  const troopKey = TROOP_TYPE_KEYS.includes('hoplite') ? 'hoplite' : TROOP_TYPE_KEYS[0];
  const preset = getTroopType(troopKey)?.presets?.normal
    || { lateralInterval: 1.8, rankDepth: 1.8 };
  const soldiers = 100;
  const files = 10;
  const frontage = files * preset.lateralInterval;
  const depth = Math.ceil(soldiers / files) * preset.rankDepth;
  const facing = defaultFacingForSide(state.document, side.id);
  const position = findFreeUnitPosition(
    state.document,
    { frontage, depth, facing },
    visibleSearchRect(),
  );
  if (!position) {
    const message = 'No free space in the current view: pan or zoom out, then add the Unit again.';
    state.fieldErrors = {};
    state.unitConflictIds = [];
    state.status = message;
    state.statusError = true;
    render();
    toast(message);
    return;
  }
  const next = cloneScenario(state.document);
  const unit = {
    id: generateId(),
    name: suggestUnitName(next),
    side: side.id,
    troopType: troopKey,
    soldiers,
    files,
    lateralInterval: preset.lateralInterval,
    rankDepth: preset.rankDepth,
    position,
    facing,
  };
  next.units.push(unit);
  state.selectedUnitId = unit.id;
  commitEdit(next);
  toast(`Added ${unit.name}.`);
}

function commitDuplicateUnit(unitId) {
  if (!state.document) {
    return;
  }
  const source = unitById(state.document, unitId);
  if (!source) {
    return;
  }
  const ranks = Math.ceil(source.soldiers / source.files);
  const frontage = source.files * source.lateralInterval;
  const depth = ranks * source.rankDepth;
  const position = findFreeUnitPosition(
    state.document,
    { frontage, depth, facing: source.facing },
    visibleSearchRect(),
  );
  if (!position) {
    const message = 'No free space in the current view: pan or zoom out, then duplicate the Unit again.';
    state.fieldErrors = {};
    state.unitConflictIds = [];
    state.status = message;
    state.statusError = true;
    render();
    toast(message);
    return;
  }
  const next = cloneScenario(state.document);
  const copy = {
    ...JSON.parse(JSON.stringify(source)),
    id: generateId(),
    name: suggestUnitName(next, `${source.name} copy`),
    position,
  };
  next.units.push(copy);
  state.selectedUnitId = copy.id;
  commitEdit(next);
  toast(`Duplicated as ${copy.name}.`);
}

function commitDeleteUnit(unitId) {
  if (!state.document) {
    return;
  }
  const target = unitById(state.document, unitId);
  if (!target) {
    return;
  }
  const next = cloneScenario(state.document);
  next.units = next.units.filter((unit) => unit?.id !== unitId);
  if (state.selectedUnitId === unitId) {
    state.selectedUnitId = null;
  }
  commitEdit(next);
  toast(`Deleted ${target.name}.`);
}

function commitUnitField(unitId, field, raw) {
  if (!state.document) {
    return;
  }
  const unit = unitById(state.document, unitId);
  if (!unit) {
    return;
  }
  const index = state.document.units.findIndex((entry) => entry?.id === unitId);
  const fieldKey = `unit-${field}-${unitId}`;
  if (field === 'name') {
    const value = String(raw ?? '');
    if (!value.trim()) {
      failUnitCommit(fieldKey, 'Unit name is required.');
      return;
    }
    const clash = (state.document.units || []).some(
      (other) => other?.id !== unitId
        && String(other?.name || '').trim().toLowerCase() === value.trim().toLowerCase(),
    );
    if (clash) {
      failUnitCommit(fieldKey, `Unit name "${value.trim()}" is already used (names must be unique).`, [unitId]);
      return;
    }
    if (value.trim() === unit.name) {
      state.fieldErrors = {};
      state.unitConflictIds = [];
      render();
      return;
    }
    const next = cloneScenario(state.document);
    next.units[index].name = value.trim();
    if (refuseIfConflicting(next, index, fieldKey)) {
      return;
    }
    commitEdit(next);
    return;
  }
  if (field === 'side') {
    const value = String(raw ?? '');
    if (!value || !state.document.sides.some((side) => side.id === value)) {
      failUnitCommit(fieldKey, 'Side is required.');
      return;
    }
    if (value === unit.side) {
      state.fieldErrors = {};
      state.unitConflictIds = [];
      render();
      return;
    }
    const next = cloneScenario(state.document);
    next.units[index].side = value;
    if (refuseIfConflicting(next, index, fieldKey)) {
      return;
    }
    commitEdit(next);
    return;
  }
  if (field === 'troopType') {
    const value = String(raw ?? '');
    if (!value.trim()) {
      failUnitCommit(fieldKey, 'Troop type is required.');
      return;
    }
    if (value === unit.troopType) {
      state.fieldErrors = {};
      state.unitConflictIds = [];
      render();
      return;
    }
    const next = cloneScenario(state.document);
    next.units[index].troopType = value;
    if (refuseIfConflicting(next, index, fieldKey)) {
      return;
    }
    commitEdit(next);
    return;
  }
  if (field === 'soldiers' || field === 'files') {
    const value = Number(raw);
    if (String(raw ?? '').trim() === '' || !Number.isInteger(value) || value < 1) {
      failUnitCommit(fieldKey, field === 'soldiers'
        ? 'Soldiers must be a whole number of at least 1.'
        : 'Files must be a whole number of at least 1.');
      return;
    }
    const soldiers = field === 'soldiers' ? value : unit.soldiers;
    const files = field === 'files' ? value : unit.files;
    if (files > soldiers) {
      failUnitCommit(fieldKey, `Files (${files}) must not exceed soldiers (${soldiers}).`, [unitId]);
      return;
    }
    if (soldiers === unit.soldiers && files === unit.files) {
      state.fieldErrors = {};
      state.unitConflictIds = [];
      render();
      return;
    }
    const next = cloneScenario(state.document);
    next.units[index].soldiers = soldiers;
    next.units[index].files = files;
    if (refuseIfConflicting(next, index, fieldKey)) {
      return;
    }
    commitEdit(next, `[data-unit-field="${field}"][data-id="${unitId}"]`);
    return;
  }
  if (field === 'lateralInterval' || field === 'rankDepth') {
    const value = Number(raw);
    const label = field === 'lateralInterval' ? 'Lateral interval' : 'Rank depth';
    if (String(raw ?? '').trim() === '' || !Number.isFinite(value) || value <= 0) {
      failUnitCommit(fieldKey, `${label} must be a positive number of metres.`);
      return;
    }
    if (value > 10) {
      failUnitCommit(fieldKey, `${label} must not exceed the application limit of 10 m.`);
      return;
    }
    if (value === unit[field]) {
      state.fieldErrors = {};
      state.unitConflictIds = [];
      render();
      return;
    }
    const next = cloneScenario(state.document);
    next.units[index][field] = Math.round(value * 10) / 10;
    if (refuseIfConflicting(next, index, fieldKey)) {
      return;
    }
    commitEdit(next, `[data-unit-field="${field}"][data-id="${unitId}"]`);
    return;
  }
  // Exact placement on the map: the front-edge midpoint in metres and the
  // compass facing in degrees. Patched through proposeUnitPatch so a typed
  // value is refused exactly like a conflicting drag or rotation.
  if (field === 'positionX' || field === 'positionY') {
    if (String(raw ?? '').trim() === '' || !Number.isFinite(Number(raw))) {
      failUnitCommit(`unit-position-${unitId}`, 'Position must hold finite X and Y metre coordinates.', [unitId]);
      return;
    }
    const position = {
      x: field === 'positionX' ? Number(raw) : unit.position?.x,
      y: field === 'positionY' ? Number(raw) : unit.position?.y,
    };
    if (position.x === unit.position?.x && position.y === unit.position?.y) {
      state.fieldErrors = {};
      state.unitConflictIds = [];
      render();
      return;
    }
    commitGeometryProposal(unitId, { position }, { refocus: `[data-unit-field="${field}"][data-id="${unitId}"]` });
    return;
  }
  if (field === 'facing') {
    if (String(raw ?? '').trim() === '' || !Number.isFinite(Number(raw))) {
      failUnitCommit(`unit-facing-${unitId}`, 'Facing must be a compass bearing in degrees.', [unitId]);
      return;
    }
    if (normalizeFacing(Number(raw)) === normalizeFacing(unit.facing)) {
      state.fieldErrors = {};
      state.unitConflictIds = [];
      render();
      return;
    }
    commitGeometryProposal(unitId, { facing: Number(raw) }, { refocus: `[data-unit-field="${field}"][data-id="${unitId}"]` });
    return;
  }
}

// Propose a geometry change (map drag, rotation handle, or inspector field)
// through proposeUnitPatch. A refused change is never committed: the unit
// returns to its stored values and every unit the refused placement would
// conflict with is highlighted. Every committed change goes through
// commitEdit, so placement and rotation are undoable like any other scenario
// change. Returns true when the proposal was committed.
function commitGeometryProposal(unitId, patch, options = {}) {
  if (!state.document) {
    return false;
  }
  const proposal = proposeUnitPatch(state.document, unitId, patch);
  if (!proposal.ok) {
    const field = patch.position !== undefined ? `unit-position-${unitId}` : `unit-facing-${unitId}`;
    const message = proposal.errors[0] || 'This placement is not allowed.';
    failUnitCommit(field, message, proposal.conflictIds);
    if (options.announceRefusal) {
      toast(message);
    }
    return false;
  }
  commitEdit(proposal.document, options.refocus || undefined);
  return true;
}

// Commit a map drag or rotation handle move, announcing a refusal with a
// toast as well as the field error and conflict highlight.
function commitUnitGeometry(unitId, patch) {
  return commitGeometryProposal(unitId, patch, { announceRefusal: true });
}

function commitUnitPreset(unitId, presetKey) {
  if (!state.document) {
    return;
  }
  const unit = unitById(state.document, unitId);
  if (!unit) {
    return;
  }
  const entry = getTroopType(unit.troopType);
  const preset = entry?.presets?.[presetKey];
  if (!preset) {
    return;
  }
  const index = state.document.units.findIndex((entry) => entry?.id === unitId);
  if (unit.lateralInterval === preset.lateralInterval && unit.rankDepth === preset.rankDepth) {
    state.fieldErrors = {};
    state.unitConflictIds = [];
    render();
    return;
  }
  const next = cloneScenario(state.document);
  next.units[index].lateralInterval = preset.lateralInterval;
  next.units[index].rankDepth = preset.rankDepth;
  // Both spacings change in one undo step; a conflicting preset is refused.
  if (refuseIfConflicting(next, index, `unit-preset-${unitId}`)) {
    return;
  }
  commitEdit(next, `[data-unit-field="lateralInterval"][data-id="${unitId}"]`);
  toast(`Spacing preset ${presetKey} applied (${describeFootprintSize(preset.lateralInterval, preset.rankDepth)}).`);
}

function committedFieldValue(input) {
  const index = Number(input.dataset.index);
  if (input.dataset.unitField) {
    const unit = unitById(state.document, input.dataset.id);
    if (!unit) {
      return input.value;
    }
    const unitField = input.dataset.unitField;
    if (unitField === 'preset') {
      return currentPresetKey(unit);
    }
    if (unitField === 'positionX') {
      return String(unit.position?.x ?? '');
    }
    if (unitField === 'positionY') {
      return String(unit.position?.y ?? '');
    }
    if (unitField === 'facing') {
      return String(unit.facing ?? '');
    }
    return String(unit[unitField] ?? '');
  }
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

// Whether a form field holds edits not yet committed to the document.
// Undo and redo skip such fields so the shortcut never destroys a draft.
function fieldHasDraft(input) {
  if (!input || !input.dataset || !state.document) {
    return false;
  }
  if (input.dataset.unitField) {
    const unit = unitById(state.document, input.dataset.id);
    if (!unit) {
      return false;
    }
    const unitField = input.dataset.unitField;
    const value = input.value ?? '';
    if (unitField === 'preset') {
      return value !== currentPresetKey(unit);
    }
    if (unitField === 'name' || unitField === 'side' || unitField === 'troopType') {
      return value !== String(unit[unitField] ?? '');
    }
    if (unitField === 'positionX' || unitField === 'positionY') {
      const axis = unitField === 'positionX' ? 'x' : 'y';
      if (String(value).trim() === '' || !Number.isFinite(Number(value))) {
        return true;
      }
      return Number(value) !== Number(unit.position?.[axis]);
    }
    if (unitField === 'facing') {
      if (String(value).trim() === '' || !Number.isFinite(Number(value))) {
        return true;
      }
      return normalizeFacing(Number(value)) !== normalizeFacing(unit.facing);
    }
    if (String(value).trim() === '' || !Number.isFinite(Number(value))) {
      return true;
    }
    return Number(value) !== Number(unit[unitField]);
  }
  if (!input.dataset.field) {
    return false;
  }
  const field = input.dataset.field;
  const index = Number(input.dataset.index);
  const value = input.value ?? '';
  if (field === 'title') {
    return value !== state.document.title;
  }
  if (field === 'description') {
    return value !== (state.document.description || '');
  }
  if (field === 'width' || field === 'height') {
    if (String(value).trim() === '' || !Number.isFinite(Number(value))) {
      return true;
    }
    return Number(value) !== state.document.battlefield[field];
  }
  if (field === 'side-name') {
    return value !== (state.document.sides[index]?.name ?? '');
  }
  if (field === 'side-color') {
    return (
      String(value).toLowerCase() !==
      String(state.document.sides[index]?.color || '').toLowerCase()
    );
  }
  return false;
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

function unitSvg(document, unit, mapView, mpp, flags = {}) {
  const position = unitPosition(unit);
  const footprint = unitFootprint(unit);
  if (!position || !footprint) return '';
  const { height: heightM } = document.battlefield;
  const centre = toScreenPoint(position, heightM);
  const facing = unitFacingDeg(unit);
  // Units whose troop-type key has left the catalogue keep a neutral marking
  // on the map: a grey footprint instead of the side colour. The key is still
  // preserved verbatim in the document.
  const unknownTroop = !isKnownTroopType(unit?.troopType);
  const color = unknownTroop ? '#6b7280' : sideColor(document, unit);
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
  // The footprint is anchored at the front midpoint (the unit position): the
  // local origin is the front edge midpoint and depth extends backwards
  // (+y locally, rotated by the facing), exactly matching deriveFootprint.
  const helperCy = depthH / 2;
  const helper =
    minEdgePx < 10
      ? `<rect x="${-helperBox / 2}" y="${helperCy - helperBox / 2}" width="${helperBox}" height="${helperBox}" rx="${4 * mpp}" fill="none" stroke="${esc(color)}" stroke-width="${1.5 * mpp}" stroke-dasharray="${6 * mpp} ${4 * mpp}" opacity="0.85" class="unit-helper"/>` +
        `<path d="M0 ${helperCy - helperBox / 2 - 10 * mpp} l${5 * mpp} ${5 * mpp} l${-5 * mpp} ${5 * mpp} l${-5 * mpp} ${-5 * mpp} Z" fill="${esc(color)}" opacity="0.9" class="unit-helper"/>`
      : '';
  // Rotation handle for the selected unit: a stem forward of the front edge
  // with a grab circle, pivoting the footprint about the front midpoint.
  // Sizes scale with metres-per-pixel so the handle keeps a constant screen
  // size at any zoom.
  const reach = 20 * mpp;
  const gripR = 7 * mpp;
  const handle =
    flags.selected
      ? `<line x1="0" y1="0" x2="0" y2="${-reach}" stroke="${esc(color)}" stroke-width="${1.6 * mpp}" stroke-dasharray="${4 * mpp} ${3 * mpp}" class="rotate-stem"/>` +
        `<circle cx="0" cy="${-reach}" r="${12 * mpp}" fill="transparent" class="rotate-hit" data-rotate-handle="${esc(unit.id || '')}"><title>Drag to rotate (snaps to ${FACING_SNAP_DEG}°, hold Shift for free rotation)</title></circle>` +
        `<circle cx="0" cy="${-reach}" r="${gripR}" fill="#f8f9f0" stroke="${esc(color)}" stroke-width="${2 * mpp}" class="rotate-grip" data-rotate-handle="${esc(unit.id || '')}"><title>Drag to rotate (snaps to ${FACING_SNAP_DEG}°, hold Shift for free rotation)</title></circle>`
      : '';
  const classes = ['unit'];
  if (flags.selected) classes.push('selected');
  if (flags.conflict) classes.push('conflict');
  if (unknownTroop) classes.push('unknown-troop');
  const outline = flags.conflict ? '#b91c1c' : esc(color);
  return `<g class="${classes.join(' ')}" transform="translate(${centre.x} ${centre.y)}" data-unit-id="${esc(unit.id || '')}">
    <g class="unit-rotor" transform="rotate(${facing})">
      ${helper}
      <rect x="${-frontW / 2}" y="0" width="${frontW}" height="${depthH}" fill="${esc(color)}" fill-opacity="0.32" stroke="${outline}" stroke-width="${(flags.selected || flags.conflict ? 3 : 1.6) * mpp}" class="unit-footprint"/>
      <line x1="${-frontW / 2}" y1="0" x2="${frontW / 2}" y2="0" stroke="${outline}" stroke-width="${3 * mpp}"/>
      ${handle}
    </g>
    <text x="0" y="${depthH + 8 * mpp + labelSize * 0.9}" text-anchor="middle" font-size="${labelSize}" class="unit-label">${esc(name)}</text>
    ${dims ? `<text x="0" y="${depthH + 8 * mpp + labelSize * 0.9 + dimsSize * 1.25}" text-anchor="middle" font-size="${dimsSize}" class="unit-dims">${esc(dims)}</text>` : ''}
    ${unknownTroop ? `<text x="0" y="${depthH + 8 * mpp + labelSize * 0.9 + dimsSize * 1.25 + (dims ? dimsSize * 1.25 : 0)}" text-anchor="middle" font-size="${dimsSize}" class="unit-dims">? unknown troop type</text>` : ''}
    <title>${esc(name)}${dims ? ` · ${esc(dims)}` : ''}${unknownTroop ? ` · unknown troop type "${esc(unit?.troopType ?? '')}" (preserved)` : ''}</title>
  </g>`;
}

// Vertex handles, the draft shape, and the refusal highlight for Terrain mode.
// All coordinates are map metres converted through `project` (map y-up to
// screen y-down); handle radii are metres-per-pixel multiples so they keep a
// constant screen size at any zoom.
function terrainOverlaySvg(document, overlay, project, toScreen, mpp) {
  const { selectedId, selectedIndex, draft, refusal } = overlay || {};
  let out = '';
  if (refusal && Array.isArray(refusal.ring) && refusal.ring.length >= 2) {
    const label = esc(refusal.reason || 'Refused shape');
    if (refusal.kind === 'linear' || refusal.ring.length === 2) {
      out += `<polyline points="${project(refusal.ring)}" fill="none" stroke="#b76e5a" stroke-width="${2.5 * mpp}" stroke-dasharray="${8 * mpp} ${5 * mpp}" class="terrain-refused"><title>${label}</title></polyline>`;
    } else {
      out += `<polygon points="${project(refusal.ring)}" fill="#b76e5a" fill-opacity="0.35" stroke="#b76e5a" stroke-width="${2.5 * mpp}" stroke-dasharray="${8 * mpp} ${5 * mpp}" class="terrain-refused"><title>${label}</title></polygon>`;
    }
  }
  if (draft && Array.isArray(draft.points) && draft.points.length > 0) {
    const line = project(draft.points);
    const isLinear = draft.kind === 'linear';
    if (!isLinear && draft.points.length >= 3) {
      out += `<polygon points="${line}" fill="#4e6047" fill-opacity="0.12" stroke="#4e6047" stroke-width="${2 * mpp}" stroke-dasharray="${7 * mpp} ${4 * mpp}" class="terrain-draft-fill"/>`;
    } else {
      out += `<polyline points="${line}" fill="none" stroke="#4e6047" stroke-width="${2 * mpp}" stroke-dasharray="${7 * mpp} ${4 * mpp}" class="terrain-draft-fill"/>`;
    }
    out += draft.points
      .map((point) => {
        const screen = toScreen(point.x, point.y);
        return `<circle cx="${screen.x}" cy="${screen.y}" r="${5 * mpp}" fill="#4e6047" stroke="#f4f3e9" stroke-width="${1.5 * mpp}" class="terrain-draft-vertex"/>`;
      })
      .join('');
  }
  const selected =
    selectedId && (document.terrainFeatures || []).find((feature) => feature?.id === selectedId);
  if (selected && (selected.kind === 'ground' || selected.kind === 'elevation') && Array.isArray(selected.polygon)) {
    const ring = selected.polygon;
    out += ring
      .map((point, index) => {
        const edge = ring[(index + 1) % ring.length];
        const mid = { x: (point.x + edge.x) / 2, y: (point.y + edge.y) / 2 };
        const screen = toScreen(mid.x, mid.y);
        return `<circle cx="${screen.x}" cy="${screen.y}" r="${4 * mpp}" fill="#faf9f4" stroke="#4e6047" stroke-width="${1.5 * mpp}" stroke-dasharray="${3 * mpp} ${2 * mpp}" class="terrain-edge-handle" data-edge-index="${index}" data-feature-id="${esc(selected.id)}"><title>Insert a vertex here</title></circle>`;
      })
      .join('');
    out += ring
      .map((point, index) => {
        const screen = toScreen(point.x, point.y);
        const active = index === selectedIndex;
        return `<circle cx="${screen.x}" cy="${screen.y}" r="${(active ? 7 : 6) * mpp}" fill="${active ? '#4e6047' : '#faf9f4'}" stroke="#4e6047" stroke-width="${2 * mpp}" class="terrain-vertex${active ? ' selected' : ''}" data-vertex-index="${index}" data-feature-id="${esc(selected.id)}"><title>Vertex ${index + 1}: drag to move, Delete removes it</title></circle>`;
      })
      .join('');
  }
  if (selected && selected.kind === 'linear' && Array.isArray(selected.path)) {
    const line = selected.path;
    for (let index = 0; index + 1 < line.length; index += 1) {
      const a = line[index];
      const b = line[index + 1];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const screen = toScreen(mid.x, mid.y);
      out += `<circle cx="${screen.x}" cy="${screen.y}" r="${4 * mpp}" fill="#faf9f4" stroke="#7fa8c9" stroke-width="${1.5 * mpp}" stroke-dasharray="${3 * mpp} ${2 * mpp}" class="terrain-edge-handle" data-edge-index="${index}" data-feature-id="${esc(selected.id)}"><title>Insert a vertex here</title></circle>`;
    }
    out += line
      .map((point, index) => {
        const screen = toScreen(point.x, point.y);
        const active = index === selectedIndex;
        return `<circle cx="${screen.x}" cy="${screen.y}" r="${(active ? 7 : 6) * mpp}" fill="${active ? '#7fa8c9' : '#faf9f4'}" stroke="#7fa8c9" stroke-width="${2 * mpp}" class="terrain-vertex${active ? ' selected' : ''}" data-vertex-index="${index}" data-feature-id="${esc(selected.id)}"><title>Vertex ${index + 1}: drag to move, Delete removes it</title></circle>`;
      })
      .join('');
  }
  return out;
}

function battlefieldSvg(document, mapView, overlay = {}) {
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

  const refusalConflictId = overlay?.refusal?.conflictId;
  const terrain = (document.terrainFeatures || [])
    .map((feature) => {
      if (feature.kind === 'ground') {
        const style = GROUND_STYLES[feature.category] || { fill: '#cccccc', stroke: '#999999' };
        const classes = ['terrain-ground'];
        if (feature.id === overlay?.selectedId) classes.push('selected');
        if (feature.id && feature.id === refusalConflictId) classes.push('conflict');
        return `<polygon points="${project(feature.polygon)}" fill="${style.fill}" fill-opacity="0.7" stroke="${style.stroke}" stroke-width="${feature.id === overlay?.selectedId ? 3 : 1.5}" class="${classes.join(' ')}" data-feature-id="${esc(feature.id || '')}"><title>${esc(groundCoverLabel(feature.category))}</title></polygon>`;
      }
      if (feature.kind === 'elevation') {
        const middle = toScreen(
          feature.polygon.reduce((sum, point) => sum + point.x, 0) / feature.polygon.length,
          feature.polygon.reduce((sum, point) => sum + point.y, 0) / feature.polygon.length,
        );
        const classes = ['terrain-elevation'];
        if (feature.id === overlay?.selectedId) classes.push('selected');
        if (feature.id && feature.id === refusalConflictId) classes.push('conflict');
        return `<g><polygon points="${project(feature.polygon)}" fill="#c6c8a4" fill-opacity="0.25" stroke="#8a7a5c" stroke-width="${feature.id === overlay?.selectedId ? 3 : 1.5}" stroke-dasharray="7 4" class="${classes.join(' ')}" data-feature-id="${esc(feature.id || '')}"><title>Hill · level ${esc(feature.level)} (derived from nesting)</title></polygon><text x="${middle.x}" y="${middle.y}" text-anchor="middle" font-size="13" fill="#6b6247">L${esc(feature.level)}</text></g>`;
      }
      if (feature.kind === 'linear') {
        const color = LINEAR_STYLES[feature.category] || '#888888';
        const classes = ['terrain-linear'];
        if (feature.id === overlay?.selectedId) classes.push('selected');
        const selected = feature.id === overlay?.selectedId;
        const halo = selected
          ? `<polyline points="${project(feature.path)}" fill="none" stroke="#4e6047" stroke-width="${Number(feature.width) + 6 * mpp}" opacity="0.35" stroke-linecap="round" stroke-linejoin="round" class="terrain-linear-halo"/>`
          : '';
        return `${halo}<polyline points="${project(feature.path)}" fill="none" stroke="${color}" stroke-width="${feature.width}" stroke-linecap="round" stroke-linejoin="round" class="${classes.join(' ')}" data-feature-id="${esc(feature.id || '')}"><title>${esc(feature.category)} · ${esc(feature.width)} m</title></polyline>`;
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
    <g id="map-terrain-overlay">${terrainOverlaySvg(document, overlay, project, toScreen, mpp)}</g>
    <rect x="0" y="0" width="${widthM}" height="${heightM}" fill="none" stroke="#6f7a65" stroke-width="2" vector-effect="non-scaling-stroke"/>
    ${xLabels}${yLabels}
    <g id="map-units-group">${placed.map((unit) => unitSvg(document, unit, mapView, mpp, { selected: unit?.id === state.selectedUnitId, conflict: state.unitConflictIds.includes(unit?.id) })).join('')}</g>
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
// One library row. Readable entries offer open, duplicate, export, and
// delete. Entries that cannot be read — and documents with a newer format
// version than this application supports — offer only raw export and delete,
// so the stored data can never be opened or silently overwritten.
function libraryEntryView(entry) {
  if (!entry.id) {
    return `<li class="library-entry unreadable">
      <div><div class="title">Unreadable scenario</div>
      <div class="meta">Unreadable · ${esc(entry.cause || 'unknown cause')}</div></div>
    </li>`;
  }
  const safeId = esc(entry.id);
  if (entry.status === 'ok') {
    return `<li class="library-entry">
      <div><div class="title">${esc(entry.title)}</div>
      <div class="meta">revision ${entry.revision} · updated ${esc(entry.updatedAt)}</div></div>
      <div class="actions">
        <button class="btn-secondary" data-action="open" data-id="${safeId}">Open</button>
        <button class="btn-primary" data-action="start-battle" data-id="${safeId}">Start battle</button>
        <button class="btn-secondary" data-action="duplicate" data-id="${safeId}">Duplicate</button>
        <button class="btn-secondary" data-action="export" data-id="${safeId}">Export</button>
        <button class="btn-quiet btn-danger" data-action="delete" data-id="${safeId}">Delete</button>
      </div>
    </li>`;
  }
  const label =
    entry.status === 'unsupported-version' ? 'Needs a newer application' : 'Unreadable';
  return `<li class="library-entry unreadable">
    <div><div class="title">${esc(entry.title)}</div>
    <div class="meta">${label} · ${esc(entry.cause || 'unknown cause')}</div></div>
    <div class="actions">
      <button class="btn-secondary" data-action="export-raw" data-id="${safeId}">Export raw</button>
      <button class="btn-quiet btn-danger" data-action="delete" data-id="${safeId}">Delete</button>
    </div>
  </li>`;
}

function libraryView() {
  const items = state.library
    .map(
      (entry) => libraryEntryView(entry),
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
          <div class="side-name"><span class="swatch" style="background:${esc(side.color)}"></span>${esc(side.name)}
            <span class="spacer"></span><button class="btn-quiet" data-action="add-unit" data-side="${esc(side.id)}" title="Add a Unit to ${esc(side.name)}">+ Add Unit</button>
          </div>
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
              // Units whose troop-type key has left the catalogue keep a neutral
              // marking in the roster: a grey swatch and a badge naming the
              // preserved key. The issues panel warns.
              const unknownTroop = !isKnownTroopType(unit?.troopType);
              const detail = footprint
                ? `${esc(troopDisplayName(unit.troopType))} · ${esc(unit.soldiers)} soldiers · ${esc(unit.files)} files × ${footprint.ranks} ranks`
                : `${esc(troopDisplayName(unit.troopType))} · not placed`;
              const classes = ['unit-row'];
              if (unit?.id === state.selectedUnitId) classes.push('selected');
              if (state.unitConflictIds.includes(unit?.id)) classes.push('conflict');
              if (unknownTroop) classes.push('unknown-troop');
              const swatch = unknownTroop ? '#9aa0a6' : side.color;
              const unknownBadge = unknownTroop
                ? `<div class="unit-detail"><span class="unknown-badge">Unknown troop type "${esc(unit?.troopType ?? '')}" · preserved</span></div>`
                : '';
              return `<button class="${classes.join(' ')}" data-action="select-unit" data-id="${esc(unit?.id || '')}" aria-pressed="${String(unit?.id === state.selectedUnitId)}"><span class="swatch" style="background:${esc(swatch)}"></span><div><div class="unit-name">${esc(unit?.name || 'Unit')}</div><div class="unit-detail">${detail}</div>${unknownBadge}</div></button>`;
            })
            .join('')}
        </div>`;
      })
      .join('')}
    <p class="readonly-note">Select a Unit to edit it in the inspector. New and duplicated Units are placed at the first free spot in the current view. Drag a Unit on the map to place it; drag its round handle to rotate it. Ground cover areas are drawn and edited in Terrain mode.</p>
  </div>`;
}

function unitEditorView(document, unit) {
  const fieldError = (name) =>
    state.fieldErrors[name] ? `<p class="field-error" role="alert">${esc(state.fieldErrors[name])}</p>` : '';
  const invalid = (name) => (state.fieldErrors[name] ? ' aria-invalid="true"' : '');
  const id = unit.id;
  let derived = null;
  try {
    derived = deriveFootprint(unit);
  } catch {
    derived = null;
  }
  if (!derived || !Number.isFinite(derived.ranks)) {
    const fallback = unitFootprint(unit);
    if (fallback && Number.isFinite(fallback.ranks)) {
      derived = {
        ranks: fallback.ranks,
        frontage: fallback.frontageM,
        depth: fallback.depthM,
      };
    }
  }
  const derivedLine = derived
    ? `${derived.ranks} ${derived.ranks === 1 ? 'rank' : 'ranks'} · ${derived.frontage.toFixed(1)} m frontage · ${derived.depth.toFixed(1)} m depth`
    : 'Ranks, frontage, and depth follow from soldiers, files, and spacings.';
  const spacing = spacingClass(unit.troopType, unit.lateralInterval);
  const presetKey = currentPresetKey(unit);
  const entry = getTroopType(unit.troopType);
  const presetLabel = (key) => {
    const preset = entry?.presets?.[key];
    if (!preset) {
      return key;
    }
    return `${key} (${preset.lateralInterval} × ${preset.rankDepth} m)`;
  };
  const sideOptions = (document.sides || [])
    .map((side) => `<option value="${esc(side.id)}"${side.id === unit.side ? ' selected' : ''}>${esc(side.name)}</option>`)
    .join('');
  // A unit whose troop-type key has left the catalogue keeps its key verbatim:
  // the select lists it as the selected "Unknown" option so the author can
  // reassign a catalogue troop type. Choosing a known key commits normally.
  const unknownTroop = !isKnownTroopType(unit.troopType);
  const unknownOption = unknownTroop
    ? `<option value="${esc(unit.troopType)}" selected>Unknown troop type "${esc(unit.troopType)}" (preserved)</option>`
    : '';
  const troopOptions = TROOP_TYPE_KEYS.map((key) => {
    const label = TROOP_TYPE_CATALOGUE[key]?.displayName || key;
    return `<option value="${esc(key)}"${key === unit.troopType ? ' selected' : ''}>${esc(label)}</option>`;
  }).join('');
  const unknownNote = unknownTroop
    ? `<p class="unknown-note" role="note">This troop type left the catalogue; the key "${esc(unit.troopType)}" is preserved verbatim. Choose a troop type to reassign it — battle start will refuse an unknown key.</p>`
    : '';
  return `<section class="unit-editor${state.unitConflictIds.includes(id) ? ' has-conflict' : ''}" aria-label="Unit">
    <span class="eyebrow">SELECTED UNIT</span>
    <h3>${esc(unit.name || 'Unit')}</h3>
    <p class="derived-line">${esc(derivedLine)}${spacing ? ` · ${esc(spacing)} spacing` : ''}</p>
    <label class="field">Unit name (required)<input data-unit-field="name" data-id="${esc(id)}" value="${esc(unit.name || '')}" maxlength="60"${invalid(`unit-name-${id}`)}></label>
    ${fieldError(`unit-name-${id}`)}
    <div class="field-pair">
      <div><label class="field">Side<select data-unit-field="side" data-id="${esc(id)}"${invalid(`unit-side-${id}`)}>${sideOptions}</select></label>${fieldError(`unit-side-${id}`)}</div>
      <div><label class="field">Troop type<select data-unit-field="troopType" data-id="${esc(id)}"${invalid(`unit-troopType-${id}`)}>${unknownOption}${troopOptions}</select></label>${fieldError(`unit-troopType-${id}`)}${unknownNote}</div>
    </div>
    <div class="field-pair">
      <div><label class="field">Soldiers<input type="number" data-unit-field="soldiers" data-id="${esc(id)}" min="1" step="1" value="${esc(unit.soldiers)}"${invalid(`unit-soldiers-${id}`)}></label>${fieldError(`unit-soldiers-${id}`)}</div>
      <div><label class="field">Files<input type="number" data-unit-field="files" data-id="${esc(id)}" min="1" step="1" value="${esc(unit.files)}"${invalid(`unit-files-${id}`)}></label>${fieldError(`unit-files-${id}`)}</div>
    </div>
    <label class="field">Spacing preset<select data-unit-field="preset" data-id="${esc(id)}"${invalid(`unit-preset-${id}`)}>
      ${presetKey === 'custom' ? '<option value="custom" selected>Custom spacings</option>' : ''}
      ${['close', 'normal', 'open'].map((key) => `<option value="${key}"${key === presetKey ? ' selected' : ''}>${esc(presetLabel(key))}</option>`).join('')}
    </select></label>
    ${fieldError(`unit-preset-${id}`)}
    <div class="field-pair">
      <div><label class="field">Lateral interval (m)<input type="number" data-unit-field="lateralInterval" data-id="${esc(id)}" min="0.1" max="10" step="0.1" value="${esc(unit.lateralInterval)}"${invalid(`unit-lateralInterval-${id}`)}></label>${fieldError(`unit-lateralInterval-${id}`)}</div>
      <div><label class="field">Rank depth (m)<input type="number" data-unit-field="rankDepth" data-id="${esc(id)}" min="0.1" max="10" step="0.1" value="${esc(unit.rankDepth)}"${invalid(`unit-rankDepth-${id}`)}></label>${fieldError(`unit-rankDepth-${id}`)}</div>
    </div>
    <p class="preset-note">A spacing preset pre-fills both spacings in metres; the scenario stores the metres (the preset itself is not stored).</p>
    <div class="field-pair">
      <div><label class="field">Position X (m)<input type="number" data-unit-field="positionX" data-id="${esc(id)}" step="0.1" value="${esc(unit.position?.x ?? '')}"${invalid(`unit-position-${id}`)}></label>${fieldError(`unit-position-${id}`)}</div>
      <div><label class="field">Position Y (m)<input type="number" data-unit-field="positionY" data-id="${esc(id)}" step="0.1" value="${esc(unit.position?.y ?? '')}"${invalid(`unit-position-${id}`)}></label></div>
    </div>
    <label class="field">Facing (°)<input type="number" data-unit-field="facing" data-id="${esc(id)}" min="0" max="360" step="1" value="${esc(unit.facing ?? '')}"${invalid(`unit-facing-${id}`)}></label>
    ${fieldError(`unit-facing-${id}`)}
    <p class="preset-note">Position is the midpoint of the front edge in metres; facing is a compass bearing (0 = north, clockwise). Dragging the unit or its rotation handle edits the same values.</p>
    <div class="unit-actions">
      <button class="btn-secondary" data-action="duplicate-unit" data-id="${esc(id)}">Duplicate</button>
      <button class="btn-quiet btn-danger" data-action="delete-unit" data-id="${esc(id)}">Delete</button>
    </div>
  </section>`;
}

function provisionalBadge(document) {
  if (!isProvisionalRuleset(document?.ruleset)) {
    return '';
  }
  return `<span class="provisional-badge" title="This scenario references a provisional 0.x ruleset version.">Provisional ruleset</span>`;
}

function inspectorView(document) {
  const size = document.battlefield;
  const errors = validateScenario(document);
  const warnings = collectWarnings(document);
  // Catalogue warnings (decision #5 item 13): one warning per unit whose
  // troop-type key is unknown. Saving stays allowed; the key is preserved.
  const catalogueWarnings = collectUnknownTroopTypeWarnings(document);
  // Ruleset notice (decision #5 item 12): an informational entry when the
  // scenario references an older version of the same ruleset. An explicit
  // Save rebinds the reference to the installed version.
  const rulesetNotice = rulesetCompatibilityNotice(document.ruleset);
  const notices = rulesetNotice ? [rulesetNotice] : [];
  const issueCount = errors.length + warnings.length + catalogueWarnings.length + notices.length;
  const fieldError = (name) =>
    state.fieldErrors[name] ? `<p class="field-error" role="alert">${esc(state.fieldErrors[name])}</p>` : '';
  const invalid = (name) => (state.fieldErrors[name] ? ' aria-invalid="true"' : '');
  const unit = selectedUnit();
  return `<div class="panel">${unit ? `${unitEditorView(document, unit)}<hr class="panel-divider">` : ''}
    <span class="eyebrow">SCENARIO INSPECTOR</span><h2>Scenario</h2>
    ${terrainInspectorView(document)}
    <label class="field">Title (required)<input data-field="title" value="${esc(document.title)}" maxlength="120"${invalid('title')}></label>
    ${fieldError('title')}
    <div class="field-pair">
      <div><label class="field">Width (m)<input type="number" data-field="width" min="1" max="${MAX_BATTLEFIELD_WIDTH_M}" step="0.1" value="${esc(size.width)}"${invalid('width')}></label>${fieldError('width')}</div>
      <div><label class="field">Height (m)<input type="number" data-field="height" min="1" max="${MAX_BATTLEFIELD_HEIGHT_M}" step="0.1" value="${esc(size.height)}"${invalid('height')}></label>${fieldError('height')}</div>
    </div>
    <label class="field">Description<textarea data-field="description" rows="3" maxlength="2000" placeholder="Optional plain-text description">${esc(document.description || '')}</textarea></label>
    <div class="kv"><dt>Units</dt><dd>${(document.units || []).length} units</dd></div>
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
      ${catalogueWarnings.map((warning) => `<p class="issue issue-warning">${esc(warning)}</p>`).join('')}
      ${notices.map((notice) => `<p class="issue issue-info">${esc(notice)}</p>`).join('')}
      ${issueCount === 0 ? '<p class="issues-empty">No issues.</p>' : '<p class="issues-note">Warnings and notices never block saving; errors must be fixed before saving.</p>'}
    </section>
    <dl>
      <div class="kv"><dt>Identifier</dt><dd class="mono">${esc(document.id)}</dd></div>
      <div class="kv"><dt>Format</dt><dd>${esc(document.kind)} · v${esc(document.formatVersion)}</dd></div>
      <div class="kv"><dt>Ruleset</dt><dd class="mono">${esc(document.ruleset.id)} ${esc(document.ruleset.version)} ${provisionalBadge(document)}</dd></div>
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

// --- Terrain mode (ground cover areas) --------------------------------------
// The left panel has two modes: the order of battle and the terrain list.
// Drawing, category changes, vertex edits, and deletions all commit through
// commitEdit, so every terrain change is undoable with no extra work.
const GROUND_COVER_LABELS = {
  forest: 'Forest',
  rough: 'Rough ground',
  water: 'Water',
  settlement: 'Settlement',
};

function groundCoverLabel(category) {
  return GROUND_COVER_LABELS[category] || String(category || 'Ground cover');
}

function groundFeatures(document) {
  return (document.terrainFeatures || []).filter(
    (feature) => feature && feature.kind === 'ground',
  );
}

function elevationFeatures(document) {
  return (document.terrainFeatures || []).filter(
    (feature) => feature && feature.kind === 'elevation',
  );
}

// Any selected terrain polygon (ground or hill): vertex handles, the vertex
// list, and the Delete key all key off this.
function selectedTerrainFeature(document) {
  if (!state.selectedTerrainId) return null;
  return (
    (document.terrainFeatures || []).find(
      (feature) =>
        feature?.id === state.selectedTerrainId &&
        (feature.kind === 'ground' || feature.kind === 'elevation'),
    ) || null
  );
}

function draftTitle(draft) {
  if (!draft) return '';
  if (draft.kind === 'elevation') return 'Hill';
  if (draft.kind === 'linear') return linearLabel(draft.category);
  return groundCoverLabel(draft.category);
}

function groundAreaSquareMetres(feature) {
  try {
    return Math.round(polygonArea(feature.polygon));
  } catch {
    return null;
  }
}

function categoryOptions(selected) {
  return GROUND_COVER_CATEGORIES.map(
    (category) =>
      `<option value="${category}"${category === selected ? ' selected' : ''}>${esc(groundCoverLabel(category))}</option>`,
  ).join('');
}

const LINEAR_LABELS = {
  river: 'River',
  road: 'Road',
};

function linearLabel(category) {
  return LINEAR_LABELS[category] || String(category || 'River or road');
}

function linearCategoryOptions(selected) {
  return LINEAR_FEATURE_CATEGORIES.map(
    (category) =>
      `<option value="${category}"${category === selected ? ' selected' : ''}>${esc(linearLabel(category))}</option>`,
  ).join('');
}

function linearFeatures(document) {
  return (document.terrainFeatures || []).filter(
    (feature) => feature && feature.kind === 'linear',
  );
}

function leftPanelView(document) {
  const isTerrain = state.leftMode === 'terrain';
  return `<div class="mode-tabs" role="tablist" aria-label="Left panel mode">
      <button class="mode-tab${isTerrain ? '' : ' active'}" role="tab" aria-selected="${String(!isTerrain)}" data-action="left-mode" data-mode="forces">Order of battle</button>
      <button class="mode-tab${isTerrain ? ' active' : ''}" role="tab" aria-selected="${String(isTerrain)}" data-action="left-mode" data-mode="terrain">Terrain</button>
    </div>
    ${isTerrain ? terrainPanelView(document) : orderOfBattleView(document)}`;
}

function terrainPanelView(document) {
  const grounds = groundFeatures(document);
  const hills = elevationFeatures(document);
  const linears = linearFeatures(document);
  const draft = state.terrainDraft;
  const drawing = draft
    ? draft.kind === 'linear'
      ? `<div class="terrain-drafting">
          <p>Drawing ${esc(linearLabel(draft.category))} (${esc(String(draft.width))} m wide) — click the map to add vertices (${draft.points.length}).</p>
          ${draft.error ? `<p class="field-error" role="alert">${esc(draft.error)}</p>` : ''}
          <div class="terrain-actions">
            <button class="btn-primary" data-action="terrain-draw-finish"${draft.points.length < 2 ? ' disabled' : ''}>Finish (Enter)</button>
            <button class="btn-secondary" data-action="terrain-draw-cancel">Cancel (Esc)</button>
          </div>
          <p class="terrain-hint">Enter finishes · Escape cancels · Backspace removes the last vertex. Lines reaching past the edge are clipped to the battlefield; rivers and roads may cross areas and each other.</p>
        </div>`
      : `<div class="terrain-drafting">
        <p>Drawing ${esc(draftTitle(draft))} — click the map to add vertices (${draft.points.length}).</p>
        ${draft.error ? `<p class="field-error" role="alert">${esc(draft.error)}</p>` : ''}
        <div class="terrain-actions">
          <button class="btn-primary" data-action="terrain-draw-finish"${draft.points.length < 3 ? ' disabled' : ''}>Finish (Enter)</button>
          <button class="btn-secondary" data-action="terrain-draw-cancel">Cancel (Esc)</button>
        </div>
        <p class="terrain-hint">Enter finishes · Escape cancels · Backspace removes the last vertex. Shapes reaching past the edge are clipped to the battlefield; overlapping areas and hills that break nesting are refused, never auto-adjusted.</p>
      </div>`
    : `<label class="field">New area category<select data-field="terrain-new-category">${categoryOptions(state.draftCategory)}</select></label>
      <div class="terrain-actions">
        <button class="btn-primary" data-action="terrain-draw-start" data-kind="ground">Draw area</button>
        <button class="btn-secondary" data-action="terrain-draw-start" data-kind="elevation">Draw hill</button>
      </div>
      <label class="field">New river or road<select data-field="terrain-new-linear-category">${linearCategoryOptions(state.draftLinearCategory)}</select></label>
      <label class="field">Width (m)<input type="number" data-field="terrain-new-linear-width" min="0.1" step="0.1" value="${esc(state.draftLinearWidth)}"></label>
      <div class="terrain-actions">
        <button class="btn-primary" data-action="terrain-line-draw-start">Draw river or road</button>
      </div>
      <p class="terrain-hint">Click vertices on the map, then finish from the keyboard. A refused shape is highlighted in red. Rivers and roads may cross ground cover, elevation, and each other.</p>`;
  const items = grounds
    .map((feature) => {
      const area = groundAreaSquareMetres(feature);
      const selected = feature.id === state.selectedTerrainId;
      return `<li class="terrain-row${selected ? ' selected' : ''}">
        <button class="terrain-select" data-action="terrain-select" data-id="${esc(feature.id)}" aria-pressed="${String(selected)}">
          <span class="swatch" style="background:${esc((GROUND_STYLES[feature.category] || {}).fill || '#cccccc')}"></span>
          <span><span class="unit-name">${esc(groundCoverLabel(feature.category))}</span>
          <span class="unit-detail">${feature.polygon.length} vertices${area === null ? '' : ` · ${area.toLocaleString('en')} m²`}</span></span>
        </button>
        <button class="btn-quiet btn-danger" data-action="terrain-delete" data-id="${esc(feature.id)}" title="Delete this area (undoable)">Delete</button>
      </li>`;
    })
    .join('');
  const hillItems = hills
    .map((feature) => {
      const area = groundAreaSquareMetres(feature);
      const selected = feature.id === state.selectedTerrainId;
      return `<li class="terrain-row${selected ? ' selected' : ''}">
        <button class="terrain-select" data-action="terrain-select" data-id="${esc(feature.id)}" aria-pressed="${String(selected)}">
          <span class="swatch" style="background:#c6c8a4"></span>
          <span><span class="unit-name">Hill · level ${esc(feature.level)}</span>
          <span class="unit-detail">${feature.polygon.length} vertices${area === null ? '' : ` · ${area.toLocaleString('en')} m²`}</span></span>
        </button>
        <button class="btn-quiet btn-danger" data-action="terrain-delete" data-id="${esc(feature.id)}" title="Delete this hill (nested hills are promoted, undoable)">Delete</button>
      </li>`;
    })
    .join('');
  const linearItems = linears
    .map((feature) => {
      const selected = feature.id === state.selectedTerrainId;
      return `<li class="terrain-row${selected ? ' selected' : ''}">
        <button class="terrain-select" data-action="terrain-select" data-id="${esc(feature.id)}" aria-pressed="${String(selected)}">
          <span class="swatch" style="background:${esc((LINEAR_STYLES[feature.category] || '#cccccc'))}"></span>
          <span><span class="unit-name">${esc(linearLabel(feature.category))} · ${esc(String(feature.width))} m</span>
          <span class="unit-detail">${feature.path.length} vertices · ${esc(String(feature.path.length - 1))} segments</span></span>
        </button>
        <button class="btn-quiet btn-danger" data-action="terrain-delete" data-id="${esc(feature.id)}" title="Delete this river or road (undoable)">Delete</button>
      </li>`;
    })
    .join('');
  return `<div class="panel"><span class="eyebrow">GROUND COVER · HILLS · RIVERS AND ROADS</span><h2>Terrain</h2>
    ${drawing}
    ${grounds.length ? `<ul class="terrain-list">${items}</ul>` : '<p class="empty-terrain">No ground cover areas yet. Open ground is the default; draw forest, rough ground, water, or a settlement.</p>'}
    <p class="readonly-note">Areas must not overlap; touching edge to edge is legal. Partly-outside shapes are clipped to the battlefield edge.</p>
    <h3 class="terrain-subhead">Hills (elevation)</h3>
    ${hills.length ? `<ul class="terrain-list">${hillItems}</ul>` : '<p class="empty-terrain">No hills yet. Draw a hill for level 1, then draw inside it for level 2, and so on — levels follow from nesting and are never typed.</p>'}
    <p class="readonly-note">Hills nest: a hill wholly inside level n becomes level n + 1. Crossing, straddling, and self-intersecting shapes are refused. Deleting a hill promotes its nested hills. Elevation is independent of ground cover.</p>
    <h3 class="terrain-subhead">Rivers and roads</h3>
    ${linears.length ? `<ul class="terrain-list">${linearItems}</ul>` : '<p class="empty-terrain">No rivers or roads yet. Draw a river or road, give it a width in metres, and edit its vertices on the map.</p>'}
    <p class="readonly-note">Rivers and roads may cross ground cover, hills, and each other. Lines reaching past the edge are clipped to the battlefield.</p>
  </div>`;
}

function terrainInspectorView(document) {
  const draft = state.terrainDraft;
  if (draft) {
    if (draft.kind === 'elevation') {
      return `<section class="terrain-inspector" aria-label="Hill being drawn">
      <h3>New hill</h3>
      <div class="kv"><dt>Level</dt><dd>Derived from nesting when finished (inside level n becomes level n + 1)</dd></div>
      <div class="kv"><dt>Vertices</dt><dd>${draft.points.length} (at least 3 to finish)</dd></div>
      ${draft.error ? `<p class="field-error" role="alert">${esc(draft.error)}</p>` : ''}
      <div class="terrain-actions">
        <button class="btn-primary" data-action="terrain-draw-finish"${draft.points.length < 3 ? ' disabled' : ''}>Finish (Enter)</button>
        <button class="btn-secondary" data-action="terrain-draw-cancel">Cancel (Esc)</button>
      </div>
    </section>`;
    }
    if (draft.kind === 'linear') {
      return `<section class="terrain-inspector" aria-label="River or road being drawn">
      <h3>New ${esc(linearLabel(draft.category))}</h3>
      <label class="field">Category<select data-field="terrain-draft-linear-category">${linearCategoryOptions(draft.category)}</select></label>
      <label class="field">Width (m)<input type="number" data-field="terrain-draft-linear-width" min="0.1" step="0.1" value="${esc(draft.width)}"></label>
      <div class="kv"><dt>Vertices</dt><dd>${draft.points.length} (at least 2 to finish)</dd></div>
      ${draft.error ? `<p class="field-error" role="alert">${esc(draft.error)}</p>` : ''}
      <div class="terrain-actions">
        <button class="btn-primary" data-action="terrain-draw-finish"${draft.points.length < 2 ? ' disabled' : ''}>Finish (Enter)</button>
        <button class="btn-secondary" data-action="terrain-draw-cancel">Cancel (Esc)</button>
      </div>
      <p class="terrain-hint">Set the category and width here; both travel with the finished line.</p>
    </section>`;
    }
    return `<section class="terrain-inspector" aria-label="Area being drawn">
      <h3>New ${esc(groundCoverLabel(draft.category))} area</h3>
      <label class="field">Category<select data-field="terrain-draft-category">${categoryOptions(draft.category)}</select></label>
      <div class="kv"><dt>Vertices</dt><dd>${draft.points.length} (at least 3 to finish)</dd></div>
      ${draft.error ? `<p class="field-error" role="alert">${esc(draft.error)}</p>` : ''}
      <div class="terrain-actions">
        <button class="btn-primary" data-action="terrain-draw-finish"${draft.points.length < 3 ? ' disabled' : ''}>Finish (Enter)</button>
        <button class="btn-secondary" data-action="terrain-draw-cancel">Cancel (Esc)</button>
      </div>
    </section>`;
  }
  const linear = linearFeatures(document).find((feature) => feature.id === state.selectedTerrainId) || null;
  if (linear) {
    const vertices = linear.path
      .map((point, index) => {
        const selected = index === state.selectedVertexIndex;
        return `<li class="terrain-vertex-row${selected ? ' selected' : ''}">
        <span class="mono">${index + 1}. (${point.x.toFixed(1)}, ${point.y.toFixed(1)})</span>
        <button class="btn-quiet btn-danger" data-action="terrain-vertex-delete" data-index="${index}"${linear.path.length <= 2 ? ' disabled' : ''} title="${linear.path.length <= 2 ? 'A river or road needs at least 2 vertices' : 'Delete this vertex (undoable)'}">Delete</button>
      </li>`;
      })
      .join('');
    return `<section class="terrain-inspector" aria-label="Selected river or road">
    <h3>${esc(linearLabel(linear.category))}</h3>
    <label class="field">Category<select data-field="terrain-linear-category" data-id="${esc(linear.id)}">${linearCategoryOptions(linear.category)}</select></label>
    <label class="field">Width (m)<input type="number" data-field="terrain-linear-width" data-id="${esc(linear.id)}" min="0.1" step="0.1" value="${esc(linear.width)}"></label>
    <div class="kv"><dt>Vertices</dt><dd>${linear.path.length}</dd></div>
    <ol class="terrain-vertex-list">${vertices}</ol>
    <div class="terrain-actions">
      <button class="btn-secondary btn-danger" data-action="terrain-delete" data-id="${esc(linear.id)}">Delete river or road</button>
    </div>
    <p class="terrain-hint">Drag a vertex on the map · click a small edge dot to insert a vertex · select a vertex and press Delete to remove it (at least two stay). Rivers and roads may cross everything.</p>
  </section>`;
  }
  const feature = selectedTerrainFeature(document);
  if (!feature) return '';
  const area = groundAreaSquareMetres(feature);
  const vertices = feature.polygon
    .map((point, index) => {
      const selected = index === state.selectedVertexIndex;
      return `<li class="terrain-vertex-row${selected ? ' selected' : ''}">
        <span class="mono">${index + 1}. (${point.x.toFixed(1)}, ${point.y.toFixed(1)})</span>
        <button class="btn-quiet btn-danger" data-action="terrain-vertex-delete" data-index="${index}"${feature.polygon.length <= 3 ? ' disabled' : ''} title="${feature.polygon.length <= 3 ? 'An area needs at least 3 vertices' : 'Delete this vertex (undoable)'}">Delete</button>
      </li>`;
    })
    .join('');
  if (feature.kind === 'elevation') {
    return `<section class="terrain-inspector" aria-label="Selected hill">
    <h3>Hill · level ${esc(feature.level)}</h3>
    <div class="kv"><dt>Level</dt><dd>${esc(feature.level)} (derived from nesting — never typed)</dd></div>
    <div class="kv"><dt>Area</dt><dd>${area === null ? '—' : `${area.toLocaleString('en')} m²`}</dd></div>
    <div class="kv"><dt>Vertices</dt><dd>${feature.polygon.length}</dd></div>
    <ol class="terrain-vertex-list">${vertices}</ol>
    <div class="terrain-actions">
      <button class="btn-secondary btn-danger" data-action="terrain-delete" data-id="${esc(feature.id)}">Delete hill</button>
    </div>
    <p class="terrain-hint">Drag a vertex on the map · click a small edge dot to insert a vertex · select a vertex and press Delete to remove it (at least three stay). Vertex edits that would break nesting are refused. Deleting this hill promotes its nested hills.</p>
  </section>`;
  }
  return `<section class="terrain-inspector" aria-label="Selected ground cover area">
    <h3>${esc(groundCoverLabel(feature.category))} area</h3>
    <label class="field">Category<select data-field="terrain-category" data-id="${esc(feature.id)}">${categoryOptions(feature.category)}</select></label>
    <div class="kv"><dt>Area</dt><dd>${area === null ? '—' : `${area.toLocaleString('en')} m²`}</dd></div>
    <div class="kv"><dt>Vertices</dt><dd>${feature.polygon.length}</dd></div>
    <ol class="terrain-vertex-list">${vertices}</ol>
    <div class="terrain-actions">
      <button class="btn-secondary btn-danger" data-action="terrain-delete" data-id="${esc(feature.id)}">Delete area</button>
    </div>
    <p class="terrain-hint">Drag a vertex on the map · click a small edge dot to insert a vertex · select a vertex and press Delete to remove it (at least three stay).</p>
  </section>`;
}

// Refuse a terrain edit without touching the document: highlight the candidate
// ring in red and explain why. Nothing is auto-clipped and nothing is
// committed, so the author can adjust the shape and try again.
function refuseTerrainEdit(reason, ring, conflictId, kind = 'ground') {
  state.terrainRefusal = { ring: Array.isArray(ring) ? ring : [], reason, conflictId, kind };
  state.status = reason;
  state.statusError = true;
  render();
}

// Drop a terrain selection that the document no longer holds (after undo,
// redo, or reopening). Called from render so the panels never show a ghost.
function pruneTerrainSelection() {
  if (!state.document) {
    return;
  }
  if (!state.selectedTerrainId) {
    return;
  }
  const holds = (state.document.terrainFeatures || []).some(
    (feature) => feature?.id === state.selectedTerrainId,
  );
  if (!holds) {
    state.selectedTerrainId = null;
    state.selectedVertexIndex = null;
  }
}

function beginDraft(draft) {
  state.terrainDraft = draft;
  state.selectedTerrainId = null;
  state.selectedVertexIndex = null;
  state.terrainRefusal = null;
  ensureMapView(state.document);
  // Drawing clicks with the hand tool would pan instead, so drafting selects.
  if (state.mapView.tool === 'hand') {
    state.mapView = { ...state.mapView, tool: 'select' };
  }
}

function startTerrainDraft(kind = 'ground') {
  if (!state.document || state.terrainDraft) {
    return;
  }
  const draftKind = kind === 'elevation' ? 'elevation' : 'ground';
  beginDraft(
    draftKind === 'elevation'
      ? { kind: 'elevation', points: [], error: '' }
      : { kind: 'ground', category: state.draftCategory, points: [], error: '' },
  );
  state.status = `Drawing ${draftTitle(state.terrainDraft)}: click the map to add vertices, Enter finishes, Esc cancels.`;
  state.statusError = false;
  render();
}

function startLinearDraft() {
  if (!state.document || state.terrainDraft) {
    return;
  }
  const width = Number(state.draftLinearWidth) > 0 ? Number(state.draftLinearWidth) : 10;
  beginDraft({ kind: 'linear', category: state.draftLinearCategory, width, points: [], error: '' });
  state.status = `Drawing ${linearLabel(state.terrainDraft.category)}: click the map to add vertices, Enter finishes, Esc cancels.`;
  state.statusError = false;
  render();
}

function cancelTerrainDraft() {
  if (!state.terrainDraft) {
    return;
  }
  state.terrainDraft = null;
  state.terrainRefusal = null;
  state.status = 'Drawing cancelled.';
  state.statusError = false;
  render();
}

function addDraftVertex(point) {
  const draft = state.terrainDraft;
  if (!draft || !state.document) {
    return;
  }
  const rounded = { x: round1(point.x), y: round1(point.y) };
  // A double click lands two vertices on the same spot: keep the first and
  // ignore the repeat, so the draft never holds a zero-length edge.
  const last = draft.points[draft.points.length - 1];
  if (last && last.x === rounded.x && last.y === rounded.y) {
    return;
  }
  draft.points.push(rounded);
  draft.error = '';
  // A new vertex is a new attempt: the last refusal highlight goes away.
  state.terrainRefusal = null;
  state.status = `Drawing ${draftTitle(draft)}: ${draft.points.length} vertices — Enter finishes, Esc cancels.`;
  state.statusError = false;
  render();
}

function popDraftVertex() {
  const draft = state.terrainDraft;
  if (!draft || draft.points.length === 0) {
    return;
  }
  draft.points.pop();
  draft.error = '';
  state.terrainRefusal = null;
  state.status = `Drawing ${draftTitle(draft)}: ${draft.points.length} vertices — Enter finishes, Esc cancels.`;
  state.statusError = false;
  render();
}

function finishPolygonDraft(draft) {
  const isHill = draft.kind === 'elevation';
  const needsVertices = isHill ? 'A hill needs at least 3 vertices.' : 'An area needs at least 3 vertices.';
  if (draft.points.length < 3) {
    draft.error = needsVertices;
    state.status = draft.error;
    state.statusError = true;
    render();
    return;
  }
  if (isHill) {
    const check = validateElevationCandidate(state.document, draft.points);
    if (!check.ok) {
      draft.error = `${check.reason[0].toUpperCase()}${check.reason.slice(1)}.`;
      refuseTerrainEdit(`Cannot add a hill: ${check.reason}.`, check.ring, check.conflictId);
      return;
    }
    let next;
    try {
      next = addElevationFeature(state.document, { polygon: draft.points });
    } catch (error) {
      draft.error = error.message;
      refuseTerrainEdit(error.message, draft.points, undefined);
      return;
    }
    const before = new Set((state.document.terrainFeatures || []).map((feature) => feature?.id));
    const added = (next.terrainFeatures || []).find((feature) => feature && !before.has(feature.id));
    const drawn = JSON.stringify(draft.points.map((point) => ({ x: round1(point.x), y: round1(point.y) })));
    const clipped = added && JSON.stringify(added.polygon) !== drawn;
    state.terrainDraft = null;
    state.selectedTerrainId = added ? added.id : null;
    state.selectedVertexIndex = null;
    commitEdit(next);
    toast(
      clipped
        ? `Hill level ${added?.level} added, clipped to the battlefield.`
        : `Hill level ${added?.level} added.`,
    );
    return;
  }
  const check = validateGroundCoverCandidate(state.document, draft.points);
  if (!check.ok) {
    draft.error = `${check.reason[0].toUpperCase()}${check.reason.slice(1)}.`;
    refuseTerrainEdit(
      `Cannot add a ground cover area: ${check.reason}.`,
      check.ring,
      check.conflictId,
      'ground',
    );
    return;
  }
  let next;
  try {
    next = addGroundCoverFeature(state.document, { category: draft.category, polygon: draft.points });
  } catch (error) {
    draft.error = error.message;
    refuseTerrainEdit(error.message, draft.points, undefined, 'ground');
    return;
  }
  const before = new Set((state.document.terrainFeatures || []).map((feature) => feature?.id));
  const added = (next.terrainFeatures || []).find((feature) => feature && !before.has(feature.id));
  const drawn = JSON.stringify(draft.points.map((point) => ({ x: round1(point.x), y: round1(point.y) })));
  const clipped = added && JSON.stringify(added.polygon) !== drawn;
  state.terrainDraft = null;
  state.draftCategory = draft.category;
  state.selectedTerrainId = added ? added.id : null;
  state.selectedVertexIndex = null;
  commitEdit(next);
  toast(
    clipped
      ? `${groundCoverLabel(draft.category)} area added, clipped to the battlefield.`
      : `${groundCoverLabel(draft.category)} area added.`,
  );
}

function finishLinearDraft(draft) {
  if (draft.points.length < 2) {
    draft.error = 'A river or road needs at least 2 vertices.';
    state.status = draft.error;
    state.statusError = true;
    render();
    return;
  }
  const width = Number(draft.width);
  if (!Number.isFinite(width) || width <= 0) {
    draft.error = 'Width must be a positive number of metres.';
    state.status = draft.error;
    state.statusError = true;
    render();
    return;
  }
  const check = validateLinearCandidate(state.document, draft.points);
  if (!check.ok) {
    draft.error = `${check.reason[0].toUpperCase()}${check.reason.slice(1)}.`;
    refuseTerrainEdit(
      `Cannot add a river or road: ${check.reason}.`,
      check.path,
      undefined,
      'linear',
    );
    return;
  }
  let next;
  try {
    next = addLinearFeature(state.document, {
      category: draft.category,
      path: draft.points,
      width,
    });
  } catch (error) {
    draft.error = error.message;
    refuseTerrainEdit(error.message, draft.points, undefined, 'linear');
    return;
  }
  const before = new Set((state.document.terrainFeatures || []).map((feature) => feature?.id));
  const added = (next.terrainFeatures || []).find((feature) => feature && !before.has(feature.id));
  const drawn = JSON.stringify(draft.points.map((point) => ({ x: round1(point.x), y: round1(point.y) })));
  const clipped = added && JSON.stringify(added.path) !== drawn;
  state.terrainDraft = null;
  state.draftLinearCategory = draft.category;
  state.draftLinearWidth = draft.width;
  state.selectedTerrainId = added ? added.id : null;
  state.selectedVertexIndex = null;
  commitEdit(next);
  toast(
    clipped
      ? `${linearLabel(draft.category)} added, clipped to the battlefield.`
      : `${linearLabel(draft.category)} added.`,
  );
}

function finishTerrainDraft() {
  const draft = state.terrainDraft;
  if (!draft || !state.document) {
    return;
  }
  if (draft.kind === 'linear') {
    finishLinearDraft(draft);
    return;
  }
  finishPolygonDraft(draft);
}

function selectTerrainFeature(id, vertexIndex = null) {
  if (!state.document) {
    return;
  }
  state.selectedTerrainId = id;
  state.selectedVertexIndex = vertexIndex;
  state.terrainRefusal = null;
  render();
}

function commitTerrainCategory(id, category) {
  if (!state.document) {
    return;
  }
  let next;
  try {
    next = updateGroundCoverFeature(state.document, id, { category });
  } catch (error) {
    state.status = error.message;
    state.statusError = true;
    render();
    return;
  }
  commitEdit(next);
  toast(`Area is now ${groundCoverLabel(category)}.`);
}

function commitLinearCategory(id, category) {
  if (!state.document) {
    return;
  }
  let next;
  try {
    next = updateLinearFeature(state.document, id, { category });
  } catch (error) {
    state.status = error.message;
    state.statusError = true;
    render();
    return;
  }
  commitEdit(next);
  toast(`Now a ${linearLabel(category)}.`);
}

function commitLinearWidth(id, raw) {
  if (!state.document) {
    return;
  }
  if (String(raw ?? '').trim() === '' || !Number.isFinite(Number(raw)) || Number(raw) <= 0) {
    state.status = 'Width must be a positive number of metres.';
    state.statusError = true;
    render();
    return;
  }
  let next;
  try {
    next = updateLinearFeature(state.document, id, { width: Number(raw) });
  } catch (error) {
    state.status = error.message;
    state.statusError = true;
    render();
    return;
  }
  commitEdit(next, `[data-field="terrain-linear-width"][data-id="${id}"]`);
  toast('Width updated.');
}

function deleteTerrainFeature(id) {
  if (!state.document) {
    return;
  }
  const feature = (state.document.terrainFeatures || []).find((entry) => entry?.id === id);
  if (!feature) {
    return;
  }
  const isHill = feature.kind === 'elevation';
  let next;
  try {
    next = feature.kind === 'linear'
      ? removeLinearFeature(state.document, id)
      : isHill
      ? removeElevationFeature(state.document, id)
      : removeGroundCoverFeature(state.document, id);
  } catch (error) {
    state.status = error.message;
    state.statusError = true;
    render();
    return;
  }
  if (state.selectedTerrainId === id) {
    state.selectedTerrainId = null;
    state.selectedVertexIndex = null;
  }
  commitEdit(next);
  toast(
    feature.kind === 'linear'
      ? `${linearLabel(feature.category)} deleted. Undo restores it.`
      : isHill
        ? `Hill deleted; nested hills promoted. Undo restores it.`
        : `${groundCoverLabel(feature.category)} area deleted. Undo restores it.`,
  );
}

function terrainValidateFor(feature, polygon, featureId) {
  if (feature?.kind === 'elevation') {
    return validateElevationCandidate(state.document, polygon, { ignoreId: featureId });
  }
  return validateGroundCoverCandidate(state.document, polygon, { ignoreId: featureId });
}

function terrainUpdateFor(featureId, isHill, polygon) {
  return isHill
    ? updateElevationFeature(state.document, featureId, { polygon })
    : updateGroundCoverFeature(state.document, featureId, { polygon });
}

function insertTerrainVertex(featureId, edgeIndex) {
  if (!state.document) {
    return;
  }
  const feature = (state.document.terrainFeatures || []).find((entry) => entry?.id === featureId);
  if (!feature) {
    return;
  }
  if (feature.kind === 'linear') {
    const line = feature.path;
    const a = line[edgeIndex];
    const b = line[edgeIndex + 1];
    if (!a || !b) {
      return;
    }
    const midpoint = { x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2) };
    const path = [...line.slice(0, edgeIndex + 1), midpoint, ...line.slice(edgeIndex + 1)];
    const check = validateLinearCandidate(state.document, path);
    if (!check.ok) {
      refuseTerrainEdit(`Cannot insert a vertex: ${check.reason}.`, check.path, undefined, 'linear');
      return;
    }
    commitEdit(updateLinearFeature(state.document, featureId, { path: check.path }));
    state.selectedTerrainId = featureId;
    state.selectedVertexIndex = edgeIndex + 1;
    render();
    toast('Vertex inserted.');
    return;
  }
  const ring = feature.polygon;
  if (!Array.isArray(ring)) {
    return;
  }
  const a = ring[edgeIndex];
  const b = ring[(edgeIndex + 1) % ring.length];
  if (!a || !b) {
    return;
  }
  const midpoint = { x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2) };
  const polygon = [...ring.slice(0, edgeIndex + 1), midpoint, ...ring.slice(edgeIndex + 1)];
  const check = terrainValidateFor(feature, polygon, featureId);
  if (!check.ok) {
    refuseTerrainEdit(`Cannot insert a vertex: ${check.reason}.`, check.ring, check.conflictId, 'ground');
    return;
  }
  commitEdit(terrainUpdateFor(featureId, feature.kind === 'elevation', check.ring));
  state.selectedTerrainId = featureId;
  state.selectedVertexIndex = edgeIndex + 1;
  render();
  toast('Vertex inserted.');
}

function deleteTerrainVertex(featureId, index) {
  if (!state.document) {
    return;
  }
  const feature = (state.document.terrainFeatures || []).find((entry) => entry?.id === featureId);
  if (!feature) {
    return;
  }
  if (feature.kind === 'linear') {
    if (!feature.path[index]) {
      return;
    }
    if (feature.path.length <= 2) {
      state.status = 'A river or road needs at least 2 vertices: the vertex stays.';
      state.statusError = true;
      render();
      return;
    }
    const path = feature.path.filter((_, other) => other !== index);
    const check = validateLinearCandidate(state.document, path);
    if (!check.ok) {
      refuseTerrainEdit(`Cannot delete the vertex: ${check.reason}.`, check.path, undefined, 'linear');
      return;
    }
    commitEdit(updateLinearFeature(state.document, featureId, { path: check.path }));
    state.selectedTerrainId = featureId;
    state.selectedVertexIndex = null;
    render();
    toast('Vertex deleted.');
    return;
  }
  if (!feature.polygon || !feature.polygon[index]) {
    return;
  }
  if (feature.polygon.length <= 3) {
    state.status = feature.kind === 'elevation'
      ? 'A hill needs at least 3 vertices: the vertex stays.'
      : 'An area needs at least 3 vertices: the vertex stays.';
    state.statusError = true;
    render();
    return;
  }
  const polygon = feature.polygon.filter((_, other) => other !== index);
  const check = terrainValidateFor(feature, polygon, featureId);
  if (!check.ok) {
    refuseTerrainEdit(`Cannot delete the vertex: ${check.reason}.`, check.ring, check.conflictId, 'ground');
    return;
  }
  commitEdit(terrainUpdateFor(featureId, feature.kind === 'elevation', check.ring));
  state.selectedTerrainId = featureId;
  state.selectedVertexIndex = null;
  render();
  toast('Vertex deleted.');
}

function commitDraggedVertex(featureId, index, point) {
  if (!state.document) {
    return;
  }
  const feature = (state.document.terrainFeatures || []).find((entry) => entry?.id === featureId);
  if (!feature) {
    return;
  }
  if (feature.kind === 'linear') {
    if (!feature.path[index]) {
      return;
    }
    const path = feature.path.map((vertex, other) =>
      other === index ? { x: round1(point.x), y: round1(point.y) } : vertex,
    );
    const check = validateLinearCandidate(state.document, path);
    if (!check.ok) {
      refuseTerrainEdit(`Cannot move the vertex: ${check.reason}.`, check.path, undefined, 'linear');
      return;
    }
    commitEdit(updateLinearFeature(state.document, featureId, { path: check.path }));
    state.selectedTerrainId = featureId;
    state.selectedVertexIndex = index;
    render();
    return;
  }
  if (!feature.polygon || !feature.polygon[index]) {
    return;
  }
  const polygon = feature.polygon.map((vertex, other) =>
    other === index ? { x: round1(point.x), y: round1(point.y) } : vertex,
  );
  const check = terrainValidateFor(feature, polygon, featureId);
  if (!check.ok) {
    refuseTerrainEdit(`Cannot move the vertex: ${check.reason}.`, check.ring, check.conflictId, 'ground');
    return;
  }
  commitEdit(terrainUpdateFor(featureId, feature.kind === 'elevation', check.ring));
  state.selectedTerrainId = featureId;
  state.selectedVertexIndex = index;
  render();
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
      ${provisionalBadge(document)}
      <span class="spacer"></span>
      ${isDirty() ? '<span class="dirty-pill" title="The scenario differs from the saved version."><span class="dirty-dot" aria-hidden="true"></span>Unsaved changes</span>' : ''}
      <span class="status${state.statusError ? ' error' : ''}">${esc(state.status || defaultStatus())}</span>
      <button class="btn-tool" data-action="undo"${canUndo ? '' : ' disabled'} title="Undo (Ctrl/⌘+Z)">Undo</button>
      <button class="btn-tool" data-action="redo"${canRedo ? '' : ' disabled'} title="Redo (Shift+Ctrl/⌘+Z)">Redo</button>
      <button class="btn-secondary" data-action="export">Export</button>
      <button class="btn-primary" data-action="save">Save</button>
      <button class="btn-primary" data-action="start-battle-editor"${isDirty() ? ' disabled title="Save before starting a battle."' : ''}>Start battle</button>
    </div>
    <main class="workspace">
      <aside class="left-panel">${leftPanelView(document)}</aside>
      <section class="map-panel">
        <div class="map-caption">${metres(width)} × ${metres(height)} · origin south-west · metres</div>
        ${mapToolbarView()}
        <div class="map-viewport${state.mapView.tool === 'hand' ? ' tool-hand' : ''}${state.spaceHeld ? ' space-pan' : ''}${state.terrainDraft ? ' drafting' : ''}">
          ${battlefieldSvg(document, state.mapView, terrainOverlay(document))}
          ${state.terrainDraft ? `<p class="map-terrain-hint" role="status">Drawing ${esc(draftTitle(state.terrainDraft))} · ${state.terrainDraft.points.length} vertices · click the map, Enter finishes, Esc cancels</p>` : ''}
          <div class="map-status">
            <span class="scale-bar" aria-label="Scale bar"><span id="scale-bar"></span><span id="scale-bar-label">—</span></span>
            <span id="cursor-coords" class="cursor-coords" aria-label="Cursor coordinates in metres">X — · Y —</span>
          </div>
        </div>
        <p class="map-hint">Click a Unit to select it · drag to place it (a refused drop returns and highlights the conflict) · drag the round handle to rotate about the front midpoint (snaps to ${FACING_SNAP_DEG}°, hold Shift for free rotation) · scroll to zoom · hand tool or Space to pan</p>
      </section>
      <aside class="right-panel">${inspectorView(document)}</aside>
    </main>${conflictDialogView()}`;
}

// Asked when the stored revision moved since the scenario was opened (for
// example in another tab). Overwrite keeps the identifier and moves the
// revision forward; Save as copy keeps both versions under a new identifier.
function conflictDialogView() {
  if (!state.conflict) return '';
  const { loadedRevision, storedRevision } = state.conflict;
  return `<div class="conflict-backdrop">
    <section class="conflict-dialog" role="dialog" aria-modal="true" aria-labelledby="conflict-title">
      <h2 id="conflict-title">This scenario changed elsewhere</h2>
      <p>The stored copy is now at revision ${esc(String(storedRevision))}, but this
      editor opened revision ${esc(String(loadedRevision))}. Overwriting replaces the
      stored copy; saving as a copy keeps both under a new identifier.</p>
      <div class="conflict-actions">
        <button class="btn-primary" data-action="conflict-overwrite">Overwrite</button>
        <button class="btn-secondary" data-action="conflict-copy">Save as copy</button>
        <button class="btn-quiet" data-action="conflict-cancel">Cancel</button>
      </div>
    </section>
  </div>`;
}

function render(refocusSelector) {
  pruneTerrainSelection();
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
  const entry = (await state.store.list()).find((item) => item.id === id);
  if (!entry) {
    toast('Scenario not found. It may have been deleted.');
    await refreshLibrary();
    render();
    return;
  }
  // Entries that cannot be read are never opened, and documents with a newer
  // format version are refused: the stored data is left untouched.
  if (entry.status !== 'ok') {
    toast(entry.cause || 'This scenario cannot be opened.');
    await refreshLibrary();
    render();
    return;
  }
  const document = await state.store.load(id);
  if (!document) {
    toast('Scenario not found. It may have been deleted.');
    await refreshLibrary();
    render();
    return;
  }
  if (isUnsupportedDocument(document)) {
    toast(
      `This scenario needs a newer application (format version ${document.formatVersion}); the stored data was left untouched.`,
    );
    await refreshLibrary();
    render();
    return;
  }
  // Ruleset mismatch (decision #5 item 12): an unknown ruleset identifier or
  // a newer version of the same ruleset is never opened, and the stored data
  // is left untouched. An older version opens against the current catalogue.
  const reference = classifyRulesetReference(document.ruleset);
  if (reference.status === 'unknown-ruleset' || reference.status === 'newer') {
    toast(
      reference.status === 'unknown-ruleset'
        ? `This scenario references an ${reference.cause}; the stored data was left untouched.`
        : `This scenario ${reference.cause}.`,
    );
    await refreshLibrary();
    render();
    return;
  }
  state.document = document;
  // A reopened scenario starts with a clean slate: the saved version for
  // the unsaved-changes indicator and an empty undo history.
  state.savedDocument = cloneScenario(document);
  state.revision = Number.isInteger(entry.revision) ? entry.revision : null;
  state.history = { past: [], future: [] };
  state.fieldErrors = {};
  state.problems = [];
  state.dirty = false;
  state.conflict = null;
  state.selectedUnitId = null;
  state.unitConflictIds = [];
  state.view = 'editor';
  state.leftMode = 'forces';
  state.selectedTerrainId = null;
  state.selectedVertexIndex = null;
  state.terrainDraft = null;
  state.terrainRefusal = null;
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

// The terrain overlay is display state (draft, selection, refusal): it never
// touches the document and never marks the scenario as unsaved.
function terrainOverlay(document) {
  return {
    selectedId: state.selectedTerrainId,
    selectedIndex: state.selectedVertexIndex,
    draft: state.terrainDraft,
    refusal: state.terrainRefusal,
  };
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

// --- Map selection, dragging, and rotation ---------------------------------
// Clicking selects the topmost unit whose real footprint is hit (with a
// screen-pixel tolerance); dragging moves it; the rotation handle pivots the
// footprint about the front midpoint with 15° snapping (Shift disables snap).
// Drops and rotations commit through proposeUnitPatch: a refused placement is
// never committed, the unit returns, and the conflict is highlighted. Every
// committed move goes through commitEdit, so placement and rotation are
// undoable like any other scenario change. Selection and the live drag
// preview never touch the undo history.
let activePointerDrag = null;

function cancelPointerDrag() {
  if (!activePointerDrag) {
    return false;
  }
  activePointerDrag = null;
  render();
  return true;
}

// SVG rotate() turns clockwise like a compass bearing; normalize for display.
function displayFacing(facing) {
  const value = normalizeFacing(facing);
  return value > 180 ? value - 360 : value;
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

  // Terrain clicks: drawing adds a vertex, an edge dot inserts one, a ground
  // area or hill polygon selects it, and empty map clears the selection.
  // Panning (hand tool, Space, middle button) always wins over terrain clicks.
  svg.addEventListener('click', (event) => {
    if (suppressMapClick) {
      suppressMapClick = false;
      return;
    }
    if (!state.document || event.ctrlKey || event.metaKey || event.altKey) return;
    const handActive = state.mapView.tool === 'hand' || state.spaceHeld;
    if (handActive) return;
    const target = event.target;
    const vertexHandle = target?.closest?.('[data-vertex-index]');
    const edgeHandle = target?.closest?.('[data-edge-index]');
    if (state.terrainDraft) {
      // Handles have their own pointer handlers; anywhere else adds a vertex.
      if (vertexHandle || edgeHandle) return;
      const cursor = svgToMap(svg, event.clientX, event.clientY);
      if (!cursor) return;
      addDraftVertex(cursor);
      return;
    }
    if (edgeHandle) {
      insertTerrainVertex(
        edgeHandle.dataset.featureId,
        Number(edgeHandle.dataset.edgeIndex),
      );
      return;
    }
    if (vertexHandle) {
      selectTerrainFeature(
        vertexHandle.dataset.featureId,
        Number(vertexHandle.dataset.vertexIndex),
      );
      return;
    }
    const ground = target?.closest?.('[data-feature-id]');
    if (ground && ground.dataset.featureId) {
      if (state.leftMode === 'terrain') selectTerrainFeature(ground.dataset.featureId);
      return;
    }
    if (state.leftMode === 'terrain' && (state.selectedTerrainId || state.selectedVertexIndex !== null)) {
      state.selectedTerrainId = null;
      state.selectedVertexIndex = null;
      render();
    }
  });

  let pan = null;
  const capturePointer = (event) => {
    try {
      svg.setPointerCapture(event.pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  };
  svg.addEventListener('pointerdown', (event) => {
    const handActive = state.mapView.tool === 'hand' || state.spaceHeld || event.button === 1;
    // Dragging a vertex moves it; the pointerup commits one undo step, and a
    // refused move highlights the candidate and keeps the old geometry.
    const vertexHandle = event.target?.closest?.('[data-vertex-index]');
    if (
      vertexHandle &&
      !state.terrainDraft &&
      !handActive &&
      event.button === 0 &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      terrainDrag = {
        featureId: vertexHandle.dataset.featureId,
        index: Number(vertexHandle.dataset.vertexIndex),
        pointerId: event.pointerId,
        pending: null,
      };
      capturePointer(event);
      return;
    }
    if (handActive) {
      if (event.button !== 0 && event.button !== 1) return;
      event.preventDefault();
      pan = { x: event.clientX, y: event.clientY };
      capturePointer(event);
      viewport.classList.add('panning');
      return;
    }
    // Select-tool unit interaction: the rotation handle first, then the real
    // footprint with a screen-pixel tolerance. Anything else (empty ground,
    // terrain, labels outside the footprint) starts no drag.
    if (event.button !== 0 || !state.document || state.mapView.tool !== 'select') return;
    const handle = event.target?.closest?.('[data-rotate-handle]');
    const handleId = handle?.dataset?.rotateHandle;
    const handleUnit = handleId ? unitById(state.document, handleId) : null;
    if (handleUnit?.position) {
      event.preventDefault();
      activePointerDrag = {
        kind: 'rotate',
        unitId: handleUnit.id,
        startClient: { clientX: event.clientX, clientY: event.clientY },
        origin: { ...handleUnit.position },
        moved: false,
        previewFacing: undefined,
      };
      capturePointer(event);
      return;
    }
    const cursor = svgToMap(svg, event.clientX, event.clientY);
    if (!cursor) return;
    const picked = pickUnitIdAtPoint(state.document, cursor, currentMpp() * UNIT_PICK_TOLERANCE_PX);
    const pickedUnit = picked ? unitById(state.document, picked) : null;
    if (!pickedUnit?.position) return;
    event.preventDefault();
    activePointerDrag = {
      kind: 'move',
      unitId: pickedUnit.id,
      startClient: { clientX: event.clientX, clientY: event.clientY },
      startMap: cursor,
      origin: { ...pickedUnit.position },
      moved: false,
      preview: undefined,
    };
    capturePointer(event);
  });
  svg.addEventListener('pointermove', (event) => {
    // A live drag preview suppresses the cursor readout for moves; rotations
    // report the live facing instead.
    if (!activePointerDrag?.moved) {
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
    }
    if (pan) {
      const dxPx = event.clientX - pan.x;
      const dyPx = event.clientY - pan.y;
      pan = { x: event.clientX, y: event.clientY };
      const next = panMapViewByPixels(state.mapView, dxPx, dyPx, currentMpp());
      setMapView({ ...state.mapView, ...next });
      return;
    }
    if (terrainDrag && event.pointerId === terrainDrag.pointerId) {
      const cursor = svgToMap(svg, event.clientX, event.clientY);
      if (cursor) {
        const pending = { x: round1(cursor.x), y: round1(cursor.y) };
        terrainDrag.pending = pending;
        // Move the handle under the pointer without re-rendering: the
        // document only changes on pointerup.
        const handle = svg.querySelector(
          `[data-vertex-index="${terrainDrag.index}"]`,
        );
        if (handle) {
          handle.setAttribute('cx', String(pending.x));
          handle.setAttribute('cy', String(state.document.battlefield.height - pending.y));
        }
      }
      return;
    }
    if (!activePointerDrag) return;
    const drag = activePointerDrag;
    if (
      !drag.moved &&
      Math.hypot(event.clientX - drag.startClient.clientX, event.clientY - drag.startClient.clientY) > 4
    ) {
      drag.moved = true;
      viewport.classList.add('unit-dragging');
      if (drag.kind === 'move' && state.selectedUnitId !== drag.unitId) {
        // Select on drag start without rebuilding the map mid-gesture: the
        // full render happens on drop.
        state.selectedUnitId = drag.unitId;
        state.fieldErrors = {};
        state.unitConflictIds = [];
        for (const node of svg.querySelectorAll('g.unit.selected')) {
          node.classList.remove('selected');
        }
        svg.querySelector(`g.unit[data-unit-id="${CSS.escape(drag.unitId)}"]`)?.classList.add('selected');
      }
    }
    if (!drag.moved) return;
    const cursor = svgToMap(svg, event.clientX, event.clientY);
    if (!cursor) return;
    if (drag.kind === 'move') {
      const preview = {
        x: drag.origin.x + (cursor.x - drag.startMap.x),
        y: drag.origin.y + (cursor.y - drag.startMap.y),
      };
      drag.preview = preview;
      const node = svg.querySelector(`g.unit[data-unit-id="${CSS.escape(drag.unitId)}"]`);
      if (node) {
        const screen = toScreenPoint(preview, state.document.battlefield.height);
        node.setAttribute('transform', `translate(${screen.x} ${screen.y})`);
      }
    } else if (drag.kind === 'rotate') {
      const dx = cursor.x - drag.origin.x;
      const dy = cursor.y - drag.origin.y;
      if (Math.hypot(dx, dy) <= 1e-9) return;
      const raw = (Math.atan2(dx, dy) * 180) / Math.PI;
      const facing = event.shiftKey ? normalizeFacing(raw) : snapFacing(raw, FACING_SNAP_DEG);
      drag.previewFacing = facing;
      const rotor = svg.querySelector(
        `g.unit[data-unit-id="${CSS.escape(drag.unitId)}"] .unit-rotor`,
      );
      if (rotor) {
        rotor.setAttribute('transform', `rotate(${displayFacing(facing)})`);
      }
      const coords = $('#cursor-coords');
      if (coords) {
        coords.textContent = event.shiftKey
          ? `Facing ${facing.toFixed(1)}° (free rotation)`
          : `Facing ${facing.toFixed(0)}° (snaps to ${FACING_SNAP_DEG}°, hold Shift for free)`;
        coords.classList.remove('outside');
      }
    }
  });
  const endGesture = (event) => {
    if (pan && (!event || event.type !== 'pointermove')) {
      pan = null;
      viewport.classList.remove('panning');
    }
    if (!activePointerDrag) return;
    const drag = activePointerDrag;
    activePointerDrag = null;
    viewport.classList.remove('unit-dragging');
    if (!drag.moved) {
      if (drag.kind === 'move') {
        // Click: single selection toggles. The pointerdown already hit-tested
        // the real footprint, so this is a true footprint click.
        state.selectedUnitId = state.selectedUnitId === drag.unitId ? null : drag.unitId;
        state.fieldErrors = {};
        state.unitConflictIds = [];
        render();
      } else {
        render();
      }
      return;
    }
    if (drag.kind === 'move' && drag.preview) {
      commitUnitGeometry(drag.unitId, { position: drag.preview });
      return;
    }
    if (drag.kind === 'rotate' && drag.previewFacing !== undefined) {
      commitUnitGeometry(drag.unitId, { facing: drag.previewFacing });
      return;
    }
    render();
  };
  const endDrag = (event) => {
    if (terrainDrag && event.pointerId === terrainDrag.pointerId) {
      const { featureId, index, pending } = terrainDrag;
      terrainDrag = null;
      // The pointerup after a drag must not also add a draft vertex.
      suppressMapClick = true;
      if (pending) {
        commitDraggedVertex(featureId, index, pending);
      } else {
        selectTerrainFeature(featureId, index);
      }
      return true;
    }
    return false;
  };
  svg.addEventListener('pointerup', (event) => {
    if (endDrag(event)) return;
    endGesture(event);
  });
  svg.addEventListener('pointercancel', (event) => {
    if (endDrag(event)) return;
    const wasActive = pan || activePointerDrag;
    pan = null;
    activePointerDrag = null;
    viewport.classList.remove('panning');
    viewport.classList.remove('unit-dragging');
    if (wasActive) render();
  });
  });
  svg.addEventListener('pointerleave', () => {
    const coords = $('#cursor-coords');
    if (coords && !pan && !activePointerDrag?.moved) coords.textContent = 'X — · Y —';
  });
}

function setStatusAfterRender(message) {
  state.status = message;
  state.statusError = false;
}

// The first save that needs browser storage requests persistent storage;
// when the browser refuses, the library shows an unobtrusive notice that
// data may be removed and recommends export as the only backup.
async function ensurePersistenceOnce() {
  if (state.persistRequested) return state.persistent;
  state.persistRequested = true;
  state.persistent = await ensurePersistentStorage();
  return state.persistent;
}

// Fold an older ruleset reference into the installed one as part of an
// explicit Save (decision #5 item 12). Opening never rebinds, so a scenario
// that only sits in the editor keeps its stored reference; the rebound
// version is what Save validates and stores. Not an undo step: the rebind is
// part of the save itself.
function commitRulesetRebind() {
  if (!state.document) {
    return;
  }
  const rebound = rebindRulesetToCurrent(state.document);
  if (JSON.stringify(rebound.ruleset) === JSON.stringify(state.document.ruleset)) {
    return;
  }
  state.document = rebound;
  state.fieldErrors = {};
}

async function saveScenario(options = {}) {
  const overwrite = options.overwrite === true;
  // An explicit Save rebinds an older ruleset reference to the installed
  // catalogue (decision #5 item 12). Opening never rebinds: only this path
  // changes the reference, and the rebound document is what is validated and
  // stored. Unknown troop-type keys are preserved verbatim either way.
  const reference = classifyRulesetReference(state.document?.ruleset);
  if (reference.status === 'older') {
    commitRulesetRebind();
  }
  // Structural errors block saving; completeness warnings, catalogue warnings,
  // and the ruleset notice (the issues panel) never do: a scenario with
  // warnings still saves.
  const errors = validateScenario(state.document);
  if (errors.length) {
    state.status = 'Cannot save: fix the highlighted problems.';
    state.statusError = true;
    state.dirty = true;
    render();
    return;
  }
  await ensurePersistenceOnce();
  const storedEntry = (await state.store.list()).find(
    (item) => item.id === state.document.id,
  );
  const storedRevision =
    storedEntry && Number.isInteger(storedEntry.revision)
      ? storedEntry.revision
      : null;
  try {
    const metadata = await performSave(state.store, state.document, {
      loadedRevision: state.revision,
      storedRevision,
      overwrite,
    });
    state.document = await state.store.load(metadata.id);
    state.savedDocument = cloneScenario(state.document);
    state.revision = metadata.revision;
    state.fieldErrors = {};
    state.problems = [];
    state.dirty = false;
    state.conflict = null;
    state.unitConflictIds = [];
    state.status = `Saved · rev. ${metadata.revision} · ${new Date(metadata.updatedAt).toLocaleTimeString('en')}`;
    state.statusError = false;
    await refreshLibrary();
    render();
    toast('Scenario saved.');
  } catch (error) {
    if (error instanceof SaveConflictError) {
      state.conflict = {
        loadedRevision: state.revision,
        storedRevision: error.storedRevision,
      };
      state.dirty = true;
      render();
      return;
    }
    // The store save is atomic: a failure (for example a quota error) leaves
    // the previous version intact, so the author keeps working on the same
    // unsaved changes instead of losing them.
    state.dirty = true;
    state.status = isQuotaError(error)
      ? quotaFailureMessage('Save')
      : `Save failed: ${error.message}`;
    state.statusError = true;
    render();
  }
}

async function saveConflictCopy() {
  state.conflict = null;
  try {
    await ensurePersistenceOnce();
    const copy = duplicateScenario(state.document);
    const metadata = await state.store.save(copy);
    await refreshLibrary();
    await openScenario(metadata.id);
    toast(`Saved as a new copy: ${copy.title}.`);
  } catch (error) {
    state.dirty = true;
    state.status = isQuotaError(error)
      ? quotaFailureMessage('Save as copy')
      : `Save as copy failed: ${error.message}`;
    state.statusError = true;
    render();
  }
}

async function duplicateScenarioById(id) {
  const document = await state.store.load(id);
  if (!document) {
    toast('Scenario not found. It may have been deleted.');
    await refreshLibrary();
    render();
    return;
  }
  if (isUnsupportedDocument(document)) {
    toast(
      `Cannot duplicate: this scenario needs a newer application (format version ${document.formatVersion}).`,
    );
    return;
  }
  // Duplicating never opens the scenario, but a copy of a reference that
  // cannot open is another entry that cannot open: refuse it like opening.
  const reference = classifyRulesetReference(document.ruleset);
  if (reference.status === 'unknown-ruleset' || reference.status === 'newer') {
    toast(
      reference.status === 'unknown-ruleset'
        ? `Cannot duplicate: this scenario references an ${reference.cause}; the stored data was left untouched.`
        : `Cannot duplicate: this scenario ${reference.cause}.`,
    );
    return;
  }
  try {
    await ensurePersistenceOnce();
    const copy = duplicateScenario(document);
    const metadata = await state.store.save(copy);
    await refreshLibrary();
    render();
    toast(`Duplicated as "${copy.title}".`);
  } catch (error) {
    toast(`Duplicate failed: ${error.message}`);
  }
}

async function exportRawScenarioById(id) {
  const record = await state.store.loadRaw(id);
  if (!record) {
    toast('Nothing to export.');
    return;
  }
  try {
    const { fileName, json } = exportRawRecord(record);
    downloadFile(fileName, json);
    toast(`Exported raw ${fileName}.`);
  } catch (error) {
    toast(`Export failed: ${error.message}`);
  }
}

// Quota failures never lose work: the store save is atomic, so the previous
// version is intact and the author keeps the same unsaved changes.
function quotaFailureMessage(what) {
  return `${what} failed: browser storage is full (quota exceeded). The previous version is intact; your changes are still here.`;
}

function updateDirtyDom() {
  if (state.view !== 'editor') return;
  const statusElement = $('.status');
  if (statusElement) {
    statusElement.textContent = state.status;
    statusElement.classList.toggle('error', state.statusError);
  }
  const head = $('.editor-head');
  if (!head) return;
  let flag = $('.dirty-flag');
  if (state.dirty && !flag) {
    flag = document.createElement('span');
    flag.className = 'dirty-flag';
    flag.title = 'Unsaved changes';
    flag.textContent = '● unsaved';
    statusElement?.after(flag);
  } else if (!state.dirty && flag) {
    flag.remove();
  }
}

function markDirty(message = 'Unsaved changes', isError = false) {
  state.dirty = true;
  state.status = message;
  state.statusError = isError;
  updateDirtyDom();
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
    await ensurePersistenceOnce();
    const metadata = await state.store.save(copy);
    await refreshLibrary();
    await openScenario(metadata.id);
    toast(`Imported as a new copy: ${copy.title}.`);
  } catch (error) {
    toast(error.message);
  }
}

document.addEventListener('click', async (event) => {
  // Map unit selection is handled by the map pointer gesture (pointerdown
  // hit-tests the real footprint, pointerup toggles on a click): clicks
  // reaching the document carry no selection meaning.
  const element = event.target.closest('[data-action]');
  if (!element || element.disabled) return;
  const { action, id } = element.dataset;
  if (action === 'open') await openScenario(id);
  // A battle starts from a saved scenario: the setup screen loads the stored
  // document by id. From the editor the button is disabled while there are
  // unsaved changes, and the guard below refuses the navigation as well.
  if (action === 'start-battle') {
    location.href = `battle.html?id=${encodeURIComponent(id)}`;
    return;
  }
  if (action === 'start-battle-editor') {
    if (isDirty()) {
      toast('Save before starting a battle: the setup screen starts from the saved scenario.');
      return;
    }
    if (!state.document) return;
    location.href = `battle.html?id=${encodeURIComponent(state.document.id)}`;
    return;
  }
  if (action === 'undo') {
    undoEdit('[data-action="undo"]');
    return;
  }
  if (action === 'redo') {
    redoEdit('[data-action="redo"]');
    return;
  }
  if (action === 'left-mode') {
    const mode = element.dataset.mode === 'terrain' ? 'terrain' : 'forces';
    if (state.leftMode !== mode) {
      state.leftMode = mode;
      render();
    }
    return;
  }
  if (action === 'terrain-draw-start') {
    startTerrainDraft(element.dataset.kind === 'elevation' ? 'elevation' : 'ground');
    return;
  }
  if (action === 'terrain-line-draw-start') {
    startLinearDraft();
    return;
  }
  if (action === 'terrain-draw-finish') {
    finishTerrainDraft();
    return;
  }
  if (action === 'terrain-draw-cancel') {
    cancelTerrainDraft();
    return;
  }
  if (action === 'terrain-select') {
    selectTerrainFeature(id);
    return;
  }
  if (action === 'terrain-delete') {
    deleteTerrainFeature(id);
    return;
  }
  if (action === 'terrain-vertex-delete') {
    deleteTerrainVertex(state.selectedTerrainId, Number(element.dataset.index));
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
    state.selectedUnitId = null;
    state.unitConflictIds = [];
    state.status = '';
    state.statusError = false;
    state.dirty = false;
    state.conflict = null;
    await refreshLibrary();
    render();
  }
  if (action === 'select-unit') {
    state.selectedUnitId = state.selectedUnitId === id ? null : id;
    state.fieldErrors = {};
    state.unitConflictIds = [];
    render();
    return;
  }
  if (action === 'add-unit') {
    commitAddUnit(element.dataset.side);
    return;
  }
  if (action === 'duplicate-unit') {
    commitDuplicateUnit(id);
    return;
  }
  if (action === 'delete-unit') {
    commitDeleteUnit(id);
    return;
  }
  if (action === 'save') await saveScenario();
  if (action === 'duplicate') await duplicateScenarioById(id);
  if (action === 'conflict-overwrite') {
    state.conflict = null;
    await saveScenario({ overwrite: true });
    return;
  }
  if (action === 'conflict-copy') {
    await saveConflictCopy();
    return;
  }
  if (action === 'conflict-cancel') {
    state.conflict = null;
    render();
    return;
  }
  if (handleMapAction(action)) return;
  if (action === 'export') await exportScenarioById(id || null);
  if (action === 'export-raw') await exportRawScenarioById(id);
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
  const unitField = event.target.dataset?.unitField;
  if (unitField) {
    const unitId = event.target.dataset?.id;
    if (unitField === 'preset') {
      if (event.target.value && event.target.value !== 'custom') {
        commitUnitPreset(unitId, event.target.value);
      }
      return;
    }
    commitUnitField(unitId, unitField, event.target.value);
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
  // Terrain fields never hold invalid values: the category selects only offer
  // known categories, and every geometry commit validates before touching
  // the document.
  if (field === 'terrain-new-category') {
    state.draftCategory = GROUND_COVER_CATEGORIES.includes(event.target.value)
      ? event.target.value
      : 'forest';
    return;
  }
  if (field === 'terrain-new-linear-category') {
    state.draftLinearCategory = LINEAR_FEATURE_CATEGORIES.includes(event.target.value)
      ? event.target.value
      : 'river';
    return;
  }
  if (field === 'terrain-new-linear-width') {
    state.draftLinearWidth = event.target.value;
    return;
  }
  if (field === 'terrain-draft-category') {
    if (state.terrainDraft && state.terrainDraft.kind !== 'elevation' && GROUND_COVER_CATEGORIES.includes(event.target.value)) {
      state.terrainDraft.category = event.target.value;
      state.terrainDraft.error = '';
      render();
    }
    return;
  }
  if (field === 'terrain-draft-linear-category') {
    if (state.terrainDraft && state.terrainDraft.kind === 'linear' && LINEAR_FEATURE_CATEGORIES.includes(event.target.value)) {
      state.terrainDraft.category = event.target.value;
      state.terrainDraft.error = '';
      render();
    }
    return;
  }
  if (field === 'terrain-draft-linear-width') {
    if (state.terrainDraft && state.terrainDraft.kind === 'linear') {
      state.terrainDraft.width = event.target.value;
      state.terrainDraft.error = '';
      render();
    }
    return;
  }
  if (field === 'terrain-category') {
    commitTerrainCategory(event.target.dataset.id, event.target.value);
    return;
  }
  if (field === 'terrain-linear-category') {
    commitLinearCategory(event.target.dataset.id, event.target.value);
    return;
  }
  if (field === 'terrain-linear-width') {
    commitLinearWidth(event.target.dataset.id, event.target.value);
  }
});

document.addEventListener('keydown', (event) => {
  if (state.view !== 'editor' || !state.document) {
    return;
  }
  const target = event.target;
  const field = target?.dataset?.field;
  const unitField = target?.dataset?.unitField;
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
  if (unitField === 'name' && !event.ctrlKey && !event.metaKey) {
    if (event.key === 'Enter') {
      event.preventDefault();
      target.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      target.value = committedFieldValue(target);
      target.blur();
    }
  }
  // Unlimited session undo/redo over the scenario history, which never
  // includes view or selection state. The shortcut works from anywhere in
  // the editor except inside an uncommitted draft: a field holding edits
  // not yet committed keeps the keystroke (native behavior), because
  // undoing would rebuild every input from the committed document and
  // destroy the draft.
  const modifier = event.ctrlKey || event.metaKey;
  if (!modifier || event.altKey) {
    return;
  }
  if (fieldHasDraft(target)) {
    return;
  }
  const key = String(event.key || '').toLowerCase();
  if (key === 'z' && !event.shiftKey) {
    event.preventDefault();
    undoEdit();
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
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
  // An active map drag or rotation is cancelled by Escape: the unit returns
  // to its stored placement (the preview never touched the document).
  if (event.key === 'Escape' && activePointerDrag && cancelPointerDrag()) {
    event.preventDefault();
    return;
  }
  if (event.code === 'Space' && !isEditableTarget(event.target) && !event.repeat) {
    event.preventDefault();
    state.spaceHeld = true;
    $('.map-viewport')?.classList.add('space-pan');
    return;
  }
  if (isEditableTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
  // Terrain drawing finishes or cancels from the keyboard: Enter finishes the
  // polygon, Escape cancels it, Backspace removes the last vertex.
  if (state.terrainDraft) {
    if (event.key === 'Enter') {
      event.preventDefault();
      finishTerrainDraft();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelTerrainDraft();
      return;
    }
    if (event.key === 'Backspace') {
      event.preventDefault();
      popDraftVertex();
      return;
    }
  } else if (
    (event.key === 'Delete' || event.key === 'Backspace') &&
    state.selectedTerrainId &&
    state.selectedVertexIndex !== null
  ) {
    event.preventDefault();
    deleteTerrainVertex(state.selectedTerrainId, state.selectedVertexIndex);
    return;
  }
  const key = event.key.toLowerCase();
  if (key === 'h') {
    ensureMapView(state.document);
    setMapView({ ...state.mapView, tool: 'hand' });
  } else if (key === 'v' || key === 'escape') {
    ensureMapView(state.document);
    setMapView({ ...state.mapView, tool: 'select' });
    if (key === 'escape' && (state.selectedTerrainId || state.selectedVertexIndex !== null)) {
      state.selectedTerrainId = null;
      state.selectedVertexIndex = null;
      state.terrainRefusal = null;
      render();
    }
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
  // Persistent storage is requested on the first save (see
  // ensurePersistenceOnce), not on load: a fresh library has nothing to lose
  // yet. When the browser refuses, the library view says so and recommends
  // export as the only backup.
  await refreshLibrary();
  if (params.get('id')) {
    await openScenario(params.get('id'));
  } else {
    render();
  }
  console.info('[PÓLIS editor]', { narrowNoticeWidth: NARROW_NOTICE_WIDTH });
}

init();
