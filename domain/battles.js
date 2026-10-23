// PÓLIS battle library — the narrow battle store interface.
//
// Battles survive reloads: every committed turn is saved, and a Battles list
// resumes battles in progress. The battle library sits behind this interface
// so browser storage (IndexedDB) can later be replaced by server storage
// without changing the battle player. The interface is framework-free: it
// imports only the domain model.
//
// A stored battle record carries the full battle state — which itself holds
// the scenario snapshot, the ruleset identifier and version, the parameter
// snapshot, the seed and generator state, the controller of each side, and
// the turn tracking — plus the committed turn decisions that produced it.
// Whether live state is also cached elsewhere is an implementation choice;
// this store is the durable copy.
//
// Interface (every implementation must honour it):
//   list() -> Promise<BattleMetadata[]> (newest first; entries carry the
//             battle id, the scenario title and id, the battle status, the
//             turn number, round, active side, revision, and updatedAt)
//   load(id) -> Promise<{ battle, decisions } | null> (deep-cloned)
//   loadRaw(id) -> Promise<stored record | null> (the raw record, deep-cloned)
//   save(battle, decisions) -> Promise<BattleMetadata>
//   remove(id) -> Promise<boolean>
//   clear()  -> Promise<void>
// save() validates the battle and the decisions, assigns revision 1 to a new
// id and increments it on every subsequent save of the same id. The battle
// id is immutable: a save never changes it. Implementations must deep-clone
// across the boundary so callers cannot mutate stored state.
// save() is atomic: it validates and clones before mutating anything, so a
// failure rejects and leaves the previous version intact.
//
// Finished battles (status other than `ongoing`) stay on the list as
// read-only: the player never commits to them, but they can be deleted.

import { CONTROLLERS } from './battle.js';

export const BATTLE_RECORD_VERSION = 1;

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

// Deep clone a battle state. Battles are plain data, so a JSON round trip is
// a faithful copy.
export function cloneBattle(battle) {
  return cloneValue(battle);
}

// Deep clone a decisions list (the committed turn decisions that produced
// the stored battle state).
export function cloneDecisions(decisions) {
  return cloneValue(decisions ?? []);
}

// Newest first; entries without a timestamp sort last. Shared by every
// store implementation so the battles list orders entries the same way.
export function compareBattleEntries(a, b) {
  if (a.updatedAt === b.updatedAt) return 0;
  if (a.updatedAt === null || a.updatedAt === undefined) return 1;
  if (b.updatedAt === null || b.updatedAt === undefined) return -1;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

// True when the battle is finished: anything other than `ongoing` is
// read-only (a conceded battle in this slice).
export function isBattleFinished(battle) {
  return !!battle && battle.status !== 'ongoing';
}

function controllersProblem(controllers) {
  if (!isRecord(controllers)) {
    return 'controllers must map each side id to a controller';
  }
  for (const [side, controller] of Object.entries(controllers)) {
    if (!isNonEmptyString(side)) {
      return 'controllers must map each side id to a controller';
    }
    if (!isNonEmptyString(controller) || !CONTROLLERS.includes(String(controller).toLowerCase())) {
      return `unknown controller "${String(controller)}" for side "${side}"`;
    }
  }
  return null;
}

function decisionsProblem(decisions) {
  if (!Array.isArray(decisions)) {
    return 'decisions must be an array of committed turn decisions';
  }
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    if (!isRecord(decision)) {
      return `decision ${index} must be an object`;
    }
    if (decision.type === 'concede') {
      continue;
    }
    if (decision.type !== 'commit') {
      return `decision ${index} has unknown type "${String(decision.type)}"`;
    }
    const submission = decision.submission;
    if (!isRecord(submission) || !Array.isArray(submission.orders)) {
      return `decision ${index} needs a submission with an orders array`;
    }
    if (!isNonEmptyString(submission.battleId) || !isNonEmptyString(submission.side)) {
      return `decision ${index} needs a battle id and a side`;
    }
    if (!Number.isInteger(submission.turnNumber) || submission.turnNumber < 1) {
      return `decision ${index} needs a turn number of at least 1`;
    }
  }
  return null;
}

