// PÓLIS engine — battle log: readable English from the engine's events
// (framework-free).
//
// The battle log is the readable record of a battle (CONTEXT.md): the orders
// carried out, every chance outcome, losses, cohesion changes, contacts, and
// any substitutions made for a player that failed to give valid orders. Both
// players read the same log — it derives purely from `battle.events`, so a
// resumed battle shows the identical log. This module never touches the DOM,
// React, or Node APIs: it formats the engine's own events into English and
// groups them by round, turn, and phase, and it summarises the turn just
// resolved for the turn result panel and the map highlights.

export const LOG_PHASE_ORDERS = 'Orders';
export const LOG_PHASE_SHOOTING = 'Shooting';
export const LOG_PHASE_COMBAT = 'Combat';
export const LOG_PHASE_COHESION = 'Cohesion';
export const LOG_PHASE_END = 'Turn end';
export const LOG_PHASE_START = 'Battle start';

export const LOG_PHASES = Object.freeze([
  LOG_PHASE_ORDERS,
  LOG_PHASE_SHOOTING,
  LOG_PHASE_COMBAT,
  LOG_PHASE_COHESION,
  LOG_PHASE_END,
]);

// The round a turn belongs to: a pair of turns forms a round (ADR 0004), so
// turns 1-2 are round 1, turns 3-4 round 2, and so on.
export function roundOfTurn(turnNumber) {
  if (!Number.isInteger(turnNumber) || turnNumber < 1) {
    return 1;
  }
  return Math.ceil(turnNumber / 2);
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function unitNameOf(battle, unitId) {
  const unit = (battle?.units || []).find((entry) => entry?.id === unitId);
  const name = unit && typeof unit.name === 'string' && unit.name.trim().length > 0
    ? unit.name.trim()
    : null;
  return name || unitId || 'an unnamed unit';
}

function sideNameOf(battle, sideId) {
  const side = (battle?.scenario?.sides || []).find((entry) => entry?.id === sideId);
  const name = side && typeof side.name === 'string' && side.name.trim().length > 0
    ? side.name.trim()
    : null;
  return name || sideId || 'an unknown side';
}

function formatPoint(point) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return 'an unknown position';
  }
  return `(${point.x.toFixed(1)}, ${point.y.toFixed(1)})`;
}

function formatDraw(value) {
  return Number.isFinite(value) ? value.toFixed(3) : '—';
}

// Which log phase an event belongs to. Movement-order events and the runner's
// fallback events belong to Orders; the Shooting phase owns shooting draws and
// shots; the Combat phase owns combat draws, fights, and their cohesion fall;
// the Cohesion phase owns terrain strain, removals, and flights; resolution
// markers close the turn. Everything without a turn (the starting-side draw)
// opens the battle.
export function phaseOfEvent(event) {
  if (!isRecord(event)) {
    return LOG_PHASE_ORDERS;
  }
  if (event.type === 'turn-phase') {
    return event.phase;
  }
  if (!Number.isInteger(event.turnNumber) || event.turnNumber < 1) {
    return LOG_PHASE_START;
  }
  switch (event.type) {
    case 'player-attempt-refused':
    case 'order-substituted':
    case 'player-fallback':
    case 'unit-moved':
    case 'unit-charged':
    case 'unit-reformed':
    case 'unit-withdrew':
    case 'unit-rallied':
    case 'turn-conceded':
      return LOG_PHASE_ORDERS;
    case 'units-shot':
      return LOG_PHASE_SHOOTING;
    case 'units-fought':
      return LOG_PHASE_COMBAT;
    case 'unit-destroyed':
      if (event.reason === 'below-strength' || event.cause === 'cohesion-phase') {
        return LOG_PHASE_COHESION;
      }
      return LOG_PHASE_COMBAT;
    case 'unit-fled':
    case 'unit-routed':
      if (event.cause === 'cohesion-phase' || event.cause === 'cohesion-zero') {
        return event.cause === 'cohesion-phase' ? LOG_PHASE_COHESION : LOG_PHASE_COMBAT;
      }
      return LOG_PHASE_COMBAT;
    case 'unit-cohesion':
      if (event.cause === 'terrain') {
        return LOG_PHASE_COHESION;
      }
      if (event.cause === 'withdraw') {
        return LOG_PHASE_ORDERS;
      }
      if (event.cause === 'flank-test' || event.cause === 'cohesion-zero') {
        return LOG_PHASE_COMBAT;
      }
      // Shooting strain records a strain total with no numeric before/after;
      // combat strain records the numeric values it stepped through.
      if (event.strain !== undefined && event.valueBefore === undefined) {
        return LOG_PHASE_SHOOTING;
      }
      return LOG_PHASE_COMBAT;
    case 'random-draw':
    case 'random-drawn':
      switch (event.purpose) {
        case 'rally':
        case 'withdraw-cohesion':
          return LOG_PHASE_ORDERS;
        case 'shooting-loss':
          return LOG_PHASE_SHOOTING;
        case 'combat-loss':
        case 'rout-test':
          return LOG_PHASE_COMBAT;
        default:
          return LOG_PHASE_START;
      }
    case 'turn-resolved':
    case 'battle-ended':
      return LOG_PHASE_END;
    default:
      return LOG_PHASE_ORDERS;
  }
}

