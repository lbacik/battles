# PÓLIS — ancient battle UI prototype

[![CI](https://github.com/lbacik/battles/actions/workflows/ci.yml/badge.svg)](https://github.com/lbacik/battles/actions/workflows/ci.yml)

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

## Tracer bullet: scenario library and editor

The first editor-first slice (layout A from the prototype: order of battle on the
left, map in the centre, inspector on the right). No dependencies, no build step:

- `prototype/domain/scenario.js` — framework-free scenario model (imports
  nothing from React or Next.js): generated immutable UUIDs, required titles,
  optional descriptions, a default 1200 × 800 m battlefield within the 2000 m
  application limit, two sides with default names and distinct colours, units
  (soldiers, files, spacings in metres, front-midpoint position, compass
  facing), ground cover, elevation, and linear terrain features, and the
  `polis-classical 0.1` ruleset reference. Stored documents carry kind
  `scenario` and integer format version 1; stored metre values are rounded to
  0.1 m; the revision counter stays in library metadata (ADR 0003). Pure
  structural validation covers counts, spacings, names, footprints (derived
  as ranks = ceil(soldiers/files), frontage × depth, anchored at the front
  midpoint), and terrain geometry. File exchange exports the stored document
  and imports a file as a new copy, rejecting bad files with specific
  messages. Map coordinates follow ADR 0001 (origin south-west, x east,
  y north, metres); only rendering flips the vertical axis.
- `prototype/domain/geometry.js` — true-scale footprint derivation and polygon
  predicates (simple rings, overlap with positive area, elevation nesting).
- `prototype/domain/polis-classical.js` — provisional `polis-classical 0.1`
  troop-type catalogue (six keys with display names, close/normal/open
  presets, permitted ranges, and spacing-class thresholds; placeholders).
- `prototype/scenarios/acceptance-plain.json` — reference scenario as an
  exported file; it round-trips through import and export identically.
- `prototype/domain/store.js` — the narrow scenario store interface with an
  in-memory implementation for tests.
- `prototype/library/idb.js` — the IndexedDB implementation used by the editor.
- `prototype/editor.html` — the application: library → new scenario → empty
  battlefield → save → reload → reopen. Viewports narrower than 1280 px show a
  notice instead of a broken layout.
- `prototype/e2e.html` — browser end-to-end test: create → save → reload →
  reopen against a separate IndexedDB test database.

Deliberately not Next.js yet: this repository ships a dependency-free browser
prototype with no build step, so the tracer is implemented in that same style.
The seams the Next.js application needs are already in place — client-only
modules, a framework-free domain package, and storage behind the narrow store
interface — so a Next.js shell can adopt them without changing the model.

### Run the application

```sh
npm run prototype
```

Open <http://localhost:4173/prototype/editor.html>. Create a scenario with a
title, see its empty battlefield in the editor, save it, reload the browser,
and reopen it from the library.

### Run the unit tests

```sh
npm test
```

Covers scenario defaults and structural validation, the map convention, the
store interface (save → list → load, revision kept apart from the document, id
immutability), and framework independence of the domain package.

### Run the end-to-end test

```sh
npm run prototype
```

Open <http://localhost:4173/prototype/e2e.html?autostart=1>. The page creates a
scenario, saves it to IndexedDB, reloads itself, reopens the scenario, and
reports PASS/FAIL with the compared values (also logged to the console).

### Run all checks

Requires the Node.js version in `.nvmrc` (also declared in the `engines`
field). Install from the lockfile only, then run the same scripts CI runs:

```sh
npm ci
npm run lint
npm run format:check
npm run typecheck
npm test
npm run build
npm run test:e2e
```

| Script | Check |
| --- | --- |
| `npm run lint` | Syntax check of every JavaScript file outside `prototype/` |
| `npm run format:check` | No trailing whitespace, exactly one trailing newline |
| `npm run typecheck` | `tsc --noEmit` once TypeScript sources exist (none yet) |
| `npm test` | Unit tests (`node --test` over `prototype/domain/`) |
| `npm run build` | Version coherence check, emits the `dist/` artifact |
| `npm run test:e2e` | Headless smoke test against the `dist/` build |

`prototype/` is a throwaway and is excluded from every check except `npm
test`, which covers the tracer-bullet domain model. The end-to-end script
serves the current placeholder build over loopback HTTP; the browser harness
arrives with the Next.js editor slice, and CI already uploads
`e2e-report/` (report plus trace log) as an artifact when it fails.
