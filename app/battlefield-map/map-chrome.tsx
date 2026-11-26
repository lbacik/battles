'use client';

import type { RefObject } from 'react';
import { fitMapView, zoomViewAroundCursor } from '../../domain/scenario.js';
import {
  UNIT_CARD_ESTIMATED_H,
  UNIT_CARD_MARGIN,
  clamp,
} from '../../domain/unit-card-geometry.js';
import { CHARGE_EDGES, MAX_APPROACH_LEGS } from '../../domain/charge.js';
import {
  UNIT_CARD_W,
  ZOOM_STEP,
  formatScaleLabel,
  releaseFocus,
} from './map-helpers';
import { LINEAR_LABELS } from './svg-helpers';
import { UnitCardReform } from './unit-card-reform';

// Map chrome (unit context card overlay, terrain hint, tool rails, scale bar
// and zoom controls). Verbatim move from ../battlefield-map: markup,
// data-testid attributes, class names and event handling are unchanged, and
// all state still lives in BattlefieldMap and arrives through props, except
// the unit card footer (battle screen, issue #129) showing the draft position
// with Earlier/Later reorder controls and the live verdict.
export interface MapChromeProps {
  cardUnit: any;
  cardBounds: any;
  cardLayout: any;
  cardRef: any;
  viewportRef: any;
  cardDragRef: any;
  cardMinimized: any;
  cardManualPos: any;
  setCardMinimized: (next: any) => void;
  setCardManualPos: (next: any) => void;
  cardRanks: any;
  cardMovementM: any;
  onCloseUnitCard: any;
  cardDraft?: any;
  cardVerdict?: any;
  cardPresets?: Record<string, any> | null;
  cardPermitted?: string[];
  onStartReformDraft?: (unitId: string) => void;
  onApplyReformPreset?: (unitId: string, preset: string) => void;
  onStepReformFiles?: (unitId: string, delta: number) => void;
  cardOrders?: any;
  draft: any;
  tool: any;
  setTool: (next: any) => void;
  showGrid: any;
  setShowGrid: (next: any) => void;
  showLabels: any;
  setShowLabels: (next: any) => void;
  showContours: any;
  setShowContours: (next: any) => void;
  scaleLengthM: any;
  scaleWidthPx: any;
  cursor: any;
  cursorText: any;
  zoom: any;
  setView: (next: any) => void;
  battlefield: any;
  cursorAnchorRef: any;
  viewportW: any;
  viewportH: any;
}

