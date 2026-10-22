// Unit tests for Move orders on open ground: leg mechanics, cost billing,
// swept-footprint checks, sequential validation, previews, and commit.
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { startBattle } from './battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  TurnRejectedError,
  availableActions,
  resolveTurn,
  validateTurn,
} from './turn.js';
import {
  MAX_MOVE_LEGS,
  convexHull,
  displacementBearing,
  movementAllowanceM,
  normalizeFacing,
  signedAngleDiff,
  validateMoveOnField,
} from './movement.js';
import { RULESET_PARAMETERS } from './polis-classical.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, '..', 'scenarios');
const MOVEMENT = RULESET_PARAMETERS.movement;

function loadReference() {
  return JSON.parse(readFileSync(path.join(scenarioDir, 'acceptance-plain.json'), 'utf8'));
}

function freshBattle(seed = 2026) {
  const stored = loadReference();
  const controllers = {
    [stored.sides[0].id]: 'passive',
    [stored.sides[1].id]: 'passive',
  };
  return startBattle(stored, { seed, controllers });
}

function submissionFor(battle, orders) {
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders,
  };
}

function ownUnits(battle) {
  return battle.units.filter((unit) => unit.side === battle.activeSide);
}

function foreignUnits(battle) {
  return battle.units.filter((unit) => unit.side !== battle.activeSide);
}

function hopliteOf(battle) {
  return ownUnits(battle).find((unit) => unit.troopType === 'hoplite');
}

function moveOrder(unitId, legs) {
  return { unitId, kind: 'Move', legs };
}

// Move a battle unit to a new position/facing. Tests mutate the started
// battle directly: validation reads the battle state as-is and never
// re-checks playability, so arranging footprints by hand is legitimate.
function place(battle, unitId, position, facing) {
  const unit = battle.units.find((entry) => entry.id === unitId);
  unit.position = { ...position };
  if (facing !== undefined) {
    unit.facing = facing;
  }
  return unit;
}

function acceptedVerdict(result, orderIndex = 0) {
  assert.equal(result.ok, true, `expected acceptance, got: ${JSON.stringify(result)}`);
  const verdict = result.verdicts[orderIndex];
  assert.equal(verdict.accepted, true);
  return verdict;
}

function rejectedVerdict(result, orderIndex = 0) {
  assert.equal(result.ok, false);
  const verdict = result.verdicts[orderIndex];
  assert.equal(verdict.accepted, false);
  return verdict.rejection;
}

describe('movement helpers', () => {
  it('exposes three legs and the movement parameter snapshot', () => {
    assert.equal(MAX_MOVE_LEGS, 3);
    for (const key of ['hoplite', 'peltast', 'archer', 'slinger', 'light_cavalry', 'cavalry']) {
      assert.ok(
        Number.isFinite(MOVEMENT.allowanceM[key]) && MOVEMENT.allowanceM[key] > 0,
        `${key} needs a positive movement allowance`,
      );
    }
    assert.equal(MOVEMENT.allowanceM.hoplite, 90);
    assert.equal(MOVEMENT.forwardArcDeg, 45);
    assert.equal(MOVEMENT.maxLegs, 3);
  });

  it('normalises facings and measures signed angle differences', () => {
    assert.equal(normalizeFacing(0), 0);
    assert.equal(normalizeFacing(360), 0);
    assert.equal(normalizeFacing(-90), 270);
    assert.equal(normalizeFacing(720 + 45), 45);
    assert.equal(signedAngleDiff(180, 270), 90);
    assert.equal(signedAngleDiff(180, 90), -90);
    assert.equal(signedAngleDiff(10, 350), -20);
    assert.equal(signedAngleDiff(350, 10), 20);
  });

  it('measures displacement bearings from north, clockwise', () => {
    assert.equal(displacementBearing({ x: 0, y: 0 }, { x: 0, y: 10 }), 0);
    assert.equal(displacementBearing({ x: 0, y: 0 }, { x: 10, y: 0 }), 90);
    assert.equal(displacementBearing({ x: 0, y: 0 }, { x: 0, y: -10 }), 180);
    assert.equal(displacementBearing({ x: 0, y: 0 }, { x: -10, y: 0 }), 270);
    assert.equal(displacementBearing({ x: 1, y: 1 }, { x: 1, y: 1 }), null);
  });

  it('hulls a translated rectangle into its swept area', () => {
    const hull = convexHull([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 4, y: 2 },
      { x: 0, y: 2 },
      { x: 0, y: 6 },
      { x: 4, y: 6 },
      { x: 4, y: 8 },
      { x: 0, y: 8 },
    ]);
    assert.equal(hull.length, 4);
    const xs = hull.map((point) => point.x).sort((a, b) => a - b);
    const ys = hull.map((point) => point.y).sort((a, b) => a - b);
    assert.deepEqual(xs, [0, 0, 4, 4]);
    assert.deepEqual(ys, [0, 0, 8, 8]);
  });

  it('reads the allowance per troop type and zero for unknown keys', () => {
    assert.equal(movementAllowanceM({ troopType: 'hoplite' }, MOVEMENT), 90);
    assert.equal(movementAllowanceM({ troopType: 'cavalry' }, MOVEMENT), 200);
    assert.equal(movementAllowanceM({ troopType: 'cataphract' }, MOVEMENT), 0);
  });
});

