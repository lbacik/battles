# Battles

Preparing scenarios and playing battles governed by a shared ruleset.

## Language

**Scenario**:
A prepared description of a battlefield, its sides, and their starting forces and positions, used to start a battle. A scenario is written for one ruleset, whose troop types its units use.
_Avoid_: Battle, saved game

**Battlefield**:
The bounded rectangular ground on which a scenario is set, measured in real ground distance. Its size is chosen per scenario.
_Avoid_: Board, map (the map is only its depiction)

**Terrain feature**:
A shaped piece of the battlefield that a ruleset may take into account: a ground cover area, an elevation level area, or a linear feature with a width (such as a river or road).
_Avoid_: Tile, hex

**Ground cover**:
The category of surface at a place on the battlefield: open ground, forest, rough ground, water, or settlement. Each place has exactly one ground cover; elevation is independent of it. The categories describe the physical ground and are the same under any ruleset; a ruleset only gives them effects.
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

**Spacing**:
How far apart a unit's soldiers stand, across files and in depth. Its class (close, normal, or open) follows from the unit's lateral interval and the troop type's thresholds.
_Avoid_: Order (for the spacing class), such as "close order"

**Footprint**:
The true-scale ground a body of troops occupies on the battlefield. What is drawn is what counts: the footprint is never enlarged for display.
_Avoid_: Symbol, base, counter

**Front**:
The edge of a footprint that faces the enemy; it determines the facing, and with it the rear and flanks.
_Avoid_: Heading (for the edge itself)

**Engaged**:
The state of two opposing units in contact: the charger's front lies flush against an edge of the other's footprint, and the touched edge (front, flank, or rear) decides how the contact counts. Engaged units fight every turn until one routs, withdraws, or is destroyed.
_Avoid_: Melee (for the state), touching (touching friendly footprints is not contact)

**Elevation level**:
A discrete step of height above the base ground, used to tell which position stands higher. Height is not modelled continuously.
_Avoid_: Altitude, height in metres

**Battle**:
A particular playthrough of a scenario, whose current situation changes as players act under the ruleset.
_Avoid_: Scenario

**Cohesion**:
A unit's steadiness during a battle, worn down by losses and adverse combat and restored by rallying. Its thresholds place the unit in one of three states: Steady, Disordered, or Routed. Every unit starts a battle Steady.
_Avoid_: Morale (for the per-unit value), fatigue

**Order**:
An instruction a player gives one of their side's units for the current turn, such as move, charge, or hold. The ruleset accepts or rejects it; a player never resolves it.
_Avoid_: Command, action (for the instruction itself)

**Rejection**:
The ruleset's refusal of an order, naming the order, a reason, and what would have to change for the order to be accepted. A rejected order is never shortened or partly carried out.
_Avoid_: Error, truncation

**Turn**:
The part of a battle in which one side gives its orders and has them resolved. The sides take turns alternately.
_Avoid_: Round (for one side's part), move

**Round**:
A pair of turns, one for each side. A battle's length is counted in rounds.
_Avoid_: Turn (for the pair)

**Ruleset**:
The system that defines permitted actions and how a battle is resolved. This product develops one ruleset with configurable parameters.
_Avoid_: Scenario, rule editor

**Structural validation**:
Checking that a scenario is well formed on its own terms (geometry invariants, unit counts and spacings, names), without consulting any ruleset mechanics. A structurally valid scenario may still be unplayable.
_Avoid_: Playability check

**Playability validation**:
Checking, by the ruleset, whether a structurally valid scenario can start a battle under that ruleset (for example permitted spacings or forbidden ground). It never changes the scenario.
_Avoid_: Structural validation, editor validation

**Player**:
The participant making decisions for a side in a battle. A player may be human, automated, or, in the future, controlled by an LLM; every kind of player sees the same player view and gives orders under the same rules.
_Avoid_: Side, army

**Player view**:
Everything a player may know about a battle when deciding: the whole current situation, the ruleset and its parameter values, and what has happened so far. It is the same for both sides; only the battle's future chance outcomes are withheld.
_Avoid_: Game state (for what the player sees), fog of war
