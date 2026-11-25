// Engine I acceptance gate (#27): one case per Engine I rejection code
// with the expected `details`. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateTurn } from './turn.js';
import { validateWithdrawOnField } from './withdraw.js';
import {
  HOPLITE_A,
  HOPLITE_B,
  PELT_A,
  engage,
  freshBattle,
  parkOthers,
  place,
  rejectedVerdict,
  submissionFor,
  validateOne,
} from './engine-gate-helpers.js';

describe('Engine I rejection codes with the expected details', () => {
  it('unknown_unit names the missing unit', () => {
    const battle = freshBattle();
    const rejection = rejectedVerdict(validateOne(battle, { unitId: 'missing-unit', kind: 'Hold' }));
    assert.equal(rejection.code, 'unknown_unit');
    assert.deepEqual(rejection.details, { unitId: 'missing-unit' });
  });

  it('not_own_unit names the unit and both sides', () => {
    const battle = freshBattle();
    const foreign = battle.units.find((unit) => unit.side !== battle.activeSide);
    const rejection = rejectedVerdict(validateOne(battle, { unitId: foreign.id, kind: 'Hold' }));
    assert.equal(rejection.code, 'not_own_unit');
    assert.deepEqual(rejection.details, {
      unitId: foreign.id,
      ownerSide: foreign.side,
      submittingSide: battle.activeSide,
    });
  });

  it('duplicate_unit_order names the unit and the first order', () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const result = validateTurn(battle, submissionFor(battle, [
      { unitId: own[0].id, kind: 'Hold' },
      { unitId: own[0].id, kind: 'Hold' },
    ]));
    const rejection = rejectedVerdict(result, 1);
    assert.equal(rejection.code, 'duplicate_unit_order');
    assert.deepEqual(rejection.details, { unitId: own[0].id, firstOrderIndex: 0 });
  });

  it('unsupported_order_kind names the unit and the kind', () => {
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const rejection = rejectedVerdict(validateOne(battle, { unitId: own[0].id, kind: 'Teleport' }));
    assert.equal(rejection.code, 'unsupported_order_kind');
    assert.deepEqual(rejection.details, { unitId: own[0].id, kind: 'Teleport' });
  });

  it('invalid_move names the unit and the reason', () => {
    const battle = freshBattle();
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [] }));
    assert.equal(rejection.code, 'invalid_move');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'no-legs' });
  });

  it('invalid_move refuses more legs than the ruleset allows', () => {
    const battle = freshBattle();
    const legs = [1, 2, 3, 4].map((step) => ({ to: { x: 500 + step, y: 610 } }));
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs }));
    assert.equal(rejection.code, 'invalid_move');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'too-many-legs' });
  });

  it('collision names the unit, the other unit, and the touch point', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, PELT_A, { x: 500, y: 650 }, 0);
    parkOthers(battle, [HOPLITE_A, PELT_A]);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 660 } }] }),
    );
    assert.equal(rejection.code, 'collision');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      withUnitId: PELT_A,
      at: { x: 500, y: 635 },
    });
  });

  it('battlefield_edge names the unit and the exit point', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    parkOthers(battle, [HOPLITE_A]);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 950 } }] }),
    );
    assert.equal(rejection.code, 'battlefield_edge');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, at: { x: 492, y: 901 } });
  });

  it('forbidden_ground names the water feature and the touch point', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    parkOthers(battle, [HOPLITE_A]);
    battle.scenario.terrainFeatures.push({
      id: 'pond-test',
      kind: 'ground',
      category: 'water',
      polygon: [{ x: 480, y: 640 }, { x: 520, y: 640 }, { x: 520, y: 680 }, { x: 480, y: 680 }],
    });
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 660 } }] }),
    );
    assert.equal(rejection.code, 'forbidden_ground');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      featureId: 'pond-test',
      groundCover: 'water',
      at: { x: 500, y: 640 },
    });
  });

  it('out_of_reach names the allowance, the requirement, and the shortfall', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    parkOthers(battle, [HOPLITE_A]);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 700 } }] }),
    );
    assert.equal(rejection.code, 'out_of_reach');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      availableM: 90,
      requiredM: 100,
      shortfallM: 10,
    });
  });

  it('contact_with_enemy names the unit and the enemy', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, HOPLITE_B, { x: 500, y: 660 }, 180);
    parkOthers(battle, [HOPLITE_A, HOPLITE_B]);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 660 } }] }),
    );
    assert.equal(rejection.code, 'contact_with_enemy');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, withUnitId: HOPLITE_B });
  });

  it('order_not_permitted refuses a Move for an engaged unit', () => {
    const battle = freshBattle();
    engage(battle, HOPLITE_A, HOPLITE_B);
    const rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 610 } }] }),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      reason: 'engaged',
      permitted: ['Hold', 'Withdraw'],
    });
  });

  it('order_not_permitted refuses a Charge for a disordered unit', () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.cohesion = 'Disordered';
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, HOPLITE_B, { x: 500, y: 660 }, 180);
    parkOthers(battle, [HOPLITE_A, HOPLITE_B]);
    const rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: HOPLITE_B, edge: 'front', approach: [],
    }));
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'disordered' });
  });

  it('order_not_permitted refuses everything but Rally for a routed unit', () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.cohesion = 'Routed';
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Move', legs: [{ to: { x: 500, y: 610 } }] }));
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'routed', permitted: ['Rally'] });
  });

  it('order_not_permitted refuses a Withdraw for a unit that is not engaged', () => {
    const battle = freshBattle();
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Withdraw' }));
    assert.equal(rejection.code, 'order_not_permitted');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      reason: 'not-engaged',
      permitted: ['Hold', 'Move', 'Charge', 'Reform'],
    });
  });

  it('outside_front_arc names the charger and the target', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, HOPLITE_B, { x: 500, y: 300 }, 0);
    parkOthers(battle, [HOPLITE_A, HOPLITE_B]);
    const rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: HOPLITE_B, edge: 'front', approach: [],
    }));
    assert.equal(rejection.code, 'outside_front_arc');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, targetId: HOPLITE_B });
  });

  it('invalid_charge names a bad edge, an unknown target, and a friendly target', () => {
    const battle = freshBattle();
    place(battle, HOPLITE_A, { x: 500, y: 600 }, 0);
    place(battle, HOPLITE_B, { x: 500, y: 660 }, 180);
    parkOthers(battle, [HOPLITE_A, HOPLITE_B, PELT_A]);
    let rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: HOPLITE_B, edge: 'top', approach: [],
    }));
    assert.equal(rejection.code, 'invalid_charge');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, targetId: HOPLITE_B, reason: 'bad-edge' });

    rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: 'missing-unit', edge: 'front', approach: [],
    }));
    assert.equal(rejection.code, 'invalid_charge');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'unknown-target' });

    rejection = rejectedVerdict(validateOne(battle, {
      unitId: HOPLITE_A, kind: 'Charge', targetId: PELT_A, edge: 'front', approach: [],
    }));
    assert.equal(rejection.code, 'invalid_charge');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, targetId: PELT_A, reason: 'not-enemy' });
  });

  it('invalid_formation names an empty reform, bad files, and an out-of-range spacing', () => {
    const battle = freshBattle();
    let rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Reform' }));
    assert.equal(rejection.code, 'invalid_formation');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'no-change' });

    rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Reform', files: 9999 }));
    assert.equal(rejection.code, 'invalid_formation');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'bad-files' });

    rejection = rejectedVerdict(
      validateOne(battle, { unitId: HOPLITE_A, kind: 'Reform', lateralInterval: 99 }),
    );
    assert.equal(rejection.code, 'invalid_formation');
    assert.deepEqual(rejection.details, {
      unitId: HOPLITE_A,
      reason: 'spacing-out-of-range',
      field: 'lateralInterval',
      value: 99,
      range: { min: 0.7, max: 4 },
    });
  });

  it('invalid_formation names an unknown troop type', () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    unit.troopType = 'bogus-type';
    const rejection = rejectedVerdict(validateOne(battle, { unitId: HOPLITE_A, kind: 'Reform', files: 8 }));
    assert.equal(rejection.code, 'invalid_formation');
    assert.deepEqual(rejection.details, { unitId: HOPLITE_A, reason: 'unknown-troop-type' });
  });

  it('invalid_withdraw reaches the contract when a contact names no enemy to break', () => {
    // The contract gates Withdraw for units that are not engaged, so a real
    // game never reaches the module's `invalid_withdraw`: only a degenerate
    // contact (one with no enemy to break from) falls through to it.
    const battle = freshBattle();
    const own = battle.units.filter((unit) => unit.side === battle.activeSide);
    const unit = own[0];
    unit.engaged = { unitId: own[1].id, edge: 'front', aspect: 'front', frontageM: 8, files: 8 };
    const rejection = rejectedVerdict(validateOne(battle, { unitId: unit.id, kind: 'Withdraw' }));
    assert.equal(rejection.code, 'invalid_withdraw');
    assert.deepEqual(rejection.details, { unitId: unit.id, reason: 'not-engaged' });
  });

  it('invalid_withdraw names a missing engagement and a missing pose', () => {
    const battle = freshBattle();
    const unit = battle.units.find((entry) => entry.id === HOPLITE_A);
    const battlefield = battle.scenario.battlefield;
    let planned = validateWithdrawOnField({
      unit,
      from: { position: { ...unit.position }, facing: unit.facing },
      brokenIds: [],
      params: battle.parameters.movement,
      withdrawParams: battle.parameters.withdraw,
      battlefield,
      others: [],
      terrainFeatures: [],
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'invalid_withdraw');
    assert.deepEqual(planned.details, { unitId: HOPLITE_A, reason: 'not-engaged' });

    planned = validateWithdrawOnField({
      unit,
      from: { position: null, facing: unit.facing },
      brokenIds: [HOPLITE_B],
      params: battle.parameters.movement,
      withdrawParams: battle.parameters.withdraw,
      battlefield,
      others: [],
      terrainFeatures: [],
    });
    assert.equal(planned.ok, false);
    assert.equal(planned.code, 'invalid_withdraw');
    assert.deepEqual(planned.details, { unitId: HOPLITE_A, reason: 'bad-pose' });
  });

  it('whole-submission refusals carry their code and no verdicts', () => {
    const battle = freshBattle();
    let result = validateTurn(battle, submissionFor(battle, [], { turnNumber: battle.turnNumber + 1 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'stale_turn');
    assert.deepEqual(result.verdicts, []);

    const idle = battle.scenario.sides.map((side) => side.id).find((id) => id !== battle.activeSide);
    result = validateTurn(battle, submissionFor(battle, [], { side: idle }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_active_side');
    assert.deepEqual(result.verdicts, []);

    result = validateTurn(battle, submissionFor(battle, [], { battleId: 'elsewhere' }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unknown_battle');
    assert.deepEqual(result.verdicts, []);
  });
});
