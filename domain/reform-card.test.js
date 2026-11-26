import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFORM_FILE_STEPS,
  reformRanksFor,
  stepReformFilesIn,
  verdictForUnitIn,
} from '../app/turn-draft-helpers.ts';

describe('reform card helpers (issue #128)', () => {
  it('exposes the six quick file-count steppers', () => {
    assert.deepEqual(REFORM_FILE_STEPS, [-4, -2, -1, 1, 2, 4]);
  });

  it('derives live ranks from soldiers and files', () => {
    assert.equal(reformRanksFor(100, 8), 13);
    assert.equal(reformRanksFor(100, 10), 10);
    assert.equal(reformRanksFor(100, 12), 9);
    assert.equal(reformRanksFor(100, 0), null);
    assert.equal(reformRanksFor(100, -2), null);
  });

  it('steps the Reform draft files by the delta', () => {
    const drafts = [{ key: 'draft-1', unitId: 'u1', kind: 'Reform', files: 8, lateralInterval: 1.8, rankDepth: 1.8 }];
    const stepped = stepReformFilesIn(drafts, 'u1', 2);
    assert.equal(stepped[0].files, 10);
    // The input list is unchanged (pure helper for the controller).
    assert.equal(drafts[0].files, 8);
    // Other units and kinds are untouched.
    const mixed = [
      ...drafts,
      { key: 'draft-2', unitId: 'u2', kind: 'Move', legs: [] },
    ];
    const mixedStepped = stepReformFilesIn(mixed, 'u1', -4);
    assert.equal(mixedStepped[0].files, 4);
    assert.equal(mixedStepped[1].kind, 'Move');
  });

  it('finds the engine verdict for one unit draft in draft order', () => {
    const drafts = [
      { key: 'draft-1', unitId: 'u1', kind: 'Reform', files: 8, lateralInterval: 1.8, rankDepth: 1.8 },
      { key: 'draft-2', unitId: 'u2', kind: 'Move', legs: [] },
    ];
    const validation = {
      verdicts: [
        { unitId: 'u1', orderIndex: 0, accepted: true, reform: { files: 8, lateralInterval: 1.8, rankDepth: 1.8 } },
        { unitId: 'u2', orderIndex: 1, accepted: false, rejection: { message: 'nope' } },
      ],
    };
    assert.equal(verdictForUnitIn(validation, drafts, 'u1').accepted, true);
    assert.equal(verdictForUnitIn(validation, drafts, 'u2').accepted, false);
    assert.equal(verdictForUnitIn(validation, drafts, 'u3'), null);
  });
});
