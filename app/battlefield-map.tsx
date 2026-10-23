'use client';

// Shared tactical map (prototype variant A styling).
//
// The editor and the battle screen render the same true-scale battlefield
// through this component: the battlefield rectangle, its units, and the
// navigation chrome. Coordinates follow ADR 0001 (origin south-west, x east,
// y north, metres); only rendering flips the vertical axis for the screen.
//
// All navigation state (zoom, centre, tool, grid/label toggles, cursor) is
// display-only and lives inside this component: it never touches the scenario
// document and never marks anything as unsaved or undoable.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, Ref, RefObject } from 'react';
import {
  FACING_SNAP_DEG,
  clampMapZoom,
  fitMapView,
  mapViewBox,
  metresPerPixel,
  niceScaleBarMetres,
  normalizeFacing,
  panMapViewByPixels,
  snapFacing,
  toScreenPoint,
  unitFacingDeg,
  unitFootprint,
  unitPosition,
  zoomViewAroundCursor,
} from '../domain/scenario.js';
import { round1 } from '../domain/geometry.js';

const FALLBACK_WIDTH = 1200;
const FALLBACK_HEIGHT = 800;
const FALLBACK_VIEWPORT_W = 800;
const GRID_STEP_M = 100;
const GRID_MAJOR_EVERY_M = 500;
const AXIS_STEP_M = 200;
const ZOOM_STEP = 1.25;

type MapTool = 'select' | 'hand';

interface MapCentre {
  x: number;
  y: number;
}

interface MapView {
  zoom: number;
  center: MapCentre;
}

export interface TerrainMapPoint {
  x: number;
  y: number;
}

export interface TerrainDraftShape {
  kind: 'ground' | 'elevation' | 'linear';
  category: string;
  points: TerrainMapPoint[];
  width?: number;
}

export interface TerrainRefusalShape {
  ring: TerrainMapPoint[];
  reason: string;
  conflictId?: string | null;
  kind?: 'ground' | 'elevation' | 'linear';
}

export interface BattleGhost {
  unitId: string;
  corners: TerrainMapPoint[];
}

export interface BattlePath {
  points: TerrainMapPoint[];
  rejected: boolean;
  label: string;
}

interface BattlefieldMapProps {
  width: number;
  height: number;
  units?: any[];
  sides?: any[];
  // Single selection shared with the order of battle: clicking a unit's
  // true-scale footprint selects it (display-only, never undoable).
  selectedUnitId?: string | null;
  onSelectUnit?: (id: string | null) => void;
  terrainFeatures?: any[];
  selectedTerrainId?: string | null;
  selectedVertexIndex?: number | null;
  draft?: TerrainDraftShape | null;
  refusal?: TerrainRefusalShape | null;
  // When true, map clicks (empty ground) add draft vertices instead of
  // being ignored. The editor sets this in its Map editor mode.
  terrainInteractive?: boolean;
  onTerrainSelect?: (id: string, vertexIndex?: number | null) => void;
  onTerrainClearSelection?: () => void;
  onMapDraftPoint?: (point: TerrainMapPoint) => void;
  onEdgeInsert?: (featureId: string, edgeIndex: number) => void;
  onVertexCommit?: (featureId: string, index: number, point: TerrainMapPoint) => void;
  // Battle drafting (the battle screen): clicks on open ground report the map
  // point in metres for the active Move draft, accepted drafts draw ghost
  // footprints and leg paths, and rejected drafts highlight their conflict.
  battleClickable?: boolean;
  onBattleMapClick?: (point: TerrainMapPoint) => void;
  battleGhosts?: BattleGhost[];
  battlePaths?: BattlePath[];
  battleConflictPoints?: TerrainMapPoint[];
  // When set, the selected unit's rotation handle pivots the Move draft facing
  // instead of the scenario geometry (the battle never moves units).
  battleRotateUnitId?: string | null;
  onBattleRotate?: (facing: number) => void;
  // Placement refusals to highlight: every id the refused drop would conflict
  // with (the dragged unit plus every overlap partner). Display-only, like the
  // selection: the document keeps the last valid values.
  unitConflictIds?: string[];
  // Battle change highlights: the units the last resolved turn changed
  // (losses, cohesion, rout, flight, or destruction). Display-only amber
  // outlines, cleared when the next turn resolves.
  changedUnitIds?: string[];
  // Geometry commits. Each call is one undo step in the editor: dragging a
  // footprint commits its front-midpoint position, dragging the round handle
  // commits the facing. A refused drop commits nothing (the unit returns).
  onMoveUnit?: (id: string, position: { x: number; y: number }) => void;
  onRotateUnit?: (id: string, facing: number) => void;
}

function safeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function sideColor(sides: any[], unit: any): string {
  const key = unit?.side ?? unit?.sideId ?? unit?.sideName;
  const side = (sides || []).find(
    (entry) => entry && (entry.id === key || entry.name === key),
  );
  return side && side.color ? String(side.color) : '#666666';
}

function formatScaleLabel(lengthM: number): string {
  return lengthM >= 1000 ? `${lengthM / 1000} km` : `${lengthM} m`;
}

// Map buttons release focus on activation: Space-held panning must work
// right after clicking a control instead of re-triggering the focused button
// (keyboard activation itself still fires before focus is released).
function releaseFocus(event: { currentTarget: HTMLElement }): void {
  event.currentTarget.blur();
}

// Screen-space point (y down) for a client position over the SVG.
function clientToMap(
  svg: SVGSVGElement,
  clientX: number,
  clientY: number,
  battlefieldHeight: number,
): { x: number; y: number } | null {
  const matrix = svg.getScreenCTM();
  if (!matrix) return null;
  const local = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  return { x: local.x, y: battlefieldHeight - local.y };
}

interface PlacedUnit {
  unit: any;
  id: string;
  centre: { x: number; y: number };
  frontageM: number;
  depthM: number;
  facing: number;
  color: string;
  name: string;
  dims: string;
  mpp: number;
  selected: boolean;
  conflict: boolean;
  changed: boolean;
}

