'use client';

// PROTOTYPE: Three variants of unit context-menu order controls on the battle
// map, switchable via `?variant=A|B|C`, on the existing battle screen.
//
// Question: How should players issue and edit unit orders directly from a
// context menu on the unit on the battlefield map, instead of reaching over to
// the right-hand inspector panel?
//
// - VariantA ("Kartoteka taktyczna / Tactical Popover Card"): Floating tactical
//   command card tethered beside the selected unit with viewport-aware side
//   flipping, unit summary, order tabs, inline parameter controls, sequence
//   reorder, and live validation feedback.
// - VariantB ("Pierścień rozkazów / Radial Command Wheel"): Spatial compass
//   ring centered on the unit footprint with 6 radial action medallions and
//   outer orbital satellite controls for targets, edges, formation presets,
//   and wheeling.
// - VariantC ("Mikro-pasek + menu PPM / Direct-Action Micro-Dock"): Minimalist
//   1-line micro-dock under the unit + right-click cascading context menu +
//   single-key hotkeys (1-6, Backspace, H) + direct click-to-move on open
//   ground without pre-selecting "Draft Move".

import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { startBattle } from '../domain/battle.js';
import { CHARGE_EDGES, MAX_APPROACH_LEGS } from '../domain/charge.js';
import { MAX_MOVE_LEGS } from '../domain/movement.js';
import { getTroopType } from '../domain/polis-classical.js';
import { normalizeFacing } from '../domain/scenario.js';

export type ContextMenuVariant = 'A' | 'B' | 'C';

export const VARIANT_META: Record<
  ContextMenuVariant,
  { key: ContextMenuVariant; name: string; subtitle: string }
> = {
  A: {
    key: 'A',
    name: 'Tactical Popover Card',
    subtitle: 'Tethered floating card with inline order form & live verdict',
  },
  B: {
    key: 'B',
    name: 'Radial Command Wheel',
    subtitle: 'Compass ring around the unit with orbital parameter satellites',
  },
  C: {
    key: 'C',
    name: 'Direct Micro-Dock + Right-Click',
    subtitle: '1-line dock, direct click-to-move, hotkeys 1–6 & right-click menu',
  },
};

export interface SelectedUnitScreenBounds {
  unitId: string;
  centerX: number;
  centerY: number;
  frontX: number;
  frontY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  radiusPx: number;
  viewportW: number;
  viewportH: number;
}

export interface PrototypeOrderCallbacks {
  onStartMove: (unitId: string) => void;
  onStartCharge: (unitId: string, targetId?: string | null, edge?: string | null) => void;
  onStartShoot: (unitId: string, targetId?: string | null) => void;
  onStartReform: (unitId: string) => void;
  onStartWithdraw: (unitId: string) => void;
  onStartRally: (unitId: string) => void;
  onSetChargeTarget: (unitId: string, targetId: string, edge?: string | null) => void;
  onSetChargeEdge: (unitId: string, edge: string) => void;
  onSetShootTarget: (unitId: string, targetId: string) => void;
  onSetReformField: (unitId: string, field: string, raw: string) => void;
  onApplyReformPreset: (unitId: string, preset: string) => void;
  onSetDraftFacing: (unitId: string, raw: string) => void;
  onUndoMoveLeg: (unitId: string) => void;
  onClearMoveLegs: (unitId: string) => void;
  onUndoApproachLeg: (unitId: string) => void;
  onClearApproachLegs: (unitId: string) => void;
  onRemoveDraft: (unitId: string) => void;
  onMoveDraftOrder: (unitId: string, direction: number) => void;
  onSelectUnit: (unitId: string | null) => void;
}

export interface UnitContextVariantProps {
  battle: any;
  unit: any;
  bounds: SelectedUnitScreenBounds;
  contextAnchor: { unitId: string; x: number; y: number } | null;
  onClearContextAnchor: () => void;
  canDraft: boolean;
  activeSide: string;
  actionsEntry: any;
  draft: any;
  draftIndex: number;
  totalDrafts: number;
  verdict: any;
  acceptedDetail: string;
  callbacks: PrototypeOrderCallbacks;
  unitDisplayName: (unitId: string) => string;
}

export function readVariantFromUrl(): ContextMenuVariant {
  if (typeof window === 'undefined') return 'A';
  const raw = new URLSearchParams(window.location.search).get('variant');
  const upper = raw ? raw.trim().toUpperCase() : '';
  if (upper === 'A' || upper === 'B' || upper === 'C') {
    return upper;
  }
  return 'A';
}

export function hasVariantInUrl(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = new URLSearchParams(window.location.search).get('variant');
  return raw !== null && raw.trim() !== '';
}

export function writeVariantToUrl(variant: ContextMenuVariant): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('variant', variant);
  window.history.replaceState(null, '', url);
}

