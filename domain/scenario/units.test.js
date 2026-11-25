// Unit tests for order of battle: units, placement, and footprints. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACING_SNAP_DEG,
  UNIT_PICK_TOLERANCE_PX,
  cloneScenario,
  collectWarnings,
  createHistory,
  createUnit,
  defaultFacingForSide,
  deleteUnit,
  duplicateUnit,
  findFreeUnitPosition,
  footprintHitTest,
  historyCommit,
  historyRedo,
  historyUndo,
  isProvisionalRuleset,
  isProvisionalRulesetVersion,
  normalizeFacing,
  pickUnitIdAtPoint,
  proposeUnitPatch,
  snapFacing,
  suggestUnitName,
  unitDerived,
  unitFacingDeg,
  unitFootprint,
  unitPosition,
  unitsBlockingResize,
  updateUnitName,
  updateUnitNumbers,
  updateUnitSide,
  updateUnitSpacing,
  updateUnitTroopType,
  validateScenario,
} from '../scenario.js';
import { freshDocument, probeUnit } from './test-helpers.js';

describe('unit footprint (ADR 0001, ADR 0002)', () => {
  it('derives ranks, frontage, and depth from soldiers, files, and spacings', () => {
    const footprint = unitFootprint({
      soldiers: 256,
      files: 16,
      lateralIntervalM: 1,
      rankDepthM: 1,
    });
    assert.deepEqual(footprint, { ranks: 16, frontageM: 16, depthM: 16 });
  });

  it('rounds ranks up when soldiers do not fill the last rank', () => {
    const footprint = unitFootprint({
      soldiers: 100,
      files: 16,
      lateralIntervalM: 1,
      rankDepthM: 2,
    });
    assert.equal(footprint.ranks, 7);
    assert.equal(footprint.frontageM, 16);
    assert.equal(footprint.depthM, 14);
  });

  it('never invents a footprint from incomplete data', () => {
    assert.equal(unitFootprint({ soldiers: 100, files: 16 }), null);
    assert.equal(unitFootprint(null), null);
  });

  it('reads tolerant positions and compass facings', () => {
    assert.deepEqual(unitPosition({ position: { x: 10, y: 20 } }), { x: 10, y: 20 });
    assert.deepEqual(unitPosition({ x: 5, y: 6 }), { x: 5, y: 6 });
    assert.equal(unitPosition({ x: 'a', y: 1 }), null);
    assert.equal(unitFacingDeg({ facingDeg: 30 }), 30);
    assert.equal(unitFacingDeg({ angle: 270 }), -90);
    assert.equal(unitFacingDeg({}), 0);
  });
});

describe('order of battle helpers', () => {
  it('badges provisional 0.x ruleset versions only', () => {
    assert.equal(isProvisionalRulesetVersion('0.1'), true);
    assert.equal(isProvisionalRulesetVersion('0.10'), true);
    assert.equal(isProvisionalRulesetVersion('1.0'), false);
    assert.equal(isProvisionalRulesetVersion(' 0.1 '), true);
    assert.equal(isProvisionalRulesetVersion(''), false);
    assert.equal(isProvisionalRulesetVersion(null), false);
    assert.equal(isProvisionalRuleset({ id: 'polis-classical', version: '0.1' }), true);
    assert.equal(isProvisionalRuleset({ id: 'polis-classical', version: '1.0' }), false);
  });

  it('suggests a unique unit name', () => {
    const document = freshDocument();
    assert.equal(suggestUnitName(document), 'New Unit');
    document.units.push(probeUnit({ name: 'New Unit' }));
    assert.equal(suggestUnitName(document), 'New Unit 2');
    document.units.push(probeUnit({ name: 'new unit 2' }));
    assert.equal(suggestUnitName(document), 'New Unit 3');
  });

  it('faces the first side south and the second side north', () => {
    const document = freshDocument();
    assert.equal(defaultFacingForSide(document, 'side-a'), 180);
    assert.equal(defaultFacingForSide(document, 'side-b'), 0);
    assert.equal(defaultFacingForSide(document, 'unknown'), 0);
  });

  it('finds the first free spot from the north-west of the search rect', () => {
    const document = freshDocument();
    const position = findFreeUnitPosition(document, { frontage: 10, depth: 10, facing: 0 });
    assert.ok(position);
    assert.deepEqual(validateScenario({
      ...document,
      units: [probeUnit({ position, facing: 0 })],
    }), []);
  });

  it('avoids overlapping footprints and returns null when the view is full', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ name: 'First', position: { x: 600, y: 400 } }));
    const overlapping = findFreeUnitPosition(
      document,
      { frontage: 10, depth: 10, facing: 0 },
      { minX: 595, maxX: 605, minY: 395, maxY: 405 },
    );
    assert.equal(overlapping, null);
    const clear = findFreeUnitPosition(
      document,
      { frontage: 10, depth: 10, facing: 0 },
      { minX: 100, maxX: 200, minY: 100, maxY: 200 },
    );
    assert.ok(clear);
    assert.ok(clear.x >= 100 && clear.x <= 200);
    assert.ok(clear.y >= 100 && clear.y <= 200);
  });
});

