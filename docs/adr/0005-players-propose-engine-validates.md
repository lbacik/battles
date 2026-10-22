# Players propose orders through one asynchronous contract; the engine alone validates

Every kind of player (human, automated, and a future LLM) takes part in a battle through the same contract. The player receives the player view, the available actions, and a `validate` function. It returns one turn decision asynchronously: commit a set of orders, or concede. The engine is a pure package independent of React. It alone decides legality, and the editor and battle UI contain no rules of their own, so every highlight, hint, or disabled control comes from engine calls. A commit is all or nothing. The engine re-validates every order against the authoritative state and refuses the whole commit if any order is rejected; it never silently drops an order. Retries and fallbacks for players that are not human live in a runner outside the engine: after a bounded number of refused attempts, the runner removes the first rejected order and re-validates until the rest is accepted, and a missing or unparseable answer means every unit holds. We chose this so that a human and an LLM are bound by exactly the same rules from the first engine release, and so the engine stays a pure, reproducible function with no notion of time, attempts, or who is playing.

## Considered Options

- **Executing the accepted orders and skipping the rejected ones on commit**: convenient for an LLM, but removing an order changes how the orders after it validate, and it would quietly break the "reject, never truncate" rule of ADR 0004.
- **A synchronous player interface now, made asynchronous for the LLM later**: simpler for the first local UI, but switching later would rewrite the whole turn flow.
- **Legality checks duplicated in the UI for responsiveness**: two sources of truth, which would let human and LLM players play under different rules.

## Consequences

- The UI calls `validate` while the player builds orders. Validation returns a deterministic preview of where each unit ends up after the Movement phase, but no chance outcomes.
- Fallbacks for players that are not human are recorded in the battle's events, so a battle remains reproducible from its seed and its committed orders. A player is never conceded for automatically.
- The contract envelope (submission, player view, turn decision, rejection structure) carries its own format version. The order kinds, their parameters, and the rejection codes belong to the ruleset and change with its major version.
