// PÓLIS engine — Shoot orders: missile fire at enemy units (framework-free).
//
// The shooting slice of the framework-free engine package: a missile-armed
// unit spends its turn shooting at one enemy unit in range and line of fire,
// inflicting losses and cohesion loss. This module imports only the domain
// model, the ruleset package, the plane geometry, and the movement footprint
// helpers — no React, no Next.js, no DOM, no Node APIs — so it runs unchanged
// in the browser, in Node unit tests, and in any future shell.
//
// Mechanics (decisions #6 items 11, 19, #7 items 3, 5, 8):
//
// - A Shoot names `{ targetId }`. Only troop types with a missile range may
//   shoot. The shooter must not be Engaged or Routed (gated by the turn
//   contract, `./turn.js`, which also refuses Shoot for troop types without
//   missiles); a Disordered shooter shoots with a penalty. A Shoot never moves
//   the shooter: the deterministic preview is the same-pose footprint, and
//   sequential validation leaves the simulated pose unchanged.
// - The engine aims at the nearest point of the target footprint, measured
//   from the shooter's front edge (the shortest distance between the front
//   edge segment and the target ring), and reads that distance against the
//   troop type's missile range (`out_of_range`). The aim point must lie inside
//   the shooter's ±45° front arc, read from the front midpoint
//   (`outside_front_arc`).
// - The line from the shooter's front midpoint to the aim point must be clear
//   (`no_line_of_fire`): a forest or settlement polygon blocks it unless the
//   shooter's own ground (the start point) or the target's cover (the aim
//   point) lies inside it, and any other unit's footprint of either side
//   blocks it on any touch. Engaged units cannot be targeted (`invalid_shoot`
//   with reason `engaged-target`).
// - The Shooting phase resolves the active side's Shoot orders in the given
//   order against the evolving state: losses are the shooters (the shooting
//   unit's soldiers) × a seeded draw × the lethality parameter, multiplied
//   down once per target modifier — open spacing, forest or settlement cover,
//   and a Disordered shooter — rounded to whole soldiers and capped at the
//   soldiers still standing. Each shot draws once; every draw is recorded as
//   a `random-draw` event with purpose `shooting-loss`, each shot as a
//   `units-shot` event, and units whose state steps down as `unit-cohesion`
//   events. Cohesion strain is casualties × the per-casualty parameter and
//   steps Steady to Disordered to Routed at the shooting thresholds.
// - Losses come off the rear exactly as in combat (see `./combat.js`), so the
//   target footprint visibly shrinks while its front edge stays put.

import {
  EPS,
  isFinitePoint,
  locatePoint,
  round1,
  segmentsIntersect,
} from './geometry.js';
import { inFrontArc } from './charge.js';
import { footprintAfterLosses, lossesOf } from './combat.js';
import { createRng } from './battle.js';
import { getTroopType, spacingClass } from './polis-classical.js';
import {
  FORWARD_ARC_DEG,
  footprintAt,
  footprintPreview,
  groundCoverAt,
  normalizeFacing,
} from './movement.js';

// The shooting parameters when the battle snapshot carries no `shooting`
// block. Initial values for this slice; the ruleset file owns the tuned ones.
export const DEFAULT_SHOOTING = Object.freeze({
  lethality: 0.02,
  openSpacingFactor: 0.6,
  coverFactor: Object.freeze({ forest: 0.5, settlement: 0.6 }),
  disorderedFactor: 0.7,
  cohesionPerCasualty: 0.2,
  disorderedAt: 2.0,
  routedAt: 4.0,
});

