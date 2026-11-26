'use client';

// The shared turn-progression control (issue #167): the one control that
// moves the turn on — device handoff, automated Continue, empty-turn
// confirmation, commit-empty, or commit-draft with its blocked message. The
// inspector's TurnPanel renders it full (explanatory paragraphs and the
// draft list stay in the panel); the turn bar renders it compact (one row:
// buttons and the short blocked message only) while the right panel is
// collapsed, so a player can finish a turn without expanding the panel. Both
// render the same component with the same handlers and the same confirmation
// state, so confirming an empty turn from either place is one flow. Test ids
// mirror the inspector's with a `turnbar-` prefix on the compact variant.
import { isBattleFinished } from '../../domain/battles.js';
import { isAutomatedController, sideName } from './battle-helpers';
import type { DraftLeg, OrderDraft } from '../turn-draft-controller';

export interface TurnControlsProps {
  battle: any;
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
  variant?: 'full' | 'compact';
  testIdPrefix?: string;
}

export function TurnControls(props: TurnControlsProps) {
  const {
    battle,
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
    variant = 'full',
    testIdPrefix = '',
  } = props;
  const finished = isBattleFinished(battle);
  if (finished) return null;
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
  const activeSide = battle?.activeSide;
  const controller = battle?.controllers?.[activeSide] || 'human';
  const automated = isAutomatedController(controller);
  const tid = (id: string): string => `${testIdPrefix}${id}`;

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

  function blockedCount(): number {
    return (validation?.verdicts || []).filter((verdict: any) => verdict?.accepted === false).length;
  }

  function blockedMessage(): string {
    return `${blockedCount()} of ${(validation?.verdicts || []).length} orders rejected — fix or remove them to commit.`;
  }

  // The turn-bar variant is compact: one row, buttons and the short blocked
  // message only, no explanatory paragraphs and no draft list.
  if (variant === 'compact') {
    if (awaitingHandoff && handoffSide) {
      return (
        <span className="turn-controls-row">
          <button
            type="button"
            className="btn-primary"
            data-testid={tid('handoff')}
            data-handoff-side={handoffSide ?? ''}
            disabled={resolving}
            onClick={onHandoff}
          >
            {sideName(battle, handoffSide)} — begin your turn
          </button>
        </span>
      );
    }
    if (automated) {
      return (
        <span className="turn-controls-row">
          <button
            type="button"
            className="btn-primary"
            data-testid={tid('continue-turn')}
            disabled={resolving}
            onClick={onContinueAutomated}
          >
            {resolving ? 'Resolving…' : 'Continue'}
          </button>
          {resolveError ? (
            <span className="field-error" role="alert" data-testid={tid('resolve-error')}>
              {resolveError}
            </span>
          ) : null}
        </span>
      );
    }
    if (confirming) {
      return (
        <span className="turn-controls-row">
          <button
            type="button"
            className="btn-primary"
            data-testid={tid('confirm-commit')}
            onClick={onCommitEmpty}
          >
            Confirm commit
          </button>
          <button
            type="button"
            className="btn-secondary"
            data-testid={tid('cancel-commit')}
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </span>
      );
    }
    if (drafts.length === 0) {
      return (
        <span className="turn-controls-row">
          <button
            type="button"
            className="btn-primary"
            data-testid={tid('commit-empty')}
            onClick={() => setConfirming(true)}
          >
            Commit empty turn
          </button>
        </span>
      );
    }
    return (
      <span className="turn-controls-row">
        <button
          type="button"
          className="btn-primary"
          data-testid={tid('commit-draft')}
          disabled={!validation?.ok}
          onClick={() => draftSubmission && onCommitDraft(draftSubmission.orders)}
        >
          Commit turn ({drafts.length} {drafts.length === 1 ? 'order' : 'orders'})
        </button>
        {blockedCount() > 0 ? (
          <span className="field-error" role="alert" data-testid={tid('commit-blocked')}>
            {blockedMessage()}
          </span>
        ) : null}
      </span>
    );
  }

  return (
    <>
      {awaitingHandoff && handoffSide ? (
        <div className="handoff" data-testid={tid('handoff-panel')}>
          <p>
            Turn {battle?.turnNumber} resolved. Pass the device, then begin the next turn.
          </p>
          <div className="handoff-actions">
            <button
              type="button"
              className="btn-primary"
              data-testid={tid('handoff')}
              data-handoff-side={handoffSide ?? ''}
              disabled={resolving}
              onClick={onHandoff}
            >
              {sideName(battle, handoffSide)} — begin your turn
            </button>
          </div>
        </div>
      ) : automated ? (
        <div className="handoff" data-testid={tid('automated-turn')}>
          <p>
            {sideName(battle, activeSide)} is automated ({controller} test player). Its
            turn resolves at once through the runner.
          </p>
          <div className="handoff-actions">
            <button
              type="button"
              className="btn-primary"
              data-testid={tid('continue-turn')}
              disabled={resolving}
              onClick={onContinueAutomated}
            >
              {resolving ? 'Resolving…' : 'Continue'}
            </button>
          </div>
          {resolveError ? (
            <p className="field-error" role="alert" data-testid={tid('resolve-error')}>
              {resolveError}
            </p>
          ) : null}
        </div>
      ) : confirming ? (
        <div className="confirm-box" data-testid={tid('commit-confirm')}>
          <p>Commit an empty turn for {sideName(battle, activeSide)}? All units hold.</p>
          <div className="confirm-actions">
            <button
              type="button"
              className="btn-primary"
              data-testid={tid('confirm-commit')}
              onClick={onCommitEmpty}
            >
              Confirm commit
            </button>
            <button
              type="button"
              className="btn-secondary"
              data-testid={tid('cancel-commit')}
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
              data-testid={tid('commit-empty')}
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
          <section aria-label="Turn draft" data-testid={tid('draft-list')}>
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
              data-testid={tid('commit-draft')}
              disabled={!validation?.ok}
              onClick={() => draftSubmission && onCommitDraft(draftSubmission.orders)}
            >
              Commit turn ({drafts.length} {drafts.length === 1 ? 'order' : 'orders'})
            </button>
          </div>
          {(validation?.verdicts || []).filter((verdict: any) => verdict?.accepted === false)
            .length > 0 ? (
            <p className="field-error" role="alert" data-testid={tid('commit-blocked')}>
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
  );
}
