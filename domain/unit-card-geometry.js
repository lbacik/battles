// Tethered unit context card geometry (issue #123) — pure, framework-free.
//
// Projects the selected unit's rotated true-scale footprint to map-viewport
// pixel bounds under `preserveAspectRatio="xMidYMid meet"`, then places the
// card beside the unit and anchors the dashed tether on the card perimeter
// nearest to the unit centre. The placement shape is the prototype-validated
// Variant A trim (prototype branch `prototype/unit-context-menu`, commit
// `0a376fb`): right of the unit, flipped left when there is no room, clamped
// against the measured rendered height and the viewport size. No manual
// position yet — see the drag ticket.

import { deriveFootprint } from './geometry.js';
import { mapViewBox } from './scenario.js';

// Prototype-validated placement constants (Variant A).
export const UNIT_CARD_MARGIN = 12;
export const UNIT_CARD_GAP = 20;
export const UNIT_CARD_ESTIMATED_H = 340;
export const UNIT_CARD_MIN_H = 160;

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function readPosition(unit) {
  if (!unit || typeof unit !== 'object') return null;
  const nested = unit.position;
  if (nested && Number.isFinite(Number(nested.x)) && Number.isFinite(Number(nested.y))) {
    return { x: Number(nested.x), y: Number(nested.y) };
  }
  if (Number.isFinite(Number(unit.x)) && Number.isFinite(Number(unit.y))) {
    return { x: Number(unit.x), y: Number(unit.y) };
  }
  return null;
}

// Project the selected unit's rotated true-scale footprint to map-viewport
// pixel bounds (`minX`, `maxX`, `minY`, `maxY`, `centerX`, `centerY`,
// `frontX`, `frontY`, `radiusPx`) from `mapViewBox(view, battlefield)` under
// `preserveAspectRatio="xMidYMid meet"`. Returns null when the unit, view,
// battlefield, or viewport is unusable.
export function projectUnitBounds(unit, view, battlefield, viewportW, viewportH) {
  const vw = Number(viewportW);
  const vh = Number(viewportH);
  if (!unit || typeof unit !== 'object') return null;
  if (!Number.isFinite(vw) || vw <= 0 || !Number.isFinite(vh) || vh <= 0) return null;
  const height = Number(battlefield?.height);
  if (!Number.isFinite(height) || height <= 0) return null;
  const position = readPosition(unit);
  if (!position) return null;
  let corners;
  try {
    corners = deriveFootprint(unit).corners;
  } catch {
    return null;
  }
  if (!Array.isArray(corners) || corners.length < 3) return null;
  let box;
  try {
    box = mapViewBox(view, battlefield);
  } catch {
    return null;
  }
  if (!box || !Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) {
    return null;
  }
  const scale = Math.min(vw / box.width, vh / box.height);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  const offsetX = (vw - box.width * scale) / 2;
  const offsetY = (vh - box.height * scale) / 2;
  const toPx = (screenX, screenY) => ({
    x: offsetX + (screenX - box.x) * scale,
    y: offsetY + (screenY - box.y) * scale,
  });
  // Rendering flips the vertical axis: screen y is down (see toScreenPoint).
  const cornersPx = [];
  for (const corner of corners) {
    if (!corner || !Number.isFinite(Number(corner.x)) || !Number.isFinite(Number(corner.y))) {
      return null;
    }
    cornersPx.push(toPx(Number(corner.x), height - Number(corner.y)));
  }
  const xs = cornersPx.map((point) => point.x);
  const ys = cornersPx.map((point) => point.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  // Centre in screen metres first (average of the map corners flipped to
  // screen), then to pixels: avoids mixing pixel offsets into the average.
  const centerScreen = {
    x: corners.reduce((sum, corner) => sum + Number(corner.x), 0) / corners.length,
    y: corners.reduce((sum, corner) => sum + (height - Number(corner.y)), 0) / corners.length,
  };
  const center = toPx(centerScreen.x, centerScreen.y);
  const front = toPx(position.x, height - position.y);
  let radiusPx = 0;
  for (const cornerPx of cornersPx) {
    radiusPx = Math.max(radiusPx, Math.hypot(cornerPx.x - center.x, cornerPx.y - center.y));
  }
  return {
    unitId: unit?.id !== undefined ? String(unit.id) : '',
    centerX: center.x,
    centerY: center.y,
    frontX: front.x,
    frontY: front.y,
    minX,
    maxX,
    minY,
    maxY,
    radiusPx,
    viewportW: vw,
    viewportH: vh,
  };
}

// Compute the card position (`left`, `top`, `maxCardH`, `placedLeft`) plus
// the effective height used for clamping. `measuredH` is the card's measured
// rendered height (ResizeObserver); `estimatedH` is the fallback before the
// first measurement.
export function layoutUnitCard(bounds, options = {}) {
  const viewportW = Number(bounds?.viewportW);
  const viewportH = Number(bounds?.viewportH);
  const cardW = Number(options?.cardW);
  const measuredH = Number(options?.measuredH);
  const estimatedH = Number(options?.estimatedH);
  const margin = Number.isFinite(Number(options?.margin)) ? Number(options.margin) : UNIT_CARD_MARGIN;
  const gap = Number.isFinite(Number(options?.gap)) ? Number(options.gap) : UNIT_CARD_GAP;
  const fallbackH = Number.isFinite(estimatedH) && estimatedH > 0 ? estimatedH : UNIT_CARD_ESTIMATED_H;
  const maxCardH = Math.max(UNIT_CARD_MIN_H, viewportH - margin * 2);
  const effectiveH = Math.min(
    isFiniteNumber(measuredH) && measuredH > 0 ? measuredH : fallbackH,
    maxCardH,
  );
  const fitsRight = bounds.maxX + gap + cardW <= viewportW - margin;
  const placedLeft = !fitsRight && bounds.minX - gap - cardW >= margin;
  const left = placedLeft
    ? bounds.minX - gap - cardW
    : clamp(bounds.maxX + gap, margin, Math.max(margin, viewportW - cardW - margin));
  const top = clamp(
    bounds.centerY - effectiveH / 2,
    margin,
    Math.max(margin, viewportH - effectiveH - margin),
  );
  return { left, top, maxCardH, placedLeft, effectiveH };
}

// Tether anchor on the card's perimeter nearest to the unit centre: the
// centre clamped into the card rectangle.
export function anchorUnitCard(bounds, card) {
  const centerX = Number(bounds?.centerX);
  const centerY = Number(bounds?.centerY);
  const left = Number(card?.left);
  const top = Number(card?.top);
  const cardW = Number(card?.cardW);
  const effectiveH = Number(card?.effectiveH);
  const anchorX = clamp(centerX, left, left + cardW);
  const anchorY = clamp(centerY, top, top + effectiveH);
  return { anchorX, anchorY };
}

// Convenience: placement plus tether anchor in one call.
export function layoutUnitContextCard(bounds, options = {}) {
  const layout = layoutUnitCard(bounds, options);
  const cardW = Number(options?.cardW);
  const anchor = anchorUnitCard(bounds, {
    left: layout.left,
    top: layout.top,
    cardW,
    effectiveH: layout.effectiveH,
  });
  return { ...layout, ...anchor };
}
