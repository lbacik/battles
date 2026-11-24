'use client';

// Shared turn-progression control for the battle screen (issue #124).
//
// The commit/handoff/continue flow that lived in the inspector's Turn section
// now lives here once, so the right-hand inspector panel and the bottom turn
// bar behave identically: the same handoff button while awaiting handoff, the
// same Continue for an automated side, the same empty-turn confirmation step,
// and the same draft commit (blocked with the same message when the engine
// rejects the turn). The inspector renders it full-size (with its hints); the
// turn bar renders it compact (buttons plus blocking/error messages only)
// when the right panel is collapsed. Test ids are prefixed per instance
// (`""` in the inspector, `"turnbar-"` in the turn bar) so the two surfaces
// never share an id.

interface TurnProgressionControlsProps {
  awaitingHandoff: boolean;
  handoffSide: string | null;
  handoffSideName: string;
  automated: boolean;
  automatedController: string;
  automatedSideName: string;
  turnNumber: unknown;
  resolving: boolean;
  resolveError: string | null;
  confirming: boolean;
  concedeConfirming: boolean;
  draftsCount: number;
  validationOk: boolean;
  rejectedCount: number;
  verdictCount: number;
  activeSideName: string;
  onHandoff: () => void;
  onCommitEmpty: () => void;
  onCommitDraft: () => void;
  onContinueAutomated: () => void;
  onConfirmingChange: (next: boolean) => void;
  testIdPrefix?: string;
  compact?: boolean;
}

export function TurnProgressionControls({
  awaitingHandoff,
  handoffSide,
  handoffSideName,
  automated,
  automatedController,
  automatedSideName,
  turnNumber,
  resolving,
  resolveError,
  confirming,
  concedeConfirming,
  draftsCount,
  validationOk,
  rejectedCount,
  verdictCount,
  activeSideName,
  onHandoff,
  onCommitEmpty,
  onCommitDraft,
  onContinueAutomated,
  onConfirmingChange,
  testIdPrefix,
  compact,
}: TurnProgressionControlsProps) {
  const prefix = testIdPrefix ?? '';
  const tid = (base: string): string => `${prefix}${base}`;
  const commitLocked = resolving || concedeConfirming;

  if (awaitingHandoff && handoffSide) {
    return (
      <div className="handoff" data-testid={tid('handoff-panel')}>
        {compact ? null : (
          <p>
            Turn {String(turnNumber)} resolved. Pass the device, then begin the next turn.
          </p>
        )}
        <div className="handoff-actions">
          <button
            type="button"
            className="btn-primary"
            data-testid={tid('handoff')}
            data-handoff-side={handoffSide ?? ''}
            disabled={resolving}
            onClick={onHandoff}
          >
            {handoffSideName} — begin your turn
          </button>
        </div>
      </div>
    );
  }

  if (automated) {
    return (
      <div className="handoff" data-testid={tid('automated-turn')}>
        {compact ? null : (
          <p>
            {automatedSideName} is automated ({automatedController} test player). Its turn
            resolves at once through the runner.
          </p>
        )}
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
    );
  }

  if (confirming) {
    return (
      <div className="confirm-box" data-testid={tid('commit-confirm')}>
        <p>
          Commit an empty turn for {activeSideName}? All units hold.
        </p>
        <div className="confirm-actions">
          <button
            type="button"
            className="btn-primary"
            data-testid={tid('confirm-commit')}
            disabled={commitLocked}
            onClick={onCommitEmpty}
          >
            Confirm commit
          </button>
          <button
            type="button"
            className="btn-secondary"
            data-testid={tid('cancel-commit')}
            onClick={() => onConfirmingChange(false)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  if (draftsCount === 0) {
    return (
      <>
        <div className="handoff-actions">
          <button
            type="button"
            className="btn-primary"
            data-testid={tid('commit-empty')}
            disabled={commitLocked}
            onClick={() => onConfirmingChange(true)}
          >
            Commit empty turn
          </button>
        </div>
        {compact ? null : (
          <p className="commit-hint">
            No orders drafted: committing an empty turn holds every unit and needs
            confirmation, and a committed turn cannot be taken back.
          </p>
        )}
      </>
    );
  }

  return (
    <>
      <div className="handoff-actions">
        <button
          type="button"
          className="btn-primary"
          data-testid={tid('commit-draft')}
          disabled={!validationOk || commitLocked}
          onClick={onCommitDraft}
        >
          Commit turn ({draftsCount} {draftsCount === 1 ? 'order' : 'orders'})
        </button>
      </div>
      {rejectedCount > 0 ? (
        <p className="field-error" role="alert" data-testid={tid('commit-blocked')}>
          {rejectedCount} of {verdictCount} orders rejected — fix or remove them to commit.
        </p>
      ) : compact ? null : (
        <p className="commit-hint">
          Every order is accepted. A committed turn cannot be taken back.
        </p>
      )}
    </>
  );
}
