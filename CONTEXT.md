# Battles

Preparing scenarios and playing battles governed by a shared ruleset.

## Language

**Scenario**:
A prepared description of a battlefield, its sides, and their starting forces and positions, used to start a battle.
_Avoid_: Battle, saved game

**Battlefield**:
The bounded rectangular ground on which a scenario is set, measured in real ground distance. Its size is chosen per scenario.
_Avoid_: Board, map (the map is only its depiction)

**Terrain feature**:
A shaped piece of the battlefield that a ruleset may take into account: a ground cover area, an elevation level area, or a linear feature with a width (such as a river or road).
_Avoid_: Tile, hex

**Ground cover**:
The category of surface at a place on the battlefield, such as open ground, forest, rough ground, water, or settlement. Each place has exactly one ground cover; elevation is independent of it.
_Avoid_: Terrain type (when elevation is meant too)

**Side**:
One of the two opposing armies in a scenario.
_Avoid_: Faction, team, player (the player commands a side)

**Unit**:
A body of troops of one troop type that receives orders and acts as a whole, occupying one footprint. A battle keeps the scenario's units throughout; they may lose soldiers but are never split or merged.
_Avoid_: Formation (for the body itself), counter, base, regiment

**Troop type**:
The kind of troops a unit consists of, such as hoplites, skirmishers, archers, or cavalry, as catalogued by the ruleset.
_Avoid_: Kind, class, unit type

**Formation**:
The current arrangement of a unit's soldiers: how many files wide it stands and how far apart they stand across and in depth. It is always rectangular and may change while the unit remains the same unit.
_Avoid_: Unit (for the arrangement), shape

**File**:
A line of soldiers standing one behind another; the number of files sets the unit's frontage.
_Avoid_: Column, width

**Rank**:
A line of soldiers standing side by side; the number of ranks follows from the soldiers and files and sets the unit's depth.
_Avoid_: Row, depth (for the count)

**Footprint**:
The true-scale ground a body of troops occupies on the battlefield. What is drawn is what counts: the footprint is never enlarged for display.
_Avoid_: Symbol, base, counter

**Front**:
The edge of a footprint that faces the enemy; it determines the facing, and with it the rear and flanks.
_Avoid_: Heading (for the edge itself)

**Elevation level**:
A discrete step of height above the base ground, used to tell which position stands higher. Height is not modelled continuously.
_Avoid_: Altitude, height in metres

**Battle**:
A particular playthrough of a scenario, whose current situation changes as players act under the ruleset.
_Avoid_: Scenario

**Ruleset**:
The system that defines permitted actions and how a battle is resolved. This product develops one ruleset with configurable parameters.
_Avoid_: Scenario, rule editor

**Player**:
The participant making decisions for a side in a battle. A player may be human or, in the future, controlled by an LLM.
_Avoid_: Side, army
