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
import {
  UNIT_CARD_ESTIMATED_H,
  layoutUnitContextCard,
  projectUnitBounds,
} from '../domain/unit-card-geometry.js';

import {
  AXIS_STEP_M,
  FALLBACK_HEIGHT,
  FALLBACK_VIEWPORT_H,
  FALLBACK_VIEWPORT_W,
  FALLBACK_WIDTH,
  GRID_MAJOR_EVERY_M,
  GRID_STEP_M,
  UNIT_CARD_W,
  ZOOM_STEP,
  clientToMap,
  escapeXml,
  safeDimension,
  sideColor,
  type PlacedUnit,
} from './battlefield-map/map-helpers';
import { BattlefieldSvg } from './battlefield-map/battlefield-svg';
import { MapChrome } from './battlefield-map/map-chrome';

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
  kind?: string;
}

export interface BattlePath {
  points: TerrainMapPoint[];
  rejected: boolean;
  label: string;
}

export interface BattleShootLine {
  from: TerrainMapPoint;
  to: TerrainMapPoint;
  rejected: boolean;
  shooterId: string;
  targetId: string;
}

export interface BattleChargeCandidate {
  unitId: string;
  edge: string;
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
  battleShootLines?: BattleShootLine[];
  // Charge and shoot candidates for the selected unit (from the engine's
  // available actions): highlighted on the map; clicking one drafts the order.
  battleCandidateCharges?: BattleChargeCandidate[];
  battleCandidateShoots?: string[];
  battleConflictPoints?: TerrainMapPoint[];
  // When set, the selected unit's rotation handle pivots the Move draft facing
  // instead of the scenario geometry (the battle never moves units).
  battleRotateUnitId?: string | null;
  onBattleRotate?: (facing: number) => void;
  // Tethered unit context card (battle screen, issue #123): the read-only
  // status card for the selected active-side unit during a human Orders
  // phase. The battle screen owns visibility; the map projects the unit and
  // places the card beside it inside the viewport.
  unitCard?: { unit: any; movementAllowanceM?: number | null } | null;
  onCloseUnitCard?: () => void;
  unitCardDraft?: any | null;
  unitCardVerdict?: any | null;
  unitCardPresets?: Record<string, any> | null;
  unitCardPermitted?: string[];
  onStartReformDraft?: (unitId: string) => void;
  onApplyReformPreset?: (unitId: string, preset: string) => void;
  onStepReformFiles?: (unitId: string, delta: number) => void;
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

// Map helpers live in ./battlefield-map/map-helpers (pure move, no behaviour change).

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
  battleShootLines = [],
  battleCandidateCharges = [],
  battleCandidateShoots = [],
  battleConflictPoints = [],
  battleRotateUnitId = null,
  onBattleRotate,
  unitCard = null,
  onCloseUnitCard,
  unitCardDraft = null,
  unitCardVerdict = null,
  unitCardPresets = null,
  unitCardPermitted = [],
  onStartReformDraft,
  onApplyReformPreset,
  onStepReformFiles,
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
  const [viewportH, setViewportH] = useState(FALLBACK_VIEWPORT_H);
  // Tethered unit card state (battle screen, issue #123): minimized
  // collapses the card to its header strip; the measured rendered height
  // (ResizeObserver) keeps the card inside the viewport as it pans/zooms.
  // The player can also drag the card by its header (issue #130): the manual
  // viewport-pixel position overrides the automatic tethered placement until
  // the snap-back button restores it or another unit is selected.
  const [cardMinimized, setCardMinimized] = useState(false);
  const [cardMeasuredH, setCardMeasuredH] = useState(0);
  const [cardManualPos, setCardManualPos] = useState<{ x: number; y: number } | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  // In-progress card drag: the dragging pointer id plus the grab offset
  // between the pointer and the card's top-left corner in viewport pixels.
  const cardDragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
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
      if (rect.height > 0) setViewportH(rect.height);
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

