// Engine gate shared test helpers (#140): fixtures, battle builders, and
// the fuzzing invariants shared by the engine gate suites. Test-only.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startBattle } from './battle.js';
import { SUBMISSION_FORMAT_VERSION, validateTurn } from './turn.js';
import { createRandomPlayer } from './players.js';
import {
  deriveFootprint,
  polygonsOverlapPositiveArea,
  ringsTouch,
} from './geometry.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, 'fixtures');

export const HOPLITE_A = '11111111-1111-4111-8111-111111111111';
export const PELT_A = '22222222-2222-4222-8222-222222222222';
export const HOPLITE_B = '44444444-4444-4444-8444-444444444444';

export function loadScenario(name) {
  return JSON.parse(readFileSync(path.join(scenarioDir, name), 'utf8'));
}

export function freshBattle(seed = 2026) {
  const stored = loadScenario('acceptance-plain.json');
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

// Park every unit except the listed ones far away so sweeps cross nothing.
export function parkOthers(battle, keepIds, at = { x: 100, y: 100 }) {
  for (const unit of battle.units) {
    if (!keepIds.includes(unit.id)) {
      place(battle, unit.id, at, 0);
    }
  }
}

// Mark two units engaged with each other, as a committed charge would leave
// them. The aspects mirror a frontal contact.
export function engage(battle, firstId, secondId) {
  const first = battle.units.find((entry) => entry.id === firstId);
  const second = battle.units.find((entry) => entry.id === secondId);
  first.engaged = { unitId: second.id, edge: 'front', aspect: 'front', frontageM: 16, files: 16 };
  second.engaged = { unitId: first.id, edge: 'front', aspect: 'front', frontageM: 16, files: 16 };
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

// Shared fuzzing helpers, used by both the Engine I and the Engine II gates:
// the water lookup, the Engine I invariant checker, one Random player per
// side from one game seed, and the reference scenarios.
export function watersOf(battle) {
  return (battle.scenario.terrainFeatures || []).filter(
    (feature) => feature
      && feature.kind === 'ground'
      && feature.category === 'water'
      && Array.isArray(feature.polygon)
      && feature.polygon.length >= 3,
  );
}

export function checkInvariants(before, step) {
  const after = step.battle;
  // The event log stays in causal order with consecutive sequence numbers.
  assert.deepEqual(
    after.events.map((event) => event.seq),
    after.events.map((_, index) => index),
    `event sequence stays consecutive on turn ${before.turnNumber}`,
  );
  // No partial commit: the resolved decision validates against the
  // pre-turn battle, and the resolved turn applies exactly its orders.
  assert.equal(validateTurn(before, step.decision.submission).ok, true, 'the committed decision is whole');
  const resolved = after.events.find(
    (event) => event.type === 'turn-resolved' && event.turnNumber === before.turnNumber,
  );
  assert.ok(resolved || after.status !== 'ongoing', 'the turn resolves or the battle ends');
  if (resolved) {
    assert.equal(resolved.ordersApplied, step.decision.submission.orders.length);
  }
  // No footprint overlap anywhere on the field.
  const cornersOf = new Map(after.units.map((unit) => {
    const derived = deriveFootprint(unit);
    return [unit.id, derived.corners];
  }));
  const units = after.units;
  for (let i = 0; i < units.length; i += 1) {
    for (let j = i + 1; j < units.length; j += 1) {
      assert.equal(
        polygonsOverlapPositiveArea(cornersOf.get(units[i].id), cornersOf.get(units[j].id)),
        false,
        `units ${units[i].id} and ${units[j].id} overlap on turn ${before.turnNumber}`,
      );
    }
  }
  // No unit outside the battlefield (Engine I removes nothing from the
  // field, so the "unless it fled" exception is vacuous here), and no
  // footprint touching water.
  const { width, height } = after.scenario.battlefield;
  const waters = watersOf(after);
  for (const unit of units) {
    for (const corner of cornersOf.get(unit.id)) {
      assert.ok(corner.x >= -1e-9 && corner.x <= width + 1e-9, `unit ${unit.id} stays on the field in x`);
      assert.ok(corner.y >= -1e-9 && corner.y <= height + 1e-9, `unit ${unit.id} stays on the field in y`);
    }
    for (const water of waters) {
      assert.equal(
        ringsTouch(cornersOf.get(unit.id), water.polygon),
        false,
        `unit ${unit.id} touches no water on turn ${before.turnNumber}`,
      );
    }
  }
}

// One Random player per side from one game seed: the side index offsets
// the player seeds so the two sides draw differently while the game stays
// reproducible from its seed.
export function randomPlayers(scenario, seed) {
  return Object.fromEntries(
    scenario.sides.map((side, index) => [side.id, createRandomPlayer({ seed: seed * 1000 + index + 1 })]),
  );
}

// Reference scenarios for the fuzzing gate: the two playable references,
// plus a meadow variant with a water pond far from both units. Neither
// reference holds water, so without the pond the "no footprint touching
// water" invariant would pass vacuously; the pond exercises the
// forbidden-ground sweep every turn without refusing battle start.
export function fuzzScenarios() {
  const plain = loadScenario('acceptance-plain.json');
  const meadow = loadScenario('playable-meadow.json');
  const pond = JSON.parse(JSON.stringify(meadow));
  pond.id = '10000000-0000-4000-8000-000000000099';
  pond.title = 'Playable Meadow with pond';
  pond.terrainFeatures.push({
    id: 'pond-fuzz',
    kind: 'ground',
    category: 'water',
    polygon: [{ x: 800, y: 400 }, { x: 900, y: 400 }, { x: 900, y: 500 }, { x: 800, y: 500 }],
  });
  return [plain, meadow, pond];
}
