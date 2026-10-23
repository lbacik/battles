'use client';

import { useMemo, useState } from 'react';
import BattlefieldMap from './battlefield-map';

type ScenarioDocument = any;

interface EditorProps {
  document: ScenarioDocument;
  dirty: boolean;
  saveError: string | null;
  saving: boolean;
  onChange: (next: ScenarioDocument) => void;
  onSave: () => Promise<void>;
  onBack: () => void;
}

function setField(document: ScenarioDocument, patch: Record<string, unknown>): ScenarioDocument {
  return { ...document, ...patch };
}

export default function Editor({
  document,
  dirty,
  saveError,
  saving,
  onChange,
  onSave,
  onBack,
}: EditorProps) {
  const [mode, setMode] = useState<'battle' | 'map'>('battle');

  const units: ScenarioDocument[] = Array.isArray(document.units) ? document.units : [];
  const sides: ScenarioDocument[] = Array.isArray(document.sides) ? document.sides : [];
  const unitsBySide = useMemo(() => {
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
  }, [units]);
  const unitsForSide = (sideId: unknown): ScenarioDocument[] =>
    typeof sideId === 'string' ? (unitsBySide.get(sideId) ?? []) : [];
  const warnings = useMemo(
    () =>
      sides
        .filter((side) => unitsForSide(side?.id).length === 0)
        .map((side) => `Side "${side?.name ?? side?.id}" has no units`),
    [sides, unitsBySide],
  );

  function updateBattlefield(dimension: 'width' | 'height', raw: string) {
    const value = Number(raw);
    if (!Number.isFinite(value)) return;
    onChange(setField(document, { battlefield: { ...document.battlefield, [dimension]: value } }));
  }

  function updateSide(index: number, name: string) {
    const nextSides = sides.map((side, i) => (i === index ? { ...side, name } : side));
    onChange(setField(document, { sides: nextSides }));
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
        {dirty ? (
          <span className="dirty-pill" data-testid="unsaved-pill">
            <span className="dirty-dot" aria-hidden="true" />
            Unsaved changes
          </span>
        ) : null}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="status" data-testid="save-status" role="status">
          {saving ? 'Saving…' : dirty ? 'Unsaved changes' : saveError ? '' : 'Saved'}
        </span>
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
        <p className="validation" role="alert" style={{ margin: '12px 28px 0' }}>
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
                  sideUnits.map((unit) => (
                    <div className="side-name" key={unit?.id ?? unit?.name}>
                      <span className="swatch" style={{ background: side?.color ?? '#888' }} />
                      {unit?.name}
                    </div>
                  ))
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
            Battlefield · {document.battlefield?.width} × {document.battlefield?.height} m
          </div>
          <div className="map-viewport">
            <BattlefieldMap width={document.battlefield?.width} height={document.battlefield?.height} />
          </div>
          <div className="map-status">
            <span data-testid="battlefield-scale">
              {units.length === 0 ? 'Empty battlefield · drawn to scale' : `${units.length} units`}
            </span>
          </div>
          <p className="map-hint">True scale: what is drawn is what counts.</p>
        </section>
        <aside className="right-panel panel" aria-label="Inspector" data-testid="inspector">
          <h2>Scenario</h2>
          <label className="field">
            Title
            <input
              data-testid="inspector-title"
              value={document.title ?? ''}
              maxLength={120}
              onChange={(event) => onChange(setField(document, { title: event.target.value }))}
            />
          </label>
          <label className="field">
            Description
            <textarea
              data-testid="inspector-description"
              value={document.description ?? ''}
              onChange={(event) => onChange(setField(document, { description: event.target.value }))}
            />
          </label>
          <div className="field-pair">
            <label className="field">
              Width (m)
              <input
                data-testid="inspector-width"
                type="number"
                min={1}
                value={document.battlefield?.width ?? ''}
                onChange={(event) => updateBattlefield('width', event.target.value)}
              />
            </label>
            <label className="field">
              Height (m)
              <input
                data-testid="inspector-height"
                type="number"
                min={1}
                value={document.battlefield?.height ?? ''}
                onChange={(event) => updateBattlefield('height', event.target.value)}
              />
            </label>
          </div>
          {sides.map((side, index) => (
            <label className="field" key={side?.id ?? index}>
              {`Side ${index + 1} name`}
              <input
                data-testid={`inspector-side-${index}`}
                value={side?.name ?? ''}
                onChange={(event) => updateSide(index, event.target.value)}
              />
            </label>
          ))}
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
          <div className="issues">
            <h3>Issues</h3>
            {warnings.length ? (
              warnings.map((warning) => (
                <p className="issue issue-warning" key={warning}>
                  {warning}
                </p>
              ))
            ) : (
              <p className="issues-note">No warnings.</p>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