// One readable English line for an engine event. Unknown event types fall back
// to a plain summary so a newer engine never breaks an older log. Every chance
// outcome names its draw value and result.
export function describeBattleEvent(event, battle) {
  if (!isRecord(event)) {
    return 'An unreadable record in the battle log.';
  }
  const unit = (unitId) => unitNameOf(battle, unitId);
  const side = (sideId) => sideNameOf(battle, sideId);
  switch (event.type) {
    case 'random-draw':
    case 'random-drawn': {
      const value = formatDraw(event.value);
      switch (event.purpose) {
        case 'starting-side':
          return `The lots chose the starter: ${side(event.result)} begins (draw ${value}).`;
        case 'rally':
          return `Chance for ${unit(event.unitId)} to rally: draw ${value} — ${event.result === 'passed' ? 'the rally holds' : 'the rally fails'}.`;
        case 'withdraw-cohesion':
          return `Chance for ${unit(event.unitId)} to withdraw in good order: draw ${value} — ${event.result === 'passed' ? 'steadiness holds' : `steadiness falls (${event.cohesionBefore} → ${event.cohesionAfter})`}.`;
        case 'shooting-loss':
          return `Chance draw for ${unit(event.unitId)} shooting ${unit(event.targetId)}: ${value} — ${event.result} ${event.result === 1 ? 'soldier' : 'soldiers'} lost.`;
        case 'combat-loss':
          return `Chance draw for ${unit(event.unitId)} against ${unit(event.opponentId)}: ${value} — ${event.result} ${event.result === 1 ? 'soldier' : 'soldiers'} dealt.`;
        case 'rout-test':
          return `Chance for ${unit(event.unitId)} to stand after the ${event.aspect || 'flank'} fight: draw ${value} — ${event.result === 'passed' ? 'the line holds' : 'the line routs'}.`;
        default:
          return `A chance draw (${event.purpose || 'unknown'}) came out ${event.result} (draw ${value}).`;
      }
    }
    case 'player-attempt-refused':
      return `The ${side(event.side)} orders were refused (attempt ${event.attempt}, ${event.code}): every order waits for a new attempt.`;
    case 'order-substituted':
      return `Salvaged orders for ${side(event.side)}: the ${unit(event.unitId)} order was removed (${event.code}).`;
    case 'player-fallback':
      return `${side(event.side)} holds every unit: ${event.reason}.`;
    case 'unit-moved':
      return `${unit(event.unitId)} moved to ${formatPoint(event.position)}${Number.isFinite(event.facing) ? `, facing ${event.facing}°` : ''}.`;
    case 'unit-charged': {
      const edge = event.edge ? ` on its ${event.edge}` : '';
      const frontage = Number.isFinite(event.frontageM) ? ` along ${event.frontageM.toFixed(1)} m` : '';
      return `${unit(event.unitId)} charged ${unit(event.targetId)}${edge} (${event.aspect || 'front'} aspect${frontage}).`;
    }
    case 'unit-reformed':
      return `${unit(event.unitId)} reformed: ${event.files} files at ${formatPoint(event.position)}.`;
    case 'unit-withdrew':
      return `${unit(event.unitId)} withdrew ${Number.isFinite(event.distanceM) ? `${event.distanceM.toFixed(1)} m ` : ''}and broke contact with ${(event.brokeContactWith || []).map((id) => unit(id)).join(', ') || 'no one'}.`;
    case 'unit-rallied':
      return `${unit(event.unitId)} rallied (${event.cohesionBefore} → ${event.cohesionAfter}).`;
    case 'units-shot': {
      const soldiers = event.soldiers && Number.isFinite(event.soldiers.before)
        ? ` (${event.soldiers.before} → ${event.soldiers.after})`
        : '';
      return `${unit(event.unitId)} shot ${unit(event.targetId)}: ${event.losses} ${event.losses === 1 ? 'soldier' : 'soldiers'} lost${soldiers}.`;
    }
    case 'units-fought': {
      const fights = Array.isArray(event.fights) ? event.fights : [];
      if (fights.length === 0) {
        const pair = Array.isArray(event.pair) ? event.pair.map((id) => unit(id)).join(' and ') : 'the engaged units';
        return `${pair} fought (${event.aspect || 'front'} aspect).`;
      }
      return fights
        .map((fight) => `${unit(fight.unitId)} fought ${unit(fight.opponentId)}: dealt ${fight.lossesInflicted}, took ${fight.lossesTaken}.`)
        .join(' ');
    }
    case 'unit-cohesion': {
      const cause = event.cause === 'terrain'
        ? ` on ${event.cover || 'bad'} ground`
        : event.cause === 'withdraw'
          ? ' after withdrawing'
          : event.cause === 'flank-test'
            ? ' after losing a flank fight'
            : event.cause === 'cohesion-zero'
              ? ' as cohesion gave way'
              : '';
      return `${unit(event.unitId)} cohesion ${event.cohesionBefore} → ${event.cohesionAfter}${cause}.`;
    }
    case 'unit-routed':
      return `${unit(event.unitId)} routed and fled${Number.isFinite(event.flightM) ? ` ${event.flightM} m` : ''} to ${formatPoint(event.position)}.`;
    case 'unit-fled':
      return `${unit(event.unitId)} fled the battlefield.`;
    case 'unit-destroyed': {
      if (event.reason === 'below-strength') {
        return `${unit(event.unitId)} destroyed: too few soldiers left (${event.soldiers} of ${event.startingSoldiers}).`;
      }
      if (event.reason === 'attacked-while-routed') {
        return `${unit(event.unitId)} destroyed: attacked while routed by ${unit(event.byUnitId)}.`;
      }
      if (event.reason === 'flight-blocked') {
        return `${unit(event.unitId)} destroyed: its flight was blocked${event.blockedBy ? ` by ${unit(event.blockedBy)}` : ''}.`;
      }
      return `${unit(event.unitId)} destroyed (${event.reason || 'removed'}).`;
    }
    case 'turn-phase':
      return `— ${event.phase} phase —`;
    case 'turn-resolved':
      return `Turn ${event.turnNumber} resolved (${event.ordersApplied} ${event.ordersApplied === 1 ? 'order' : 'orders'}): ${side(event.nextSide)} to move (turn ${event.nextTurnNumber}, round ${roundOfTurn(event.nextTurnNumber)}).`;
    case 'turn-conceded':
      return `${side(event.side)} conceded the battle.`;
    case 'battle-ended': {
      const winner = event.winner ? `${side(event.winner)} wins` : 'a draw';
      const reason = event.reason === 'break'
        ? 'an army broke'
        : event.reason === 'round-limit'
          ? 'the round limit was reached'
          : event.reason === 'concede'
            ? 'a concession'
            : event.reason || 'the end';
      return `The battle ended (${reason}): ${winner}.`;
    }
    default:
      return `${event.type}: turn ${event.turnNumber ?? '—'}${event.side ? ` · ${side(event.side)}` : ''}.`;
  }
}

