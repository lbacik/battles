'use client';

// The battle screen (prototype layout A): order of battle left, the map
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

import { useEffect, useMemo, useState } from 'react';
import BattlefieldMap from './battlefield-map';
import { PanelToggle, panelGridColumns, panelMinWidth, usePersistentPanel } from './collapsible-panel';
import { TURN_PHASE_ORDERS } from '../domain/battle.js';
import { CHARGE_EDGES, MAX_APPROACH_LEGS } from '../domain/charge.js';
import { MAX_MOVE_LEGS } from '../domain/movement.js';
import { isBattleFinished } from '../domain/battles.js';
import { useTurnDraftController } from './turn-draft-controller';
import type { DraftLeg, OrderDraft } from './turn-draft-controller';
import {
  changedUnitsForTurn,
  describeBattleEvent,
  groupLogEvents,
  lastResolvedTurnNumber,
  summarizeTurn,
} from '../domain/battle-log.js';

type BattleDocument = any;

// Order-draft shapes live with the shared turn-draft controller
// (app/turn-draft-controller.ts); the screen imports them for its summaries.

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
  const [confirming, setConfirming] = useState(false);
  // Collapsible side panels (issues #112, #113): the same mechanism as the
  // scenario editor's panels (app/collapsible-panel.tsx) — each panel
  // collapses to a narrow strip with an expand control. The collapsed state
  // is a browser-only preference per screen and per panel (localStorage), so
  // a reload restores it; missing or unreadable values start expanded.
  // Selection and draft state live above the panels (in the shared
  // turn-draft controller below), so selecting on the map while a panel is
  // collapsed works and expanding shows the current selection. The map keeps
  // its camera across resizes, so the view never jumps away when a panel
  // collapses or expands.
  const [leftCollapsed, setLeftCollapsed] = usePersistentPanel('battle', 'left');
  const [rightCollapsed, setRightCollapsed] = usePersistentPanel('battle', 'right');
  // A concede needs its own confirmation step in the turn bar, separate from
  // the empty-commit confirmation: requesting it locks drafting until the
  // player confirms or cancels.
  const [concedeConfirming, setConcedeConfirming] = useState(false);
  const scenario = battle?.scenario;
  const units: any[] = Array.isArray(battle?.units) ? battle.units : [];
  const sides: any[] = Array.isArray(scenario?.sides) ? scenario.sides : [];
  const finished = isBattleFinished(battle);
  const activeSide = battle?.activeSide;
  const controller = battle?.controllers?.[activeSide] || 'human';
  const automated = isAutomatedController(controller);
  const limit = roundLimitOf(battle);
  const lastResolved = lastResolvedTurnNumber(battle);

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

  // The shared turn-draft controller (issue #122): the selected unit, the
  // ordered turn draft, the engine validation result and the per-unit
  // available-actions lookups, plus every draft operation the inspector and
  // the map use. The screen keeps only rendering (plus its confirm/panel
  // UI); every hint and verdict comes from the engine through the
  // controller, which holds no ruleset logic of its own (ADR 0005). The
  // inspector panel and the battlefield map's selection, open-ground click
  // and rotation-handle handlers below all go through it. Draft reset on
  // turn commit and stale-selection clearing live in the controller and
  // behave as before; the confirmation reset stays here with the confirm UI.
  const turnDraft = useTurnDraftController({
    battle,
    activeSide,
    canDraft,
    finished,
    onDraftMutated: () => setConfirming(false),
  });
  const {
    selectedUnit,
    selectedUnitId,
    drafts,
    draftSubmission,
    validation,
    selectedEntry,
    battleGhosts,
    battlePaths,
    battleShootLines,
    battleCandidateCharges,
    battleCandidateShoots,
    selectUnit: setSelectedUnitId,
    draftForUnit,
    draftKindOf,
    permittedKindsOf,
    chargeCandidatesOf,
    shootCandidatesOf,
    spacingPresetsOf,
    verdictForDraftIndex,
    conflictUnitIds,
    conflictPoints,
    unitDisplayName,
    startMoveDraft,
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
    removeLastApproachLeg,
    clearApproachLegs,
    removeDraft,
    moveDraft,
    removeLastDraftLeg,
    clearDraftLegs,
    setDraftFacing,
    handleBattleUnitSelect,
    handleBattleMapClick,
    handleBattleRotate,
  } = turnDraft;

  // A committed turn moves play on: the confirmations belong to the turn that
  // was committed, never to the next one. The draft and selection reset live
  // in the controller on the same turn boundary.
  useEffect(() => {
    setConfirming(false);
    setConcedeConfirming(false);
  }, [battle?.turnNumber, battle?.id]);

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

  // Ghost footprints, leg paths, shoot lines and candidate highlights come
  // from the shared turn-draft controller (see above); the screen only renders
  // them.

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
      <main
        className="workspace battle-workspace"
        data-testid="battle-workspace"
        data-left-collapsed={leftCollapsed ? 'true' : 'false'}
        data-right-collapsed={rightCollapsed ? 'true' : 'false'}
        style={{ gridTemplateColumns: panelGridColumns(leftCollapsed, rightCollapsed), minWidth: panelMinWidth(leftCollapsed, rightCollapsed) }}
      >
        <aside
          className={leftCollapsed ? 'left-panel panel collapsed' : 'left-panel panel'}
          aria-label="Order of battle"
          data-testid="battle-left-panel"
          data-collapsed={leftCollapsed ? 'true' : 'false'}
        >
          <PanelToggle
            side="left"
            collapsed={leftCollapsed}
            onToggle={() => setLeftCollapsed((value) => !value)}
            collapseTestId="collapse-left-panel"
            expandTestId="expand-left-panel"
          />
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
        <aside
          className={rightCollapsed ? 'right-panel panel collapsed' : 'right-panel panel'}
          aria-label="Inspector"
          data-testid="battle-inspector"
          data-collapsed={rightCollapsed ? 'true' : 'false'}
        >
          <PanelToggle
            side="right"
            collapsed={rightCollapsed}
            onToggle={() => setRightCollapsed((value) => !value)}
            collapseTestId="collapse-right-panel"
            expandTestId="expand-right-panel"
          />
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
