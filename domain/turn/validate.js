// PÓLIS engine — order validation (framework-free).
//
// Moved verbatim from `../turn.js` (#140): `validateTurn` checks a
// submission against the authoritative battle state and returns a verdict
// per order in sequence. Pure: neither the battle nor the submission is
// changed.

import { BATTLE_STATUS_ONGOING } from '../battle.js';
import { RULESET_PARAMETERS } from '../polis-classical.js';
import { fightingFiles, validateChargeOnField } from '../charge.js';
import {
  footprintAt,
  footprintPreview,
  validateMoveOnField,
} from '../movement.js';
import { validateShootOnField } from '../shoot.js';
import { validateReformOnField } from '../reform.js';
import { validateWithdrawOnField } from '../withdraw.js';
import {
  cohesionParamsOf,
  isActiveUnit,
  nearestEnemyOf,
  unitCohesionState,
} from '../cohesion.js';
import {
  ORDER_KINDS,
  ORDER_KIND_CHARGE,
  ORDER_KIND_HOLD,
  ORDER_KIND_MOVE,
  ORDER_KIND_RALLY,
  ORDER_KIND_REFORM,
  ORDER_KIND_SHOOT,
  ORDER_KIND_WITHDRAW,
  REFUSAL_BATTLE_FINISHED,
  REFUSAL_NOT_ACTIVE_SIDE,
  REFUSAL_ORDERS_REJECTED,
  REFUSAL_STALE_TURN,
  REFUSAL_UNKNOWN_BATTLE,
  REJECTION_DUPLICATE_UNIT_ORDER,
  REJECTION_INVALID_CHARGE,
  REJECTION_NOT_OWN_UNIT,
  REJECTION_ORDER_NOT_PERMITTED,
  REJECTION_UNKNOWN_UNIT,
  REJECTION_UNSUPPORTED_ORDER_KIND,
  TURN_CONTRACT_VERSION,
} from './constants.js';
import { assertBattle, cloneValue, isRecord } from './shared.js';
import {
  hasMissiles,
  isEngaged,
  movementParamsOf,
  permissionFor,
} from './available-actions.js';

// --- Validation -------------------------------------------------------------
// `validateTurn` checks a submission against the authoritative battle state
// and returns a verdict per order in sequence. A stale turn number or a side
// that is not active refuses the whole submission before any order is
// examined. Rejections have the shape
// `{ orderIndex, unitId, code, details, message }`.

function wholeRefusal(code, message) {
  return { ok: false, code, message, verdicts: [], acceptedOrders: [] };
}

function reject(orderIndex, unitId, code, details, message) {
  return { orderIndex, unitId, accepted: false, rejection: { orderIndex, unitId, code, details, message } };
}