// Read the shooting parameters from the battle snapshot, in either the outer
// shape (`parameters.shooting`) or the inner shape (the shooting block
// itself). Missing values fall back to the defaults; the cover table merges
// per category. Never throws.
export function shootingParamsOf(parameters) {
  const inner = parameters && typeof parameters === 'object' && parameters.shooting
    && typeof parameters.shooting === 'object'
    ? parameters.shooting
    : parameters && typeof parameters === 'object' ? parameters : {};
  const pick = (key) => (Number.isFinite(inner[key]) ? inner[key] : DEFAULT_SHOOTING[key]);
  const cover = inner.coverFactor && typeof inner.coverFactor === 'object' ? inner.coverFactor : {};
  const coverFactor = { ...DEFAULT_SHOOTING.coverFactor };
  for (const key of Object.keys(coverFactor)) {
    if (Number.isFinite(cover[key])) {
      coverFactor[key] = cover[key];
    }
  }
  return {
    lethality: pick('lethality'),
    openSpacingFactor: pick('openSpacingFactor'),
    coverFactor,
    disorderedFactor: pick('disorderedFactor'),
    cohesionPerCasualty: pick('cohesionPerCasualty'),
    disorderedAt: pick('disorderedAt'),
    routedAt: pick('routedAt'),
  };
}

// The troop type's missile range in metres, or null when the unit's troop
// type has none (or is unknown). Pure. Never throws.
export function missileRangeOf(unit) {
  const range = getTroopType(unit?.troopType)?.missileRange;
  return Number.isFinite(range) && range > 0 ? range : null;
}

function roundPoint(point) {
  return { x: round1(point.x), y: round1(point.y) };
}

// The closest point on the segment a-b to `point`, with its distance.
function pointToSegment(point, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const squared = dx * dx + dy * dy;
  let t = squared > EPS ? ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared : 0;
  t = Math.min(1, Math.max(0, t));
  const closest = { x: a.x + dx * t, y: a.y + dy * t };
  return { distance: Math.hypot(point.x - closest.x, point.y - closest.y), closest };
}

// The nearest point of the target footprint ring to the shooter's front edge
// segment (corners[0] to corners[1]): `{ distance, aim }`, where `aim` lies
// on the target ring. When the front edge touches or crosses the target ring
// — a degenerate state, since opposing touch is refused before a battle and
// movement never rests in contact — the distance is 0 and the aim is the
// target vertex nearest the shooter's front midpoint. Deterministic: ties
// keep the first candidate in ring order. Pure.
export function aimAtTarget(shooterCorners, targetCorners) {
  const frontA = shooterCorners[0];
  const frontB = shooterCorners[1];
  for (let i = 0; i < targetCorners.length; i += 1) {
    const c = targetCorners[i];
    const d = targetCorners[(i + 1) % targetCorners.length];
    if (segmentsIntersect(frontA, frontB, c, d)) {
      const mid = { x: (frontA.x + frontB.x) / 2, y: (frontA.y + frontB.y) / 2 };
      let nearest = targetCorners[0];
      let best = Number.POSITIVE_INFINITY;
      for (const vertex of targetCorners) {
        const distance = Math.hypot(vertex.x - mid.x, vertex.y - mid.y);
        if (distance < best) {
          best = distance;
          nearest = vertex;
        }
      }
      return { distance: 0, aim: { ...nearest } };
    }
  }
  let best = null;
  const consider = (distance, aim) => {
    if (!best || distance < best.distance - EPS) {
      best = { distance, aim: { ...aim } };
    }
  };
  for (const vertex of targetCorners) {
    consider(pointToSegment(vertex, frontA, frontB).distance, vertex);
  }
  for (const end of [frontA, frontB]) {
    for (let i = 0; i < targetCorners.length; i += 1) {
      const c = targetCorners[i];
      const d = targetCorners[(i + 1) % targetCorners.length];
      const { distance, closest } = pointToSegment(end, c, d);
      consider(distance, closest);
    }
  }
  return best;
}

// True when the segment from `start` to `end` meets the ring in any way:
// crossing or touching an edge, or starting or ending strictly inside it.
// A shot line ending inside a neighbour is a hit on that neighbour, so the
// aim endpoint counts here (the target's own ring is never passed in).
function segmentMeetsRing(start, end, ring) {
  for (let i = 0; i < ring.length; i += 1) {
    if (segmentsIntersect(start, end, ring[i], ring[(i + 1) % ring.length])) {
      return true;
    }
  }
  return locatePoint(ring, start) === 'inside' || locatePoint(ring, end) === 'inside';
}