// Group the battle's events by round and turn, in causal order. The starting
// draw (no turn number) opens the log; every other event joins its turn group
// with the round derived from the turn number. Pure: the battle is unchanged.
export function groupLogEvents(battle) {
  const events = Array.isArray(battle?.events) ? [...battle.events].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0)) : [];
  const groups = [];
  const byTurn = new Map();
  for (const event of events) {
    const turnNumber = Number.isInteger(event?.turnNumber) && event.turnNumber >= 1
      ? event.turnNumber
      : 0;
    if (!byTurn.has(turnNumber)) {
      byTurn.set(turnNumber, []);
    }
    byTurn.get(turnNumber).push(event);
  }
  for (const [turnNumber, turnEvents] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    if (turnNumber === 0) {
      groups.push({
        turnNumber: 0,
        round: 0,
        side: null,
        phase: LOG_PHASE_START,
        events: turnEvents,
      });
      continue;
    }
    const resolved = turnEvents.find((entry) => entry?.type === 'turn-resolved');
    const conceded = turnEvents.find((entry) => entry?.type === 'turn-conceded');
    const ended = turnEvents.find((entry) => entry?.type === 'battle-ended');
    const side = resolved?.side ?? conceded?.side ?? ended?.side ?? turnEvents.find((entry) => entry?.side)?.side ?? null;
    const sections = [];
    const order = [LOG_PHASE_ORDERS, LOG_PHASE_SHOOTING, LOG_PHASE_COMBAT, LOG_PHASE_COHESION, LOG_PHASE_END];
    for (const phase of order) {
      const phaseEvents = turnEvents.filter((entry) => entry?.type !== 'turn-phase' && phaseOfEvent(entry) === phase);
      if (phaseEvents.length > 0) {
        sections.push({ phase, events: phaseEvents });
      }
    }
    groups.push({
      turnNumber,
      round: roundOfTurn(turnNumber),
      side,
      sections,
      events: turnEvents,
    });
  }
  return groups;
}

