export const FALLBACK_WIDTH = 1200;
export const FALLBACK_HEIGHT = 800;
export const FALLBACK_VIEWPORT_W = 800;
export const FALLBACK_VIEWPORT_H = 600;
export const UNIT_CARD_W = 300;
export const GRID_STEP_M = 100;
export const GRID_MAJOR_EVERY_M = 500;
export const AXIS_STEP_M = 200;
export const ZOOM_STEP = 1.25;

export function safeDimension(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function sideColor(sides: any[], unit: any): string {
  const key = unit?.side ?? unit?.sideId ?? unit?.sideName;
  const side = (sides || []).find(
    (entry) => entry && (entry.id === key || entry.name === key),
  );
  return side && side.color ? String(side.color) : '#666666';
}

export function formatScaleLabel(lengthM: number): string {
  return lengthM >= 1000 ? `${lengthM / 1000} km` : `${lengthM} m`;
}

// Map buttons release focus on activation: Space-held panning must work
// right after clicking a control instead of re-triggering the focused button
// (keyboard activation itself still fires before focus is released).
export function releaseFocus(event: { currentTarget: HTMLElement }): void {
  event.currentTarget.blur();
}

// Screen-space point (y down) for a client position over the SVG.
export function clientToMap(
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

export interface PlacedUnit {
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
  candidateCharge: boolean;
  candidateShoot: boolean;
  candidateEdge: string | null;
}

export function escapeXml(value: string): string {
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
