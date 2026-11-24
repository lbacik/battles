'use client';

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
} from '../../domain/scenario.js';
import { round1 } from '../../domain/geometry.js';
import {
  UNIT_CARD_ESTIMATED_H,
  UNIT_CARD_MARGIN,
  clamp,
  layoutUnitContextCard,
  projectUnitBounds,
} from '../../domain/unit-card-geometry.js';
import { clientToMap, escapeXml, type PlacedUnit } from './map-helpers';
import {
  GRID_MAJOR_EVERY_M,
  GRID_STEP_M,
  AXIS_STEP_M,
} from './map-helpers';
import { buildBattleMarkers, buildBattleOverlays, buildTerrainLayer, mppOf } from './svg-helpers';

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
  draft: any;
  refusal: any;
  onSvgClick: (event: ReactMouseEvent<SVGSVGElement>) => void;
  onMoveUnit?: (id: string, position: { x: number; y: number }) => void;
  onRotateUnit?: (id: string, facing: number) => void;
  onPreviewRotate?: (preview: { facing: number; free: boolean } | null) => void;
  battleRotateUnitId?: string | null;
  onBattleRotate?: (facing: number) => void;
  battleGhosts?: any[];
  battlePaths?: any[];
  battleShootLines?: any[];
  // Charge and shoot candidates for the selected unit (from the engine's
  // available actions): highlighted on the map; clicking one drafts the order.
  battleCandidateCharges?: any[];
  battleCandidateShoots?: string[];
  battleConflictPoints?: any[];
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

