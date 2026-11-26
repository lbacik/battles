// Pure turn-draft helpers for the battle screen (issue #142).
//
// Moved verbatim from `app/turn-draft-controller.ts`: draft submission
// building, validation, and conflict extraction with no React state, so the
// hook below stays under the size limit. Each helper takes the battle, the
// drafts, or the validation it reads as an argument; the controller passes
// its own state through unchanged.

import { SUBMISSION_FORMAT_VERSION, validateTurn } from '../domain/turn.js';
import { normalizeFacing } from '../domain/scenario.js';
import { round1 } from '../domain/geometry.js';
import type { OrderDraft } from './turn-draft-types';

export function draftKindOfDraft(draft: OrderDraft | null): string {
  return draft?.kind || 'Move';
}

// The draft submission in draft order, one order per draft. Every kind the
// inspector can draft maps to the order shape the engine validates.
export function buildDraftSubmission(battle: any, drafts: OrderDraft[]): any {
  if (!battle) return null;
  return {
    formatVersion: SUBMISSION_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side: battle.activeSide,
    orders: drafts.map((draft) => {
      switch (draft.kind) {
        case 'Charge':
          return {
            unitId: draft.unitId,
            kind: 'Charge',
            targetId: draft.targetId,
            edge: draft.edge,
            approach: draft.approach.map((leg) => ({
              ...(leg.face === null || leg.face === undefined ? {} : { face: leg.face }),
              ...(leg.to ? { to: { ...leg.to } } : {}),
            })),
          };
        case 'Shoot':
          return { unitId: draft.unitId, kind: 'Shoot', targetId: draft.targetId };
        case 'Reform': {
          const order: any = { unitId: draft.unitId, kind: 'Reform' };
          if (draft.files !== null && draft.files !== undefined) order.files = draft.files;
          if (draft.lateralInterval !== null && draft.lateralInterval !== undefined) {
            order.lateralInterval = draft.lateralInterval;
          }
          if (draft.rankDepth !== null && draft.rankDepth !== undefined) {
            order.rankDepth = draft.rankDepth;
          }
          return order;
        }
        case 'Withdraw':
          return { unitId: draft.unitId, kind: 'Withdraw' };
        case 'Rally':
          return { unitId: draft.unitId, kind: 'Rally' };
        case 'Move':
        default:
          return {
            unitId: draft.unitId,
            kind: 'Move',
            legs: draft.legs.map((leg) => ({
              ...(leg.face === null || leg.face === undefined ? {} : { face: leg.face }),
              ...(leg.to ? { to: { ...leg.to } } : {}),
            })),
          };
      }
    }),
  };
}

// Every draft change calls the engine's `validate`: pure, never throws for
// a missing battle, and stores the per-order verdicts for the draft list
// and the map ghosts/highlights.
export function validateDraftSubmission(battle: any, draftSubmission: any): any {
  if (!battle || !draftSubmission) return null;
  try {
    return validateTurn(battle, draftSubmission);
  } catch {
    return null;
  }
}

export function verdictForDraftIndexIn(validation: any, index: number): any {
  const verdicts = validation?.verdicts;
  if (!Array.isArray(verdicts)) return null;
  return verdicts.find((verdict: any) => verdict?.orderIndex === index) || null;
}

// Quick wheeling buttons for the unit context card (issue #126): one tap
// turns the Move draft facing by `delta` degrees. Pure over the draft list
// so the controller stays a thin state wrapper; the engine alone decides
// legality, so no clamping happens here.
export const MOVE_WHEEL_STEPS: number[] = [-45, -15, 15, 45, 180];

// The latest set facing of a Move draft, searching legs from the end: the
// value the card's numeric facing field and the inspector's facing field
// both show, so the map rotation handle and both surfaces stay in sync.
export function latestMoveFaceFor(draft: OrderDraft | null): number | null {
  if (!draft || draft.kind !== 'Move') return null;
  for (let index = draft.legs.length - 1; index >= 0; index -= 1) {
    const face = draft.legs[index]?.face;
    if (face !== null && face !== undefined) return face;
  }
  return null;
}