// Rich in-memory demo battle so opening `/?variant=A` lands directly on the
// battle screen with units covering every order kind (Move, Charge, Shoot,
// Reform, Withdraw, Rally) and gating state (Steady, Disordered, Engaged).
export function createPrototypeDemoBattle(): any {
  const demoScenario = {
    kind: 'scenario',
    formatVersion: 1,
    id: 'prototype-context-menu-scenario',
    title: 'Plain of Mantinea (Context Menu Prototype)',
    description:
      'Throwaway in-memory prototype scenario: test Move, Charge, Shoot, Reform, Withdraw, and Rally directly from the unit context menu.',
    battlefield: { width: 1400, height: 900 },
    sides: [
      { id: 'athens', name: 'Athens', color: '#1d4ed8' },
      { id: 'sparta', name: 'Sparta', color: '#b91c1c' },
    ],
    ruleset: { id: 'polis-classical', version: '1.0' },
    units: [
      {
        id: 'a-taxis-1',
        name: 'I Athenian taxis',
        side: 'athens',
        troopType: 'hoplite',
        soldiers: 256,
        files: 16,
        lateralInterval: 1,
        rankDepth: 1,
        position: { x: 540, y: 495 },
        facing: 180,
      },
      {
        id: 'a-peltasts',
        name: 'Athenian peltasts',
        side: 'athens',
        troopType: 'peltast',
        soldiers: 120,
        files: 12,
        lateralInterval: 1.5,
        rankDepth: 1.5,
        position: { x: 750, y: 485 },
        facing: 180,
      },
      {
        id: 'a-archers',
        name: 'Cretan archers',
        side: 'athens',
        troopType: 'archer',
        soldiers: 100,
        files: 14,
        lateralInterval: 1.5,
        rankDepth: 1.5,
        position: { x: 920, y: 520 },
        facing: 180,
      },
      {
        id: 'a-taxis-2',
        name: 'II Athenian taxis',
        side: 'athens',
        troopType: 'hoplite',
        soldiers: 240,
        files: 16,
        lateralInterval: 1,
        rankDepth: 1,
        position: { x: 640, y: 550 },
        facing: 180,
      },
      {
        id: 'a-vanguard',
        name: 'Athenian vanguard',
        side: 'athens',
        troopType: 'hoplite',
        soldiers: 144,
        files: 12,
        lateralInterval: 1,
        rankDepth: 1,
        position: { x: 380, y: 470 },
        facing: 180,
      },
      {
        id: 'a-cavalry',
        name: 'Athenian cavalry',
        side: 'athens',
        troopType: 'cavalry',
        soldiers: 80,
        files: 10,
        lateralInterval: 1.8,
        rankDepth: 2.8,
        position: { x: 1090, y: 525 },
        facing: 180,
      },
      {
        id: 'b-vanguard',
        name: 'Spartan vanguard',
        side: 'sparta',
        troopType: 'hoplite',
        soldiers: 144,
        files: 12,
        lateralInterval: 1,
        rankDepth: 1,
        position: { x: 380, y: 450 },
        facing: 0,
      },
      {
        id: 'b-mora-1',
        name: 'I Spartan mora',
        side: 'sparta',
        troopType: 'hoplite',
        soldiers: 320,
        files: 16,
        lateralInterval: 1,
        rankDepth: 1,
        position: { x: 540, y: 425 },
        facing: 0,
      },
      {
        id: 'b-archers',
        name: 'Spartan archers',
        side: 'sparta',
        troopType: 'archer',
        soldiers: 100,
        files: 14,
        lateralInterval: 1.5,
        rankDepth: 1.5,
        position: { x: 750, y: 445 },
        facing: 0,
      },
      {
        id: 'b-skiritae',
        name: 'Skiritae peltasts',
        side: 'sparta',
        troopType: 'peltast',
        soldiers: 120,
        files: 12,
        lateralInterval: 2,
        rankDepth: 2,
        position: { x: 960, y: 400 },
        facing: 0,
      },
    ],
    terrainFeatures: [
      {
        id: 'forest-north',
        kind: 'ground',
        category: 'forest',
        polygon: [
          { x: 120, y: 580 },
          { x: 260, y: 580 },
          { x: 280, y: 700 },
          { x: 160, y: 730 },
          { x: 110, y: 660 },
        ],
      },
      {
        id: 'rough-east',
        kind: 'ground',
        category: 'rough',
        polygon: [
          { x: 1160, y: 610 },
          { x: 1310, y: 620 },
          { x: 1290, y: 740 },
          { x: 1150, y: 720 },
        ],
      },
      {
        id: 'hill-outer',
        kind: 'elevation',
        level: 1,
        polygon: [
          { x: 180, y: 310 },
          { x: 320, y: 310 },
          { x: 320, y: 430 },
          { x: 180, y: 430 },
        ],
      },
    ],
    createdAt: '2026-10-22T12:00:00.000Z',
    updatedAt: '2026-10-22T12:00:00.000Z',
  };

  const started = startBattle(demoScenario, {
    seed: 1,
    controllers: { athens: 'human', sparta: 'passive' },
    battleId: 'prototype-context-menu-battle',
  });

  // Ensure Athens is active on Turn 1 and enrich two units so Rally and
  // Withdraw can be tested immediately alongside Move, Charge, Shoot, Reform.
  started.activeSide = 'athens';
  started.startingSide = 'athens';

  const disorderedUnit = started.units.find((u: any) => u.id === 'a-taxis-2');
  if (disorderedUnit) {
    disorderedUnit.cohesion = 'Disordered';
    disorderedUnit.cohesionState = 'Disordered';
    disorderedUnit.cohesionValue = 3;
  }

  const aVanguard = started.units.find((u: any) => u.id === 'a-vanguard');
  const bVanguard = started.units.find((u: any) => u.id === 'b-vanguard');
  if (aVanguard && bVanguard) {
    bVanguard.position = { x: 380, y: 470 };
    aVanguard.engaged = {
      unitId: 'b-vanguard',
      edge: 'front',
      aspect: 'front',
      frontageM: 12,
      files: 12,
    };
    bVanguard.engaged = {
      unitId: 'a-vanguard',
      edge: 'front',
      aspect: 'front',
      frontageM: 12,
      files: 12,
    };
  }

  return started;
}

const ALL_ORDER_KINDS = ['Move', 'Charge', 'Shoot', 'Reform', 'Withdraw', 'Rally'] as const;

const ORDER_ICONS: Record<string, string> = {
  Move: '➔',
  Charge: '⚔',
  Shoot: '🏹',
  Reform: '▤',
  Withdraw: '↶',
  Rally: '⚑',
  Hold: '■',
};

function currentDraftFacing(unit: any, draft: any): number {
  if (draft?.kind === 'Move' && Array.isArray(draft.legs)) {
    const withFace = [...draft.legs]
      .reverse()
      .find((leg: any) => leg.face !== null && leg.face !== undefined);
    if (withFace && Number.isFinite(withFace.face)) {
      return Number(withFace.face);
    }
  }
  return Number.isFinite(unit?.facing) ? Number(unit.facing) : 0;
}

function rotateByDelta(
  unit: any,
  draft: any,
  deltaDeg: number,
  callbacks: PrototypeOrderCallbacks,
) {
  const base = currentDraftFacing(unit, draft);
  const next = normalizeFacing(base + deltaDeg);
  if (!draft || draft.kind !== 'Move') {
    callbacks.onStartMove(unit.id);
  }
  callbacks.onSetDraftFacing(unit.id, String(next));
}

function stepReformFiles(
  unit: any,
  draft: any,
  delta: number,
  callbacks: PrototypeOrderCallbacks,
) {
  const currentFiles = Number(draft?.files ?? unit?.files ?? 8);
  const soldiers = Number(unit?.soldiers ?? 100);
  const nextFiles = Math.max(1, Math.min(soldiers, currentFiles + delta));
  if (!draft || draft.kind !== 'Reform') {
    callbacks.onStartReform(unit.id);
  }
  callbacks.onSetReformField(unit.id, 'files', String(nextFiles));
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function useDraggableViewportCard(
  bounds: SelectedUnitScreenBounds,
  unitId: string,
  cardW: number,
  estimatedH: number,
) {
  const cardRef = useRef<HTMLElement | null>(null);
  const [measuredH, setMeasuredH] = useState(estimatedH);
  const [manualPos, setManualPos] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    originLeft: number;
    originTop: number;
  } | null>(null);

  // Reset manual drag position when switching to a different unit.
  useEffect(() => {
    setManualPos(null);
  }, [unitId]);

  // Measure actual rendered height of the card so bottom is never clipped.
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return undefined;
    const update = () => {
      const h = el.offsetHeight;
      if (h > 0) setMeasuredH(h);
    };
    update();
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    observer?.observe(el);
    return () => observer?.disconnect();
  });

  const margin = 12;
  const maxCardH = Math.max(160, bounds.viewportH - margin * 2);
  const effectiveH = Math.min(measuredH || estimatedH, maxCardH);

  const gap = 20;
  const fitsRight = bounds.maxX + gap + cardW <= bounds.viewportW - margin;
  const placedLeft = !fitsRight && bounds.minX - gap - cardW >= margin;
  const autoLeft = placedLeft
    ? bounds.minX - gap - cardW
    : clamp(bounds.maxX + gap, margin, Math.max(margin, bounds.viewportW - cardW - margin));
  const autoTop = clamp(
    bounds.centerY - effectiveH / 2,
    margin,
    Math.max(margin, bounds.viewportH - effectiveH - margin),
  );

  const left = manualPos
    ? clamp(manualPos.x, margin, Math.max(margin, bounds.viewportW - cardW - margin))
    : autoLeft;
  const top = manualPos
    ? clamp(manualPos.y, margin, Math.max(margin, bounds.viewportH - effectiveH - margin))
    : autoTop;

  // Nearest point on the card's perimeter to the unit center for the tether line.
  const anchorX = clamp(bounds.centerX, left, left + cardW);
  const anchorY = clamp(bounds.centerY, top, top + effectiveH);

  function onHeaderPointerDown(e: ReactPointerEvent<HTMLElement>) {
    if (e.button !== 0) return;
    if (e.target instanceof Element && e.target.closest('button')) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      pointerId: e.pointerId,
      startClientX: e.clientX,
      startClientY: e.clientY,
      originLeft: left,
      originTop: top,
    };
    setDragging(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Best-effort pointer capture.
    }
  }

  function onHeaderPointerMove(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const nextX = drag.originLeft + (e.clientX - drag.startClientX);
    const nextY = drag.originTop + (e.clientY - drag.startClientY);
    setManualPos({
      x: clamp(nextX, margin, Math.max(margin, bounds.viewportW - cardW - margin)),
      y: clamp(nextY, margin, Math.max(margin, bounds.viewportH - effectiveH - margin)),
    });
  }

  function onHeaderPointerUp(e: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || e.pointerId !== drag.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  }

  return {
    cardRef,
    left,
    top,
    maxCardH,
    anchorX,
    anchorY,
    dragging,
    isManuallyPlaced: manualPos !== null,
    resetPosition: () => setManualPos(null),
    onHeaderPointerDown,
    onHeaderPointerMove,
    onHeaderPointerUp,
  };
}

