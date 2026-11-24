// Shared fixtures for the Shoot-order tests (issue #142).
//
// Moved verbatim from `domain/shoot.test.js`: battle setup, footprint
// helpers, and verdict helpers shared by the shoot validation and shoot
// resolution suites. This is not a test file; it defines no tests and is
// imported by the suites below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRng, startBattle } from './battle.js';
import { SUBMISSION_FORMAT_VERSION, validateTurn } from './turn.js';
import { footprintAt } from './movement.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, 'fixtures');

export const HOPLITE_A = '11111111-1111-4111-8111-111111111111';
export const PELT_A = '22222222-2222-4222-8222-222222222222';
export const HOPLITE_B = '44444444-4444-4444-8444-444444444444';

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
  assert.equal(battle.activeSide, 'athens');
  return battle;
}

export function submissionFor(battle, orders, overrides = {}) {
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
    ...overrides,
  };
}

// Move a battle unit to a new position/facing. Tests mutate the started
// battle directly: shooting reads the battle state as-is and never re-checks
// playability, so arranging footprints by hand is legitimate.
export function place(battle, unitId, position, facing) {
  const unit = battle.units.find((entry) => entry.id === unitId);
  unit.position = { ...position };
  if (facing !== undefined) {
    unit.facing = facing;
  }
  return unit;
}

// Park every unit except the named ones far away so only the arranged
// footprints interact.
export function isolate(battle, ...keepIds) {
  for (const unit of battle.units) {
    if (!keepIds.includes(unit.id)) {
      place(battle, unit.id, { x: 100, y: 100 }, 0);
      unit.engaged = null;
    }
  }
}

// Mark two units engaged with each other, as a committed charge would leave
// them after a frontal contact.
export function engage(battle, firstId, secondId) {
  const first = battle.units.find((entry) => entry.id === firstId);
  const second = battle.units.find((entry) => entry.id === secondId);
  first.engaged = { unitId: second.id, edge: 'front', aspect: 'front', frontageM: 16, files: 16 };
  second.engaged = { unitId: first.id, edge: 'front', aspect: 'front', frontageM: 16, files: 16 };
  return { first, second };
}

export function groundRect(id, category, minX, minY, maxX, maxY) {
  return {
    id,
    kind: 'ground',
    category,
    polygon: [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ],
  };
}

// A tiny 4-soldier unit for exact geometry: frontage 4 m, depth 1 m.
export function tinyShooter(position = { x: 0, y: 10 }, facing = 180, troopType = 'peltast') {
  return {
    id: 'shooter-test',
    side: 'athens',
    troopType,
    soldiers: 4,
    files: 4,
    lateralInterval: 1,
    rankDepth: 1,
    position: { ...position },
    facing,
  };
}

export function tinyTarget(position = { x: 0, y: 0 }, facing = 0, side = 'sparta') {
  return {
    id: 'target-test',
    side,
    troopType: 'hoplite',
    soldiers: 4,
    files: 4,
    lateralInterval: 1,
    rankDepth: 1,
    position: { ...position },
    facing,
  };
}

export function cornersOf(unit) {
  return footprintAt(unit, { ...unit.position }, unit.facing).corners;
}

// An rng state whose next `count` draws each fall inside the wanted ranges:
// `ranges` is [{ lo, hi }] per draw, half-open. Scans linearly; every
// non-degenerate range is hit quickly by the deterministic generator.
export function rngStateForDraws(ranges) {
  for (let state = 0; state < 200000; state += 1) {
    const rng = createRng(state);
    const values = ranges.map(() => rng.next());
    if (values.every((value, index) => value >= ranges[index].lo && value < ranges[index].hi)) {
      return { state, values };
    }
  }
  throw new Error('no rng state found for the wanted draws');
}

export function rejectedVerdict(result, orderIndex = 0) {
  assert.equal(result.ok, false, `expected refusal, got: ${JSON.stringify(result)}`);
  const verdict = result.verdicts[orderIndex];
  assert.equal(verdict.accepted, false);
  return verdict.rejection;
}

export function validateOne(battle, order) {
  return validateTurn(battle, submissionFor(battle, [order]));
}