function escapeXml(value: string): string {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export default function BattlefieldMap({
  width,
  height,
  units = [],
  sides = [],
  selectedUnitId = null,
  onSelectUnit,
  terrainFeatures = [],
  selectedTerrainId = null,
  selectedVertexIndex = null,
  draft = null,
  refusal = null,
  terrainInteractive = false,
  onTerrainSelect,
  onTerrainClearSelection,
  onMapDraftPoint,
  onEdgeInsert,
  onVertexCommit,
  unitConflictIds = [],
  changedUnitIds = [],
  onMoveUnit,
  onRotateUnit,
  battleClickable = false,
  onBattleMapClick,
  battleGhosts = [],
  battlePaths = [],
  battleConflictPoints = [],
  battleRotateUnitId = null,
  onBattleRotate,
}: BattlefieldMapProps) {
  const safeW = safeDimension(width, FALLBACK_WIDTH);
  const safeH = safeDimension(height, FALLBACK_HEIGHT);
  const battlefield = useMemo(() => ({ width: safeW, height: safeH }), [safeW, safeH]);

  // Camera and display toggles. Display-only: nothing here reaches the
  // scenario document, so navigation is never dirty and never undoable.
  const [view, setView] = useState<MapView>(() => fitMapView(battlefield));
  const [tool, setTool] = useState<MapTool>('select');
  const [showGrid, setShowGrid] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [showContours, setShowContours] = useState(true);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; inside: boolean } | null>(null);
  const [viewportW, setViewportW] = useState(FALLBACK_VIEWPORT_W);
  // Live rotation preview (display-only): the facing under the pointer while a
  // rotation handle is dragged, plus whether snapping is disabled. Cleared on
  // drop, so the cursor readout falls back to coordinates.
  const [liveRotate, setLiveRotate] = useState<{ facing: number; free: boolean } | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const svgHolderRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // A click following a pan drag must not add a draft vertex or change the
  // terrain selection: the drag consumed the gesture.
  const suppressClickRef = useRef(false);
  // An in-progress vertex drag: pointer id, the dragged handle element for
  // the live preview, and the pending rounded map point committed on
  // pointerup. The document only changes on pointerup, so a refused move
  // keeps the old geometry and highlights the candidate.
  const vertexDragRef = useRef<{
    featureId: string;
    index: number;
    pointerId: number;
    startClient: { x: number; y: number };
    handle: SVGCircleElement | null;
    pending: TerrainMapPoint | null;
  } | null>(null);
  // Last-known cursor position in map metres, so the zoom control and the
  // +/- keys can anchor on the cursor (centre fallback) just like the wheel.
  const cursorAnchorRef = useRef<MapCentre | null>(null);

  // A new battlefield size refits the camera; every other prop change keeps it.
  const dimsKey = `${safeW}x${safeH}`;
  const prevDimsKey = useRef(dimsKey);
  useEffect(() => {
    if (prevDimsKey.current !== dimsKey) {
      prevDimsKey.current = dimsKey;
      setView(fitMapView(battlefield));
    }
  }, [dimsKey, battlefield]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (rect.width > 0) setViewportW(rect.width);
    };
    measure();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);

  const toMap = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgHolderRef.current;
      if (!svg) return null;
      return clientToMap(svg, clientX, clientY, safeH);
    },
    [safeH],
  );

  // Wheel zoom (non-passive so the page never scrolls under the map).
  useEffect(() => {
    const svg = svgHolderRef.current;
    if (!svg) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const cursorMap = clientToMap(svg, event.clientX, event.clientY, safeH);
      if (!cursorMap) return;
      // Ctrl+wheel (trackpad pinch) sends small deltas: same path, finer step.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      setView((current) => zoomViewAroundCursor(current, cursorMap, current.zoom * factor));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
    };
  }, [safeH]);

  // View-navigation shortcuts. Display-only: none of these mark the scenario
  // as unsaved or record an undo step. Letter shortcuts work from anywhere
  // except text fields (a focused button still leaves them available); Space
  // panning yields to focused buttons and fields so native activation wins.
  useEffect(() => {
    const isFormField = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      !!target.closest('input, textarea, select, [contenteditable="true"]');
    const isButton = (target: EventTarget | null) =>
      target instanceof HTMLElement && !!target.closest('button');
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !isFormField(event.target) && !isButton(event.target) && !event.repeat) {
        event.preventDefault();
        setSpaceHeld(true);
        return;
      }
      if (isFormField(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'v' || key === 'escape') {
        setTool('select');
      } else if (key === 'h') {
        setTool('hand');
      } else if (key === 'g') {
        setShowGrid((value) => !value);
      } else if (key === 'l') {
        setShowLabels((value) => !value);
      } else if (key === 'c') {
        setShowContours((value) => !value);
      } else if (key === '0') {
        setView(fitMapView(battlefield));
      } else if (key === '+' || key === '=') {
        setView((current) =>
          zoomViewAroundCursor(current, cursorAnchorRef.current ?? current.center, current.zoom * ZOOM_STEP),
        );
      } else if (key === '-' || key === '_') {
        setView((current) =>
          zoomViewAroundCursor(current, cursorAnchorRef.current ?? current.center, current.zoom / ZOOM_STEP),
        );
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') setSpaceHeld(false);
    };
    const onBlur = () => setSpaceHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, [battlefield]);

  const zoom = clampMapZoom(view?.zoom);
  const box = mapViewBox(view, battlefield);
  const viewBox = `${box.x} ${box.y} ${box.width} ${box.height}`;
  const mpp = metresPerPixel(view, battlefield, viewportW > 0 ? viewportW : FALLBACK_VIEWPORT_W);
  const scaleLengthM = niceScaleBarMetres(mpp, 120);
  const scaleWidthPx = Math.max(8, scaleLengthM / mpp);

  const placed: PlacedUnit[] = useMemo(() => {
    const list = Array.isArray(units) ? units : [];
    const out: PlacedUnit[] = [];
    for (const unit of list) {
      const position = unitPosition(unit);
      const footprint = unitFootprint(unit);
      if (!position || !footprint) continue;
      const name = escapeXml(String(unit?.name || 'Unit'));
      const id = String(unit?.id ?? '');
      out.push({
        unit,
        id,
        centre: toScreenPoint(position, safeH),
        frontageM: footprint.frontageM,
        depthM: footprint.depthM,
        facing: unitFacingDeg(unit),
        color: sideColor(sides, unit),
        name,
        dims: `${Math.round(footprint.frontageM)} × ${Math.round(footprint.depthM)} m`,
        mpp,
        selected: selectedUnitId != null && id !== '' && id === String(selectedUnitId),
        conflict: id !== '' && (unitConflictIds || []).includes(id),
        changed: id !== '' && (changedUnitIds || []).includes(id),
      });
    }
    return out;
  }, [units, sides, safeH, mpp, selectedUnitId, unitConflictIds, changedUnitIds]);

  const cursorText = liveRotate
    ? liveRotate.free
      ? `Facing ${liveRotate.facing.toFixed(1)}° (free rotation)`
      : `Facing ${liveRotate.facing.toFixed(0)}° (snaps to ${FACING_SNAP_DEG}°, hold Shift for free)`
    : cursor
      ? `X ${cursor.x.toFixed(1)} m · Y ${cursor.y.toFixed(1)} m${cursor.inside ? '' : ' · outside'}`
      : 'X — · Y —';

  const handActive = tool === 'hand' || spaceHeld;

  return (
    <div
      ref={viewportRef}
      data-testid="map-viewport"
      className={`map-viewport${tool === 'hand' ? ' tool-hand' : ''}${spaceHeld ? ' space-pan' : ''}${panning ? ' panning' : ''}${draft ? ' drafting' : ''}`}
      onPointerDown={(event) => {
        // Dragging a vertex moves it; the pointerup commits one undo step,
        // and a refused move highlights the candidate and keeps the old
        // geometry. No vertex drags while drawing: every click adds a vertex.
        const vertexHandle =
          event.target instanceof Element
            ? event.target.closest('[data-vertex-index]')
            : null;
        if (
          vertexHandle &&
          !draft &&
          terrainInteractive &&
          !handActive &&
          event.button === 0 &&
          !event.ctrlKey &&
          !event.metaKey &&
          !event.altKey
        ) {
          const dataset = (vertexHandle as HTMLElement).dataset;
          if (dataset.featureId !== undefined && dataset.vertexIndex !== undefined) {
            event.preventDefault();
            vertexDragRef.current = {
              featureId: dataset.featureId,
              index: Number(dataset.vertexIndex),
              pointerId: event.pointerId,
              startClient: { x: event.clientX, y: event.clientY },
              handle: vertexHandle as SVGCircleElement,
              pending: null,
            };
            try {
              svgHolderRef.current?.setPointerCapture?.(event.pointerId);
            } catch {
              // Pointer capture is best-effort; dragging still works without it.
            }
            return;
          }
        }
        // While drawing, left clicks add draft vertices instead of panning;
        // Space-held and middle-button pans still work.
        if (draft && event.button === 0 && !spaceHeld) return;
        if (event.button === 1 || handActive) {
          if (event.button !== 0 && event.button !== 1) return;
          event.preventDefault();
          panRef.current = { x: event.clientX, y: event.clientY, moved: false };
          try {
            (event.target as Element)?.setPointerCapture?.(event.pointerId);
          } catch {
            // Pointer capture is best-effort; dragging still works without it.
          }
          setPanning(true);
        }
      }}
      onPointerMove={(event) => {
        const point = toMap(event.clientX, event.clientY);
        if (point) {
          const inside =
            point.x >= 0 && point.x <= safeW && point.y >= 0 && point.y <= safeH;
          // The rail and zoom controls overlay the viewport: only the SVG
          // scene itself refreshes the zoom anchor, so moving the pointer
          // onto a button never re-anchors the zoom onto the control.
          const svg = svgHolderRef.current;
          if (svg && event.target instanceof Element && svg.contains(event.target)) {
            cursorAnchorRef.current = { x: point.x, y: point.y };
          }
          setCursor({ x: point.x, y: point.y, inside });
        } else {
          setCursor(null);
        }
        const drag = vertexDragRef.current;
        if (drag && event.pointerId === drag.pointerId) {
          if (
            Math.hypot(
              event.clientX - drag.startClient.x,
              event.clientY - drag.startClient.y,
            ) <= 4
          ) {
            return;
          }
          const mapPoint = toMap(event.clientX, event.clientY);
          if (mapPoint) {
            const pending = { x: round1(mapPoint.x), y: round1(mapPoint.y) };
            drag.pending = pending;
            // Move the handle under the pointer without re-rendering: the
            // document only changes on pointerup.
            drag.handle?.setAttribute('cx', String(pending.x));
            drag.handle?.setAttribute('cy', String(safeH - pending.y));
          }
          return;
        }
        if (panRef.current) {
          const start = panRef.current;
          const dxPx = event.clientX - start.x;
          const dyPx = event.clientY - start.y;
          if (Math.abs(dxPx) + Math.abs(dyPx) > 0) start.moved = true;
          panRef.current = { x: event.clientX, y: event.clientY, moved: start.moved };
          setView((current) => ({
            ...current,
            ...panMapViewByPixels(current, dxPx, dyPx, mpp),
          }));
        }
      }}
      onPointerUp={(event) => {
        const drag = vertexDragRef.current;
        if (drag && event.pointerId === drag.pointerId) {
          vertexDragRef.current = null;
          // The pointerup after a vertex gesture must not also add a draft
          // vertex or reselect through the click handler.
          suppressClickRef.current = true;
          if (drag.pending) {
            onVertexCommit?.(drag.featureId, drag.index, drag.pending);
          } else {
            onTerrainSelect?.(drag.featureId, drag.index);
          }
          return;
        }
        if (panRef.current?.moved) suppressClickRef.current = true;
        panRef.current = null;
        setPanning(false);
      }}
      onPointerCancel={() => {
        vertexDragRef.current = null;
        panRef.current = null;
        setPanning(false);
      }}
      onPointerLeave={() => {
        if (!panRef.current) {
          setCursor(null);
          cursorAnchorRef.current = null;
        }
      }}
    >
      <BattlefieldSvg
        safeW={safeW}
        safeH={safeH}
        viewBox={viewBox}
        zoom={zoom}
        showGrid={showGrid}
        showLabels={showLabels}
        showContours={showContours}
        mpp={mpp}
        placed={placed}
        svgRef={svgHolderRef}
        selectionEnabled={!handActive && !panning}
        onSelectUnit={onSelectUnit}
        terrainFeatures={terrainFeatures}
        selectedTerrainId={selectedTerrainId}
        selectedVertexIndex={selectedVertexIndex}
        draft={draft}
        refusal={refusal}
        onSvgClick={(event) => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          if (event.ctrlKey || event.metaKey || event.altKey) return;
          const target = event.target instanceof Element ? event.target : null;
          // Battle drafting: a click on open ground (never on a unit, whose
          // pointer gesture already selected it) appends a leg point to the
          // active Move draft.
          if (battleClickable && !draft) {
            if (target?.closest('[data-rotate-handle],[data-testid="map-unit"]')) return;
            const svg = svgHolderRef.current;
            if (!svg) return;
            const cursorMap = clientToMap(svg, event.clientX, event.clientY, safeH);
            if (cursorMap) onBattleMapClick?.(cursorMap);
            return;
          }
          if (draft) {
            // Handles have their own pointer handlers; anywhere else on the
            // map adds a vertex.
            if (target?.closest('[data-vertex-index],[data-edge-index]')) return;
            const svg = svgHolderRef.current;
            if (!svg) return;
            const cursorMap = clientToMap(svg, event.clientX, event.clientY, safeH);
            if (cursorMap) onMapDraftPoint?.(cursorMap);
            return;
          }
          if (!terrainInteractive) return;
          const edge = target?.closest('[data-edge-index]');
          if (edge) {
            const dataset = (edge as HTMLElement).dataset;
            if (dataset.featureId !== undefined && dataset.edgeIndex !== undefined) {
              onEdgeInsert?.(dataset.featureId, Number(dataset.edgeIndex));
            }
            return;
          }
          const vertex = target?.closest('[data-vertex-index]');
          if (vertex) {
            const dataset = (vertex as HTMLElement).dataset;
            if (dataset.featureId !== undefined && dataset.vertexIndex !== undefined) {
              onTerrainSelect?.(dataset.featureId, Number(dataset.vertexIndex));
            }
            return;
          }
          const feature = target?.closest('[data-feature-id]');
          if (feature) {
            const id = (feature as HTMLElement).dataset?.featureId;
            if (id) onTerrainSelect?.(id);
            return;
          }
          onTerrainClearSelection?.();
        }}
        onMoveUnit={onMoveUnit}
        onRotateUnit={onRotateUnit}
        onPreviewRotate={setLiveRotate}
        battleRotateUnitId={battleRotateUnitId}
        onBattleRotate={onBattleRotate}
        battleGhosts={battleGhosts}
        battlePaths={battlePaths}
        battleConflictPoints={battleConflictPoints}
      />
      {draft ? (
        <p className="map-terrain-hint" role="status" data-testid="map-terrain-hint">
          Drawing{' '}
          {draft.kind === 'linear'
            ? LINEAR_LABELS[draft.category] || draft.category
            : draft.kind === 'elevation'
              ? 'hill'
              : draft.category}{' '}
          · {draft.points.length} {draft.points.length === 1 ? 'vertex' : 'vertices'} · click the
          map, Enter finishes, Esc cancels
        </p>
      ) : null}
      <div className="map-tool-rail" role="toolbar" aria-label="Map tools">
        <button
          type="button"
          className={tool === 'select' ? 'map-tool active' : 'map-tool'}
          data-testid="map-tool-select"
          aria-pressed={tool === 'select'}
          title="Select (V)"
          onClick={(event) => {
            releaseFocus(event);
            setTool('select');
          }}
        >
          Select
        </button>
        <button
          type="button"
          className={tool === 'hand' ? 'map-tool active' : 'map-tool'}
          data-testid="map-tool-hand"
          aria-pressed={tool === 'hand'}
          title="Hand: drag to pan (H, or hold Space)"
          onClick={(event) => {
            releaseFocus(event);
            setTool('hand');
          }}
        >
          Hand
        </button>
      </div>
      <div className="map-display-tools" role="toolbar" aria-label="Map display">
        <button
          type="button"
          className={showGrid ? 'map-tool active' : 'map-tool'}
          data-testid="toggle-grid"
          aria-pressed={showGrid}
          title="Toggle display-only grid (G)"
          onClick={(event) => {
            releaseFocus(event);
            setShowGrid((value) => !value);
          }}
        >
          Grid
        </button>
        <button
          type="button"
          className={showLabels ? 'map-tool active' : 'map-tool'}
          data-testid="toggle-labels"
          aria-pressed={showLabels}
          title="Toggle unit labels (L)"
          onClick={(event) => {
            releaseFocus(event);
            setShowLabels((value) => !value);
          }}
        >
          Labels
        </button>
        <button
          type="button"
          className={showContours ? 'map-tool active' : 'map-tool'}
          data-testid="toggle-contours"
          aria-pressed={showContours}
          title="Toggle elevation contours (C)"
          onClick={(event) => {
            releaseFocus(event);
            setShowContours((value) => !value);
          }}
        >
          Contours
        </button>
      </div>
      <div className="map-bottom-left">
        <span className="map-scale" aria-label="Scale bar">
          <span data-testid="scale-bar" id="scale-bar" style={{ width: `${scaleWidthPx}px` }} />
          <span data-testid="scale-bar-label" id="scale-bar-label">
            {formatScaleLabel(scaleLengthM)}
          </span>
        </span>
        <span
          data-testid="cursor-coords"
          id="cursor-coords"
          className={`cursor-coords${cursor && !cursor.inside ? ' outside' : ''}`}
          aria-label="Cursor coordinates in metres"
        >
          {cursorText}
        </span>
      </div>
      <div className="map-zoom-control" role="group" aria-label="Zoom">
        <button
          type="button"
          className="map-tool"
          data-testid="zoom-out"
          aria-label="Zoom out (−)"
          onClick={(event) => {
            releaseFocus(event);
            setView((current) =>
              zoomViewAroundCursor(current, cursorAnchorRef.current ?? current.center, current.zoom / ZOOM_STEP),
            );
          }}
        >
          −
        </button>
        <span data-testid="map-zoom-level" id="zoom-level" aria-live="off">
          {Math.round(zoom * 100)}%
        </span>
        <button
          type="button"
          className="map-tool"
          data-testid="zoom-in"
          aria-label="Zoom in (+)"
          onClick={(event) => {
            releaseFocus(event);
            setView((current) =>
              zoomViewAroundCursor(current, cursorAnchorRef.current ?? current.center, current.zoom * ZOOM_STEP),
            );
          }}
        >
          +
        </button>
        <button
          type="button"
          className="map-tool"
          data-testid="fit-view"
          aria-label="Fit battlefield (0)"
          title="Fit to battlefield (0)"
          onClick={(event) => {
            releaseFocus(event);
            setView(fitMapView(battlefield));
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}

interface BattlefieldSvgProps {
  safeW: number;
  safeH: number;
  viewBox: string;
  zoom: number;
  showGrid: boolean;
  showLabels: boolean;
  showContours: boolean;
  mpp: number;
  placed: PlacedUnit[];
  svgRef: RefObject<SVGSVGElement | null>;
  selectionEnabled: boolean;
  onSelectUnit?: (id: string | null) => void;
  terrainFeatures: any[];
  selectedTerrainId: string | null;
  selectedVertexIndex: number | null;
  draft: TerrainDraftShape | null;
  refusal: TerrainRefusalShape | null;
  onSvgClick: (event: ReactMouseEvent<SVGSVGElement>) => void;
  onMoveUnit?: (id: string, position: { x: number; y: number }) => void;
  onRotateUnit?: (id: string, facing: number) => void;
  onPreviewRotate?: (preview: { facing: number; free: boolean } | null) => void;
  battleRotateUnitId?: string | null;
  onBattleRotate?: (facing: number) => void;
  battleGhosts?: BattleGhost[];
  battlePaths?: BattlePath[];
  battleConflictPoints?: TerrainMapPoint[];
}

// A map pointer gesture: dragging a true-scale footprint moves it, dragging
// the selected unit's round handle rotates it about the front midpoint.
// Transient pointer state only: the document changes once, on drop, through
// onMoveUnit/onRotateUnit, so a drag is one undo step and a refused drop
// returns the unit to its stored values.
interface UnitGesture {
  kind: 'move' | 'rotate';
  unitId: string;
  startClient: { x: number; y: number };
  startMap: { x: number; y: number };
  origin: { x: number; y: number };
  moved: boolean;
  preview?: { x: number; y: number };
  previewFacing?: number;
}

// The scene, memoised so cursor-readout updates (which only touch the HTML
// overlays) do not rebuild the SVG. The labels toggle only flips the labels
// layer between shown and hidden: display-only, never the document.
const GROUND_FILLS: Record<string, { fill: string; stroke: string; label: string }> = {
  forest: { fill: '#aebc9c', stroke: '#93a582', label: 'Forest' },
  rough: { fill: '#d8d2b8', stroke: '#a89f83', label: 'Rough ground' },
  water: { fill: '#b3cece', stroke: '#92b2b0', label: 'Water' },
  settlement: { fill: '#d8cbb2', stroke: '#a08c66', label: 'Settlement' },
};

// Rivers and roads draw as true-scale polylines: the stroke width is the
// stored width in metres, so what is drawn is what counts.
const LINEAR_COLORS: Record<string, string> = {
  river: '#7fb3c8',
  road: '#c9b98f',
};

const LINEAR_LABELS: Record<string, string> = {
  river: 'River',
  road: 'Road',
};

const BattlefieldSvg = memo(function BattlefieldSvg({
  showLabels,
  showContours,
  mpp,
  svgRef,
  safeW,
  safeH,
  viewBox,
  zoom,
  showGrid,
  placed,
  selectionEnabled,
  onSelectUnit,
  terrainFeatures,
  selectedTerrainId,
  selectedVertexIndex,
  draft,
  refusal,
  onSvgClick,
  onMoveUnit,
  onRotateUnit,
  onPreviewRotate,
  battleRotateUnitId = null,
  onBattleRotate,
  battleGhosts = [],
  battlePaths = [],
  battleConflictPoints = [],
}: BattlefieldSvgProps) {
  // Battle draft overlays in true scale: ghost footprints for accepted drafts,
  // leg paths for every draft, and conflict markers from rejection details.
  const battleOverlays = useMemo(() => {
    let out = '';
    for (const ghost of battleGhosts) {
      if (!ghost || !Array.isArray(ghost.corners) || ghost.corners.length < 3) {
        continue;
      }
      const line = ghost.corners.map((point) => `${point.x},${safeH - point.y}`).join(' ');
      out += `<polygon points="${line}" fill="#4e6047" fill-opacity="0.14" stroke="#4e6047" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}" data-testid="draft-ghost" data-ghost-unit="${escapeXml(ghost.unitId)}"><title>Ghost: ${escapeXml(ghost.unitId)} Move preview</title></polygon>`;
    }
    for (const path of battlePaths) {
      const points = Array.isArray(path?.points) ? path.points : [];
      if (points.length < 2) {
        continue;
      }
      const line = points.map((point) => `${point.x},${safeH - point.y}`).join(' ');
      const color = path.rejected ? '#b91c1c' : '#4e6047';
      const dash = path.rejected
        ? `${(3 * mpp).toFixed(1)} ${(3 * mpp).toFixed(1)}`
        : `${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}`;
      out += `<polyline points="${line}" fill="none" stroke="${color}" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${dash}" data-testid="draft-path"><title>${escapeXml(path.label || 'Leg')}</title></polyline>`;
      out += points
        .slice(1)
        .map(
          (stop, legIndex) =>
            `<circle cx="${stop.x}" cy="${(safeH - stop.y).toFixed(1)}" r="${(5 * mpp).toFixed(2)}" fill="${color}" stroke="#f8f9f0" stroke-width="${(1.5 * mpp).toFixed(2)}" data-testid="draft-vertex"><title>${escapeXml(path.label || 'Leg')} ${legIndex + 1} · (${stop.x.toFixed(1)}, ${stop.y.toFixed(1)})</title></circle>`,
        )
        .join('');
    }
    return out;
  }, [battleGhosts, battlePaths, safeH, mpp]);

  const battleMarkers = useMemo(() => {
    let out = '';
    for (const point of battleConflictPoints) {
      if (!point || !Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
        continue;
      }
      out += `<circle cx="${point.x}" cy="${safeH - point.y}" r="${(8 * mpp).toFixed(2)}" fill="none" stroke="#b91c1c" stroke-width="${(2.5 * mpp).toFixed(2)}" data-testid="conflict-marker"><title>Conflict at (${point.x.toFixed(1)}, ${point.y.toFixed(1)})</title></circle>`;
    }
    return out;
  }, [battleConflictPoints, safeH, mpp]);
  // The live drag preview mutates the SVG transform directly (no re-render
  // per pointermove, so gestures stay smooth). Bumping dropSeq remounts the
  // units layer on drop, discarding the preview: a committed drop re-renders
  // from the new document, a refused one falls back to the stored values and
  // the unit visibly returns.
  const [dropSeq, setDropSeq] = useState(0);
  const gestureRef = useRef<UnitGesture | null>(null);
  const axisSize = 13 / zoom;
  const grid = useMemo(() => {
    const lines: string[] = [];
    for (let x = 0; x <= safeW; x += GRID_STEP_M) {
      const major = x % GRID_MAJOR_EVERY_M === 0;
      lines.push(
        `<line x1="${x}" y1="0" x2="${x}" y2="${safeH}" stroke="#7d8a76" stroke-width="${major ? 1.4 : 0.7}" opacity="${major ? 0.4 : 0.2}"/>`,
      );
    }
    for (let y = 0; y <= safeH; y += GRID_STEP_M) {
      const major = y % GRID_MAJOR_EVERY_M === 0;
      const screenY = safeH - y;
      lines.push(
        `<line x1="0" y1="${screenY}" x2="${safeW}" y2="${screenY}" stroke="#7d8a76" stroke-width="${major ? 1.4 : 0.7}" opacity="${major ? 0.4 : 0.2}"/>`,
      );
    }
    return lines.join('');
  }, [safeW, safeH]);

  const xLabels = useMemo(() => {
    let out = '';
    for (let x = 0; x <= safeW; x += AXIS_STEP_M) {
      out += `<text x="${x}" y="${safeH + 26 / zoom}" text-anchor="middle" font-size="${axisSize}" fill="#8a947c">${x}</text>`;
    }
    return out;
  }, [safeW, safeH, zoom, axisSize]);

  const yLabels = useMemo(() => {
    let out = '';
    for (let y = 0; y <= safeH; y += AXIS_STEP_M) {
      out += `<text x="${-16 / zoom}" y="${safeH - y + axisSize * 0.35}" text-anchor="end" font-size="${axisSize}" fill="#8a947c">${y}</text>`;
    }
    return out;
  }, [safeH, zoom, axisSize]);

  const origin = toScreenPoint({ x: 0, y: 0 }, safeH);
  const centre = toScreenPoint({ x: safeW / 2, y: safeH / 2 }, safeH);

  // Terrain in prototype variant A styling, drawn true to scale from the
  // stored vertices and always under the units. String-built like the grid
  // and unit layers; clicks delegate through data attributes.
  const terrain = useMemo(() => {
    const features = Array.isArray(terrainFeatures) ? terrainFeatures : [];
    const project = (points: TerrainMapPoint[]) =>
      points
        .map((point) => `${point.x},${safeH - point.y}`)
        .join(' ');
    let out = '';
    for (const feature of features) {
      if (!feature) {
        continue;
      }
      // A river or road is an open polyline drawn at true scale: the stroke
      // width is the stored width in metres, so the line covers exactly the
      // ground it claims. Rivers and roads may cross everything, so they are
      // never in conflict with another feature.
      if (feature.kind === 'linear') {
        if (!Array.isArray(feature.path) || feature.path.length < 2) {
          continue;
        }
        const line = project(feature.path as TerrainMapPoint[]);
        const id = escapeXml(String(feature.id ?? ''));
        const selected = feature.id === selectedTerrainId;
        const color = LINEAR_COLORS[feature.category] || '#888888';
        const widthM = Number(feature.width);
        const label = `${LINEAR_LABELS[feature.category] || 'River or road'} · ${escapeXml(String(feature.width))} m`;
        const halo = selected
          ? `<polyline points="${line}" fill="none" stroke="#4e6047" stroke-width="${(Number.isFinite(widthM) ? widthM : 0) + 6 * mpp}" opacity="0.35" stroke-linecap="round" stroke-linejoin="round" class="terrain-linear-halo"/>`
          : '';
        out += `${halo}<polyline points="${line}" fill="none" stroke="${color}" stroke-width="${Number.isFinite(widthM) ? widthM : 2}" stroke-linecap="round" stroke-linejoin="round" data-feature-id="${id}" data-testid="terrain-linear"><title>${label}</title></polyline>`;
        continue;
      }
      if (feature.kind !== 'ground' && feature.kind !== 'elevation') {
        continue;
      }
      if (!Array.isArray(feature.polygon) || feature.polygon.length < 3) {
        continue;
      }
      const ring = feature.polygon as TerrainMapPoint[];
      const line = project(ring);
      const id = escapeXml(String(feature.id ?? ''));
      const selected = feature.id === selectedTerrainId;
      const conflict =
        refusal?.conflictId !== undefined &&
        refusal?.conflictId !== null &&
        feature.id === refusal.conflictId;
      const screen = ring.map((point) => ({ x: point.x, y: safeH - point.y }));
      const cx = screen.reduce((sum, point) => sum + point.x, 0) / screen.length;
      const cy = screen.reduce((sum, point) => sum + point.y, 0) / screen.length;
      const selectedHalo = selected
        ? `<polygon points="${line}" fill="none" stroke="#9b7538" stroke-width="3" stroke-dasharray="7 5"/>`
        : '';
      if (feature.kind === 'ground') {
        const style = GROUND_FILLS[feature.category] || {
          fill: '#cccccc',
          stroke: '#999999',
          label: String(feature.category || 'Ground cover'),
        };
        const outline = conflict ? '#b76e5a' : style.stroke;
        let art = `<polygon points="${line}" fill="${style.fill}" fill-opacity="0.85" stroke="${outline}" stroke-width="${selected || conflict ? 3 : 1.5}"><title>${escapeXml(style.label)} area</title></polygon>`;
        if (feature.category === 'forest') {
          const minX = Math.min(...screen.map((point) => point.x));
          const maxX = Math.max(...screen.map((point) => point.x));
          const minY = Math.min(...screen.map((point) => point.y));
          const maxY = Math.max(...screen.map((point) => point.y));
          let trees = '';
          for (let y = minY + 10; y < maxY; y += 21) {
            for (let x = minX + 10; x < maxX; x += 22) {
              const ox = Math.sin(x + y) * 5;
              const oy = Math.cos(x * y) * 5;
              trees += `<use href="#polis-tree" x="${(x + ox).toFixed(1)}" y="${(y + oy).toFixed(1)}" opacity="${(0.55 + 0.2 * Math.sin(x)).toFixed(2)}"/>`;
            }
          }
          art += `<defs><clipPath id="clip-${id}"><polygon points="${line}"/></clipPath></defs><g clip-path="url(#clip-${id})">${trees}</g>`;
        } else if (feature.category === 'rough') {
          art = `<polygon points="${line}" fill="url(#polis-rough)" stroke="${conflict ? '#b76e5a' : '#b5ab93'}" stroke-width="${selected || conflict ? 3 : 1.5}"><title>Rough ground area</title></polygon>`;
        } else if (feature.category === 'water') {
          art += `<polygon points="${line}" fill="url(#polis-water)"><title>Water area</title></polygon>`;
        } else if (feature.category === 'settlement') {
          let houses = '';
          for (let row = 0; row < 3; row += 1) {
            for (let col = 0; col < 3; col += 1) {
              const hx = cx + (col - 1) * 34 + (row % 2) * 7;
              const hy = cy + (row - 1) * 27;
              const tilt = (col + row) % 2 === 0 ? 12 : -10;
              houses += `<g transform="translate(${hx.toFixed(1)} ${hy.toFixed(1)}) rotate(${tilt})"><rect x="-12" y="-7" width="26" height="19" fill="#a69a7c" opacity=".2"/><rect x="-13" y="-11" width="24" height="16" fill="#c6b89e" stroke="#9b8c73"/><path d="m-15-11 14-8 15 8-14 7z" fill="#b68e6f" stroke="#a08263" stroke-width=".7"/></g>`;
            }
          }
          art += `<defs><clipPath id="clip-${id}"><polygon points="${line}"/></clipPath></defs><g clip-path="url(#clip-${id})"><path d="M${(cx - 65).toFixed(1)},${(cy + 40).toFixed(1)}l140,-70M${(cx - 30).toFixed(1)},${(cy - 65).toFixed(1)}l55,125" fill="none" stroke="#c1b699" stroke-width="8"/>${houses}</g>`;
        }
        out += `<g data-feature-id="${id}" data-testid="terrain-ground">${art}${selectedHalo}</g>`;
      } else {
        const level = feature.level;
        const outline = conflict ? '#b76e5a' : '#8a7a5c';
        let rings = '';
        if (showContours) {
          for (let i = 0; i < 6; i += 1) {
            const scale = 1 - i * 0.135;
            rings += `<polygon points="${line}" transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) scale(${scale.toFixed(3)}) translate(${(-cx).toFixed(1)} ${(-cy).toFixed(1)})" fill="${i === 5 ? '#b7bc93' : 'none'}" fill-opacity=".22" stroke="#a8ad85" stroke-width="1.2" opacity="${(0.5 + i * 0.06).toFixed(2)}"/>`;
          }
        }
        out += `<g data-feature-id="${id}" data-testid="terrain-hill"><polygon points="${line}" fill="#c6c8a4" fill-opacity=".31" stroke="${outline}" stroke-width="${selected || conflict ? 3 : 1.5}" stroke-dasharray="7 4"><title>Hill · level ${escapeXml(String(level))} (derived from nesting)</title></polygon>${rings}<text x="${cx.toFixed(1)}" y="${(cy + 4).toFixed(1)}" text-anchor="middle" font-size="${(13 / zoom).toFixed(2)}" fill="#6b6247" pointer-events="none">L${escapeXml(String(level))}</text>${selectedHalo}</g>`;
      }
    }
    if (refusal && Array.isArray(refusal.ring) && refusal.ring.length >= 2) {
      const label = escapeXml(refusal.reason || 'Refused shape');
      // A refused river or road is an open line, never a closed shape.
      if (refusal.kind === 'linear' || refusal.ring.length === 2) {
        out += `<polyline points="${project(refusal.ring)}" fill="none" stroke="#b76e5a" stroke-width="${(2.5 * mpp).toFixed(2)}" stroke-dasharray="${(8 * mpp).toFixed(1)} ${(5 * mpp).toFixed(1)}" class="terrain-refused" data-testid="terrain-refusal-shape"><title>${label}</title></polyline>`;
      } else {
        out += `<polygon points="${project(refusal.ring)}" fill="#b76e5a" fill-opacity="0.35" stroke="#b76e5a" stroke-width="${(2.5 * mpp).toFixed(2)}" stroke-dasharray="${(8 * mpp).toFixed(1)} ${(5 * mpp).toFixed(1)}" class="terrain-refused" data-testid="terrain-refusal-shape"><title>${label}</title></polygon>`;
      }
    }
    if (draft && Array.isArray(draft.points) && draft.points.length > 0) {
      const line = project(draft.points);
      const isLinearDraft = draft.kind === 'linear';
      const fill =
        !isLinearDraft && draft.points.length >= 3
          ? `<polygon points="${line}" fill="#4e6047" fill-opacity="0.12" stroke="#4e6047" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}" data-testid="terrain-draft"/>`
          : `<polyline points="${line}" fill="none" stroke="#4e6047" stroke-width="${(2 * mpp).toFixed(2)}" stroke-dasharray="${(7 * mpp).toFixed(1)} ${(4 * mpp).toFixed(1)}" data-testid="terrain-draft"/>`;
      out +=
        fill +
        draft.points
          .map((point) => {
            const sx = point.x;
            const sy = safeH - point.y;
            return `<circle cx="${sx}" cy="${sy}" r="${(5 * mpp).toFixed(2)}" fill="#4e6047" stroke="#f4f3e9" stroke-width="${(1.5 * mpp).toFixed(2)}" class="terrain-draft-vertex"/>`;
          })
          .join('');
    }
    const selected = features.find(
      (feature) =>
        feature?.id === selectedTerrainId &&
        (((feature.kind === 'ground' || feature.kind === 'elevation') &&
          Array.isArray(feature.polygon) &&
          feature.polygon.length >= 3) ||
          (feature.kind === 'linear' &&
            Array.isArray(feature.path) &&
            feature.path.length >= 2)),
    );
    if (selected && !draft) {
      const isLinear = selected.kind === 'linear';
      const ring = (isLinear ? selected.path : selected.polygon) as TerrainMapPoint[];
      const handleStroke = isLinear ? '#7fa8c9' : '#4e6047';
      // Edges of a river or road run between consecutive vertices only; a
      // polygon's last edge wraps back to its first vertex.
      const edges = isLinear ? ring.length - 1 : ring.length;
      for (let index = 0; index < edges; index += 1) {
        const point = ring[index];
        const edge = ring[(index + 1) % ring.length];
        const mid = { x: (point.x + edge.x) / 2, y: (point.y + edge.y) / 2 };
        out += `<circle cx="${mid.x.toFixed(1)}" cy="${(safeH - mid.y).toFixed(1)}" r="${(4 * mpp).toFixed(2)}" fill="#faf9f4" stroke="${handleStroke}" stroke-width="${(1.5 * mpp).toFixed(2)}" stroke-dasharray="${(3 * mpp).toFixed(1)} ${(2 * mpp).toFixed(1)}" class="terrain-edge-handle" data-testid="terrain-edge-handle" data-edge-index="${index}" data-feature-id="${escapeXml(String(selected.id))}"><title>Insert a vertex here</title></circle>`;
      }
      out += ring
        .map((point, index) => {
          const active = index === selectedVertexIndex;
          return `<circle cx="${point.x}" cy="${safeH - point.y}" r="${((active ? 7 : 6) * mpp).toFixed(2)}" fill="${active ? handleStroke : '#faf9f4'}" stroke="${handleStroke}" stroke-width="${(2 * mpp).toFixed(2)}" class="terrain-vertex${active ? ' selected' : ''}" data-testid="terrain-vertex-handle" data-vertex-index="${index}" data-feature-id="${escapeXml(String(selected.id))}"><title>Vertex ${index + 1}: drag to move, Delete removes it</title></circle>`;
        })
        .join('');
    }
    return out;
  }, [terrainFeatures, selectedTerrainId, selectedVertexIndex, draft, refusal, showContours, safeH, zoom, mpp]);
  // Map metres (y up) for a client position over the SVG.
  const toMapMetres = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return null;
      return clientToMap(svg, clientX, clientY, safeH);
    },
    [svgRef, safeH],
  );

  function entryById(unitId: string): PlacedUnit | undefined {
    return placed.find((item) => item.id === unitId);
  }

  function queryUnitNode(svg: SVGSVGElement, unitId: string): SVGGElement | null {
    try {
      return svg.querySelector(`g[data-testid="map-unit"][data-unit-id="${CSS.escape(unitId)}"]`);
    } catch {
      return null;
    }
  }

  function capturePointer(svg: SVGSVGElement, pointerId: number) {
    try {
      svg.setPointerCapture(pointerId);
    } catch {
      // Pointer capture is best-effort; dragging still works without it.
    }
  }

  // Select-tool unit interaction: the rotation handle first, then the real
  // footprint with no tolerance (the pointer already hit the true-scale
  // rectangle). Anything else (empty ground, labels outside the footprint)
  // starts no drag. Panning (hand tool, Space, middle button) always wins:
  // selectionEnabled is already false then.
  function beginUnitGesture(event: React.PointerEvent<SVGSVGElement>) {
    if (!selectionEnabled) return;
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey) return;
    const svg = svgRef.current;
    if (!svg) return;
    const target = event.target as Element | null;
    const handle = target?.closest?.('[data-rotate-handle]');
    const handleId = handle?.getAttribute?.('data-rotate-handle');
    if (handle && handleId) {
      const entry = entryById(handleId);
      const originPoint = entry ? unitPosition(entry.unit) : null;
      if (!entry || !originPoint) return;
      event.preventDefault();
      gestureRef.current = {
        kind: 'rotate',
        unitId: handleId,
        startClient: { x: event.clientX, y: event.clientY },
        startMap: { x: 0, y: 0 },
        origin: originPoint,
        moved: false,
      };
      capturePointer(svg, event.pointerId);
      return;
    }
    const holder = target?.closest?.('[data-testid="map-unit"]');
    const unitId = holder?.getAttribute?.('data-unit-id');
    if (!unitId) return;
    const entry = entryById(unitId);
    const originPoint = entry ? unitPosition(entry.unit) : null;
    const cursor = toMapMetres(event.clientX, event.clientY);
    if (!entry || !originPoint || !cursor) return;
    event.preventDefault();
    gestureRef.current = {
      kind: 'move',
      unitId,
      startClient: { x: event.clientX, y: event.clientY },
      startMap: cursor,
      origin: originPoint,
      moved: false,
    };
    capturePointer(svg, event.pointerId);
  }

  function updateUnitGesture(event: React.PointerEvent<SVGSVGElement>) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (
      !gesture.moved &&
      Math.hypot(event.clientX - gesture.startClient.x, event.clientY - gesture.startClient.y) <= 4
    ) {
      return;
    }
    const svg = svgRef.current;
    if (!svg) return;
    if (!gesture.moved) {
      gesture.moved = true;
      svg.closest?.('.map-viewport')?.classList.add('unit-dragging');
      if (gesture.kind === 'move') {
        // Select on drag start without rebuilding the map mid-gesture: the
        // full render (including the rotation handle) happens on drop.
        onSelectUnit?.(gesture.unitId);
      }
    }
    const cursor = toMapMetres(event.clientX, event.clientY);
    if (!cursor) return;
    if (gesture.kind === 'move') {
      const preview = {
        x: gesture.origin.x + (cursor.x - gesture.startMap.x),
        y: gesture.origin.y + (cursor.y - gesture.startMap.y),
      };
      gesture.preview = preview;
      const node = queryUnitNode(svg, gesture.unitId);
      if (node) {
        const screen = toScreenPoint(preview, safeH);
        node.setAttribute('transform', `translate(${screen.x} ${screen.y})`);
      }
    } else {
      const dx = cursor.x - gesture.origin.x;
      const dy = cursor.y - gesture.origin.y;
      if (Math.hypot(dx, dy) <= 1e-9) return;
      const raw = (Math.atan2(dx, dy) * 180) / Math.PI;
      const free = event.shiftKey;
      const facing = free ? normalizeFacing(raw) : snapFacing(raw, FACING_SNAP_DEG);
      gesture.previewFacing = facing;
      onPreviewRotate?.({ facing, free });
      const node = queryUnitNode(svg, gesture.unitId);
      const rotor = node?.querySelector?.('.unit-rotor');
      if (rotor) {
        rotor.setAttribute('transform', `rotate(${facing})`);
      }
    }
  }

  function finishUnitGesture(commit: boolean) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    gestureRef.current = null;
    onPreviewRotate?.(null);
    svgRef.current?.closest?.('.map-viewport')?.classList.remove('unit-dragging');
    // Discard the live preview: a committed drop re-renders from the new
    // document, a refused (or cancelled) one falls back to the stored values
    // and the unit visibly returns.
    setDropSeq((value) => value + 1);
    if (!gesture.moved) {
      // Click: single selection. The pointerdown already hit-tested the real
      // footprint, so this is a true footprint click.
      if (gesture.kind === 'move') {
        onSelectUnit?.(gesture.unitId);
      }
      return;
    }
    if (!commit) return;
    if (gesture.kind === 'move' && gesture.preview) {
      onMoveUnit?.(gesture.unitId, gesture.preview);
    } else if (gesture.kind === 'rotate' && gesture.previewFacing !== undefined) {
      // A battle draft pivots the Move facing, never the scenario geometry:
      // the engine alone decides the draft through validation.
      if (battleRotateUnitId && gesture.unitId === battleRotateUnitId && onBattleRotate) {
        onBattleRotate(gesture.previewFacing);
      } else {
        onRotateUnit?.(gesture.unitId, gesture.previewFacing);
      }
    }
  }

  return (
    <svg
      id="battle-svg"
      ref={svgRef as Ref<SVGSVGElement>}
      data-testid="battlefield-map"
      data-width={safeW}
      data-height={safeH}
      data-zoom={String(zoom)}
      viewBox={viewBox}
      role="img"
      aria-label={`Battlefield, ${safeW} by ${safeH} metres, origin south-west`}
      onClick={onSvgClick}
      onPointerDown={beginUnitGesture}
      onPointerMove={updateUnitGesture}
      onPointerUp={() => finishUnitGesture(true)}
      onPointerCancel={() => finishUnitGesture(false)}
    >
      <defs>
        <pattern id="polis-rough" width="22" height="18" patternUnits="userSpaceOnUse">
          <rect width="22" height="18" fill="#d5cfb7" />
          <path d="m4 13 4-5 4 5zM16 3h3" fill="none" stroke="#a29b82" />
        </pattern>
        <pattern id="polis-water" width="32" height="22" patternUnits="userSpaceOnUse">
          <path d="M3 11q5-3 10 0t10 0" stroke="#d1e1db" fill="none" />
        </pattern>
        <g id="polis-tree">
          <path d="M10 9v12" stroke="#7a8969" stroke-width="1" />
          <ellipse cx="10" cy="10" rx="9" ry="8" fill="#7b956e" stroke="#6e8761" stroke-width=".7" />
          <path d="M5 8q5-6 10-1" stroke="#adba93" fill="none" stroke-width="1" />
        </g>
      </defs>
      <rect
        x={origin.x - 3000}
        y={origin.y - 3000}
        width={safeW + 6000}
        height={safeH + 6000}
        fill="#dfddce"
      />
      <rect x={0} y={0} width={safeW} height={safeH} fill="#e8e5d5" />
      <g data-testid="map-grid" style={{ display: showGrid ? 'block' : 'none' }}>
        <g dangerouslySetInnerHTML={{ __html: grid }} />
      </g>
      <rect
        x={0}
        y={0}
        width={safeW}
        height={safeH}
        fill="none"
        stroke="#6f7a65"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      <g data-testid="map-terrain" dangerouslySetInnerHTML={{ __html: terrain }} />
      <g dangerouslySetInnerHTML={{ __html: xLabels + yLabels }} />
      <g data-testid="map-battle-overlays" dangerouslySetInnerHTML={{ __html: battleOverlays }} />
      <g data-testid="map-units-group" key={`units-${dropSeq}`}>
        {placed.map((entry) => {
          const minEdgePx = Math.min(entry.frontageM, entry.depthM) / entry.mpp;
          const helperM = 16 * entry.mpp;
          const helperBox = Math.max(entry.frontageM, entry.depthM, helperM);
          const helperCy = entry.depthM / 2;
          const helper =
            minEdgePx < 10
              ? `<rect x="${-helperBox / 2}" y="${helperCy - helperBox / 2}" width="${helperBox}" height="${helperBox}" rx="${4 * entry.mpp}" fill="none" stroke="${entry.color}" stroke-width="${1.5 * entry.mpp}" stroke-dasharray="${6 * entry.mpp} ${4 * entry.mpp}" opacity="0.85"/>`
              : '';
          // A refused drop highlights every unit the refused placement would
          // conflict with (the dragged unit plus every overlap partner) in
          // red; the document keeps the last valid values throughout. A unit
          // the last resolved turn changed outlines in amber instead.
          const outline = entry.conflict ? '#b91c1c' : entry.changed ? '#b45309' : entry.color;
          const strokeW = (entry.selected || entry.conflict || entry.changed ? 3 : 1.6) * entry.mpp;
          const dash = entry.conflict
            ? ` stroke-dasharray="${7 * entry.mpp} ${4 * entry.mpp}"`
            : '';
          // Rotation handle for the selected unit: a stem forward of the front
          // edge with a grab circle, pivoting the footprint about the front
          // midpoint. Sizes scale with metres-per-pixel so the handle keeps a
          // constant screen size at any zoom.
          const reach = 20 * entry.mpp;
          const gripR = 7 * entry.mpp;
          const handle = entry.selected
            ? `<line x1="0" y1="0" x2="0" y2="${-reach}" stroke="${entry.color}" stroke-width="${1.6 * entry.mpp}" stroke-dasharray="${4 * entry.mpp} ${3 * entry.mpp}" class="rotate-stem" pointer-events="none"/>` +
              `<circle cx="0" cy="${-reach}" r="${12 * entry.mpp}" fill="transparent" class="rotate-hit" data-rotate-handle="${entry.id}" pointer-events="all"><title>Drag to rotate (snaps to ${FACING_SNAP_DEG}°, hold Shift for free rotation)</title></circle>` +
              `<circle cx="0" cy="${-reach}" r="${gripR}" fill="#f8f9f0" stroke="${entry.color}" stroke-width="${2 * entry.mpp}" class="rotate-grip" data-testid="rotate-handle" data-rotate-handle="${entry.id}"><title>Drag to rotate (snaps to ${FACING_SNAP_DEG}°, hold Shift for free rotation)</title></circle>`
            : '';
          const footprint =
            `<g class="unit-rotor" transform="rotate(${entry.facing})">${helper}` +
            `<rect x="${-entry.frontageM / 2}" y="0" width="${entry.frontageM}" height="${entry.depthM}" fill="${entry.color}" fill-opacity="0.32" stroke="${outline}" stroke-width="${strokeW}"${dash} class="unit-footprint" data-testid="unit-footprint"/>` +
            `<line x1="${-entry.frontageM / 2}" y1="0" x2="${entry.frontageM / 2}" y2="0" stroke="${outline}" stroke-width="${3 * entry.mpp}"/>${handle}</g>`;
          const unitId = entry.id;
          return (
            <g
              key={unitId || entry.name}
              transform={`translate(${entry.centre.x} ${entry.centre.y})`}
              className={`map-unit${entry.selected ? ' selected' : ''}${entry.conflict ? ' conflict' : ''}${entry.changed ? ' changed' : ''}`}
              data-testid="map-unit"
              data-unit-id={unitId}
              data-selected={entry.selected ? 'true' : 'false'}
              data-conflict={entry.conflict ? 'true' : 'false'}
              data-changed={entry.changed ? 'true' : 'false'}
              style={{ cursor: selectionEnabled ? 'pointer' : undefined }}
              dangerouslySetInnerHTML={{ __html: footprint }}
            />
          );
        })}
      </g>
      <g data-testid="map-conflict-markers" dangerouslySetInnerHTML={{ __html: battleMarkers }} />
      <g
        data-testid="map-unit-labels"
        style={{ display: showLabels ? 'block' : 'none' }}
      >
        {placed.map((entry) => {
          const labelSize = 13 / zoom;
          const dimsSize = 10.5 / zoom;
          const label =
            `<text x="0" y="${entry.depthM + 8 * entry.mpp + labelSize * 0.9}" text-anchor="middle" font-size="${labelSize}" class="unit-label">${entry.name}</text>` +
            `<text x="0" y="${entry.depthM + 8 * entry.mpp + labelSize * 0.9 + dimsSize * 1.25}" text-anchor="middle" font-size="${dimsSize}" class="unit-dims">${entry.dims}</text>`;
          return (
            <g
              key={String(entry.unit?.id ?? entry.name)}
              transform={`translate(${entry.centre.x} ${entry.centre.y})`}
              dangerouslySetInnerHTML={{ __html: label }}
            />
          );
        })}
      </g>
      <circle cx={origin.x} cy={origin.y} r={5 * mppOf(placed)} fill="#4e6047" />
      <text
        x={origin.x + 10 * mppOf(placed)}
        y={origin.y - 10 * mppOf(placed)}
        fontSize={axisSize}
        fill="#4e6047"
      >
        origin (0, 0) · SW
      </text>
      <text
        x={safeW - 14 / zoom}
        y={30 / zoom}
        textAnchor="end"
        fontSize={15 / zoom}
        fill="#6f7a65"
      >
        N ↑
      </text>
      {placed.length === 0 ? (
        <text
          x={centre.x}
          y={centre.y}
          textAnchor="middle"
          fontSize={17 / zoom}
          fill="#9aa08b"
        >
          Empty battlefield — no units yet
        </text>
      ) : null}
    </svg>
  );
});

function mppOf(placed: PlacedUnit[]): number {
  return placed.length > 0 && Number.isFinite(placed[0].mpp) ? placed[0].mpp : 1;
}
