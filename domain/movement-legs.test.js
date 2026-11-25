// Unit tests for Move orders: leg mechanics, cost billing, and
// swept-footprint checks. Split from `domain/movement.test.js` (issue #142);
// sequential validation and terrain live in `domain/movement-field.test.js`.
// Shared fixtures live in `domain/movement-test-helpers.js`.
// Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTurn } from './turn.js';
import {
  MAX_MOVE_LEGS,
  convexHull,
  displacementBearing,
  movementAllowanceM,
  normalizeFacing,
  signedAngleDiff,
} from './movement.js';
import {
  MOVEMENT,
  freshBattle,
  submissionFor,
  ownUnits,
  foreignUnits,
  hopliteOf,
  moveOrder,
  place,
  acceptedVerdict,
  rejectedVerdict,
} from './movement-test-helpers.js';

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
      at: { x: 500, y: 565 },
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
    assert.deepEqual(rejection.details, { unitId: unit.id, at: { x: 492, y: 901 } });
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
    assert.deepEqual(rejection.details, { unitId: unit.id, at: { x: 1400.1, y: 614.7 } });
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
    // Ten metres further the footprints overlap: collision at the first touch.
    const overlap = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 510 } }])])),
    );
    assert.equal(overlap.code, 'collision');
    assert.deepEqual(overlap.details, {
      unitId: unit.id,
      withUnitId: enemy.id,
      at: { x: 500, y: 520 },
    });
  });

  it('lets a unit deployed touching a friend march away', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const friend = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    // Peltast front edge on the hoplite rear edge: legal setup adjacency.
    place(battle, friend.id, { x: 500, y: 616 }, 180);
    const result = validateTurn(
      battle,
      submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 560 } }])]),
    );
    assert.deepEqual(acceptedVerdict(result).movement, { availableM: 90, requiredM: 40 });
  });

  it('rejects sliding along an adjacent friend as collision', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    const friend = ownUnits(battle).find((entry) => entry.troopType === 'peltast');
    // Peltast western edge on the hoplite eastern edge: shoulder-to-shoulder.
    place(battle, friend.id, { x: 517, y: 600 }, 180);
    place(battle, unit.id, { x: 500, y: 600 }, 90);
    const rejection = rejectedVerdict(
      validateTurn(
        battle,
        submissionFor(battle, [moveOrder(unit.id, [{ face: 90, to: { x: 560, y: 600 } }])]),
      ),
    );
    assert.equal(rejection.code, 'collision');
    assert.equal(rejection.details.withUnitId, friend.id);
    assert.deepEqual(rejection.details.at, { x: 508, y: 600 });
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