export const BattlefieldSvg = memo(function BattlefieldSvg({
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
  battleShootLines = [],
  battleCandidateCharges = [],
  battleCandidateShoots = [],
  battleConflictPoints = [],
}: BattlefieldSvgProps) {
  // Battle draft overlays in true scale: ghost footprints for accepted drafts,
  // leg paths for every draft, and conflict markers from rejection details.
  const battleOverlays = useMemo(
    () => buildBattleOverlays({ battleGhosts, battlePaths, battleShootLines, safeH, mpp }),
    [battleGhosts, battlePaths, battleShootLines, safeH, mpp],
  );

  const battleMarkers = useMemo(
    () => buildBattleMarkers({ battleConflictPoints, safeH, mpp }),
    [battleConflictPoints, safeH, mpp],
  );
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
  const terrain = useMemo(
    () =>
      buildTerrainLayer({
        terrainFeatures,
        selectedTerrainId,
        selectedVertexIndex,
        draft,
        refusal,
        showContours,
        safeH,
        zoom,
        mpp,
      }),
    [terrainFeatures, selectedTerrainId, selectedVertexIndex, draft, refusal, showContours, safeH, zoom, mpp],
  );
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
          <path d="M10 9v12" stroke="#7a8969" strokeWidth="1" />
          <ellipse cx="10" cy="10" rx="9" ry="8" fill="#7b956e" stroke="#6e8761" strokeWidth=".7" />
          <path d="M5 8q5-6 10-1" stroke="#adba93" fill="none" strokeWidth="1" />
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
          // the last resolved turn changed outlines in amber instead. Battle
          // charge candidates draw in bronze and shoot candidates in blue, so
          // the selected unit's targets stand out from the order of battle.
          const outline = entry.conflict
            ? '#b91c1c'
            : entry.candidateCharge
              ? '#9c853c'
              : entry.candidateShoot
                ? '#2f6f8f'
                : entry.changed
                  ? '#b45309'
                  : entry.color;
          const strokeW =
            (entry.selected || entry.conflict || entry.changed ? 3 : 1.6) * entry.mpp;
          let dash = '';
          if (entry.conflict) {
            dash = ` stroke-dasharray="${7 * entry.mpp} ${4 * entry.mpp}"`;
          } else if (entry.candidateCharge) {
            dash = ` stroke-dasharray="${6 * entry.mpp} ${3 * entry.mpp}"`;
          } else if (entry.candidateShoot) {
            dash = ` stroke-dasharray="${2 * entry.mpp} ${3 * entry.mpp}"`;
          }
          const candidateNote =
            entry.candidateCharge && entry.candidateShoot
              ? ' · charge/shoot candidate — click to draft'
              : entry.candidateCharge
                ? ` · charge candidate (${escapeXml(entry.candidateEdge || '')}) — click to draft`
                : entry.candidateShoot
                  ? ' · shoot candidate — click to draft'
                  : '';
          // Rotation handle for the selected unit: a stem forward of the front
          // edge with a grab circle, pivoting the footprint about the front
          // midpoint. Sizes scale with metres-per-pixel so the handle keeps a
          // constant screen size at any zoom.
          const reach = 20 * entry.mpp;
          const gripR = 7 * entry.mpp;
          // Only a unit something can rotate gets the grip: in the editor
          // every selected unit; in battle only the unit whose Move draft the
          // grip pivots. A dead grip would swallow map clicks (approach legs).
          const rotatable =
            entry.selected &&
            (onRotateUnit !== undefined ||
              (onBattleRotate !== undefined && entry.id === battleRotateUnitId));
          const handle = rotatable
            ? `<line x1="0" y1="0" x2="0" y2="${-reach}" stroke="${entry.color}" stroke-width="${1.6 * entry.mpp}" stroke-dasharray="${4 * entry.mpp} ${3 * entry.mpp}" class="rotate-stem" pointer-events="none"/>` +
              `<circle cx="0" cy="${-reach}" r="${12 * entry.mpp}" fill="transparent" class="rotate-hit" data-rotate-handle="${entry.id}" pointer-events="all"><title>Drag to rotate (snaps to ${FACING_SNAP_DEG}°, hold Shift for free rotation)</title></circle>` +
              `<circle cx="0" cy="${-reach}" r="${gripR}" fill="#f8f9f0" stroke="${entry.color}" stroke-width="${2 * entry.mpp}" class="rotate-grip" data-testid="rotate-handle" data-rotate-handle="${entry.id}"><title>Drag to rotate (snaps to ${FACING_SNAP_DEG}°, hold Shift for free rotation)</title></circle>`
            : '';
          const footprint =
            `<title>${entry.name} · ${entry.dims}${candidateNote}</title>` +
            `<g class="unit-rotor" transform="rotate(${entry.facing})">${helper}` +
            `<rect x="${-entry.frontageM / 2}" y="0" width="${entry.frontageM}" height="${entry.depthM}" fill="${entry.color}" fill-opacity="0.32" stroke="${outline}" stroke-width="${strokeW}"${dash} class="unit-footprint" data-testid="unit-footprint"/>` +
            `<line x1="${-entry.frontageM / 2}" y1="0" x2="${entry.frontageM / 2}" y2="0" stroke="${outline}" stroke-width="${3 * entry.mpp}"/>${handle}</g>`;
          const unitId = entry.id;
          return (
            <g
              key={unitId || entry.name}
              transform={`translate(${entry.centre.x} ${entry.centre.y})`}
              className={`map-unit${entry.selected ? ' selected' : ''}${entry.conflict ? ' conflict' : ''}${entry.changed ? ' changed' : ''}${entry.candidateCharge ? ' candidate-charge' : ''}${entry.candidateShoot ? ' candidate-shoot' : ''}`}
              data-testid="map-unit"
              data-unit-id={unitId}
              data-selected={entry.selected ? 'true' : 'false'}
              data-conflict={entry.conflict ? 'true' : 'false'}
              data-changed={entry.changed ? 'true' : 'false'}
              data-candidate-charge={entry.candidateCharge ? 'true' : 'false'}
              data-candidate-shoot={entry.candidateShoot ? 'true' : 'false'}
              data-candidate-edge={entry.candidateEdge ?? undefined}
              style={{
                cursor:
                  selectionEnabled || entry.candidateCharge || entry.candidateShoot
                    ? 'pointer'
                    : undefined,
              }}
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
