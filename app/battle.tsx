'use client';

// The battle screen (prototype layout A): order of battle left, the map
// shared with the editor centre, the selected unit's inspector right, and the
// bottom turn bar showing round and round limit, the active side in its
// colour, and the phase.
//
// During a human turn the side drafts Move orders: one per unit, up to three
// leg points clicked on the map with a rotation handle. Every draft change
// calls the engine's `validateTurn`: an accepted order shows a ghost footprint
// of its movement preview, a rejected one shows its message inline and
// highlights the conflict. Drafts can be removed and reordered (reordering
// re-validates); Commit is enabled only while every order is accepted, and a
// committed turn cannot be taken back. Automated turns resolve through the
// runner and wait for "Continue". The screen holds no legality rules:
// playability comes from `validatePlayability`, every hint from
// `availableActions`, and every draft and commit from `validateTurn`.

import { useEffect, useMemo, useRef, useState } from 'react';
import BattlefieldMap from './battlefield-map';
import { TURN_PHASE_ORDERS } from '../domain/battle.js';
import {
  SUBMISSION_FORMAT_VERSION,
  availableActions,
  validateTurn,
} from '../domain/turn.js';
import { MAX_MOVE_LEGS } from '../domain/movement.js';
import { normalizeFacing } from '../domain/scenario.js';
import { round1 } from '../domain/geometry.js';
import { isBattleFinished } from '../domain/battles.js';
import {
  describeBattleEvent,
  groupLogEvents,
  lastResolvedTurnNumber,
  summarizeTurn,
} from '../domain/battle-log.js';

type BattleDocument = any;

// A Move draft for one unit: up to three `{ face, to }` legs in draft order.
// A leg with only a rotation is allowed. The engine alone decides legality.
interface MoveDraft {
  key: string;
  unitId: string;
  legs: { face: number | null; to: { x: number; y: number } | null }[];
}

