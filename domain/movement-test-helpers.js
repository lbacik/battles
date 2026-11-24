// Shared fixtures for the Move-order tests (issue #142).
//
// Moved verbatim from `domain/movement.test.js`: battle setup, unit
// selection helpers, and verdict helpers shared by the move legs and move
// field suites. This is not a test file; it defines no tests and is
// imported by the suites below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startBattle } from './battle.js';
import { SUBMISSION_FORMAT_VERSION } from './turn.js';
import { RULESET_PARAMETERS } from './polis-classical.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, 'fixtures');
export const MOVEMENT = RULESET_PARAMETERS.movement;

export function loadReference() {
  return JSON.parse(readFileSync(path.join(scenarioDir, 'acceptance-plain.json'), 'utf8'));
}

export function freshBattle(seed = 2026) {
  const stored = loadReference();
  const controllers = {
    [stored.sides[0].id]: 'passive',
    [stored.sides[1].id]: 'passive',
  };
  const battle = startBattle(stored, { seed, controllers });
  // The movement fixtures below arrange footprints on the Athens half of the
  // reference scenario; pin the seed's starting side instead of failing
  // mysteriously if the draw ever changes.
  assert.equal(battle.activeSide, 'athens');
  return battle;
}

export function submissionFor(battle, orders) {
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
  };
}

export function ownUnits(battle) {
  return battle.units.filter((unit) => unit.side === battle.activeSide);
}

export function foreignUnits(battle) {
  return battle.units.filter((unit) => unit.side !== battle.activeSide);
}

export function hopliteOf(battle) {
  return ownUnits(battle).find((unit) => unit.troopType === 'hoplite');
}

export function moveOrder(unitId, legs) {
  return { unitId, kind: 'Move', legs };
}

// Move a battle unit to a new position/facing. Tests mutate the started
// battle directly: validation reads the battle state as-is and never
// re-checks playability, so arranging footprints by hand is legitimate.
export function place(battle, unitId, position, facing) {
  const unit = battle.units.find((entry) => entry.id === unitId);
  unit.position = { ...position };
  if (facing !== undefined) {
    unit.facing = facing;
  }
  return unit;
}

export function acceptedVerdict(result, orderIndex = 0) {
  assert.equal(result.ok, true, `expected acceptance, got: ${JSON.stringify(result)}`);
  const verdict = result.verdicts[orderIndex];
  assert.equal(verdict.accepted, true);
  return verdict;
}

export function rejectedVerdict(result, orderIndex = 0) {
  assert.equal(result.ok, false);
  const verdict = result.verdicts[orderIndex];
  assert.equal(verdict.accepted, false);
  return verdict.rejection;
}
