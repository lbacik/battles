# PÓLIS — ancient battle scenarios and battles

[![CI](https://github.com/lbacik/battles/actions/workflows/ci.yml/badge.svg)](https://github.com/lbacik/battles/actions/workflows/ci.yml)

PÓLIS prepares scenarios and plays battles governed by a shared ruleset.
An author builds a scenario in the library and editor — battlefield size,
sides, terrain, and the order of battle with true-scale footprints — then
starts a battle from it, assigns a controller per side (Human or the Random
and Passive test players), and plays alternating turns with sequential
orders until an end condition, concession, or rematch.

## Running the app

The application is Next.js (App Router, TypeScript) with a static export;
it is client-only and runs locally. Requires Node.js — install dependencies
from the lockfile first:

```sh
npm ci
npm run dev
```

Open <http://localhost:3000>. Create a scenario with a title, see its empty
battlefield in the editor, save it, reload the browser, and reopen it from
the library. From a saved scenario, start a battle, assign controllers, and
play turns; the battles list resumes battles in progress.

```sh
npm run build
```

produces the static production site in `out/` (build metadata in `dist/`);
`npm run test:e2e` serves that build over loopback HTTP and drives a
headless browser through the editor acceptance scenario (create → properties
→ terrain → order of battle → save → reload → reopen → duplicate, delete,
export/import round-trips, rejected files) and the local battle gate
(playability refusal, Human vs Passive orders with reorder and commit, turn
result, battle log, reload-resume, concession, rematch, and a seeded
Human vs Random run to an end condition). It requires the Playwright
Chromium browser (`npx playwright install chromium`; CI installs it before
running the test and uploads `e2e-report/` on failure).

## Run all checks

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
| `npm run lint` | Syntax check of every JavaScript and TypeScript file |
| `npm run format:check` | No trailing whitespace, exactly one trailing newline |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (`node --test` over `domain/`) |
| `npm run build` | Version coherence check, emits the static export in `out/` plus the `dist/` artifact |
| `npm run test:e2e` | Headless browser test against the `out/` build |

## Domain package

The rules live in the framework-free domain package in `domain/` — it
imports nothing from React or Next.js, so the app shell can adopt it
without changing the model:

- `domain/scenario.js` — scenario model: generated immutable UUIDs,
  required titles, optional descriptions, a default 1200 × 800 m
  battlefield within the 2000 m application limit, two sides with default
  names and distinct colours, units (soldiers, files, spacings in metres,
  front-midpoint position, compass facing), ground cover, elevation, and
  linear terrain features, and the `polis-classical 0.1` ruleset reference.
  Stored documents carry kind `scenario` and integer format version 1;
  stored metre values are rounded to 0.1 m; the revision counter stays in
  library metadata (ADR 0003). Pure structural validation covers counts,
  spacings, names, footprints (derived as ranks = ceil(soldiers/files),
  frontage × depth, anchored at the front midpoint), and terrain geometry.
  File exchange exports the stored document and imports a file as a new
  copy, rejecting bad files with specific messages. Map coordinates follow
  ADR 0001 (origin south-west, x east, y north, metres); only rendering
  flips the vertical axis.
- `domain/geometry.js` — true-scale footprint derivation and polygon
  predicates (simple rings, overlap with positive area, elevation nesting).
- `domain/polis-classical.js` — `polis-classical 0.1` troop-type catalogue
  (six keys with display names, close/normal/open presets, permitted
  ranges, and spacing-class thresholds).
- `domain/turn.js`, `domain/movement.js`, `domain/charge.js`,
  `domain/shoot.js`, `domain/combat.js`, `domain/cohesion.js`,
  `domain/battle.js`, and related modules — the battle engine: alternating
  turns with sequential orders (ADR 0004), validated drafts, turn
  resolution, and end conditions.
- `domain/players.js` — Human, Passive, and Random (seeded) controllers.
- `domain/store.js`, `domain/library.js`, `domain/battles.js` — the narrow
  store interfaces and library trust helpers (duplicate, save conflicts,
  import classification) that the app and the tests share.
- `domain/browser/` — the IndexedDB implementations used by the app.
- `domain/fixtures/` — shared fixtures, including
  `acceptance-plain.json`, the reference scenario as an exported file; it
  round-trips through import and export identically.

`npm test` covers scenario defaults and structural validation, the map
convention, the store interfaces (save → list → load, revision kept apart
from the document, id immutability), save/export/import round-trips
identical to 0.1 m, multi-kind undo/redo, duplicate and save-conflict
handling, import rejections, quota failures, ruleset reference
compatibility, turn validation and resolution, and framework independence
of the domain package.

## Scenario format and migration

Format version 1 is frozen: the stored scenario document (kind
`scenario`, integer format version 1) is fixed, and every later format
change ships a forward migration — older documents migrate forward on load
and nothing is ever migrated backwards (ADR 0003). The library sits behind
the narrow store interface, so server storage can later replace the
browser store without changing the editor. Exports carry the document
kind, the format version, and the ruleset reference, so a file always says
what it needs to load.

## Moving scenarios from the old tracer

The dependency-free browser tracer that preceded this app is removed; only
history keeps it (`git log` before the removal). Its exported scenario
files load in this app unchanged: in an old checkout, open the tracer's
editor library and export the scenario to a JSON file, then in the app use
the library's import to store it as a new copy (a fresh id, identical
content to 0.1 m). Files the app cannot read — malformed JSON, wrong
document kind, a newer format version, an unknown ruleset, overlapping
units — are rejected whole with a specific message and nothing is stored.
