'use client';

// Shared turn-draft controller for the battle screen (issue #122).
//
// The turn draft and everything that reads or edits it live behind this one
// controller, separate from the battle screen's rendering, so that a second
// UI surface (the on-map unit context card) can drive exactly the same draft
// as the right-hand inspector panel. The controller owns the selected unit,
// the ordered turn draft (at most one order draft per unit), the engine
// validation result (`validateTurn`) and the per-unit `availableActions`
// lookups (permitted kinds with unavailability reasons, charge/shoot
// candidates, movement allowance, spacing presets), and exposes every draft
// operation the inspector uses today. It holds no ruleset logic of its own
// (ADR 0005): permitted kinds, reasons and candidates come only from the
// engine.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BattleChargeCandidate } from './battlefield-map';
import { SUBMISSION_FORMAT_VERSION, availableActions, validateTurn } from '../domain/turn.js';
import { CHARGE_EDGES, MAX_APPROACH_LEGS } from '../domain/charge.js';
import { MAX_MOVE_LEGS } from '../domain/movement.js';
import { getTroopType } from '../domain/polis-classical.js';
import { normalizeFacing } from '../domain/scenario.js';
import { round1 } from '../domain/geometry.js';

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
  verdictForUnit: (unitId: string) => any;
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

export function useTurnDraftController({
  battle,
  activeSide,
  canDraft,
  finished,
  onDraftMutated,
}: TurnDraftControllerOptions): TurnDraftController {
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  // The ordered turn draft: at most one order draft per unit, of every kind
  // (Move, Charge, Shoot, Reform, Withdraw, Rally). Every mutation rebuilds
  // the turn submission in draft order and re-validates it against the
  // authoritative battle state, so the verdicts always describe the current
  // draft. Units without a draft hold implicitly.
  const [drafts, setDrafts] = useState<OrderDraft[]>([]);
  const draftSeq = useRef(1);
  const units: any[] = Array.isArray(battle?.units) ? battle.units : [];

  function notifyMutated(): void {
    onDraftMutated?.();
  }

  // A committed turn moves play on: the whole draft belongs to the turn that
  // was committed, never to the next one. A committed turn cannot be taken
  // back, so no draft survives it.
  useEffect(() => {
    setDrafts([]);
    setSelectedUnitId(null);
  }, [battle?.turnNumber, battle?.id]);

  // Drop a selection the battle no longer holds so the inspector never shows
  // a ghost.
  useEffect(() => {
    if (selectedUnitId && !units.some((unit) => unit?.id === selectedUnitId)) {
      setSelectedUnitId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [units, selectedUnitId]);

  const selectedUnit: any = units.find((unit) => unit?.id === selectedUnitId) ?? null;

  function selectUnit(unitId: string | null): void {
    setSelectedUnitId(unitId);
  }

  function ownUnit(unitId: string | null): any {
    if (!unitId) return null;
    return units.find((unit) => unit?.id === unitId && unit?.side === activeSide) || null;
  }

  function draftForUnit(unitId: string): OrderDraft | null {
    return drafts.find((draft) => draft.unitId === unitId) || null;
  }

  function draftKindOf(draft: OrderDraft | null): string {
    return draft?.kind || 'Move';
  }

  // The inspector reads the engine's available actions, never its own rules:
  // permitted kinds, reasons for the unavailable ones, charge and shoot
  // candidates, and the movement allowance for the unit.
  function actionsEntryFor(unitId: string): any {
    if (!battle || finished) return null;
    try {
      const actions = availableActions(battle, activeSide);
      return (actions.units || []).find((entry: any) => entry.unitId === unitId) || null;
    } catch {
      return null;
    }
  }

  const selectedEntry = useMemo(() => {
    if (!selectedUnit || finished) return null;
    return actionsEntryFor(selectedUnit.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle, selectedUnit, finished]);

  function permittedKindsOf(unitId: string): string[] {
    return (actionsEntryFor(unitId)?.permitted || []).map((item: any) => item.kind);
  }

  // Charge and shoot candidates for a unit from the available actions: hints,
  // not guarantees — earlier orders in the same turn can still block them.
  // The map highlights them for the selected unit; clicking one drafts the
  // order. Spacing presets come from the installed troop catalogue, in metres.
  function chargeCandidatesOf(unitId: string): any[] {
    return actionsEntryFor(unitId)?.chargeCandidates || [];
  }

  function shootCandidatesOf(unitId: string): any[] {
    return actionsEntryFor(unitId)?.shootCandidates || [];
  }

  function spacingPresetsOf(unit: any): Record<string, any> | null {
    return getTroopType(unit?.troopType)?.presets || null;
  }

  // The draft submission in draft order, one order per draft. Every kind the
  // inspector can draft maps to the order shape the engine validates.
  const draftSubmission = useMemo(() => {
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
  }, [battle, drafts]);

  // Every draft change calls the engine's `validate`: pure, never throws for
  // a missing battle, and stores the per-order verdicts for the draft list
  // and the map ghosts/highlights.
  const validation = useMemo(() => {
    if (!battle || !draftSubmission) return null;
    try {
      return validateTurn(battle, draftSubmission);
    } catch {
      return null;
    }
  }, [battle, draftSubmission]);

  function verdictForDraftIndex(index: number): any {
    const verdicts = validation?.verdicts;
    if (!Array.isArray(verdicts)) return null;
    return verdicts.find((verdict: any) => verdict?.orderIndex === index) || null;
  }

  // Live engine verdict for one unit's draft (the card and the inspector
  // share it): the verdict whose order index holds that unit's draft.
  function verdictForUnit(unitId: string): any {
    const index = drafts.findIndex((draft) => draft.unitId === unitId);
    if (index < 0) return null;
    return verdictForDraftIndex(index);
  }

  // Units named as the conflict by a rejection, drawn as map highlights: the
  // collision partner (`details.withUnitId`), the charge or shoot target
  // (`details.targetId`), a line-of-fire blocker (`details.blockedBy`), or
  // the nearest enemy a rally objects to (`details.nearestEnemyId`). The
  // rejected unit itself is outlined by its draft row; the other parties
  // highlight on the map.
  function conflictUnitIds(): Set<string> {
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

  function conflictPoints(): { x: number; y: number }[] {
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

  function upsertDraft(unitId: string, draft: NewOrderDraft): void {
    setDrafts((prev) => {
      const index = prev.findIndex((entry) => entry.unitId === unitId);
      // Spreading a union keeps every variant's fields, so the result is
      // cast back to the draft union once it is whole.
      if (index < 0) {
        const created = { key: `draft-${draftSeq.current++}`, unitId, ...draft } as OrderDraft;
        return [...prev, created];
      }
      const next = [...prev];
      if (next[index].kind !== draft.kind) {
        // Switching kinds drops the old parameters.
        next[index] = { key: next[index].key, unitId, ...draft } as OrderDraft;
      } else {
        // Same kind: the new parameters overwrite the old ones field by
        // field, keeping the draft key.
        next[index] = { ...next[index], ...draft } as OrderDraft;
      }
      return next;
    });
    setSelectedUnitId(unitId);
    notifyMutated();
  }

  function startMoveDraft(unitId: string): void {
    if (!canDraft) return;
    if (!ownUnit(unitId)) return;
    if (!permittedKindsOf(unitId).includes('Move')) return;
    const existing = draftForUnit(unitId);
    if (existing) {
      // Re-drafting Move over another kind replaces it; over Move it selects.
      if (existing.kind !== 'Move') upsertDraft(unitId, { kind: 'Move', legs: [] });
      else {
        setSelectedUnitId(unitId);
        notifyMutated();
      }
      return;
    }
    setDrafts((prev) => [...prev, { key: `draft-${draftSeq.current++}`, unitId, kind: 'Move' as const, legs: [] }]);
    setSelectedUnitId(unitId);
    notifyMutated();
  }

  function startChargeDraft(unitId: string, targetId: string | null = null, edge: string | null = null): void {
    if (!canDraft) return;
    if (!ownUnit(unitId)) return;
    const candidates = chargeCandidatesOf(unitId);
    const chosen =
      candidates.find((candidate: any) => candidate.targetId === targetId) || candidates[0] || null;
    if (!chosen) return;
    upsertDraft(unitId, {
      kind: 'Charge',
      targetId: chosen.targetId,
      edge: CHARGE_EDGES.includes(edge as any) ? (edge as string) : chosen.edge,
      approach: [],
    });
  }

  function startShootDraft(unitId: string, targetId: string | null = null): void {
    if (!canDraft) return;
    if (!ownUnit(unitId)) return;
    const candidates = shootCandidatesOf(unitId);
    const chosen =
      candidates.find((candidate: any) => candidate.targetId === targetId) || candidates[0] || null;
    if (!chosen) return;
    upsertDraft(unitId, { kind: 'Shoot', targetId: chosen.targetId });
  }

  function startReformDraft(unitId: string): void {
    if (!canDraft) return;
    const unit = ownUnit(unitId);
    if (!unit) return;
    upsertDraft(unitId, {
      kind: 'Reform',
      files: unit.files,
      lateralInterval: unit.lateralInterval,
      rankDepth: unit.rankDepth,
    });
  }

  function startWithdrawDraft(unitId: string): void {
    if (!canDraft) return;
    if (!ownUnit(unitId)) return;
    upsertDraft(unitId, { kind: 'Withdraw' });
  }

  function startRallyDraft(unitId: string): void {
    if (!canDraft) return;
    if (!ownUnit(unitId)) return;
    upsertDraft(unitId, { kind: 'Rally' });
  }

  function setChargeTarget(unitId: string, targetId: string, edge: string | null = null): void {
    if (!canDraft) return;
    const chosen = chargeCandidatesOf(unitId).find(
      (candidate: any) => candidate.targetId === targetId,
    );
    if (!chosen) return;
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Charge') return draft;
      return {
        ...draft,
        targetId: chosen.targetId,
        edge: CHARGE_EDGES.includes(edge as any) ? (edge as string) : chosen.edge,
      };
    }));
    notifyMutated();
  }

  function setChargeEdge(unitId: string, edge: string): void {
    if (!canDraft) return;
    if (!CHARGE_EDGES.includes(edge as any)) return;
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Charge') return draft;
      return { ...draft, edge };
    }));
    notifyMutated();
  }

  function setShootTarget(unitId: string, targetId: string): void {
    if (!canDraft) return;
    const chosen = shootCandidatesOf(unitId).find(
      (candidate: any) => candidate.targetId === targetId,
    );
    if (!chosen) return;
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Shoot') return draft;
      return { ...draft, targetId: chosen.targetId };
    }));
    notifyMutated();
  }

  function setReformField(unitId: string, field: string, raw: string): void {
    if (!canDraft) return;
    const text = String(raw ?? '');
    if (text.trim() === '') return;
    if (field === 'files') {
      const value = Number(text);
      if (!Number.isInteger(value)) return;
      setDrafts((prev) => prev.map((draft) => {
        if (draft.unitId !== unitId || draft.kind !== 'Reform') return draft;
        return { ...draft, files: value };
      }));
    } else if (field === 'lateralInterval' || field === 'rankDepth') {
      const value = Number(text);
      if (!Number.isFinite(value)) return;
      setDrafts((prev) => prev.map((draft) => {
        if (draft.unitId !== unitId || draft.kind !== 'Reform') return draft;
        return { ...draft, [field]: round1(value) };
      }));
    } else {
      return;
    }
    notifyMutated();
  }

  function applyReformPreset(unitId: string, preset: string): void {
    if (!canDraft) return;
    const draft = draftForUnit(unitId);
    const unit = ownUnit(unitId);
    if (!draft || draft.kind !== 'Reform' || !unit) return;
    const chosen = spacingPresetsOf(unit)?.[preset];
    if (!chosen) return;
    setDrafts((prev) => prev.map((entry) => {
      if (entry.unitId !== unitId || entry.kind !== 'Reform') return entry;
      return { ...entry, lateralInterval: chosen.lateralInterval, rankDepth: chosen.rankDepth };
    }));
    notifyMutated();
  }

  function appendApproachLeg(unitId: string, point: { x: number; y: number }): void {
    if (!canDraft) return;
    if (!ownUnit(unitId)) return;
    const snapped = { x: round1(point.x), y: round1(point.y) };
    if (!Number.isFinite(snapped.x) || !Number.isFinite(snapped.y)) return;
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Charge') return draft;
      if (draft.approach.length >= MAX_APPROACH_LEGS) return draft;
      return { ...draft, approach: [...draft.approach, { face: null, to: snapped }] };
    }));
    notifyMutated();
  }

  function removeLastApproachLeg(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Charge' || draft.approach.length === 0) return draft;
      return { ...draft, approach: draft.approach.slice(0, -1) };
    }));
    notifyMutated();
  }

  function clearApproachLegs(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Charge' || draft.approach.length === 0) return draft;
      return { ...draft, approach: [] };
    }));
    notifyMutated();
  }

  function removeDraft(unitId: string): void {
    setDrafts((prev) => (prev.some((draft) => draft.unitId === unitId)
      ? prev.filter((draft) => draft.unitId !== unitId)
      : prev));
    notifyMutated();
  }

  // Reordering swaps the draft order and re-validates: each order validates
  // against the state left by the orders before it.
  function moveDraft(unitId: string, direction: number): void {
    setDrafts((prev) => {
      const index = prev.findIndex((draft) => draft.unitId === unitId);
      const other = index + direction;
      if (index < 0 || other < 0 || other >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[other]] = [next[other], next[index]];
      return next;
    });
    notifyMutated();
  }

  function appendDraftLeg(unitId: string, point: { x: number; y: number }): void {
    if (!canDraft) return;
    if (!ownUnit(unitId)) return;
    const snapped = { x: round1(point.x), y: round1(point.y) };
    if (!Number.isFinite(snapped.x) || !Number.isFinite(snapped.y)) return;
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Move' || draft.legs.length >= MAX_MOVE_LEGS) {
        return draft;
      }
      return { ...draft, legs: [...draft.legs, { face: null, to: snapped }] };
    }));
    notifyMutated();
  }

  function removeLastDraftLeg(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Move' || draft.legs.length === 0) return draft;
      return { ...draft, legs: draft.legs.slice(0, -1) };
    }));
    notifyMutated();
  }

  function clearDraftLegs(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => (
      draft.unitId === unitId && draft.kind === 'Move' && draft.legs.length > 0
        ? { ...draft, legs: [] }
        : draft
    )));
    notifyMutated();
  }

  function setDraftFacing(unitId: string, raw: string): void {
    if (!canDraft) return;
    const text = String(raw ?? '').trim();
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Move') return draft;
      if (text === '') {
        // Clearing the facing removes the rotation from every leg.
        return {
          ...draft,
          legs: draft.legs.map((leg) => ({ face: null as number | null, to: leg.to ? { ...leg.to } : null })),
        };
      }
      if (!Number.isFinite(Number(text))) return draft;
      const face = normalizeFacing(round1(Number(text)));
      if (draft.legs.length === 0) {
        return { ...draft, legs: [{ face, to: null }] };
      }
      return {
        ...draft,
        legs: draft.legs.map((leg, index) => (
          index === draft.legs.length - 1 ? { face, to: leg.to ? { ...leg.to } : null } : leg
        )),
      };
    }));
    notifyMutated();
  }

  // Unit clicks on the map: an own unit selects it; an enemy candidate drafts
  // (or retargets) a Charge or Shoot for the selected unit, Charge first; any
  // other click clears the selection.
  function handleBattleUnitSelect(unitId: string | null): void {
    if (!canDraft || !unitId) {
      setSelectedUnitId(unitId);
      return;
    }
    const unit = units.find((entry: any) => entry?.id === unitId) || null;
    if (!unit) {
      setSelectedUnitId(null);
      return;
    }
    if (unit.side === activeSide) {
      setSelectedUnitId(unitId);
      notifyMutated();
      return;
    }
    if (selectedUnitId) {
      const kinds = permittedKindsOf(selectedUnitId);
      const charge = kinds.includes('Charge')
        ? chargeCandidatesOf(selectedUnitId).find(
          (candidate: any) => candidate.targetId === unitId,
        )
        : null;
      if (charge) {
        if (draftForUnit(selectedUnitId)?.kind === 'Charge') {
          setChargeTarget(selectedUnitId, charge.targetId, charge.edge);
        } else {
          startChargeDraft(selectedUnitId, charge.targetId, charge.edge);
        }
        return;
      }
      const shoot = kinds.includes('Shoot')
        ? shootCandidatesOf(selectedUnitId).find(
          (candidate: any) => candidate.targetId === unitId,
        )
        : null;
      if (shoot) {
        if (draftForUnit(selectedUnitId)?.kind === 'Shoot') {
          setShootTarget(selectedUnitId, shoot.targetId);
        } else {
          startShootDraft(selectedUnitId, shoot.targetId);
        }
        return;
      }
    }
    setSelectedUnitId(null);
  }

  // Open-ground clicks draft legs: up to three for the active Move draft,
  // up to two optional approach legs for the active Charge draft.
  function handleBattleMapClick(point: { x: number; y: number }): void {
    if (!canDraft || !selectedUnitId) return;
    const draft = draftForUnit(selectedUnitId);
    if (!draft) return;
    if (draft.kind === 'Move' && draft.legs.length < MAX_MOVE_LEGS) {
      appendDraftLeg(selectedUnitId, point);
    } else if (draft.kind === 'Charge' && draft.approach.length < MAX_APPROACH_LEGS) {
      appendApproachLeg(selectedUnitId, point);
    }
  }

  function handleBattleRotate(facing: number): void {
    if (!canDraft || !selectedUnitId) return;
    if (draftForUnit(selectedUnitId)?.kind !== 'Move') return;
    setDraftFacing(selectedUnitId, String(facing));
  }

  function unitDisplayName(unitId: string): string {
    return units.find((unit: any) => unit?.id === unitId)?.name || unitId;
  }

  // Ghost footprints for accepted drafts that move or reshape the unit (the
  // Movement-phase preview: Move, Charge, Reform, Withdraw), approach and leg
  // paths for every draft, and shoot lines; rejected drafts draw in red.
  // Shoot and Rally previews match the current footprint, so they draw no
  // ghost.
  const GHOST_KINDS = useMemo(() => new Set(['Move', 'Charge', 'Reform', 'Withdraw']), []);

  const battleGhosts = useMemo(() => {
    const ghosts: { unitId: string; corners: { x: number; y: number }[]; kind: string }[] = [];
    for (const [verdictIndex, verdict] of (validation?.verdicts || []).entries()) {
      if (!verdict?.accepted || !verdict.preview?.corners) continue;
      if (!Array.isArray(verdict.preview.corners) || verdict.preview.corners.length < 3) continue;
      const kind = drafts[verdict.orderIndex ?? verdictIndex]?.kind || 'Move';
      if (!GHOST_KINDS.has(kind)) continue;
      ghosts.push({ unitId: verdict.unitId, corners: verdict.preview.corners, kind });
    }
    return ghosts;
  }, [validation, drafts, GHOST_KINDS]);

  const battlePaths = useMemo(() => {
    const paths: { points: { x: number; y: number }[]; rejected: boolean; label: string }[] = [];
    drafts.forEach((draft, index) => {
      const mover = units.find((unit: any) => unit?.id === draft.unitId);
      const start = mover?.position && Number.isFinite(mover.position?.x) && Number.isFinite(mover.position?.y)
        ? { x: mover.position.x, y: mover.position.y }
        : null;
      const legs = draft.kind === 'Charge' ? draft.approach : draft.kind === 'Move' ? draft.legs : [];
      const stops = (legs || []).filter((leg) => leg.to).map((leg) => leg.to as { x: number; y: number });
      if (!start || stops.length === 0) return;
      const verdict = verdictForDraftIndex(index);
      paths.push({
        points: [start, ...stops],
        rejected: verdict?.accepted === false,
        label: draft.kind === 'Charge' ? 'Approach' : 'Leg',
      });
    });
    return paths;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, validation, units]);

  // A Shoot never moves: the line marks the shot from the shooter to the
  // target, and the Shooting phase resolves it. Rejected shots draw in red
  // like every rejected draft.
  const battleShootLines = useMemo(() => {
    const lines: { from: { x: number; y: number }; to: { x: number; y: number }; rejected: boolean; shooterId: string; targetId: string }[] = [];
    drafts.forEach((draft, index) => {
      if (draft.kind !== 'Shoot') return;
      const shooter = units.find((unit: any) => unit?.id === draft.unitId);
      const target = units.find((unit: any) => unit?.id === draft.targetId);
      const from = shooter?.position && Number.isFinite(shooter.position?.x) && Number.isFinite(shooter.position?.y)
        ? { x: shooter.position.x, y: shooter.position.y }
        : null;
      const to = target?.position && Number.isFinite(target.position?.x) && Number.isFinite(target.position?.y)
        ? { x: target.position.x, y: target.position.y }
        : null;
      if (!from || !to) return;
      const verdict = verdictForDraftIndex(index);
      lines.push({
        from,
        to,
        rejected: verdict?.accepted === false,
        shooterId: draft.unitId,
        targetId: draft.targetId,
      });
    });
    return lines;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, validation, units]);

  // Charge and shoot candidates for the selected unit, from the engine's
  // available actions: highlighted on the map and listed in the inspector.
  const battleCandidateCharges: BattleChargeCandidate[] = useMemo(() => {
    if (!canDraft || !selectedUnitId) return [];
    return chargeCandidatesOf(selectedUnitId).map((candidate: any) => ({
      unitId: String(candidate.targetId),
      edge: String(candidate.edge || ''),
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle, selectedUnitId, finished, canDraft]);

  const battleCandidateShoots = useMemo(() => {
    if (!canDraft || !selectedUnitId) return [];
    return shootCandidatesOf(selectedUnitId).map((candidate: any) => String(candidate.targetId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [battle, selectedUnitId, finished, canDraft]);

  return {
    selectedUnitId,
    selectedUnit,
    drafts,
    draftSubmission,
    validation,
    selectedEntry,
    battleGhosts,
    battlePaths,
    battleShootLines,
    battleCandidateCharges,
    battleCandidateShoots,
    selectUnit,
    ownUnit,
    draftForUnit,
    draftKindOf,
    actionsEntryFor,
    permittedKindsOf,
    chargeCandidatesOf,
    shootCandidatesOf,
    spacingPresetsOf,
    verdictForDraftIndex,
    verdictForUnit,
    conflictUnitIds,
    conflictPoints,
    unitDisplayName,
    startMoveDraft,
    upsertDraft,
    startChargeDraft,
    startShootDraft,
    startReformDraft,
    startWithdrawDraft,
    startRallyDraft,
    setChargeTarget,
    setChargeEdge,
    setShootTarget,
    setReformField,
    applyReformPreset,
    appendApproachLeg,
    removeLastApproachLeg,
    clearApproachLegs,
    removeDraft,
    moveDraft,
    appendDraftLeg,
    removeLastDraftLeg,
    clearDraftLegs,
    setDraftFacing,
    handleBattleUnitSelect,
    handleBattleMapClick,
    handleBattleRotate,
  };
}
