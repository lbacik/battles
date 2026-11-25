// PÓLIS scenario model — undo history (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

// --- Undo history (framework-free) ------------------------------------------
// The editing session keeps whole-document snapshots: every committed change
// (properties, terrain, units, placements, rotations) pushes the previous
// document and clears the redo stack, so every tool that commits through
// these helpers is undoable with no extra work. View navigation and selection
// are never recorded. History is not saved with the scenario. Pure: snapshots
// are treated as opaque values and never mutated.

export function createHistory() {
  return { past: [], future: [] };
}

// Record `snapshot` (the document before a committed change) and drop the
// redo stack. Returns the next history value.
export function historyCommit(history, snapshot) {
  const past = Array.isArray(history?.past) ? history.past : [];
  return { past: [...past, snapshot], future: [] };
}

// Step back to the most recent snapshot, holding `current` for redo. Returns
// null when there is nothing to undo: { history, document } otherwise.
export function historyUndo(history, current) {
  const past = Array.isArray(history?.past) ? history.past : [];
  const future = Array.isArray(history?.future) ? history.future : [];
  if (past.length === 0) {
    return null;
  }
  const previous = past.slice(0, -1);
  return {
    history: { past: previous, future: [...future, current] },
    document: past[past.length - 1],
  };
}

// Step forward to the most recently undone snapshot, holding `current` for
// undo. Returns null when there is nothing to redo.
export function historyRedo(history, current) {
  const past = Array.isArray(history?.past) ? history.past : [];
  const future = Array.isArray(history?.future) ? history.future : [];
  if (future.length === 0) {
    return null;
  }
  const remaining = future.slice(0, -1);
  return {
    history: { past: [...past, current], future: remaining },
    document: future[future.length - 1],
  };
}
