'use client';

import { REFORM_FILE_STEPS, reformRanksFor } from '../turn-draft-helpers';

export interface UnitCardReformProps {
  unit: any;
  draft: any | null;
  verdict: any | null;
  presets: Record<string, any> | null;
  permitted: string[];
  onStartReformDraft: (unitId: string) => void;
  onApplyReformPreset: (unitId: string, preset: string) => void;
  onStepReformFiles: (unitId: string, delta: number) => void;
}

function stepTestIdSuffix(delta: number): string {
  return delta < 0 ? `minus-${Math.abs(delta)}` : `plus-${delta}`;
}

function stepLabel(delta: number): string {
  return delta < 0 ? `${delta}` : `+${delta}`;
}

function acceptedDetail(verdict: any): string {
  if (verdict?.reform && Number.isFinite(verdict.reform.files)) {
    const lateral = verdict.reform.lateralInterval;
    const depth = verdict.reform.rankDepth;
    if (Number.isFinite(lateral) && Number.isFinite(depth)) {
      return `Accepted · ${verdict.reform.files} files · ${lateral}×${depth} m.`;
    }
    return `Accepted · ${verdict.reform.files} files.`;
  }
  return 'Accepted.';
}

// Reform drafting from the unit context card (issue #128): the same Reform
// draft the inspector edits, driven with one-click spacing presets from the
// troop type's catalogue, quick file-count steppers, and a live files ×
// ranks readout. The ghost footprint on the map and the engine verdict update
// after every click through the shared turn-draft controller.
export function UnitCardReform(props: UnitCardReformProps) {
  const { unit, draft, verdict, presets, permitted } = props;
  const { onStartReformDraft, onApplyReformPreset, onStepReformFiles } = props;
  if (!unit) return null;
  const unitId = String(unit?.id ?? '');
  const isReform = draft?.kind === 'Reform';
  const canStart = !draft && (permitted || []).includes('Reform');

  if (!isReform) {
    if (!canStart) return null;
    return (
      <div className="unit-card-reform" data-testid={`card-reform-${unitId}`}>
        <button
          type="button"
          className="btn-secondary"
          data-testid={`card-start-reform-${unitId}`}
          onClick={(event) => {
            event.stopPropagation();
            onStartReformDraft(unitId);
          }}
        >
          Draft Reform
        </button>
      </div>
    );
  }

  const ranks = reformRanksFor(unit?.soldiers, draft.files);
  const readout = ranks != null ? `${draft.files} × ${ranks}` : '—';
  const rejected = verdict?.accepted === false;
  const accepted = verdict?.accepted === true;
  const rejectionMessage = rejected ? String(verdict?.rejection?.message || 'Rejected.') : '';

  return (
    <div className="unit-card-reform" data-testid={`card-reform-${unitId}`}>
      <span className="field-label">Reform draft</span>
      <p className="unit-card-readout" data-testid={`card-reform-readout-${unitId}`}>
        {readout} files × ranks
      </p>
      <div className="unit-card-step-row" role="group" aria-label="Adjust files">
        {REFORM_FILE_STEPS.map((delta) => (
          <button
            key={delta}
            type="button"
            className="btn-quiet unit-card-step"
            data-testid={`card-step-files-${unitId}-${stepTestIdSuffix(delta)}`}
            title={`Adjust files by ${stepLabel(delta)}`}
            aria-label={`Adjust files by ${stepLabel(delta)}`}
            onClick={(event) => {
              event.stopPropagation();
              onStepReformFiles(unitId, delta);
            }}
          >
            {stepLabel(delta)}
          </button>
        ))}
      </div>
      <div className="unit-card-preset-row">
        <span className="field-label">Spacing presets</span>
        <div className="handoff-actions">
          {presets ? (
            Object.entries(presets).map(([name, preset]: [string, any]) => (
              <button
                key={name}
                type="button"
                className="btn-quiet"
                data-testid={`card-apply-preset-${unitId}-${name}`}
                title={`Set ${name} spacing (${preset.lateralInterval} × ${preset.rankDepth} m)`}
                onClick={(event) => {
                  event.stopPropagation();
                  onApplyReformPreset(unitId, name);
                }}
              >
                {name} ({preset.lateralInterval}×{preset.rankDepth})
              </button>
            ))
          ) : (
            <span className="draft-hint">No presets for this troop type.</span>
          )}
        </div>
      </div>
      {rejected ? (
        <p className="field-error" role="alert" data-testid={`card-draft-rejection-${unitId}`}>
          {rejectionMessage}
        </p>
      ) : accepted ? (
        <p className="draft-ok" data-testid={`card-draft-accepted-${unitId}`}>
          {acceptedDetail(verdict)}
        </p>
      ) : (
        <p className="draft-pending" data-testid={`card-draft-pending-${unitId}`}>
          Validating…
        </p>
      )}
    </div>
  );
}