export function MapChrome(props: MapChromeProps) {
  const {
    cardUnit,
    cardBounds,
    cardLayout,
    cardRef,
    viewportRef,
    cardDragRef,
    cardMinimized,
    cardManualPos,
    setCardMinimized,
    setCardManualPos,
    cardRanks,
    cardMovementM,
    onCloseUnitCard,
    cardDraft,
    cardVerdict,
    cardPresets,
    cardPermitted,
    onStartReformDraft,
    onApplyReformPreset,
    onStepReformFiles,
    cardOrders = null,
    draft,
    tool,
    setTool,
    showGrid,
    setShowGrid,
    showLabels,
    setShowLabels,
    showContours,
    setShowContours,
    scaleLengthM,
    scaleWidthPx,
    cursor,
    cursorText,
    zoom,
    setView,
    battlefield,
    cursorAnchorRef,
    viewportW,
    viewportH,
  }: MapChromeProps = props;
  return (
    <>
      {cardUnit && cardBounds && cardLayout ? (
        <div className="unit-card-overlay" data-testid="unit-card-overlay">
          <svg
            className="unit-card-tether-svg"
            aria-hidden="true"
            data-testid="unit-card-tether"
          >
            <line
              x1={cardBounds.centerX}
              y1={cardBounds.centerY}
              x2={cardLayout.anchorX}
              y2={cardLayout.anchorY}
              stroke="#4e6047"
              strokeWidth="1.75"
              strokeDasharray="4 3"
            />
            <circle cx={cardBounds.centerX} cy={cardBounds.centerY} r="4" fill="#4e6047" />
          </svg>
          <aside
            ref={cardRef as RefObject<HTMLElement>}
            className="unit-card"
            data-testid="unit-context-card"
            style={{
              left: `${cardLayout.left}px`,
              top: `${cardLayout.top}px`,
              width: `${UNIT_CARD_W}px`,
              maxHeight: `${cardLayout.maxCardH}px`,
            }}
            aria-label={`Unit card for ${String(cardUnit.name || 'Unit')}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            onContextMenu={(event) => event.stopPropagation()}
          >
            <header
              className="unit-card-head"
              data-testid="unit-card-header"
              title="Drag to move"
              onPointerDown={(event) => {
                // Window controls keep their own behaviour: dragging starts
                // from the header surface, never from a button.
                if (event.target instanceof Element && event.target.closest('button')) return;
                if (!event.isPrimary || event.button !== 0) return;
                if (!cardLayout) return;
                event.stopPropagation();
                event.preventDefault();
                const viewport = viewportRef.current?.getBoundingClientRect();
                const pointerX = viewport ? event.clientX - viewport.left : event.clientX;
                const pointerY = viewport ? event.clientY - viewport.top : event.clientY;
                cardDragRef.current = {
                  pointerId: event.pointerId,
                  offsetX: pointerX - cardLayout.left,
                  offsetY: pointerY - cardLayout.top,
                };
                try {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                } catch {
                  // Pointer capture is best-effort; dragging still works without it.
                }
              }}
              onPointerMove={(event) => {
                const drag = cardDragRef.current;
                if (!drag || event.pointerId !== drag.pointerId) return;
                event.stopPropagation();
                event.preventDefault();
                const rect = viewportRef.current?.getBoundingClientRect();
                const pointerX = rect ? event.clientX - rect.left : event.clientX;
                const pointerY = rect ? event.clientY - rect.top : event.clientY;
                // The effective height is independent of the manual position,
                // so the live layout's value clamps the drag like the domain.
                const effectiveH = cardLayout?.effectiveH ?? UNIT_CARD_ESTIMATED_H;
                setCardManualPos({
                  x: clamp(
                    pointerX - drag.offsetX,
                    UNIT_CARD_MARGIN,
                    Math.max(UNIT_CARD_MARGIN, viewportW - UNIT_CARD_W - UNIT_CARD_MARGIN),
                  ),
                  y: clamp(
                    pointerY - drag.offsetY,
                    UNIT_CARD_MARGIN,
                    Math.max(UNIT_CARD_MARGIN, viewportH - effectiveH - UNIT_CARD_MARGIN),
                  ),
                });
              }}
              onPointerUp={(event) => {
                const drag = cardDragRef.current;
                if (!drag || event.pointerId !== drag.pointerId) return;
                event.stopPropagation();
                cardDragRef.current = null;
                try {
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                    event.currentTarget.releasePointerCapture?.(event.pointerId);
                  }
                } catch {
                  // Releasing capture is best-effort.
                }
              }}
              onPointerCancel={(event) => {
                const drag = cardDragRef.current;
                if (!drag || event.pointerId !== drag.pointerId) return;
                cardDragRef.current = null;
              }}
            >
              <div className="unit-card-titles">
                <span className="eyebrow" data-testid="unit-card-troop">
                  {String(cardUnit.troopType || 'Unit')}
                </span>
                <h4 data-testid="unit-card-name">{String(cardUnit.name || 'Unit')}</h4>
              </div>
              <div className="unit-card-head-right">
                <span
                  className={`unit-card-cohesion state-${String(cardUnit.cohesion || 'Steady').toLowerCase()}`}
                  data-testid="unit-card-cohesion"
                >
                  {String(cardUnit.cohesion || 'Steady')}
                </span>
                {cardManualPos ? (
                  <button
                    type="button"
                    className="unit-card-icon-btn"
                    data-testid="unit-card-snap-back"
                    title="Snap back to unit"
                    aria-label="Snap back to unit"
                    onClick={(event) => {
                      event.stopPropagation();
                      cardDragRef.current = null;
                      setCardManualPos(null);
                    }}
                  >
                    ⌖
                  </button>
                ) : null}
                <button
                  type="button"
                  className="unit-card-icon-btn"
                  data-testid="unit-card-minimize"
                  title={cardMinimized ? 'Expand card' : 'Minimize card'}
                  aria-label={cardMinimized ? 'Expand card' : 'Minimize card'}
                  onClick={(event) => {
                    event.stopPropagation();
                    setCardMinimized((value: any) => !value);
                  }}
                >
                  {cardMinimized ? '▢' : '—'}
                </button>
                <button
                  type="button"
                  className="unit-card-icon-btn"
                  data-testid="unit-card-close"
                  title="Deselect unit (Esc)"
                  aria-label="Deselect unit"
                  onClick={(event) => {
                    event.stopPropagation();
                    onCloseUnitCard?.();
                  }}
                >
                  ✕
                </button>
              </div>
            </header>
            {!cardMinimized ? (
              <div className="unit-card-body">
                <div className="unit-card-meta">
                  <span data-testid="unit-card-soldiers">{`${Number(cardUnit.soldiers) || 0} soldiers`}</span>
                  <span>·</span>
                  <span data-testid="unit-card-formation">
                    {cardRanks != null
                      ? `${Number(cardUnit.files)}×${cardRanks} (${Number(cardUnit.lateralInterval)}×${Number(cardUnit.rankDepth)} m)`
                      : '—'}
                  </span>
                  <span>·</span>
                  <strong data-testid="unit-card-allowance">
                    {Number.isFinite(cardMovementM) ? `Reach ${cardMovementM} m` : 'Reach —'}
                  </strong>
                </div>
                {onStartReformDraft && onApplyReformPreset && onStepReformFiles ? (
                  <UnitCardReform
                    unit={cardUnit}
                    draft={cardDraft ?? null}
                    verdict={cardVerdict ?? null}
                    presets={cardPresets ?? null}
                    permitted={cardPermitted || []}
                    onStartReformDraft={onStartReformDraft}
                    onApplyReformPreset={onApplyReformPreset}
                    onStepReformFiles={onStepReformFiles}
                  />
                ) : null}
                {cardOrders ? (
                  <>
                    {(cardOrders.permitted || []).includes('Charge') &&
                    (cardOrders.chargeCandidates || []).length > 0 ? (
                      <div
                        className="unit-card-orders"
                        aria-label="Charge orders"
                        data-testid={`unit-card-charge-section-${cardOrders.unitId}`}
                      >
                        <span className="field-label">Charge</span>
                        <ul className="candidate-list">
                          {(cardOrders.chargeCandidates || []).map((candidate: any) => (
                            <li key={candidate.targetId}>
                              <button
                                type="button"
                                className="btn-quiet candidate-pick"
                                data-testid={`unit-card-charge-${cardOrders.unitId}-${candidate.targetId}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  cardOrders.onPickChargeTarget?.(candidate.targetId);
                                }}
                              >
                                Charge {cardOrders.displayName?.(candidate.targetId) ?? candidate.targetId} (
                                {candidate.edge}, {candidate.aspect}, {candidate.distanceM} m)
                              </button>
                            </li>
                          ))}
                        </ul>
                        {cardOrders.draft?.kind === 'Charge' ? (
                          <>
                            <label className="field">
                              Target
                              <select
                                data-testid={`unit-card-charge-target-${cardOrders.unitId}`}
                                value={cardOrders.draft.targetId}
                                onChange={(event) => {
                                  event.stopPropagation();
                                  cardOrders.onPickChargeTarget?.(event.target.value);
                                }}
                              >
                                {(cardOrders.chargeCandidates || []).map((candidate: any) => (
                                  <option key={candidate.targetId} value={candidate.targetId}>
                                    {cardOrders.displayName?.(candidate.targetId) ?? candidate.targetId} ·{' '}
                                    {candidate.distanceM} m · {candidate.aspect} ({candidate.edge})
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="field">
                              Edge
                              <select
                                data-testid={`unit-card-charge-edge-${cardOrders.unitId}`}
                                value={cardOrders.draft.edge}
                                onChange={(event) => {
                                  event.stopPropagation();
                                  cardOrders.onChargeEdge?.(event.target.value);
                                }}
                              >
                                {CHARGE_EDGES.map((edge: string) => (
                                  <option key={edge} value={edge}>
                                    {edge}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <p
                              className="draft-hint"
                              data-testid={`unit-card-approach-${cardOrders.unitId}`}
                            >
                              Approach legs: {(cardOrders.draft.approach || []).length} /{' '}
                              {MAX_APPROACH_LEGS} — click open ground for the next leg.
                            </p>
                            <div className="draft-actions">
                              <button
                                type="button"
                                className="btn-secondary"
                                data-testid={`unit-card-remove-last-approach-${cardOrders.unitId}`}
                                disabled={(cardOrders.draft.approach || []).length === 0}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  cardOrders.onUndoApproach?.();
                                }}
                              >
                                Undo
                              </button>
                              <button
                                type="button"
                                className="btn-secondary"
                                data-testid={`unit-card-clear-approach-${cardOrders.unitId}`}
                                disabled={(cardOrders.draft.approach || []).length === 0}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  cardOrders.onClearApproach?.();
                                }}
                              >
                                Clear
                              </button>
                            </div>
                          </>
                        ) : null}
                      </div>
                    ) : null}
                    {(cardOrders.permitted || []).includes('Shoot') &&
                    (cardOrders.shootCandidates || []).length > 0 ? (
                      <div
                        className="unit-card-orders"
                        aria-label="Shoot orders"
                        data-testid={`unit-card-shoot-section-${cardOrders.unitId}`}
                      >
                        <span className="field-label">Shoot</span>
                        <ul className="candidate-list">
                          {(cardOrders.shootCandidates || []).map((candidate: any) => (
                            <li key={candidate.targetId}>
                              <button
                                type="button"
                                className="btn-quiet candidate-pick"
                                data-testid={`unit-card-shoot-${cardOrders.unitId}-${candidate.targetId}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  cardOrders.onPickShootTarget?.(candidate.targetId);
                                }}
                              >
                                Shoot {cardOrders.displayName?.(candidate.targetId) ?? candidate.targetId} (
                                {candidate.distanceM} m)
                              </button>
                            </li>
                          ))}
                        </ul>
                        {cardOrders.draft?.kind === 'Shoot' ? (
                          <label className="field">
                            Target
                            <select
                              data-testid={`unit-card-shoot-target-${cardOrders.unitId}`}
                              value={cardOrders.draft.targetId}
                              onChange={(event) => {
                                event.stopPropagation();
                                cardOrders.onPickShootTarget?.(event.target.value);
                              }}
                            >
                              {(cardOrders.shootCandidates || []).map((candidate: any) => (
                                <option key={candidate.targetId} value={candidate.targetId}>
                                  {cardOrders.displayName?.(candidate.targetId) ?? candidate.targetId} ·{' '}
                                  {candidate.distanceM} m
                                </option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                      </div>
                    ) : null}
                  </>
                ) : null}
                {cardOrders?.draft &&
                typeof cardOrders?.draftIndex === 'number' &&
                cardOrders.draftIndex >= 0 &&
                typeof cardOrders?.draftCount === 'number' &&
                cardOrders.draftCount > 0 ? (
                  <footer
                    className="unit-card-footer"
                    data-testid={`unit-card-footer-${cardOrders.unitId}`}
                  >
                    <span
                      className="unit-card-order"
                      data-testid={`unit-card-order-${cardOrders.unitId}`}
                    >
                      Order #{cardOrders.draftIndex + 1} of {cardOrders.draftCount}
                    </span>
                    <div className="unit-card-order-actions">
                      <button
                        type="button"
                        className="btn-quiet"
                        data-testid={`unit-card-move-earlier-${cardOrders.unitId}`}
                        disabled={cardOrders.draftIndex <= 0}
                        title="Move earlier (re-validates)"
                        onClick={(event) => {
                          event.stopPropagation();
                          cardOrders.onMoveEarlier?.();
                        }}
                      >
                        ↑ Earlier
                      </button>
                      <button
                        type="button"
                        className="btn-quiet"
                        data-testid={`unit-card-move-later-${cardOrders.unitId}`}
                        disabled={cardOrders.draftIndex >= cardOrders.draftCount - 1}
                        title="Move later (re-validates)"
                        onClick={(event) => {
                          event.stopPropagation();
                          cardOrders.onMoveLater?.();
                        }}
                      >
                        ↓ Later
                      </button>
                    </div>
                    {cardOrders?.draftVerdict?.accepted === true ? (
                      <p
                        className="draft-ok"
                        data-testid={`unit-card-accepted-${cardOrders.unitId}`}
                      >
                        Accepted
                      </p>
                    ) : cardOrders?.draftVerdict?.accepted === false &&
                      cardOrders?.draftVerdict?.rejection ? (
                      <p
                        className="field-error"
                        role="alert"
                        data-testid={`unit-card-rejection-${cardOrders.unitId}`}
                      >
                        {cardOrders.draftVerdict.rejection.message}
                      </p>
                    ) : null}
                  </footer>
                ) : null}
              </div>
            ) : null}
          </aside>
        </div>
      ) : null}
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
            setShowGrid((value: any) => !value);
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
            setShowLabels((value: any) => !value);
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
            setShowContours((value: any) => !value);
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
            setView((current: any) =>
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
            setView((current: any) =>
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
    </>
  );
}
