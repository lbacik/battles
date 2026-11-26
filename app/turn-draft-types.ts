// Shared turn-draft types for the battle screen (issue #142).
//
// Moved verbatim from `app/turn-draft-controller.ts`: the order-draft shapes
// the inspector drafts and the controller surface the battle screen consumes.
// The controller re-exports every name below so no importer changes.

import type { BattleChargeCandidate } from './battlefield-map';

// An order draft for one unit. Move holds up to three `{ face, to }` leg
// points in draft order (a leg with only a rotation is allowed); Charge holds
// its target, edge, and up to two optional approach legs; Shoot holds its
// target; Reform holds the files with the spacings; Withdraw and Rally hold
// no parameters. Drafting a second kind for the same unit replaces the first.
// The engine alone decides legality.
export interface DraftLeg {
  face: number | null;
  to: { x: number; y: number } | null;
}

export type OrderDraft =
  | { key: string; unitId: string; kind: 'Move'; legs: DraftLeg[] }
  | { key: string; unitId: string; kind: 'Charge'; targetId: string; edge: string; approach: DraftLeg[] }
  | { key: string; unitId: string; kind: 'Shoot'; targetId: string }
  | { key: string; unitId: string; kind: 'Reform'; files: number; lateralInterval: number; rankDepth: number }
  | { key: string; unitId: string; kind: 'Withdraw' }
  | { key: string; unitId: string; kind: 'Rally' };

// A new order draft without its key: drafting a second kind for the same
// unit replaces the first, so at most one draft per unit, and the button
// pressed names the intent.
export type NewOrderDraft =
  | { kind: 'Move'; legs: DraftLeg[] }
  | { kind: 'Charge'; targetId: string; edge: string; approach: DraftLeg[] }
  | { kind: 'Shoot'; targetId: string }
  | { kind: 'Reform'; files: number; lateralInterval: number; rankDepth: number }
  | { kind: 'Withdraw' }
  | { kind: 'Rally' };

export interface TurnDraftControllerOptions {
  battle: any;
  activeSide: string;
  canDraft: boolean;
  finished: boolean;
  // Called wherever the battle screen used to clear its commit confirmation:
  // every draft mutation exits the confirm step. The controller itself owns
  // no confirmation UI.
  onDraftMutated?: () => void;
}

export interface TurnDraftController {
  selectedUnitId: string | null;
  selectedUnit: any;
  drafts: OrderDraft[];
  draftSubmission: any;
  validation: any;
  selectedEntry: any;
  battleGhosts: { unitId: string; corners: { x: number; y: number }[]; kind: string }[];
  battlePaths: { points: { x: number; y: number }[]; rejected: boolean; label: string }[];
  battleShootLines: { from: { x: number; y: number }; to: { x: number; y: number }; rejected: boolean; shooterId: string; targetId: string }[];
  battleCandidateCharges: BattleChargeCandidate[];
  battleCandidateShoots: string[];
  selectUnit: (unitId: string | null) => void;
  ownUnit: (unitId: string | null) => any;
  draftForUnit: (unitId: string) => OrderDraft | null;
  draftKindOf: (draft: OrderDraft | null) => string;
  actionsEntryFor: (unitId: string) => any;
  permittedKindsOf: (unitId: string) => string[];
  chargeCandidatesOf: (unitId: string) => any[];
  shootCandidatesOf: (unitId: string) => any[];
  spacingPresetsOf: (unit: any) => Record<string, any> | null;
  verdictForDraftIndex: (index: number) => any;
  conflictUnitIds: () => Set<string>;
  conflictPoints: () => { x: number; y: number }[];
  unitDisplayName: (unitId: string) => string;
  startMoveDraft: (unitId: string) => void;
  upsertDraft: (unitId: string, draft: NewOrderDraft) => void;
  startChargeDraft: (unitId: string, targetId?: string | null, edge?: string | null) => void;
  startShootDraft: (unitId: string, targetId?: string | null) => void;
  startReformDraft: (unitId: string) => void;
  startWithdrawDraft: (unitId: string) => void;
  startRallyDraft: (unitId: string) => void;
  setChargeTarget: (unitId: string, targetId: string, edge?: string | null) => void;
  setChargeEdge: (unitId: string, edge: string) => void;
  setShootTarget: (unitId: string, targetId: string) => void;
  setReformField: (unitId: string, field: string, raw: string) => void;
  applyReformPreset: (unitId: string, preset: string) => void;
  stepReformFiles: (unitId: string, delta: number) => void;
  verdictForUnit: (unitId: string) => any;
  appendApproachLeg: (unitId: string, point: { x: number; y: number }) => void;
  removeLastApproachLeg: (unitId: string) => void;
  clearApproachLegs: (unitId: string) => void;
  removeDraft: (unitId: string) => void;
  moveDraft: (unitId: string, direction: number) => void;
  appendDraftLeg: (unitId: string, point: { x: number; y: number }) => void;
  removeLastDraftLeg: (unitId: string) => void;
  clearDraftLegs: (unitId: string) => void;
  setDraftFacing: (unitId: string, raw: string) => void;
  handleBattleUnitSelect: (unitId: string | null) => void;
  handleBattleMapClick: (point: { x: number; y: number }) => void;
  handleBattleRotate: (facing: number) => void;
}
