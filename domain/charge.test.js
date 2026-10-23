// Unit tests for Charge orders: flush contact against a named edge.
//
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
  buildPlayerView,
  resolveTurn,
  validateTurn,
} from './turn.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const scenarioDir = path.join(here, 'fixtures');

function loadReference() {
  return JSON.parse(readFileSync(path.join(scenarioDir, 'acceptance-plain.json'), 'utf8'));
}

function freshBattle(seed = 2026) {
  const stored = loadReference();
  const controllers = {
    [stored.sides[0].id]: 'passive',
    [stored.sides[1].id]: 'passive',
  };
  const battle = startBattle(stored, { seed, controllers });
  assert.equal(battle.activeSide, 'athens');
  return battle;
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

function chargeOrder(unitId, targetId, edge, approach = []) {
  return { unitId, kind: 'Charge', targetId, edge, approach };
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

// A charger facing south at (500, 600) and an enemy facing north at
// (500, 540): a straight 60 m charge at the target's front.
function arrangedFrontCharge() {
  const battle = freshBattle();
  const charger = hopliteOf(battle);
  const target = foreignUnits(battle).find((unit) => unit.troopType === 'hoplite');
  place(battle, charger.id, { x: 500, y: 600 }, 180);
  place(battle, target.id, { x: 500, y: 540 }, 0);
  // Park everyone else far away so only the arranged footprints interact.
  for (const unit of battle.units) {
    if (unit.id !== charger.id && unit.id !== target.id) {
      place(battle, unit.id, { x: 100, y: 100 }, 0);
    }
  }
  return { battle, charger, target };
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

describe('charge contact', () => {
  it('ends flush against the named edge with the contact recorded', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    const result = validateTurn(
      battle,
      submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')]),
    );
    const verdict = acceptedVerdict(result);
    assert.deepEqual(verdict.preview.position, { x: 500, y: 540 });
    assert.equal(verdict.preview.facing, 180);
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 60 });
    assert.deepEqual(verdict.charge, {
      targetId: target.id,
      edge: 'front',
      aspect: 'front',
      frontageM: 16,
      fightingFiles: 16,
    });
  });

  it('turns parallel to a flank edge and records the flank aspect', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    // The charger stands west of the target facing east; the target's left
    // edge (its western edge) is the near flank.
    place(battle, charger.id, { x: 440, y: 552 }, 90);
    const result = validateTurn(
      battle,
      submissionFor(battle, [chargeOrder(charger.id, target.id, 'left')]),
    );
    const verdict = acceptedVerdict(result);
    // The target (320 soldiers in 16 files: 20 ranks deep) spans y 520-540; its
    // left edge runs north from (492, 520) to (492, 540); the
    // charger faces east (90) with its front midpoint projected onto it.
    assert.equal(verdict.preview.facing, 90);
    assert.deepEqual(verdict.preview.position, { x: 492, y: 540 });
    assert.equal(verdict.charge.edge, 'left');
    assert.equal(verdict.charge.aspect, 'flank');
    assert.equal(verdict.charge.frontageM, 8);
  });

  it('turns parallel to the rear edge and records the rear aspect', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    // A rear charge approaches from behind the target: the charger stands
    // south of the target facing north, like the target itself.
    place(battle, charger.id, { x: 500, y: 500 }, 0);
    place(battle, target.id, { x: 500, y: 560 }, 0);
    const result = validateTurn(
      battle,
      submissionFor(battle, [chargeOrder(charger.id, target.id, 'rear')]),
    );
    const verdict = acceptedVerdict(result);
    assert.equal(verdict.preview.facing, 0);
    assert.equal(verdict.charge.aspect, 'rear');
    // The target (320 soldiers in 16 files: 20 ranks deep) spans y 540-560,
    // so its rear edge lies at y 540.
    assert.deepEqual(verdict.preview.position, { x: 500, y: 540 });
  });

  it('rejects a target outside the ±45° front arc', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    place(battle, target.id, { x: 100, y: 540 }, 0);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')])),
    );
    assert.equal(rejection.code, 'outside_front_arc');
    assert.deepEqual(rejection.details, { unitId: charger.id, targetId: target.id });
  });

  it('rejects malformed charge parameters as invalid_charge', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    const cases = [
      [{ ...chargeOrder(charger.id, target.id, 'front'), edge: 'top' }, 'bad-edge'],
      [{ ...chargeOrder(charger.id, target.id, 'front'), targetId: 'missing' }, 'unknown-target'],
      [{ ...chargeOrder(charger.id, target.id, 'front'), approach: [{}, {}, {}] }, 'too-many-legs'],
      [{ ...chargeOrder(charger.id, charger.id, 'front') }, 'not-enemy'],
    ];
    for (const [order, reason] of cases) {
      const rejection = rejectedVerdict(validateTurn(battle, submissionFor(battle, [order])));
      assert.equal(rejection.code, 'invalid_charge');
      assert.equal(rejection.details.reason, reason);
    }
  });

  it('rejects a charge that does not fit the allowance as out_of_reach', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    place(battle, target.id, { x: 500, y: 480 }, 0);
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')])),
    );
    assert.equal(rejection.code, 'out_of_reach');
    assert.equal(rejection.details.unitId, charger.id);
    assert.equal(rejection.details.availableM, 90);
    assert.ok(rejection.details.requiredM > 90);
  });
});

