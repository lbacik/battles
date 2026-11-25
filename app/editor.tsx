'use client';

import { useEffect, useEffectEvent, useMemo, useState } from 'react';
import BattlefieldMap from './battlefield-map';
import { PanelToggle, panelGridColumns, panelMinWidth, usePersistentPanel } from './collapsible-panel';
import { LeftPanel } from './editor/left-panel';
import { UnitInspector } from './editor/unit-inspector';
import { TerrainInspector } from './editor/terrain-inspector';
import { createUnitCommits } from './editor/unit-commits';
import { createTerrainDraft } from './editor/terrain-draft';
import { useTerrainEdits } from './editor/terrain-edit';
import {
  DraftField,
  FormationDiagram,
  GROUND_FILLS_FOR_PANEL,
  LINEAR_FILLS_FOR_PANEL,
  SPACING_PRESET_KEYS,
  errorMessage,
  groundCoverLabel,
  linearLabel,
  sideColorFor,
  troopDisplayName,
} from './editor/editor-fields';
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
  revision: number | null;
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

export default function Editor({
  document,
  dirty,
  saveError,
  saving,
  revision,
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
  // Collapsible side panels (issues #111, #113): each panel collapses to a
  // narrow strip with an expand control. The collapsed state is a
  // browser-only preference per screen and per panel (localStorage), so a
  // reload restores it; missing or unreadable values start expanded.
  // Selection and document state live above the panels, so selecting on the
  // map while a panel is collapsed works and expanding shows the current
  // selection. The map keeps its camera across resizes, so the view never
  // jumps away.
  const [leftCollapsed, setLeftCollapsed] = usePersistentPanel('editor', 'left');
  const [rightCollapsed, setRightCollapsed] = usePersistentPanel('editor', 'right');
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
  const {
    terrainFeatureById,
    groundAreaSquareMetres,
    startTerrainDraft,
    cancelTerrainDraft,
    addDraftPoint,
    popDraftVertex,
    finishTerrainDraft,
  } = createTerrainDraft({
    document,
    draftCategory,
    draftLinearCategory,
    draftLinearWidth,
    onChange,
    setDraftCategory,
    setDraftLinearCategory,
    setDraftLinearWidth,
    setFieldErrors,
    setSelectedTerrainId,
    setSelectedVertexIndex,
    setTerrainDraft,
    setTerrainRefusal,
    terrainDraft,
  });


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
  // An Effect Event always sees the latest onUndo/onRedo, so the listener is
  // attached once and a keystroke never reaches a stale handler.
  const onUndoRedoKey = useEffectEvent((event: KeyboardEvent) => {
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
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => onUndoRedoKey(event);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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


  const {
    presetKeyFor,
    handleAddUnit,
    handleDuplicateUnit,
    handleDeleteUnit,
    commitUnitName,
    commitUnitSide,
    commitUnitTroopType,
    commitUnitNumbers,
    commitUnitSpacing,
    commitUnitPreset,
  } = createUnitCommits({
    document,
    fail,
    onChange,
    oobTab,
    selectedUnitId,
    setFieldErrors,
    setNotice,
    setSelectedUnitId,
    sides,
  });

  const {
    selectTerrain,
    commitTerrainCategory,
    commitLinearCategory,
    commitLinearWidth,
    deleteTerrainFeature,
    validateTerrainPolygon,
    updateTerrainPolygon,
    insertTerrainVertex,
    deleteTerrainVertex,
    commitTerrainVertex,
    commitUnitGeometry,
    handleMoveUnit,
    handleRotateUnit,
    commitUnitPositionAxis,
    commitUnitFacing,
  } = useTerrainEdits({
    cancelTerrainDraft,
    document,
    errors,
    fail,
    finishTerrainDraft,
    mode,
    onChange,
    popDraftVertex,
    selectedTerrainId,
    selectedVertexIndex,
    setFieldErrors,
    setNotice,
    setSelectedTerrainId,
    setSelectedUnitId,
    setSelectedVertexIndex,
    setTerrainRefusal,
    setUnitConflictIds,
    terrainDraft,
    terrainFeatureById,
  });

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
        <span
          className="status"
          data-testid="save-status"
          role="status"
          data-saving={saving ? 'true' : 'false'}
          data-revision={revision ?? ''}
        >
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
      <main
        className="workspace"
        data-testid="editor-workspace"
        data-left-collapsed={leftCollapsed ? 'true' : 'false'}
        data-right-collapsed={rightCollapsed ? 'true' : 'false'}
        style={{ gridTemplateColumns: panelGridColumns(leftCollapsed, rightCollapsed), minWidth: panelMinWidth(leftCollapsed, rightCollapsed) }}
      >
        <LeftPanel
          mode={mode}
          setMode={setMode}
          leftCollapsed={leftCollapsed}
          setLeftCollapsed={setLeftCollapsed}
          oobTab={oobTab}
          setOobTab={setOobTab}
          selectedUnitId={selectedUnitId}
          setSelectedUnitId={setSelectedUnitId}
          notice={notice}
          setNotice={setNotice}
          unitConflictIds={unitConflictIds}
          setUnitConflictIds={setUnitConflictIds}
          terrainDraft={terrainDraft}
          draftCategory={draftCategory}
          setDraftCategory={setDraftCategory}
          draftLinearCategory={draftLinearCategory}
          setDraftLinearCategory={setDraftLinearCategory}
          draftLinearWidth={draftLinearWidth}
          setDraftLinearWidth={setDraftLinearWidth}
          selectedTerrainId={selectedTerrainId}
          terrainRefusal={terrainRefusal}
          units={units}
          sides={sides}
          unitsForSide={unitsForSide}
          groundFeatures={groundFeatures}
          hillFeatures={hillFeatures}
          linearFeatures={linearFeatures}
          inTerrainMode={inTerrainMode}
          handleAddUnit={handleAddUnit}
          groundAreaSquareMetres={groundAreaSquareMetres}
          startTerrainDraft={startTerrainDraft}
          cancelTerrainDraft={cancelTerrainDraft}
          finishTerrainDraft={finishTerrainDraft}
          selectTerrain={selectTerrain}
          deleteTerrainFeature={deleteTerrainFeature}
        />
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
        <aside
          className={rightCollapsed ? 'right-panel panel collapsed' : 'right-panel panel'}
          aria-label="Inspector"
          data-testid="inspector"
          data-collapsed={rightCollapsed ? 'true' : 'false'}
        >
          <PanelToggle
            side="right"
            collapsed={rightCollapsed}
            onToggle={() => setRightCollapsed((value) => !value)}
            collapseTestId="collapse-right-panel"
            expandTestId="expand-right-panel"
          />
          <UnitInspector
            selectedUnit={selectedUnit}
            selectedDerived={selectedDerived}
            selectedSpacingClass={selectedSpacingClass}
            selectedPosition={selectedPosition}
            selectedFacing={selectedFacing}
            fieldErrors={fieldErrors}
            terrainDraft={terrainDraft}
            sides={sides}
            presetKeyFor={presetKeyFor}
            handleDuplicateUnit={handleDuplicateUnit}
            handleDeleteUnit={handleDeleteUnit}
            commitUnitName={commitUnitName}
            commitUnitSide={commitUnitSide}
            commitUnitTroopType={commitUnitTroopType}
            commitUnitNumbers={commitUnitNumbers}
            commitUnitSpacing={commitUnitSpacing}
            commitUnitPreset={commitUnitPreset}
            commitUnitPositionAxis={commitUnitPositionAxis}
            commitUnitFacing={commitUnitFacing}
            fieldError={fieldError}
          />
          <TerrainInspector
            document={document}
            fieldErrors={fieldErrors}
            notice={notice}
            terrainDraft={terrainDraft}
            setTerrainDraft={setTerrainDraft}
            selectedVertexIndex={selectedVertexIndex}
            sides={sides}
            errors={errors}
            warnings={warnings}
            catalogueWarnings={catalogueWarnings}
            notices={notices}
            issueCount={issueCount}
            selectedTerrain={selectedTerrain}
            groundAreaSquareMetres={groundAreaSquareMetres}
            commitTerrainCategory={commitTerrainCategory}
            commitLinearCategory={commitLinearCategory}
            commitLinearWidth={commitLinearWidth}
            deleteTerrainFeature={deleteTerrainFeature}
            deleteTerrainVertex={deleteTerrainVertex}
            fieldError={fieldError}
            commitTitle={commitTitle}
            commitDescription={commitDescription}
            commitDimension={commitDimension}
            commitSideName={commitSideName}
            commitSideColor={commitSideColor}
          />
        </aside>
      </main>
    </div>
  );
}