// The latest turn with any resolution event: the turn the result panel
// summarises. Resolution markers are `turn-resolved` (or any battle-ending
// event); a battle with no resolved turn yet returns null. Pure.
export function lastResolvedTurnNumber(battle) {
  const events = Array.isArray(battle?.events) ? battle.events : [];
  let last = null;
  for (const event of events) {
    if (!isRecord(event) || !Number.isInteger(event.turnNumber) || event.turnNumber < 1) {
      continue;
    }
    if (event.type === 'turn-resolved' || event.type === 'turn-conceded' || event.type === 'battle-ended') {
      last = last === null ? event.turnNumber : Math.max(last, event.turnNumber);
    }
  }
  if (last !== null) {
    return last;
  }
  // A conceded or finished battle without its own marker still resolved its
  // turn: fall back to the highest turn number present in the events.
  let highest = null;
  for (const event of events) {
    if (!isRecord(event) || !Number.isInteger(event.turnNumber) || event.turnNumber < 1) {
      continue;
    }
    highest = highest === null ? event.turnNumber : Math.max(highest, event.turnNumber);
  }
  return highest;
}

// The structured summary of one resolved turn: contacts, losses, cohesion
// changes, routs and removals — each with its chance outcome — plus the
// runner's fallback events for non-human players. Pure.
export function summarizeTurn(battle, turnNumber) {
  const events = (Array.isArray(battle?.events) ? battle.events : []).filter(
    (event) => isRecord(event) && event.turnNumber === turnNumber,
  );
  const empty = {
    turnNumber,
    round: roundOfTurn(turnNumber),
    side: null,
    orders: [],
    contacts: [],
    losses: [],
    cohesion: [],
    routs: [],
    draws: [],
    fallbacks: [],
    ended: null,
  };
  if (events.length === 0) {
    return empty;
  }
  const summary = { ...empty, orders: [], contacts: [], losses: [], cohesion: [], routs: [], draws: [], fallbacks: [] };
  summary.side = events.find((entry) => entry?.type === 'turn-resolved')?.side
    ?? events.find((entry) => typeof entry?.side === 'string')?.side
    ?? null;
  for (const event of events) {
    switch (event.type) {
      case 'unit-moved':
      case 'unit-reformed':
      case 'unit-withdrew':
      case 'unit-rallied':
        summary.orders.push(event);
        break;
      case 'unit-charged':
        summary.orders.push(event);
        summary.contacts.push(event);
        break;
      case 'units-shot':
        summary.losses.push({
          kind: 'shot',
          unitId: event.targetId,
          byUnitId: event.unitId,
          losses: event.losses,
          before: event.soldiers?.before ?? null,
          after: event.soldiers?.after ?? null,
          event,
        });
        break;
      case 'units-fought':
        summary.contacts.push(event);
        for (const fight of event.fights || []) {
          if ((fight.lossesTaken ?? 0) > 0) {
            summary.losses.push({
              kind: 'fought',
              unitId: fight.unitId,
              byUnitId: fight.opponentId,
              losses: fight.lossesTaken,
              before: event.soldiers?.[fight.unitId]?.before ?? null,
              after: event.soldiers?.[fight.unitId]?.after ?? null,
              event,
            });
          }
        }
        break;
      case 'unit-cohesion':
        summary.cohesion.push(event);
        break;
      case 'unit-routed':
      case 'unit-fled':
      case 'unit-destroyed':
        summary.routs.push(event);
        break;
      case 'random-draw':
      case 'random-drawn':
        if (event.purpose !== 'starting-side') {
          summary.draws.push(event);
        }
        break;
      case 'player-attempt-refused':
      case 'order-substituted':
      case 'player-fallback':
        summary.fallbacks.push(event);
        break;
      case 'battle-ended':
        summary.ended = event;
        break;
      default:
        break;
    }
  }
  return summary;
}

