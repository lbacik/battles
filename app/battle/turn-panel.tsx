import { useMemo } from 'react';
import { isBattleFinished } from '../../domain/battles.js';
import { describeBattleEvent, groupLogEvents, lastResolvedTurnNumber, summarizeTurn } from '../../domain/battle-log.js';
import { isAutomatedController, sideName } from './battle-helpers';
import { TurnControls } from './turn-controls';

// Turn panel (outcome, draft list, turn result, battle log). Derived state
// (summaries, outcome, log groups) is computed here from `battle`, so the
// DOM the e2e suite asserts on does not change.
export interface TurnPanelProps {
  battle: any;
  sides: any;
  turnDraft: any;
  confirming: any;
  setConfirming: (next: any) => void;
  resolving: any;
  resolveError: any;
  awaitingHandoff: any;
  handoffSide: any;
  onHandoff: (...args: any[]) => any;
  onCommitEmpty: (...args: any[]) => any;
  onCommitDraft: (...args: any[]) => any;
  onContinueAutomated: (...args: any[]) => any;
  onRematch: (...args: any[]) => any;
  onOpenScenarioInEditor: (...args: any[]) => any;
  onBackToLibrary: (...args: any[]) => any;
}

export function TurnPanel(props: TurnPanelProps) {
  const {
    battle,
    sides,
    turnDraft,
    confirming,
    setConfirming,
    resolving,
    resolveError,
    awaitingHandoff,
    handoffSide,
    onHandoff,
    onCommitEmpty,
    onCommitDraft,
    onContinueAutomated,
    onRematch,
    onOpenScenarioInEditor,
    onBackToLibrary,
  } = props;
  const { unitDisplayName } = turnDraft;
  const lastResolved = lastResolvedTurnNumber(battle);
  const finished = isBattleFinished(battle);
  const activeSide = battle?.activeSide;
  const controller = battle?.controllers?.[activeSide] || 'human';
  const automated = isAutomatedController(controller);

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
                <TurnControls
                  battle={battle}
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
                  variant="full"
                />
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
  );

}
