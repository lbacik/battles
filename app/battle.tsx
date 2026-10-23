'use client';

// The battle screen: order of battle left, the map
// shared with the editor centre, the selected unit's inspector right, and the
// bottom turn bar showing round and round limit, the active side in its
// colour, and the phase.
//
// During a human turn the side drafts orders of every kind: one per unit —
// Move on the map (up to three leg points with a rotation handle), Charge at
// a highlighted candidate (with optional approach legs), Shoot at a
// highlighted candidate, Reform through its form with spacing presets, and
// Withdraw and Rally in place from the inspector. Every draft change calls the
// engine's `validateTurn`: an accepted order shows a ghost footprint of its
// preview (where it moves), a rejected one shows its message inline and
// highlights the conflict. Drafts can be removed and reordered (reordering
// re-validates); Commit is enabled only while every order is accepted, and a
// committed turn cannot be taken back. Automated turns resolve through the
// runner and wait for "Continue". The screen holds no legality rules:
// playability comes from `validatePlayability`, every hint from
// `availableActions`, and every draft and commit from `validateTurn`.

import { useEffect, useMemo, useRef, useState } from 'react';
import BattlefieldMap from './battlefield-map';
import type { BattleChargeCandidate } from './battlefield-map';
import { TURN_PHASE_ORDERS } from '../domain/battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  availableActions,
  validateTurn,
} from '../domain/turn.js';
import { CHARGE_EDGES, MAX_APPROACH_LEGS } from '../domain/charge.js';
import { MAX_MOVE_LEGS } from '../domain/movement.js';
import { getTroopType } from '../domain/polis-classical.js';
import { normalizeFacing } from '../domain/scenario.js';
import { round1 } from '../domain/geometry.js';
import { isBattleFinished } from '../domain/battles.js';
import {
  changedUnitsForTurn,
  describeBattleEvent,
  groupLogEvents,
  lastResolvedTurnNumber,
  summarizeTurn,
} from '../domain/battle-log.js';

type BattleDocument = any;

// An order draft for one unit. Move holds up to three `{ face, to }` legs in
// draft order (a leg with only a rotation is allowed); Charge holds its target,
// edge, and up to two optional approach legs; Shoot holds its target; Reform
// holds the files with the spacings; Withdraw and Rally hold no parameters.
// Drafting a second kind for the same unit replaces the first. The engine
// alone decides legality.
interface DraftLeg {
  face: number | null;
  to: { x: number; y: number } | null;
}

type OrderDraft =
  | { key: string; unitId: string; kind: 'Move'; legs: DraftLeg[] }
  | { key: string; unitId: string; kind: 'Charge'; targetId: string; edge: string; approach: DraftLeg[] }
  | { key: string; unitId: string; kind: 'Shoot'; targetId: string }
  | { key: string; unitId: string; kind: 'Reform'; files: number; lateralInterval: number; rankDepth: number }
  | { key: string; unitId: string; kind: 'Withdraw' }
  | { key: string; unitId: string; kind: 'Rally' };

interface BattleScreenProps {
  battle: BattleDocument;
  announcement: string | null;
  resolving: boolean;
  resolveError: string | null;
  awaitingHandoff: boolean;
  handoffSide: string | null;
  onHandoff: () => void;
  onCommitEmpty: () => void;
  onCommitDraft: (orders: any[]) => void;
  onContinueAutomated: () => void;
  onConcede: () => void;
  onRematch: () => void;
  onOpenScenarioInEditor: () => void;
  onBackToLibrary: () => void;
}

function sideOf(battle: BattleDocument, id: string): any {
  return (battle?.scenario?.sides || []).find((side: any) => side?.id === id) || null;
}

function sideName(battle: BattleDocument, id: string): string {
  return sideOf(battle, id)?.name || id;
}

function sideColor(battle: BattleDocument, id: string): string {
  return sideOf(battle, id)?.color || '#666666';
}

function roundLimitOf(battle: BattleDocument): number {
  const limit = battle?.parameters?.battle?.roundLimit;
  return Number.isInteger(limit) && limit > 0 ? limit : 12;
}

function isAutomatedController(controller: unknown): boolean {
  return controller !== 'human';
}