// The first blocker on the line from `start` to `aim`, or null when the line
// is clear. Unit rings (`[{ id, corners }]`, never holding the shooter or
// the target) block on any touch, on either side alike. Forest and settlement
// polygons block unless the line starts inside them (the shooter's own
// ground) or ends inside them (the target's cover, which softens the shot
// instead). Units are checked first in the given order, then terrain in
// document order, so the reported blocker is deterministic. Pure.
export function lineBlocker(start, aim, unitRings, terrainFeatures) {
  for (const entry of Array.isArray(unitRings) ? unitRings : []) {
    if (!entry || typeof entry.id !== 'string' || !Array.isArray(entry.corners)) {
      continue;
    }
    if (entry.corners.length >= 3 && segmentMeetsRing(start, aim, entry.corners)) {
      return entry.id;
    }
  }
  for (const feature of Array.isArray(terrainFeatures) ? terrainFeatures : []) {
    if (!feature || feature.kind !== 'ground') {
      continue;
    }
    if (feature.category !== 'forest' && feature.category !== 'settlement') {
      continue;
    }
    if (!Array.isArray(feature.polygon) || feature.polygon.length < 3) {
      continue;
    }
    if (locatePoint(feature.polygon, start) !== 'outside') {
      continue;
    }
    if (locatePoint(feature.polygon, aim) !== 'outside') {
      continue;
    }
    if (segmentMeetsRing(start, aim, feature.polygon)) {
      return feature.id;
    }
  }
  return null;
}

// Corners for a unit template at a pose, or null when the template is
// degenerate. Never throws.
function cornersOf(template, pose) {
  try {
    return footprintAt(template, { ...pose.position }, pose.facing).corners;
  } catch {
    return null;
  }
}

