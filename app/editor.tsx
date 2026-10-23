'use client';

import { useEffect, useMemo, useState } from 'react';
import BattlefieldMap from './battlefield-map';
import {
  TROOP_TYPE_CATALOGUE,
  TROOP_TYPE_KEYS,
  collectUnknownTroopTypeWarnings,
  getTroopType,
  isKnownTroopType,
  spacingClass,
} from '../domain/polis-classical.js';
import {
  GROUND_COVER_CATEGORIES,
  LINEAR_FEATURE_CATEGORIES,
  addElevationFeature,
  addGroundCoverFeature,
  addLinearFeature,
  collectWarnings,
  createUnit,
  deleteUnit,
  duplicateUnit,
  isProvisionalRuleset,
  normalizeFacing,
  proposeUnitPatch,
  removeElevationFeature,
  removeGroundCoverFeature,
  removeLinearFeature,
  resizeBattlefield,
  rulesetCompatibilityNotice,
  unitDerived,
  unitFacingDeg,
  unitPosition,
  updateElevationFeature,
  updateGroundCoverFeature,
  updateLinearFeature,
  updateScenarioDescription,
  updateScenarioTitle,
  updateSideColor,
  updateSideName,
  updateUnitName,
  updateUnitNumbers,
  updateUnitSide,
  updateUnitSpacing,
  updateUnitTroopType,
  validateElevationCandidate,
  validateGroundCoverCandidate,
  validateLinearCandidate,
  validateScenario,
} from '../domain/scenario.js';
import { polygonArea, round1 } from '../domain/geometry.js';

type ScenarioDocument = any;

interface EditorProps {
  document: ScenarioDocument;
  dirty: boolean;
  saveError: string | null;
  saving: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onChange: (next: ScenarioDocument) => void;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => Promise<void>;
  onExport: () => void;
  onBack: () => void;
  onStartBattle: () => void;
}