describe('Move legs', () => {
  it('accepts a straight forward move with a deterministic preview', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const result = validateTurn(
      battle,
      submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 560 } }])]),
    );
    const verdict = acceptedVerdict(result);
    assert.deepEqual(verdict.preview.position, { x: 500, y: 560 });
    assert.equal(verdict.preview.facing, 180);
    assert.deepEqual(verdict.preview.corners, [
      { x: 508, y: 560 },
      { x: 492, y: 560 },
      { x: 492, y: 576 },
      { x: 508, y: 576 },
    ]);
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 40 });
  });

  it('accepts up to three legs and a rotation-only leg', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const direct = validateTurn(
      battle,
      submissionFor(battle, [moveOrder(unit.id, [{ face: 270 }])]),
    );
    const turn = acceptedVerdict(direct);
    assert.deepEqual(turn.preview.position, { ...unit.position });
    assert.equal(turn.preview.facing, 270);
    assert.deepEqual(turn.movement, { availableM: 90, requiredM: 12.6 });

    const chained = validateTurn(
      battle,
      submissionFor(battle, [
        moveOrder(unit.id, [
          { face: 180, to: { x: 500, y: 580 } },
          { face: 180, to: { x: 500, y: 560 } },
          { face: 180 },
        ]),
      ]),
    );
    const verdict = acceptedVerdict(chained);
    assert.deepEqual(verdict.preview.position, { x: 500, y: 560 });
    assert.equal(verdict.preview.facing, 180);
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 40 });
  });

  it('accepts a zero-length leg that stays put', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const result = validateTurn(
      battle,
      submissionFor(battle, [moveOrder(unit.id, [{ to: { ...unit.position } }])]),
    );
    const verdict = acceptedVerdict(result);
    assert.deepEqual(verdict.preview.position, { ...unit.position });
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 0 });
  });

  it('rejects malformed legs as invalid_move', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const cases = [
      [{ ...moveOrder(unit.id, undefined), legs: undefined }, 'legs-missing'],
      [moveOrder(unit.id, []), 'no-legs'],
      [moveOrder(unit.id, [{}, {}, {}, {}]), 'too-many-legs'],
      [moveOrder(unit.id, [{}]), 'empty-leg'],
      [moveOrder(unit.id, [{ face: 'north' }]), 'bad-face'],
      [moveOrder(unit.id, [{ to: { x: 1 } }]), 'bad-to'],
    ];
    for (const [order, reason] of cases) {
      const rejection = rejectedVerdict(validateTurn(battle, submissionFor(battle, [order])));
      assert.equal(rejection.code, 'invalid_move');
      assert.deepEqual(rejection.details, { unitId: unit.id, reason });
      assert.ok(typeof rejection.message === 'string' && rejection.message.length > 0);
    }
  });

  it('returns the same preview for the same submission twice', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const submission = submissionFor(battle, [
      moveOrder(unit.id, [{ face: 200, to: { x: 480, y: 540 } }]),
    ]);
    const first = validateTurn(battle, submission);
    const second = validateTurn(battle, submission);
    assert.deepEqual(first.verdicts, second.verdicts);
  });
});

