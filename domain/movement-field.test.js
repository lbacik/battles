// Unit tests for Move orders: sequential validation and commit, available
// actions, pure move planning, and terrain effects (decision #6 items 14-15).
// Split from `domain/movement.test.js` (issue #142); leg mechanics live in
// `domain/movement-legs.test.js`. Shared fixtures live in
// `domain/movement-test-helpers.js`. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TurnRejectedError,
  availableActions,
  resolveTurn,
  validateTurn,
} from './turn.js';
import {
  footprintTouchesPath,
  groundCoverAt,
  movementAllowanceM,
  terrainFactorAt,
  validateMoveOnField,
} from './movement.js';
import { round1 } from './geometry.js';
import {
  MOVEMENT,
  freshBattle,
  submissionFor,
  ownUnits,
  hopliteOf,
  moveOrder,
  place,
  acceptedVerdict,
  rejectedVerdict,
} from './movement-test-helpers.js';

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
    assert.deepEqual(hopliteActions.permitted, [{ kind: 'Hold' }, { kind: 'Move' }, { kind: 'Charge' }, { kind: 'Reform' }]);
    assert.equal(hopliteActions.movementAllowanceM, 90);
    assert.deepEqual(
      hopliteActions.unavailable.map((entry) => entry.kind).sort(),
      ['Rally', 'Shoot'],
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

describe('terrain effects on movement (decision #6 items 14-15)', () => {
  const TERRAIN = MOVEMENT.terrain;
  assert.ok(TERRAIN.roughFactor > 1, 'rough slows movement');
  assert.ok(TERRAIN.forestFactor > TERRAIN.roughFactor, 'forest slows much more than rough');
  assert.ok(TERRAIN.roadFactor < 1, 'road speeds movement');
  assert.ok(Number.isInteger(TERRAIN.columnMaxFiles), 'column is files at or below a parameter');

  function terrainBattle(features) {
    const battle = freshBattle();
    battle.scenario.terrainFeatures = features;
    return battle;
  }

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

  function roadAlongX500(id = 'road-test') {
    return {
      id,
      kind: 'linear',
      category: 'road',
      path: [{ x: 500, y: 640 }, { x: 500, y: 520 }],
      width: 6,
    };
  }

  function riverAcross(id = 'river-test') {
    return {
      id,
      kind: 'linear',
      category: 'river',
      path: [{ x: 440, y: 580 }, { x: 560, y: 580 }],
      width: 6,
    };
  }

  function moveSouth(battle) {
    const unit = hopliteOf(battle);
    return validateTurn(battle, submissionFor(battle, [moveOrder(unit.id, [{ to: { x: 500, y: 560 } }])]));
  }

  it('bills rough ground slower than open ground', () => {
    const battle = terrainBattle([groundRect('rough-a', 'rough', 400, 540, 600, 620)]);
    const verdict = acceptedVerdict(moveSouth(battle));
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 60 });
  });

  it('bills forest much slower than rough ground', () => {
    const battle = terrainBattle([groundRect('forest-a', 'forest', 400, 540, 600, 620)]);
    const rejection = rejectedVerdict(moveSouth(battle));
    assert.equal(rejection.code, 'out_of_reach');
    assert.deepEqual(rejection.details, { unitId: hopliteOf(battle).id, availableM: 90, requiredM: 100, shortfallM: 10 });
  });

  it('treats settlement as forest', () => {
    const battle = terrainBattle([groundRect('town-a', 'settlement', 400, 540, 600, 620)]);
    const rejection = rejectedVerdict(moveSouth(battle));
    assert.equal(rejection.code, 'out_of_reach');
    assert.deepEqual(rejection.details.requiredM, 100);
  });

  it('applies the worst ground cover the footprint touches', () => {
    const battle = freshBattle();
    const unit = hopliteOf(battle);
    battle.scenario.terrainFeatures = [
      groundRect('rough-a', 'rough', 400, 540, 600, 650),
      groundRect('forest-a', 'forest', 480, 590, 520, 630),
    ];
    const actions = availableActions(battle, battle.activeSide);
    const entry = actions.units.find((item) => item.unitId === unit.id);
    // The footprint (y 600-616) touches both rough and forest: forest wins.
    assert.equal(entry.movementAllowanceM, 36);
    assert.equal(
      groundCoverAt(
        [{ x: 492, y: 600 }, { x: 508, y: 600 }, { x: 508, y: 616 }, { x: 492, y: 616 }],
        battle.scenario.terrainFeatures,
      ),
      'forest',
    );
  });

  it('accumulates cost along a leg that crosses terrain boundaries', () => {
    const allRough = terrainBattle([groundRect('rough-a', 'rough', 400, 540, 600, 620)]);
    const allForest = terrainBattle([groundRect('forest-a', 'forest', 400, 540, 600, 620)]);
    const mixed = terrainBattle([
      groundRect('rough-a', 'rough', 400, 580, 600, 620),
      groundRect('forest-a', 'forest', 400, 540, 600, 580),
    ]);
    const roughRequired = acceptedVerdict(moveSouth(allRough)).movement.requiredM;
    const mixedRequired = acceptedVerdict(moveSouth(mixed)).movement.requiredM;
    assert.equal(roughRequired, 60);
    // Half the march bills rough, half bills forest: strictly between the two.
    assert.ok(mixedRequired > roughRequired, `mixed ${mixedRequired} exceeds rough ${roughRequired}`);
    assert.ok(mixedRequired < 100, `mixed ${mixedRequired} stays below all-forest 100`);
  });

  it('speeds a unit in column on a road and ignores the road out of column', () => {
    const lineBattle = terrainBattle([roadAlongX500()]);
    const lineVerdict = acceptedVerdict(moveSouth(lineBattle));
    // The hoplite marches 16 files wide: out of column, the road is ignored.
    assert.deepEqual(lineVerdict.movement, { availableM: 90, requiredM: 40 });

    const columnBattle = terrainBattle([roadAlongX500()]);
    const columnUnit = hopliteOf(columnBattle);
    columnUnit.files = TERRAIN.columnMaxFiles;
    const columnVerdict = acceptedVerdict(moveSouth(columnBattle));
    assert.deepEqual(columnVerdict.movement, {
      availableM: 90,
      requiredM: round1(40 * TERRAIN.roadFactor),
    });
    assert.ok(columnVerdict.movement.requiredM < 40, 'road speeds a column');
  });

  it('lets a road win over bad ground only in column', () => {
    const features = [
      groundRect('forest-a', 'forest', 400, 540, 600, 620),
      roadAlongX500(),
    ];
    const lineBattle = terrainBattle(structuredClone(features));
    const lineRejection = rejectedVerdict(moveSouth(lineBattle));
    assert.equal(lineRejection.code, 'out_of_reach');
    assert.equal(lineRejection.details.requiredM, 100);

    const columnBattle = terrainBattle(structuredClone(features));
    hopliteOf(columnBattle).files = TERRAIN.columnMaxFiles;
    const columnVerdict = acceptedVerdict(moveSouth(columnBattle));
    assert.deepEqual(columnVerdict.movement.requiredM, round1(40 * TERRAIN.roadFactor));
  });

  it('crosses a river everywhere at a movement cost', () => {
    const battle = terrainBattle([riverAcross()]);
    const verdict = acceptedVerdict(moveSouth(battle));
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 40 + TERRAIN.riverCostM });
  });

  it('bills the river fee once per move across split legs', () => {
    const battle = terrainBattle([riverAcross()]);
    const unit = hopliteOf(battle);
    const result = validateTurn(
      battle,
      submissionFor(battle, [moveOrder(unit.id, [
        { to: { x: 500, y: 580 } },
        { to: { x: 500, y: 560 } },
      ])]),
    );
    assert.deepEqual(acceptedVerdict(result).movement, {
      availableM: 90,
      requiredM: 40 + TERRAIN.riverCostM,
    });
  });

  it('rejects a swept footprint touching water as forbidden_ground', () => {
    const battle = terrainBattle([groundRect('lake-a', 'water', 490, 570, 510, 590)]);
    const unit = hopliteOf(battle);
    const result = moveSouth(battle);
    assert.equal(result.ok, false);
    const rejection = rejectedVerdict(result);
    assert.equal(rejection.code, 'forbidden_ground');
    assert.deepEqual(rejection.details, {
      unitId: unit.id,
      featureId: 'lake-a',
      groundCover: 'water',
      at: { x: 500, y: 590 },
    });
    assert.match(rejection.message, /forbidden ground/);
  });

  it('never lets a road rescue a footprint on water', () => {
    const battle = terrainBattle([
      groundRect('lake-a', 'water', 400, 540, 600, 620),
      roadAlongX500(),
    ]);
    hopliteOf(battle).files = TERRAIN.columnMaxFiles;
    const rejection = rejectedVerdict(moveSouth(battle));
    assert.equal(rejection.code, 'forbidden_ground');
    assert.equal(rejection.details.groundCover, 'water');
    const unit = hopliteOf(battle);
    const corners = [
      { x: unit.position.x - 8, y: unit.position.y },
      { x: unit.position.x + 8, y: unit.position.y },
      { x: unit.position.x + 8, y: unit.position.y + 16 },
      { x: unit.position.x - 8, y: unit.position.y + 16 },
    ];
    assert.equal(
      terrainFactorAt(corners, TERRAIN.columnMaxFiles, battle.scenario.terrainFeatures, MOVEMENT).factor,
      Number.POSITIVE_INFINITY,
    );
  });

  it('ignores water far from the swept footprint', () => {
    const battle = terrainBattle([groundRect('lake-a', 'water', 100, 100, 200, 200)]);
    const verdict = acceptedVerdict(moveSouth(battle));
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 40 });
  });

  it('imposes no movement penalty for elevation', () => {
    const battle = terrainBattle([
      { id: 'hill-a', kind: 'elevation', level: 1, polygon: [
        { x: 400, y: 540 }, { x: 600, y: 540 }, { x: 600, y: 620 }, { x: 400, y: 620 },
      ] },
    ]);
    const verdict = acceptedVerdict(moveSouth(battle));
    assert.deepEqual(verdict.movement, { availableM: 90, requiredM: 40 });
  });

  it('reflects the unit’s current terrain in the available actions', () => {
    const openBattle = terrainBattle([]);
    const openEntry = availableActions(openBattle, openBattle.activeSide)
      .units.find((item) => item.unitId === hopliteOf(openBattle).id);
    assert.equal(openEntry.movementAllowanceM, 90);

    const roughBattle = terrainBattle([groundRect('rough-a', 'rough', 400, 540, 600, 650)]);
    const roughEntry = availableActions(roughBattle, roughBattle.activeSide)
      .units.find((item) => item.unitId === hopliteOf(roughBattle).id);
    assert.equal(roughEntry.movementAllowanceM, round1(90 / TERRAIN.roughFactor));

    const forestBattle = terrainBattle([groundRect('forest-a', 'forest', 400, 540, 600, 650)]);
    const forestEntry = availableActions(forestBattle, forestBattle.activeSide)
      .units.find((item) => item.unitId === hopliteOf(forestBattle).id);
    assert.equal(forestEntry.movementAllowanceM, round1(90 / TERRAIN.forestFactor));

    const roadBattle = terrainBattle([groundRect('rough-a', 'rough', 400, 540, 600, 650), roadAlongX500()]);
    const roadUnit = hopliteOf(roadBattle);
    roadUnit.files = TERRAIN.columnMaxFiles;
    const roadEntry = availableActions(roadBattle, roadBattle.activeSide)
      .units.find((item) => item.unitId === roadUnit.id);
    assert.equal(roadEntry.movementAllowanceM, round1(90 / TERRAIN.roadFactor));

    const waterBattle = terrainBattle([groundRect('lake-a', 'water', 400, 540, 600, 650)]);
    const waterEntry = availableActions(waterBattle, waterBattle.activeSide)
      .units.find((item) => item.unitId === hopliteOf(waterBattle).id);
    assert.equal(waterEntry.movementAllowanceM, 0);
  });

  it('reads the worst cover and the road factor through the terrain helpers', () => {
    const features = [
      groundRect('rough-a', 'rough', 0, 0, 100, 100),
      groundRect('forest-a', 'forest', 200, 200, 300, 300),
    ];
    const overlapping = [
      groundRect('rough-a', 'rough', 0, 0, 100, 100),
      groundRect('town-a', 'settlement', 50, 50, 150, 150),
    ];
    const ring = [{ x: 60, y: 60 }, { x: 70, y: 60 }, { x: 70, y: 70 }, { x: 60, y: 70 }];
    assert.equal(groundCoverAt(ring, features), 'rough');
    assert.equal(
      groundCoverAt([{ x: 210, y: 210 }, { x: 220, y: 210 }, { x: 220, y: 220 }, { x: 210, y: 220 }], features),
      'forest',
    );
    assert.equal(
      groundCoverAt(ring, overlapping),
      'settlement',
      'settlement outranks rough',
    );
    assert.equal(groundCoverAt(ring, []), 'open');
    const { cover, factor } = terrainFactorAt(ring, 16, overlapping, MOVEMENT);
    assert.equal(cover, 'settlement');
    assert.equal(factor, TERRAIN.forestFactor);
    const roadFeatures = [roadAlongX500()];
    const onRoad = [{ x: 495, y: 590 }, { x: 505, y: 590 }, { x: 505, y: 600 }, { x: 495, y: 600 }];
    assert.equal(footprintTouchesPath(onRoad, roadFeatures[0].path, 6), true);
    assert.equal(
      terrainFactorAt(onRoad, TERRAIN.columnMaxFiles, roadFeatures, MOVEMENT).factor,
      TERRAIN.roadFactor,
    );
    assert.equal(
      terrainFactorAt(onRoad, TERRAIN.columnMaxFiles + 1, roadFeatures, MOVEMENT).factor,
      1,
      'out of column the road is ignored',
    );
  });
});
