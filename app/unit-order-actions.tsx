'use client';

// Shared order-action controls for the battle screen (issue #125).
//
// The unit context card on the map and the right-hand inspector panel are two
// surfaces over the same turn draft (the shared turn-draft controller): both
// render this module's six order-kind buttons, the same disabled reasons, the
// same live engine verdict, and the same Hold (Clear) control. Nothing here
// holds ruleset logic (ADR 0005): permitted kinds, unavailability reasons and
// candidates come from the engine's `availableActions` through props.

import React from 'react';

// The six order kinds the card and the inspector can draft. Hold is not an
// order draft: it is the implicit state of a unit without a draft, so the
// Hold control only clears an existing draft.
export const ORDER_ACTION_KINDS: readonly string[] = Object.freeze([
  'Move',
  'Charge',
  'Shoot',
  'Reform',
  'Withdraw',
  'Rally',
]);

export interface UnavailableEntry {
  kind: string;
  reason?: string | null;
  code?: string | null;
}

// The card's order state for one unit: permitted kinds, the engine's
// unavailability reasons, candidate counts, the current draft kind and the
// live engine verdict for it. The battle screen builds it from
// `availableActions` and `validateTurn` through the shared turn-draft
// controller; the map only renders it (ADR 0005).
export interface UnitCardOrderState {
  permitted?: string[];
  unavailable?: UnavailableEntry[];
  chargeCandidateCount?: number;
  shootCandidateCount?: number;
  draftKind?: string | null;
  hasDraft?: boolean;
  verdict?: any;
}

// Availability of one order kind for a unit, derived only from the engine's
// `availableActions` entry (permitted kinds with unavailability reasons) and
// the candidate lists. A kind the ruleset gates for the unit is disabled with
// the engine's reason; Charge/Shoot permitted in principle but with zero
// candidates are disabled with a no-target hint.
export function orderAvailability(args: {
  kind: string;
  permitted: string[];
  unavailable?: UnavailableEntry[] | null;
  chargeCandidateCount?: number;
  shootCandidateCount?: number;
}): { disabled: boolean; reason: string | null } {
  const permitted = Array.isArray(args.permitted) ? args.permitted : [];
  if (!permitted.includes(args.kind)) {
    const entry = (Array.isArray(args.unavailable) ? args.unavailable : []).find(
      (item) => item?.kind === args.kind,
    );
    return {
      disabled: true,
      reason: entry?.reason || entry?.code || 'Not permitted for this unit.',
    };
  }
  if (args.kind === 'Charge' && (args.chargeCandidateCount ?? 0) <= 0) {
    return { disabled: true, reason: 'No target reachable in range or forward arc.' };
  }
  if (args.kind === 'Shoot' && (args.shootCandidateCount ?? 0) <= 0) {
    return { disabled: true, reason: 'No target reachable in range or forward arc.' };
  }
  return { disabled: false, reason: null };
}

export function unavailableReasonFor(
  unavailable: UnavailableEntry[] | null | undefined,
  kind: string,
): string | null {
  const entry = (Array.isArray(unavailable) ? unavailable : []).find(
    (item) => item?.kind === kind,
  );
  if (!entry) return null;
  return entry.reason || entry.code || 'Not permitted for this unit.';
}

// One-line accepted detail for a draft from its verdict preview, per kind.
// Shared by the inspector draft list, the inspector per-unit verdict, and the
// unit card, so every surface shows the same acceptance summary. Kind
// summaries come first: an accepted Withdraw carries its movement cost as
// well as its step back, and the step back is the summary the card and the
// inspector name for it.
export function draftAcceptedDetail(
  verdict: any,
  unitDisplayName: (unitId: string) => string = (id) => id,
): string {
  if (verdict?.withdraw && Number.isFinite(verdict.withdraw.distanceM)) {
    return `Accepted · steps back ${verdict.withdraw.distanceM} m.`;
  }
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
  if (verdict?.rally) {
    return `Accepted · rallies from ${verdict.rally.state}.`;
  }
  return 'Accepted.';
}