// Validate one Shoot against the field: the shooter's footprint template,
// its current `{ position, facing }`, the target unit and its simulated pose,
// whether the target is engaged (battle state or earlier orders this turn),
// every other unit as a full unit at its simulated pose (the shooter
// excluded), the scenario's `terrainFeatures`, and the battle `parameters`
// (the shooting block and the movement arc). Pure: nothing is changed.
//
// Checks, in order (the first failure wins, so each rejection is
// unambiguous):
//
// 1. `invalid_shoot`: the target is unknown (`unknown-target`), is no enemy
//    (`not-enemy`), or is Engaged (`engaged-target`); the shooter's troop
//    type has no missile range (`no-missiles`); or a pose is missing
//    (`bad-pose`).
// 2. `out_of_range`: the aim distance exceeds the missile range. `details`
//    carries `rangeM`, `distanceM`, and the `shortfallM`, all billed to
//    0.1 m.
// 3. `outside_front_arc`: the aim point lies outside the shooter's ±45°
//    front arc. `details` names the shooter and the target.
// 4. `no_line_of_fire`: a unit of either side, a forest, or a settlement
//    blocks the line. `details` names the blocker (`blockedBy`, a unit id or
//    a terrain feature id).
//
// An accepted plan returns a deterministic preview — the same-pose footprint,
// since a Shoot never moves — plus the shot (`targetId`, `distanceM`, and the
// aim point). Validation simulates on snapped poses and commits exactly the
// preview, so re-validating a verdict can never disagree with it.
export function validateShootOnField({
  unit,
  from,
  target,
  targetPose,
  targetEngaged = false,
  others = [],
  terrainFeatures = [],
  parameters = {},
  orderIndex = 0,
}) {
  const unitId = unit?.id ?? null;
  const fail = (code, details, message) => ({ ok: false, code, details, message });
  if (!target || typeof target !== 'object' || typeof target.id !== 'string') {
    return fail(
      'invalid_shoot',
      { unitId, reason: 'unknown-target' },
      `Order ${orderIndex}: unit "${unitId}" shoots at an unknown target.`,
    );
  }
  if (target.side === unit?.side || target.id === unitId) {
    return fail(
      'invalid_shoot',
      { unitId, targetId: target.id, reason: 'not-enemy' },
      `Order ${orderIndex}: unit "${unitId}" cannot shoot at "${target.id}" (only enemies).`,
    );
  }
  if (targetEngaged === true) {
    return fail(
      'invalid_shoot',
      { unitId, targetId: target.id, reason: 'engaged-target' },
      `Order ${orderIndex}: unit "${unitId}" cannot shoot at "${target.id}" (Engaged units cannot be targeted).`,
    );
  }
  const rangeM = missileRangeOf(unit);
  if (rangeM === null) {
    return fail(
      'invalid_shoot',
      { unitId, reason: 'no-missiles' },
      `Order ${orderIndex}: unit "${unitId}" (troop type "${unit?.troopType}") has no missiles and cannot shoot.`,
    );
  }
  if (!isFinitePoint(from?.position) || !Number.isFinite(from?.facing)
    || !isFinitePoint(targetPose?.position) || !Number.isFinite(targetPose?.facing)) {
    return fail(
      'invalid_shoot',
      { unitId, targetId: target.id, reason: 'bad-pose' },
      `Order ${orderIndex}: unit "${unitId}" cannot aim at "${target.id}" without a position.`,
    );
  }
  const startPose = {
    position: roundPoint(from.position),
    facing: normalizeFacing(round1(from.facing)),
  };
  const shooterCorners = cornersOf(unit, startPose);
  const targetCorners = cornersOf(target, {
    position: roundPoint(targetPose.position),
    facing: normalizeFacing(round1(targetPose.facing)),
  });
  if (!shooterCorners || !targetCorners) {
    return fail(
      'invalid_shoot',
      { unitId, targetId: target.id, reason: 'bad-pose' },
      `Order ${orderIndex}: unit "${unitId}" cannot aim at "${target.id}" without a footprint.`,
    );
  }
  const start = { ...startPose.position };
  const { distance, aim } = aimAtTarget(shooterCorners, targetCorners);
  const distanceM = round1(distance);
  if (distance > rangeM + EPS) {
    return fail(
      'out_of_range',
      { unitId, targetId: target.id, rangeM, distanceM, shortfallM: round1(distanceM - rangeM) },
      `Order ${orderIndex}: unit "${unitId}" cannot reach "${target.id}" ` +
        `(${distanceM} m beyond the ${rangeM} m range).`,
    );
  }
  const arc = Number.isFinite(parameters?.movement?.forwardArcDeg)
    ? parameters.movement.forwardArcDeg
    : FORWARD_ARC_DEG;
  if (!inFrontArc(startPose, aim, arc)) {
    return fail(
      'outside_front_arc',
      { unitId, targetId: target.id },
      `Order ${orderIndex}: unit "${unitId}" cannot shoot at "${target.id}" outside its front arc.`,
    );
  }
  const unitRings = [];
  for (const other of Array.isArray(others) ? others : []) {
    if (!other || typeof other.id !== 'string' || other.id === unitId || other.id === target.id) {
      continue;
    }
    if (!isFinitePoint(other.position) || !Number.isFinite(other.facing)) {
      continue;
    }
    const corners = cornersOf(other, { position: other.position, facing: other.facing });
    if (corners) {
      unitRings.push({ id: other.id, corners });
    }
  }
  const blockedBy = lineBlocker(start, aim, unitRings, terrainFeatures);
  if (blockedBy !== null) {
    return fail(
      'no_line_of_fire',
      { unitId, targetId: target.id, blockedBy },
      `Order ${orderIndex}: unit "${unitId}" has no line of fire at "${target.id}" ` +
        `(blocked by "${blockedBy}").`,
    );
  }
  return {
    ok: true,
    preview: footprintPreview(unit, start, startPose.facing),
    shoot: { targetId: target.id, distanceM, aimPoint: roundPoint(aim) },
  };
}