// The units the map highlights after a turn: every unit with losses, a
// cohesion change, a rout, a flight, or a destruction — each with the reason
// it changed. Contacts without harm (a charge nobody bled in) draw no
// highlight. Pure.
export function changedUnitsForTurn(battle, turnNumber) {
  const summary = summarizeTurn(battle, turnNumber);
  const changed = new Map();
  const mark = (unitId, reason) => {
    if (typeof unitId !== 'string' || unitId.length === 0) {
      return;
    }
    if (!changed.has(unitId)) {
      changed.set(unitId, { unitId, reasons: [] });
    }
    if (!changed.get(unitId).reasons.includes(reason)) {
      changed.get(unitId).reasons.push(reason);
    }
  };
  for (const loss of summary.losses) {
    mark(loss.unitId, 'losses');
    if (loss.kind === 'shot') {
      mark(loss.byUnitId, 'shooting');
    }
  }
  for (const entry of summary.cohesion) {
    mark(entry.unitId, 'cohesion');
  }
  for (const entry of summary.routs) {
    if (entry.type === 'unit-routed') {
      mark(entry.unitId, 'routed');
    } else if (entry.type === 'unit-fled') {
      mark(entry.unitId, 'fled');
    } else {
      mark(entry.unitId, 'destroyed');
    }
  }
  return [...changed.values()];
}