export default function BattleScreen({
  battle,
  announcement,
  resolving,
  resolveError,
  awaitingHandoff,
  handoffSide,
  onHandoff,
  onCommitEmpty,
  onCommitDraft,
  onContinueAutomated,
  onConcede,
  onRematch,
  onOpenScenarioInEditor,
  onBackToLibrary,
}: BattleScreenProps) {
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // A concede needs its own confirmation step in the turn bar, separate from
  // the empty-commit confirmation: requesting it locks drafting until the
  // player confirms or cancels.
  const [concedeConfirming, setConcedeConfirming] = useState(false);
  // The ordered turn draft: at most one order draft per unit, of every kind
  // (Move, Charge, Shoot, Reform, Withdraw, Rally). Every mutation rebuilds
  // the turn submission in draft order and re-validates it against the
  // authoritative battle state, so the verdicts always describe the current
  // draft. Units without a draft hold implicitly.
  const [drafts, setDrafts] = useState<OrderDraft[]>([]);
  const draftSeq = useRef(1);
  const scenario = battle?.scenario;
  const units: any[] = Array.isArray(battle?.units) ? battle.units : [];
  const sides: any[] = Array.isArray(scenario?.sides) ? scenario.sides : [];
  const finished = isBattleFinished(battle);
  const activeSide = battle?.activeSide;
  const controller = battle?.controllers?.[activeSide] || 'human';
  const automated = isAutomatedController(controller);
  const limit = roundLimitOf(battle);
  const lastResolved = lastResolvedTurnNumber(battle);

  // A committed turn moves play on: the confirmation, the selection, and the
  // whole draft belong to the turn that was committed, never to the next one.
  // A committed turn cannot be taken back, so no draft survives it.
  useEffect(() => {
    setConfirming(false);
    setConcedeConfirming(false);
    setDrafts([]);
    setSelectedUnitId(null);
  }, [battle?.turnNumber, battle?.id]);

  // Drop a selection the battle no longer holds so the inspector never shows
  // a ghost.
  useEffect(() => {
    if (selectedUnitId && !units.some((unit) => unit?.id === selectedUnitId)) {
      setSelectedUnitId(null);
    }
  }, [units, selectedUnitId]);

  const selectedUnit: any =
    units.find((unit) => unit?.id === selectedUnitId) ?? null;

  // Drafting is a human Orders-phase activity only: automated sides resolve
  // through the runner, nothing drafts outside the Orders phase, and nothing
  // drafts behind the device handoff — "<Side> — begin your turn" unlocks it.
  const canDraft =
    !finished &&
    !automated &&
    battle?.phase === TURN_PHASE_ORDERS &&
    !resolving &&
    !awaitingHandoff;

  // A concede is offered in the turn bar during one's own turn only: the same
  // gate as drafting (an ongoing battle in the human side's Orders phase, with
  // no handoff wait, resolution, or open confirmation in the way). While the
  // concession itself waits for confirmation, drafting locks and the turn bar
  // shows the confirm step instead.
  const canConcede =
    !finished &&
    !automated &&
    battle?.phase === TURN_PHASE_ORDERS &&
    !resolving &&
    !awaitingHandoff &&
    !confirming &&
    !concedeConfirming;

  function requestConcede(): void {
    if (!canConcede) return;
    setConfirming(false);
    setConcedeConfirming(true);
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

  // Per-kind draft editor for the selected unit: Move legs on the map with a
  // facing field, Charge target/edge selects with optional approach legs,
  // Shoot target select, Reform form with spacing presets, and Withdraw and
  // Rally in place. Every change re-validates through the engine.
  function draftEditor(unit: any) {
    const draft = draftForUnit(unit.id);
    if (!draft) return null;
    const removeRow = (
      <div className="draft-actions">
        <button
          type="button"
          className="btn-quiet btn-danger"
          onClick={() => removeDraft(unit.id)}
        >
          Remove order
        </button>
      </div>
    );
    if (draft.kind === 'Move') {
      const legs = draft.legs;
      return (
        <section aria-label="Move draft" data-testid={`draft-editor-${unit.id}`}>
          <span className="eyebrow">MOVE DRAFT</span>
          <ol className="leg-list">
            {legs.length === 0 ? (
              <li className="leg-empty">No legs yet — click the map for leg 1.</li>
            ) : (
              legs.map((leg: any, index: number) => (
                <li key={index}>
                  Leg {index + 1}:{' '}
                  {leg.to ? `(${leg.to.x.toFixed(1)}, ${leg.to.y.toFixed(1)})` : 'rotation only'}
                  {leg.face !== null && leg.face !== undefined ? ` · face ${leg.face}°` : ''}
                </li>
              ))
            )}
          </ol>
          <p className="draft-hint">
            Click the map for leg {legs.length + 1} (up to {MAX_MOVE_LEGS}) · drag the round
            handle or type a facing to rotate about the front midpoint.
          </p>
          <label className="field">
            Facing (°)
            <input
              type="number"
              data-testid={`draft-facing-${unit.id}`}
              min={0}
              max={360}
              step={1}
              value={
                [...legs]
                  .reverse()
                  .find((leg: any) => leg.face !== null && leg.face !== undefined)?.face ?? ''
              }
              placeholder="—"
              onChange={(event) => setDraftFacing(unit.id, event.target.value)}
            />
          </label>
          <div className="draft-actions">
            <button
              type="button"
              className="btn-secondary"
              data-testid={`remove-last-leg-${unit.id}`}
              disabled={legs.length === 0}
              onClick={() => removeLastDraftLeg(unit.id)}
            >
              Undo leg
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid={`clear-legs-${unit.id}`}
              disabled={legs.length === 0}
              onClick={() => clearDraftLegs(unit.id)}
            >
              Clear legs
            </button>
          </div>
        </section>
      );
    }
    if (draft.kind === 'Charge') {
      const candidates = chargeCandidatesOf(unit.id);
      const approach = draft.approach;
      return (
        <section aria-label="Charge draft" data-testid={`draft-editor-${unit.id}`}>
          <span className="eyebrow">CHARGE DRAFT</span>
          <label className="field">
            Target
            <select
              data-testid={`charge-target-${unit.id}`}
              value={draft.targetId}
              onChange={(event) => setChargeTarget(unit.id, event.target.value)}
            >
              {candidates.map((candidate: any) => (
                <option key={candidate.targetId} value={candidate.targetId}>
                  {unitDisplayName(candidate.targetId)} · {candidate.distanceM} m
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            Edge
            <select
              data-testid={`charge-edge-${unit.id}`}
              value={draft.edge}
              onChange={(event) => setChargeEdge(unit.id, event.target.value)}
            >
              {CHARGE_EDGES.map((edge: string) => (
                <option key={edge} value={edge}>
                  {edge}
                </option>
              ))}
            </select>
          </label>
          <ol className="leg-list">
            {approach.length === 0 ? (
              <li className="leg-empty">
                No approach legs — a direct charge, or click the map for approach 1.
              </li>
            ) : (
              approach.map((leg: any, index: number) => (
                <li key={index}>
                  Approach {index + 1}: ({leg.to.x.toFixed(1)}, {leg.to.y.toFixed(1)})
                </li>
              ))
            )}
          </ol>
          <p className="draft-hint">
            Click the map for approach {approach.length + 1} (up to {MAX_APPROACH_LEGS},
            optional). The ghost shows the flush contact position.
          </p>
          <div className="draft-actions">
            <button
              type="button"
              className="btn-secondary"
              data-testid={`remove-last-approach-${unit.id}`}
              disabled={approach.length === 0}
              onClick={() => removeLastApproachLeg(unit.id)}
            >
              Undo approach
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid={`clear-approach-${unit.id}`}
              disabled={approach.length === 0}
              onClick={() => clearApproachLegs(unit.id)}
            >
              Clear approach
            </button>
            <button
              type="button"
              className="btn-quiet btn-danger"
              onClick={() => removeDraft(unit.id)}
            >
              Remove order
            </button>
          </div>
        </section>
      );
    }
    if (draft.kind === 'Shoot') {
      const candidates = shootCandidatesOf(unit.id);
      return (
        <section aria-label="Shoot draft" data-testid={`draft-editor-${unit.id}`}>
          <span className="eyebrow">SHOOT DRAFT</span>
          <label className="field">
            Target
            <select
              data-testid={`shoot-target-${unit.id}`}
              value={draft.targetId}
              onChange={(event) => setShootTarget(unit.id, event.target.value)}
            >
              {candidates.map((candidate: any) => (
                <option key={candidate.targetId} value={candidate.targetId}>
                  {unitDisplayName(candidate.targetId)} · {candidate.distanceM} m
                </option>
              ))}
            </select>
          </label>
          <p className="draft-hint">
            A Shoot never moves: the line marks the shot, and the Shooting phase resolves it.
          </p>
          {removeRow}
        </section>
      );
    }
    if (draft.kind === 'Reform') {
      const presets = spacingPresetsOf(unit);
      return (
        <section aria-label="Reform draft" data-testid={`draft-editor-${unit.id}`}>
          <span className="eyebrow">REFORM DRAFT</span>
          <label className="field">
            Files
            <input
              type="number"
              data-testid={`reform-files-${unit.id}`}
              min={1}
              step={1}
              value={draft.files ?? ''}
              onChange={(event) => setReformField(unit.id, 'files', event.target.value)}
            />
          </label>
          <label className="field">
            Lateral interval (m)
            <input
              type="number"
              data-testid={`reform-lateral-${unit.id}`}
              min={0.1}
              step={0.1}
              value={draft.lateralInterval ?? ''}
              onChange={(event) => setReformField(unit.id, 'lateralInterval', event.target.value)}
            />
          </label>
          <label className="field">
            Rank depth (m)
            <input
              type="number"
              data-testid={`reform-depth-${unit.id}`}
              min={0.1}
              step={0.1}
              value={draft.rankDepth ?? ''}
              onChange={(event) => setReformField(unit.id, 'rankDepth', event.target.value)}
            />
          </label>
          <div className="preset-row">
            <span className="field-label">Spacing presets</span>
            <div className="handoff-actions">
              {presets ? (
                Object.entries(presets).map(([name, preset]: [string, any]) => (
                  <button
                    key={name}
                    type="button"
                    className="btn-quiet"
                    data-testid={`apply-preset-${unit.id}-${name}`}
                    title={`Set ${name} spacing (${preset.lateralInterval} × ${preset.rankDepth} m)`}
                    onClick={() => applyReformPreset(unit.id, name)}
                  >
                    {name} ({preset.lateralInterval}×{preset.rankDepth})
                  </button>
                ))
              ) : (
                <span className="draft-hint">No presets for this troop type.</span>
              )}
            </div>
          </div>
          <p className="draft-hint">
            The reform anchors at the front midpoint and takes the whole turn. The ghost shows
            the new footprint.
          </p>
          {removeRow}
        </section>
      );
    }
    if (draft.kind === 'Withdraw') {
      return (
        <section aria-label="Withdraw draft" data-testid={`draft-editor-${unit.id}`}>
          <span className="eyebrow">WITHDRAW DRAFT</span>
          <p className="draft-hint">
            Withdraws straight back without turning and breaks every contact. The ghost shows
            the step back; cohesion is tested by chance on resolution.
          </p>
          {removeRow}
        </section>
      );
    }
    return (
      <section aria-label="Rally draft" data-testid={`draft-editor-${unit.id}`}>
        <span className="eyebrow">RALLY DRAFT</span>
        <p className="draft-hint">
          Rallies in place and never moves. A Disordered unit regains cohesion; a Routed unit
          attempts only with no enemy near.
        </p>
        {removeRow}
      </section>
    );
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
        setConfirming(false);
      }
      return;
    }
    setDrafts((prev) => [...prev, { key: `draft-${draftSeq.current++}`, unitId, kind: 'Move' as const, legs: [] }]);
    setSelectedUnitId(unitId);
    setConfirming(false);
  }

  // A new order draft without its key: drafting a second kind for the same
  // unit replaces the first, so at most one draft per unit, and the button
  // pressed names the intent.
  type NewOrderDraft =
    | { kind: 'Move'; legs: DraftLeg[] }
    | { kind: 'Charge'; targetId: string; edge: string; approach: DraftLeg[] }
    | { kind: 'Shoot'; targetId: string }
    | { kind: 'Reform'; files: number; lateralInterval: number; rankDepth: number }
    | { kind: 'Withdraw' }
    | { kind: 'Rally' };

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
    setConfirming(false);
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
    setConfirming(false);
  }

  function setChargeEdge(unitId: string, edge: string): void {
    if (!canDraft) return;
    if (!CHARGE_EDGES.includes(edge as any)) return;
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Charge') return draft;
      return { ...draft, edge };
    }));
    setConfirming(false);
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
    setConfirming(false);
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
    setConfirming(false);
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
    setConfirming(false);
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
    setConfirming(false);
  }

  function removeLastApproachLeg(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Charge' || draft.approach.length === 0) return draft;
      return { ...draft, approach: draft.approach.slice(0, -1) };
    }));
    setConfirming(false);
  }

  function clearApproachLegs(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Charge' || draft.approach.length === 0) return draft;
      return { ...draft, approach: [] };
    }));
    setConfirming(false);
  }

  function removeDraft(unitId: string): void {
    setDrafts((prev) => (prev.some((draft) => draft.unitId === unitId)
      ? prev.filter((draft) => draft.unitId !== unitId)
      : prev));
    setConfirming(false);
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
    setConfirming(false);
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
    setConfirming(false);
  }

  function removeLastDraftLeg(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.kind !== 'Move' || draft.legs.length === 0) return draft;
      return { ...draft, legs: draft.legs.slice(0, -1) };
    }));
    setConfirming(false);
  }

  function clearDraftLegs(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => (
      draft.unitId === unitId && draft.kind === 'Move' && draft.legs.length > 0
        ? { ...draft, legs: [] }
        : draft
    )));
    setConfirming(false);
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
    setConfirming(false);
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
      setConfirming(false);
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

  // One-line accepted detail for a draft from its verdict preview, per kind.
  function draftAcceptedDetail(verdict: any): string {
    if (verdict?.movement && Number.isFinite(verdict.movement.requiredM)) {
      return `Accepted · needs ${verdict.movement.requiredM} m of ${verdict.movement.availableM} m.`;
    }
    if (verdict?.charge) {
      return `Accepted · ${verdict.charge.aspect} contact, ${verdict.charge.frontageM} m, ${verdict.charge.fightingFiles} files.`;
    }
    if (verdict?.shoot) {
      return `Accepted · ${verdict.shoot.distanceM} m to ${unitDisplayName(verdict.shoot.targetId)}.`;
    }
    if (verdict?.reform) {
      return `Accepted · ${verdict.reform.files} files · ${verdict.reform.lateralInterval}×${verdict.reform.rankDepth} m.`;
    }
    if (verdict?.withdraw) {
      return `Accepted · steps back ${verdict.withdraw.distanceM} m.`;
    }
    if (verdict?.rally) {
      return `Accepted · rallies from ${verdict.rally.state}.`;
    }
    return 'Accepted.';
  }

  function draftLegSummary(draft: { legs: DraftLeg[] }): string {
    const stops = draft.legs.filter((leg) => leg.to);
    const faces = draft.legs.filter((leg) => leg.face !== null && leg.face !== undefined);
    const parts = [`${stops.length} ${stops.length === 1 ? 'leg' : 'legs'}`];
    if (faces.length > 0) {
      parts.push(`face ${faces[faces.length - 1].face}°`);
    }
    return parts.join(' · ');
  }

  // One-line summary per draft for the draft list, naming the kind and its
  // parameters.
  function draftSummary(draft: OrderDraft): string {
    switch (draft.kind) {
      case 'Charge': {
        const approach = draft.approach.filter((leg) => leg.to).length;
        return `Charge → ${unitDisplayName(draft.targetId)} (${draft.edge || '—'}) · ${approach} approach ${
          approach === 1 ? 'leg' : 'legs'
        }`;
      }
      case 'Shoot':
        return `Shoot → ${unitDisplayName(draft.targetId)}`;
      case 'Reform':
        return `Reform → ${draft.files} files · ${draft.lateralInterval}×${draft.rankDepth} m`;
      case 'Withdraw':
        return 'Withdraw (step straight back)';
      case 'Rally':
        return 'Rally';
      case 'Move':
        return `Move · ${draftLegSummary(draft)}`;
      default: {
        const _exhaustive: never = draft;
        return `Move · ${draftLegSummary(_exhaustive)}`;
      }
    }
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

  const logGroups = useMemo(() => {
    try {
      return groupLogEvents(battle);
    } catch {
      return [];
    }
  }, [battle]);

  const summary = useMemo(() => {
    if (lastResolved === null || lastResolved === undefined) return null;
    try {
      return summarizeTurn(battle, lastResolved);
    } catch {
      return null;
    }
  }, [battle, lastResolved]);

  // Each rout, loss, and cohesion change shows its chance outcome: the
  // rout-test, shooting/combat-loss, and rally/withdraw-cohesion draws that
  // decided it.
  const drawsFor = (purposes: string[], unitIds: string[]) =>
    (summary?.draws || []).filter(
      (event: any) =>
        purposes.includes(event.purpose) &&
        (!unitIds ||
          unitIds.includes(event.unitId) ||
          unitIds.includes(event.targetId) ||
          unitIds.includes(event.opponentId)),
    );
  const lossDraws = drawsFor(
    ['shooting-loss', 'combat-loss'],
    (summary?.losses || []).map((loss: any) => loss.unitId),
  );
  const cohesionDraws = drawsFor(
    ['rally', 'withdraw-cohesion'],
    (summary?.cohesion || []).map((entry: any) => entry.unitId),
  );
  const routDraws = drawsFor(
    ['rout-test'],
    (summary?.routs || []).map((entry: any) => entry.unitId),
  );

  // The units the last resolved turn changed (losses, cohesion, rout, flight,
  // or destruction), as a unit-id → reasons map for the order-of-battle and
  // map highlights. A null turn means no resolved turn yet: nothing highlights.
  const changedByUnit = useMemo(() => {
    if (lastResolved === null || lastResolved === undefined) return new Map<string, string[]>();
    try {
      return new Map(
        changedUnitsForTurn(battle, lastResolved).map((entry: any) => [entry.unitId, entry.reasons]),
      );
    } catch {
      return new Map<string, string[]>();
    }
  }, [battle, lastResolved]);

  const result = battle?.result && typeof battle.result === 'object' ? battle.result : null;
  const winnerName = battle?.winner ? sideName(battle, battle.winner) : null;

  // The outcome screen of a finished battle: the winner or the draw, the
  // reason (an army break naming the broken sides; the round limit with both
  // lost shares and the margin; a concession naming who conceded), and both
  // sides' losses. The final map and the battle log stay viewable around it.
  const lostShares: Record<string, number> =
    result && typeof result.lostShares === 'object' && result.lostShares !== null
      ? result.lostShares
      : {};
  const sideLosses: Record<string, number> =
    result && typeof result.losses === 'object' && result.losses !== null ? result.losses : {};

  function percent(share: unknown): string {
    return typeof share === 'number' && Number.isFinite(share)
      ? `${(share * 100).toFixed(1)}%`
      : '—';
  }

  function outcomeReason(): string {
    if (!result || !result.reason) {
      return `This battle ended (${battle?.status}).`;
    }
    if (result.reason === 'break') {
      const broken = Array.isArray(result.brokenSides) ? result.brokenSides : [];
      if (broken.length === 0) return 'Army break.';
      const names = broken.map((id: string) => sideName(battle, id)).join(' and ');
      return broken.length > 1
        ? `Army break — both sides broke (${names}). Neither side wins.`
        : `Army break — ${names} broke.`;
    }
    if (result.reason === 'round-limit') {
      return 'Round limit reached — the side with the lower lost share wins when the difference exceeds the margin.';
    }
    if (result.reason === 'concede') {
      const conceded = (battle?.events || []).find((event: any) => event?.type === 'turn-conceded');
      const conceder = conceded?.side ? sideName(battle, conceded.side) : null;
      return conceder && winnerName
        ? `Concession — ${conceder} conceded, so ${winnerName} wins.`
        : 'Concession.';
    }
    return `Ended: ${result.reason}.`;
  }

  // The round-limit margin line: both lost shares already sit in the losses
  // list below, and the difference decides against the margin.
  function outcomeMargin(): string | null {
    if (!result || result.reason !== 'round-limit') return null;
    const ids = sides.map((side: any) => side?.id);
    const difference =
      ids.length === 2 &&
      typeof lostShares[ids[0]] === 'number' &&
      Number.isFinite(lostShares[ids[0]]) &&
      typeof lostShares[ids[1]] === 'number' &&
      Number.isFinite(lostShares[ids[1]])
        ? Math.abs(lostShares[ids[0]] - lostShares[ids[1]])
        : null;
    return `Draw margin ${percent(result.margin)} · difference ${difference === null ? '—' : percent(difference)}.`;
  }

  return (
    <div data-testid="battle-screen">
      <main className="workspace battle-workspace">
        <aside className="left-panel panel" aria-label="Order of battle">
          <span className="eyebrow">FORCES IN THE FIELD</span>
          <h2>
            Order of battle <span data-testid="battle-oob-count">{units.length}</span>
          </h2>
          {sides.map((side: any, index: number) => {
            const sideUnits = units.filter((unit) => unit?.side === side?.id);
            const soldiers = sideUnits.reduce(
              (sum: number, unit: any) => sum + (Number(unit?.soldiers) || 0),
              0,
            );
            return (
              <section
                className="side"
                key={side?.id ?? index}
                data-testid={index === 0 ? 'battle-oob-side-a' : 'battle-oob-side-b'}
              >
                <div className="side-name">
                  <span
                    className="swatch"
                    style={{ background: side?.color ?? '#888' }}
                    aria-hidden="true"
                  />
                  {side?.name ?? 'Unnamed side'}
                </div>
                <p className="side-count" data-testid="battle-oob-side-count">
                  {sideUnits.length === 0
                    ? 'No units'
                    : `${sideUnits.length} ${sideUnits.length === 1 ? 'unit' : 'units'} · ${soldiers.toLocaleString('en')} soldiers`}
                </p>
                {sideUnits.map((unit: any) => {
                  const changedReasons = changedByUnit.get(unit?.id) || [];
                  const changed = changedReasons.length > 0;
                  return (
                    <button
                      type="button"
                      className={
                        `unit-row selectable${unit?.id === selectedUnitId ? ' selected' : ''}${changed ? ' changed' : ''}`
                      }
                      key={unit?.id ?? unit?.name}
                      data-testid="battle-oob-unit"
                      data-unit-id={unit?.id ?? ''}
                      data-selected={unit?.id === selectedUnitId ? 'true' : 'false'}
                      data-changed={changed ? 'true' : 'false'}
                      aria-pressed={unit?.id === selectedUnitId}
                      onClick={() => setSelectedUnitId(unit?.id ?? null)}
                    >
                      <span
                        className="swatch"
                        style={{ background: side?.color ?? '#888' }}
                        aria-hidden="true"
                      />
                      <span>
                        <span className="unit-name">{unit?.name || 'Unit'}</span>
                        <span className="unit-detail">
                          {unit?.troopType} · {unit?.soldiers} soldiers · {unit?.cohesion || ''}
                          {unit?.status && unit.status !== 'active' ? ` · ${unit.status}` : ''}
                          {changed ? ` · changed: ${changedReasons.join(', ')}` : ''}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </section>
            );
          })}
          <p className="readonly-note">
            The battle keeps the scenario&apos;s units throughout. Select a unit to inspect it.
          </p>
        </aside>
        <section className="map-panel" aria-label="Battlefield map">
          <div className="map-caption" data-testid="battle-map-caption">
            Battlefield · {scenario?.battlefield?.width} × {scenario?.battlefield?.height} m ·{' '}
            {canDraft
              ? 'click a unit, then draft from the inspector: click the map for Move legs, drag the round handle to rotate'
              : 'read-only'}
            {lastResolved !== null && lastResolved !== undefined
              ? ' · amber outlines mark the units the last turn changed'
              : ''}
          </div>
          <BattlefieldMap
            width={scenario?.battlefield?.width}
            height={scenario?.battlefield?.height}
            units={units}
            sides={sides}
            selectedUnitId={selectedUnitId}
            onSelectUnit={handleBattleUnitSelect}
            terrainFeatures={scenario?.terrainFeatures}
            unitConflictIds={[...conflictUnitIds()]}
            changedUnitIds={[...changedByUnit.keys()]}
            battleClickable={canDraft}
            onBattleMapClick={handleBattleMapClick}
            battleGhosts={battleGhosts}
            battlePaths={battlePaths}
            battleShootLines={battleShootLines}
            battleCandidateCharges={battleCandidateCharges}
            battleCandidateShoots={battleCandidateShoots}
            battleConflictPoints={conflictPoints()}
            battleRotateUnitId={
              canDraft && selectedUnitId && draftForUnit(selectedUnitId)?.kind === 'Move'
                ? selectedUnitId
                : null
            }
            onBattleRotate={handleBattleRotate}
          />
          <p className="map-hint">
            {canDraft
              ? `Select your unit · click the map for Move legs (${MAX_MOVE_LEGS}) or Charge approaches (${MAX_APPROACH_LEGS}) · click a highlighted target to Charge or Shoot · drag the round handle to rotate · scroll to zoom · drag to pan`
              : 'The map is shared with the editor and read-only here: scroll to zoom, drag to pan, 0 fits the battlefield.'}
          </p>
        </section>
        <aside className="right-panel panel" aria-label="Inspector" data-testid="battle-inspector">
          {announcement ? (
            <div className="announcement" data-testid="starting-announcement">
              {announcement}
            </div>
          ) : null}
          {selectedUnit ? (
            <section aria-label="Selected unit" data-testid="battle-unit-inspector">
              <span className="eyebrow">SELECTED UNIT</span>
              <h3 data-testid="battle-unit-title">{selectedUnit.name || 'Unit'}</h3>
              <dl>
                <div className="kv">
                  <dt>Side</dt>
                  <dd data-testid="battle-unit-side">{sideName(battle, selectedUnit.side)}</dd>
                </div>
                <div className="kv">
                  <dt>Troop type</dt>
                  <dd>{selectedUnit.troopType}</dd>
                </div>
                <div className="kv">
                  <dt>Soldiers</dt>
                  <dd data-testid="battle-unit-soldiers">{selectedUnit.soldiers}</dd>
                </div>
                <div className="kv">
                  <dt>Cohesion</dt>
                  <dd data-testid="battle-unit-cohesion">{selectedUnit.cohesion || '—'}</dd>
                </div>
                {selectedEntry ? (
                  <>
                    <div className="kv">
                      <dt>Movement allowance</dt>
                      <dd data-testid="battle-unit-allowance">
                        {Number.isFinite(selectedEntry.movementAllowanceM)
                          ? `${selectedEntry.movementAllowanceM} m`
                          : '—'}
                      </dd>
                    </div>
                    <div className="kv">
                      <dt>Permitted orders</dt>
                      <dd data-testid="battle-unit-permitted">
                        {(selectedEntry.permitted || []).map((item: any) => item.kind).join(', ') ||
                          '—'}
                      </dd>
                    </div>
                  </>
                ) : null}
                {selectedEntry && (selectedEntry.unavailable || []).length > 0 ? (
                  <ul className="unavailable" data-testid="battle-unit-unavailable">
                    {(selectedEntry.unavailable || []).map((item: any) => (
                      <li key={item.kind}>
                        <strong>{item.kind}</strong> — {item.reason || item.code || 'unavailable'}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </dl>
              {canDraft && selectedUnit.side === activeSide ? (
                <>
                  <div className="inspector-drafts">
                    <span className="field-label">
                      Draft an order
                      {draftForUnit(selectedUnit.id)
                        ? ` (now: ${draftKindOf(draftForUnit(selectedUnit.id))})`
                        : ''}
                    </span>
                    <div className="handoff-actions">
                      {permittedKindsOf(selectedUnit.id).includes('Move') ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          data-testid={`start-draft-${selectedUnit.id}`}
                          onClick={() => startMoveDraft(selectedUnit.id)}
                        >
                          Draft Move
                        </button>
                      ) : null}
                      {permittedKindsOf(selectedUnit.id).includes('Charge') ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          data-testid={`start-charge-${selectedUnit.id}`}
                          onClick={() => startChargeDraft(selectedUnit.id)}
                        >
                          Draft Charge
                        </button>
                      ) : null}
                      {permittedKindsOf(selectedUnit.id).includes('Shoot') ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          data-testid={`start-shoot-${selectedUnit.id}`}
                          onClick={() => startShootDraft(selectedUnit.id)}
                        >
                          Draft Shoot
                        </button>
                      ) : null}
                      {permittedKindsOf(selectedUnit.id).includes('Reform') ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          data-testid={`start-reform-${selectedUnit.id}`}
                          onClick={() => startReformDraft(selectedUnit.id)}
                        >
                          Draft Reform
                        </button>
                      ) : null}
                      {permittedKindsOf(selectedUnit.id).includes('Withdraw') ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          data-testid={`start-withdraw-${selectedUnit.id}`}
                          onClick={() => startWithdrawDraft(selectedUnit.id)}
                        >
                          Draft Withdraw
                        </button>
                      ) : null}
                      {permittedKindsOf(selectedUnit.id).includes('Rally') ? (
                        <button
                          type="button"
                          className="btn-secondary"
                          data-testid={`start-rally-${selectedUnit.id}`}
                          onClick={() => startRallyDraft(selectedUnit.id)}
                        >
                          Draft Rally
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {permittedKindsOf(selectedUnit.id).includes('Charge') &&
                  chargeCandidatesOf(selectedUnit.id).length > 0 ? (
                    <div className="candidates">
                      <span className="field-label">Charge candidates</span>
                      <ul className="candidate-list">
                        {chargeCandidatesOf(selectedUnit.id).map((candidate: any) => (
                          <li key={candidate.targetId}>
                            <button
                              type="button"
                              className="btn-quiet candidate-pick"
                              data-testid={`charge-${selectedUnit.id}-${candidate.targetId}`}
                              onClick={() =>
                                startChargeDraft(selectedUnit.id, candidate.targetId, candidate.edge)
                              }
                            >
                              Charge {unitDisplayName(candidate.targetId)} ({candidate.edge},{' '}
                              {candidate.aspect}, {candidate.distanceM} m)
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {permittedKindsOf(selectedUnit.id).includes('Shoot') &&
                  shootCandidatesOf(selectedUnit.id).length > 0 ? (
                    <div className="candidates">
                      <span className="field-label">Shoot candidates</span>
                      <ul className="candidate-list">
                        {shootCandidatesOf(selectedUnit.id).map((candidate: any) => (
                          <li key={candidate.targetId}>
                            <button
                              type="button"
                              className="btn-quiet candidate-pick"
                              data-testid={`shoot-${selectedUnit.id}-${candidate.targetId}`}
                              onClick={() => startShootDraft(selectedUnit.id, candidate.targetId)}
                            >
                              Shoot {unitDisplayName(candidate.targetId)} ({candidate.distanceM} m)
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {permittedKindsOf(selectedUnit.id).includes('Withdraw') ? (
                    <p className="draft-hint">
                      Withdraw steps straight back without turning and breaks every contact. The
                      ghost shows the step back.
                    </p>
                  ) : null}
                </>
              ) : null}
            </section>
          ) : (
            <p className="empty-inspector" data-testid="battle-inspector-empty">
              Select a unit in the order of battle or on the map to inspect it.
            </p>
          )}
          {canDraft &&
          selectedUnit &&
          selectedUnit.side === activeSide &&
          draftForUnit(selectedUnit.id)
            ? draftEditor(selectedUnit)
            : null}
          <section aria-label="Turn" data-testid="turn-panel">
            {finished ? (
              <>
                <span className="eyebrow">BATTLE OVER</span>
                <h2 data-testid="battle-status">{battle?.status}</h2>
                <div className="kv">
                  <dt>Status</dt>
                  <dd>
                    {battle?.status}
                    {winnerName ? ` · winner ${winnerName}` : ' · draw'}
                  </dd>
                </div>
                <section aria-label="Battle outcome" data-testid="battle-outcome">
                  <span className="eyebrow">OUTCOME</span>
                  <h3 data-testid="outcome-title">
                    {winnerName ? `${winnerName} wins` : 'Draw'}
                  </h3>
                  <p data-testid="outcome-reason">{outcomeReason()}</p>
                  {outcomeMargin() ? (
                    <p data-testid="outcome-margin">{outcomeMargin()}</p>
                  ) : null}
                  <ul className="outcome-losses" data-testid="outcome-losses">
                    {sides.map((side: any) => (
                      <li key={side?.id ?? side?.name}>
                        <strong>{side?.name ?? side?.id}</strong> —{' '}
                        {typeof sideLosses[side?.id] === 'number' &&
                        Number.isFinite(sideLosses[side?.id])
                          ? `${sideLosses[side?.id]} soldiers lost`
                          : 'losses unknown'}{' '}
                        · lost share {percent(lostShares[side?.id])}
                      </li>
                    ))}
                  </ul>
                </section>
                <div className="handoff" data-testid="battle-finished">
                  <p>
                    This battle is finished and read-only. The final map and the battle log stay
                    viewable; the battle stays on the Battles list.
                  </p>
                  <div className="handoff-actions">
                    <button
                      type="button"
                      className="btn-primary"
                      data-testid="rematch"
                      onClick={onRematch}
                    >
                      Rematch
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid="back-to-library"
                      onClick={onBackToLibrary}
                    >
                      Back to library
                    </button>
                    {battle?.scenario?.id ? (
                      <button
                        type="button"
                        className="btn-secondary"
                        data-testid="open-scenario-in-editor"
                        onClick={onOpenScenarioInEditor}
                      >
                        Open scenario in editor
                      </button>
                    ) : null}
                  </div>
                </div>
              </>
            ) : (
              <>
                <span className="eyebrow">TURN {battle?.turnNumber}</span>
                <h2 data-testid="turn-side">{sideName(battle, activeSide)}</h2>
                <div className="kv">
                  <dt>Controller</dt>
                  <dd data-testid="turn-controller">
                    {controller}
                    {automated ? ' (test player)' : ''}
                  </dd>
                </div>
                <div className="kv">
                  <dt>Phase</dt>
                  <dd data-testid="phase">{battle?.phase}</dd>
                </div>
                {awaitingHandoff && handoffSide ? (
                  <div className="handoff" data-testid="handoff-panel">
                    <p>
                      Turn {battle?.turnNumber} resolved. Pass the device, then begin the next turn.
                    </p>
                    <div className="handoff-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        data-testid="handoff"
                        disabled={resolving}
                        onClick={onHandoff}
                      >
                        {sideName(battle, handoffSide)} — begin your turn
                      </button>
                    </div>
                  </div>
                ) : automated ? (
                  <div className="handoff" data-testid="automated-turn">
                    <p>
                      {sideName(battle, activeSide)} is automated ({controller} test player). Its
                      turn resolves at once through the runner.
                    </p>
                    <div className="handoff-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        data-testid="continue-turn"
                        disabled={resolving}
                        onClick={onContinueAutomated}
                      >
                        {resolving ? 'Resolving…' : 'Continue'}
                      </button>
                    </div>
                    {resolveError ? (
                      <p className="field-error" role="alert" data-testid="resolve-error">
                        {resolveError}
                      </p>
                    ) : null}
                  </div>
                ) : confirming ? (
                  <div className="confirm-box" data-testid="commit-confirm">
                    <p>Commit an empty turn for {sideName(battle, activeSide)}? All units hold.</p>
                    <div className="confirm-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        data-testid="confirm-commit"
                        onClick={onCommitEmpty}
                      >
                        Confirm commit
                      </button>
                      <button
                        type="button"
                        className="btn-secondary"
                        data-testid="cancel-commit"
                        onClick={() => setConfirming(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : drafts.length === 0 ? (
                  <>
                    <div className="handoff-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        data-testid="commit-empty"
                        onClick={() => setConfirming(true)}
                      >
                        Commit empty turn
                      </button>
                    </div>
                    <p className="commit-hint">
                      No orders drafted: committing an empty turn holds every unit and needs
                      confirmation, and a committed turn cannot be taken back.
                    </p>
                  </>
                ) : (
                  <>
                    <section aria-label="Turn draft" data-testid="draft-list">
                      <span className="eyebrow">TURN DRAFT</span>
                      <h3>Draft ({drafts.length})</h3>
                      <ol className="draft-rows">
                        {drafts.map((draft, index) => {
                          const verdict = verdictForDraftIndex(index);
                          const accepted = verdict?.accepted === true;
                          const rejection =
                            verdict && verdict.accepted === false ? verdict.rejection : null;
                          const rowClass = ['draft-row'];
                          if (draft.unitId === selectedUnitId) rowClass.push('selected');
                          if (rejection) rowClass.push('rejected');
                          else if (accepted) rowClass.push('accepted');
                          return (
                            <li
                              key={draft.key}
                              className={rowClass.join(' ')}
                              data-testid={`draft-${draft.unitId}`}
                            >
                              <div className="draft-head">
                                <button
                                  type="button"
                                  className="draft-select"
                                  data-testid={`select-draft-${draft.unitId}`}
                                  title="Edit this order"
                                  onClick={() => setSelectedUnitId(draft.unitId)}
                                >
                                  {unitDisplayName(draft.unitId)}
                                </button>
                                <span className="draft-kind">{draftKindOf(draft)}</span>
                                <span className="draft-meta">
                                  {draftSummary(draft)} · order {index + 1}
                                </span>
                              </div>
                              {rejection ? (
                                <p
                                  className="field-error"
                                  role="alert"
                                  data-testid={`draft-rejection-${draft.unitId}`}
                                >
                                  {rejection.message}
                                </p>
                              ) : accepted ? (
                                <p
                                  className="draft-ok"
                                  data-testid={`draft-accepted-${draft.unitId}`}
                                >
                                  {draftAcceptedDetail(verdict)}
                                </p>
                              ) : (
                                <p className="draft-pending">Validating…</p>
                              )}
                              <div className="draft-actions">
                                <button
                                  type="button"
                                  className="btn-quiet"
                                  data-testid={`move-draft-up-${draft.unitId}`}
                                  disabled={index === 0}
                                  title="Move earlier (re-validates)"
                                  onClick={() => moveDraft(draft.unitId, -1)}
                                >
                                  ↑
                                </button>
                                <button
                                  type="button"
                                  className="btn-quiet"
                                  data-testid={`move-draft-down-${draft.unitId}`}
                                  disabled={index === drafts.length - 1}
                                  title="Move later (re-validates)"
                                  onClick={() => moveDraft(draft.unitId, 1)}
                                >
                                  ↓
                                </button>
                                <button
                                  type="button"
                                  className="btn-quiet btn-danger"
                                  data-testid={`remove-draft-${draft.unitId}`}
                                  title="Remove this order (re-validates)"
                                  onClick={() => removeDraft(draft.unitId)}
                                >
                                  Remove
                                </button>
                              </div>
                            </li>
                          );
                        })}
                      </ol>
                      <p className="readonly-note">
                        Order matters: each order validates against the state left by the orders
                        before it. Reordering re-validates.
                      </p>
                    </section>
                    <div className="handoff-actions">
                      <button
                        type="button"
                        className="btn-primary"
                        data-testid="commit-draft"
                        disabled={!validation?.ok}
                        onClick={() => draftSubmission && onCommitDraft(draftSubmission.orders)}
                      >
                        Commit turn ({drafts.length} {drafts.length === 1 ? 'order' : 'orders'})
                      </button>
                    </div>
                    {(validation?.verdicts || []).filter((verdict: any) => verdict?.accepted === false)
                      .length > 0 ? (
                      <p className="field-error" role="alert" data-testid="commit-blocked">
                        {(validation?.verdicts || []).filter(
                          (verdict: any) => verdict?.accepted === false,
                        ).length}{' '}
                        of {(validation?.verdicts || []).length} orders rejected — fix or remove
                        them to commit.
                      </p>
                    ) : (
                      <p className="commit-hint">
                        Every order is accepted. A committed turn cannot be taken back.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            {summary ? (
              <>
                <hr className="panel-divider" />
                <section aria-label="Turn result" data-testid="turn-result">
                  <span className="eyebrow">
                    TURN {summary.turnNumber} RESULT ·{' '}
                    {String(sideName(battle, summary.side ?? '')).toUpperCase()}
                  </span>
                  <dl className="result">
                    <dt>Contacts</dt>
                    <dd>
                      <ul className="result-list">
                        {summary.contacts.length > 0 ? (
                          summary.contacts.map((event: any, index: number) => (
                            <li key={index}>{describeBattleEvent(event, battle)}</li>
                          ))
                        ) : (
                          <li className="empty-result">No new contacts.</li>
                        )}
                      </ul>
                    </dd>
                    <dt>Losses</dt>
                    <dd>
                      <ul className="result-list">
                        {summary.losses.length > 0 || lossDraws.length > 0 ? (
                          <>
                            {summary.losses.map((loss: any, index: number) => (
                              <li key={`loss-${index}`}>
                                <strong>{unitDisplayName(loss.unitId)}</strong> lost {loss.losses}{' '}
                                {loss.kind === 'shot' ? 'shot' : 'in combat'}
                                {loss.before !== null && loss.before !== undefined
                                  ? ` (${loss.before} → ${loss.after})`
                                  : ''}
                                {loss.byUnitId ? ` — by ${unitDisplayName(loss.byUnitId)}` : ''}
                              </li>
                            ))}
                            {lossDraws.map((event: any, index: number) => (
                              <li className="chance" key={`loss-draw-${index}`}>
                                {describeBattleEvent(event, battle)}
                              </li>
                            ))}
                          </>
                        ) : (
                          <li className="empty-result">No losses.</li>
                        )}
                      </ul>
                    </dd>
                    <dt>Cohesion</dt>
                    <dd>
                      <ul className="result-list">
                        {summary.cohesion.length > 0 || cohesionDraws.length > 0 ? (
                          <>
                            {summary.cohesion.map((event: any, index: number) => (
                              <li key={`cohesion-${index}`}>
                                {describeBattleEvent(event, battle)}
                              </li>
                            ))}
                            {cohesionDraws.map((event: any, index: number) => (
                              <li className="chance" key={`cohesion-draw-${index}`}>
                                {describeBattleEvent(event, battle)}
                              </li>
                            ))}
                          </>
                        ) : (
                          <li className="empty-result">No cohesion changes.</li>
                        )}
                      </ul>
                    </dd>
                    <dt>Routs &amp; removals</dt>
                    <dd>
                      <ul className="result-list">
                        {summary.routs.length > 0 || routDraws.length > 0 ? (
                          <>
                            {summary.routs.map((event: any, index: number) => (
                              <li key={`rout-${index}`}>
                                {describeBattleEvent(event, battle)}
                              </li>
                            ))}
                            {routDraws.map((event: any, index: number) => (
                              <li className="chance" key={`rout-draw-${index}`}>
                                {describeBattleEvent(event, battle)}
                              </li>
                            ))}
                          </>
                        ) : (
                          <li className="empty-result">No routs, flights, or destroyed units.</li>
                        )}
                      </ul>
                    </dd>
                    <dt>Orders carried out</dt>
                    <dd>
                      <ul className="result-list">
                        {summary.orders.length > 0 ? (
                          summary.orders.map((event: any, index: number) => (
                            <li key={index}>{describeBattleEvent(event, battle)}</li>
                          ))
                        ) : (
                          <li className="empty-result">No orders: every unit held.</li>
                        )}
                      </ul>
                    </dd>
                    {summary.fallbacks.length > 0 ? (
                      <>
                        <dt>Substitutions</dt>
                        <dd>
                          <ul className="result-list">
                            {summary.fallbacks.map((event: any, index: number) => (
                              <li key={index}>{describeBattleEvent(event, battle)}</li>
                            ))}
                          </ul>
                        </dd>
                      </>
                    ) : null}
                    {summary.ended ? (
                      <>
                        <dt>Battle end</dt>
                        <dd>
                          <ul className="result-list">
                            <li>{describeBattleEvent(summary.ended, battle)}</li>
                          </ul>
                        </dd>
                      </>
                    ) : null}
                  </dl>
                </section>
              </>
            ) : null}
            <hr className="panel-divider" />
            <span className="eyebrow">BATTLE LOG</span>
            <div className="battle-log-scroll">
              <ol className="log-list log-grouped" data-testid="battle-log">
                {logGroups.map((group: any, index: number) =>
                  group.turnNumber === 0 ? (
                    <li className="log-turn" key={index}>
                      <span className="log-turn-head">Battle start</span>
                      <ul className="log-lines">
                        {(group.events || []).map((event: any, line: number) => (
                          <li key={line}>{describeBattleEvent(event, battle)}</li>
                        ))}
                      </ul>
                    </li>
                  ) : (
                    <li className="log-turn" key={index}>
                      <span className="log-turn-head">
                        Round {group.round} · Turn {group.turnNumber} —{' '}
                        {sideName(battle, group.side)}
                      </span>
                      <ul className="log-phases">
                        {(group.sections || []).map((section: any, other: number) => (
                          <li className="log-phase" key={other}>
                            <span className="log-phase-head">{section.phase}</span>
                            <ul className="log-lines">
                              {(section.events || []).map((event: any, line: number) => (
                                <li key={line}>{describeBattleEvent(event, battle)}</li>
                              ))}
                            </ul>
                          </li>
                        ))}
                      </ul>
                    </li>
                  ),
                )}
              </ol>
            </div>
          </section>
        </aside>
      </main>
      <div className="turnbar" data-testid="turn-bar">
        <span className="round" data-testid="round">
          Round {battle?.round} / {limit} · Turn {battle?.turnNumber}
        </span>
        <span className="active-side" data-testid="active-side">
          <span
            className="swatch"
            style={{ background: sideColor(battle, activeSide) }}
            aria-hidden="true"
          />
          <span style={{ color: sideColor(battle, activeSide) }}>
            {sideName(battle, activeSide)}
          </span>
        </span>
        <span className="phase" data-testid="turnbar-phase">
          Phase: {battle?.phase}
        </span>
        <span className="spacer" />
        {finished ? null : concedeConfirming ? (
          <span className="concede-confirm" data-testid="concede-confirm-box">
            Concede the battle?
            <button
              type="button"
              className="btn-primary"
              data-testid="concede-confirm"
              onClick={() => {
                setConcedeConfirming(false);
                onConcede();
              }}
            >
              Yes, concede
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid="concede-cancel"
              onClick={() => setConcedeConfirming(false)}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="btn-secondary"
            data-testid="concede"
            disabled={!canConcede}
            title="Concede the battle (only on your own turn)"
            onClick={requestConcede}
          >
            Concede
          </button>
        )}
        <button
          type="button"
          className="btn-quiet"
          data-testid="back-to-battles"
          onClick={onBackToLibrary}
        >
          Battles
        </button>
      </div>
    </div>
  );
}
