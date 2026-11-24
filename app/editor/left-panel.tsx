'use client';

import { PanelToggle } from '../collapsible-panel';
import { isKnownTroopType } from '../../domain/polis-classical.js';
import {
  GROUND_COVER_CATEGORIES,
  LINEAR_FEATURE_CATEGORIES,
} from '../../domain/scenario.js';
import {
  GROUND_FILLS_FOR_PANEL,
  LINEAR_FILLS_FOR_PANEL,
  groundCoverLabel,
  linearLabel,
  sideColorFor,
  troopDisplayName,
} from './editor-fields';
// Left panel (mode tabs, terrain drawing tools, terrain lists, order of
// battle). Verbatim move from ../editor: markup, data-testid attributes,
// class names and event handling are unchanged, and all state still lives in
// Editor and arrives through props.
export interface LeftPanelProps {
  mode: any;
  setMode: (next: any) => void;
  leftCollapsed: any;
  setLeftCollapsed: (next: any) => void;
  oobTab: any;
  setOobTab: (next: any) => void;
  selectedUnitId: any;
  setSelectedUnitId: (next: any) => void;
  notice: any;
  setNotice: (next: any) => void;
  unitConflictIds: any[];
  setUnitConflictIds: (next: any) => void;
  terrainDraft: any;
  draftCategory: any;
  setDraftCategory: (next: any) => void;
  draftLinearCategory: any;
  setDraftLinearCategory: (next: any) => void;
  draftLinearWidth: any;
  setDraftLinearWidth: (next: any) => void;
  selectedTerrainId: any;
  terrainRefusal: any;
  units: any[];
  sides: any[];
  unitsForSide: (sideId: unknown) => any[];
  groundFeatures: any[];
  hillFeatures: any[];
  linearFeatures: any[];
  inTerrainMode: any;
  handleAddUnit: () => void;
  groundAreaSquareMetres: (feature: any) => number | null;
  startTerrainDraft: (kind: 'ground' | 'elevation' | 'linear') => void;
  cancelTerrainDraft: () => void;
  finishTerrainDraft: () => void;
  selectTerrain: (id: string, vertexIndex?: number | null) => void;
  deleteTerrainFeature: (id: string) => void;
}

export function LeftPanel(props: LeftPanelProps) {
  const {
    mode,
    setMode,
    leftCollapsed,
    setLeftCollapsed,
    oobTab,
    setOobTab,
    selectedUnitId,
    setSelectedUnitId,
    notice,
    setNotice,
    unitConflictIds,
    setUnitConflictIds,
    terrainDraft,
    draftCategory,
    setDraftCategory,
    draftLinearCategory,
    setDraftLinearCategory,
    draftLinearWidth,
    setDraftLinearWidth,
    selectedTerrainId,
    terrainRefusal,
    units,
    sides,
    unitsForSide,
    groundFeatures,
    hillFeatures,
    linearFeatures,
    inTerrainMode,
    handleAddUnit,
    groundAreaSquareMetres,
    startTerrainDraft,
    cancelTerrainDraft,
    finishTerrainDraft,
    selectTerrain,
    deleteTerrainFeature,
  }: LeftPanelProps = props;
  return (
    <>
        <aside
          className={leftCollapsed ? 'left-panel panel collapsed' : 'left-panel panel'}
          aria-label={inTerrainMode ? 'Terrain' : 'Order of battle'}
          data-testid="editor-left-panel"
          data-collapsed={leftCollapsed ? 'true' : 'false'}
        >
          <PanelToggle
            side="left"
            collapsed={leftCollapsed}
            onToggle={() => setLeftCollapsed((value: any) => !value)}
            collapseTestId="collapse-left-panel"
            expandTestId="expand-left-panel"
          />
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
    </>
  );
}
