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
import { sideName, sideColor, roundLimitOf, isAutomatedController } from './battle/battle-helpers';
import { createDraftEditor } from './battle/draft-editors';
import { TurnPanel } from './battle/turn-panel';
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

  // Battle helpers live in ./battle/battle-helpers (pure move, no behaviour change).

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

  const { draftEditor } = createDraftEditor({ turnDraft });


  // Draft summaries and outcome helpers live in ./battle/turn-panel (pure move).

  // Ghost footprints, leg paths, shoot lines and candidate highlights come
  // from the shared turn-draft controller (see above); the screen only renders
  // them.

  // Turn-result log groups and draws live in ./battle/turn-panel (pure move).

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

  // Outcome helpers live in ./battle/turn-panel (pure move).

  return (
    <div
      data-testid="battle-screen"
      data-turn={`${battle?.round ?? ''}:${battle?.turnNumber ?? ''}:${battle?.activeSide ?? ''}:${battle?.phase ?? ''}:${battle?.status ?? ''}`}
      data-resolving={resolving ? 'true' : 'false'}
      data-awaiting-handoff={awaitingHandoff ? 'true' : 'false'}
      data-handoff-side={handoffSide ?? ''}
      data-active-side={battle?.activeSide ?? ''}
    >
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
            unitCard={
              canDraft && selectedUnit && selectedUnit.side === activeSide
                ? {
                    unit: selectedUnit,
                    movementAllowanceM: selectedEntry?.movementAllowanceM,
                    orders: {
                      unitId: selectedUnit.id,
                      permitted: permittedKindsOf(selectedUnit.id),
                      chargeCandidates: chargeCandidatesOf(selectedUnit.id),
                      shootCandidates: shootCandidatesOf(selectedUnit.id),
                      draft: draftForUnit(selectedUnit.id),
                      displayName: unitDisplayName,
                      onPickChargeTarget: (targetId: string) => {
                        const candidates = chargeCandidatesOf(selectedUnit.id);
                        const chosen = candidates.find(
                          (candidate: any) => String(candidate.targetId) === String(targetId),
                        );
                        if (!chosen) return;
                        if (draftForUnit(selectedUnit.id)?.kind === 'Charge') {
                          setChargeTarget(selectedUnit.id, chosen.targetId, chosen.edge);
                        } else {
                          startChargeDraft(selectedUnit.id, chosen.targetId, chosen.edge);
                        }
                      },
                      onChargeEdge: (edge: string) => setChargeEdge(selectedUnit.id, edge),
                      onPickShootTarget: (targetId: string) => {
                        const candidates = shootCandidatesOf(selectedUnit.id);
                        const chosen = candidates.find(
                          (candidate: any) => String(candidate.targetId) === String(targetId),
                        );
                        if (!chosen) return;
                        if (draftForUnit(selectedUnit.id)?.kind === 'Shoot') {
                          setShootTarget(selectedUnit.id, chosen.targetId);
                        } else {
                          startShootDraft(selectedUnit.id, chosen.targetId);
                        }
                      },
                      onUndoApproach: () => removeLastApproachLeg(selectedUnit.id),
                      onClearApproach: () => clearApproachLegs(selectedUnit.id),
                    },
                  }
                : null
            }
            onCloseUnitCard={() => setSelectedUnitId(null)}
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
          <TurnPanel
            battle={battle}
            sides={sides}
            turnDraft={turnDraft}
            confirming={confirming}
            setConfirming={setConfirming}
            resolving={resolving}
            resolveError={resolveError}
            awaitingHandoff={awaitingHandoff}
            handoffSide={handoffSide}
            onHandoff={onHandoff}
            onCommitEmpty={onCommitEmpty}
            onCommitDraft={onCommitDraft}
            onContinueAutomated={onContinueAutomated}
            onRematch={onRematch}
            onOpenScenarioInEditor={onOpenScenarioInEditor}
            onBackToLibrary={onBackToLibrary}
          />
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
