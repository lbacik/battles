// PÓLIS engine — available actions (framework-free).
//
// Moved verbatim from `../turn.js` (#140): the permitted order kinds per
// unit with reasons, charge/shoot candidates, and the movement allowance.
// `movementParamsOf`, `isEngaged`, `hasMissiles`, and `permissionFor` are
// also shared with validation inside `domain/turn/`.

import { RULESET_PARAMETERS, getTroopType } from '../polis-classical.js';
import { chargeCandidatesFor } from '../charge.js';
import { FORWARD_ARC_DEG, movementAllowanceM } from '../movement.js';
import { shootCandidatesFor } from '../shoot.js';
import {
  cohesionParamsOf,
  isActiveUnit,
  unitCohesionState,
} from '../cohesion.js';
import {
  AVAILABLE_ACTIONS_FORMAT_VERSION,
  KNOWN_ORDER_KINDS,
  ORDER_KINDS,
  ORDER_KIND_CHARGE,
  ORDER_KIND_HOLD,
  ORDER_KIND_MOVE,
  ORDER_KIND_RALLY,
  ORDER_KIND_REFORM,
  ORDER_KIND_SHOOT,
  ORDER_KIND_WITHDRAW,
  REJECTION_ORDER_NOT_PERMITTED,
  REJECTION_UNSUPPORTED_ORDER_KIND,
} from './constants.js';
import { assertBattle } from './shared.js';

// --- Available actions ------------------------------------------------------
// Computed per unit at the start of the turn: the permitted order kinds,
// with reasons for the unavailable ones, the Charge and Shoot candidates,
// and the movement allowance in metres at the unit's current terrain (the
// open-ground allowance divided by the worst-cover factor there; the flat
// river fee is per leg and never part of the allowance). Hold, Move, Charge,
// Reform, Withdraw, Shoot, and Rally are permitted in this slice; only
// missile troops shoot. Permission follows the battle state: a
// routed unit may only Rally, an engaged unit may only Hold or Withdraw, and
// a disordered unit cannot charge.

const UNAVAILABLE_REASONS = Object.freeze({
  // Every known order kind is permitted in this slice, so no kind carries an
  // unavailable reason. Kept for the shape `actionsForUnit` reads.
});

export function movementParamsOf(battle) {
  return battle?.parameters?.movement ?? RULESET_PARAMETERS.movement;
}

export function isEngaged(unit) {
  return !!unit?.engaged && typeof unit.engaged === 'object'
    && typeof unit.engaged.unitId === 'string';
}

// True when the unit's troop type carries a missile range and may shoot.
export function hasMissiles(unit) {
  const range = getTroopType(unit?.troopType)?.missileRange;
  return Number.isFinite(range) && range > 0;
}

// The reason Shoot is unavailable to a unit whose troop type has no missile
// range.
function noMissilesReason(unit) {
  return `Troop type "${unit?.troopType}" has no missile range: Shoot is not permitted.`;
}