// Suggest shoot targets for a shooter at its turn-start pose: every enemy
// unit that is not engaged, in range, inside the front arc, and on a clear
// line, each with the distance in metres. Hints, not guarantees: earlier
// orders in the same turn can still block the shot. Sorted by distance, then
// target id, so the hints are deterministic. Pure.
export function shootCandidatesFor(shooter, shooterPose, enemies, others, terrainFeatures, parameters) {
  const rangeM = missileRangeOf(shooter);
  if (rangeM === null) {
    return [];
  }
  if (!isFinitePoint(shooterPose?.position) || !Number.isFinite(shooterPose?.facing)) {
    return [];
  }
  const startPose = {
    position: roundPoint(shooterPose.position),
    facing: normalizeFacing(round1(shooterPose.facing)),
  };
  const shooterCorners = cornersOf(shooter, startPose);
  if (!shooterCorners) {
    return [];
  }
  const arc = Number.isFinite(parameters?.movement?.forwardArcDeg)
    ? parameters.movement.forwardArcDeg
    : FORWARD_ARC_DEG;
  const start = { ...startPose.position };
  const candidates = [];
  for (const enemy of Array.isArray(enemies) ? enemies : []) {
    if (!enemy || typeof enemy.id !== 'string' || enemy.id === shooter?.id) {
      continue;
    }
    if (enemy.side === shooter?.side) {
      continue;
    }
    if (enemy.engaged && typeof enemy.engaged === 'object' && typeof enemy.engaged.unitId === 'string') {
      continue;
    }
    if (!isFinitePoint(enemy.position) || !Number.isFinite(enemy.facing)) {
      continue;
    }
    const targetCorners = cornersOf(enemy, { position: enemy.position, facing: enemy.facing });
    if (!targetCorners) {
      continue;
    }
    const { distance, aim } = aimAtTarget(shooterCorners, targetCorners);
    if (distance > rangeM + EPS) {
      continue;
    }
    if (!inFrontArc(startPose, aim, arc)) {
      continue;
    }
    const unitRings = [];
    for (const other of Array.isArray(others) ? others : []) {
      if (!other || typeof other.id !== 'string' || other.id === shooter?.id || other.id === enemy.id) {
        continue;
      }
      if (!isFinitePoint(other.position) || !Number.isFinite(other.facing)) {
        continue;
      }
      const corners = cornersOf(other, { position: other.position, facing: other.facing });
      if (corners) {
        unitRings.push({ id: other.id, corners });
      }
    }
    if (lineBlocker(start, aim, unitRings, terrainFeatures) !== null) {
      continue;
    }
    candidates.push({ targetId: enemy.id, distanceM: round1(distance) });
  }
  candidates.sort((left, right) => {
    if (left.distanceM !== right.distanceM) {
      return left.distanceM - right.distanceM;
    }
    return left.targetId < right.targetId ? -1 : 1;
  });
  return candidates;
}

