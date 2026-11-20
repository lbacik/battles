'use client';

// Reusable collapsible side-panel mechanism (issue #111).
//
// The scenario editor's left (order of battle / Map editor) and right
// (inspector) panels collapse independently to a narrow strip that holds an
// expand control, so it is always obvious how to get the panel back. The
// battle screen reuses this module (layout helper + control) without change.
//
// Panels start expanded on every visit: collapsed state lives in the host
// screen's useState (default false) and is never persisted (a separate
// ticket). Collapsing only changes the grid layout and hides the panel
// content; selection and document state live above the panels, so selecting
// on the map while collapsed works and expanding shows the current
// selection. The battlefield map keeps its camera ({ zoom, center }) across
// resizes, so the view never jumps away when a panel collapses or expands.

export const PANEL_WIDTH_LEFT = 264;
export const PANEL_WIDTH_RIGHT = 300;
export const PANEL_WIDTH_COLLAPSED = 48;

// Grid columns for the three-column workspace (left, map, right). The map
// takes the freed width through `minmax(0, 1fr)`; the collapsed column keeps
// a narrow strip for the expand control.
export function panelGridColumns(leftCollapsed: boolean, rightCollapsed: boolean): string {
  const left = leftCollapsed ? PANEL_WIDTH_COLLAPSED : PANEL_WIDTH_LEFT;
  const right = rightCollapsed ? PANEL_WIDTH_COLLAPSED : PANEL_WIDTH_RIGHT;
  return `${left}px minmax(0, 1fr) ${right}px`;
}

interface PanelToggleProps {
  side: 'left' | 'right';
  collapsed: boolean;
  onToggle: () => void;
  collapseTestId: string;
  expandTestId: string;
}

// One button per panel that doubles as its collapse control (when expanded)
// and its expand control (when collapsed). A native <button> is
// keyboard-operable by default; the accessible name names the action and the
// panel, and `aria-expanded` exposes the panel state.
export function PanelToggle({
  side,
  collapsed,
  onToggle,
  collapseTestId,
  expandTestId,
}: PanelToggleProps) {
  const panelName = side === 'left' ? 'Left panel' : 'Right panel';
  const label = collapsed ? `Expand ${panelName.toLowerCase()}` : `Collapse ${panelName.toLowerCase()}`;
  // Chevron points towards the edge the panel hides behind: the left panel
  // collapses left (‹) and expands right (›); the right panel mirrors it.
  const chevron = side === 'left' ? (collapsed ? '›' : '‹') : collapsed ? '‹' : '›';
  return (
    <button
      type="button"
      className="panel-collapse-btn"
      data-testid={collapsed ? expandTestId : collapseTestId}
      aria-expanded={!collapsed}
      aria-label={label}
      title={label}
      onClick={onToggle}
    >
      <span aria-hidden="true" className="panel-collapse-chevron">
        {chevron}
      </span>
      <span className="panel-collapse-text">{collapsed ? 'Expand' : 'Collapse'}</span>
    </button>
  );
}
