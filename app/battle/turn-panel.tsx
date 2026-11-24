import { useMemo } from 'react';
import { isBattleFinished } from '../../domain/battles.js';
import { describeBattleEvent, groupLogEvents, lastResolvedTurnNumber, summarizeTurn } from '../../domain/battle-log.js';
import { isAutomatedController, sideName } from './battle-helpers';
import type { DraftLeg, OrderDraft } from '../turn-draft-controller';

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
  const {
    selectedUnitId,
    drafts,
    draftSubmission,
    validation,
    draftKindOf,
    unitDisplayName,
    verdictForDraftIndex,
    moveDraft,
    removeDraft,
    selectUnit: setSelectedUnitId,
  } = turnDraft;
  const lastResolved = lastResolvedTurnNumber(battle);
  const finished = isBattleFinished(battle);
  const activeSide = battle?.activeSide;
  const controller = battle?.controllers?.[activeSide] || 'human';
  const automated = isAutomatedController(controller);

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
                        data-handoff-side={handoffSide ?? ''}
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
                        {drafts.map((draft: any, index: number) => {
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
  );

}