describe('unit placement and rotation on the map', () => {
  // Probe footprint: 100 soldiers in 10 files at 1 m spacings is 10 ranks,
  // a 10 m frontage, and a 10 m depth. Facing north (0), the front midpoint
  // (600, 400) spans x 595-605 and extends south to y 390.
  const placed = (overrides = {}) =>
    probeUnit({ position: { x: 600, y: 400 }, facing: 0, ...overrides });

  it('normalizes facings into [0, 360) and snaps the handle to 15 degrees', () => {
    assert.equal(normalizeFacing(720), 0);
    assert.equal(normalizeFacing(-45), 315);
    assert.equal(normalizeFacing(360), 0);
    assert.equal(normalizeFacing(30), 30);
    assert.equal(FACING_SNAP_DEG, 15);
    assert.equal(snapFacing(33), 30);
    assert.equal(snapFacing(38), 45);
    assert.equal(snapFacing(7.5), 15);
    assert.equal(UNIT_PICK_TOLERANCE_PX, 8);
  });

  it('hit-tests the real footprint with a metre tolerance', () => {
    const unit = placed();
    assert.equal(footprintHitTest(unit, { x: 600, y: 395 }), true);
    assert.equal(footprintHitTest(unit, { x: 600, y: 400 }), true);
    assert.equal(footprintHitTest(unit, { x: 600, y: 401 }), false);
    assert.equal(footprintHitTest(unit, { x: 600, y: 401 }, 2), true);
    assert.equal(footprintHitTest(unit, { x: 100, y: 100 }), false);
    assert.equal(footprintHitTest(unit, { x: 100, y: 100 }, 5), false);
    assert.equal(footprintHitTest(unit, null), false);
  });

  it('picks the topmost unit at a point and nothing on empty ground', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'Lower' }));
    document.units.push(placed({ name: 'Upper' }));
    const [, upper] = document.units;
    assert.equal(pickUnitIdAtPoint(document, { x: 600, y: 395 }, 0), upper.id);
    assert.equal(pickUnitIdAtPoint(document, { x: 100, y: 100 }, 0), null);
    assert.equal(pickUnitIdAtPoint(document, { x: 600, y: 402 }, 5), upper.id);
  });

  it('moves a unit through the proposal and keeps the input untouched', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'First' }));
    const before = cloneScenario(document);
    const proposal = proposeUnitPatch(document, document.units[0].id, {
      position: { x: 610.04, y: 400 },
    });
    assert.equal(proposal.ok, true);
    assert.deepEqual(proposal.document.units[0].position, { x: 610, y: 400 });
    assert.deepEqual(document, before);
  });

  it('refuses an overlapping drop and names both units as the conflict', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'First', position: { x: 600, y: 400 } }));
    document.units.push(placed({ name: 'Second', position: { x: 630, y: 400 } }));
    assert.deepEqual(validateScenario(document), []);
    const [first, second] = document.units;
    const refused = proposeUnitPatch(document, second.id, { position: { x: 600, y: 400 } });
    assert.equal(refused.ok, false);
    assert.equal(refused.document, null);
    assert.ok(refused.conflictIds.includes(first.id));
    assert.ok(refused.conflictIds.includes(second.id));
    assert.match(refused.errors.join(' '), /overlap/);
  });

  it('accepts touching edge to edge and refuses leaving the battlefield', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'First', position: { x: 600, y: 400 } }));
    document.units.push(placed({ name: 'Second', position: { x: 630, y: 400 } }));
    const [, second] = document.units;
    // 10 m frontages: 595-605 beside 605-615 touch at x 605.
    const touching = proposeUnitPatch(document, second.id, { position: { x: 610, y: 400 } });
    assert.equal(touching.ok, true);
    assert.deepEqual(validateScenario(touching.document), []);
    const outside = proposeUnitPatch(document, second.id, { position: { x: 2, y: 400 } });
    assert.equal(outside.ok, false);
    assert.deepEqual(outside.conflictIds, [second.id]);
    assert.match(outside.errors.join(' '), /outside the battlefield/);
    const invalid = proposeUnitPatch(document, second.id, { position: { x: Number.NaN, y: 400 } });
    assert.equal(invalid.ok, false);
    const missing = proposeUnitPatch(document, 'no-such-unit', { position: { x: 600, y: 400 } });
    assert.equal(missing.ok, false);
  });

  it('rotates a unit about its facing and wraps the bearing', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'First' }));
    const [unit] = document.units;
    const rotated = proposeUnitPatch(document, unit.id, { facing: 30 });
    assert.equal(rotated.ok, true);
    assert.equal(rotated.document.units[0].facing, 30);
    const wrapped = proposeUnitPatch(document, unit.id, { facing: 370 });
    assert.equal(wrapped.ok, true);
    assert.equal(wrapped.document.units[0].facing, 10);
    const invalid = proposeUnitPatch(document, unit.id, { facing: Number.NaN });
    assert.equal(invalid.ok, false);
  });

  it('names the units blocking a battlefield shrink', () => {
    const document = freshDocument();
    document.units.push(placed({ name: 'Probe taxis', position: { x: 1150, y: 400 } }));
    const blockers = unitsBlockingResize(document, 1000, 800);
    assert.equal(blockers.length, 1);
    assert.equal(blockers[0].name, 'Probe taxis');
    assert.equal(blockers[0].index, 0);
    assert.deepEqual(unitsBlockingResize(document, 1400, 900), []);
    assert.deepEqual(unitsBlockingResize(document, 0, 800), []);
  });

  it('skips units without an id when picking', () => {
    const document = freshDocument();
    document.units.push(placed({ id: undefined, name: 'Ghost' }));
    document.units.push(placed({ name: 'Lower' }));
    const [, lower] = document.units;
    assert.equal(pickUnitIdAtPoint(document, { x: 600, y: 395 }, 0), lower.id);
    const ghostsOnly = freshDocument();
    ghostsOnly.units.push(placed({ id: undefined, name: 'Ghost' }));
    assert.equal(pickUnitIdAtPoint(ghostsOnly, { x: 600, y: 395 }, 0), null);
  });

  it('round-trips a placement patch through commit, undo, and redo', () => {
    const before = freshDocument();
    before.units.push(placed({ name: 'First' }));
    const proposal = proposeUnitPatch(before, before.units[0].id, { position: { x: 620, y: 400 } });
    assert.equal(proposal.ok, true);
    let history = createHistory();
    history = historyCommit(history, cloneScenario(before));
    let current = proposal.document;
    assert.deepEqual(current.units[0].position, { x: 620, y: 400 });
    const undone = historyUndo(history, cloneScenario(current));
    assert.ok(undone, 'expected an undo step');
    history = undone.history;
    current = undone.document;
    assert.deepEqual(current.units[0].position, { x: 600, y: 400 });
    const redone = historyRedo(history, cloneScenario(current));
    assert.ok(redone, 'expected a redo step');
    current = redone.document;
    assert.deepEqual(current.units[0].position, { x: 620, y: 400 });
    const undoneAgain = historyUndo(redone.history, cloneScenario(current));
    assert.ok(undoneAgain, 'expected undo to be available after redo');
    assert.deepEqual(undoneAgain.document.units[0].position, { x: 600, y: 400 });
    assert.equal(historyUndo(createHistory(), cloneScenario(current)), null);
  });
});