describe('movement billing', () => {
  it('bills oblique moves up to 45 degrees at the full rate', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    // Bearing 225 from facing 180: exactly 45 degrees off front-first.
    const result = validateTurn(
      battle,
      submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 460, y: 560 } }])]),
    );
    assert.deepEqual(acceptedVerdict(result).movement, { availableM: 90, requiredM: 56.6 });
  });

  it('bills steeper, sideways, and backward steps at the reduced rate', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const from = { ...unit.position };
    assert.deepEqual(from, { x: 500, y: 600 });
    // Bearing ~231 degrees: 51 off the facing, so the 64 m step costs double.
    const steep = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 450, y: 560 } }])])),
    );
    assert.equal(steep.code, 'out_of_reach');
    assert.deepEqual(steep.details, { unitId: unit.id, availableM: 90, requiredM: 128.1, shortfallM: 38.1 });

    // Sideways: 60 m east from facing 180 costs 120 m.
    const sideways = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 560, y: 600 } }])])),
    );
    assert.deepEqual(sideways.details, { unitId: unit.id, availableM: 90, requiredM: 120, shortfallM: 30 });

    // Backward: 45 m north costs the whole allowance, 46 m does not fit.
    const backOk = validateTurn(
      battle,
      submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 645 } }])]),
    );
    assert.deepEqual(acceptedVerdict(backOk).movement, { availableM: 90, requiredM: 90 });
    const backFar = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 646 } }])])),
    );
    assert.deepEqual(backFar.details, { unitId: unit.id, availableM: 90, requiredM: 92, shortfallM: 2 });
  });

  it('bills facing changes in proportion to the angle and the frontage', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    // Frontage 16 m: a quarter turn costs 12.6 m.
    const quarter = acceptedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ face: 270 }])])),
    );
    assert.deepEqual(quarter.movement, { availableM: 90, requiredM: 12.6 });
    // An about-face costs twice the quarter turn.
    const about = acceptedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ face: 0 }])])),
    );
    assert.deepEqual(about.movement, { availableM: 90, requiredM: 25.1 });
    // Doubling the frontage doubles the same turn.
    const wide = battle.units.find((entry) => entry.id === unit.id);
    wide.files = 32;
    const wideQuarter = acceptedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ face: 270 }])])),
    );
    assert.deepEqual(wideQuarter.movement, { availableM: 90, requiredM: 25.1 });
  });

  it('adds the turn and the march together against one allowance', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const rejection = rejectedVerdict(
      validateTurn(
        battle,
        submissionFor(battle, [moveOrder(unit.id, [{ face: 270, to: { x: 410, y: 600 } }])]),
      ),
    );
    assert.equal(rejection.code, 'out_of_reach');
    assert.deepEqual(rejection.details, {
      unitId: unit.id,
      availableM: 90,
      requiredM: 102.6,
      shortfallM: 12.6,
    });
  });
});