// One shot's loss multipliers for the target: open spacing, forest or
// settlement cover under the target, and a Disordered shooter each multiply
// the losses down. Returns `{ product, modifiers }`, where `modifiers` lists
// the applied `{ key, factor }` entries for the shot record. Pure.
export function shotModifiersOf({ shooter, target, terrainFeatures = [], parameters = {} }) {
  const params = shootingParamsOf(parameters?.shooting ?? parameters);
  let product = 1;
  const modifiers = [];
  const apply = (key, factor) => {
    if (!Number.isFinite(factor) || factor === 1 || !(factor > 0)) {
      return;
    }
    product *= factor;
    modifiers.push({ key, factor });
  };
  if (spacingClass(target?.troopType, target?.lateralInterval) === 'open') {
    apply('open-spacing', params.openSpacingFactor);
  }
  let cover = 'open';
  try {
    const corners = footprintAt(target, { ...target.position }, target.facing).corners;
    cover = groundCoverAt(corners, terrainFeatures);
  } catch {
    cover = 'open';
  }
  if (cover === 'forest' || cover === 'settlement') {
    apply('cover', params.coverFactor[cover]);
  }
  if (shooter?.cohesion === 'Disordered' || shooter?.cohesion === 'Routed') {
    apply('disordered', params.disorderedFactor);
  }
  return { product, modifiers };
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

// Resolve the Shooting phase against the mutable battle: the active side's
// accepted Shoot orders in the given order, each drawing from the engine
// generator. Mutates the target units (soldiers, files, cohesion, strain),
// the generator state, and the events. Shots resolve sequentially against the
// evolving state — unlike Combat's simultaneous pairs, each shot reads the
// target as earlier shots left it — and losses shrink the footprint from the
// rear exactly as in combat. No orders means no draws and no events.
export function resolveShootingPhase(battle, shootOrders) {
  if (!battle || typeof battle !== 'object' || Array.isArray(battle)) {
    throw new Error('Shooting needs a battle state object.');
  }
  if (!Array.isArray(battle.units) || !Array.isArray(battle.events)) {
    throw new Error('Shooting needs a battle with units and events.');
  }
  const orders = Array.isArray(shootOrders) ? shootOrders : [];
  if (orders.length === 0) {
    return;
  }
  const params = shootingParamsOf(battle.parameters);
  const features = battle.scenario?.terrainFeatures || [];
  const byId = new Map(battle.units.map((unit) => [unit?.id, unit]));
  const rng = createRng(battle.rngState);
  const pushEvent = (fields) => {
    battle.events.push({ seq: battle.events.length, ...fields });
  };
  for (const order of orders) {
    const shooter = order && typeof order.unitId === 'string' ? byId.get(order.unitId) : undefined;
    const target = order && typeof order.targetId === 'string' ? byId.get(order.targetId) : undefined;
    if (!shooter || !target) {
      continue;
    }
    const shooters = Number.isFinite(shooter.soldiers) && shooter.soldiers > 0
      ? Math.floor(shooter.soldiers)
      : 0;
    const { product, modifiers } = shotModifiersOf({
      shooter,
      target,
      terrainFeatures: features,
      parameters: battle.parameters,
    });
    const value = rng.next();
    battle.rngState = rng.state;
    const raw = lossesOf({ strength: shooters * product, draw: value, lethality: params.lethality });
    const before = Number.isFinite(target.soldiers) && target.soldiers > 0
      ? Math.floor(target.soldiers)
      : 0;
    const dealt = Math.min(before, raw);
    const after = footprintAfterLosses({ soldiers: target.soldiers, files: target.files }, dealt);
    target.soldiers = after.soldiers;
    target.files = after.files;
    pushEvent({
      type: 'random-draw',
      purpose: 'shooting-loss',
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      unitId: shooter.id,
      targetId: target.id,
      value,
      result: dealt,
    });
    const strain = round3(dealt * params.cohesionPerCasualty);
    if (strain > 0) {
      const total = round3(
        (Number.isFinite(target.cohesionStrain) && target.cohesionStrain > 0
          ? target.cohesionStrain
          : 0) + strain,
      );
      target.cohesionStrain = total;
      const cohesionBefore = target.cohesion;
      if (total >= params.routedAt) {
        target.cohesion = 'Routed';
        target.cohesionState = 'Routed';
      } else if (total >= params.disorderedAt && target.cohesion === 'Steady') {
        target.cohesion = 'Disordered';
        target.cohesionState = 'Disordered';
      }
      // Both stored state strings move together: nothing reads `cohesionState`
      // preferentially (see `./cohesion.js`), so this keeps the mirror fields
      // in sync without changing any engine read.
      if (target.cohesion !== cohesionBefore) {
        pushEvent({
          type: 'unit-cohesion',
          turnNumber: battle.turnNumber,
          side: target.side ?? null,
          unitId: target.id,
          cohesionBefore,
          cohesionAfter: target.cohesion,
          strain: total,
        });
      }
    }
    pushEvent({
      type: 'units-shot',
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      unitId: shooter.id,
      targetId: target.id,
      shooters,
      modifiers,
      losses: dealt,
      soldiers: { before, after: target.soldiers },
      strain,
    });
  }
}