describe('unit editing (order of battle)', () => {
  it('derives ranks, frontage, and depth from the same footprint the map draws', () => {
    assert.deepEqual(unitDerived(probeUnit()), { ranks: 10, frontageM: 10, depthM: 10 });
    assert.deepEqual(unitDerived(probeUnit({ soldiers: 101, files: 10 })), {
      ranks: 11,
      frontageM: 10,
      depthM: 11,
    });
    assert.equal(unitDerived({}), null);
  });

  it('creates a unit with catalogue-style defaults at the first free spot', () => {
    const before = freshDocument();
    const { document, unitId } = createUnit(before);
    assert.equal(before.units.length, 0, 'the input document is never mutated');
    assert.equal(document.units.length, 1);
    const unit = document.units[0];
    assert.equal(unit.id, unitId);
    assert.equal(unit.name, 'New Unit');
    assert.equal(unit.side, 'side-a');
    assert.equal(unit.troopType, 'hoplite');
    assert.equal(unit.soldiers, 100);
    assert.equal(unit.files, 10);
    assert.deepEqual(validateScenario(document), []);
    assert.deepEqual(collectWarnings(document).filter((warning) => /side-a/i.test(warning)), []);
  });

  it('faces a new unit with its side and keeps names unique', () => {
    const first = createUnit(freshDocument()).document;
    const second = createUnit(first, { sideId: 'side-b' }).document;
    assert.equal(second.units[0].facing, 180);
    assert.equal(second.units[1].facing, 0);
    assert.equal(second.units[1].side, 'side-b');
    assert.equal(second.units[1].name, 'New Unit 2');
  });

  it('refuses to add a unit when the current view has no free spot', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ position: { x: 600, y: 400 } }));
    assert.throws(
      () =>
        createUnit(document, {
          searchRect: { minX: 600, maxX: 600, minY: 395, maxY: 395 },
        }),
      /No free space/,
    );
  });

  it('duplicates a unit under a unique name at the first free spot', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ name: 'Taxis', position: { x: 600, y: 400 } }));
    const { document: next, unitId } = duplicateUnit(document, document.units[0].id);
    assert.equal(document.units.length, 1, 'the input document is never mutated');
    assert.equal(next.units.length, 2);
    const copy = next.units.find((unit) => unit.id === unitId);
    assert.equal(copy.name, 'Taxis copy');
    assert.notDeepEqual(copy.position, { x: 600, y: 400 });
    assert.deepEqual(validateScenario(next), []);
  });

  it('refuses to duplicate when the current view has no free spot', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ name: 'Taxis', position: { x: 600, y: 400 } }));
    assert.throws(
      () =>
        duplicateUnit(document, document.units[0].id, {
          minX: 595,
          maxX: 605,
          minY: 395,
          maxY: 405,
        }),
      /No free space/,
    );
  });

  it('deletes a unit and reports an unknown id', () => {
    const document = freshDocument();
    document.units.push(probeUnit());
    const id = document.units[0].id;
    const next = deleteUnit(document, id);
    assert.equal(document.units.length, 1, 'the input document is never mutated');
    assert.equal(next.units.length, 0);
    assert.throws(() => deleteUnit(next, id), /Unit not found/);
  });

  it('requires a unique unit name', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ name: 'Taxis' }));
    document.units.push(probeUnit({ name: 'Other', position: { x: 300, y: 200 } }));
    assert.throws(() => updateUnitName(document, document.units[1].id, '  '), /required/);
    assert.throws(
      () => updateUnitName(document, document.units[1].id, 'taxis'),
      /already used/,
    );
    const next = updateUnitName(document, document.units[1].id, '  Fresh  ');
    assert.equal(next.units[1].name, 'Fresh');
    assert.equal(document.units[1].name, 'Other', 'the input document is never mutated');
  });

  it('moves a unit between the two sides only', () => {
    const document = freshDocument();
    document.units.push(probeUnit());
    assert.throws(() => updateUnitSide(document, document.units[0].id, 'side-z'), /Side/);
    const next = updateUnitSide(document, document.units[0].id, 'side-b');
    assert.equal(next.units[0].side, 'side-b');
  });

  it('changes the troop type and optionally pre-fills the preset spacings', () => {
    const document = freshDocument();
    document.units.push(probeUnit());
    assert.throws(
      () => updateUnitTroopType(document, document.units[0].id, '  '),
      /Troop type is required/,
    );
    const kept = updateUnitTroopType(document, document.units[0].id, 'peltast');
    assert.equal(kept.units[0].troopType, 'peltast');
    assert.equal(kept.units[0].lateralInterval, 1, 'spacings stay without a preset');
    const prefilled = updateUnitTroopType(document, document.units[0].id, 'peltast', {
      lateralInterval: 1.5,
      rankDepth: 1.5,
    });
    assert.equal(prefilled.units[0].lateralInterval, 1.5);
    assert.equal(prefilled.units[0].rankDepth, 1.5);
  });

  it('checks soldier and file counts structurally', () => {
    const document = freshDocument();
    document.units.push(probeUnit());
    const id = document.units[0].id;
    assert.throws(() => updateUnitNumbers(document, id, { soldiers: 0 }), /at least 1/);
    assert.throws(() => updateUnitNumbers(document, id, { files: 2.5 }), /whole number/);
    assert.throws(() => updateUnitNumbers(document, id, { files: 101 }), /must not exceed/);
    const next = updateUnitNumbers(document, id, { soldiers: 150 });
    assert.equal(next.units[0].soldiers, 150);
    assert.equal(next.units[0].files, 10);
  });

  it('checks spacings against the structural application limit', () => {
    const document = freshDocument();
    document.units.push(probeUnit());
    const id = document.units[0].id;
    assert.throws(() => updateUnitSpacing(document, id, { lateralInterval: 0 }), /positive/);
    assert.throws(
      () => updateUnitSpacing(document, id, { rankDepth: 10.5 }),
      /application limit/,
    );
    const next = updateUnitSpacing(document, id, { lateralInterval: 1.85, rankDepth: 1.85 });
    assert.equal(next.units[0].lateralInterval, 1.9, 'spacings round to 0.1 m');
  });

  it('refuses a numbers change whose footprint would overlap or leave the field', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ name: 'First', position: { x: 600, y: 400 } }));
    document.units.push(probeUnit({ name: 'Second', position: { x: 300, y: 200 } }));
    assert.throws(
      () => updateUnitNumbers(document, document.units[0].id, { soldiers: 100000 }),
      /footprint extends outside/,
    );
    assert.deepEqual(validateScenario(document), [], 'the refused edit leaves no trace');
  });

  it('refuses a spacing change whose footprint would overlap another unit', () => {
    const document = freshDocument();
    document.units.push(probeUnit({ name: 'First', position: { x: 600, y: 400 } }));
    document.units.push(probeUnit({ name: 'Second', position: { x: 615, y: 400 } }));
    assert.throws(
      () => updateUnitSpacing(document, document.units[0].id, { lateralInterval: 10 }),
      /overlap/,
    );
  });
});