describe('swept-footprint checks', () => {
  it('rejects a path through another unit as collision with the unit and the point', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const blocker = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    place(battle, blocker.id, { x: 500, y: 550 }, 180);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 540 } }])])),
    );
    assert.equal(rejection.code, 'collision');
    assert.deepEqual(rejection.details, {
      unitId: unit.id,
      withUnitId: blocker.id,
      at: { x: 500, y: 600 },
    });
    assert.ok(rejection.message.includes(blocker.id));
  });

  it('rejects a rotation that sweeps into a neighbour', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const neighbour = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    place(battle, neighbour.id, { x: 520, y: 600 }, 180);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ face: 270 }])])),
    );
    assert.equal(rejection.code, 'collision');
    assert.deepEqual(rejection.details, {
      unitId: unit.id,
      withUnitId: neighbour.id,
      at: { x: 500, y: 600 },
    });
  });

  it('rejects a footprint that leaves the battlefield with the exit point', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 950 } }])])),
    );
    assert.equal(rejection.code, 'battlefield_edge');
    assert.equal(rejection.details.unitId, unit.id);
    const { at } = rejection.details;
    assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y), 'the exit point is a finite point');
    assert.ok(at.y > 900, 'the exit point lies beyond the northern edge');
    assert.ok(typeof rejection.message === 'string' && rejection.message.length > 0);
  });

  it('rejects a wheel that swings a corner outside the battlefield', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    place(battle, unit.id, { x: 1390, y: 600 }, 180);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ face: 270 }])])),
    );
    assert.equal(rejection.code, 'battlefield_edge');
    assert.ok(rejection.details.at.x > 1400, 'the swinging corner crosses the eastern edge');
  });

  it('rejects ending in contact with an enemy but overlaps as collision', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const enemy = foreignUnits(battle).find((entry) => entry.troopType === 'hoplite');
    place(battle, enemy.id, { x: 500, y: 520 }, 0);
    // The front edge stops exactly on the enemy front: contact, not overlap.
    const touch = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 520 } }])])),
    );
    assert.equal(touch.code, 'contact_with_enemy');
    assert.deepEqual(touch.details, { unitId: unit.id, withUnitId: enemy.id });
    // Ten metres further the footprints overlap: collision.
    const overlap = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 510 } }])])),
    );
    assert.equal(overlap.code, 'collision');
    assert.deepEqual(overlap.details, {
      unitId: unit.id,
      withUnitId: enemy.id,
      at: { x: 500, y: 600 },
    });
  });

  it('rejects ending shoulder-to-shoulder with a friend as collision', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const friend = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    // Peltast frontage 18 m at x 750: its western edge is x 741. The hoplite
    // front edge runs through its position, so stopping at x 741 touches it.
    place(battle, friend.id, { x: 750, y: 600 }, 180);
    place(battle, unit.id, { x: 660, y: 600 }, 90);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 741, y: 600 } }])])),
    );
    assert.equal(rejection.code, 'collision');
    assert.equal(rejection.details.withUnitId, friend.id);
  });
});

describe('sequential validation and commit', () => {
  function arrangedBattle() {
    const battle = freshBattle();
    const first = hopliteOf(battle);
    const second = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    place(battle, first.id, { x: 530, y: 600 }, 180);
    place(battle, second.id, { x: 560, y: 600 }, 270);
    return { battle, first, second };
  }

  it('validates each order against the state left by the earlier ones', () => {
    const { battle, first, second } = arrangedBattle();
    const clearFirst = submissionFor(battle, [
      moveOrder(first.id, [{ to: { x: 530, y: 540 } }]),
      moveOrder(second.id, [{ to: { x: 500, y: 600 } }]),
    ]);
    assert.equal(validateTurn(battle, clearFirst).ok, true);

    const blockedFirst = submissionFor(battle, [
      moveOrder(second.id, [{ to: { x: 500, y: 600 } }]),
      moveOrder(first.id, [{ to: { x: 530, y: 540 } }]),
    ]);
    const result = validateTurn(battle, blockedFirst);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'orders_rejected');
    assert.equal(result.verdicts[0].accepted, false);
    assert.equal(result.verdicts[0].rejection.code, 'collision');
    assert.equal(result.verdicts[0].rejection.details.withUnitId, first.id);
    assert.equal(result.verdicts[1].accepted, true);
  });

  it('commits accepted moves in the given order with move events', () => {
    const { battle, first, second } = arrangedBattle();
    const submission = submissionFor(battle, [
      moveOrder(first.id, [{ to: { x: 530, y: 540 } }]),
      moveOrder(second.id, [{ to: { x: 500, y: 600 } }]),
    ]);
    const next = resolveTurn(battle, { type: 'commit', submission });
    const movedFirst = next.units.find((entry) => entry.id === first.id);
    const movedSecond = next.units.find((entry) => entry.id === second.id);
    assert.deepEqual(movedFirst.position, { x: 530, y: 540 });
    assert.deepEqual(movedSecond.position, { x: 500, y: 600 });
    const moved = next.events.filter((event) => event.type === 'unit-moved');
    assert.equal(moved.length, 2);
    assert.deepEqual(moved.map((event) => event.unitId), [first.id, second.id]);
    assert.equal(next.turnNumber, battle.turnNumber + 1);
  });

  it('refuses a commit when any move is rejected and changes nothing', () => {
    const { battle, first, second } = arrangedBattle();
    const before = JSON.stringify(battle);
    const submission = submissionFor(battle, [
      moveOrder(second.id, [{ to: { x: 500, y: 600 } }]),
      moveOrder(first.id, [{ to: { x: 530, y: 540 } }]),
    ]);
    assert.throws(() => resolveTurn(battle, { type: 'commit', submission }), TurnRejectedError);
    assert.equal(JSON.stringify(battle), before);
  });

  it('previews a Hold at the current footprint', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const result = validateTurn(battle, submissionFor(battle, [{ unitId: unit.id, kind: 'Hold' }]));
    const verdict = acceptedVerdict(result);
    assert.deepEqual(verdict.preview.position, { ...unit.position });
    assert.equal(verdict.preview.facing, unit.facing);
    assert.equal(verdict.preview.corners.length, 4);
  });
});