// Wheeling the Move draft facing from the unit context card (issue #126):
// one tap adds `delta` to the latest set facing, or to the unit's current
// facing when the draft has none yet (a wheeled facing with no legs becomes
// a rotation-only leg, exactly like typing a facing with no legs). Pure over
// the draft list and the units, so the controller stays a thin state
// wrapper; the engine alone decides legality.
export function stepMoveFacingIn(
  drafts: OrderDraft[],
  units: any[],
  unitId: string,
  delta: number,
): OrderDraft[] {
  if (!Number.isFinite(delta)) return drafts;
  let changed = false;
  const next = drafts.map((draft) => {
    if (draft.unitId !== unitId || draft.kind !== 'Move') return draft;
    const base = latestMoveFaceFor(draft)
      ?? Number((units || []).find((unit: any) => unit?.id === unitId)?.facing)
      ?? 0;
    const face = normalizeFacing(round1((Number.isFinite(base) ? base : 0) + delta));
    changed = true;
    if (draft.legs.length === 0) {
      return { ...draft, legs: [{ face, to: null }] };
    }
    return {
      ...draft,
      legs: draft.legs.map((leg, index) => (
        index === draft.legs.length - 1 ? { face, to: leg.to ? { ...leg.to } : null } : leg
      )),
    };
  });
  return changed ? (next as OrderDraft[]) : drafts;
}

// Quick file-count steppers for the unit context card (issue #128): one tap
// adds `delta` to the Reform draft files. Pure over the draft list so the
// controller stays a thin state wrapper; the engine alone decides legality,
// so no clamping happens here (a step may produce a rejected draft, which
// the card then shows with the engine's message).
export const REFORM_FILE_STEPS: number[] = [-4, -2, -1, 1, 2, 4];

export function reformRanksFor(soldiers: any, files: any): number | null {
  const total = Number(soldiers);
  const count = Number(files);
  if (!Number.isFinite(total) || !Number.isInteger(count) || count <= 0) return null;
  if (total <= 0) return null;
  return Math.ceil(total / count);
}

export function stepReformFilesIn(drafts: OrderDraft[], unitId: string, delta: number): OrderDraft[] {
  if (!Number.isFinite(delta) || Math.trunc(delta) !== delta || delta === 0) return drafts;
  let changed = false;
  const next = drafts.map((draft) => {
    if (draft.unitId !== unitId || draft.kind !== 'Reform') return draft;
    const base = Number((draft as any).files);
    const files = (Number.isFinite(base) ? Math.trunc(base) : 0) + Math.trunc(delta);
    changed = true;
    return { ...draft, files };
  });
  return changed ? (next as OrderDraft[]) : drafts;
}

// The engine verdict for one unit's draft, looked up through draft order:
// the draft index in `drafts` is the submission order index the verdicts
// carry as `orderIndex`.
export function verdictForUnitIn(validation: any, drafts: OrderDraft[], unitId: string): any {
  const index = drafts.findIndex((draft) => draft.unitId === unitId);
  if (index < 0) return null;
  return verdictForDraftIndexIn(validation, index);
}

// Units named as the conflict by a rejection, drawn as map highlights: the
// collision partner (`details.withUnitId`), the charge or shoot target
// (`details.targetId`), a line-of-fire blocker (`details.blockedBy`), or
// the nearest enemy a rally objects to (`details.nearestEnemyId`). The
// rejected unit itself is outlined by its draft row; the other parties
// highlight on the map.
export function conflictUnitIdsIn(validation: any, units: any[]): Set<string> {
  const ids = new Set<string>();
  const unitIds = new Set(units.map((unit: any) => unit?.id));
  for (const verdict of validation?.verdicts || []) {
    const details = verdict?.accepted === false ? verdict?.rejection?.details : null;
    if (!details) continue;
    if (typeof details.withUnitId === 'string') ids.add(details.withUnitId);
    if (
      typeof details.targetId === 'string' &&
      details.targetId !== verdict.unitId &&
      unitIds.has(details.targetId)
    ) {
      ids.add(details.targetId);
    }
    if (typeof details.blockedBy === 'string' && unitIds.has(details.blockedBy)) {
      ids.add(details.blockedBy);
    }
    if (typeof details.nearestEnemyId === 'string') ids.add(details.nearestEnemyId);
  }
  return ids;
}

export function conflictPointsIn(validation: any): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  for (const verdict of validation?.verdicts || []) {
    if (verdict?.accepted !== false) continue;
    const details = verdict?.rejection?.details;
    for (const key of ['at', 'aimPoint']) {
      const point = details?.[key];
      if (point && Number.isFinite(point?.x) && Number.isFinite(point?.y)) {
        points.push({ x: point.x, y: point.y });
      }
    }
  }
  return points;
}
