// Panel collapsed-state preferences (issue #113).
//
// The scenario editor and the battle screen each remember which side panels
// the user collapsed, separately per screen and per panel. Stored in the
// browser only (localStorage): a UI preference, never part of the scenario
// or battle data, never written into exported files.
//
// Missing or unreadable values fall back to expanded (false) without errors.

export const PANEL_SCREENS = ['editor', 'battle'];
export const PANEL_SIDES = ['left', 'right'];

export function panelPrefKey(screen, side) {
  return `polis.panel.${screen}.${side}`;
}

function isKnownScreen(screen) {
  return screen === 'editor' || screen === 'battle';
}

function isKnownSide(side) {
  return side === 'left' || side === 'right';
}

// Parse a stored raw value: only an explicit collapsed marker counts as
// collapsed; everything missing or unreadable means expanded.
export function parsePanelCollapsed(raw) {
  if (raw === true) return true;
  if (typeof raw !== 'string') return false;
  const text = raw.trim().toLowerCase();
  return text === 'true' || text === '1';
}

// Read one panel preference from a storage-like ({ getItem }). Never throws:
// missing storage, missing keys, and unreadable values all read as expanded.
export function readPanelCollapsed(storage, screen, side) {
  try {
    if (!isKnownScreen(screen) || !isKnownSide(side)) return false;
    if (!storage || typeof storage.getItem !== 'function') return false;
    return parsePanelCollapsed(storage.getItem(panelPrefKey(screen, side)));
  } catch {
    return false;
  }
}

// Write one panel preference to a storage-like ({ setItem }). Never throws:
// a browser that refuses storage keeps the in-memory state for the visit.
export function writePanelCollapsed(storage, screen, side, collapsed) {
  try {
    if (!isKnownScreen(screen) || !isKnownSide(side)) return;
    if (!storage || typeof storage.setItem !== 'function') return;
    storage.setItem(panelPrefKey(screen, side), collapsed ? 'true' : 'false');
  } catch {
    // Storage refusals are silent: the panels still work for the visit.
  }
}
