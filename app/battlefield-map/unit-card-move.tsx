'use client';

import { MAX_MOVE_LEGS } from '../../domain/movement.js';
import { MOVE_WHEEL_STEPS, latestMoveFaceFor } from '../turn-draft-helpers';

export interface UnitCardMoveProps {
  unit: any;
  draft: any | null;
  onUndoMoveLeg: () => void;
  onClearMoveLegs: () => void;
  onSetMoveFacing: (raw: string) => void;
  onStepMoveFacing: (delta: number) => void;
}

function wheelTestIdSuffix(delta: number): string {
  return delta < 0 ? `minus-${Math.abs(delta)}` : `plus-${delta}`;
}

function wheelLabel(delta: number): string {
  if (delta === 180) return '180°';
  return delta < 0 ? `${delta}°` : `+${delta}°`;
}

// Move drafting from the unit context card (issue #126): the same Move draft
// the inspector edits, with a live leg count (up to three legs added by
// clicking open ground on the map), quick wheeling buttons and a numeric
// facing field for the latest leg (alongside the map rotation handle), and
// Undo leg / Clear leg editing. Ghost footprints, leg paths and the engine
// verdict update after every change through the shared turn-draft
// controller.
export function UnitCardMove(props: UnitCardMoveProps) {
  const { unit, draft } = props;
  const { onUndoMoveLeg, onClearMoveLegs, onSetMoveFacing, onStepMoveFacing } = props;
  if (!unit) return null;
  const unitId = String(unit?.id ?? '');
  if (!draft || draft?.kind !== 'Move') return null;
  const legs = Array.isArray(draft?.legs) ? draft.legs : [];
  const face = latestMoveFaceFor(draft);

  return (
    <div
      className="unit-card-orders"
      aria-label="Move orders"
      data-testid={`unit-card-move-section-${unitId}`}
    >
      <span className="field-label">Move</span>
      <p className="unit-card-readout" data-testid={`unit-card-move-legs-${unitId}`}>
        {legs.length} / {MAX_MOVE_LEGS} legs
      </p>
      <ol className="leg-list">
        {legs.length === 0 ? (
          <li className="leg-empty">No legs yet — click open ground for leg 1.</li>
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
        Click open ground for leg {legs.length + 1} (up to {MAX_MOVE_LEGS}) · wheel a turn,
        type a facing, or drag the round handle to rotate about the front midpoint.
      </p>
      <div className="unit-card-step-row" role="group" aria-label="Wheel facing">
        {MOVE_WHEEL_STEPS.map((delta) => (
          <button
            key={delta}
            type="button"
            className="btn-quiet unit-card-step"
            data-testid={`unit-card-wheel-${unitId}-${wheelTestIdSuffix(delta)}`}
            title={`Wheel facing by ${wheelLabel(delta)}`}
            aria-label={`Wheel facing by ${wheelLabel(delta)}`}
            onClick={(event) => {
              event.stopPropagation();
              onStepMoveFacing(delta);
            }}
          >
            {wheelLabel(delta)}
          </button>
        ))}
      </div>
      <label className="field">
        Facing (°)
        <input
          type="number"
          data-testid={`unit-card-move-facing-${unitId}`}
          min={0}
          max={360}
          step={1}
          value={face ?? ''}
          placeholder="—"
          onChange={(event) => {
            event.stopPropagation();
            onSetMoveFacing(event.target.value);
          }}
        />
      </label>
      <div className="draft-actions">
        <button
          type="button"
          className="btn-secondary"
          data-testid={`unit-card-undo-leg-${unitId}`}
          disabled={legs.length === 0}
          onClick={(event) => {
            event.stopPropagation();
            onUndoMoveLeg();
          }}
        >
          Undo leg
        </button>
        <button
          type="button"
          className="btn-secondary"
          data-testid={`unit-card-clear-legs-${unitId}`}
          disabled={legs.length === 0}
          onClick={(event) => {
            event.stopPropagation();
            onClearMoveLegs();
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}
