'use client';

// The battle screen (prototype layout A): order of battle left, the map
// shared with the editor (read-only) centre, the selected unit's inspector
// right, and the bottom turn bar showing round and round limit, the active
// side in its colour, and the phase.
//
// In this slice the human side can only commit an empty turn (all units hold,
// with confirmation); automated turns resolve through the runner and wait for
// "Continue". The screen holds no legality rules: the commit is validated by
// `validateTurn` and resolved by `resolveTurn` (human) or the runner's
// `runTurn` (automated) in the parent.

import { useEffect, useMemo, useState } from 'react';
import BattlefieldMap from './battlefield-map';
import { availableActions } from '../domain/turn.js';
import { isBattleFinished } from '../domain/battles.js';
import {
  describeBattleEvent,
  groupLogEvents,
  lastResolvedTurnNumber,
  summarizeTurn,
} from '../domain/battle-log.js';

type BattleDocument = any;

interface BattleScreenProps {
  battle: BattleDocument;
  announcement: string | null;
  resolving: boolean;
  resolveError: string | null;
  onCommitEmpty: () => void;
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
  onContinueAutomated,
  onBackToLibrary,
}: BattleScreenProps) {
  const [selectedUnitId, setSelectedUnitId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const scenario = battle?.scenario;
  const units: any[] = Array.isArray(battle?.units) ? battle.units : [];
  const sides: any[] = Array.isArray(scenario?.sides) ? scenario.sides : [];
  const finished = isBattleFinished(battle);
  const activeSide = battle?.activeSide;
  const controller = battle?.controllers?.[activeSide] || 'human';
  const automated = isAutomatedController(controller);
  const limit = roundLimitOf(battle);
  const lastResolved = lastResolvedTurnNumber(battle);

  // A committed turn moves play on: the confirmation and the selection belong
  // to the turn that was committed, never to the next one.
  useEffect(() => {
    setConfirming(false);
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

  // The inspector reads the engine's available actions, never its own rules:
  // permitted kinds and the movement allowance for the selected unit.
  const selectedEntry = useMemo(() => {
    if (!selectedUnit || finished) return null;
    try {
      const actions = availableActions(battle, selectedUnit.side);
      return (actions.units || []).find((entry: any) => entry.unitId === selectedUnit.id) || null;
    } catch {
      return null;
    }
  }, [battle, selectedUnit, finished]);

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
            Battlefield · {scenario?.battlefield?.width} × {scenario?.battlefield?.height} m ·
            read-only
          </div>
          <BattlefieldMap
            width={scenario?.battlefield?.width}
            height={scenario?.battlefield?.height}
            units={units}
            sides={sides}
            selectedUnitId={selectedUnitId}
            onSelectUnit={(id: string | null) => setSelectedUnitId(id)}
            terrainFeatures={scenario?.terrainFeatures}
          />
          <p className="map-hint">
            The map is shared with the editor and read-only here: scroll to zoom, drag to pan, 0
            fits the battlefield.
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
              </dl>
            </section>
          ) : (
            <p className="empty-inspector" data-testid="battle-inspector-empty">
              Select a unit in the order of battle or on the map to inspect it.
            </p>
          )}
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
                ) : (
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
                      The human side holds every unit in this slice: committing an empty turn
                      needs confirmation, and a committed turn cannot be taken back.
                    </p>
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