// Compute the permitted order kinds for a unit at the start of the turn: a
// removed unit (destroyed or fled) may give no order, a routed unit may only
// Rally, an engaged unit may only Hold or Withdraw, a disordered unit cannot
// charge but may Rally, a steady unit may not Rally, and only missile troops
// may Shoot (a Disordered missile unit shoots with a penalty at resolution).
// Returns `{ permitted, gated }` where `gated` lists `{ kind, reason }` for
// the kinds refused by permission (as opposed to kinds unavailable until
// their slice lands).
export function permissionFor(unit, battle = null) {
  if (!isActiveUnit(unit)) {
    return {
      permitted: [],
      gated: KNOWN_ORDER_KINDS.map((kind) => ({
        kind,
        reason: unit?.status === 'fled'
          ? 'The unit has left the battlefield and may give no order.'
          : 'The unit is destroyed and may give no order.',
      })),
    };
  }
  const cohesion = battle ? cohesionParamsOf(battle.parameters) : cohesionParamsOf({});
  const state = unitCohesionState(unit, cohesion);
  const missiles = hasMissiles(unit);
  if (state === 'Routed') {
    return {
      permitted: [{ kind: ORDER_KIND_RALLY }],
      gated: KNOWN_ORDER_KINDS.filter((kind) => kind !== ORDER_KIND_RALLY).map((kind) => ({
        kind,
        reason: 'Routed: only Rally is permitted.',
      })),
    };
  }
  if (isEngaged(unit)) {
    return {
      permitted: [{ kind: ORDER_KIND_HOLD }, { kind: ORDER_KIND_WITHDRAW }],
      gated: KNOWN_ORDER_KINDS.filter(
        (kind) => kind !== ORDER_KIND_HOLD && kind !== ORDER_KIND_WITHDRAW,
      ).map((kind) => ({
        kind,
        reason: 'Engaged: only Hold or Withdraw is permitted.',
      })),
    };
  }
  if (state === 'Disordered') {
    return {
      permitted: [
        { kind: ORDER_KIND_HOLD },
        { kind: ORDER_KIND_MOVE },
        { kind: ORDER_KIND_REFORM },
        { kind: ORDER_KIND_RALLY },
        ...(missiles ? [{ kind: ORDER_KIND_SHOOT }] : []),
      ],
      gated: [
        { kind: ORDER_KIND_CHARGE, reason: 'Disordered units cannot charge.' },
        ...(missiles ? [] : [{ kind: ORDER_KIND_SHOOT, reason: noMissilesReason(unit) }]),
      ],
    };
  }
  return {
    permitted: [
      { kind: ORDER_KIND_HOLD },
      { kind: ORDER_KIND_MOVE },
      { kind: ORDER_KIND_CHARGE },
      { kind: ORDER_KIND_REFORM },
      ...(missiles ? [{ kind: ORDER_KIND_SHOOT }] : []),
    ],
    gated: [
      { kind: ORDER_KIND_RALLY, reason: 'Steady units have no need to rally.' },
      ...(missiles ? [] : [{ kind: ORDER_KIND_SHOOT, reason: noMissilesReason(unit) }]),
    ],
  };
}

function actionsForUnit(unit, battle, params, terrainFeatures = []) {
  const { permitted, gated } = permissionFor(unit, battle);
  const gatedKinds = new Set(gated.map((entry) => entry.kind));
  const unavailable = [
    ...gated.map((entry) => ({
      kind: entry.kind,
      code: REJECTION_ORDER_NOT_PERMITTED,
      reason: entry.reason,
    })),
    ...KNOWN_ORDER_KINDS.filter(
      (kind) => !ORDER_KINDS.includes(kind) && !gatedKinds.has(kind)
        && !permitted.some((item) => item.kind === kind),
    ).map((kind) => ({
      kind,
      code: REJECTION_UNSUPPORTED_ORDER_KIND,
      reason: UNAVAILABLE_REASONS[kind],
    })),
  ];
  const canCharge = permitted.some((item) => item.kind === ORDER_KIND_CHARGE);
  const canShoot = permitted.some((item) => item.kind === ORDER_KIND_SHOOT);
  const arc = Number.isFinite(params?.forwardArcDeg) ? params.forwardArcDeg : FORWARD_ARC_DEG;
  const enemies = canCharge
    ? battle.units
      .filter((other) => other.side !== unit.side && isActiveUnit(other))
      .map((other) => ({ id: other.id, position: { ...other.position }, facing: other.facing }))
    : [];
  return {
    unitId: unit.id,
    permitted,
    unavailable,
    chargeCandidates: canCharge
      ? chargeCandidatesFor(
        unit,
        { position: { ...unit.position }, facing: unit.facing },
        enemies,
        arc,
      )
      : [],
    shootCandidates: canShoot
      ? shootCandidatesFor(
        unit,
        { position: { ...unit.position }, facing: unit.facing },
        battle.units.filter((other) => other.side !== unit.side),
        battle.units.filter((other) => other.id !== unit.id),
        terrainFeatures,
        battle.parameters,
      )
      : [],
    movementAllowanceM: movementAllowanceM(unit, params, terrainFeatures),
  };
}

// Compute the available actions for `side` on the battle's current turn.
// Pure: the battle is never changed.
export function availableActions(battle, side) {
  assertBattle(battle);
  const ids = battle.scenario.sides.map((entry) => entry.id);
  if (!ids.includes(side)) {
    throw new Error(`Unknown side "${side}" (one of: ${ids.join(', ')}).`);
  }
  const params = movementParamsOf(battle);
  const terrainFeatures = battle.scenario?.terrainFeatures || [];
  return {
    formatVersion: AVAILABLE_ACTIONS_FORMAT_VERSION,
    battleId: battle.id,
    turnNumber: battle.turnNumber,
    side,
    units: battle.units
      .filter((unit) => unit.side === side)
      .map((unit) => actionsForUnit(unit, battle, params, terrainFeatures)),
  };
}
