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
  collectWarnings,
  createUnit,
  deleteUnit,
  duplicateUnit,
  isProvisionalRuleset,
  resizeBattlefield,
  rulesetCompatibilityNotice,
  unitDerived,
  updateScenarioDescription,
  updateScenarioTitle,
  updateSideColor,
  updateSideName,
  updateUnitName,
  updateUnitNumbers,
  updateUnitSide,
  updateUnitSpacing,
  updateUnitTroopType,
  validateScenario,
} from '../domain/scenario.js';

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
        <aside className="left-panel panel" aria-label="Order of battle">
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
                      return (
                        <button
                          type="button"
                          className={
                            unit?.id === selectedUnitId ? 'unit-row selected' : 'unit-row'
                          }
                          key={unit?.id ?? unit?.name}
                          data-testid="oob-unit"
                          data-unit-id={unit?.id ?? ''}
                          data-selected={unit?.id === selectedUnitId ? 'true' : 'false'}
                          aria-pressed={unit?.id === selectedUnitId}
                          onClick={() => {
                            setSelectedUnitId(unit?.id ?? null);
                            setNotice(null);
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
            Select a unit to edit it in the inspector.
          </p>
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
            }}
          />
          <p className="map-hint">
            Scroll to zoom around the cursor · hand tool or Space to pan · V selects, H pans ·
            G toggles the grid, L the labels, 0 fits the battlefield
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
