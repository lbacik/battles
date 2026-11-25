import { getScenarioStore } from '../../lib/store';
import { getBattleStore } from '../../lib/battles';
import { BattleStartError, startBattle, validatePlayability } from '../../domain/battle.js';
import { createPlayerForController, runTurn } from '../../domain/players.js';
import { SUBMISSION_FORMAT_VERSION, resolveTurn, validateTurn } from '../../domain/turn.js';
import { cloneScenario, generateId } from '../../domain/scenario.js';
import { battleSeedOverride, drawBattleSeed, setUrlParams } from './page-helpers';

// Battle-flow actions: setup, begin, turn resolution, handoff, rematch and
// stored-battle maintenance. State stays in `Home`; this factory only closes
// over the values and setters `Home` passes in each render.
export interface BattleActionsDeps {
  openId: any;
  setOpenId: (next: any) => void;
  document: any;
  setDocument: (next: any) => void;
  setSavedDocument: (next: any) => void;
  battles: any;
  setBattles: (next: any) => void;
  setupId: any;
  setSetupId: (next: any) => void;
  setupDocument: any;
  setSetupDocument: (next: any) => void;
  setupProblems: any;
  setSetupProblems: (next: any) => void;
  battle: any;
  setBattle: (next: any) => void;
  decisions: any;
  setDecisions: (next: any) => void;
  announcement: any;
  setAnnouncement: (next: any) => void;
  resolving: any;
  setResolving: (next: any) => void;
  resolveError: any;
  setResolveError: (next: any) => void;
  awaitingHandoff: any;
  setAwaitingHandoff: (next: any) => void;
  handoffSide: any;
  setHandoffSide: (next: any) => void;
  battleError: any;
  setBattleError: (next: any) => void;
  dirty: any;
  refreshLibrary: (...args: any[]) => any;
  refreshBattles: (...args: any[]) => any;
  openScenario: (...args: any[]) => any;
  closeEditor: (...args: any[]) => any;
  showToast: (...args: any[]) => any;
}