describe('charge permission gates', () => {
  it('refuses a Disordered charger with order_not_permitted', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    charger.cohesion = 'Disordered';
    const rejection = rejectedVerdict(
      validateTurn(battle, submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')])),
    );
    assert.equal(rejection.code, 'order_not_permitted');
    assert.equal(rejection.details.reason, 'disordered');
  });

  it('refuses Move and Charge for an engaged unit, but accepts Hold', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    const committed = resolveTurn(
      battle,
      {
        type: 'commit',
        submission: submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')]),
      },
    );
    const next = { ...committed, turnNumber: battle.turnNumber, activeSide: battle.activeSide };
    const moveRejection = rejectedVerdict(
      validateTurn(next, submissionFor(next, [{ unitId: charger.id, kind: 'Move', legs: [{ to: { x: 500, y: 560 } }] }])),
    );
    assert.equal(moveRejection.code, 'order_not_permitted');
    assert.equal(moveRejection.details.reason, 'engaged');
    const chargeRejection = rejectedVerdict(
      validateTurn(next, submissionFor(next, [chargeOrder(charger.id, target.id, 'rear')])),
    );
    assert.equal(chargeRejection.code, 'order_not_permitted');
    assert.equal(chargeRejection.details.reason, 'engaged');
    const hold = validateTurn(next, submissionFor(next, [{ unitId: charger.id, kind: 'Hold' }]));
    assert.equal(hold.ok, true);
  });

  it('refuses everything but Rally for a routed unit', () => {
    const { battle, charger } = arrangedFrontCharge();
    charger.cohesion = 'Routed';
    for (const order of [{ unitId: charger.id, kind: 'Hold' }, { unitId: charger.id, kind: 'Move', legs: [{ to: { x: 500, y: 590 } }] }]) {
      const rejection = rejectedVerdict(validateTurn(battle, submissionFor(battle, [order])));
      assert.equal(rejection.code, 'order_not_permitted');
      assert.equal(rejection.details.reason, 'routed');
    }
  });
});

describe('charge resolution', () => {
  it('marks both units engaged and shows it in the player view', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    const next = resolveTurn(
      battle,
      {
        type: 'commit',
        submission: submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')]),
      },
    );
    const moved = next.units.find((unit) => unit.id === charger.id);
    const engaged = next.units.find((unit) => unit.id === target.id);
    assert.deepEqual(moved.position, { x: 500, y: 540 });
    assert.equal(moved.facing, 180);
    assert.deepEqual(moved.engaged, {
      unitId: target.id,
      edge: 'front',
      aspect: 'front',
      frontageM: 16,
      files: 16,
    });
    assert.deepEqual(engaged.engaged, {
      unitId: charger.id,
      edge: 'front',
      aspect: 'front',
      frontageM: 16,
      files: 16,
    });
    const view = buildPlayerView(next);
    const viewedCharger = view.units.find((unit) => unit.id === charger.id);
    const viewedTarget = view.units.find((unit) => unit.id === target.id);
    assert.equal(viewedCharger.engaged.unitId, target.id);
    assert.equal(viewedCharger.engaged.edge, 'front');
    assert.equal(viewedTarget.engaged.unitId, charger.id);
    assert.equal(viewedTarget.engaged.edge, 'front');
    assert.ok(next.events.some((event) => event.type === 'unit-charged'));
  });

  it('accepts several charges against the same target, in order', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    const second = ownUnits(battle).find((unit) => unit.troopType === 'peltast');
    // A second charger south-east of the target takes the right flank while
    // the hoplite takes the front.
    place(battle, second.id, { x: 620, y: 470 }, 270);
    const result = validateTurn(
      battle,
      submissionFor(battle, [
        chargeOrder(charger.id, target.id, 'front'),
        chargeOrder(second.id, target.id, 'right'),
      ]),
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(result.verdicts.every((verdict) => verdict.accepted));
  });

  it('reproduces the #7 example flow: order decides collision or acceptance', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    const blocker = ownUnits(battle).find((unit) => unit.troopType === 'cavalry');
    place(battle, blocker.id, { x: 650, y: 572 }, 270);
    const blocking = { unitId: blocker.id, kind: 'Move', legs: [{ to: { x: 500, y: 572 } }] };
    const charge = chargeOrder(charger.id, target.id, 'front');
    const blocked = validateTurn(battle, submissionFor(battle, [blocking, charge]));
    assert.equal(blocked.ok, false);
    assert.equal(blocked.verdicts[0].accepted, true);
    assert.equal(blocked.verdicts[1].accepted, false);
    assert.equal(blocked.verdicts[1].rejection.code, 'collision');
    const reordered = validateTurn(battle, submissionFor(battle, [charge, blocking]));
    assert.equal(reordered.ok, true, JSON.stringify(reordered));
  });
});

