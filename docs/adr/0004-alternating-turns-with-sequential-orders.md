# Alternating side turns with sequentially executed orders

The first ruleset uses alternating turns: one side gives its orders and has them resolved, then the other side does the same, and a pair of turns forms a round. Within a turn, the active side's orders execute one at a time in the order the player gave them. Each order is validated against the state left by the orders before it, so an order that would collide with a unit or forbidden ground is rejected with a reason instead of being cut short during resolution. We chose this over the simultaneous orders the UI prototype and the background research suggested because, on a continuous battlefield with true-scale footprints (ADR 0001), simultaneous resolution would need original rules for crossing paths, mutual charges, targets that move away, and tie-breaking before anything could be played. Alternating turns remove that whole class of problems. They also need only one device handoff per turn and no hidden orders, and they give human and LLM players the same simple contract: propose a set of orders, have each one accepted or rejected, then commit.

## Considered Options

- **Simultaneous orders (WEGO)** with time-stepped resolution: symmetric and closer to the prototype's "plan, then the whole army moves", but every conflict between moving units needs its own rule, and a shared device must hide each side's orders from the other.
- **Alternating activation of single units**: the most interactive, but it needs a handoff for every unit and makes the order of activations a rule of its own.

## Consequences

- The side that moves first gains an advantage. Which side starts is drawn from the battle's seed at the start; scenarios do not store initiative.
- The inactive side cannot react during the other side's turn. In particular, light troops cannot evade a charge in the first ruleset; an automatic evade for skirmishing troop types is the first candidate if playtesting shows they need it.
- Moving to simultaneous orders later is a new ruleset version with new mechanisms, not a parameter change.