export function createBattleActions(deps: BattleActionsDeps) {
  const {
    openId,
    setOpenId,
    document,
    setDocument,
    setSavedDocument,
    battles,
    setBattles,
    setupId,
    setSetupId,
    setupDocument,
    setSetupDocument,
    setupProblems,
    setSetupProblems,
    battle,
    setBattle,
    decisions,
    setDecisions,
    announcement,
    setAnnouncement,
    resolving,
    setResolving,
    resolveError,
    setResolveError,
    awaitingHandoff,
    setAwaitingHandoff,
    handoffSide,
    setHandoffSide,
    battleError,
    setBattleError,
    dirty,
    refreshLibrary,
    refreshBattles,
    openScenario,
    closeEditor,
    showToast,
  } = deps;
  void setOpenId;
  void setDocument;
  void battles;
  void setBattles;
  void setupProblems;
  void announcement;
  void resolveError;
  void awaitingHandoff;
  void handoffSide;
  void battleError;

  function battleSideName(battle: any, id: string): string {
    const side = (battle?.scenario?.sides || []).find((entry: any) => entry?.id === id);
    return side?.name || id;
  }

  // Every battle step is stored before the screen shows it, so a reload
  // right after a visible turn, start, or concession always resumes it.
  async function persistBattle(nextBattle: any, nextDecisions: any[]) {
    try {
      await getBattleStore().save(nextBattle, nextDecisions);
      await refreshBattles();
    } catch (persistError) {
      showToast(
        persistError instanceof Error ? persistError.message : String(persistError),
      );
    }
  }

  // Every resolved turn ends behind the device handoff: the "<Side> — begin
  // your turn" press unlocks the next turn (a human side drafts, an automated
  // side resolves at once).
  function armHandoff(nextBattle: any) {
    setAwaitingHandoff(true);
    setHandoffSide(nextBattle.activeSide);
  }

  async function handleStartBattleFromLibrary(id: string) {
    setBattleError(null);
    try {
      const loaded = await getScenarioStore().load(id);
      if (!loaded) {
        setBattleError('That scenario is no longer in the library.');
        await refreshLibrary();
        return;
      }
      setSetupId(id);
      setSetupDocument(loaded);
      setSetupProblems([]);
    } catch (startError) {
      setBattleError(startError instanceof Error ? startError.message : String(startError));
    }
  }

  function handleStartBattleFromEditor() {
    // The editor button is disabled while dirty, so this always sees the
    // saved version; guard anyway so a battle never starts from edits.
    if (dirty || !document || !openId) return;
    setBattleError(null);
    setSetupId(openId);
    setSetupDocument(cloneScenario(document));
    setSetupProblems([]);
  }

  async function handleBegin(controllers: Record<string, string>) {
    if (!setupDocument) return;
    setBattleError(null);
    setSetupProblems([]);
    let problems: { message: string }[] = [];
    try {
      problems = validatePlayability(setupDocument);
    } catch (validationError) {
      problems = [
        {
          message: `Cannot start a battle: ${validationError instanceof Error ? validationError.message : String(validationError)}`,
        },
      ];
    }
    if (problems.length > 0) {
      setSetupProblems(problems);
      return;
    }
    const seed = battleSeedOverride() ?? drawBattleSeed();
    const normalized: Record<string, string> = {};
    for (const side of setupDocument.sides || []) {
      normalized[side.id] = controllers[side.id] || 'human';
    }
    // The Battles list keys battles by a durable id distinct from the
    // scenario id, so two battles from one scenario never overwrite each
    // other. The battle keeps the scenario id inside its snapshot.
    const battleId = generateId();
    let started: any;
    try {
      started = startBattle(setupDocument, { seed, controllers: normalized, battleId });
    } catch (startError) {
      if (startError instanceof BattleStartError) {
        setSetupProblems(startError.problems);
        return;
      }
      setBattleError(startError instanceof Error ? startError.message : String(startError));
      return;
    }
    const startedDecisions: any[] = [];
    await persistBattle(started, startedDecisions);
    setBattle(started);
    setDecisions(startedDecisions);
    setAnnouncement(`${battleSideName(started, started.startingSide)} begins — round 1, turn 1.`);
    setResolveError(null);
    setResolving(false);
    setAwaitingHandoff(false);
    setHandoffSide(null);
    setSetupId(null);
    setSetupDocument(null);
    setSetupProblems([]);
    setOpenId(null);
    setDocument(null);
    setSavedDocument(null);
    setUrlParams({ scenario: null, battle: battleId });
    showToast(`${battleSideName(started, started.activeSide)} begins.`);
  }

  // The human side commits its drafted orders: every draft change is already
  // validated by the engine, and the commit re-validates the whole submission
  // before it resolves. A commit is all or nothing, and a committed turn
  // cannot be taken back.
  async function handleCommitDraft(orders: any[]) {
    if (!battle || resolving) return;
    if (battle.status !== 'ongoing') return;
    setResolveError(null);
    const submission = {
      formatVersion: SUBMISSION_FORMAT_VERSION,
      battleId: battle.id,
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      orders,
    };
    const verdict = validateTurn(battle, submission);
    if (!verdict.ok) {
      setResolveError(`Commit refused: ${verdict.message} (${verdict.code}).`);
      return;
    }
    let next: any;
    try {
      next = resolveTurn(battle, { type: 'commit', submission });
    } catch (resolveFailure) {
      setResolveError(
        resolveFailure instanceof Error ? resolveFailure.message : String(resolveFailure),
      );
      return;
    }
    const nextDecisions = [...decisions, { type: 'commit', submission }];
    setResolving(true);
    try {
      await persistBattle(next, nextDecisions);
    } finally {
      setResolving(false);
    }
    setBattle(next);
    setDecisions(nextDecisions);
    setAnnouncement(null);
    armHandoff(next);
    showToast(`Turn ${battle.turnNumber} resolved.`);
  }

  // The human side commits an empty turn: all units hold. The commit is
  // validated by the engine before it resolves; a committed turn cannot be
  // taken back.
  async function handleCommitEmpty() {
    if (!battle || resolving) return;
    if (battle.status !== 'ongoing') return;
    setResolveError(null);
    const submission = {
      formatVersion: SUBMISSION_FORMAT_VERSION,
      battleId: battle.id,
      turnNumber: battle.turnNumber,
      side: battle.activeSide,
      orders: [],
    };
    const verdict = validateTurn(battle, submission);
    if (!verdict.ok) {
      setResolveError(`Commit refused: ${verdict.message} (${verdict.code}).`);
      return;
    }
    let next: any;
    try {
      next = resolveTurn(battle, { type: 'commit', submission });
    } catch (resolveFailure) {
      setResolveError(
        resolveFailure instanceof Error ? resolveFailure.message : String(resolveFailure),
      );
      return;
    }
    const nextDecisions = [...decisions, { type: 'commit', submission }];
    setResolving(true);
    try {
      await persistBattle(next, nextDecisions);
    } finally {
      setResolving(false);
    }
    setBattle(next);
    setDecisions(nextDecisions);
    setAnnouncement(null);
    armHandoff(next);
    showToast(`Turn ${battle.turnNumber} resolved.`);
  }

  // A concession ends the battle at once with the other side the winner (the
  // engine records the `turn-conceded` event first, then the uniform
  // `battle-ended` result). There is no handoff afterwards: the battle is
  // finished and read-only. The decision is appended to the stored decisions
  // so the Battles list keeps the full record.
  async function handleConcede() {
    if (!battle || resolving) return;
    if (battle.status !== 'ongoing') return;
    setResolveError(null);
    const side = battle.activeSide;
    let next: any;
    try {
      next = resolveTurn(battle, { type: 'concede', side });
    } catch (concedeError) {
      setResolveError(
        concedeError instanceof Error ? concedeError.message : String(concedeError),
      );
      return;
    }
    const nextDecisions = [...decisions, { type: 'concede', side }];
    await persistBattle(next, nextDecisions);
    setBattle(next);
    setDecisions(nextDecisions);
    setAnnouncement(null);
    showToast(`${battleSideName(battle, side)} conceded.`);
  }

  // A rematch starts a new battle from this battle's scenario snapshot (not
  // the library's current scenario, which may have changed since) with a
  // fresh seed and the same controllers. The finished battle stays stored and
  // read-only.
  async function handleRematch() {
    if (!battle || battle.status === 'ongoing') return;
    const snapshot = battle.scenario;
    if (!snapshot) {
      setBattleError('Rematch refused: this battle has no scenario snapshot.');
      return;
    }
    const controllers = { ...(battle.controllers || {}) };
    const seed = drawBattleSeed();
    const battleId = generateId();
    let started: any;
    try {
      started = startBattle(snapshot, { seed, controllers, battleId });
    } catch (rematchError) {
      if (rematchError instanceof BattleStartError) {
        setBattleError(`Rematch refused: ${rematchError.problems.length} playability problems.`);
      } else {
        setBattleError(rematchError instanceof Error ? rematchError.message : String(rematchError));
      }
      return;
    }
    const startedDecisions: any[] = [];
    await persistBattle(started, startedDecisions);
    setBattle(started);
    setDecisions(startedDecisions);
    setAnnouncement(
      `${battleSideName(started, started.startingSide)} begins the rematch — round 1, turn 1.`,
    );
    setResolveError(null);
    setResolving(false);
    setAwaitingHandoff(false);
    setHandoffSide(null);
    setUrlParams({ scenario: null, battle: battleId });
    showToast(`${battleSideName(started, started.activeSide)} begins the rematch.`);
  }

  // "Open scenario in editor" opens the library's current scenario by the same
  // id — not the battle's snapshot, which never changes after Begin.
  async function handleOpenBattleScenarioInEditor() {
    const scenarioId = battle?.scenario?.id;
    if (!scenarioId) return;
    setBattleError(null);
    let stored: unknown = null;
    try {
      stored = await getScenarioStore().load(scenarioId);
    } catch {
      stored = null;
    }
    if (!stored) {
      showToast('That scenario is no longer in the library.');
      return;
    }
    setBattle(null);
    setDecisions([]);
    setAnnouncement(null);
    setResolveError(null);
    setResolving(false);
    setAwaitingHandoff(false);
    setHandoffSide(null);
    setUrlParams({ scenario: null, battle: null });
    await openScenario(scenarioId);
  }

  // An automated side's turn resolves through the runner at once and then
  // waits for "Continue": there is no auto-play.
  async function handleContinueAutomated() {
    if (!battle || resolving) return;
    if (battle.status !== 'ongoing') return;
    setResolving(true);
    setResolveError(null);
    try {
      const players: Record<string, any> = {};
      for (const [side, controller] of Object.entries(battle.controllers || {})) {
        if (controller !== 'human') {
          players[side] = createPlayerForController(controller as string);
        }
      }
      if (!players[battle.activeSide]) {
        players[battle.activeSide] = createPlayerForController(
          battle.controllers?.[battle.activeSide] || 'passive',
        );
      }
      const step = await runTurn(battle, players);
      const nextDecisions = [...decisions, step.decision];
      await persistBattle(step.battle, nextDecisions);
      setBattle(step.battle);
      setDecisions(nextDecisions);
      setAnnouncement(null);
      armHandoff(step.battle);
      showToast(`Turn ${battle.turnNumber} resolved.`);
    } catch (automatedError) {
      setResolveError(
        automatedError instanceof Error ? automatedError.message : String(automatedError),
      );
    } finally {
      setResolving(false);
    }
  }

  // The device handoff: pressing "<Side> — begin your turn" unlocks the next
  // turn. A human side drafts after the press; an automated side resolves at
  // once through the runner. A committed turn cannot be taken back.
  async function handleHandoff() {
    if (!battle || resolving || !awaitingHandoff) return;
    if (battle.status !== 'ongoing') return;
    const nextSide = handoffSide;
    setAwaitingHandoff(false);
    setHandoffSide(null);
    setResolveError(null);
    if (!nextSide) return;
    const controller = battle.controllers?.[nextSide] || 'human';
    if (controller === 'human') return;
    await handleContinueAutomated();
  }

  function handleBackToLibrary() {
    // Starting a battle needs a saved scenario, so closing the editor here
    // never drops unsaved edits.
    closeEditor();
    setSetupId(null);
    setSetupDocument(null);
    setSetupProblems([]);
    setBattle(null);
    setDecisions([]);
    setAnnouncement(null);
    setResolveError(null);
    setResolving(false);
    setAwaitingHandoff(false);
    setHandoffSide(null);
    setUrlParams({ scenario: null, battle: null });
    void refreshLibrary();
    void refreshBattles();
  }

  async function handleOpenSetupInEditor() {
    if (!setupId) return;
    const id = setupId;
    setSetupId(null);
    setSetupDocument(null);
    setSetupProblems([]);
    await openScenario(id);
  }

  async function handleDeleteBattle(id: string) {
    if (!window.confirm('Delete this battle?')) return;
    try {
      await getBattleStore().remove(id);
      if (battle?.id === id) {
        handleBackToLibrary();
        return;
      }
      await refreshBattles();
      showToast('Battle deleted.');
    } catch (deleteError) {
      setBattleError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    }
  }

  return {
    battleSideName,
    persistBattle,
    armHandoff,
    handleStartBattleFromLibrary,
    handleStartBattleFromEditor,
    handleBegin,
    handleCommitDraft,
    handleCommitEmpty,
    handleConcede,
    handleRematch,
    handleOpenBattleScenarioInEditor,
    handleContinueAutomated,
    handleHandoff,
    handleBackToLibrary,
    handleOpenSetupInEditor,
    handleDeleteBattle,
  };
}