interface BattleScreenProps {
  battle: BattleDocument;
  announcement: string | null;
  resolving: boolean;
  resolveError: string | null;
  onCommitEmpty: () => void;
  onCommitDraft: (orders: any[]) => void;
  onContinueAutomated: () => void;
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
  onCommitEmpty,
  onCommitDraft,
  onContinueAutomated,
  onBackToLibrary,
}: BattleScreenProps) {
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // The ordered turn draft: at most one Move draft per unit. Every mutation
  // rebuilds the turn submission in draft order and re-validates it against
  // the authoritative battle state, so the verdicts always describe the
  // current draft. Units without a draft hold implicitly.
  const [drafts, setDrafts] = useState<MoveDraft[]>([]);
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
  // through the runner, and nothing drafts outside the Orders phase.
  const canDraft =
    !finished && !automated && battle?.phase === TURN_PHASE_ORDERS && !resolving;

  function ownUnit(unitId: string | null): any {
    if (!unitId) return null;
    return units.find((unit) => unit?.id === unitId && unit?.side === activeSide) || null;
  }

  function draftForUnit(unitId: string): MoveDraft | null {
    return drafts.find((draft) => draft.unitId === unitId) || null;
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

  // The draft submission in draft order, one Move order per draft, validated
  // by the engine on every change.
  const draftSubmission = useMemo(() => {
    if (!battle) return null;
    return {
      formatVersion: SUBMISSION_FORMAT_VERSION,
      battleId: battle.id,
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      orders: drafts.map((draft) => ({
        unitId: draft.unitId,
        kind: 'Move',
        legs: draft.legs.map((leg) => ({
          ...(leg.face === null || leg.face === undefined ? {} : { face: leg.face }),
          ...(leg.to ? { to: { ...leg.to } } : {}),
        })),
      })),
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

  // Units named as the conflict by a rejection, drawn as map highlights: the
  // collision partner (`details.withUnitId`). The rejected unit itself is
  // outlined by its draft row; only the other party highlights on the map.
  function conflictUnitIds(): Set<string> {
    const ids = new Set<string>();
    for (const verdict of validation?.verdicts || []) {
      const details = verdict?.accepted === false ? verdict?.rejection?.details : null;
      if (!details) continue;
      if (typeof details.withUnitId === 'string') ids.add(details.withUnitId);
    }
    return ids;
  }

  function conflictPoints(): { x: number; y: number }[] {
    const points: { x: number; y: number }[] = [];
    for (const verdict of validation?.verdicts || []) {
      if (verdict?.accepted !== false) continue;
      const at = verdict?.rejection?.details?.at;
      if (at && Number.isFinite(at?.x) && Number.isFinite(at?.y)) {
        points.push({ x: at.x, y: at.y });
      }
    }
    return points;
  }

  function startMoveDraft(unitId: string): void {
    if (!canDraft) return;
    if (!ownUnit(unitId)) return;
    if (!permittedKindsOf(unitId).includes('Move')) return;
    setDrafts((prev) => {
      if (prev.some((draft) => draft.unitId === unitId)) return prev;
      return [...prev, { key: `draft-${draftSeq.current++}`, unitId, legs: [] }];
    });
    setSelectedUnitId(unitId);
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
      if (draft.unitId !== unitId || draft.legs.length >= MAX_MOVE_LEGS) return draft;
      return { ...draft, legs: [...draft.legs, { face: null, to: snapped }] };
    }));
    setConfirming(false);
  }

  function removeLastDraftLeg(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId || draft.legs.length === 0) return draft;
      return { ...draft, legs: draft.legs.slice(0, -1) };
    }));
    setConfirming(false);
  }

  function clearDraftLegs(unitId: string): void {
    setDrafts((prev) => prev.map((draft) => (draft.unitId === unitId && draft.legs.length > 0
      ? { ...draft, legs: [] }
      : draft)));
    setConfirming(false);
  }

  function setDraftFacing(unitId: string, raw: string): void {
    if (!canDraft) return;
    const text = String(raw ?? '').trim();
    setDrafts((prev) => prev.map((draft) => {
      if (draft.unitId !== unitId) return draft;
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

  function handleBattleMapClick(point: { x: number; y: number }): void {
    if (!canDraft || !selectedUnitId) return;
    const draft = draftForUnit(selectedUnitId);
    if (!draft || draft.legs.length >= MAX_MOVE_LEGS) return;
    appendDraftLeg(selectedUnitId, point);
  }

  function handleBattleRotate(facing: number): void {
    if (!canDraft || !selectedUnitId) return;
    setDraftFacing(selectedUnitId, String(facing));
  }

  function unitDisplayName(unitId: string): string {
    return units.find((unit: any) => unit?.id === unitId)?.name || unitId;
  }

  // One-line accepted detail for a draft from its verdict preview.
  function draftAcceptedDetail(verdict: any): string {
    if (verdict?.movement && Number.isFinite(verdict.movement.requiredM)) {
      return `Accepted · needs ${verdict.movement.requiredM} m of ${verdict.movement.availableM} m.`;
    }
    return 'Accepted.';
  }

  // Ghost footprints for accepted drafts (the Movement-phase preview) and leg
  // paths for every draft; rejected drafts draw in red. Shoot-less Move-only
  // slice: every draft is a Move.
  const battleGhosts = useMemo(() => {
    const ghosts: { unitId: string; corners: { x: number; y: number }[] }[] = [];
    for (const verdict of validation?.verdicts || []) {
      if (!verdict?.accepted || !verdict.preview?.corners) continue;
      if (!Array.isArray(verdict.preview.corners) || verdict.preview.corners.length < 3) continue;
      ghosts.push({ unitId: verdict.unitId, corners: verdict.preview.corners });
    }
    return ghosts;
  }, [validation]);

  const battlePaths = useMemo(() => {
    const paths: { points: { x: number; y: number }[]; rejected: boolean; label: string }[] = [];
    drafts.forEach((draft, index) => {
      const mover = units.find((unit: any) => unit?.id === draft.unitId);
      const start = mover?.position && Number.isFinite(mover.position?.x) && Number.isFinite(mover.position?.y)
        ? { x: mover.position.x, y: mover.position.y }
        : null;
      const stops = (draft.legs || []).filter((leg) => leg.to).map((leg) => leg.to as { x: number; y: number });
      if (!start || stops.length === 0) return;
      const verdict = verdictForDraftIndex(index);
      paths.push({
        points: [start, ...stops],
        rejected: verdict?.accepted === false,
        label: 'Leg',
      });
    });
    return paths;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drafts, validation, units]);

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

  const result = battle?.result && typeof battle.result === 'object' ? battle.result : null;
  const winnerName = battle?.winner ? sideName(battle, battle.winner) : null;

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
      return 'Concession.';
    }
    return `Ended: ${result.reason}.`;
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
                {sideUnits.map((unit: any) => (
                  <button
                    type="button"
                    className={
                      unit?.id === selectedUnitId ? 'unit-row selected' : 'unit-row selectable'
                    }
                    key={unit?.id ?? unit?.name}
                    data-testid="battle-oob-unit"
                    data-unit-id={unit?.id ?? ''}
                    data-selected={unit?.id === selectedUnitId ? 'true' : 'false'}
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
                      </span>
                    </span>
                  </button>
                ))}
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
          </div>
          <BattlefieldMap
            width={scenario?.battlefield?.width}
            height={scenario?.battlefield?.height}
            units={units}
            sides={sides}
            selectedUnitId={selectedUnitId}
            onSelectUnit={(id: string | null) => setSelectedUnitId(id)}
            terrainFeatures={scenario?.terrainFeatures}
            unitConflictIds={[...conflictUnitIds()]}
            battleClickable={canDraft}
            onBattleMapClick={handleBattleMapClick}
            battleGhosts={battleGhosts}
            battlePaths={battlePaths}
            battleConflictPoints={conflictPoints()}
            battleRotateUnitId={
              canDraft && selectedUnitId && draftForUnit(selectedUnitId) ? selectedUnitId : null
            }
            onBattleRotate={handleBattleRotate}
          />
          <p className="map-hint">
            {canDraft
              ? `Select your unit · click the map for Move legs (up to ${MAX_MOVE_LEGS}) · drag the round handle to rotate · scroll to zoom · drag to pan`
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
              {canDraft &&
              selectedUnit.side === activeSide &&
              permittedKindsOf(selectedUnit.id).includes('Move') ? (
                <div className="inspector-drafts">
                  <span className="field-label">
                    Draft an order{draftForUnit(selectedUnit.id) ? ' (now: Move)' : ''}
                  </span>
                  <div className="handoff-actions">
                    <button
                      type="button"
                      className="btn-secondary"
                      data-testid={`start-draft-${selectedUnit.id}`}
                      onClick={() => startMoveDraft(selectedUnit.id)}
                    >
                      Draft Move
                    </button>
                  </div>
                </div>
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
          draftForUnit(selectedUnit.id) ? (
            <section aria-label="Move draft" data-testid={`draft-editor-${selectedUnit.id}`}>
              <span className="eyebrow">MOVE DRAFT</span>
              <ol className="leg-list">
                {(draftForUnit(selectedUnit.id)?.legs || []).length === 0 ? (
                  <li className="leg-empty">No legs yet — click the map for leg 1.</li>
                ) : (
                  (draftForUnit(selectedUnit.id)?.legs || []).map((leg: any, index: number) => (
                    <li key={index}>
                      Leg {index + 1}:{' '}
                      {leg.to
                        ? `(${leg.to.x.toFixed(1)}, ${leg.to.y.toFixed(1)})`
                        : 'rotation only'}
                      {leg.face !== null && leg.face !== undefined ? ` · face ${leg.face}°` : ''}
                    </li>
                  ))
                )}
              </ol>
              <p className="draft-hint">
                Click the map for leg {(draftForUnit(selectedUnit.id)?.legs || []).length + 1}{' '}
                (up to {MAX_MOVE_LEGS}) · drag the round handle or type a facing to rotate about
                the front midpoint.
              </p>
              <label className="field">
                Facing (°)
                <input
                  type="number"
                  data-testid={`draft-facing-${selectedUnit.id}`}
                  min={0}
                  max={360}
                  step={1}
                  value={
                    [...(draftForUnit(selectedUnit.id)?.legs || [])]
                      .reverse()
                      .find((leg: any) => leg.face !== null && leg.face !== undefined)?.face ?? ''
                  }
                  placeholder="—"
                  onChange={(event) => setDraftFacing(selectedUnit.id, event.target.value)}
                />
              </label>
              <div className="draft-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid={`remove-last-leg-${selectedUnit.id}`}
                  disabled={(draftForUnit(selectedUnit.id)?.legs || []).length === 0}
                  onClick={() => removeLastDraftLeg(selectedUnit.id)}
                >
                  Undo leg
                </button>
                <button
                  type="button"
                  className="btn-secondary"
                  data-testid={`clear-legs-${selectedUnit.id}`}
                  disabled={(draftForUnit(selectedUnit.id)?.legs || []).length === 0}
                  onClick={() => clearDraftLegs(selectedUnit.id)}
                >
                  Clear legs
                </button>
              </div>
            </section>
          ) : null}
          <section aria-label="Turn" data-testid="turn-panel">
            {finished ? (
              <>
                <span className="eyebrow">BATTLE OVER</span>
                <h2 data-testid="battle-status">{battle?.status}</h2>
                <section aria-label="Battle outcome" data-testid="battle-outcome">
                  <h3 data-testid="outcome-title">
                    {winnerName ? `${winnerName} wins` : 'Draw'}
                  </h3>
                  <p data-testid="outcome-reason">{outcomeReason()}</p>
                </section>
                <p className="readonly-note">
                  This battle is finished and read-only. It stays on the Battles list.
                </p>
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
                {automated ? (
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
                                <span className="draft-kind">Move</span>
                                <span className="draft-meta">
                                  Move · {(draft.legs || []).filter((leg) => leg.to).length}{' '}
                                  {(draft.legs || []).filter((leg) => leg.to).length === 1
                                    ? 'leg'
                                    : 'legs'}{' '}
                                  · order {index + 1}
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
                    <dt>Losses</dt>
                    <dd>
                      <ul className="result-list">
                        {summary.losses.length > 0 ? (
                          summary.losses.map((loss: any, index: number) => (
                            <li key={index}>
                              {loss.unitId} lost {loss.losses}
                              {loss.before !== null && loss.before !== undefined
                                ? ` (${loss.before} → ${loss.after})`
                                : ''}
                            </li>
                          ))
                        ) : (
                          <li className="empty-result">No losses.</li>
                        )}
                      </ul>
                    </dd>
                  </dl>
                </section>
              </>
            ) : null}
            <hr className="panel-divider" />
            <span className="eyebrow">BATTLE LOG</span>
            <div className="battle-log-scroll">
              <ol className="log-list log-grouped" data-testid="battle-log">
                {logGroups.map((group: any, index: number) => (
                  <li className="log-turn" key={index}>
                    <span className="log-turn-head">
                      {group.turnNumber === 0
                        ? 'Battle start'
                        : `Round ${group.round} · Turn ${group.turnNumber} — ${sideName(battle, group.side)}`}
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
                      {group.turnNumber === 0
                        ? (group.events || []).map((event: any, line: number) => (
                            <li className="log-phase" key={`start-${line}`}>
                              <ul className="log-lines">
                                <li>{describeBattleEvent(event, battle)}</li>
                              </ul>
                            </li>
                          ))
                        : null}
                    </ul>
                  </li>
                ))}
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