  // Tethered unit context card (battle screen, issue #123): project the
  // card's unit to viewport pixels under xMidYMid meet, then place the card
  // beside it. Recomputed from the live camera, so the card follows pans
  // and zooms.
  const cardUnitId = (unitCard?.unit as any)?.id != null ? String((unitCard?.unit as any).id) : '';
  const cardBounds = useMemo(
    () =>
      unitCard?.unit
        ? projectUnitBounds(unitCard.unit, view, battlefield, viewportW, viewportH)
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [unitCard?.unit, view, battlefield, viewportW, viewportH],
  );
  useEffect(() => {
    setCardMinimized(false);
    setCardMeasuredH(0);
    setCardManualPos(null);
    cardDragRef.current = null;
  }, [cardUnitId]);
  useEffect(() => {
    const element = cardRef.current;
    if (!element || !cardBounds) return;
    const update = () => {
      const height = element.offsetHeight;
      if (height > 0) setCardMeasuredH(height);
    };
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (observer && element) observer.observe(element);
    return () => observer?.disconnect();
  });
  const cardLayout = useMemo(
    () =>
      cardBounds
        ? layoutUnitContextCard(cardBounds, {
            cardW: UNIT_CARD_W,
            measuredH: cardMeasuredH,
            estimatedH: cardMinimized ? 72 : UNIT_CARD_ESTIMATED_H,
            manualPos: cardManualPos ?? undefined,
          })
        : null,
    [cardBounds, cardMeasuredH, cardMinimized, cardManualPos],
  );
  const cardUnit = (unitCard?.unit as any) || null;
  const cardRanks =
    cardUnit && Number.isFinite(Number(cardUnit.soldiers)) && Number.isFinite(Number(cardUnit.files)) && Number(cardUnit.files) > 0
      ? Math.ceil(Number(cardUnit.soldiers) / Number(cardUnit.files))
      : null;
  const cardMovementM = Number(unitCard?.movementAllowanceM);

  const placed: PlacedUnit[] = useMemo(() => {
    const list = Array.isArray(units) ? units : [];
    const chargeByUnit = new Map(
      (battleCandidateCharges || []).map((candidate) => [
        String(candidate.unitId),
        String(candidate.edge || ''),
      ]),
    );
    const shootSet = new Set((battleCandidateShoots || []).map((id) => String(id)));
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
        candidateCharge: chargeByUnit.has(id),
        candidateShoot: shootSet.has(id),
        candidateEdge: chargeByUnit.get(id) ?? null,
      });
    }
    return out;
  }, [units, sides, safeH, mpp, selectedUnitId, unitConflictIds, changedUnitIds, battleCandidateCharges, battleCandidateShoots]);

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
        // A click suppression belongs to the gesture that set it. When that
        // gesture's click never arrives (the pointerup re-render can replace
        // the handle it started on), a stale flag must not swallow the next
        // gesture's click, so every new press starts unsuppressed.
        suppressClickRef.current = false;
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
        battleShootLines={battleShootLines}
        battleCandidateCharges={battleCandidateCharges}
        battleCandidateShoots={battleCandidateShoots}
        battleConflictPoints={battleConflictPoints}
      />
      <MapChrome
        cardUnit={cardUnit}
        cardBounds={cardBounds}
        cardLayout={cardLayout}
        cardRef={cardRef}
        viewportRef={viewportRef}
        cardDragRef={cardDragRef}
        cardMinimized={cardMinimized}
        cardManualPos={cardManualPos}
        setCardMinimized={setCardMinimized}
        setCardManualPos={setCardManualPos}
        cardRanks={cardRanks}
        cardMovementM={cardMovementM}
        onCloseUnitCard={onCloseUnitCard}
        cardDraft={unitCardDraft}
        cardVerdict={unitCardVerdict}
        cardPresets={unitCardPresets}
        cardPermitted={unitCardPermitted}
        onStartReformDraft={onStartReformDraft}
        onApplyReformPreset={onApplyReformPreset}
        onStepReformFiles={onStepReformFiles}
        draft={draft}
        tool={tool}
        setTool={setTool}
        showGrid={showGrid}
        setShowGrid={setShowGrid}
        showLabels={showLabels}
        setShowLabels={setShowLabels}
        showContours={showContours}
        setShowContours={setShowContours}
        scaleLengthM={scaleLengthM}
        scaleWidthPx={scaleWidthPx}
        cursor={cursor}
        cursorText={cursorText}
        zoom={zoom}
        setView={setView}
        battlefield={battlefield}
        cursorAnchorRef={cursorAnchorRef}
        viewportW={viewportW}
        viewportH={viewportH}
      />
    </div>
  );
}
