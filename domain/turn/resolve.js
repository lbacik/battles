// PÓLIS engine — turn resolution (framework-free).
//
// Moved verbatim from `../turn.js` (#140): the pure function from the
// battle state and a committed decision to a new state and events.

import {
  BATTLE_STATUS_ONGOING,
  RANDOM_DRAW_EVENT,
  TURN_PHASE_ORDERS,
  createRng,
} from '../battle.js';
import {
  END_REASON_BREAK,
  END_REASON_CONCEDE,
  END_REASON_ROUND_LIMIT,
  applyBattleEnd,
  battleEndParamsOf,
  checkArmyBreak,
  decideRoundLimit,
  isRoundLimitReached,
} from '../battle-end.js';
import { resolveCombatPhase } from '../combat.js';
import { resolveShootingPhase } from '../shoot.js';
import {
  cohesionParamsOf,
  resolveCohesionPhase,
  syncCohesion,
  unitCohesionState,
  unitCohesionValue,
} from '../cohesion.js';
import { fightingFiles } from '../charge.js';
import { withdrawParamsOf } from '../withdraw.js';
import {
  ORDER_KIND_CHARGE,
  ORDER_KIND_MOVE,
  ORDER_KIND_RALLY,
  ORDER_KIND_REFORM,
  ORDER_KIND_SHOOT,
  ORDER_KIND_WITHDRAW,
  REFUSAL_BATTLE_FINISHED,
  REFUSAL_NOT_ACTIVE_SIDE,
  TURN_PHASES,
} from './constants.js';
import {
  assertBattle,
  cloneValue,
  isRecord,
  otherSide,
  stepDownCohesionValue,
} from './shared.js';
import { isEngaged } from './available-actions.js';
import { validateTurn } from './validate.js';

// --- Resolution -------------------------------------------------------------
// Resolution is a pure function from the battle state and a committed
// decision to a new state and events. The Movement phase executes the
// accepted moves, charges, reforms, withdraws, and rallies in the given order
// at their validated previews; a withdraw also breaks every contact it held
// and then tests cohesion by chance on the engine generator (failure steps the
// numeric value down to the next state, recorded with the draw), while a rally
// never moves the unit. The Shooting phase then resolves the accepted Shoot
// orders (see `./shoot.js`), the Combat phase fights every engaged pair (see
// `./combat.js`), and the Cohesion phase wears close-spacing units on bad
// ground, removes units worn below their share, and flees the side's Routed
// units again (see `./cohesion.js`). After the Cohesion phase the army break
// is checked, then the round limit (see `./battle-end.js`): either ends the
// battle at once with a recorded result instead of passing the turn.
// Resolution otherwise passes the turn and
// counts rounds as pairs of turns. A turn decision is either a commit or a
// concede.

export class TurnRejectedError extends Error {
  constructor(result) {
    super(`Decision refused: ${result.message} (${result.code}).`);
    this.name = 'TurnRejectedError';
    this.code = result.code;
    this.result = result;
  }
}

function nextEvent(battle, fields) {
  return { seq: battle.events.length, ...fields };
}

