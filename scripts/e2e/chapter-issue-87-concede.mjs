// issue #87: concede, the outcome screen, and rematch (scripts/e2e.mjs lines 3624-3835).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, T_SAVE, T_LOAD, T_BATTLE } from './helpers.mjs';

export async function runIssue87Concede(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #87: concede, the outcome screen, and rematch. Fresh storage, a
  // fixed setup seed, Human vs Human: the starting side is seed-drawn, so the
  // probe reads the active side instead of assuming it.
  const concedeContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await concedeContext.setDefaultTimeout(T_BATTLE);
  const concedePage = await concedeContext.newPage();
  concedePage.on('console', (message) => log(`concede console: ${message.text()}`));
  concedePage.on('pageerror', (error) => log(`concede pageerror: ${String(error)}`));
  concedePage.on('dialog', async (dialog) => {
    log(`concede dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await concedePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await concedePage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await concedePage.evaluate(() => {
    window.__POLIS_TEST_SEED = 7;
  });

  const concedeTitle = `Concede Probe ${Date.now()}`;
  await concedePage.getByTestId('new-scenario-title').fill(concedeTitle);
  await concedePage.getByTestId('new-scenario-submit').click();
  await concedePage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await concedePage.getByTestId('oob-tab-0').click();
  await concedePage.getByTestId('oob-add').click();
  await concedePage.getByTestId('oob-tab-1').click();
  await concedePage.getByTestId('oob-add').click();
  await concedePage.getByTestId('save-scenario').click();
  await waitForSave(concedePage);
  await concedePage.getByTestId('start-battle-editor').click();
  await concedePage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await concedePage.getByTestId('begin-battle').click();
  await concedePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  // Concede is offered on one's own turn: the first turn needs no handoff and
  // both sides are human, so the button starts enabled.
  check(
    "concede is offered on one's own turn",
    await concedePage.getByTestId('concede').isEnabled(),
  );
  await concedePage.getByTestId('concede').click();
  check(
    'conceding asks for confirmation',
    await concedePage.getByTestId('concede-confirm-box').isVisible(),
  );
  await concedePage.getByTestId('concede-cancel').click();
  check(
    'cancelling keeps the battle ongoing',
    (await concedePage.getByTestId('concede-confirm-box').count()) === 0 &&
      (await concedePage.getByTestId('battle-outcome').count()) === 0,
  );

  // Behind the device handoff it is nobody's turn: concede stays unavailable
  // until the next side begins.
  await concedePage.getByTestId('commit-empty').click();
  await concedePage.getByTestId('commit-confirm').waitFor({ timeout: T_SAVE });
  await concedePage.getByTestId('confirm-commit').click();
  await concedePage.getByTestId('handoff').waitFor({ timeout: T_BATTLE });
  check(
    'concede is unavailable behind the device handoff',
    await concedePage.getByTestId('concede').isDisabled(),
  );
  await concedePage.getByTestId('handoff').click();
  await concedePage.getByTestId('commit-empty').waitFor({ timeout: T_BATTLE });
  check(
    "concede is offered again on the next side's turn",
    await concedePage.getByTestId('concede').isEnabled(),
  );

  const conceder = ((await concedePage.getByTestId('active-side').textContent()) ?? '').trim();
  const concederPattern = conceder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await concedePage.getByTestId('concede').click();
  await concedePage.getByTestId('concede-confirm').click();
  await concedePage.getByTestId('battle-outcome').waitFor({ timeout: T_BATTLE });
  const concededBattleId = new URL(concedePage.url()).searchParams.get('battle');
  const concedeOutcomeTitle = (await concedePage.getByTestId('outcome-title').textContent()) ?? '';
  const concedeOutcomeReason = (await concedePage.getByTestId('outcome-reason').textContent()) ?? '';
  check(
    'concession names the winner',
    /wins/.test(concedeOutcomeTitle),
    concedeOutcomeTitle,
  );
  check(
    'concession names who conceded',
    new RegExp(concederPattern).test(concedeOutcomeReason) &&
      /conceded/i.test(concedeOutcomeReason),
    concedeOutcomeReason.slice(0, 160),
  );
  check(
    "the outcome lists both sides' losses",
    (await concedePage.getByTestId('outcome-losses').locator('li').count()) === 2,
  );
  const concedeLog = (await concedePage.getByTestId('battle-log').textContent()) ?? '';
  check(
    'the battle log records the concession',
    /conceded/i.test(concedeLog),
  );
  check(
    'the finished battle is read-only',
    (await concedePage.getByTestId('commit-empty').count()) === 0 &&
      (await concedePage.getByTestId('continue-turn').count()) === 0 &&
      (await concedePage.getByTestId('concede').count()) === 0 &&
      (await concedePage.getByTestId('rematch').isVisible()) &&
      (await concedePage.getByTestId('back-to-library').isVisible()) &&
      (await concedePage.getByTestId('open-scenario-in-editor').isVisible()),
  );

  // Reloading keeps the outcome; the Battles list keeps the finished battle.
  await concedePage.reload({ waitUntil: 'networkidle' });
  await concedePage.getByTestId('battle-outcome').waitFor({ timeout: T_BATTLE });
  check(
    'reloading keeps the concession outcome',
    ((await concedePage.getByTestId('outcome-title').textContent()) ?? '') === concedeOutcomeTitle,
  );
  await concedePage.getByTestId('back-to-battles').click();
  await concedePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  check(
    'the battles list keeps the finished battle',
    (await concedePage.getByTestId('battle-row').count()) === 1,
  );
  const concedeMeta = (await concedePage.getByTestId('battle-row-meta').textContent()) ?? '';
  check(
    'the finished battle lists as finished and conceded',
    /Finished/.test(concedeMeta) && /conceded/.test(concedeMeta),
    concedeMeta.replace(/\s+/g, ' ').slice(0, 160),
  );
  await concedePage.getByTestId('view-battle').click();
  await concedePage.getByTestId('battle-outcome').waitFor({ timeout: T_BATTLE });
  check(
    'viewing resumes the finished battle read-only',
    (await concedePage.getByTestId('commit-empty').count()) === 0 &&
      (await concedePage.getByTestId('battle-outcome').isVisible()),
  );

  // Rematch starts a new battle from the same snapshot: round 1, turn 1, a new
  // battle id, and the finished battle stays on the list.
  await concedePage.getByTestId('rematch').click();
  await concedePage.getByTestId('starting-announcement').waitFor({ timeout: T_BATTLE });
  const rematchRound = (await concedePage.getByTestId('round').textContent()) ?? '';
  const rematchBattleId = new URL(concedePage.url()).searchParams.get('battle');
  const rematchAnnouncement = (await concedePage.getByTestId('starting-announcement').textContent()) ?? '';
  check(
    'rematch opens round 1, turn 1',
    /Round 1 \/ \d+ · Turn 1/.test(rematchRound),
    rematchRound,
  );
  check(
    'the rematch announces itself',
    /rematch — round 1, turn 1/.test(rematchAnnouncement),
    rematchAnnouncement.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'rematch is a new battle',
    !!rematchBattleId && rematchBattleId !== concededBattleId,
    `${concededBattleId} → ${rematchBattleId}`,
  );
  await concedePage.getByTestId('back-to-battles').click();
  await concedePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  check(
    'rematch keeps the finished battle on the list',
    (await concedePage.getByTestId('battle-row').count()) === 2,
  );
  const finishedRow = concedePage.locator(
    `[data-testid="battle-row"][data-battle-id="${concededBattleId}"]`,
  );
  const finishedMeta = (await finishedRow.getByTestId('battle-row-meta').textContent()) ?? '';
  check(
    'the finished battle stays finished',
    /Finished/.test(finishedMeta) && /conceded/.test(finishedMeta),
    finishedMeta.replace(/\s+/g, ' ').slice(0, 160),
  );
  const liveRow = concedePage.locator(
    `[data-testid="battle-row"][data-battle-id="${rematchBattleId}"]`,
  );
  check(
    'the rematch lists as in progress',
    /In progress/.test((await liveRow.getByTestId('battle-row-meta').textContent()) ?? ''),
  );

  // Open scenario in editor opens the library's current scenario (not the
  // snapshot): the editor shows the probe title and its two units.
  await finishedRow.getByTestId('view-battle').click();
  await concedePage.getByTestId('battle-outcome').waitFor({ timeout: T_BATTLE });
  await concedePage.getByTestId('open-scenario-in-editor').click();
  await concedePage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  check(
    'open scenario in editor opens the current scenario',
    (await concedePage.getByTestId('header-title').textContent()) === concedeTitle &&
      !new URL(concedePage.url()).searchParams.has('battle') &&
      (await concedePage.getByTestId('oob-unit').count()) === 2,
  );
  await concedePage.getByTestId('back-to-library').click();
  await concedePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  await concedePage
    .locator(`[data-testid="battle-row"][data-battle-id="${rematchBattleId}"]`)
    .getByTestId('delete-battle')
    .click();
  await concedePage.waitForFunction(
    () => document.querySelectorAll('[data-testid="battle-row"]').length === 1,
    null,
    { timeout: T_LOAD },
  );
  await concedePage
    .locator(`[data-testid="battle-row"][data-battle-id="${concededBattleId}"]`)
    .getByTestId('delete-battle')
    .click();
  await concedePage.getByTestId('empty-battles').waitFor({ timeout: T_SAVE });
  check('deleting clears both battles', true);

  await concedeContext.close();
}
