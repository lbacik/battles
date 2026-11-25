// issue #83: battle flow - setup, refusal, Begin, one turn each way, resume (scripts/e2e.mjs lines 2175-2406).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, T_SAVE, T_LOAD, T_BATTLE } from './helpers.mjs';
import { reportDir } from './helpers.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runIssue83(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #83: battle flow — setup, refusal, Begin, one turn each way, and
  // resume. Runs in a fresh context with a fixed programmatic seed (there is
  // no seed field in the UI: the seed is drawn at Begin).
  const battleContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await battleContext.setDefaultTimeout(T_BATTLE);
  const battlePage = await battleContext.newPage();
  ctx.battleContext = battleContext;
  ctx.battlePage = battlePage;
  battlePage.on('console', (message) => log(`battle console: ${message.text()}`));
  battlePage.on('pageerror', (error) => log(`battle pageerror: ${String(error)}`));
  battlePage.on('dialog', async (dialog) => {
    log(`battle dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await battlePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await battlePage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await battlePage.evaluate(() => {
    window.__POLIS_TEST_SEED = 7;
  });

  const battleTitle = `Battle Probe ${Date.now()}`;
  await battlePage.getByTestId('new-scenario-title').fill(battleTitle);
  await battlePage.getByTestId('new-scenario-submit').click();
  await battlePage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  // The editor offers Start battle only without unsaved changes.
  check(
    'start battle is available when the scenario is saved',
    await battlePage.getByTestId('start-battle-editor').isEnabled(),
  );
  const editedBattleTitle = `${battleTitle} edited`;
  await battlePage.getByTestId('inspector-title').fill(editedBattleTitle);
  await battlePage.getByTestId('inspector-title').blur();
  check(
    'start battle is disabled with unsaved changes',
    await battlePage.getByTestId('start-battle-editor').isDisabled(),
  );
  await battlePage.getByTestId('save-scenario').click();
  await waitForSave(battlePage);

  // The empty scenario is unplayable: Begin refuses with every problem.
  await battlePage.getByTestId('start-battle-editor').click();
  await battlePage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  const setupNameA = await battlePage.getByTestId('setup-side-name-side-a').textContent();
  const setupNameB = await battlePage.getByTestId('setup-side-name-side-b').textContent();
  check(
    'setup shows both side names and colours',
    setupNameA === 'Athenians' && setupNameB === 'Spartans',
    `${setupNameA} | ${setupNameB}`,
  );
  check(
    'setup defaults both controllers to human',
    (await battlePage.getByTestId('controller-side-a').inputValue()) === 'human' &&
      (await battlePage.getByTestId('controller-side-b').inputValue()) === 'human',
  );
  const setupRuleset = await battlePage.getByTestId('setup-ruleset').textContent();
  check(
    'setup shows the ruleset version',
    /polis-classical/.test(setupRuleset ?? ''),
    setupRuleset ?? 'no ruleset',
  );
  check(
    'setup has no seed field',
    (await battlePage.getByTestId('battle-seed').count()) === 0,
  );
  await battlePage.getByTestId('begin-battle').click();
  await battlePage.getByTestId('playability-refusal').waitFor({ timeout: T_SAVE });
  const problems = await battlePage.getByTestId('playability-problem').allTextContents();
  check(
    'unplayable scenario is refused with every problem',
    problems.length === 2 && problems.every((problem) => /fields no units/.test(problem)),
    problems.join(' | '),
  );
  check(
    'refusal offers open in editor',
    await battlePage.getByTestId('open-in-editor').isVisible(),
  );
  await battlePage.getByTestId('setup-back').click();
  await battlePage.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  check(
    'refused begin creates no battle',
    await battlePage.getByTestId('empty-battles').isVisible(),
  );

  // Refusal names each unit and its reason: import an unplayable fixture with
  // two bad units and start the battle from the library row.
  const unplayableTitle = `E2E Unplayable ${Date.now()}`;
  const unplayable = {
    kind: 'scenario',
    formatVersion: 1,
    id: '00000000-0000-4000-8000-000000000083',
    title: unplayableTitle,
    description: '',
    battlefield: { width: 1200, height: 800 },
    sides: [
      { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
      { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
    ],
    ruleset: { id: 'polis-classical', version: '0.1' },
    units: [
      {
        id: '00000000-0000-4000-8000-000000000084',
        name: 'Mystery Unit',
        side: 'side-a',
        troopType: 'mystery-phalanx-xyz',
        soldiers: 100,
        files: 10,
        lateralInterval: 1.8,
        rankDepth: 1.8,
        position: { x: 200, y: 200 },
        facing: 0,
      },
      {
        id: '00000000-0000-4000-8000-000000000085',
        name: 'Wide Unit',
        side: 'side-b',
        troopType: 'hoplite',
        soldiers: 100,
        files: 10,
        // Inside the 10 m application limit, so the import stores it, but
        // past the hoplite permitted range (4 m), so Begin refuses it.
        lateralInterval: 8,
        rankDepth: 1.8,
        position: { x: 1000, y: 600 },
        facing: 180,
      },
    ],
    terrainFeatures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const unplayableFile = path.join(reportDir, 'unplayable.json');
  writeFileSync(unplayableFile, `${JSON.stringify(unplayable, null, 2)}\n`);
  await battlePage.getByTestId('import-file').setInputFiles(unplayableFile);
  await battlePage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await battlePage.getByTestId('back-to-library').click();
  await battlePage.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const unplayableRow = battlePage.getByTestId('scenario-row').filter({ hasText: unplayableTitle });
  await unplayableRow.getByTestId('start-battle').click();
  await battlePage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await battlePage.getByTestId('begin-battle').click();
  await battlePage.getByTestId('playability-refusal').waitFor({ timeout: T_SAVE });
  const unitProblems = await battlePage.getByTestId('playability-problem').allTextContents();
  check(
    'refusal names each unit and its reason',
    unitProblems.length === 2 &&
      unitProblems.some((problem) => /Mystery Unit/.test(problem) && /unknown troop-type/.test(problem)) &&
      unitProblems.some((problem) => /Wide Unit/.test(problem) && /lateralInterval/.test(problem)),
    unitProblems.join(' | '),
  );
  check(
    'library refusal offers open in editor',
    await battlePage.getByTestId('open-in-editor').isVisible(),
  );
  await battlePage.getByTestId('open-in-editor').click();
  await battlePage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  check(
    'open in editor opens the refused scenario',
    (await battlePage.getByTestId('header-title').textContent()) === unplayableTitle,
  );
  await battlePage.getByTestId('back-to-library').click();
  await battlePage.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });

  // Make the scenario playable: one unit per side, then Human vs Passive.
  const playableRow = battlePage.getByTestId('scenario-row').filter({ hasText: editedBattleTitle });
  await playableRow.getByTestId('open-scenario').click();
  await battlePage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await battlePage.getByTestId('oob-tab-0').click();
  // New units start near the battlefield corner, under the map tool rail, so
  // place both probe units in the open field: the collapsed-panel probe below
  // clicks one on the map, and a covered unit would swallow that click.
  async function placeBattleProbeUnit(x, y) {
    await battlePage.getByTestId('unit-position-x').fill(x);
    await battlePage.locator('.map-caption').click();
    await battlePage.getByTestId('unit-position-y').fill(y);
    await battlePage.locator('.map-caption').click();
  }
  await battlePage.getByTestId('oob-add').click();
  await placeBattleProbeUnit('500', '400');
  await battlePage.getByTestId('oob-tab-1').click();
  await battlePage.getByTestId('oob-add').click();
  await placeBattleProbeUnit('700', '400');
  await battlePage.getByTestId('save-scenario').click();
  await waitForSave(battlePage);
  await battlePage.getByTestId('start-battle-editor').click();
  await battlePage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await battlePage.getByTestId('controller-side-b').selectOption('passive');
  await battlePage.getByTestId('begin-battle').click();
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  // Layout A: order of battle, map, inspector, and the bottom turn bar.
  check(
    'battle screen shows the order of battle',
    (await battlePage.getByTestId('battle-oob-side-a').isVisible()) &&
      (await battlePage.getByTestId('battle-oob-side-b').isVisible()),
  );
  // The human side drafts first, so the shared map caption explains drafting
  // (issue #84); it reads "read-only" only when nobody may draft.
  const battleCaption = (await battlePage.getByTestId('battle-map-caption').textContent()) ?? '';
  check(
    'battle screen shows the shared map with its drafting caption',
    (await battlePage.getByTestId('battle-map-caption').isVisible()) &&
      /click a unit, then draft from the inspector/.test(battleCaption),
    battleCaption.replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    'battle screen shows the inspector',
    await battlePage.getByTestId('battle-inspector').isVisible(),
  );
  const roundText = await battlePage.getByTestId('round').textContent();
  ctx.roundText = roundText;
  check(
    'turn bar shows round and round limit',
    /Round 1 \/ \d+ · Turn 1/.test(roundText ?? ''),
    roundText ?? 'no round',
  );
  check(
    'turn bar shows the active side and phase',
    (await battlePage.getByTestId('active-side').isVisible()) &&
      /Phase:/.test((await battlePage.getByTestId('turnbar-phase').textContent()) ?? ''),
  );
  check(
    'battle URL carries the battle id',
    new URL(battlePage.url()).searchParams.has('battle'),
    battlePage.url(),
  );
  const announcement = await battlePage.getByTestId('starting-announcement').textContent();
  check(
    'the starting side is announced',
    /begins — round 1, turn 1/.test(announcement ?? ''),
    announcement ?? 'no announcement',
  );
}
