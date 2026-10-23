'use client';

import { useEffect, useMemo, useState } from 'react';
import BattlefieldMap from './battlefield-map';
import {
  collectUnknownTroopTypeWarnings,
  isKnownTroopType,
} from '../domain/polis-classical.js';
import {
  collectWarnings,
  isProvisionalRuleset,
  resizeBattlefield,
  rulesetCompatibilityNotice,
  updateScenarioDescription,
  updateScenarioTitle,
  updateSideColor,
  updateSideName,
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
          <h2>Order of battle</h2>
          {sides.map((side) => {
            const sideUnits = unitsForSide(side?.id);
            return (
              <section
                className="side"
                key={side?.id ?? side?.name}
                data-testid={side?.id === sides[0]?.id ? 'oob-side-a' : 'oob-side-b'}
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
                    : `${sideUnits.length} ${sideUnits.length === 1 ? 'unit' : 'units'}`}
                </p>
                {sideUnits.length === 0 ? (
                  <p className="empty-oob">No units yet.</p>
                ) : (
                  sideUnits.map((unit) => {
                    const unknownTroop = !isKnownTroopType(unit?.troopType);
                    return (
                      <div key={unit?.id ?? unit?.name}>
                        <div className="side-name">
                          <span
                            className="swatch"
                            style={{ background: unknownTroop ? '#9aa0a6' : (side?.color ?? '#888') }}
                          />
                          {unit?.name}
                        </div>
                        {unknownTroop ? (
                          <p className="unknown-badge" data-testid="unknown-troop-badge">
                            Unknown troop type &ldquo;{unit?.troopType}&rdquo; · preserved
                          </p>
                        ) : null}
                      </div>
                    );
                  })
                )}
              </section>
            );
          })}
          <p className="readonly-note">
            Units and terrain are added in later slices; this slice always opens an empty
            battlefield.
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
          />
          <p className="map-hint">
            Scroll to zoom around the cursor · hand tool or Space to pan · V selects, H pans ·
            G toggles the grid, L the labels, 0 fits the battlefield
          </p>
        </section>
        <aside className="right-panel panel" aria-label="Inspector" data-testid="inspector">
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
