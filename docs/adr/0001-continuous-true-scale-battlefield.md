# Continuous battlefield with true-scale footprints

The editor and the rules engine share one spatial model: a continuous 2D plane measured in metres, on which every body of troops occupies a true-scale rectangular footprint with a front. There is no rules grid, and the footprint is never enlarged for display. We chose this because formations whose frontage and depth come from files, ranks, and spacing cannot be expressed faithfully on hexes or squares, and because a hidden rules grid behind a continuous map would create two competing truths about position. The cost is real geometry in the engine (polygon intersection, contact detection, paths), which we accept and bound by keeping shapes simple: rectangles, simple polygons, and polylines with a width.

## Considered Options

- **Hex grid** (Hoplite, Commands & Colors: Ancients): simplest rules and order validation, but formation depth and frontage only approximate.
- **Square grid** (To the Strongest!): simplest of all, but diagonal movement and rotation look artificial.
- **Continuous editor over a hidden rules grid**: two sources of truth for position.
- **Abstract fixed-size bases** (DBA, Triumph!) or **purely symbolic footprints**: readable at any zoom, but contact and terrain occupancy would not match what is drawn.

## Consequences

- Coordinates use a map convention (origin at the south-west corner, x east, y north, facing as a compass bearing); only rendering flips the axes for the screen.
- The first release targets a tactical scale (a few hundred to a few thousand troops per side, a battlefield of up to about 1–2 km) so true-scale footprints stay legible.
- Touching footprints are legal and distinct from overlap; future contact rules depend on that distinction.
- Elevation is discrete levels, not continuous height.
