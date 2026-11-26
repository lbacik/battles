import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOVE_WHEEL_STEPS,
  latestMoveFaceFor,
  stepMoveFacingIn,
} from '../app/turn-draft-helpers.ts';

describe('move card helpers (issue #126)', () => {
  it('exposes the five quick wheeling buttons', () => {
    assert.deepEqual(MOVE_WHEEL_STEPS, [-45, -15, 15, 45, 180]);
  });

  it('reads the latest set facing of the Move draft', () => {
    assert.equal(latestMoveFaceFor(null), null);
    assert.equal(
      latestMoveFaceFor({ key: 'd', unitId: 'u1', kind: 'Charge', targetId: 't', edge: 'front', approach: [] }),
      null,
    );
    assert.equal(latestMoveFaceFor({ key: 'd', unitId: 'u1', kind: 'Move', legs: [] }), null);
    assert.equal(
      latestMoveFaceFor({ key: 'd', unitId: 'u1', kind: 'Move', legs: [{ face: null, to: { x: 1, y: 2 } }] }),
      null,
    );
    assert.equal(
      latestMoveFaceFor({ key: 'd', unitId: 'u1', kind: 'Move', legs: [{ face: 90, to: null }] }),
      90,
    );
    assert.equal(
      latestMoveFaceFor({
        key: 'd',
        unitId: 'u1',
        kind: 'Move',
        legs: [
          { face: 90, to: { x: 1, y: 1 } },
          { face: null, to: { x: 2, y: 2 } },
        ],
      }),
      90,
    );
    assert.equal(
      latestMoveFaceFor({
        key: 'd',
        unitId: 'u1',
        kind: 'Move',
        legs: [
          { face: 90, to: { x: 1, y: 1 } },
          { face: 135, to: { x: 2, y: 2 } },
        ],
      }),
      135,
    );
  });

  it('wheels the Move draft facing from the unit facing with no legs', () => {
    const drafts = [{ key: 'draft-1', unitId: 'u1', kind: 'Move', legs: [] }];
    const units = [{ id: 'u1', facing: 90 }];
    const stepped = stepMoveFacingIn(drafts, units, 'u1', 45);
    assert.deepEqual(stepped[0].legs, [{ face: 135, to: null }]);
    // The input list is unchanged (pure helper for the controller).
    assert.deepEqual(drafts[0].legs, []);
  });

  it('wheels the latest leg from its set facing and normalizes past 0/360', () => {
    const drafts = [
      {
        key: 'draft-1',
        unitId: 'u1',
        kind: 'Move',
        legs: [{ face: 350, to: { x: 1, y: 1 } }],
      },
    ];
    const units = [{ id: 'u1', facing: 0 }];
    assert.equal(stepMoveFacingIn(drafts, units, 'u1', 30)[0].legs[0].face, 20);
    assert.equal(stepMoveFacingIn(drafts, units, 'u1', -45)[0].legs[0].face, 305);
    // The about-face button turns the unit around from its current facing.
    assert.equal(stepMoveFacingIn(drafts, units, 'u1', 180)[0].legs[0].face, 170);
    // Other drafts and other units are untouched; a non-Move draft never wheels.
    const mixed = [
      ...drafts,
      { key: 'draft-2', unitId: 'u2', kind: 'Move', legs: [{ face: 10, to: null }] },
      { key: 'draft-3', unitId: 'u3', kind: 'Reform', files: 8, lateralInterval: 1.8, rankDepth: 1.8 },
    ];
    const steppedMixed = stepMoveFacingIn(mixed, units, 'u1', 15);
    assert.equal(steppedMixed[0].legs[0].face, 5);
    assert.equal(steppedMixed[1].legs[0].face, 10);
    assert.equal(steppedMixed[2].kind, 'Reform');
    // A non-finite step or an unknown unit leaves the drafts alone.
    assert.equal(stepMoveFacingIn(drafts, units, 'u1', Number.NaN), drafts);
    assert.equal(stepMoveFacingIn(drafts, units, 'nope', 15), drafts);
  });
});