// Validate a submission against the battle state. Never throws for a
// malformed submission — it refuses it — but throws for a missing battle.
// Pure: neither the battle nor the submission is changed.
export function validateTurn(battle, submission) {
  assertBattle(battle);
  if (battle.status !== BATTLE_STATUS_ONGOING) {
    return wholeRefusal(
      REFUSAL_BATTLE_FINISHED,
      `The battle is over (status "${battle.status}"): no further orders are accepted.`,
    );
  }
  if (!isRecord(submission)) {
    return wholeRefusal('invalid-submission', 'A submission must be an object.');
  }
  if (submission.formatVersion !== TURN_CONTRACT_VERSION) {
    return wholeRefusal(
      'unsupported-format-version',
      `Unsupported submission format version ${JSON.stringify(submission.formatVersion)} ` +
        `(this engine reads version ${TURN_CONTRACT_VERSION}).`,
    );
  }
  if (submission.battleId !== battle.id) {
    return wholeRefusal(
      REFUSAL_UNKNOWN_BATTLE,
      `Submission is for battle "${String(submission.battleId)}" but this battle is "${String(battle.id)}".`,
    );
  }
  if (submission.turnNumber !== battle.turnNumber) {
    return wholeRefusal(
      REFUSAL_STALE_TURN,
      `Submission turn ${String(submission.turnNumber)} does not match the current turn ${battle.turnNumber}.`,
    );
  }
  if (submission.side !== battle.activeSide) {
    return wholeRefusal(
      REFUSAL_NOT_ACTIVE_SIDE,
      `Side "${String(submission.side)}" is not the active side ("${battle.activeSide}").`,
    );
  }
  if (!Array.isArray(submission.orders)) {
    return wholeRefusal('invalid-submission', 'A submission requires an orders array.');
  }
  const byId = new Map(battle.units.map((unit) => [unit.id, unit]));
  const seen = new Map();
  // Simulated footprints: each order validates against the state left by the
  // orders before it (ADR 0004), starting from the battle state.
  const simulated = new Map(
    battle.units.map((unit) => [unit.id, { position: { ...unit.position }, facing: unit.facing }]),
  );
  // Simulated engagements: contacts from the battle state plus every charge
  // accepted earlier in this turn, minus every withdraw accepted earlier in
  // this turn. A unit engaged here may only Hold or Withdraw; a target
  // already engaged can still be charged again.
  const engaged = new Map(
    battle.units
      .filter((unit) => isEngaged(unit))
      .map((unit) => [unit.id, { ...unit.engaged }]),
  );
  // Simulated formations: each order validates against the state left by the
  // orders before it (ADR 0004), so a Reform accepted earlier in this turn
  // reshapes the footprint every later order sees.
  const templates = new Map(
    battle.units.map((unit) => [unit.id, {
      soldiers: unit.soldiers,
      files: unit.files,
      lateralInterval: unit.lateralInterval,
      rankDepth: unit.rankDepth,
    }]),
  );
  function effectiveUnit(unitId) {
    const base = byId.get(unitId);
    const template = templates.get(unitId);
    return { ...base, ...template };
  }
  const params = movementParamsOf(battle);
  const withdrawParams = battle?.parameters?.withdraw ?? RULESET_PARAMETERS.withdraw;
  // Preview of a unit's footprint at its simulated pose: the deterministic
  // Movement-phase footprint every accepted verdict carries. Shared with the
  // movement module so Hold and Move previews describe the same shape.
  function previewAt(unit, pose) {
    return footprintPreview(unit, pose.position, pose.facing);
  }
  function othersAt(moverId) {
    return battle.units
      .filter((unit) => unit.id !== moverId && isActiveUnit(unit))
      .map((unit) => {
        const pose = simulated.get(unit.id);
        return {
          id: unit.id,
          side: unit.side,
          corners: footprintAt(effectiveUnit(unit.id), pose.position, pose.facing).corners,
        };
      });
  }
  // Every enemy the withdrawing unit is engaged with: its own contact plus
  // every unit whose contact points at it. All of them break on a withdraw.
  function engagedEnemiesOf(unitId) {
    const unit = byId.get(unitId);
    const found = [];
    const contact = engaged.get(unitId);
    if (contact && typeof contact.unitId === 'string') {
      const target = byId.get(contact.unitId);
      if (target && target.side !== unit?.side && !found.includes(target.id)) {
        found.push(target.id);
      }
    }
    for (const [otherId, otherContact] of engaged) {
      if (otherContact?.unitId === unitId && otherId !== unitId) {
        const other = byId.get(otherId);
        if (other && other.side !== unit?.side && !found.includes(otherId)) {
          found.push(otherId);
        }
      }
    }
    return found;
  }
  const verdicts = submission.orders.map((order, orderIndex) => {
    const unitId = isRecord(order) ? order.unitId : undefined;
    const unit = typeof unitId === 'string' ? byId.get(unitId) : undefined;
    if (!unit) {
      return reject(orderIndex, unitId ?? null, REJECTION_UNKNOWN_UNIT, { unitId: unitId ?? null },
        `Order ${orderIndex}: unknown unit "${String(unitId)}".`);
    }
    if (unit.side !== submission.side) {
      return reject(orderIndex, unit.id, REJECTION_NOT_OWN_UNIT,
        { unitId: unit.id, ownerSide: unit.side, submittingSide: submission.side },
        `Order ${orderIndex}: unit "${unit.id}" fights for "${unit.side}", not "${submission.side}".`);
    }
    if (seen.has(unit.id)) {
      return reject(orderIndex, unit.id, REJECTION_DUPLICATE_UNIT_ORDER,
        { unitId: unit.id, firstOrderIndex: seen.get(unit.id) },
        `Order ${orderIndex}: unit "${unit.id}" already holds an order (order ${seen.get(unit.id)}).`);
    }
    seen.set(unit.id, orderIndex);
    const kind = isRecord(order) ? order.kind : undefined;
    const cohesion = cohesionParamsOf(battle.parameters);
    // Permission gates: a removed unit may give no order, a routed unit may
    // only Rally, an engaged unit may only Hold or Withdraw, a disordered unit
    // cannot charge, and a steady unit may not rally. Each refusal names the
    // reason so the player can fix the order.
    if (!isActiveUnit(unit)) {
      return reject(orderIndex, unit.id, REJECTION_ORDER_NOT_PERMITTED,
        { unitId: unit.id, reason: unit.status === 'fled' ? 'fled' : 'destroyed', permitted: [] },
        `Order ${orderIndex}: unit "${unit.id}" is ${unit.status === 'fled' ? 'fled' : 'destroyed'} and may give no order.`);
    }
    const state = unitCohesionState(unit, cohesion);
    if (state === 'Routed' && kind !== ORDER_KIND_RALLY) {
      return reject(orderIndex, unit.id, REJECTION_ORDER_NOT_PERMITTED,
        { unitId: unit.id, reason: 'routed', permitted: [ORDER_KIND_RALLY] },
        `Order ${orderIndex}: unit "${unit.id}" is Routed and may only Rally.`);
    }
    if (engaged.has(unit.id) && kind !== ORDER_KIND_HOLD && kind !== ORDER_KIND_WITHDRAW) {
      return reject(orderIndex, unit.id, REJECTION_ORDER_NOT_PERMITTED,
        { unitId: unit.id, reason: 'engaged', permitted: [ORDER_KIND_HOLD, ORDER_KIND_WITHDRAW] },
        `Order ${orderIndex}: unit "${unit.id}" is Engaged and may only Hold or Withdraw.`);
    }
    if (state === 'Disordered' && kind === ORDER_KIND_CHARGE) {
      return reject(orderIndex, unit.id, REJECTION_ORDER_NOT_PERMITTED,
        { unitId: unit.id, reason: 'disordered' },
        `Order ${orderIndex}: unit "${unit.id}" is Disordered and cannot charge.`);
    }
    if (state === 'Steady' && kind === ORDER_KIND_RALLY) {
      return reject(orderIndex, unit.id, REJECTION_ORDER_NOT_PERMITTED,
        { unitId: unit.id, reason: 'not-disordered', permitted: [ORDER_KIND_HOLD, ORDER_KIND_MOVE, ORDER_KIND_CHARGE, ORDER_KIND_REFORM] },
        `Order ${orderIndex}: unit "${unit.id}" is Steady and may not Rally.`);
    }
    if (kind === ORDER_KIND_RALLY) {
      // Rally carries no parameters and the unit does not move. A Disordered
      // unit always qualifies; a Routed unit qualifies only with no active
      // enemy within the clear distance.
      if (state === 'Disordered') {
        return {
          orderIndex,
          unitId: unit.id,
          accepted: true,
          preview: previewAt(unit, simulated.get(unit.id)),
          rally: { state },
        };
      }
      if (state === 'Routed') {
        const { enemy, distanceM } = nearestEnemyOf(
          { units: battle.units.map((entry) => (entry.id === unit.id
            ? { ...entry, position: { ...simulated.get(entry.id).position } }
            : entry)) },
          { ...unit, position: { ...simulated.get(unit.id).position } },
        );
        if (Number.isFinite(distanceM) && distanceM < cohesion.rallyClearM) {
          return reject(orderIndex, unit.id, REJECTION_ORDER_NOT_PERMITTED,
            {
              unitId: unit.id,
              reason: 'enemy-too-close',
              nearestEnemyId: enemy?.id ?? null,
              distanceM: Math.round(distanceM * 10) / 10,
              requiredM: cohesion.rallyClearM,
            },
            `Order ${orderIndex}: unit "${unit.id}" may not Rally with enemy "${enemy?.id}" ` +
              `${Math.round(distanceM * 10) / 10} m away (needs ${cohesion.rallyClearM} m clear).`);
        }
        return {
          orderIndex,
          unitId: unit.id,
          accepted: true,
          preview: previewAt(unit, simulated.get(unit.id)),
          rally: { state },
        };
      }
    }
    // Only missile troops may shoot. Engaged and routed units never reach
    // this gate (their only permitted kinds exclude Shoot above); any other
    // unit whose troop type has no missile range is refused with the orders
    // it may give instead.
    if (kind === ORDER_KIND_SHOOT && !hasMissiles(unit)) {
      const shootPermitted = permissionFor(unit, battle).permitted.map((item) => item.kind);
      return reject(orderIndex, unit.id, REJECTION_ORDER_NOT_PERMITTED,
        { unitId: unit.id, reason: 'no-missiles', permitted: shootPermitted },
        `Order ${orderIndex}: unit "${unit.id}" (troop type "${unit.troopType}") has no missiles and may not Shoot.`);
    }
    if (kind === ORDER_KIND_HOLD) {
      return {
        orderIndex,
        unitId: unit.id,
        accepted: true,
        preview: previewAt(unit, simulated.get(unit.id)),
      };
    }
    if (kind === ORDER_KIND_MOVE) {
      const planned = validateMoveOnField({
        unit: effectiveUnit(unit.id),
        from: simulated.get(unit.id),
        legs: isRecord(order) ? order.legs : undefined,
        params,
        battlefield: battle.scenario.battlefield,
        others: othersAt(unit.id),
        terrainFeatures: battle.scenario?.terrainFeatures || [],
        orderIndex,
      });
      if (!planned.ok) {
        return reject(orderIndex, unit.id, planned.code, planned.details, planned.message);
      }
      simulated.set(unit.id, {
        position: { ...planned.preview.position },
        facing: planned.preview.facing,
      });
      return {
        orderIndex,
        unitId: unit.id,
        accepted: true,
        preview: planned.preview,
        movement: { availableM: planned.availableM, requiredM: planned.requiredM },
      };
    }
    if (kind === ORDER_KIND_CHARGE) {
      const targetId = isRecord(order) ? order.targetId : undefined;
      const target = typeof targetId === 'string' ? byId.get(targetId) : undefined;
      if (target && !isActiveUnit(target)) {
        return reject(orderIndex, unit.id, REJECTION_INVALID_CHARGE,
          { unitId: unit.id, targetId: target.id, reason: 'target-inactive', status: target.status ?? null },
          `Order ${orderIndex}: unit "${unit.id}" cannot charge "${target.id}" (the target has left the field).`);
      }
      const planned = validateChargeOnField({
        unit: effectiveUnit(unit.id),
        from: simulated.get(unit.id),
        target: target ? effectiveUnit(target.id) : undefined,
        targetPose: target ? simulated.get(target.id) : undefined,
        edge: isRecord(order) ? order.edge : undefined,
        approachLegs: isRecord(order) ? order.approach : undefined,
        params,
        battlefield: battle.scenario.battlefield,
        others: othersAt(unit.id),
        terrainFeatures: battle.scenario?.terrainFeatures || [],
        orderIndex,
      });
      if (!planned.ok) {
        return reject(orderIndex, unit.id, planned.code, planned.details, planned.message);
      }
      simulated.set(unit.id, {
        position: { ...planned.preview.position },
        facing: planned.preview.facing,
      });
      engaged.set(unit.id, {
        unitId: target.id,
        edge: 'front',
        aspect: planned.contact.aspect,
        frontageM: planned.contact.frontageM,
        files: planned.contact.fightingFiles,
      });
      if (!engaged.has(target.id)) {
        engaged.set(target.id, {
          unitId: unit.id,
          edge: planned.contact.edge,
          aspect: planned.contact.aspect,
          frontageM: planned.contact.frontageM,
          files: fightingFiles(effectiveUnit(target.id), planned.contact.frontageM),
        });
      }
      return {
        orderIndex,
        unitId: unit.id,
        accepted: true,
        preview: planned.preview,
        movement: { availableM: planned.availableM, requiredM: planned.requiredM },
        charge: { ...planned.contact },
      };
    }
    if (kind === ORDER_KIND_REFORM) {
      const planned = validateReformOnField({
        unit: effectiveUnit(unit.id),
        reform: isRecord(order) ? order : undefined,
        battlefield: battle.scenario.battlefield,
        others: othersAt(unit.id),
        terrainFeatures: battle.scenario?.terrainFeatures || [],
        orderIndex,
      });
      if (!planned.ok) {
        return reject(orderIndex, unit.id, planned.code, planned.details, planned.message);
      }
      templates.set(unit.id, {
        soldiers: unit.soldiers,
        files: planned.formation.files,
        lateralInterval: planned.formation.lateralInterval,
        rankDepth: planned.formation.rankDepth,
      });
      return {
        orderIndex,
        unitId: unit.id,
        accepted: true,
        preview: planned.preview,
        reform: { ...planned.formation },
      };
    }
    if (kind === ORDER_KIND_WITHDRAW) {
      // Only an engaged unit may withdraw. Routed units never reach this
      // branch (Rally is their only permitted order); any other unit ordered
      // to withdraw is refused with the orders it may give instead.
      if (!engaged.has(unit.id)) {
        const steadyPermitted = [ORDER_KIND_HOLD, ORDER_KIND_MOVE, ORDER_KIND_CHARGE, ORDER_KIND_REFORM];
        const disorderedPermitted = [ORDER_KIND_HOLD, ORDER_KIND_MOVE, ORDER_KIND_REFORM, ORDER_KIND_RALLY];
        const permitted = state === 'Disordered' ? disorderedPermitted : steadyPermitted;
        return reject(orderIndex, unit.id, REJECTION_ORDER_NOT_PERMITTED,
          { unitId: unit.id, reason: 'not-engaged', permitted },
          `Order ${orderIndex}: unit "${unit.id}" is not Engaged and may not Withdraw.`);
      }
      const brokenIds = engagedEnemiesOf(unit.id);
      const planned = validateWithdrawOnField({
        unit: effectiveUnit(unit.id),
        from: simulated.get(unit.id),
        brokenIds,
        params,
        withdrawParams,
        battlefield: battle.scenario.battlefield,
        others: othersAt(unit.id),
        terrainFeatures: battle.scenario?.terrainFeatures || [],
        orderIndex,
      });
      if (!planned.ok) {
        return reject(orderIndex, unit.id, planned.code, planned.details, planned.message);
      }
      simulated.set(unit.id, {
        position: { ...planned.preview.position },
        facing: planned.preview.facing,
      });
      engaged.delete(unit.id);
      for (const enemyId of planned.brokeContactWith) {
        engaged.delete(enemyId);
      }
      return {
        orderIndex,
        unitId: unit.id,
        accepted: true,
        preview: planned.preview,
        movement: { availableM: planned.availableM, requiredM: planned.requiredM },
        withdraw: { distanceM: planned.distanceM, brokeContactWith: [...planned.brokeContactWith] },
      };
    }
    if (kind === ORDER_KIND_SHOOT) {
      const targetId = isRecord(order) ? order.targetId : undefined;
      const target = typeof targetId === 'string' ? byId.get(targetId) : undefined;
      const planned = validateShootOnField({
        unit: effectiveUnit(unit.id),
        from: simulated.get(unit.id),
        target: target ? effectiveUnit(target.id) : undefined,
        targetPose: target ? simulated.get(target.id) : undefined,
        targetEngaged: target ? engaged.has(target.id) : false,
        others: battle.units
          .filter((entry) => entry.id !== unit.id)
          .map((entry) => ({
            ...effectiveUnit(entry.id),
            position: { ...simulated.get(entry.id).position },
            facing: simulated.get(entry.id).facing,
          })),
        terrainFeatures: battle.scenario?.terrainFeatures || [],
        parameters: battle.parameters,
        orderIndex,
      });
      if (!planned.ok) {
        return reject(orderIndex, unit.id, planned.code, planned.details, planned.message);
      }
      // A Shoot never moves: the simulated pose is left unchanged, so the
      // shooter ends the turn where its earlier validation left it.
      return {
        orderIndex,
        unitId: unit.id,
        accepted: true,
        preview: planned.preview,
        shoot: { ...planned.shoot },
      };
    }
    return reject(orderIndex, unit.id, REJECTION_UNSUPPORTED_ORDER_KIND,
      { unitId: unit.id, kind },
      `Order ${orderIndex}: order kind "${String(kind)}" is not ` +
        `available in this slice (only ${ORDER_KINDS.join(', ')} are permitted).`);
  });
  const acceptedOrders = verdicts
    .filter((verdict) => verdict.accepted)
    .map((verdict) => cloneValue(submission.orders[verdict.orderIndex]));
  if (acceptedOrders.length < verdicts.length) {
    const rejected = verdicts.length - acceptedOrders.length;
    return {
      ok: false,
      code: REFUSAL_ORDERS_REJECTED,
      message: `${rejected} of ${verdicts.length} orders rejected.`,
      verdicts,
      acceptedOrders,
    };
  }
  return { ok: true, code: null, message: null, verdicts, acceptedOrders };
}