describe('available actions with charge', () => {
  it('lists charge candidates as hints with the contact preview', () => {
    const { battle, charger } = arrangedFrontCharge();
    const actions = availableActions(battle, battle.activeSide);
    const entry = actions.units.find((unit) => unit.unitId === charger.id);
    assert.ok(entry.permitted.some((item) => item.kind === 'Charge'));
    assert.ok(entry.chargeCandidates.length > 0);
    const candidate = entry.chargeCandidates[0];
    assert.ok(candidate.targetId && candidate.edge && candidate.aspect);
  });

  it('reports engaged and routed limits in the available actions', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    const committed = resolveTurn(
      battle,
      {
        type: 'commit',
        submission: submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')]),
      },
    );
    const next = { ...committed, turnNumber: battle.turnNumber, activeSide: battle.activeSide };
    const actions = availableActions(next, next.activeSide);
    const entry = actions.units.find((unit) => unit.unitId === charger.id);
    assert.deepEqual(entry.permitted, [{ kind: 'Hold' }, { kind: 'Withdraw' }]);
    const refused = entry.unavailable.find((item) => item.kind === 'Charge');
    assert.equal(refused.code, 'order_not_permitted');
  });

  it('refuses a commit when any charge is rejected and changes nothing', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    place(battle, target.id, { x: 100, y: 540 }, 0);
    const before = JSON.stringify(battle);
    const submission = submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')]);
    assert.throws(() => resolveTurn(battle, { type: 'commit', submission }), TurnRejectedError);
    assert.equal(JSON.stringify(battle), before);
  });
});

describe('charge terrain and arc rules', () => {
  function groundRect(id, category, minX, minY, maxX, maxY) {
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

  it('refuses a charge through water as forbidden_ground, as for Move', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    battle.scenario.terrainFeatures = [groundRect('water-a', 'water', 480, 550, 520, 590)];
    const result = validateTurn(
      battle,
      submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')]),
    );
    const rejection = rejectedVerdict(result);
    assert.equal(rejection.code, 'forbidden_ground');
    assert.equal(rejection.details.featureId, 'water-a');
  });

  it('bills rough ground on the march, as for Move', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    place(battle, target.id, { x: 500, y: 570 }, 0);
    battle.scenario.terrainFeatures = [groundRect('forest-a', 'forest', 400, 540, 600, 620)];
    const result = validateTurn(
      battle,
      submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')]),
    );
    const verdict = acceptedVerdict(result);
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 75 });
  });

  it('pays the river fee for a crossing, as for Move', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    battle.scenario.terrainFeatures = [{
      id: 'river-test',
      kind: 'linear',
      category: 'river',
      path: [{ x: 440, y: 580 }, { x: 560, y: 580 }],
      width: 6,
    }];
    const result = validateTurn(
      battle,
      submissionFor(battle, [chargeOrder(charger.id, target.id, 'front')]),
    );
    const verdict = acceptedVerdict(result);
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 90 });
  });

  it('honours the ruleset front-arc override', () => {
    const { battle, charger, target } = arrangedFrontCharge();
    // About 40° off the charger's facing: inside the default ±45° arc.
    place(battle, target.id, { x: 538.6, y: 554 }, 0);
    const charge = chargeOrder(charger.id, target.id, 'front');
    const accepted = validateTurn(battle, submissionFor(battle, [charge]));
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    battle.parameters.movement.forwardArcDeg = 10;
    const narrowed = validateTurn(battle, submissionFor(battle, [charge]));
    assert.equal(narrowed.ok, false);
    assert.equal(narrowed.verdicts[0].rejection.code, 'outside_front_arc');
  });
});