// Throw when the battle state misses anything the Battles list must keep:
// the scenario snapshot, the ruleset identifier and version, the parameter
// snapshot, the seed, and the controller of each side.
export function assertValidBattle(battle) {
  const problems = [];
  if (!isRecord(battle)) {
    throw new Error('Invalid battle: a battle must be an object.');
  }
  if (battle.kind !== 'battle') {
    problems.push('kind must be "battle"');
  }
  if (!isNonEmptyString(battle.id)) {
    problems.push('id must be a non-empty string');
  }
  if (!isRecord(battle.scenario)) {
    problems.push('scenario snapshot must be an object');
  } else if (!isNonEmptyString(battle.scenario.id)) {
    problems.push('scenario snapshot must carry its id');
  }
  if (!isRecord(battle.ruleset) || !isNonEmptyString(battle.ruleset.id) || !isNonEmptyString(battle.ruleset.version)) {
    problems.push('ruleset must carry an identifier and a version');
  }
  if (!isRecord(battle.parameters)) {
    problems.push('parameters must carry the parameter snapshot');
  }
  if (!Number.isInteger(battle.seed) || battle.seed < 0 || battle.seed > 0xffffffff) {
    problems.push('seed must be an unsigned 32-bit integer');
  }
  const controllerProblem = controllersProblem(battle.controllers);
  if (controllerProblem) {
    problems.push(controllerProblem);
  }
  if (!isNonEmptyString(battle.status)) {
    problems.push('status must be a non-empty string');
  }
  if (!Number.isInteger(battle.turnNumber) || battle.turnNumber < 1) {
    problems.push('turnNumber must be an integer of at least 1');
  }
  if (!Number.isInteger(battle.round) || battle.round < 1) {
    problems.push('round must be an integer of at least 1');
  }
  if (!isNonEmptyString(battle.activeSide)) {
    problems.push('activeSide must be a non-empty string');
  }
  if (!Array.isArray(battle.units)) {
    problems.push('units must be an array');
  }
  if (!Array.isArray(battle.events)) {
    problems.push('events must be an array');
  }
  if (problems.length > 0) {
    throw new Error(`Invalid battle: ${problems.join('; ')}.`);
  }
}

export function assertValidDecisions(decisions) {
  const problem = decisionsProblem(decisions);
  if (problem) {
    throw new Error(`Invalid battle decisions: ${problem}.`);
  }
}

function battleMetadata(id, battle, revision, updatedAt) {
  return {
    id,
    title: isRecord(battle?.scenario) && isNonEmptyString(battle.scenario.title)
      ? battle.scenario.title
      : '(untitled battle)',
    scenarioId: isRecord(battle?.scenario) && isNonEmptyString(battle.scenario.id)
      ? battle.scenario.id
      : null,
    status: isNonEmptyString(battle?.status) ? battle.status : 'unknown',
    turnNumber: Number.isInteger(battle?.turnNumber) ? battle.turnNumber : null,
    round: Number.isInteger(battle?.round) ? battle.round : null,
    activeSide: isNonEmptyString(battle?.activeSide) ? battle.activeSide : null,
    revision,
    updatedAt,
  };
}

export class MemoryBattleStore {
  constructor() {
    this.records = new Map();
  }

  async list() {
    return [...this.records.values()]
      .map((record) => battleMetadata(
        record.id,
        record.battle,
        record.revision,
        record.updatedAt,
      ))
      .sort(compareBattleEntries);
  }

  async load(id) {
    const record = this.records.get(id);
    if (!record) return null;
    return {
      battle: cloneBattle(record.battle),
      decisions: cloneDecisions(record.decisions),
    };
  }

  async loadRaw(id) {
    const record = this.records.get(id);
    if (!record) return null;
    return cloneValue(record);
  }

  async save(battle, decisions = []) {
    assertValidBattle(battle);
    assertValidDecisions(decisions);
    const previous = this.records.get(battle.id);
    const storedBattle = cloneBattle(battle);
    const storedDecisions = cloneDecisions(decisions);
    const updatedAt = new Date().toISOString();
    const revision = previous ? previous.revision + 1 : 1;
    this.records.set(storedBattle.id, {
      id: storedBattle.id,
      battle: storedBattle,
      decisions: storedDecisions,
      revision,
      updatedAt,
    });
    return battleMetadata(storedBattle.id, storedBattle, revision, updatedAt);
  }

  async remove(id) {
    return this.records.delete(id);
  }

  async clear() {
    this.records.clear();
  }
}
