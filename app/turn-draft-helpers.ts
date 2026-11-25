// Pure turn-draft helpers for the battle screen (issue #142).
//
// Moved verbatim from `app/turn-draft-controller.ts`: draft submission
// building, validation, and conflict extraction with no React state, so the
// hook below stays under the size limit. Each helper takes the battle, the
// drafts, or the validation it reads as an argument; the controller passes
// its own state through unchanged.

import { SUBMISSION_FORMAT_VERSION, validateTurn } from '../domain/turn.js';
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
