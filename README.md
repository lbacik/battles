# PÓLIS — ancient battle UI prototype

A throwaway interface experiment, not production code. Three layouts of the same application explore **how formation design, formation management on the map, and terrain preparation can work together in a turn-based game**.

## Running the prototype

Requires Node.js. No dependencies to install:

```sh
npm run prototype
```

Open <http://localhost:4173/prototype/?variant=A>.

| Variant | Design question | URL |
| --- | --- | --- |
| A · Tactical table | Do an army roster, a map, and a persistent inspector make a convenient command view? | <http://localhost:4173/prototype/?variant=A> |
| B · Battlefield | Does a map with floating panels provide better spatial awareness? | <http://localhost:4173/prototype/?variant=B> |
| C · Scenario workshop | Do a formation library, an order queue, and a bottom inspector make scenario preparation easier? | <http://localhost:4173/prototype/?variant=C> |

The switcher at the bottom or the ← / → keys change variants without resetting state. The URL parameter preserves the selected layout on refresh. The switcher is only available on localhost.

## What you can explore

- Create and edit formations: name, side, type, soldier count, files, ranks, and spacing, with a formation preview.
- Select units on the map or in the roster; change their layout, rotate, duplicate, and delete them.
- Plan movement by dragging a unit or choosing a destination. An arrow and a translucent formation show the future position.
- Execute all orders simultaneously with “Execute turn”, hold positions, and clear the movement plan.
- Add hills, forests, buildings, rough ground, lakes, and rivers. Click or drag to use the brush; draw polygons and rivers with points, then confirm with the button or Enter.
- Edit hill heights and river widths, and delete terrain features.
- Pan and zoom the map, toggle the grid, labels, and contours, and undo changes.
- Inspect the full state with the “State” button or in the console after each view update.

Shortcuts: **V** select, **H** pan map, **M** plan move, **Esc** cancel, **⌘/Ctrl Z** undo.

## Experiment assumptions

State lives only in memory. Refreshing the page restores the scenario. The user controls both sides to compare interactions. The example is a fictional deployment inspired by antiquity, without claiming historical accuracy.

Movement waits for turn execution; formation and terrain edits take effect immediately. There is no combat, collision handling, pathfinding, movement limit, or terrain effect yet. Formation symbols are enlarged relative to the map scale. Soldier count and the number of markers in the diagram are independent.

## Outcome and next decision

**Status: awaiting user evaluation; no variant has been approved yet.** A is a starting point for discussion: all command tools remain available. B explores a focus on the map, while C explores scenario preparation. Selected elements can be combined after comparison.

The prototype source is in `prototype/`. It remains a disposable experiment; the chosen direction requires a separate production implementation. There is no implementation issue yet to record the decision against.

## Verification

Manual browser checks cover formation creation, map selection, movement planning by clicking and dragging, turn execution, river drawing, and state preservation across all three variants. Layouts have been inspected at desktop and narrow widths. JavaScript syntax has been checked; in keeping with the prototype's scope, it has no automated test suite or dependencies.