export function draftVerdictText(
  verdict: any,
  unitDisplayName: (unitId: string) => string = (id) => id,
): { accepted: boolean; text: string } | null {
  if (!verdict) return null;
  if (verdict.accepted === false) {
    return { accepted: false, text: verdict?.rejection?.message || 'Rejected.' };
  }
  if (verdict.accepted === true) {
    return { accepted: true, text: draftAcceptedDetail(verdict, unitDisplayName) };
  }
  return null;
}

interface UnitOrderButtonsProps {
  permitted: string[];
  unavailable?: UnavailableEntry[] | null;
  chargeCandidateCount?: number;
  shootCandidateCount?: number;
  activeKind?: string | null;
  testIdFor: (kind: string) => string;
  onOrder: (kind: string) => void;
}

// Six order-kind buttons, enabled or disabled only from the engine's
// `availableActions`. Disabled buttons carry the engine's reason as their
// title and expose it via `data-reason` for tests and assistive text.
export function UnitOrderButtons(props: UnitOrderButtonsProps): React.JSX.Element {
  return (
    <>
      {(ORDER_ACTION_KINDS as unknown as string[]).map((kind) => {
        const { disabled, reason } = orderAvailability({
          kind,
          permitted: props.permitted,
          unavailable: props.unavailable,
          chargeCandidateCount: props.chargeCandidateCount,
          shootCandidateCount: props.shootCandidateCount,
        });
        const active = props.activeKind === kind;
        const className = ['btn-secondary', 'order-kind-btn'];
        if (active) className.push('active');
        return (
          <button
            key={kind}
            type="button"
            className={className.join(' ')}
            data-testid={props.testIdFor(kind)}
            data-kind={kind}
            data-active={active ? 'true' : 'false'}
            disabled={disabled}
            title={disabled && reason ? reason : `Draft ${kind}`}
            data-reason={disabled && reason ? reason : undefined}
            aria-disabled={disabled}
            onClick={() => props.onOrder(kind)}
          >
            {kind}
          </button>
        );
      })}
    </>
  );
}

interface UnitDraftVerdictProps {
  verdictTestId: string;
  verdict: any;
  unitDisplayName?: (unitId: string) => string;
  pendingLabel?: string;
}

// The live engine verdict for a unit's draft: the green acceptance summary or
// the red inline rejection message. Null verdicts render a pending note so
// the card and the inspector never disagree about "no verdict yet".
interface OrderReasonListProps {
  permitted: string[];
  unavailable?: UnavailableEntry[] | null;
  chargeCandidateCount?: number;
  shootCandidateCount?: number;
  listTestId: string;
  itemTestId: (kind: string) => string;
}

// Visible disabled reasons for the six order kinds, from the same
// availability rule as the buttons: the engine's unavailability reason for
// gated kinds, the no-target hint for permitted-but-candidate-less
// Charge/Shoot.
export function OrderReasonList(props: OrderReasonListProps): React.JSX.Element {
  return (
    <ul className="order-reasons" data-testid={props.listTestId}>
      {ORDER_ACTION_KINDS.map((kind) => {
        const availability = orderAvailability({
          kind,
          permitted: props.permitted,
          unavailable: props.unavailable,
          chargeCandidateCount: props.chargeCandidateCount,
          shootCandidateCount: props.shootCandidateCount,
        });
        if (!availability.disabled || !availability.reason) return null;
        return (
          <li key={kind} data-testid={props.itemTestId(kind)}>
            <strong>{kind}</strong> — {availability.reason}
          </li>
        );
      })}
    </ul>
  );
}

export function UnitDraftVerdict(props: UnitDraftVerdictProps): React.JSX.Element | null {
  const resolved = draftVerdictText(props.verdict, props.unitDisplayName);
  if (!resolved) {
    return (
      <p className="draft-pending" data-testid={props.verdictTestId}>
        {props.pendingLabel || 'Validating…'}
      </p>
    );
  }
  if (!resolved.accepted) {
    return (
      <p className="field-error" role="alert" data-testid={props.verdictTestId}>
        {resolved.text}
      </p>
    );
  }
  return (
    <p className="draft-ok" data-testid={props.verdictTestId}>
      {resolved.text}
    </p>
  );
}
