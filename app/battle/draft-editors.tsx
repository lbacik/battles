import { CHARGE_EDGES, MAX_APPROACH_LEGS } from '../../domain/charge.js';
import { MAX_MOVE_LEGS } from '../../domain/movement.js';
import { reformRanksFor } from '../turn-draft-helpers';

// Per-kind draft editors for the selected unit. State stays in `BattleScreen`
// (via the shared turn-draft controller); this factory only closes over the
// controller `BattleScreen` passes in each render, so behaviour is unchanged.
export interface DraftEditorDeps {
  turnDraft: any;
}

export function createDraftEditor(deps: DraftEditorDeps) {
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
    selectUnit,
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
  } = deps.turnDraft;
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
                  {unitDisplayName(candidate.targetId)} · {candidate.distanceM} m · {candidate.aspect} ({candidate.edge})
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
      const reformRanks = reformRanksFor(unit?.soldiers, draft.files);
      const reformReadout =
        reformRanks != null ? `${draft.files} × ${reformRanks}` : '—';
      return (
        <section aria-label="Reform draft" data-testid={`draft-editor-${unit.id}`}>
          <span className="eyebrow">REFORM DRAFT</span>
          <p className="draft-readout" data-testid={`reform-readout-${unit.id}`}>
            {reformReadout} files × ranks
          </p>
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

  return { draftEditor };
}
