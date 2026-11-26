// issue #84: Move drafting (scripts/e2e.mjs lines 2876-3088).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, reachHumanTurn, clickMapAt, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue84(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #84: Move drafting — available actions and allowance come from the
  // engine, an accepted Move shows a ghost preview, a colliding Move is
  // rejected inline with a highlight, reordering revalidates, and committing
  // applies the turn and saves the battle. Fresh storage, fixed seed.
  const moveContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await moveContext.setDefaultTimeout(T_BATTLE);
  const movePage = await moveContext.newPage();
  movePage.on('console', (message) => log(`move console: ${message.text()}`));
  movePage.on('pageerror', (error) => log(`move pageerror: ${String(error)}`));
  movePage.on('dialog', async (dialog) => {
    log(`move dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await movePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await movePage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await movePage.evaluate(() => {
    window.__POLIS_TEST_SEED = 7;
  });

  const moveTitle = `Move Draft Probe ${Date.now()}`;
  await movePage.getByTestId('new-scenario-title').fill(moveTitle);
  await movePage.getByTestId('new-scenario-submit').click();
  await movePage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  // Two side-a units and one side-b unit, placed apart with known facings.
  async function addMoveUnit(sideLabel, x, y, facing) {
    await movePage.getByTestId('oob-add').click();
    await movePage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await movePage.getByTestId('unit-position-x').fill(String(x));
    await movePage.locator('.map-caption').click();
    await movePage.getByTestId('unit-position-y').fill(String(y));
    await movePage.locator('.map-caption').click();
    await movePage.getByTestId('unit-facing').fill(String(facing));
    await movePage.locator('.map-caption').click();
  }
  await addMoveUnit('Athenians', 500, 600, 180);
  await addMoveUnit('Athenians', 750, 620, 180);
  await addMoveUnit('Spartans', 600, 300, 0);
  check(
    'move drafting fields two side-a units and one side-b unit',
    (await movePage.getByTestId('oob-unit').count()) === 3,
  );
  await movePage.getByTestId('save-scenario').click();
  await waitForSave(movePage);
  await movePage.getByTestId('start-battle-editor').click();
  await movePage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await movePage.getByTestId('controller-side-b').selectOption('passive');
  await movePage.getByTestId('begin-battle').click();
  await movePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  // Reach the human turn: the starting side is seed-drawn, so resolve the
  // automated side first when it starts. Every resolution ends behind the
  // device handoff, which is what unlocks drafting. The shared helper waits
  // for a settled state first and never assumes whether the automated side
  // is still waiting or has already resolved (issue #157).
  await reachHumanTurn(movePage);
  check(
    'move drafting starts on the human turn',
    ((await movePage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );

  await movePage.getByTestId('fit-view').click();
  await movePage.waitForTimeout(SETTLE_MS);

  const ownUnits = movePage
    .getByTestId('battle-oob-side-a')
    .getByTestId('battle-oob-unit');
  const id1 = await ownUnits.nth(0).getAttribute('data-unit-id');
  const id2 = await ownUnits.nth(1).getAttribute('data-unit-id');
  await ownUnits.nth(0).click();
  check(
    'inspector shows the engine Move permission and 90 m allowance',
    ((await movePage.getByTestId('battle-unit-permitted').textContent()) ?? '').includes('Move') &&
      (await movePage.getByTestId('battle-unit-allowance').textContent()) === '90 m',
  );
  check(
    'inspector lists the unavailable order reasons from the engine',
    await movePage.getByTestId('battle-unit-unavailable').isVisible(),
  );

  // An accepted Move: 60 m south, inside the 90 m allowance, shows its ghost.
  await movePage.getByTestId(`start-draft-${id1}`).click();
  await movePage.getByTestId(`draft-editor-${id1}`).waitFor({ timeout: T_SAVE });
  await clickMapAt(movePage, 500, 540);
  await movePage.getByTestId(`draft-accepted-${id1}`).waitFor({ timeout: T_SAVE });
  check('an accepted Move shows its detail', true);
  check(
    'an accepted Move shows a ghost footprint',
    (await movePage.getByTestId('draft-ghost').count()) >= 1,
  );

  // A colliding Move: the second unit ends on the first unit's destination,
  // so the engine rejects it and names the conflict.
  await ownUnits.nth(1).click();
  await movePage.getByTestId(`start-draft-${id2}`).click();
  await clickMapAt(movePage, 500, 540);
  await movePage.getByTestId(`draft-rejection-${id2}`).waitFor({ timeout: T_SAVE });
  const rejectionText = await movePage.getByTestId(`draft-rejection-${id2}`).textContent();
  check(
    'a colliding Move is rejected inline',
    /collid/i.test(rejectionText ?? ''),
    (rejectionText ?? '').replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    'commit is disabled while an order is rejected',
    await movePage.getByTestId('commit-draft').isDisabled(),
  );
  check(
    'the rejected Move highlights its conflict',
    (await movePage
      .locator(`[data-testid="map-unit"][data-unit-id="${id1}"]`)
      .getAttribute('data-conflict')) === 'true' &&
      (await movePage.getByTestId('conflict-marker').count()) >= 1,
  );

  // Reordering revalidates: the rejected draft moves first and the collision
  // follows the new order, so the commit stays blocked.
  await movePage.getByTestId(`move-draft-down-${id1}`).click();
  await movePage.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-testid="draft-list"] .draft-rows > li')
        ?.getAttribute('data-testid') === expected,
    `draft-${id2}`,
  );
  check('reordering moves the rejected draft first', true);
  check(
    'reordering keeps the commit blocked',
    await movePage.getByTestId('commit-draft').isDisabled(),
  );

  // Removing the rejected draft enables the commit; committing applies the
  // turn and the round advances.
  await movePage.getByTestId(`remove-draft-${id2}`).click();
  await movePage.waitForFunction(
    () => document.querySelector('[data-testid="commit-draft"]')?.disabled === false,
  );
  check('removing the rejected draft enables the commit', true);
  const moveRoundBefore = await movePage.getByTestId('round').textContent();
  await movePage.getByTestId('commit-draft').click();
  await movePage.getByTestId('turn-result').waitFor({ timeout: T_BATTLE });
  await movePage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    moveRoundBefore,
  );
  const moveRoundAfter = await movePage.getByTestId('round').textContent();
  check(
    'committing applies the turn',
    moveRoundAfter !== moveRoundBefore,
    `${moveRoundBefore} → ${moveRoundAfter}`,
  );

  // The committed turn is saved: reload resumes it, the battles list shows one
  // row, resume restores it, and delete clears the list.
  await movePage.reload({ waitUntil: 'networkidle' });
  await movePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  check(
    'reloading resumes the committed turn',
    (await movePage.getByTestId('round').textContent()) === moveRoundAfter,
  );
  await movePage.getByTestId('back-to-battles').click();
  await movePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  check('the battles list shows the committed battle', (await movePage.getByTestId('battle-row').count()) === 1);
  await movePage.getByTestId('resume-battle').click();
  await movePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  check(
    'resume restores the committed turn',
    (await movePage.getByTestId('round').textContent()) === moveRoundAfter,
  );
  await movePage.getByTestId('back-to-battles').click();
  await movePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  await movePage.getByTestId('delete-battle').click();
  await movePage.getByTestId('empty-battles').waitFor({ timeout: T_SAVE });
  check('deleting clears the committed battle', true);

  await moveContext.close();
}