describe('available actions', () => {
  it('permits Move with the allowance in metres per troop type', () => {
    const battle = freshBattle();
    const actions = availableActions(battle, battle.activeSide);
    const hoplite = ownUnits(battle).find((entry) => entry.troopType === 'hoplite');
    const cavalry = battle.units
      .filter((entry) => entry.side === battle.activeSide)
      .find((entry) => entry.troopType === 'cavalry');
    const hopliteActions = actions.units.find((entry) => entry.unitId === hoplite.id);
    assert.deepEqual(hopliteActions.permitted, [{ kind: 'Hold' }, { kind: 'Move' }]);
    assert.equal(hopliteActions.movementAllowanceM, 90);
    assert.deepEqual(
      hopliteActions.unavailable.map((entry) => entry.kind).sort(),
      ['Charge', 'Shoot'],
    );
    if (cavalry) {
      const cavalryActions = actions.units.find((entry) => entry.unitId === cavalry.id);
      assert.equal(cavalryActions.movementAllowanceM, 200);
    }
  });
});

describe('pure move planning', () => {
  function field(extra = {}) {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    return {
      battle,
      unit,
      args: {
        unit,
        from: { position: { ...unit.position }, facing: unit.facing },
        legs: [{ to: { x: 500, y: 560 } }],
        params: MOVEMENT,
        battlefield: { ...battle.scenario.battlefield },
        others: [],
        orderIndex: 0,
        ...extra,
      },
    };
  }

  it('plans a move without other units', () => {
    const { args } = field();
    const planned = validateMoveOnField(args);
    assert.equal(planned.ok, true);
    assert.deepEqual(planned.preview.position, { x: 500, y: 560 });
    assert.equal(planned.requiredM, 40);
    assert.equal(planned.availableM, 90);
  });

  it('reports the first touch in battlefield order', () => {
    const { battle, unit, args } = field();
    const blocker = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    place(battle, blocker.id, { x: 500, y: 550 }, 180);
    const planned = validateMoveOnField({
      ...args,
      others: battle.units
        .filter((entry) => entry.id !== unit.id)
        .map((entry) => ({
          id: entry.id,
          side: entry.side,
          corners: entry.id === blocker.id
            ? [
              { x: 509, y: 550 },
              { x: 491, y: 550 },
              { x: 491, y: 565 },
              { x: 509, y: 565 },
            ]
            : [],
        }))
        .filter((entry) => entry.corners.length > 0),
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'collision');
    assert.equal(planned.details.withUnitId, blocker.id);
  });
});
