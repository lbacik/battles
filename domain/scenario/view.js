// PÓLIS scenario model — screen coordinates and map view (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

// Map convention helpers (ADR 0001). The model keeps y-up metres; only
// rendering flips the vertical axis for the screen, via these functions.
export function toScreenPoint(point, battlefieldHeight) {
  return { x: point.x, y: battlefieldHeight - point.y };
}

export function fromScreenPoint(point, battlefieldHeight) {
  // Screen↔map conversion is its own inverse (a single vertical flip).
  return toScreenPoint(point, battlefieldHeight);
}

// Largest uniform scale that fits the battlefield into a viewport of the
// given size (both in the same units), keeping the true-scale aspect ratio.
export function fitScale(battlefieldWidth, battlefieldHeight, viewportWidth, viewportHeight) {
  if (
    !Number.isFinite(battlefieldWidth) ||
    !Number.isFinite(battlefieldHeight) ||
    battlefieldWidth <= 0 ||
    battlefieldHeight <= 0 ||
    !Number.isFinite(viewportWidth) ||
    !Number.isFinite(viewportHeight) ||
    viewportWidth <= 0 ||
    viewportHeight <= 0
  ) {
    return 1;
  }
  return Math.min(viewportWidth / battlefieldWidth, viewportHeight / battlefieldHeight);
}

// --- Map navigation view model (display only) -------------------------------
// The editor map keeps its camera apart from the scenario document: zooming,
// panning, fitting, toggling the grid, and moving the cursor never mutate the
// document and never mark the scenario as unsaved. These helpers are pure and
// framework-free so the editor and the unit tests share them.
//
// A map view is { zoom, center } where zoom 1 fits the battlefield (plus the
// fixed editorial margin below) and center is a map-convention point
// { x, y } in metres (origin south-west, x east, y north).
export const MAP_VIEW_MIN_ZOOM = 0.2;
export const MAP_VIEW_MAX_ZOOM = 32;

// Fixed editorial margin around the battlefield, in metres. It frames axis
// labels only; it is not stored and never affects validation.
export const MAP_VIEW_PAD_LEFT_M = 70;
export const MAP_VIEW_PAD_RIGHT_M = 60;
export const MAP_VIEW_PAD_TOP_M = 60;
export const MAP_VIEW_PAD_BOTTOM_M = 60;

function baseViewSize(battlefield) {
  const width = Number(battlefield?.width);
  const height = Number(battlefield?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return null;
  }
  return {
    width: width + MAP_VIEW_PAD_LEFT_M + MAP_VIEW_PAD_RIGHT_M,
    height: height + MAP_VIEW_PAD_TOP_M + MAP_VIEW_PAD_BOTTOM_M,
  };
}

export function clampMapZoom(zoom) {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAP_VIEW_MAX_ZOOM, Math.max(MAP_VIEW_MIN_ZOOM, zoom));
}

// The fitted view: the whole battlefield plus the editorial margin is
// visible, centred on the battlefield centre.
export function fitMapView(battlefield) {
  const width = Number(battlefield?.width);
  const height = Number(battlefield?.height);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return { zoom: 1, center: { x: 0, y: 0 } };
  }
  return { zoom: 1, center: { x: width / 2, y: height / 2 } };
}

// Zoom keeping the map point under the cursor fixed on the screen. The cursor
// and the previous centre are map-convention points in metres.
export function zoomViewAroundCursor(view, cursorMap, newZoom) {
  const zoom = clampMapZoom(newZoom);
  const center = view?.center;
  const cursor = cursorMap;
  if (
    !center ||
    !Number.isFinite(center.x) ||
    !Number.isFinite(center.y) ||
    !cursor ||
    !Number.isFinite(cursor.x) ||
    !Number.isFinite(cursor.y)
  ) {
    return { zoom, center: { x: cursor?.x ?? 0, y: cursor?.y ?? 0 } };
  }
  const previousZoom = clampMapZoom(view?.zoom);
  const ratio = previousZoom / zoom;
  return {
    zoom,
    center: {
      x: cursor.x + (center.x - cursor.x) * ratio,
      y: cursor.y + (center.y - cursor.y) * ratio,
    },
  };
}

// Pan by a screen drag. Positive dxPx moves the pointer right, positive dyPx
// moves it down; the content follows the pointer, so the centre moves the
// opposite way in screen space (map y is flipped: down on screen is south).
export function panMapViewByPixels(view, dxPx, dyPx, metresPerPixel) {
  const zoom = clampMapZoom(view?.zoom);
  const center = view?.center;
  if (!center || !Number.isFinite(center.x) || !Number.isFinite(center.y)) {
    return { zoom, center: { x: 0, y: 0 } };
  }
  const mpp = Number.isFinite(metresPerPixel) && metresPerPixel > 0 ? metresPerPixel : 1;
  const dx = Number.isFinite(dxPx) ? dxPx : 0;
  const dy = Number.isFinite(dyPx) ? dyPx : 0;
  return {
    zoom,
    center: { x: center.x - dx * mpp, y: center.y + dy * mpp },
  };
}

// SVG viewBox in screen coordinates (y down) for the current view. Rendering
// flips the vertical axis through toScreenPoint; this is the only place the
// flip happens.
export function mapViewBox(view, battlefield) {
  const base = baseViewSize(battlefield);
  const height = Number(battlefield?.height);
  if (!base || !Number.isFinite(height)) {
    return { x: 0, y: 0, width: 100, height: 100 };
  }
  const zoom = clampMapZoom(view?.zoom);
  const center = view?.center;
  const width = base.width / zoom;
  const viewHeight = base.height / zoom;
  const centerScreenX = center && Number.isFinite(center.x) ? center.x : 0;
  const centerScreenY =
    center && Number.isFinite(center.y) ? height - center.y : height / 2;
  return {
    x: centerScreenX - width / 2,
    y: centerScreenY - viewHeight / 2,
    width,
    height: viewHeight,
  };
}

export function metresPerPixel(view, battlefield, viewportWidthPx) {
  const viewport = Number(viewportWidthPx);
  if (!Number.isFinite(viewport) || viewport <= 0) return 1;
  return mapViewBox(view, battlefield).width / viewport;
}

const SCALE_BAR_STEPS_M = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000];

// Pick a human-readable scale bar length (metres) whose on-screen width is
// close to targetPx without exceeding maxPx.
export function niceScaleBarMetres(mpp, targetPx = 120, maxPx = 180) {
  const perPixel = Number.isFinite(mpp) && mpp > 0 ? mpp : 1;
  const target = Number.isFinite(targetPx) && targetPx > 0 ? targetPx : 120;
  const max = Number.isFinite(maxPx) && maxPx > 0 ? maxPx : 180;
  let fallback = SCALE_BAR_STEPS_M[0];
  for (const step of SCALE_BAR_STEPS_M) {
    if (step / perPixel <= max) fallback = step;
    if (step / perPixel >= target) return step;
  }
  return fallback;
}
