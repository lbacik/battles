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
import type { Ref, RefObject } from 'react';
import {
  clampMapZoom,
  fitMapView,
  mapViewBox,
  metresPerPixel,
  niceScaleBarMetres,
  panMapViewByPixels,
  toScreenPoint,
  unitFacingDeg,
  unitFootprint,
  unitPosition,
  zoomViewAroundCursor,
} from '../domain/scenario.js';

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

interface BattlefieldMapProps {
  width: number;
  height: number;
  units?: any[];
  sides?: any[];
  // Single selection shared with the order of battle: clicking a unit's
  // true-scale footprint selects it (display-only, never undoable).
  selectedUnitId?: string | null;
  onSelectUnit?: (id: string | null) => void;
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
  centre: { x: number; y: number };
  frontageM: number;
  depthM: number;
  facing: number;
  color: string;
  name: string;
  dims: string;
  mpp: number;
  selected: boolean;
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
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [panning, setPanning] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number; inside: boolean } | null>(null);
  const [viewportW, setViewportW] = useState(FALLBACK_VIEWPORT_W);

  const viewportRef = useRef<HTMLDivElement>(null);
  const svgHolderRef = useRef<SVGSVGElement | null>(null);
  const panRef = useRef<{ x: number; y: number } | null>(null);
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
      out.push({
        unit,
        centre: toScreenPoint(position, safeH),
        frontageM: footprint.frontageM,
        depthM: footprint.depthM,
        facing: unitFacingDeg(unit),
        color: sideColor(sides, unit),
        name,
        dims: `${Math.round(footprint.frontageM)} × ${Math.round(footprint.depthM)} m`,
        mpp,
        selected: selectedUnitId != null && String(unit?.id ?? '') === String(selectedUnitId),
      });
    }
    return out;
  }, [units, sides, safeH, mpp, selectedUnitId]);

  const cursorText = cursor
    ? `X ${cursor.x.toFixed(1)} m · Y ${cursor.y.toFixed(1)} m${cursor.inside ? '' : ' · outside'}`
    : 'X — · Y —';

  const handActive = tool === 'hand' || spaceHeld;

  return (
    <div
      ref={viewportRef}
      data-testid="map-viewport"
      className={`map-viewport${tool === 'hand' ? ' tool-hand' : ''}${spaceHeld ? ' space-pan' : ''}${panning ? ' panning' : ''}`}
      onPointerDown={(event) => {
        if (event.button === 1 || handActive) {
          if (event.button !== 0 && event.button !== 1) return;
          event.preventDefault();
          panRef.current = { x: event.clientX, y: event.clientY };
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
        if (panRef.current) {
          const start = panRef.current;
          const dxPx = event.clientX - start.x;
          const dyPx = event.clientY - start.y;
          panRef.current = { x: event.clientX, y: event.clientY };
          setView((current) => ({
            ...current,
            ...panMapViewByPixels(current, dxPx, dyPx, mpp),
          }));
        }
      }}
      onPointerUp={() => {
        panRef.current = null;
        setPanning(false);
      }}
      onPointerCancel={() => {
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
        placed={placed}
        svgRef={svgHolderRef}
        selectionEnabled={!handActive && !panning}
        onSelectUnit={onSelectUnit}
      />
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
  placed: PlacedUnit[];
  svgRef: RefObject<SVGSVGElement | null>;
  selectionEnabled: boolean;
  onSelectUnit?: (id: string | null) => void;
}

// The scene, memoised so cursor-readout updates (which only touch the HTML
// overlays) do not rebuild the SVG. The labels toggle only flips the labels
// layer between shown and hidden: display-only, never the document.
const BattlefieldSvg = memo(function BattlefieldSvg({
  showLabels,
  svgRef,
  safeW,
  safeH,
  viewBox,
  zoom,
  showGrid,
  placed,
  selectionEnabled,
  onSelectUnit,
}: BattlefieldSvgProps) {
  // Pointer-down position per unit, so a pan that starts on a footprint does
  // not select it when the pointer comes back up.
  const downPos = useRef<{ x: number; y: number } | null>(null);
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
    >
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
      <g dangerouslySetInnerHTML={{ __html: xLabels + yLabels }} />
      <g data-testid="map-units-group">
        {placed.map((entry) => {
          const minEdgePx = Math.min(entry.frontageM, entry.depthM) / entry.mpp;
          const helperM = 16 * entry.mpp;
          const helperBox = Math.max(entry.frontageM, entry.depthM, helperM);
          const helperCy = entry.depthM / 2;
          const helper =
            minEdgePx < 10
              ? `<rect x="${-helperBox / 2}" y="${helperCy - helperBox / 2}" width="${helperBox}" height="${helperBox}" rx="${4 * entry.mpp}" fill="none" stroke="${entry.color}" stroke-width="${1.5 * entry.mpp}" stroke-dasharray="${6 * entry.mpp} ${4 * entry.mpp}" opacity="0.85"/>`
              : '';
          const outline = entry.selected ? 3 * entry.mpp : 1.6 * entry.mpp;
          const footprint =
            `<g transform="rotate(${entry.facing})">${helper}` +
            `<rect x="${-entry.frontageM / 2}" y="0" width="${entry.frontageM}" height="${entry.depthM}" fill="${entry.color}" fill-opacity="0.32" stroke="${entry.color}" stroke-width="${outline}"/>` +
            `<line x1="${-entry.frontageM / 2}" y1="0" x2="${entry.frontageM / 2}" y2="0" stroke="${entry.color}" stroke-width="${3 * entry.mpp}"/></g>`;
          const unitId = String(entry.unit?.id ?? '');
          return (
            <g
              key={unitId || entry.name}
              transform={`translate(${entry.centre.x} ${entry.centre.y})`}
              data-testid="map-unit"
              data-unit-id={unitId}
              data-selected={entry.selected ? 'true' : 'false'}
              style={{ cursor: selectionEnabled ? 'pointer' : undefined }}
              onPointerDown={(event) => {
                downPos.current = { x: event.clientX, y: event.clientY };
              }}
              onClick={(event) => {
                const down = downPos.current;
                downPos.current = null;
                if (!selectionEnabled) return;
                if (down && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) {
                  return;
                }
                if (!unitId) return;
                event.stopPropagation();
                onSelectUnit?.(unitId);
              }}
              dangerouslySetInnerHTML={{ __html: footprint }}
            />
          );
        })}
      </g>
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