// A form field that commits on blur (Enter blurs, Escape reverts): typing
// stays a draft so every committed change is one undo step, and an invalid
// value is refused before it reaches the document — the field reverts and the
// cause is shown inline.
function DraftField({
  testid,
  value,
  error,
  onCommit,
  multiline = false,
  ...rest
}: {
  testid: string;
  value: string;
  error: string | null;
  onCommit: (raw: string) => void;
  multiline?: boolean;
} & Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'value' | 'defaultValue' | 'onChange' | 'onBlur'
> &
  Pick<React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'rows' | 'maxLength'>) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  // An outside change (undo, redo, reopen) refreshes the field, but never
  // clobbers a draft the author is still typing.
  useEffect(() => {
    if (!focused) {
      setDraft(value);
    }
  }, [value, focused]);

  // A refused commit reverts the field to the last committed value (the
  // document keeps it throughout): the typed value was never committed.
  const errorKey = error ?? '';
  useEffect(() => {
    if (errorKey) {
      setDraft(value);
    }
    // Revert only when a refusal appears, not while typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorKey]);

  function commit(raw: string) {
    if (raw !== value) {
      onCommit(raw);
    }
  }

  function revert() {
    setDraft(value);
  }

  if (multiline) {
    return (
      <textarea
        data-testid={testid}
        data-committed={value}
        aria-invalid={error ? true : undefined}
        rows={rest.rows}
        maxLength={rest.maxLength}
        value={draft}
        onFocus={() => {
          setFocused(true);
          setDraft(value);
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          setFocused(false);
          commit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            revert();
            event.currentTarget.blur();
          }
        }}
      />
    );
  }
  const { rows: _rows, maxLength, type, min, max, step, ...inputRest } = rest;
  return (
    <input
      data-testid={testid}
      data-committed={value}
      aria-invalid={error ? true : undefined}
      type={type}
      min={min}
      max={max}
      step={step}
      maxLength={maxLength}
      {...inputRest}
      value={draft}
      onFocus={() => {
        setFocused(true);
        setDraft(value);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={(event) => {
        setFocused(false);
        commit(event.target.value);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && type !== 'color') {
          event.preventDefault();
          event.currentTarget.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          revert();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sideColorFor(sides: ScenarioDocument[], unit: ScenarioDocument): string {
  const key = unit?.side ?? unit?.sideId;
  const side = (sides || []).find((entry) => entry && entry.id === key);
  return side && side.color ? String(side.color) : '#666666';
}

// The catalogue's spacing presets, in order. Shared by the preset matcher
// and the preset select so the two can never drift apart.
const SPACING_PRESET_KEYS = ['close', 'normal', 'open'];

function troopDisplayName(troopType: unknown): string {
  const entry = getTroopType(troopType as string) as any;
  return entry?.displayName || String(troopType ?? 'Unknown');
}

// Prototype variant A's formation diagram: one dot per file and rank,
// capped to fit the inspector. Dots only — the footprint on the map is the
// true-scale rectangle, never enlarged for display.
function FormationDiagram({ files, ranks }: { files: number; ranks: number }) {
  const cols = Math.max(1, Math.min(Math.floor(files), 18));
  const rows = Math.max(1, Math.min(Math.floor(ranks), 9));
  const dots = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      dots.push(
        <rect
          key={`${row}-${col}`}
          x={110 - cols * 4.7 + col * 9.4}
          y={32 + row * 6}
          width={5.5}
          height={3.8}
          rx={0.8}
          fill="currentColor"
          opacity={0.8 - row * 0.035}
        />,
      );
    }
  }
  return (
    <svg
      viewBox="0 0 220 95"
      role="img"
      aria-label={`Diagram: ${files} files, ${ranks} ranks`}
      data-testid="formation-diagram"
    >
      <path d="m102 13 8-7 8 7M110 6v16" fill="none" stroke="currentColor" opacity="0.6" />
      {dots}
    </svg>
  );
}

export default function Editor({
  document,
  dirty,
  saveError,
  saving,
  canUndo,
  canRedo,
  onChange,
  onUndo,
  onRedo,
  onSave,
  onExport,
  onBack,
  onStartBattle,
}: EditorProps) {
  const [mode, setMode] = useState<'battle' | 'map'>('battle');
  // Rejected form values, keyed by field: the value is never committed to
  // the document, the field reverts, and the cause is shown inline.
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Order-of-battle tab: 'all' or a side id. Selection and the tab are
  // display-only: neither marks the scenario unsaved nor records undo steps.
  const [oobTab, setOobTab] = useState<string>('all');
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  // Placement refusals (no free spot in the current view): the document is
  // untouched, so the message lives outside the field errors.
  const [notice, setNotice] = useState<string | null>(null);
  // Units the last refused placement would conflict with (the edited unit
  // plus every overlap partner). Display-only, like the selection: the
  // document keeps the last valid values, and the highlight mirrors the
  // refused edit until the next committed change clears it.
  const [unitConflictIds, setUnitConflictIds] = useState<string[]>([]);

  // A committed change supersedes the last refusal highlight.
  useEffect(() => {
    setUnitConflictIds([]);
  }, [document]);

  // Terrain mode (Map editor tab): the polygon being drawn, the selected
  // feature and vertex, and the last refused edit. All display-only: only
  // committed documents reach onChange, so every terrain change is one undo
  // step and refusals never touch the document.
  interface TerrainDraft {
    kind: 'ground' | 'elevation' | 'linear';
    category: string;
    points: { x: number; y: number }[];
    // A river or road draft carries its width in metres; polygon drafts leave
    // it undefined. The width travels with the finished line.
    width?: number;
    error: string;
  }
  const [terrainDraft, setTerrainDraft] = useState<TerrainDraft | null>(null);
  const [draftCategory, setDraftCategory] = useState<string>('forest');
  const [draftLinearCategory, setDraftLinearCategory] = useState<string>('river');
  const [draftLinearWidth, setDraftLinearWidth] = useState<string>('10');
  const [selectedTerrainId, setSelectedTerrainId] = useState<string | null>(null);
  const [selectedVertexIndex, setSelectedVertexIndex] = useState<number | null>(null);
  const [terrainRefusal, setTerrainRefusal] = useState<{
    ring: { x: number; y: number }[];
    reason: string;
    conflictId?: string | null;
    kind?: 'ground' | 'elevation' | 'linear';
  } | null>(null);

  const units: ScenarioDocument[] = Array.isArray(document.units) ? document.units : [];
  const sides: ScenarioDocument[] = Array.isArray(document.sides) ? document.sides : [];
  const unitsBySide = (() => {
    const grouped = new Map<string, ScenarioDocument[]>();
    for (const unit of units) {
      if (!unit || typeof unit.side !== 'string') continue;
      const list = grouped.get(unit.side);
      if (list) {
        list.push(unit);
      } else {
        grouped.set(unit.side, [unit]);
      }
    }
    return grouped;
  })();
  const unitsForSide = (sideId: unknown): ScenarioDocument[] =>
    typeof sideId === 'string' ? (unitsBySide.get(sideId) ?? []) : [];
  // Issues panel, as in the tracer: structural errors block saving while
  // completeness warnings, unknown troop-type warnings, and the ruleset
  // notice never do. Saving stays allowed with warnings; the editor keeps
  // unknown keys verbatim. The completeness warnings include the empty-side
  // notices, so this memo subsumes the per-side check.
  const { errors, warnings, catalogueWarnings, rulesetNotice } = useMemo(() => {
    let errors: string[] = [];
    let warnings: string[] = [];
    try {
      errors = validateScenario(document);
    } catch {
      errors = ['Scenario cannot be read.'];
    }
    try {
      warnings = collectWarnings(document);
    } catch {
      warnings = [];
    }
    let catalogueWarnings: string[] = [];
    try {
      catalogueWarnings = collectUnknownTroopTypeWarnings(document);
    } catch {
      catalogueWarnings = [];
    }
    let rulesetNotice: string | null = null;
    try {
      rulesetNotice = rulesetCompatibilityNotice(document.ruleset);
    } catch {
      rulesetNotice = null;
    }
    return { errors, warnings, catalogueWarnings, rulesetNotice };
  }, [document]);
  const notices = rulesetNotice ? [rulesetNotice] : [];
  const issueCount = errors.length + warnings.length + catalogueWarnings.length + notices.length;
  const provisional = isProvisionalRuleset(document?.ruleset);

  const groundFeatures: ScenarioDocument[] = (document.terrainFeatures || []).filter(
    (feature: any) => feature && feature.kind === 'ground',
  );
  const hillFeatures: ScenarioDocument[] = (document.terrainFeatures || []).filter(
    (feature: any) => feature && feature.kind === 'elevation',
  );
  const linearFeatures: ScenarioDocument[] = (document.terrainFeatures || []).filter(
    (feature: any) => feature && feature.kind === 'linear',
  );
  const selectedTerrain = terrainFeatureById(document, selectedTerrainId);
  const inTerrainMode = mode === 'map';

  // Unlimited session undo/redo over the scenario history, which never
  // includes selection or view state. The shortcut works from anywhere in the
  // editor except inside an uncommitted draft: a field holding edits not yet
  // committed keeps the keystroke (native behavior), because undoing would
  // rebuild every input from the committed document and destroy the draft.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        const committed = (target as HTMLInputElement).dataset?.committed;
        if (committed !== undefined && (target as HTMLInputElement).value !== committed) return;
      }
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        onUndo();
      } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
        event.preventDefault();
        onRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onUndo, onRedo]);

  function fail(field: string, message: string) {
    setFieldErrors({ [field]: message });
  }

  function commitTitle(raw: string) {
    try {
      onChange(updateScenarioTitle(document, raw));
      setFieldErrors({});
    } catch (error) {
      fail('title', errorMessage(error));
    }
  }

  function commitDescription(raw: string) {
    try {
      onChange(updateScenarioDescription(document, raw));
      setFieldErrors({});
    } catch (error) {
      fail('description', errorMessage(error));
    }
  }

  function commitDimension(dimension: 'width' | 'height', raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      fail(dimension, `Battlefield ${dimension} must be a number of metres.`);
      return;
    }
    try {
      const next = resizeBattlefield(
        document,
        dimension === 'width' ? Number(trimmed) : document.battlefield.width,
        dimension === 'height' ? Number(trimmed) : document.battlefield.height,
      );
      setFieldErrors({});
      onChange(next);
    } catch (error) {
      // Shrinking past a unit is refused with the blocking units named, and
      // the message doubles as the inline cause; terrain is clipped by the
      // resize itself on the paths that succeed.
      fail(dimension, errorMessage(error));
    }
  }

  function commitSideName(index: number, raw: string) {
    try {
      onChange(updateSideName(document, index, raw));
      setFieldErrors({});
    } catch (error) {
      fail(`side-name-${index}`, errorMessage(error));
    }
  }

  function commitSideColor(index: number, raw: string) {
    try {
      onChange(updateSideColor(document, index, raw));
      setFieldErrors({});
    } catch (error) {
      fail(`side-color-${index}`, errorMessage(error));
    }
  }

  // --- Units (order of battle) ---------------------------------------------
  // Every unit change commits through onChange, so add, edit, duplicate, and
  // delete are all undoable with no extra work. Invalid values throw in the
  // domain helpers and are refused before they reach the document: the field
  // reverts and the cause is shown inline.

  const selectedUnit: ScenarioDocument | null =
    (units as ScenarioDocument[]).find((unit) => unit?.id === selectedUnitId) ?? null;
  const selectedDerived = selectedUnit ? unitDerived(selectedUnit) : null;
  const selectedSpacingClass = selectedUnit
    ? spacingClass(selectedUnit.troopType, selectedUnit.lateralInterval)
    : null;
  // Exact placement on the map: the front-edge midpoint in metres and the
  // compass facing in degrees, matching what the drag and rotation handle edit.
  const selectedPosition = selectedUnit ? unitPosition(selectedUnit) : null;
  const selectedFacing =
    selectedUnit && Number.isFinite(Number(selectedUnit.facing))
      ? normalizeFacing(Number(selectedUnit.facing))
      : null;

  // Which spacing preset the selected unit's spacings match, or 'custom'.
  function presetKeyFor(unit: ScenarioDocument): string {
    const entry = getTroopType(unit?.troopType) as any;
    if (!entry || !Number.isFinite(unit?.lateralInterval) || !Number.isFinite(unit?.rankDepth)) {
      return 'custom';
    }
    for (const key of SPACING_PRESET_KEYS) {
      const preset = entry.presets?.[key];
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

  function handleAddUnit() {
    const targetSide = oobTab !== 'all' ? oobTab : sides[0]?.id;
    try {
      // A new unit is a hoplite standing at its normal preset: the scenario
      // stores the preset's metres (ADR 0002), read from the catalogue here
      // so a catalogue change moves the default with it.
      const normalPreset = (getTroopType('hoplite') as any)?.presets?.normal;
      const next = createUnit(document, {
        sideId: targetSide,
        ...(normalPreset
          ? {
              lateralInterval: normalPreset.lateralInterval,
              rankDepth: normalPreset.rankDepth,
            }
          : {}),
      });
      setSelectedUnitId(next.unitId);
      setFieldErrors({});
      setNotice(null);
      onChange(next.document);
    } catch (error) {
      setFieldErrors({});
      setNotice(errorMessage(error));
    }
  }

  function handleDuplicateUnit(unit: ScenarioDocument) {
    try {
      const next = duplicateUnit(document, unit?.id);
      setSelectedUnitId(next.unitId);
      setFieldErrors({});
      setNotice(null);
      onChange(next.document);
    } catch (error) {
      setFieldErrors({});
      setNotice(errorMessage(error));
    }
  }

  function handleDeleteUnit(unit: ScenarioDocument) {
    try {
      onChange(deleteUnit(document, unit?.id));
      if (selectedUnitId === unit?.id) {
        setSelectedUnitId(null);
      }
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-delete', errorMessage(error));
    }
  }

  function commitUnitName(unit: ScenarioDocument, raw: string) {
    try {
      onChange(updateUnitName(document, unit?.id, raw));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-name', errorMessage(error));
    }
  }

  function commitUnitSide(unit: ScenarioDocument, sideId: string) {
    if (sideId === unit?.side) return;
    try {
      onChange(updateUnitSide(document, unit?.id, sideId));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-side', errorMessage(error));
    }
  }

  // Changing the troop type pre-fills both spacings from the new type's
  // normal preset in the same undo step; the scenario stores the metres
  // (ADR 0002), never the preset itself.
  function commitUnitTroopType(unit: ScenarioDocument, troopType: string) {
    if (troopType === unit?.troopType) return;
    try {
      const preset = (getTroopType(troopType) as any)?.presets?.normal ?? null;
      onChange(updateUnitTroopType(document, unit?.id, troopType, preset));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-troop', errorMessage(error));
    }
  }

  function commitUnitNumbers(unit: ScenarioDocument, patch: { soldiers?: string; files?: string }) {
    const field = patch.soldiers !== undefined ? 'unit-soldiers' : 'unit-files';
    const label = patch.soldiers !== undefined ? 'Soldiers' : 'Files';
    const trimmed = String(patch.soldiers ?? patch.files ?? '').trim();
    if (!trimmed || !Number.isInteger(Number(trimmed)) || Number(trimmed) < 1) {
      fail(field, `${label} must be a whole number of at least 1.`);
      return;
    }
    try {
      onChange(
        updateUnitNumbers(document, unit?.id, {
          ...(patch.soldiers !== undefined ? { soldiers: Number(trimmed) } : {}),
          ...(patch.files !== undefined ? { files: Number(trimmed) } : {}),
        }),
      );
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail(field, errorMessage(error));
    }
  }

  function commitUnitSpacing(
    unit: ScenarioDocument,
    key: 'lateralInterval' | 'rankDepth',
    raw: string,
  ) {
    const label = key === 'lateralInterval' ? 'Lateral interval' : 'Rank depth';
    const field = key === 'lateralInterval' ? 'unit-spacing-lateral' : 'unit-spacing-depth';
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      fail(field, `${label} must be a positive number of metres.`);
      return;
    }
    try {
      onChange(updateUnitSpacing(document, unit?.id, { [key]: Number(trimmed) }));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail(field, errorMessage(error));
    }
  }

  // A spacing preset pre-fills both spacings in metres in one undo step.
  function commitUnitPreset(unit: ScenarioDocument, presetKey: string) {
    if (presetKey === 'custom') return;
    const preset = (getTroopType(unit?.troopType) as any)?.presets?.[presetKey];
    if (!preset) return;
    try {
      onChange(updateUnitSpacing(document, unit?.id, preset));
      setFieldErrors({});
      setNotice(null);
    } catch (error) {
      fail('unit-preset', errorMessage(error));
    }
  }

  // --- Terrain mode (ground cover areas and hills) --------------------------
  // The Map editor tab replaces the order of battle with the terrain panel.
  // Drawing, recategorising, vertex edits, and deletions all commit through
  // onChange, so every terrain change is undoable with no extra work. A
  // refused edit never reaches the document: the candidate ring is drawn in
  // red and the reason is shown until the next committed change.
  const GROUND_COVER_LABELS: Record<string, string> = {
    forest: 'Forest',
    rough: 'Rough ground',
    water: 'Water',
    settlement: 'Settlement',
  };

  function groundCoverLabel(category: unknown): string {
    return typeof category === 'string' && GROUND_COVER_LABELS[category]
      ? GROUND_COVER_LABELS[category]
      : 'Ground cover';
  }

  const LINEAR_LABELS: Record<string, string> = {
    river: 'River',
    road: 'Road',
  };

  function linearLabel(category: unknown): string {
    return typeof category === 'string' && LINEAR_LABELS[category]
      ? LINEAR_LABELS[category]
      : 'River or road';
  }

  const GROUND_FILLS_FOR_PANEL: Record<string, { fill: string }> = {
    forest: { fill: '#aebc9c' },
    rough: { fill: '#d8d2b8' },
    water: { fill: '#b3cece' },
    settlement: { fill: '#d8cbb2' },
  };

  const LINEAR_FILLS_FOR_PANEL: Record<string, { fill: string }> = {
    river: { fill: '#7fb3c8' },
    road: { fill: '#c9b98f' },
  };

  function terrainFeatureById(doc: ScenarioDocument, id: string | null): any {
    if (!id) return null;
    return (
      (doc?.terrainFeatures || []).find(
        (feature: any) =>
          feature?.id === id &&
          (feature.kind === 'ground' ||
            feature.kind === 'elevation' ||
            feature.kind === 'linear'),
      ) || null
    );
  }

  function groundAreaSquareMetres(feature: any): number | null {
    try {
      return Math.round(polygonArea(feature.polygon));
    } catch {
      return null;
    }
  }

  function addedTerrainFeature(before: ScenarioDocument, after: ScenarioDocument): any {
    const ids = new Set((before?.terrainFeatures || []).map((feature: any) => feature?.id));
    return (after?.terrainFeatures || []).find((feature: any) => feature && !ids.has(feature.id));
  }

  function startTerrainDraft(kind: 'ground' | 'elevation' | 'linear') {
    if (terrainDraft) return;
    if (kind === 'linear') {
      const width = Number(draftLinearWidth);
      setTerrainDraft({
        kind: 'linear',
        category: draftLinearCategory,
        points: [],
        width: Number.isFinite(width) && width > 0 ? width : 10,
        error: '',
      });
    } else {
      setTerrainDraft(
        kind === 'elevation'
          ? { kind: 'elevation', category: 'hill', points: [], error: '' }
          : { kind: 'ground', category: draftCategory, points: [], error: '' },
      );
    }
    setSelectedTerrainId(null);
    setSelectedVertexIndex(null);
    setTerrainRefusal(null);
  }

  function cancelTerrainDraft() {
    if (!terrainDraft) return;
    setTerrainDraft(null);
    setTerrainRefusal(null);
  }

  function addDraftPoint(point: { x: number; y: number }) {
    const rounded = { x: round1(point.x), y: round1(point.y) };
    setTerrainDraft((current) => {
      if (!current) return current;
      // A double click lands two vertices on the same spot: keep the first
      // and ignore the repeat, so the draft never holds a zero-length edge.
      const last = current.points[current.points.length - 1];
      if (last && last.x === rounded.x && last.y === rounded.y) return current;
      return { ...current, points: [...current.points, rounded], error: '' };
    });
    // A new vertex is a new attempt: the last refusal highlight goes away.
    setTerrainRefusal(null);
  }

  function popDraftVertex() {
    setTerrainDraft((current) =>
      current && current.points.length > 0
        ? { ...current, points: current.points.slice(0, -1), error: '' }
        : current,
    );
    setTerrainRefusal(null);
  }

  function finishTerrainDraft() {
    if (!terrainDraft) return;
    const draft = terrainDraft;
    // Rivers and roads are polylines with a width in metres: two vertices
    // suffice, crossings are never refused, and only degenerate input or an
    // invalid width stops the finish.
    if (draft.kind === 'linear') {
      if (draft.points.length < 2) {
        setTerrainDraft({ ...draft, error: 'A river or road needs at least 2 vertices.' });
        return;
      }
      const width = Number(draft.width);
      if (!Number.isFinite(width) || width <= 0) {
        setTerrainDraft({ ...draft, error: 'Width must be a positive number of metres.' });
        return;
      }
      const check = validateLinearCandidate(document, draft.points);
      if (!check.ok) {
        const detail = check.reason ?? 'invalid shape';
        const reason = `Cannot add a river or road: ${detail}.`;
        setTerrainDraft({
          ...draft,
          error: `${detail[0].toUpperCase()}${detail.slice(1)}.`,
        });
        setTerrainRefusal({ ring: check.path, reason, kind: 'linear' });
        return;
      }
      let next: ScenarioDocument;
      try {
        next = addLinearFeature(document, {
          category: draft.category,
          path: draft.points,
          width,
        });
      } catch (error) {
        const reason = errorMessage(error);
        setTerrainDraft({ ...draft, error: reason });
        setTerrainRefusal({ ring: draft.points, reason, kind: 'linear' });
        return;
      }
      const added = addedTerrainFeature(document, next);
      setDraftLinearCategory(draft.category);
      setDraftLinearWidth(String(width));
      setTerrainDraft(null);
      setSelectedTerrainId(added ? added.id : null);
      setSelectedVertexIndex(null);
      setTerrainRefusal(null);
      setFieldErrors({});
      onChange(next);
      return;
    }
    if (draft.kind === 'elevation') {
      if (draft.points.length < 3) {
        setTerrainDraft({ ...draft, error: 'A hill needs at least 3 vertices.' });
        return;
      }
      const check = validateElevationCandidate(document, draft.points);
      if (!check.ok) {
        const detail = check.reason ?? 'invalid shape';
        const reason = `Cannot add a hill: ${detail}.`;
        setTerrainDraft({
          ...draft,
          error: `${detail[0].toUpperCase()}${detail.slice(1)}.`,
        });
        setTerrainRefusal({ ring: check.ring, reason, conflictId: check.conflictId });
        return;
      }
      let next: ScenarioDocument;
      try {
        next = addElevationFeature(document, { polygon: draft.points });
      } catch (error) {
        const reason = errorMessage(error);
        setTerrainDraft({ ...draft, error: reason });
        setTerrainRefusal({ ring: draft.points, reason });
        return;
      }
      const added = addedTerrainFeature(document, next);
      setTerrainDraft(null);
      setSelectedTerrainId(added ? added.id : null);
      setSelectedVertexIndex(null);
      setTerrainRefusal(null);
      setFieldErrors({});
      onChange(next);
      return;
    }
    if (draft.points.length < 3) {
      setTerrainDraft({ ...draft, error: 'An area needs at least 3 vertices.' });
      return;
    }
    const check = validateGroundCoverCandidate(document, draft.points);
    if (!check.ok) {
      const detail = check.reason ?? 'invalid shape';
      const reason = `Cannot add a ground cover area: ${detail}.`;
      setTerrainDraft({
        ...draft,
        error: `${detail[0].toUpperCase()}${detail.slice(1)}.`,
      });
      setTerrainRefusal({ ring: check.ring, reason, conflictId: check.conflictId });
      return;
    }
    let next: ScenarioDocument;
    try {
      next = addGroundCoverFeature(document, { category: draft.category, polygon: draft.points });
    } catch (error) {
      const reason = errorMessage(error);
      setTerrainDraft({ ...draft, error: reason });
      setTerrainRefusal({ ring: draft.points, reason });
      return;
    }
    const added = addedTerrainFeature(document, next);
    setDraftCategory(draft.category);
    setTerrainDraft(null);
    setSelectedTerrainId(added ? added.id : null);
    setSelectedVertexIndex(null);
    setTerrainRefusal(null);
    setFieldErrors({});
    onChange(next);
  }

  function selectTerrain(id: string, vertexIndex: number | null = null) {
    setSelectedTerrainId(id);
    setSelectedVertexIndex(vertexIndex);
    setTerrainRefusal(null);
  }

  function commitTerrainCategory(id: string, category: string) {
    let next: ScenarioDocument;
    try {
      next = updateGroundCoverFeature(document, id, { category });
    } catch (error) {
      const feature = terrainFeatureById(document, id);
      setTerrainRefusal({
        ring: Array.isArray(feature?.polygon) ? feature.polygon : [],
        reason: errorMessage(error),
      });
      return;
    }
    setTerrainRefusal(null);
    setFieldErrors({});
    onChange(next);
  }

  function commitLinearCategory(id: string, category: string) {
    let next: ScenarioDocument;
    try {
      next = updateLinearFeature(document, id, { category });
    } catch (error) {
      const feature = terrainFeatureById(document, id);
      setTerrainRefusal({
        ring: Array.isArray(feature?.path) ? feature.path : [],
        reason: errorMessage(error),
        kind: 'linear',
      });
      return;
    }
    setTerrainRefusal(null);
    setFieldErrors({});
    onChange(next);
  }

  function commitLinearWidth(id: string, raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed)) || Number(trimmed) <= 0) {
      fail('terrain-linear-width', 'Width must be a positive number of metres.');
      return;
    }
    try {
      onChange(updateLinearFeature(document, id, { width: Number(trimmed) }));
      setFieldErrors({});
      setTerrainRefusal(null);
    } catch (error) {
      fail('terrain-linear-width', errorMessage(error));
    }
  }

  function deleteTerrainFeature(id: string) {
    const feature = terrainFeatureById(document, id);
    if (!feature) return;
    let next: ScenarioDocument;
    try {
      next =
        feature.kind === 'linear'
          ? removeLinearFeature(document, id)
          : feature.kind === 'elevation'
            ? removeElevationFeature(document, id)
            : removeGroundCoverFeature(document, id);
    } catch (error) {
      const failedRing = feature.kind === 'linear' ? feature.path : feature?.polygon;
      setTerrainRefusal({
        ring: Array.isArray(failedRing) ? failedRing : [],
        reason: errorMessage(error),
        ...(feature.kind === 'linear' ? { kind: 'linear' as const } : {}),
      });
      return;
    }
    if (selectedTerrainId === id) {
      setSelectedTerrainId(null);
      setSelectedVertexIndex(null);
    }
    setTerrainRefusal(null);
    onChange(next);
  }

  function validateTerrainPolygon(
    feature: any,
    polygon: { x: number; y: number }[],
    ignoreId: string,
  ) {
    return feature?.kind === 'elevation'
      ? validateElevationCandidate(document, polygon, { ignoreId })
      : validateGroundCoverCandidate(document, polygon, { ignoreId });
  }

  function updateTerrainPolygon(feature: any, id: string, ring: { x: number; y: number }[]) {
    return feature?.kind === 'elevation'
      ? updateElevationFeature(document, id, { polygon: ring })
      : updateGroundCoverFeature(document, id, { polygon: ring });
  }

  function insertTerrainVertex(featureId: string, edgeIndex: number) {
    const feature = terrainFeatureById(document, featureId);
    if (!feature) return;
    // A river or road is an open polyline: edges run between consecutive
    // vertices only, never wrapping from the last back to the first.
    if (feature.kind === 'linear') {
      if (!Array.isArray(feature.path)) return;
      const a = feature.path[edgeIndex];
      const b = feature.path[edgeIndex + 1];
      if (!a || !b) return;
      const path = [
        ...feature.path.slice(0, edgeIndex + 1),
        { x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2) },
        ...feature.path.slice(edgeIndex + 1),
      ];
      const check = validateLinearCandidate(document, path);
      if (!check.ok) {
        setTerrainRefusal({
          ring: check.path,
          reason: `Cannot insert a vertex: ${check.reason}.`,
          kind: 'linear',
        });
        return;
      }
      setTerrainRefusal(null);
      onChange(updateLinearFeature(document, featureId, { path: check.path }));
      setSelectedTerrainId(featureId);
      setSelectedVertexIndex(edgeIndex + 1);
      return;
    }
    if (!Array.isArray(feature.polygon)) return;
    const ring = feature.polygon;
    const a = ring[edgeIndex];
    const b = ring[(edgeIndex + 1) % ring.length];
    if (!a || !b) return;
    const polygon = [
      ...ring.slice(0, edgeIndex + 1),
      { x: round1((a.x + b.x) / 2), y: round1((a.y + b.y) / 2) },
      ...ring.slice(edgeIndex + 1),
    ];
    const check = validateTerrainPolygon(feature, polygon, featureId);
    if (!check.ok) {
      setTerrainRefusal({
        ring: check.ring,
        reason: `Cannot insert a vertex: ${check.reason}.`,
        conflictId: check.conflictId,
      });
      return;
    }
    setTerrainRefusal(null);
    onChange(updateTerrainPolygon(feature, featureId, check.ring));
    setSelectedTerrainId(featureId);
    setSelectedVertexIndex(edgeIndex + 1);
  }

  function deleteTerrainVertex(featureId: string, index: number) {
    const feature = terrainFeatureById(document, featureId);
    if (!feature) return;
    if (feature.kind === 'linear') {
      if (!feature.path?.[index]) return;
      if (feature.path.length <= 2) {
        setTerrainRefusal({
          ring: feature.path,
          reason: 'A river or road needs at least 2 vertices: the vertex stays.',
          kind: 'linear',
        });
        return;
      }
      const path = feature.path.filter((_: unknown, other: number) => other !== index);
      const check = validateLinearCandidate(document, path);
      if (!check.ok) {
        setTerrainRefusal({
          ring: check.path,
          reason: `Cannot delete the vertex: ${check.reason}.`,
          kind: 'linear',
        });
        return;
      }
      setTerrainRefusal(null);
      onChange(updateLinearFeature(document, featureId, { path: check.path }));
      setSelectedTerrainId(featureId);
      setSelectedVertexIndex(null);
      return;
    }
    if (!feature.polygon?.[index]) return;
    if (feature.polygon.length <= 3) {
      setTerrainRefusal({
        ring: feature.polygon,
        reason:
          feature.kind === 'elevation'
            ? 'A hill needs at least 3 vertices: the vertex stays.'
            : 'An area needs at least 3 vertices: the vertex stays.',
      });
      return;
    }
    const polygon = feature.polygon.filter((_: unknown, other: number) => other !== index);
    const check = validateTerrainPolygon(feature, polygon, featureId);
    if (!check.ok) {
      setTerrainRefusal({
        ring: check.ring,
        reason: `Cannot delete the vertex: ${check.reason}.`,
        conflictId: check.conflictId,
      });
      return;
    }
    setTerrainRefusal(null);
    onChange(updateTerrainPolygon(feature, featureId, check.ring));
    setSelectedTerrainId(featureId);
    setSelectedVertexIndex(null);
  }

  function commitTerrainVertex(
    featureId: string,
    index: number,
    point: { x: number; y: number },
  ) {
    const feature = terrainFeatureById(document, featureId);
    if (!feature) return;
    if (feature.kind === 'linear') {
      if (!feature.path?.[index]) return;
      const path = feature.path.map((vertex: { x: number; y: number }, other: number) =>
        other === index ? { x: round1(point.x), y: round1(point.y) } : vertex,
      );
      const check = validateLinearCandidate(document, path);
      if (!check.ok) {
        setTerrainRefusal({
          ring: check.path,
          reason: `Cannot move the vertex: ${check.reason}.`,
          kind: 'linear',
        });
        return;
      }
      setTerrainRefusal(null);
      onChange(updateLinearFeature(document, featureId, { path: check.path }));
      setSelectedTerrainId(featureId);
      setSelectedVertexIndex(index);
      return;
    }
    if (!feature.polygon?.[index]) return;
    const polygon = feature.polygon.map((vertex: { x: number; y: number }, other: number) =>
      other === index ? { x: round1(point.x), y: round1(point.y) } : vertex,
    );
    const check = validateTerrainPolygon(feature, polygon, featureId);
    if (!check.ok) {
      setTerrainRefusal({
        ring: check.ring,
        reason: `Cannot move the vertex: ${check.reason}.`,
        conflictId: check.conflictId,
      });
      return;
    }
    setTerrainRefusal(null);
    onChange(updateTerrainPolygon(feature, featureId, check.ring));
    setSelectedTerrainId(featureId);
    setSelectedVertexIndex(index);
  }

  // Drop a terrain selection the document no longer holds (after undo,
  // redo, or reopening) so the panels never show a ghost.
  useEffect(() => {
    if (
      selectedTerrainId &&
      !(document?.terrainFeatures || []).some(
        (feature: any) => feature?.id === selectedTerrainId,
      )
    ) {
      setSelectedTerrainId(null);
      setSelectedVertexIndex(null);
    }
  }, [document, selectedTerrainId]);

  // Terrain drawing and vertex keys. Enter finishes the polygon, Escape
  // cancels it, Backspace removes the last vertex; with no draft, Delete
  // removes the selected vertex and Escape clears the selection. Typing in a
  // field is never stolen. Undo and redo keep their own shortcut.
  useEffect(() => {
    if (mode !== 'map') return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (terrainDraft) {
        if (event.key === 'Enter') {
          event.preventDefault();
          finishTerrainDraft();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelTerrainDraft();
        } else if (event.key === 'Backspace') {
          event.preventDefault();
          popDraftVertex();
        }
        return;
      }
      if (
        (event.key === 'Delete' || event.key === 'Backspace') &&
        selectedTerrainId &&
        selectedVertexIndex !== null
      ) {
        event.preventDefault();
        deleteTerrainVertex(selectedTerrainId, selectedVertexIndex);
        return;
      }
      if (event.key === 'Escape' && selectedTerrainId) {
        setSelectedTerrainId(null);
        setSelectedVertexIndex(null);
        setTerrainRefusal(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // --- Unit placement (map drag, rotation handle, inspector fields) ----------
  // Every geometry change goes through proposeUnitPatch: a change whose
  // footprint would overlap another unit or leave the battlefield is refused,
  // the value is never committed, the field reverts, and every conflicting
  // unit is highlighted on the map and in the order of battle. Touching
  // edge to edge is accepted. Each committed change is one undo step.
  function commitUnitGeometry(
    unitId: string,
    patch: { position?: { x: number; y: number }; facing?: number },
    field: string,
  ) {
    const proposal = proposeUnitPatch(document, unitId, patch);
    if (!proposal.ok) {
      setFieldErrors({ [field]: proposal.errors[0] || 'This placement is not allowed.' });
      setUnitConflictIds(proposal.conflictIds ?? []);
      return;
    }
    setFieldErrors({});
    setNotice(null);
    onChange(proposal.document);
  }

  function handleMoveUnit(unitId: string, position: { x: number; y: number }) {
    setSelectedUnitId(unitId);
    commitUnitGeometry(unitId, { position }, 'unit-position');
  }

  function handleRotateUnit(unitId: string, facing: number) {
    setSelectedUnitId(unitId);
    commitUnitGeometry(unitId, { facing }, 'unit-facing');
  }

  // Exact placement on the map: the front-edge midpoint in metres and the
  // compass facing in degrees.
  function commitUnitPositionAxis(unit: ScenarioDocument, axis: 'x' | 'y', raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      setFieldErrors({ 'unit-position': 'Position must hold finite X and Y metre coordinates.' });
      setUnitConflictIds(unit?.id ? [unit.id] : []);
      return;
    }
    const current = unitPosition(unit);
    const position = {
      x: axis === 'x' ? Number(trimmed) : (current?.x ?? Number.NaN),
      y: axis === 'y' ? Number(trimmed) : (current?.y ?? Number.NaN),
    };
    if (current && position.x === current.x && position.y === current.y) {
      setFieldErrors({});
      return;
    }
    commitUnitGeometry(unit?.id, { position }, 'unit-position');
  }

  function commitUnitFacing(unit: ScenarioDocument, raw: string) {
    const trimmed = raw.trim();
    if (!trimmed || !Number.isFinite(Number(trimmed))) {
      setFieldErrors({ 'unit-facing': 'Facing must be a compass bearing in degrees.' });
      setUnitConflictIds(unit?.id ? [unit.id] : []);
      return;
    }
    if (normalizeFacing(Number(trimmed)) === normalizeFacing(Number(unit?.facing))) {
      setFieldErrors({});
      return;
    }
    commitUnitGeometry(unit?.id, { facing: Number(trimmed) }, 'unit-facing');
  }

  function fieldError(field: string) {
    return fieldErrors[field] ? (
      <p className="field-error" role="alert" data-testid={`inspector-${field}-error`}>
        {fieldErrors[field]}
      </p>
    ) : null;
  }

  return (
    <div data-testid="editor">
      <div className="editor-head">
        <button type="button" className="btn-quiet" data-testid="back-to-library" onClick={onBack}>
          ← Library
        </button>
        <div className="doc-title" data-testid="editor-title">
          {document.title}
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        {provisional ? (
          <span
            className="provisional-badge"
            data-testid="provisional-badge"
            title="This scenario references a provisional 0.x ruleset version."
          >
            Provisional ruleset
          </span>
        ) : null}
        {dirty ? (
          <span className="dirty-pill" data-testid="unsaved-pill">
            <span className="dirty-dot" aria-hidden="true" />
            Unsaved changes
          </span>
        ) : null}
        <span className="status" data-testid="save-status" role="status">
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : saveError ? '' : 'Saved'}
        </span>
        <button
          type="button"
          className="btn-tool"
          data-testid="undo"
          disabled={!canUndo}
          title="Undo (Ctrl/⌘+Z)"
          onClick={onUndo}
        >
          Undo
        </button>
        <button
          type="button"
          className="btn-tool"
          data-testid="redo"
          disabled={!canRedo}
          title="Redo (Shift+Ctrl/⌘+Z)"
          onClick={onRedo}
        >
          Redo
        </button>
        <button
          type="button"
          className="btn-secondary"
          data-testid="export-open-scenario"
          onClick={onExport}
        >
          Export
        </button>
        <button
          type="button"
          className="btn-secondary"
          data-testid="start-battle-editor"
          disabled={dirty}
          title={
            dirty
              ? 'Save the scenario first: a battle starts from the saved version.'
              : 'Start a battle from this scenario'
          }
          onClick={onStartBattle}
        >
          Start battle
        </button>
        <button
          type="button"
          className="btn-primary"
          data-testid="save-scenario"
          disabled={saving}
          onClick={onSave}
        >
          Save
        </button>
      </div>
      {saveError ? (
        <p
          className="validation"
          role="alert"
          data-testid="save-error"
          style={{ margin: '12px 28px 0' }}
        >
          {saveError}
        </p>
      ) : null}
      <main className="workspace">
        <aside
          className="left-panel panel"
          aria-label={inTerrainMode ? 'Terrain' : 'Order of battle'}
        >
          <div className="mode-tabs" role="tablist" aria-label="Editor mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'battle'}
              className={mode === 'battle' ? 'mode-tab active' : 'mode-tab'}
              data-testid="mode-battle"
              onClick={() => setMode('battle')}
            >
              Battle
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'map'}
              className={mode === 'map' ? 'mode-tab active' : 'mode-tab'}
              data-testid="mode-map"
              onClick={() => setMode('map')}
            >
              Map editor
            </button>
          </div>
          {inTerrainMode ? (
            <div data-testid="terrain-panel">
              <span className="eyebrow">GROUND COVER · HILLS · RIVERS AND ROADS</span>
              <h2>Terrain</h2>
              {terrainDraft ? (
                <div className="terrain-drafting">
                  <p>
                    Drawing{' '}
                    {terrainDraft.kind === 'linear'
                      ? `${linearLabel(terrainDraft.category)} (${terrainDraft.width} m wide)`
                      : terrainDraft.kind === 'elevation'
                        ? 'hill'
                        : groundCoverLabel(terrainDraft.category)}{' '}
                    — click the map to add vertices ({terrainDraft.points.length}).
                  </p>
                  {terrainDraft.error ? (
                    <p className="field-error" role="alert">
                      {terrainDraft.error}
                    </p>
                  ) : null}
                  <div className="terrain-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      data-testid="terrain-draw-finish"
                      disabled={
                        terrainDraft.kind === 'linear'
                          ? terrainDraft.points.length < 2
                          : terrainDraft.points.length < 3
                      }
                      onClick={finishTerrainDraft}
                    >
                      Finish (Enter)
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="terrain-draw-cancel"
                      onClick={cancelTerrainDraft}
                    >
                      Cancel (Esc)
                    </button>
                  </div>
                  <p className="terrain-hint">
                    {terrainDraft.kind === 'linear'
                      ? 'Enter finishes · Escape cancels · Backspace removes the last vertex. Lines reaching past the edge are clipped to the battlefield; rivers and roads may cross areas and each other.'
                      : 'Enter finishes · Escape cancels · Backspace removes the last vertex. Shapes reaching past the edge are clipped to the battlefield; overlapping areas and hills that break nesting are refused, never auto-adjusted.'}
                  </p>
                </div>
              ) : (
                <>
                  <label className="field">
                    New area category
                    <select
                      data-testid="terrain-new-category"
                      value={draftCategory}
                      onChange={(event) => setDraftCategory(event.target.value)}
                    >
                      {GROUND_COVER_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {groundCoverLabel(category)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="terrain-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      data-testid="terrain-draw-area"
                      onClick={() => startTerrainDraft('ground')}
                    >
                      Draw area
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="terrain-draw-hill"
                      onClick={() => startTerrainDraft('elevation')}
                    >
                      Draw hill
                    </button>
                  </div>
                  <label className="field">
                    New river or road
                    <select
                      data-testid="terrain-new-linear-category"
                      value={draftLinearCategory}
                      onChange={(event) => setDraftLinearCategory(event.target.value)}
                    >
                      {LINEAR_FEATURE_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {linearLabel(category)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Width (m)
                    <input
                      type="number"
                      data-testid="terrain-new-linear-width"
                      min={0.1}
                      step={0.1}
                      value={draftLinearWidth}
                      onChange={(event) => setDraftLinearWidth(event.target.value)}
                    />
                  </label>
                  <div className="terrain-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      data-testid="terrain-draw-linear"
                      onClick={() => startTerrainDraft('linear')}
                    >
                      Draw river or road
                    </button>
                  </div>
                  <p className="terrain-hint">
                    Click vertices on the map, then finish from the keyboard. A refused shape is
                    highlighted in red. Rivers and roads may cross ground cover, elevation, and
                    each other.
                  </p>
                </>
              )}
              {terrainRefusal ? (
                <p className="field-error" role="alert" data-testid="terrain-refusal">
                  {terrainRefusal.reason}
                </p>
              ) : null}
              {groundFeatures.length > 0 ? (
                <ul className="terrain-list">
                  {groundFeatures.map((feature) => {
                    const area = groundAreaSquareMetres(feature);
                    const selected = feature.id === selectedTerrainId;
                    return (
                      <li
                        className={selected ? 'terrain-row selected' : 'terrain-row'}
                        key={feature.id}
                        data-testid="terrain-ground-row"
                        data-category={feature.category}
                      >
                        <button
                          type="button"
                          className="terrain-select"
                          data-testid="terrain-select"
                          aria-pressed={selected}
                          onClick={() => selectTerrain(feature.id)}
                        >
                          <span
                            className="swatch"
                            style={{
                              background:
                                (
                                  GROUND_FILLS_FOR_PANEL[feature.category] || { fill: '#cccccc' }
                                ).fill,
                            }}
                            aria-hidden="true"
                          />
                          <span>
                            <span className="unit-name">
                              {groundCoverLabel(feature.category)}
                            </span>
                            <span className="unit-detail">
                              {feature.polygon.length} vertices
                              {area === null ? '' : ` · ${area.toLocaleString('en')} m²`}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn-quiet btn-danger"
                          data-testid="terrain-delete"
                          title="Delete this area (undoable)"
                          onClick={() => deleteTerrainFeature(feature.id)}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="empty-terrain">
                  No ground cover areas yet. Open ground is the default; draw forest, rough
                  ground, water, or a settlement.
                </p>
              )}
              <p className="readonly-note">
                Areas must not overlap; touching edge to edge is legal. Partly-outside shapes are
                clipped to the battlefield edge.
              </p>
              <h3 className="terrain-subhead">Hills (elevation)</h3>
              {hillFeatures.length > 0 ? (
                <ul className="terrain-list">
                  {hillFeatures.map((feature) => {
                    const area = groundAreaSquareMetres(feature);
                    const selected = feature.id === selectedTerrainId;
                    return (
                      <li
                        className={selected ? 'terrain-row selected' : 'terrain-row'}
                        key={feature.id}
                        data-testid="terrain-hill-row"
                        data-level={feature.level}
                      >
                        <button
                          type="button"
                          className="terrain-select"
                          data-testid="terrain-select"
                          aria-pressed={selected}
                          onClick={() => selectTerrain(feature.id)}
                        >
                          <span
                            className="swatch"
                            style={{ background: '#c6c8a4' }}
                            aria-hidden="true"
                          />
                          <span>
                            <span className="unit-name">Hill · level {feature.level}</span>
                            <span className="unit-detail">
                              {feature.polygon.length} vertices
                              {area === null ? '' : ` · ${area.toLocaleString('en')} m²`}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn-quiet btn-danger"
                          data-testid="terrain-delete"
                          title="Delete this hill (nested hills are promoted, undoable)"
                          onClick={() => deleteTerrainFeature(feature.id)}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="empty-terrain">
                  No hills yet. Draw a hill for level 1, then draw inside it for level 2, and so
                  on — levels follow from nesting and are never typed.
                </p>
              )}
              <p className="readonly-note">
                Hills nest: a hill wholly inside level n becomes level n + 1. Crossing,
                straddling, and self-intersecting shapes are refused. Deleting a hill promotes
                its nested hills. Elevation is independent of ground cover.
              </p>
              <h3 className="terrain-subhead">Rivers and roads</h3>
              {linearFeatures.length > 0 ? (
                <ul className="terrain-list">
                  {linearFeatures.map((feature) => {
                    const selected = feature.id === selectedTerrainId;
                    return (
                      <li
                        className={selected ? 'terrain-row selected' : 'terrain-row'}
                        key={feature.id}
                        data-testid="terrain-linear-row"
                        data-category={feature.category}
                      >
                        <button
                          type="button"
                          className="terrain-select"
                          data-testid="terrain-select"
                          aria-pressed={selected}
                          onClick={() => selectTerrain(feature.id)}
                        >
                          <span
                            className="swatch"
                            style={{
                              background:
                                (
                                  LINEAR_FILLS_FOR_PANEL[feature.category] || { fill: '#cccccc' }
                                ).fill,
                            }}
                            aria-hidden="true"
                          />
                          <span>
                            <span className="unit-name">
                              {linearLabel(feature.category)} · {feature.width} m
                            </span>
                            <span className="unit-detail">
                              {feature.path.length} vertices · {feature.path.length - 1}{' '}
                              {feature.path.length - 1 === 1 ? 'segment' : 'segments'}
                            </span>
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn-quiet btn-danger"
                          data-testid="terrain-delete"
                          title="Delete this river or road (undoable)"
                          onClick={() => deleteTerrainFeature(feature.id)}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="empty-terrain">
                  No rivers or roads yet. Draw a river or road, give it a width in metres, and
                  edit its vertices on the map.
                </p>
              )}
              <p className="readonly-note">
                Rivers and roads may cross ground cover, hills, and each other. Lines reaching
                past the edge are clipped to the battlefield.
              </p>
            </div>
          ) : (
          <>
          <span className="eyebrow">FORCES IN THE FIELD</span>
          <div className="oob-head">
            <h2>
              Order of battle <span data-testid="oob-count">{units.length}</span>
            </h2>
            <button
              type="button"
              className="btn-tool"
              data-testid="oob-add"
              title="Add a unit to this side"
              aria-label="Add unit"
              onClick={handleAddUnit}
            >
              +
            </button>
          </div>
          <div className="mode-tabs" role="tablist" aria-label="Order of battle filter">
            <button
              type="button"
              role="tab"
              aria-selected={oobTab === 'all'}
              className={oobTab === 'all' ? 'mode-tab active' : 'mode-tab'}
              data-testid="oob-tab-all"
              onClick={() => setOobTab('all')}
            >
              All
            </button>
            {sides.map((side, tabIndex) => (
              <button
                type="button"
                role="tab"
                key={side?.id ?? tabIndex}
                aria-selected={oobTab === side?.id}
                className={oobTab === side?.id ? 'mode-tab active' : 'mode-tab'}
                data-testid={`oob-tab-${tabIndex}`}
                data-side={side?.id}
                onClick={() => setOobTab(side?.id)}
              >
                {side?.name ?? 'Unnamed side'}
              </button>
            ))}
          </div>
          {notice ? (
            <p className="oob-notice" role="status" data-testid="oob-notice">
              {notice}
            </p>
          ) : null}
          {sides
            .filter((side) => oobTab === 'all' || side?.id === oobTab)
            .map((side, index) => {
              const sideUnits = unitsForSide(side?.id);
              const soldiers = sideUnits.reduce(
                (sum, unit) => sum + (Number(unit?.soldiers) || 0),
                0,
              );
              return (
                <section
                  className="side"
                  key={side?.id ?? side?.name ?? index}
                  data-testid={
                    side?.id === sides[0]?.id
                      ? 'oob-side-a'
                      : side?.id === sides[1]?.id
                        ? 'oob-side-b'
                        : `oob-side-${index}`
                  }
                  data-empty={sideUnits.length === 0 ? 'true' : 'false'}
                >
                  <div className="side-name">
                    <span
                      className="swatch"
                      style={{ background: side?.color ?? '#888' }}
                      aria-hidden="true"
                    />
                    {side?.name ?? 'Unnamed side'}
                  </div>
                  <p className="side-count" data-testid="oob-side-count">
                    {sideUnits.length === 0
                      ? 'No units'
                      : `${sideUnits.length} ${sideUnits.length === 1 ? 'unit' : 'units'} · ${soldiers.toLocaleString('en')} troops`}
                  </p>
                  {sideUnits.length === 0 ? (
                    <p className="empty-oob">No units yet.</p>
                  ) : (
                    sideUnits.map((unit) => {
                      const unknownTroop = !isKnownTroopType(unit?.troopType);
                      const inConflict = (unit?.id ? unitConflictIds : []).includes(unit?.id);
                      return (
                        <button
                          type="button"
                          className={
                            (unit?.id === selectedUnitId ? 'unit-row selected' : 'unit-row') +
                            (inConflict ? ' conflict' : '')
                          }
                          key={unit?.id ?? unit?.name}
                          data-testid="oob-unit"
                          data-unit-id={unit?.id ?? ''}
                          data-selected={unit?.id === selectedUnitId ? 'true' : 'false'}
                          data-conflict={inConflict ? 'true' : 'false'}
                          aria-pressed={unit?.id === selectedUnitId}
                          onClick={() => {
                            setSelectedUnitId(unit?.id ?? null);
                            setNotice(null);
                            setUnitConflictIds([]);
                          }}
                        >
                          <span
                            className="swatch"
                            style={{
                              background: unknownTroop
                                ? '#9aa0a6'
                                : sideColorFor(sides, unit),
                            }}
                            aria-hidden="true"
                          />
                          <span>
                            <span className="unit-name">{unit?.name}</span>
                            <span className="unit-detail">
                              {troopDisplayName(unit?.troopType)} · {unit?.soldiers} soldiers
                            </span>
                            {unknownTroop ? (
                              <span
                                className="unknown-badge"
                                data-testid="unknown-troop-badge"
                              >
                                Unknown troop type &ldquo;{unit?.troopType}&rdquo; ·
                                preserved
                              </span>
                            ) : null}
                          </span>
                        </button>
                      );
                    })
                  )}
                </section>
              );
            })}
          <p className="readonly-note">
            New and duplicated units are placed at the first free spot in the current view.
            Select a unit to edit it in the inspector. Switch to the Map editor tab to shape the
            battlefield.
          </p>
          </>
          )}
        </aside>
        <section className="map-panel" aria-label="Battlefield map">
          <div className="map-caption" data-testid="battlefield-dims">
            Battlefield · {document.battlefield?.width} × {document.battlefield?.height} m ·
            origin south-west
          </div>
          <BattlefieldMap
            width={document.battlefield?.width}
            height={document.battlefield?.height}
            units={units}
            sides={sides}
            selectedUnitId={selectedUnitId}
            onSelectUnit={(id: string | null) => {
              setSelectedUnitId(id);
              setNotice(null);
              setUnitConflictIds([]);
            }}
            terrainFeatures={document.terrainFeatures}
            selectedTerrainId={selectedTerrainId}
            selectedVertexIndex={selectedVertexIndex}
            draft={
              terrainDraft
                ? {
                    kind: terrainDraft.kind,
                    category: terrainDraft.category,
                    points: terrainDraft.points,
                    width: terrainDraft.width,
                  }
                : null
            }
            refusal={terrainRefusal}
            terrainInteractive={inTerrainMode}
            onTerrainSelect={(id, vertexIndex) => selectTerrain(id, vertexIndex ?? null)}
            onTerrainClearSelection={() => {
              setSelectedTerrainId(null);
              setSelectedVertexIndex(null);
            }}
            onMapDraftPoint={(point) => addDraftPoint(point)}
            onEdgeInsert={(featureId, edgeIndex) => insertTerrainVertex(featureId, edgeIndex)}
            onVertexCommit={(featureId, index, point) =>
              commitTerrainVertex(featureId, index, point)
            }
            unitConflictIds={unitConflictIds}
            onMoveUnit={handleMoveUnit}
            onRotateUnit={handleRotateUnit}
          />
          <p className="map-hint">
            Click a unit to select it · drag to place it (a refused drop returns and highlights
            the conflict) · drag the round handle to rotate about the front midpoint (snaps to
            15°, hold Shift for free rotation) · scroll to zoom around the cursor · hand tool or
            Space to pan · V selects, H pans · G toggles the grid, L the labels, C the contours,
            0 fits the battlefield
            {inTerrainMode
              ? ' · click the map to add terrain vertices, Enter finishes, Esc cancels'
              : null}
          </p>
        </section>
        <aside className="right-panel panel" aria-label="Inspector" data-testid="inspector">
          {selectedUnit ? (
            <>
              <section aria-label="Selected unit" data-testid="unit-inspector">
                <span className="eyebrow">SELECTED UNIT</span>
                <h3 data-testid="unit-title">{selectedUnit.name || 'Unit'}</h3>
                {selectedDerived ? (
                  <p className="derived-line" data-testid="unit-derived">
                    {selectedDerived.ranks} {selectedDerived.ranks === 1 ? 'rank' : 'ranks'} ·{' '}
                    {selectedDerived.frontageM.toFixed(1)} m frontage ·{' '}
                    {selectedDerived.depthM.toFixed(1)} m depth
                    {selectedSpacingClass ? ` · ${selectedSpacingClass} spacing` : ''}
                  </p>
                ) : (
                  <p className="derived-line" data-testid="unit-derived">
                    Ranks, frontage, and depth follow from soldiers, files, and spacings.
                  </p>
                )}
                {selectedDerived &&
                Number.isInteger(selectedDerived.ranks) &&
                Number.isInteger(selectedUnit.files) &&
                selectedUnit.files >= 1 ? (
                  <>
                    <div className="formation-preview">
                      <FormationDiagram
                        files={selectedUnit.files}
                        ranks={selectedDerived.ranks ?? 0}
                      />
                      <span>FORMATION DIAGRAM</span>
                    </div>
                  </>
                ) : null}
                <label className="field">
                  Unit name
                  <DraftField
                    testid="unit-name"
                    value={selectedUnit.name ?? ''}
                    error={fieldErrors['unit-name'] ?? null}
                    maxLength={60}
                    onCommit={(raw) => commitUnitName(selectedUnit, raw)}
                  />
                </label>
                {fieldError('unit-name')}
                <div className="field-pair">
                  <div>
                    <label className="field">
                      Side
                      <select
                        data-testid="unit-side"
                        value={selectedUnit.side ?? ''}
                        onChange={(event) => commitUnitSide(selectedUnit, event.target.value)}
                        aria-invalid={fieldErrors['unit-side'] ? true : undefined}
                      >
                        {sides.map((side) => (
                          <option key={side?.id} value={side?.id}>
                            {side?.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {fieldError('unit-side')}
                  </div>
                  <div>
                    <label className="field">
                      Troop type
                      <select
                        data-testid="unit-troop"
                        value={selectedUnit.troopType ?? ''}
                        onChange={(event) => commitUnitTroopType(selectedUnit, event.target.value)}
                        aria-invalid={fieldErrors['unit-troop'] ? true : undefined}
                      >
                        {TROOP_TYPE_KEYS.map((key) => (
                          <option key={key} value={key}>
                            {(TROOP_TYPE_CATALOGUE as any)[key]?.displayName || key}
                          </option>
                        ))}
                      </select>
                    </label>
                    {fieldError('unit-troop')}
                  </div>
                </div>
                <div className="field-pair">
                  <div>
                    <label className="field">
                      Soldiers
                      <DraftField
                        testid="unit-soldiers"
                        type="number"
                        min={1}
                        step={1}
                        value={String(selectedUnit.soldiers ?? '')}
                        error={fieldErrors['unit-soldiers'] ?? null}
                        onCommit={(raw) => commitUnitNumbers(selectedUnit, { soldiers: raw })}
                      />
                    </label>
                    {fieldError('unit-soldiers')}
                  </div>
                  <div>
                    <label className="field">
                      Files
                      <DraftField
                        testid="unit-files"
                        type="number"
                        min={1}
                        step={1}
                        value={String(selectedUnit.files ?? '')}
                        error={fieldErrors['unit-files'] ?? null}
                        onCommit={(raw) => commitUnitNumbers(selectedUnit, { files: raw })}
                      />
                    </label>
                    {fieldError('unit-files')}
                  </div>
                </div>
                <label className="field">
                  Spacing preset
                  <select
                    data-testid="unit-preset"
                    value={presetKeyFor(selectedUnit)}
                    onChange={(event) => commitUnitPreset(selectedUnit, event.target.value)}
                    aria-invalid={fieldErrors['unit-preset'] ? true : undefined}
                  >
                    {presetKeyFor(selectedUnit) === 'custom' ? (
                      <option value="custom">Custom spacings</option>
                    ) : null}
                    {SPACING_PRESET_KEYS.map((key) => {
                      const preset = (getTroopType(selectedUnit.troopType) as any)?.presets?.[key];
                      const label = preset
                        ? `${key} (${preset.lateralInterval} × ${preset.rankDepth} m)`
                        : key;
                      return (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {fieldError('unit-preset')}
                <div className="field-pair">
                  <div>
                    <label className="field">
                      Lateral interval (m)
                      <DraftField
                        testid="unit-spacing-lateral"
                        type="number"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={String(selectedUnit.lateralInterval ?? '')}
                        error={fieldErrors['unit-spacing-lateral'] ?? null}
                        onCommit={(raw) =>
                          commitUnitSpacing(selectedUnit, 'lateralInterval', raw)
                        }
                      />
                    </label>
                    {fieldError('unit-spacing-lateral')}
                  </div>
                  <div>
                    <label className="field">
                      Rank depth (m)
                      <DraftField
                        testid="unit-spacing-depth"
                        type="number"
                        min={0.1}
                        max={10}
                        step={0.1}
                        value={String(selectedUnit.rankDepth ?? '')}
                        error={fieldErrors['unit-spacing-depth'] ?? null}
                        onCommit={(raw) => commitUnitSpacing(selectedUnit, 'rankDepth', raw)}
                      />
                    </label>
                    {fieldError('unit-spacing-depth')}
                  </div>
                </div>
                <p className="preset-note">
                  A spacing preset pre-fills both spacings in metres; the scenario stores the
                  metres (the preset itself is not stored).
                </p>
                <div className="field-pair">
                  <div>
                    <label className="field">
                      Position X — front midpoint (m)
                      <DraftField
                        testid="unit-position-x"
                        type="number"
                        step={0.1}
                        value={selectedPosition ? String(selectedPosition.x) : ''}
                        error={fieldErrors['unit-position'] ?? null}
                        onCommit={(raw) => commitUnitPositionAxis(selectedUnit, 'x', raw)}
                      />
                    </label>
                  </div>
                  <div>
                    <label className="field">
                      Position Y — front midpoint (m)
                      <DraftField
                        testid="unit-position-y"
                        type="number"
                        step={0.1}
                        value={selectedPosition ? String(selectedPosition.y) : ''}
                        error={fieldErrors['unit-position'] ?? null}
                        onCommit={(raw) => commitUnitPositionAxis(selectedUnit, 'y', raw)}
                      />
                    </label>
                  </div>
                </div>
                {fieldError('unit-position')}
                <label className="field">
                  Facing (°)
                  <DraftField
                    testid="unit-facing"
                    type="number"
                    min={0}
                    max={360}
                    step={1}
                    value={selectedFacing !== null ? String(selectedFacing) : ''}
                    error={fieldErrors['unit-facing'] ?? null}
                    onCommit={(raw) => commitUnitFacing(selectedUnit, raw)}
                  />
                </label>
                {fieldError('unit-facing')}
                <p className="preset-note">
                  Position is the midpoint of the front edge in metres; facing is a compass
                  bearing (0 = north, clockwise). Dragging the footprint or its round handle
                  edits the same values.
                </p>
                <div className="unit-actions">
                  <button
                    type="button"
                    className="btn-secondary"
                    data-testid="unit-duplicate"
                    onClick={() => handleDuplicateUnit(selectedUnit)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    className="btn-quiet btn-danger"
                    data-testid="unit-delete"
                    onClick={() => handleDeleteUnit(selectedUnit)}
                  >
                    Delete
                  </button>
                </div>
                {fieldError('unit-delete')}
              </section>
              <hr className="panel-divider" />
            </>
          ) : null}
          {terrainDraft ? (
            <section
              className="terrain-inspector"
              aria-label={
                terrainDraft.kind === 'linear'
                  ? 'River or road being drawn'
                  : terrainDraft.kind === 'elevation'
                    ? 'Hill being drawn'
                    : 'Area being drawn'
              }
              data-testid="terrain-inspector"
            >
              <h3>
                {terrainDraft.kind === 'linear'
                  ? `New ${linearLabel(terrainDraft.category)}`
                  : terrainDraft.kind === 'elevation'
                    ? 'New hill'
                    : `New ${groundCoverLabel(terrainDraft.category)} area`}
              </h3>
              {terrainDraft.kind === 'linear' ? (
                <>
                  <label className="field">
                    Category
                    <select
                      data-testid="terrain-draft-linear-category"
                      value={terrainDraft.category}
                      onChange={(event) =>
                        setTerrainDraft({ ...terrainDraft, category: event.target.value, error: '' })
                      }
                    >
                      {LINEAR_FEATURE_CATEGORIES.map((category) => (
                        <option key={category} value={category}>
                          {linearLabel(category)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Width (m)
                    <input
                      type="number"
                      data-testid="terrain-draft-linear-width"
                      min={0.1}
                      step={0.1}
                      value={String(terrainDraft.width ?? '')}
                      onChange={(event) =>
                        setTerrainDraft({
                          ...terrainDraft,
                          width: Number(event.target.value),
                          error: '',
                        })
                      }
                    />
                  </label>
                </>
              ) : terrainDraft.kind === 'elevation' ? (
                <div className="kv">
                  <dt>Level</dt>
                  <dd>Derived from nesting when finished (inside level n becomes level n + 1)</dd>
                </div>
              ) : (
                <label className="field">
                  Category
                  <select
                    data-testid="terrain-draft-category"
                    value={terrainDraft.category}
                    onChange={(event) =>
                      setTerrainDraft({ ...terrainDraft, category: event.target.value, error: '' })
                    }
                  >
                    {GROUND_COVER_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {groundCoverLabel(category)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="kv">
                <dt>Vertices</dt>
                <dd>
                  {terrainDraft.points.length}{' '}
                  {terrainDraft.kind === 'linear' ? '(at least 2 to finish)' : '(at least 3 to finish)'}
                </dd>
              </div>
              {terrainDraft.error ? (
                <p className="field-error" role="alert">
                  {terrainDraft.error}
                </p>
              ) : null}
              {terrainDraft.kind === 'linear' ? (
                <p className="terrain-hint">
                  Set the category and width here; both travel with the finished line.
                </p>
              ) : null}
            </section>
          ) : null}
          {selectedTerrain && selectedTerrain.kind === 'linear' && !terrainDraft ? (
            <section
              className="terrain-inspector"
              aria-label="Selected river or road"
              data-testid="terrain-inspector"
            >
              <h3>{linearLabel(selectedTerrain.category)}</h3>
              <label className="field">
                Category
                <select
                  data-testid="terrain-linear-category"
                  value={selectedTerrain.category}
                  onChange={(event) =>
                    commitLinearCategory(selectedTerrain.id, event.target.value)
                  }
                >
                  {LINEAR_FEATURE_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {linearLabel(category)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                Width (m)
                <DraftField
                  testid="terrain-linear-width"
                  type="number"
                  min={0.1}
                  step={0.1}
                  value={String(selectedTerrain.width ?? '')}
                  error={fieldErrors['terrain-linear-width'] ?? null}
                  onCommit={(raw) => commitLinearWidth(selectedTerrain.id, raw)}
                />
              </label>
              {fieldError('terrain-linear-width')}
              <div className="kv">
                <dt>Vertices</dt>
                <dd>{selectedTerrain.path.length}</dd>
              </div>
              <ol className="terrain-vertex-list" data-testid="terrain-vertex-list">
                {selectedTerrain.path.map(
                  (point: { x: number; y: number }, index: number) => {
                    const active = index === selectedVertexIndex;
                    return (
                      <li
                        className={active ? 'terrain-vertex-row selected' : 'terrain-vertex-row'}
                        key={index}
                        data-testid="terrain-vertex-row"
                      >
                        <span className="mono">
                          {index + 1}. ({point.x.toFixed(1)}, {point.y.toFixed(1)})
                        </span>
                        <button
                          type="button"
                          className="btn-quiet btn-danger"
                          data-testid="terrain-vertex-delete"
                          data-index={index}
                          disabled={selectedTerrain.path.length <= 2}
                          onClick={() => deleteTerrainVertex(selectedTerrain.id, index)}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  },
                )}
              </ol>
              <div className="terrain-actions">
                <button
                  type="button"
                  className="btn-secondary btn-danger"
                  data-testid="terrain-delete-feature"
                  onClick={() => deleteTerrainFeature(selectedTerrain.id)}
                >
                  Delete river or road
                </button>
              </div>
              <p className="terrain-hint">
                Drag a vertex on the map · click a small edge dot to insert a vertex · select a
                vertex and press Delete to remove it (at least two stay). Rivers and roads may
                cross everything.
              </p>
            </section>
          ) : null}
          {selectedTerrain && selectedTerrain.kind !== 'linear' && !terrainDraft ? (
            <section
              className="terrain-inspector"
              aria-label={
                selectedTerrain.kind === 'elevation' ? 'Selected hill' : 'Selected ground cover area'
              }
              data-testid="terrain-inspector"
            >
              <h3>
                {selectedTerrain.kind === 'elevation'
                  ? `Hill · level ${selectedTerrain.level}`
                  : `${groundCoverLabel(selectedTerrain.category)} area`}
              </h3>
              {selectedTerrain.kind === 'elevation' ? (
                <div className="kv">
                  <dt>Level</dt>
                  <dd data-testid="terrain-level">
                    {selectedTerrain.level} (derived from nesting — never typed)
                  </dd>
                </div>
              ) : (
                <label className="field">
                  Category
                  <select
                    data-testid="terrain-category"
                    value={selectedTerrain.category}
                    onChange={(event) =>
                      commitTerrainCategory(selectedTerrain.id, event.target.value)
                    }
                  >
                    {GROUND_COVER_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {groundCoverLabel(category)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <div className="kv">
                <dt>Area</dt>
                <dd>
                  {(() => {
                    const area = groundAreaSquareMetres(selectedTerrain);
                    return area === null ? '—' : `${area.toLocaleString('en')} m²`;
                  })()}
                </dd>
              </div>
              <div className="kv">
                <dt>Vertices</dt>
                <dd>{selectedTerrain.polygon.length}</dd>
              </div>
              <ol className="terrain-vertex-list" data-testid="terrain-vertex-list">
                {selectedTerrain.polygon.map(
                  (point: { x: number; y: number }, index: number) => {
                    const active = index === selectedVertexIndex;
                    return (
                      <li
                        className={active ? 'terrain-vertex-row selected' : 'terrain-vertex-row'}
                        key={index}
                        data-testid="terrain-vertex-row"
                      >
                        <span className="mono">
                          {index + 1}. ({point.x.toFixed(1)}, {point.y.toFixed(1)})
                        </span>
                        <button
                          type="button"
                          className="btn-quiet btn-danger"
                          data-testid="terrain-vertex-delete"
                          data-index={index}
                          disabled={selectedTerrain.polygon.length <= 3}
                          onClick={() => deleteTerrainVertex(selectedTerrain.id, index)}
                        >
                          Delete
                        </button>
                      </li>
                    );
                  },
                )}
              </ol>
              <div className="terrain-actions">
                <button
                  type="button"
                  className="btn-secondary btn-danger"
                  data-testid="terrain-delete-feature"
                  onClick={() => deleteTerrainFeature(selectedTerrain.id)}
                >
                  {selectedTerrain.kind === 'elevation' ? 'Delete hill' : 'Delete area'}
                </button>
              </div>
              <p className="terrain-hint">
                Drag a vertex on the map · click a small edge dot to insert a vertex · select a
                vertex and press Delete to remove it (at least three stay).
              </p>
            </section>
          ) : null}
          <h2>Scenario</h2>
          <label className="field">
            Title
            <DraftField
              testid="inspector-title"
              value={document.title ?? ''}
              error={fieldErrors.title ?? null}
              maxLength={120}
              onCommit={commitTitle}
            />
          </label>
          {fieldError('title')}
          <label className="field">
            Description
            <DraftField
              testid="inspector-description"
              value={document.description ?? ''}
              error={fieldErrors.description ?? null}
              multiline
              rows={3}
              maxLength={2000}
              onCommit={commitDescription}
            />
          </label>
          {fieldError('description')}
          <div className="field-pair">
            <div>
              <label className="field">
                Width (m)
                <DraftField
                  testid="inspector-width"
                  type="number"
                  min={1}
                  step={0.1}
                  value={String(document.battlefield?.width ?? '')}
                  error={fieldErrors.width ?? null}
                  onCommit={(raw) => commitDimension('width', raw)}
                />
              </label>
              {fieldError('width')}
            </div>
            <div>
              <label className="field">
                Height (m)
                <DraftField
                  testid="inspector-height"
                  type="number"
                  min={1}
                  step={0.1}
                  value={String(document.battlefield?.height ?? '')}
                  error={fieldErrors.height ?? null}
                  onCommit={(raw) => commitDimension('height', raw)}
                />
              </label>
              {fieldError('height')}
            </div>
          </div>
          {sides.map((side, index) => (
            <div className="field-pair" key={side?.id ?? index}>
              <div>
                <label className="field">
                  {`Side ${index + 1} name`}
                  <DraftField
                    testid={`inspector-side-${index}`}
                    value={side?.name ?? ''}
                    error={fieldErrors[`side-name-${index}`] ?? null}
                    maxLength={60}
                    onCommit={(raw) => commitSideName(index, raw)}
                  />
                </label>
                {fieldError(`side-name-${index}`)}
              </div>
              <div>
                <label className="field">
                  Colour
                  <DraftField
                    testid={`inspector-side-color-${index}`}
                    type="color"
                    value={side?.color ?? '#888888'}
                    error={fieldErrors[`side-color-${index}`] ?? null}
                    onCommit={(raw) => commitSideColor(index, raw)}
                  />
                </label>
                {fieldError(`side-color-${index}`)}
              </div>
            </div>
          ))}
          <p className="readonly-note">Two sides, always: sides cannot be added or removed.</p>
          <dl>
            <div className="kv">
              <dt>Ruleset</dt>
              <dd className="mono" data-testid="inspector-ruleset">
                {document.ruleset?.id} {document.ruleset?.version}
              </dd>
            </div>
            <div className="kv">
              <dt>Terrain features</dt>
              <dd data-testid="inspector-terrain-count">
                {(Array.isArray(document.terrainFeatures) ? document.terrainFeatures : []).length}
              </dd>
            </div>
          </dl>
          <div className="issues" data-testid="issues-panel">
            <h3>
              Issues{issueCount ? <span data-testid="issue-count"> {issueCount}</span> : null}
            </h3>
            {errors.map((problem) => (
              <p className="issue issue-error" data-testid="issue-error" key={problem}>
                {problem}
              </p>
            ))}
            {warnings.map((warning) => (
              <p className="issue issue-warning" data-testid="issue-warning" key={warning}>
                {warning}
              </p>
            ))}
            {catalogueWarnings.map((warning) => (
              <p
                className="issue issue-warning"
                data-testid="unknown-troop-warning"
                key={warning}
              >
                {warning}
              </p>
            ))}
            {notices.map((notice) => (
              <p className="issue issue-info" data-testid="ruleset-notice" key={notice}>
                {notice}
              </p>
            ))}
            {issueCount === 0 ? <p className="issues-note">No warnings.</p> : null}
          </div>
        </aside>
      </main>
    </div>
  );
}
