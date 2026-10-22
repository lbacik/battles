# Scenarios store formation spacing in metres

A unit's footprint is derived from its soldiers, files, and two spacings: the lateral interval per file and the depth per rank (ranks = ceil(soldiers / files); frontage = files × lateral interval; depth = ranks × rank depth). The scenario stores both spacings in metres on each unit; troop-type presets (close, normal, open order) only pre-fill them in the editor. We chose this so a scenario's geometry is self-contained: the editor can compute and validate footprints without the rules engine, and changing a ruleset parameter can never move or enlarge footprints in a saved scenario and silently create overlaps. The ruleset may still reject spacings it does not permit, as part of playability validation.

## Considered Options

- **Named order only** (the scenario stores "close", the ruleset supplies the metres): smaller scenario data, but every ruleset tweak would reshape saved scenarios and could invalidate geometry the editor had accepted.
- **Files and ranks authored independently of soldiers** (as in the UI prototype): the drawn footprint would not match the troops it represents, contradicting ADR 0001.