// Resolve a turn decision against the battle state. Commit re-validates every
// order against the authoritative state and is all or nothing: any rejection
// throws a `TurnRejectedError` and no battle is produced. Concede ends the
// battle with the other side the winner, but only during the conceding side's
// own turn. A commit that breaks an army or completes the limit round ends the
// battle at once with the recorded result instead of passing the turn. Any
// decision on a finished battle is refused. Pure: the input battle and the
// decision are never changed.
export function resolveTurn(battle, decision) {
  assertBattle(battle);
  if (!isRecord(decision)) {
    throw new Error('A turn decision must be an object ({ type: "commit" | "concede", ... }).');
  }
  const next = cloneValue(battle);
  if (decision.type === 'concede') {
    if (battle.status !== BATTLE_STATUS_ONGOING) {
      throw new TurnRejectedError({
        ok: false,
        code: REFUSAL_BATTLE_FINISHED,
        message: `The battle is over (status "${battle.status}"): no further decisions are accepted.`,
      });
    }
    const side = typeof decision.side === 'string' ? decision.side : battle.activeSide;
    if (side !== battle.activeSide) {
      throw new TurnRejectedError({
        ok: false,
        code: REFUSAL_NOT_ACTIVE_SIDE,
        message: `Side "${side}" is not the active side ("${battle.activeSide}").`,
      });
    }
    const winner = otherSide(battle, side);
    next.events.push(
      nextEvent(next, {
        type: 'turn-conceded',
        turnNumber: battle.turnNumber,
        side,
        winner,
      }),
    );
    // The concede is recorded with its own event first; `applyBattleEnd`
    // records the result and the uniform `battle-ended` event.
    applyBattleEnd(next, { reason: END_REASON_CONCEDE, winner });
    return next;
  }
  if (decision.type !== 'commit') {
    throw new Error(
      `Unknown turn decision type "${String(decision.type)}" (one of: commit, concede).`,
    );
  }
  const result = validateTurn(battle, decision.submission);
  if (!result.ok) {
    throw new TurnRejectedError(result);
  }
  // Execute the accepted orders in the given order at their validated
  // previews: the previews are deterministic, so resolution replays exactly
  // what validation promised. Each charge also records the engagement on both
  // units (a target charged twice keeps its first contact). Each reform
  // changes the formation in place; each withdraw steps back, breaks every
  // contact it held, and then tests cohesion by chance on the engine
  // generator (the enemy neither pursues nor gets a free attack); failure steps
  // the numeric value down to the next state. A rally never moves the unit: a
  // Disordered unit regains cohesion up to its maximum, while a Routed unit
  // draws against the rally chance and returns as Disordered at the rally
  // value. A charge marks the charger for the first-fight bonus, consumed by
  // the Combat phase of this same turn (see `./combat.js`). A Shoot changes
  // nothing yet: its losses resolve in the Shooting phase below (see
  // `./shoot.js`).
  const rng = createRng(next.rngState);
  const rallyParams = cohesionParamsOf(next.parameters);
  for (const verdict of result.verdicts) {
    if (!verdict.accepted || !verdict.preview) {
      continue;
    }
    const order = decision.submission.orders[verdict.orderIndex];
    if (!isRecord(order)) {
      continue;
    }
    if (order.kind === ORDER_KIND_RALLY && verdict.rally) {
      const target = next.units.find((unit) => unit.id === verdict.unitId);
      const valueBefore = unitCohesionValue(target, rallyParams);
      const stateBefore = unitCohesionState(target, rallyParams);
      if (stateBefore === 'Disordered') {
        target.cohesionValue = valueBefore + rallyParams.rallyRegain;
        syncCohesion(target, rallyParams);
        next.events.push(
          nextEvent(next, {
            type: 'unit-rallied',
            turnNumber: battle.turnNumber,
            side: battle.activeSide,
            unitId: verdict.unitId,
            orderIndex: verdict.orderIndex,
            cohesionBefore: stateBefore,
            cohesionAfter: unitCohesionState(target, rallyParams),
            valueBefore,
            valueAfter: target.cohesionValue,
            result: 'rallied',
          }),
        );
      } else if (stateBefore === 'Routed') {
        const value = rng.next();
        next.rngState = rng.state;
        const passed = value < rallyParams.rallyChance;
        next.events.push(
          nextEvent(next, {
            type: RANDOM_DRAW_EVENT,
            purpose: 'rally',
            turnNumber: battle.turnNumber,
            side: battle.activeSide,
            unitId: verdict.unitId,
            orderIndex: verdict.orderIndex,
            value,
            result: passed ? 'passed' : 'failed',
            cohesionBefore: stateBefore,
            cohesionAfter: passed ? 'Disordered' : stateBefore,
          }),
        );
        if (passed) {
          target.cohesionValue = rallyParams.rallyTo;
          syncCohesion(target, rallyParams);
          // A rallied unit returns as Disordered even when the tuned rally
          // value sits outside the Disordered band.
          if (unitCohesionState(target, rallyParams) !== 'Disordered') {
            const top = Math.floor(rallyParams.disorderedBelow - 1);
            target.cohesionValue = Number.isFinite(top) && top >= 1 ? top : 1;
            syncCohesion(target, rallyParams);
          }
          next.events.push(
            nextEvent(next, {
              type: 'unit-rallied',
              turnNumber: battle.turnNumber,
              side: battle.activeSide,
              unitId: verdict.unitId,
              orderIndex: verdict.orderIndex,
              cohesionBefore: stateBefore,
              cohesionAfter: unitCohesionState(target, rallyParams),
              valueBefore,
              valueAfter: target.cohesionValue,
              result: 'rallied',
            }),
          );
        }
      }
      continue;
    }
    if (order.kind === ORDER_KIND_REFORM && verdict.reform) {
      const target = next.units.find((unit) => unit.id === verdict.unitId);
      target.files = verdict.reform.files;
      target.lateralInterval = verdict.reform.lateralInterval;
      target.rankDepth = verdict.reform.rankDepth;
      next.events.push(
        nextEvent(next, {
          type: 'unit-reformed',
          turnNumber: battle.turnNumber,
          side: battle.activeSide,
          unitId: verdict.unitId,
          orderIndex: verdict.orderIndex,
          files: verdict.reform.files,
          lateralInterval: verdict.reform.lateralInterval,
          rankDepth: verdict.reform.rankDepth,
          position: { ...verdict.preview.position },
          facing: verdict.preview.facing,
        }),
      );
      continue;
    }
    if (order.kind === ORDER_KIND_WITHDRAW && verdict.withdraw) {
      const target = next.units.find((unit) => unit.id === verdict.unitId);
      target.position = { ...verdict.preview.position };
      target.facing = verdict.preview.facing;
      target.engaged = null;
      for (const enemyId of verdict.withdraw.brokeContactWith) {
        const enemy = next.units.find((unit) => unit.id === enemyId);
        if (enemy && enemy.engaged?.unitId === target.id) {
          enemy.engaged = null;
        }
      }
      next.events.push(
        nextEvent(next, {
          type: 'unit-withdrew',
          turnNumber: battle.turnNumber,
          side: battle.activeSide,
          unitId: verdict.unitId,
          orderIndex: verdict.orderIndex,
          position: { ...verdict.preview.position },
          facing: verdict.preview.facing,
          distanceM: verdict.withdraw.distanceM,
          brokeContactWith: [...verdict.withdraw.brokeContactWith],
          requiredM: verdict.movement.requiredM,
        }),
      );
      const { cohesionPassChance } = withdrawParamsOf(next.parameters?.withdraw);
      const value = rng.next();
      next.rngState = rng.state;
      const passed = value < cohesionPassChance;
      const cohesion = cohesionParamsOf(next.parameters);
      const stateBefore = unitCohesionState(target, cohesion);
      const numericBefore = unitCohesionValue(target, cohesion);
      if (!passed) {
        target.cohesionValue = stepDownCohesionValue(target, cohesion);
        syncCohesion(target, cohesion);
      }
      const stateAfter = unitCohesionState(target, cohesion);
      const numericAfter = unitCohesionValue(target, cohesion);
      next.events.push(
        nextEvent(next, {
          type: RANDOM_DRAW_EVENT,
          purpose: 'withdraw-cohesion',
          turnNumber: battle.turnNumber,
          side: battle.activeSide,
          unitId: verdict.unitId,
          orderIndex: verdict.orderIndex,
          value,
          result: passed ? 'passed' : 'failed',
          cohesionBefore: stateBefore,
          cohesionAfter: stateAfter,
          valueBefore: numericBefore,
          valueAfter: numericAfter,
        }),
      );
      if (!passed) {
        next.events.push(
          nextEvent(next, {
            type: 'unit-cohesion',
            turnNumber: battle.turnNumber,
            side: battle.activeSide,
            unitId: verdict.unitId,
            orderIndex: verdict.orderIndex,
            cohesionBefore: stateBefore,
            cohesionAfter: stateAfter,
            valueBefore: numericBefore,
            valueAfter: numericAfter,
            cause: 'withdraw',
          }),
        );
      }
      continue;
    }
    if (order.kind !== ORDER_KIND_MOVE) {
      if (order.kind !== ORDER_KIND_CHARGE || !verdict.charge) {
        continue;
      }
      const charger = next.units.find((unit) => unit.id === verdict.unitId);
      const charged = next.units.find((unit) => unit.id === verdict.charge.targetId);
      charger.position = { ...verdict.preview.position };
      charger.facing = verdict.preview.facing;
      charger.engaged = {
        unitId: charged.id,
        edge: 'front',
        aspect: verdict.charge.aspect,
        frontageM: verdict.charge.frontageM,
        files: verdict.charge.fightingFiles,
      };
      charger.freshCharge = true;
      if (!isEngaged(charged)) {
        charged.engaged = {
          unitId: charger.id,
          edge: verdict.charge.edge,
          aspect: verdict.charge.aspect,
          frontageM: verdict.charge.frontageM,
          files: fightingFiles(charged, verdict.charge.frontageM),
        };
      }
      next.events.push(
        nextEvent(next, {
          type: 'unit-charged',
          turnNumber: battle.turnNumber,
          side: battle.activeSide,
          unitId: verdict.unitId,
          targetId: verdict.charge.targetId,
          orderIndex: verdict.orderIndex,
          edge: verdict.charge.edge,
          aspect: verdict.charge.aspect,
          frontageM: verdict.charge.frontageM,
          fightingFiles: verdict.charge.fightingFiles,
          position: { ...verdict.preview.position },
          facing: verdict.preview.facing,
        }),
      );
      continue;
    }
    const target = next.units.find((unit) => unit.id === verdict.unitId);
    target.position = { ...verdict.preview.position };
    target.facing = verdict.preview.facing;
    next.events.push(
      nextEvent(next, {
        type: 'unit-moved',
        turnNumber: battle.turnNumber,
        side: battle.activeSide,
        unitId: verdict.unitId,
        orderIndex: verdict.orderIndex,
        position: { ...verdict.preview.position },
        facing: verdict.preview.facing,
      }),
    );
  }
  for (const phase of TURN_PHASES.slice(0, 2)) {
    next.events.push(
      nextEvent(next, {
        type: 'turn-phase',
        turnNumber: battle.turnNumber,
        side: battle.activeSide,
        phase,
        ordersApplied: result.acceptedOrders.length,
      }),
    );
  }
  // The Shooting phase resolves the active side's accepted Shoot orders in
  // the given order on the engine generator, recording one draw per shot
  // (see `./shoot.js`).
  const shootOrders = [];
  for (const verdict of result.verdicts) {
    if (!verdict.accepted) {
      continue;
    }
    const order = decision.submission.orders[verdict.orderIndex];
    if (isRecord(order) && order.kind === ORDER_KIND_SHOOT && typeof order.targetId === 'string') {
      shootOrders.push({ unitId: verdict.unitId, targetId: order.targetId });
    }
  }
  resolveShootingPhase(next, shootOrders);
  // The Combat phase fights every engaged pair on the engine generator,
  // recording one draw per side per fight (see `./combat.js`). The Cohesion
  // phase then wears close-spacing units on bad ground, removes units worn
  // below their share, and flees the side's Routed units again (see
  // `./cohesion.js`).
  resolveCombatPhase(next);
  resolveCohesionPhase(next, battle.activeSide);
  for (const phase of TURN_PHASES.slice(2)) {
    next.events.push(
      nextEvent(next, {
        type: 'turn-phase',
        turnNumber: battle.turnNumber,
        side: battle.activeSide,
        phase,
        ordersApplied: result.acceptedOrders.length,
      }),
    );
  }
  // The Cohesion phase carries the end-condition check (decision #6 item 4):
  // an army break ends the battle at once, and the round limit decides it
  // after the last turn of the limit round. A finished battle keeps its turn
  // counters and records no `turn-resolved`.
  const breakCheck = checkArmyBreak(next);
  if (breakCheck.broken) {
    const winner = breakCheck.brokenSides.length === 1
      ? otherSide(battle, breakCheck.brokenSides[0])
      : null;
    applyBattleEnd(next, { reason: END_REASON_BREAK, winner });
    return next;
  }
  if (isRoundLimitReached(battle.turnNumber, battleEndParamsOf(next.parameters))) {
    const decided = decideRoundLimit(next);
    applyBattleEnd(next, { reason: END_REASON_ROUND_LIMIT, winner: decided.winner });
    return next;
  }
  const nextTurnNumber = battle.turnNumber + 1;
  const nextSide = otherSide(battle, battle.activeSide);
  next.events.push(
    nextEvent(next, {
      type: 'turn-resolved',
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      ordersApplied: result.acceptedOrders.length,
      nextTurnNumber,
      nextSide,
      nextRound: Math.ceil(nextTurnNumber / 2),
    }),
  );
  next.turnNumber = nextTurnNumber;
  next.activeSide = nextSide;
  next.round = Math.ceil(nextTurnNumber / 2);
  next.phase = TURN_PHASE_ORDERS;
  next.status = BATTLE_STATUS_ONGOING;
  return next;
}