// ============================================================================
// VARIANT A: Tactical Popover Card (Kartoteka taktyczna przy jednostce)
// ============================================================================
export function VariantA({
  unit,
  bounds,
  canDraft,
  actionsEntry,
  draft,
  draftIndex,
  totalDrafts,
  verdict,
  acceptedDetail,
  callbacks,
  unitDisplayName,
}: UnitContextVariantProps) {
  const [minimized, setMinimized] = useState(false);
  const permittedKinds: string[] = (actionsEntry?.permitted || []).map((item: any) => item.kind);
  const unavailableList: any[] = actionsEntry?.unavailable || [];
  const chargeCandidates: any[] = actionsEntry?.chargeCandidates || [];
  const shootCandidates: any[] = actionsEntry?.shootCandidates || [];
  const presets = getTroopType(unit?.troopType)?.presets || null;

  const cardW = minimized ? 236 : 332;
  const {
    cardRef,
    left,
    top,
    maxCardH,
    anchorX,
    anchorY,
    dragging,
    isManuallyPlaced,
    resetPosition,
    onHeaderPointerDown,
    onHeaderPointerMove,
    onHeaderPointerUp,
  } = useDraggableViewportCard(bounds, unit.id, cardW, minimized ? 72 : 340);

  const accepted = verdict?.accepted === true;
  const rejection = verdict && verdict.accepted === false ? verdict.rejection : null;

  function triggerKind(kind: string) {
    switch (kind) {
      case 'Move':
        callbacks.onStartMove(unit.id);
        break;
      case 'Charge':
        callbacks.onStartCharge(unit.id);
        break;
      case 'Shoot':
        callbacks.onStartShoot(unit.id);
        break;
      case 'Reform':
        callbacks.onStartReform(unit.id);
        break;
      case 'Withdraw':
        callbacks.onStartWithdraw(unit.id);
        break;
      case 'Rally':
        callbacks.onStartRally(unit.id);
        break;
    }
  }

  return (
    <div
      className="proto-overlay-layer"
      data-prototype-context-menu="variant-a"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <svg className="proto-tether-svg" aria-hidden="true">
        <line
          x1={bounds.centerX}
          y1={bounds.centerY}
          x2={anchorX}
          y2={anchorY}
          stroke="#4e6047"
          strokeWidth="1.75"
          strokeDasharray="4 3"
        />
        <circle cx={bounds.centerX} cy={bounds.centerY} r="4" fill="#4e6047" />
      </svg>

      <aside
        ref={cardRef}
        className={`proto-card-a${rejection ? ' is-rejected' : accepted ? ' is-accepted' : ''}${dragging ? ' is-dragging' : ''}`}
        style={{
          left: `${left}px`,
          top: `${top}px`,
          width: `${cardW}px`,
          maxHeight: `${maxCardH}px`,
        }}
        aria-label={`Tactical context menu for ${unit.name}`}
      >
        <header
          className="proto-card-a-head is-draggable"
          title="Drag to move this card"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
        >
          <span className="proto-drag-grip" aria-hidden="true">
            ⋮⋮
          </span>
          <div className="proto-head-titles">
            <span className="proto-eyebrow">
              VARIANT A · TACTICAL CARD · {unit.troopType?.toUpperCase()}
            </span>
            <h4 className="proto-unit-title">{unit.name}</h4>
          </div>
          <div className="proto-head-right">
            <span className={`proto-cohesion-pill state-${(unit.cohesion || 'Steady').toLowerCase()}`}>
              {unit.cohesion || 'Steady'}
            </span>
            {isManuallyPlaced ? (
              <button
                type="button"
                className="proto-icon-btn"
                title="Snap card back next to unit"
                onClick={resetPosition}
              >
                ⌖
              </button>
            ) : null}
            <button
              type="button"
              className="proto-icon-btn"
              title={minimized ? 'Expand menu' : 'Minimize menu'}
              onClick={() => setMinimized((v) => !v)}
            >
              {minimized ? '▢' : '—'}
            </button>
            <button
              type="button"
              className="proto-icon-btn"
              title="Deselect unit (Esc)"
              onClick={() => callbacks.onSelectUnit(null)}
            >
              ✕
            </button>
          </div>
        </header>

        <div className="proto-card-a-body">
          <div className="proto-card-a-meta">
            <span>{unit.soldiers} soldiers</span>
            <span>·</span>
            <span>
              {unit.files}×{Math.ceil(unit.soldiers / unit.files)} ({unit.lateralInterval}×{unit.rankDepth} m)
            </span>
            {Number.isFinite(actionsEntry?.movementAllowanceM) ? (
              <>
                <span>·</span>
                <strong>Reach {actionsEntry.movementAllowanceM} m</strong>
              </>
            ) : null}
          </div>

          {!minimized && canDraft ? (
          <>
            <div className="proto-kind-grid" role="group" aria-label="Order types">
              {ALL_ORDER_KINDS.map((kind) => {
                const isPermitted = permittedKinds.includes(kind);
                const hasCandidates =
                  kind === 'Charge'
                    ? chargeCandidates.length > 0
                    : kind === 'Shoot'
                      ? shootCandidates.length > 0
                      : true;
                const enabled = isPermitted && hasCandidates;
                const active = draft?.kind === kind;
                const gatedReason = !isPermitted
                  ? unavailableList.find((u: any) => u.kind === kind)?.reason || 'Not permitted'
                  : !hasCandidates
                    ? kind === 'Charge'
                      ? 'No enemy in front arc & reach'
                      : 'No enemy in missile range'
                    : '';

                return (
                  <button
                    key={kind}
                    type="button"
                    disabled={!enabled}
                    className={`proto-kind-btn${active ? ' active' : ''}`}
                    title={enabled ? `Issue ${kind} order` : `${kind}: ${gatedReason}`}
                    onClick={() => triggerKind(kind)}
                  >
                    <span className="proto-kind-icon">{ORDER_ICONS[kind]}</span>
                    <span>{kind}</span>
                  </button>
                );
              })}
            </div>

            {unavailableList.length > 0 ? (
              <div className="proto-gated-note">
                {unavailableList.map((u: any) => (
                  <span key={u.kind} className="proto-gated-chip" title={u.reason}>
                    🔒 {u.kind}: {u.reason}
                  </span>
                ))}
              </div>
            ) : null}

            {/* Context-sensitive inline order parameters */}
            {draft ? (
              <div className="proto-subpanel">
                {draft.kind === 'Move' ? (
                  <>
                    <div className="proto-subpanel-row">
                      <span className="proto-sublabel">
                        Legs ({draft.legs.filter((l: any) => l.to).length}/{MAX_MOVE_LEGS}) — click map
                        to add
                      </span>
                      <div className="proto-mini-actions">
                        <button
                          type="button"
                          className="proto-mini-btn"
                          disabled={draft.legs.length === 0}
                          onClick={() => callbacks.onUndoMoveLeg(unit.id)}
                        >
                          Undo leg
                        </button>
                        <button
                          type="button"
                          className="proto-mini-btn"
                          disabled={draft.legs.length === 0}
                          onClick={() => callbacks.onClearMoveLegs(unit.id)}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                    <div className="proto-subpanel-row">
                      <span className="proto-sublabel">
                        Wheel / Facing ({currentDraftFacing(unit, draft)}°)
                      </span>
                      <div className="proto-mini-actions">
                        {[-45, -15, 15, 45, 180].map((delta) => (
                          <button
                            key={delta}
                            type="button"
                            className="proto-mini-btn"
                            onClick={() => rotateByDelta(unit, draft, delta, callbacks)}
                          >
                            {delta > 0 ? `+${delta}°` : `${delta}°`}
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}

                {draft.kind === 'Charge' ? (
                  <>
                    <span className="proto-sublabel">Target &amp; impact edge</span>
                    <div className="proto-target-list">
                      {chargeCandidates.map((cand: any) => (
                        <button
                          key={cand.targetId}
                          type="button"
                          className={`proto-target-chip${draft.targetId === cand.targetId ? ' active' : ''}`}
                          onClick={() =>
                            callbacks.onSetChargeTarget(unit.id, cand.targetId, cand.edge)
                          }
                        >
                          ⚔ {unitDisplayName(cand.targetId)} · {cand.distanceM} m ({cand.aspect})
                        </button>
                      ))}
                    </div>
                    <div className="proto-subpanel-row">
                      <span className="proto-sublabel">Edge</span>
                      <div className="proto-mini-actions">
                        {CHARGE_EDGES.map((edge: string) => (
                          <button
                            key={edge}
                            type="button"
                            className={`proto-mini-btn${draft.edge === edge ? ' active' : ''}`}
                            onClick={() => callbacks.onSetChargeEdge(unit.id, edge)}
                          >
                            {edge}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="proto-subpanel-row">
                      <span className="proto-sublabel">
                        Approach legs ({draft.approach.length}/{MAX_APPROACH_LEGS}) — click map
                      </span>
                      <div className="proto-mini-actions">
                        <button
                          type="button"
                          className="proto-mini-btn"
                          disabled={draft.approach.length === 0}
                          onClick={() => callbacks.onUndoApproachLeg(unit.id)}
                        >
                          Undo
                        </button>
                        <button
                          type="button"
                          className="proto-mini-btn"
                          disabled={draft.approach.length === 0}
                          onClick={() => callbacks.onClearApproachLegs(unit.id)}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  </>
                ) : null}

                {draft.kind === 'Shoot' ? (
                  <>
                    <span className="proto-sublabel">Missile target</span>
                    <div className="proto-target-list">
                      {shootCandidates.map((cand: any) => (
                        <button
                          key={cand.targetId}
                          type="button"
                          className={`proto-target-chip${draft.targetId === cand.targetId ? ' active' : ''}`}
                          onClick={() => callbacks.onSetShootTarget(unit.id, cand.targetId)}
                        >
                          🏹 {unitDisplayName(cand.targetId)} · {cand.distanceM} m
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}

                {draft.kind === 'Reform' ? (
                  <>
                    <div className="proto-subpanel-row">
                      <span className="proto-sublabel">
                        Files (frontage): <strong>{draft.files}</strong> files ×{' '}
                        {Math.ceil(unit.soldiers / Math.max(1, draft.files))} ranks
                      </span>
                      <div className="proto-mini-actions">
                        {[-4, -2, -1, 1, 2, 4].map((delta) => (
                          <button
                            key={delta}
                            type="button"
                            className="proto-mini-btn"
                            onClick={() => stepReformFiles(unit, draft, delta, callbacks)}
                          >
                            {delta > 0 ? `+${delta}` : delta}
                          </button>
                        ))}
                      </div>
                    </div>
                    {presets ? (
                      <div className="proto-subpanel-row">
                        <span className="proto-sublabel">Spacing preset</span>
                        <div className="proto-mini-actions">
                          {Object.entries(presets).map(([name, preset]: [string, any]) => {
                            const isCurrent =
                              draft.lateralInterval === preset.lateralInterval &&
                              draft.rankDepth === preset.rankDepth;
                            return (
                              <button
                                key={name}
                                type="button"
                                className={`proto-mini-btn${isCurrent ? ' active' : ''}`}
                                onClick={() => callbacks.onApplyReformPreset(unit.id, name)}
                              >
                                {name} ({preset.lateralInterval}×{preset.rankDepth})
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </>
                ) : null}

                {draft.kind === 'Withdraw' ? (
                  <p className="proto-subnote">
                    Steps straight back 20 m without turning and breaks every contact.
                  </p>
                ) : null}

                {draft.kind === 'Rally' ? (
                  <p className="proto-subnote">
                    Rallies in place to restore cohesion ({unit.cohesion}).
                  </p>
                ) : null}

                {/* Verdict & sequence footer */}
                <div className={`proto-verdict-bar${rejection ? ' rejected' : ' accepted'}`}>
                  {rejection ? (
                    <span>⚠ {rejection.message}</span>
                  ) : accepted ? (
                    <span>✓ {acceptedDetail}</span>
                  ) : (
                    <span>Validating…</span>
                  )}
                </div>

                <div className="proto-card-a-footer">
                  <span className="proto-seq-label">
                    Order #{draftIndex + 1} of {totalDrafts}
                  </span>
                  <div className="proto-mini-actions">
                    <button
                      type="button"
                      className="proto-mini-btn"
                      disabled={draftIndex <= 0}
                      title="Execute earlier in turn"
                      onClick={() => callbacks.onMoveDraftOrder(unit.id, -1)}
                    >
                      ↑ Earlier
                    </button>
                    <button
                      type="button"
                      className="proto-mini-btn"
                      disabled={draftIndex < 0 || draftIndex >= totalDrafts - 1}
                      title="Execute later in turn"
                      onClick={() => callbacks.onMoveDraftOrder(unit.id, 1)}
                    >
                      ↓ Later
                    </button>
                    <button
                      type="button"
                      className="proto-mini-btn danger"
                      onClick={() => callbacks.onRemoveDraft(unit.id)}
                    >
                      ■ Hold (Clear)
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="proto-holding-note">
                Currently <strong>Holding position</strong>. Pick an order above, or click a
                highlighted enemy on the map.
              </div>
            )}
          </>
        ) : null}
        </div>
      </aside>
    </div>
  );
}

// ============================================================================
// VARIANT B: Radial Command Wheel (Pierścień rozkazów wokół jednostki)
// ============================================================================
export function VariantB({
  unit,
  bounds,
  canDraft,
  actionsEntry,
  draft,
  draftIndex,
  totalDrafts,
  verdict,
  acceptedDetail,
  callbacks,
  unitDisplayName,
}: UnitContextVariantProps) {
  const permittedKinds: string[] = (actionsEntry?.permitted || []).map((item: any) => item.kind);
  const unavailableList: any[] = actionsEntry?.unavailable || [];
  const chargeCandidates: any[] = actionsEntry?.chargeCandidates || [];
  const shootCandidates: any[] = actionsEntry?.shootCandidates || [];
  const presets = getTroopType(unit?.troopType)?.presets || null;

  const cx = clamp(bounds.centerX, 130, Math.max(130, bounds.viewportW - 130));
  const cy = clamp(bounds.centerY, 130, Math.max(130, bounds.viewportH - 130));
  const ringRadius = clamp(bounds.radiusPx + 46, 68, 108);

  // Place the 6 order medallions around the compass avoiding 0 deg (top stem)
  const wheelAngles: { kind: (typeof ALL_ORDER_KINDS)[number]; angleDeg: number }[] = [
    { kind: 'Move', angleDeg: -55 },
    { kind: 'Charge', angleDeg: 0 },
    { kind: 'Shoot', angleDeg: 55 },
    { kind: 'Reform', angleDeg: 125 },
    { kind: 'Withdraw', angleDeg: 180 },
    { kind: 'Rally', angleDeg: -125 },
  ];

  const accepted = verdict?.accepted === true;
  const rejection = verdict && verdict.accepted === false ? verdict.rejection : null;

  function triggerKind(kind: string) {
    switch (kind) {
      case 'Move':
        callbacks.onStartMove(unit.id);
        break;
      case 'Charge':
        callbacks.onStartCharge(unit.id);
        break;
      case 'Shoot':
        callbacks.onStartShoot(unit.id);
        break;
      case 'Reform':
        callbacks.onStartReform(unit.id);
        break;
      case 'Withdraw':
        callbacks.onStartWithdraw(unit.id);
        break;
      case 'Rally':
        callbacks.onStartRally(unit.id);
        break;
    }
  }

  return (
    <div
      className="proto-overlay-layer"
      data-prototype-context-menu="variant-b"
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Decorative SVG ring centered on the unit (pointer-events: none so map clicks pass through!) */}
      <svg className="proto-tether-svg" aria-hidden="true">
        <circle
          cx={cx}
          cy={cy}
          r={ringRadius}
          fill="none"
          stroke="#4e6047"
          strokeWidth="1.5"
          strokeDasharray="6 4"
          opacity="0.7"
        />
        <circle
          cx={cx}
          cy={cy}
          r={ringRadius + 28}
          fill="none"
          stroke="#9c853c"
          strokeWidth="1"
          strokeDasharray="2 5"
          opacity="0.45"
        />
      </svg>

      {/* Top banner above the ring: unit badge & live validation */}
      <div
        className={`proto-wheel-banner${rejection ? ' rejected' : accepted ? ' accepted' : ''}`}
        style={{ left: `${cx}px`, top: `${Math.max(18, cy - ringRadius - 48)}px` }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <strong>{unit.name}</strong>
        <span className="proto-wheel-sub">
          {unit.cohesion || 'Steady'} · {actionsEntry?.movementAllowanceM ?? '—'} m
        </span>
        {draft ? (
          <span className="proto-wheel-status">
            {rejection ? `⚠ ${rejection.code}` : accepted ? `✓ ${draft.kind} (#${draftIndex + 1})` : draft.kind}
          </span>
        ) : (
          <span className="proto-wheel-status holding">Holding</span>
        )}
      </div>

      {/* 6 radial order medallions */}
      {canDraft
        ? wheelAngles.map(({ kind, angleDeg }) => {
            const rad = (angleDeg * Math.PI) / 180;
            const nx = cx + Math.cos(rad) * ringRadius;
            const ny = cy + Math.sin(rad) * ringRadius;
            const isPermitted = permittedKinds.includes(kind);
            const hasCandidates =
              kind === 'Charge'
                ? chargeCandidates.length > 0
                : kind === 'Shoot'
                  ? shootCandidates.length > 0
                  : true;
            const enabled = isPermitted && hasCandidates;
            const active = draft?.kind === kind;
            const reason = !isPermitted
              ? unavailableList.find((u: any) => u.kind === kind)?.reason || 'Unavailable'
              : !hasCandidates
                ? 'No target in range/arc'
                : '';

            return (
              <button
                key={kind}
                type="button"
                disabled={!enabled}
                className={`proto-wheel-node${active ? ' active' : ''}`}
                style={{ left: `${nx}px`, top: `${ny}px` }}
                title={enabled ? `${kind}` : `${kind}: ${reason}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  triggerKind(kind);
                }}
              >
                <span className="proto-wheel-icon">{ORDER_ICONS[kind]}</span>
                <span className="proto-wheel-label">{kind}</span>
              </button>
            );
          })
        : null}

      {/* Center-bottom orbital satellite dock for active order parameters */}
      {canDraft && draft ? (
        <div
          className="proto-wheel-orbit-pod"
          style={{
            left: `${cx}px`,
            top: `${Math.min(bounds.viewportH - 54, cy + ringRadius + 36)}px`,
          }}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {draft.kind === 'Move' ? (
            <>
              <span className="proto-orbit-tag">
                Legs {draft.legs.filter((l: any) => l.to).length}/{MAX_MOVE_LEGS}
              </span>
              <button
                type="button"
                className="proto-orbit-btn"
                onClick={() => rotateByDelta(unit, draft, -15, callbacks)}
                title="Wheel -15°"
              >
                ↺ -15°
              </button>
              <button
                type="button"
                className="proto-orbit-btn"
                onClick={() => rotateByDelta(unit, draft, 15, callbacks)}
                title="Wheel +15°"
              >
                ↻ +15°
              </button>
              <button
                type="button"
                className="proto-orbit-btn"
                disabled={draft.legs.length === 0}
                onClick={() => callbacks.onUndoMoveLeg(unit.id)}
              >
                ↶ Undo leg
              </button>
            </>
          ) : null}

          {draft.kind === 'Charge' ? (
            <>
              {chargeCandidates.map((cand: any) => (
                <button
                  key={cand.targetId}
                  type="button"
                  className={`proto-orbit-btn${draft.targetId === cand.targetId ? ' active' : ''}`}
                  onClick={() => callbacks.onSetChargeTarget(unit.id, cand.targetId, cand.edge)}
                >
                  ⚔ {unitDisplayName(cand.targetId)} ({cand.distanceM}m)
                </button>
              ))}
              {CHARGE_EDGES.map((edge: string) => (
                <button
                  key={edge}
                  type="button"
                  className={`proto-orbit-btn${draft.edge === edge ? ' active' : ''}`}
                  onClick={() => callbacks.onSetChargeEdge(unit.id, edge)}
                >
                  {edge}
                </button>
              ))}
              {draft.approach.length > 0 ? (
                <button
                  type="button"
                  className="proto-orbit-btn"
                  onClick={() => callbacks.onUndoApproachLeg(unit.id)}
                >
                  ↶ Undo approach
                </button>
              ) : null}
            </>
          ) : null}

          {draft.kind === 'Shoot' ? (
            <>
              {shootCandidates.map((cand: any) => (
                <button
                  key={cand.targetId}
                  type="button"
                  className={`proto-orbit-btn${draft.targetId === cand.targetId ? ' active' : ''}`}
                  onClick={() => callbacks.onSetShootTarget(unit.id, cand.targetId)}
                >
                  🏹 {unitDisplayName(cand.targetId)} ({cand.distanceM}m)
                </button>
              ))}
            </>
          ) : null}

          {draft.kind === 'Reform' ? (
            <>
              <button
                type="button"
                className="proto-orbit-btn"
                onClick={() => stepReformFiles(unit, draft, -2, callbacks)}
              >
                −2 files
              </button>
              <span className="proto-orbit-tag">{draft.files} files</span>
              <button
                type="button"
                className="proto-orbit-btn"
                onClick={() => stepReformFiles(unit, draft, 2, callbacks)}
              >
                +2 files
              </button>
              {presets
                ? Object.keys(presets).map((name) => (
                    <button
                      key={name}
                      type="button"
                      className="proto-orbit-btn"
                      onClick={() => callbacks.onApplyReformPreset(unit.id, name)}
                    >
                      {name}
                    </button>
                  ))
                : null}
            </>
          ) : null}

          {totalDrafts > 1 ? (
            <>
              <button
                type="button"
                className="proto-orbit-btn"
                disabled={draftIndex <= 0}
                title="Move order earlier"
                onClick={() => callbacks.onMoveDraftOrder(unit.id, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="proto-orbit-btn"
                disabled={draftIndex >= totalDrafts - 1}
                title="Move order later"
                onClick={() => callbacks.onMoveDraftOrder(unit.id, 1)}
              >
                ↓
              </button>
            </>
          ) : null}

          <button
            type="button"
            className="proto-orbit-btn danger"
            title="Clear order (Hold)"
            onClick={() => callbacks.onRemoveDraft(unit.id)}
          >
            ✕ Hold
          </button>
        </div>
      ) : null}

      {rejection ? (
        <div
          className="proto-wheel-rejection"
          style={{
            left: `${cx}px`,
            top: `${Math.min(bounds.viewportH - 18, cy + ringRadius + 76)}px`,
          }}
        >
          {rejection.message}
        </div>
      ) : accepted ? (
        <div
          className="proto-wheel-accepted"
          style={{
            left: `${cx}px`,
            top: `${Math.min(bounds.viewportH - 18, cy + ringRadius + 76)}px`,
          }}
        >
          {acceptedDetail}
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// VARIANT C: Direct-Action Micro-Dock & Right-Click Context Menu
// ============================================================================
export function VariantC({
  unit,
  bounds,
  contextAnchor,
  onClearContextAnchor,
  canDraft,
  actionsEntry,
  draft,
  draftIndex,
  totalDrafts,
  verdict,
  acceptedDetail,
  callbacks,
  unitDisplayName,
}: UnitContextVariantProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const permittedKinds: string[] = (actionsEntry?.permitted || []).map((item: any) => item.kind);
  const unavailableList: any[] = actionsEntry?.unavailable || [];
  const chargeCandidates: any[] = actionsEntry?.chargeCandidates || [];
  const shootCandidates: any[] = actionsEntry?.shootCandidates || [];
  const presets = getTroopType(unit?.troopType)?.presets || null;

  const isRightClickOpen = contextAnchor !== null && contextAnchor.unitId === unit.id;
  const showPopupMenu = menuOpen || isRightClickOpen;

  // Keyboard hotkeys 1-6 for orders, Backspace to undo leg, H/Delete to hold
  useEffect(() => {
    if (!canDraft) return undefined;
    const isInput = (el: EventTarget | null) =>
      el instanceof HTMLElement &&
      !!el.closest('input, textarea, select, [contenteditable="true"]');

    const onKeyDown = (e: KeyboardEvent) => {
      if (isInput(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '1' && permittedKinds.includes('Move')) {
        e.preventDefault();
        callbacks.onStartMove(unit.id);
      } else if (e.key === '2' && permittedKinds.includes('Charge') && chargeCandidates.length > 0) {
        e.preventDefault();
        callbacks.onStartCharge(unit.id);
      } else if (e.key === '3' && permittedKinds.includes('Shoot') && shootCandidates.length > 0) {
        e.preventDefault();
        callbacks.onStartShoot(unit.id);
      } else if (e.key === '4' && permittedKinds.includes('Reform')) {
        e.preventDefault();
        callbacks.onStartReform(unit.id);
      } else if (e.key === '5' && permittedKinds.includes('Withdraw')) {
        e.preventDefault();
        callbacks.onStartWithdraw(unit.id);
      } else if (e.key === '6' && permittedKinds.includes('Rally')) {
        e.preventDefault();
        callbacks.onStartRally(unit.id);
      } else if (e.key === 'Backspace' && draft) {
        e.preventDefault();
        if (draft.kind === 'Move' && draft.legs.length > 0) {
          callbacks.onUndoMoveLeg(unit.id);
        } else if (draft.kind === 'Charge' && draft.approach.length > 0) {
          callbacks.onUndoApproachLeg(unit.id);
        }
      } else if ((e.key === 'Delete' || e.key.toLowerCase() === 'x') && draft) {
        e.preventDefault();
        callbacks.onRemoveDraft(unit.id);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    canDraft,
    unit.id,
    permittedKinds,
    chargeCandidates.length,
    shootCandidates.length,
    draft,
    callbacks,
  ]);

  const dockX = clamp(bounds.centerX, 210, Math.max(210, bounds.viewportW - 210));
  const dockY = clamp(bounds.maxY + 34, 48, Math.max(48, bounds.viewportH - 42));

  const menuX = isRightClickOpen
    ? clamp(contextAnchor.x, 16, Math.max(16, bounds.viewportW - 270))
    : clamp(bounds.maxX + 16, 16, Math.max(16, bounds.viewportW - 270));
  const menuY = isRightClickOpen
    ? clamp(contextAnchor.y, 16, Math.max(16, bounds.viewportH - 320))
    : clamp(bounds.minY, 16, Math.max(16, bounds.viewportH - 320));

  const accepted = verdict?.accepted === true;
  const rejection = verdict && verdict.accepted === false ? verdict.rejection : null;

  function closePopup() {
    setMenuOpen(false);
    onClearContextAnchor();
  }

  return (
    <div
      className="proto-overlay-layer"
      data-prototype-context-menu="variant-c"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* Slim 1-line Micro-Dock directly under the unit */}
      <div
        className={`proto-micro-dock${rejection ? ' rejected' : accepted ? ' accepted' : ''}`}
        style={{ left: `${dockX}px`, top: `${dockY}px` }}
      >
        <span className="proto-dock-unit" title={`${unit.name} (${unit.cohesion || 'Steady'})`}>
          {unit.name}
        </span>

        {canDraft ? (
          <>
            {ALL_ORDER_KINDS.map((kind, idx) => {
              const isPermitted = permittedKinds.includes(kind);
              const hasCandidates =
                kind === 'Charge'
                  ? chargeCandidates.length > 0
                  : kind === 'Shoot'
                    ? shootCandidates.length > 0
                    : true;
              const enabled = isPermitted && hasCandidates;
              const active = draft?.kind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={!enabled}
                  className={`proto-dock-pill${active ? ' active' : ''}`}
                  title={`${kind} (Hotkey ${idx + 1})`}
                  onClick={() => {
                    switch (kind) {
                      case 'Move':
                        callbacks.onStartMove(unit.id);
                        break;
                      case 'Charge':
                        callbacks.onStartCharge(unit.id);
                        break;
                      case 'Shoot':
                        callbacks.onStartShoot(unit.id);
                        break;
                      case 'Reform':
                        callbacks.onStartReform(unit.id);
                        setMenuOpen(true);
                        break;
                      case 'Withdraw':
                        callbacks.onStartWithdraw(unit.id);
                        break;
                      case 'Rally':
                        callbacks.onStartRally(unit.id);
                        break;
                    }
                  }}
                >
                  <kbd>{idx + 1}</kbd>
                  <span>{kind}</span>
                </button>
              );
            })}

            {draft?.kind === 'Move' && draft.legs.length > 0 ? (
              <button
                type="button"
                className="proto-dock-pill"
                title="Undo last leg (Backspace)"
                onClick={() => callbacks.onUndoMoveLeg(unit.id)}
              >
                ↶
              </button>
            ) : null}

            {draft ? (
              <button
                type="button"
                className="proto-dock-pill danger"
                title="Hold / Clear order (X)"
                onClick={() => callbacks.onRemoveDraft(unit.id)}
              >
                ✕
              </button>
            ) : null}

            <button
              type="button"
              className={`proto-dock-pill menu-trigger${showPopupMenu ? ' active' : ''}`}
              title="Open full context menu (or Right-Click unit)"
              onClick={() => {
                if (showPopupMenu) closePopup();
                else setMenuOpen(true);
              }}
            >
              ⋯ Menu
            </button>
          </>
        ) : null}

        <span className="proto-dock-verdict">
          {rejection
            ? `⚠ ${rejection.message}`
            : accepted
              ? `✓ ${acceptedDetail.replace(/^Accepted · /, '')}`
              : 'Direct-click map to Move'}
        </span>
      </div>

      {/* Right-click / Cascading Context Menu */}
      {showPopupMenu && canDraft ? (
        <div
          className="proto-rc-menu"
          style={{ left: `${menuX}px`, top: `${menuY}px` }}
          role="dialog"
          aria-label={`Context menu for ${unit.name}`}
        >
          <div className="proto-rc-header">
            <strong>{unit.name}</strong>
            <span>
              {unit.troopType} · {unit.cohesion || 'Steady'} · {actionsEntry?.movementAllowanceM ?? '—'} m
            </span>
            <button type="button" className="proto-icon-btn" onClick={closePopup}>
              ✕
            </button>
          </div>

          {permittedKinds.includes('Move') ? (
            <div className="proto-rc-group">
              <button
                type="button"
                className={`proto-rc-item${draft?.kind === 'Move' ? ' active' : ''}`}
                onClick={() => callbacks.onStartMove(unit.id)}
              >
                <span>➔ Move (click map for legs)</span>
                <kbd>1</kbd>
              </button>
              <div className="proto-rc-subrow">
                {[-45, -15, 15, 45, 180].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    className="proto-rc-chip"
                    onClick={() => rotateByDelta(unit, draft, delta, callbacks)}
                  >
                    Wheel {delta > 0 ? `+${delta}°` : `${delta}°`}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {permittedKinds.includes('Charge') && chargeCandidates.length > 0 ? (
            <div className="proto-rc-group">
              <span className="proto-rc-grouplabel">⚔ Charge target (2)</span>
              {chargeCandidates.map((cand: any) => (
                <div key={cand.targetId} className="proto-rc-target-block">
                  <button
                    type="button"
                    className={`proto-rc-item${
                      draft?.kind === 'Charge' && draft.targetId === cand.targetId ? ' active' : ''
                    }`}
                    onClick={() => callbacks.onStartCharge(unit.id, cand.targetId, cand.edge)}
                  >
                    <span>
                      {unitDisplayName(cand.targetId)} ({cand.distanceM} m)
                    </span>
                    <small>{cand.edge}</small>
                  </button>
                  {draft?.kind === 'Charge' && draft.targetId === cand.targetId ? (
                    <div className="proto-rc-subrow">
                      {CHARGE_EDGES.map((edge: string) => (
                        <button
                          key={edge}
                          type="button"
                          className={`proto-rc-chip${draft.edge === edge ? ' active' : ''}`}
                          onClick={() => callbacks.onSetChargeEdge(unit.id, edge)}
                        >
                          {edge}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}

          {permittedKinds.includes('Shoot') && shootCandidates.length > 0 ? (
            <div className="proto-rc-group">
              <span className="proto-rc-grouplabel">🏹 Shoot target (3)</span>
              {shootCandidates.map((cand: any) => (
                <button
                  key={cand.targetId}
                  type="button"
                  className={`proto-rc-item${
                    draft?.kind === 'Shoot' && draft.targetId === cand.targetId ? ' active' : ''
                  }`}
                  onClick={() => callbacks.onStartShoot(unit.id, cand.targetId)}
                >
                  <span>{unitDisplayName(cand.targetId)}</span>
                  <small>{cand.distanceM} m</small>
                </button>
              ))}
            </div>
          ) : null}

          {permittedKinds.includes('Reform') ? (
            <div className="proto-rc-group">
              <span className="proto-rc-grouplabel">
                ▤ Reform formation (4) · now {draft?.files ?? unit.files} files
              </span>
              <div className="proto-rc-subrow">
                {presets
                  ? Object.entries(presets).map(([name, preset]: [string, any]) => (
                      <button
                        key={name}
                        type="button"
                        className="proto-rc-chip"
                        onClick={() => {
                          if (!draft || draft.kind !== 'Reform') callbacks.onStartReform(unit.id);
                          setTimeout(() => callbacks.onApplyReformPreset(unit.id, name), 0);
                        }}
                      >
                        {name} ({preset.lateralInterval}m)
                      </button>
                    ))
                  : null}
                {[-4, -2, 2, 4].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    className="proto-rc-chip"
                    onClick={() => stepReformFiles(unit, draft, delta, callbacks)}
                  >
                    {delta > 0 ? `+${delta} files` : `${delta} files`}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {permittedKinds.includes('Withdraw') ? (
            <button
              type="button"
              className={`proto-rc-item${draft?.kind === 'Withdraw' ? ' active' : ''}`}
              onClick={() => callbacks.onStartWithdraw(unit.id)}
            >
              <span>↶ Withdraw (step back 20 m)</span>
              <kbd>5</kbd>
            </button>
          ) : null}

          {permittedKinds.includes('Rally') ? (
            <button
              type="button"
              className={`proto-rc-item${draft?.kind === 'Rally' ? ' active' : ''}`}
              onClick={() => callbacks.onStartRally(unit.id)}
            >
              <span>⚑ Rally in place</span>
              <kbd>6</kbd>
            </button>
          ) : null}

          {unavailableList.length > 0 ? (
            <div className="proto-rc-gated">
              {unavailableList.map((u: any) => (
                <div key={u.kind}>
                  🔒 <strong>{u.kind}</strong>: {u.reason}
                </div>
              ))}
            </div>
          ) : null}

          {draft ? (
            <div className="proto-rc-footer">
              <span>
                Order #{draftIndex + 1}/{totalDrafts}
              </span>
              <button
                type="button"
                className="proto-rc-chip"
                disabled={draftIndex <= 0}
                onClick={() => callbacks.onMoveDraftOrder(unit.id, -1)}
              >
                ↑ Earlier
              </button>
              <button
                type="button"
                className="proto-rc-chip"
                disabled={draftIndex >= totalDrafts - 1}
                onClick={() => callbacks.onMoveDraftOrder(unit.id, 1)}
              >
                ↓ Later
              </button>
              <button
                type="button"
                className="proto-rc-chip danger"
                onClick={() => callbacks.onRemoveDraft(unit.id)}
              >
                ■ Hold (Clear)
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

// ============================================================================
// Enemy Unit Recon & Direct Target Action Overlay
// ============================================================================
export function EnemyUnitContextCard({
  enemyUnit,
  bounds,
  canDraft,
  ownAttackers,
  onOrderAttack,
  onClose,
}: {
  enemyUnit: any;
  bounds: SelectedUnitScreenBounds;
  canDraft: boolean;
  ownAttackers: {
    unitId: string;
    unitName: string;
    kind: 'Charge' | 'Shoot';
    edge?: string;
    distanceM: number;
  }[];
  onOrderAttack: (
    attackerId: string,
    kind: 'Charge' | 'Shoot',
    targetId: string,
    edge?: string,
  ) => void;
  onClose: () => void;
}) {
  const cardW = 280;
  const {
    cardRef,
    left,
    top,
    maxCardH,
    anchorX,
    anchorY,
    dragging,
    isManuallyPlaced,
    resetPosition,
    onHeaderPointerDown,
    onHeaderPointerMove,
    onHeaderPointerUp,
  } = useDraggableViewportCard(bounds, enemyUnit.id, cardW, 200);

  return (
    <div
      className="proto-overlay-layer"
      data-prototype-context-menu="enemy-recon"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <svg className="proto-tether-svg" aria-hidden="true">
        <line
          x1={bounds.centerX}
          y1={bounds.centerY}
          x2={anchorX}
          y2={anchorY}
          stroke="#9c853c"
          strokeWidth="1.5"
          strokeDasharray="4 3"
        />
        <circle cx={bounds.centerX} cy={bounds.centerY} r="3.5" fill="#9c853c" />
      </svg>
      <aside
        ref={cardRef}
        className={`proto-card-a enemy-card${dragging ? ' is-dragging' : ''}`}
        style={{
          left: `${left}px`,
          top: `${top}px`,
          width: `${cardW}px`,
          maxHeight: `${maxCardH}px`,
        }}
      >
        <header
          className="proto-card-a-head is-draggable"
          title="Drag to move this card"
          onPointerDown={onHeaderPointerDown}
          onPointerMove={onHeaderPointerMove}
          onPointerUp={onHeaderPointerUp}
          onPointerCancel={onHeaderPointerUp}
        >
          <span className="proto-drag-grip" aria-hidden="true">
            ⋮⋮
          </span>
          <div className="proto-head-titles">
            <span className="proto-eyebrow">OPPOSING UNIT · {enemyUnit.troopType?.toUpperCase()}</span>
            <h4 className="proto-unit-title">{enemyUnit.name}</h4>
          </div>
          <div className="proto-head-right">
            {isManuallyPlaced ? (
              <button
                type="button"
                className="proto-icon-btn"
                title="Snap card back next to unit"
                onClick={resetPosition}
              >
                ⌖
              </button>
            ) : null}
            <button type="button" className="proto-icon-btn" onClick={onClose}>
              ✕
            </button>
          </div>
        </header>
        <div className="proto-card-a-body">
          <div className="proto-card-a-meta">
            <span>{enemyUnit.soldiers} soldiers</span>
            <span>·</span>
            <span>{enemyUnit.cohesion || 'Steady'}</span>
            <span>·</span>
            <span>
              {enemyUnit.files}×{Math.ceil(enemyUnit.soldiers / enemyUnit.files)}
            </span>
          </div>
          {canDraft && ownAttackers.length > 0 ? (
            <div className="proto-subpanel">
              <span className="proto-sublabel">Attack this target with:</span>
              <div className="proto-target-list">
                {ownAttackers.map((att, i) => (
                  <button
                    key={`${att.unitId}-${att.kind}-${i}`}
                    type="button"
                    className="proto-target-chip"
                    onClick={() => onOrderAttack(att.unitId, att.kind, enemyUnit.id, att.edge)}
                  >
                    {att.kind === 'Charge' ? '⚔ Charge' : '🏹 Shoot'} with{' '}
                    <strong>{att.unitName}</strong> ({att.distanceM} m
                    {att.edge ? `, ${att.edge}` : ''})
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="proto-holding-note">
              No friendly units currently have this enemy in Charge or Shoot range.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

// ============================================================================
// Floating Bottom Prototype Switcher + Live State Readout (UI.md Step 4 & Rule 5)
// ============================================================================
export function PrototypeSwitcher({
  current,
  onChange,
  rightCollapsed,
  onToggleRightPanel,
  onResetDemoBattle,
  stateSnapshot,
}: {
  current: ContextMenuVariant;
  onChange: (next: ContextMenuVariant) => void;
  rightCollapsed: boolean;
  onToggleRightPanel: () => void;
  onResetDemoBattle?: () => void;
  stateSnapshot: any;
}) {
  const [stateOpen, setStateOpen] = useState(false);
  const order: ContextMenuVariant[] = ['A', 'B', 'C'];

  function cycle(delta: number) {
    const idx = order.indexOf(current);
    const next = order[(idx + delta + order.length) % order.length];
    writeVariantToUrl(next);
    onChange(next);
  }

  useEffect(() => {
    const isFormField = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      !!target.closest('input, textarea, select, [contenteditable="true"]');

    const onKeyDown = (event: KeyboardEvent) => {
      if (isFormField(event.target) || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        cycle(-1);
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        cycle(1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    // Surface state to console on variant switch or draft change (Rule 5).
    console.info('[PÓLIS unit-context-menu prototype]', stateSnapshot);
  }, [stateSnapshot]);

  // Gate in production builds unless `?variant=` was explicitly requested
  if (process.env.NODE_ENV === 'production' && !hasVariantInUrl()) {
    return null;
  }

  const meta = VARIANT_META[current];

  return (
    <>
      {stateOpen ? (
        <aside
          className="proto-state-drawer"
          data-testid="prototype-state-drawer"
          aria-label="Prototype live state"
        >
          <div className="proto-state-head">
            <div>
              <span className="proto-eyebrow">PROTOTYPE LIVE STATE · IN MEMORY</span>
              <h3>
                Variant {meta.key}: {meta.name}
              </h3>
            </div>
            <button
              type="button"
              className="proto-icon-btn"
              onClick={() => setStateOpen(false)}
            >
              ✕
            </button>
          </div>
          <p className="proto-state-desc">{meta.subtitle}</p>
          <pre className="proto-state-pre">{JSON.stringify(stateSnapshot, null, 2)}</pre>
        </aside>
      ) : null}

      <nav
        className="proto-switcher-bar"
        data-testid="prototype-switcher"
        aria-label="Prototype variants"
      >
        <span className="proto-switcher-tag">PROTOTYPE</span>
        <button
          type="button"
          className="proto-switcher-arrow"
          data-testid="prototype-prev-variant"
          aria-label="Previous variant (←)"
          title="Previous variant (←)"
          onClick={() => cycle(-1)}
        >
          ‹
        </button>
        <div className="proto-switcher-label" data-testid="prototype-variant-label">
          <strong>
            {meta.key} ({meta.name})
          </strong>
          <small>{meta.subtitle}</small>
        </div>
        <button
          type="button"
          className="proto-switcher-arrow"
          data-testid="prototype-next-variant"
          aria-label="Next variant (→)"
          title="Next variant (→)"
          onClick={() => cycle(1)}
        >
          ›
        </button>
        <div className="proto-switcher-divider" />
        <button
          type="button"
          className="proto-switcher-btn"
          onClick={onToggleRightPanel}
          title="Toggle right inspector panel to test map-only order control"
        >
          {rightCollapsed ? 'Show Right Panel' : 'Hide Right Panel'}
        </button>
        {onResetDemoBattle ? (
          <button
            type="button"
            className="proto-switcher-btn"
            onClick={onResetDemoBattle}
            title="Reset in-memory demo battle"
          >
            Reset Demo
          </button>
        ) : null}
        <button
          type="button"
          className={`proto-switcher-btn${stateOpen ? ' active' : ''}`}
          data-testid="prototype-toggle-state"
          onClick={() => setStateOpen((v) => !v)}
        >
          State ({stateSnapshot?.drafts?.length ?? 0} orders)
        </button>
      </nav>
    </>
  );
}
