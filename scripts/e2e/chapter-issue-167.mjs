// issue #167: turn-bar turn controls while the right panel is collapsed.
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, reachHumanTurn, clickMapAt, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue167(ctx) {
  const { browser, check, log } = ctx;
  // Issue #167: with the right panel collapsed and the battle ongoing, the
  // turn bar shows the current turn-progression control — commit with N
  // orders, commit empty turn (and its confirm/cancel step), handoff, or
  // Continue — through one shared component, so both places show the same
  // state and behave identically. Fresh storage, fixed seed.
  const barContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await barContext.setDefaultTimeout(T_BATTLE);
  const barPage = await barContext.newPage();
  barPage.on('console', (message) => log(`turnbar console: ${message.text()}`));
  barPage.on('pageerror', (error) => log(`turnbar pageerror: ${String(error)}`));
  barPage.on('dialog', async (dialog) => {
    log(`turnbar dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await barPage.goto(`${ctx.base}/`, { waitUntil: 'networkidle' });
  await barPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await barPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 187501;
  });

  const barTitle = `Turnbar Probe ${Date.now()}`;
  await barPage.getByTestId('new-scenario-title').fill(barTitle);
  await barPage.getByTestId('new-scenario-submit').click();
  await barPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  // The probe geometry mirrors the full-orders probe: the charger faces its
  // target across 80 m of open ground, and the two movers start side by side
  // so the second Move onto the first destination collides.
  async function addBarUnit(sideLabel, troop, x, y, facing) {
    await barPage.getByTestId('oob-add').click();
    await barPage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await barPage.getByTestId('unit-troop').selectOption(troop);
    await barPage.getByTestId('unit-position-x').fill(String(x));
    await barPage.locator('.map-caption').click();
    await barPage.getByTestId('unit-position-y').fill(String(y));
    await barPage.locator('.map-caption').click();
    await barPage.getByTestId('unit-facing').fill(String(facing));
    await barPage.locator('.map-caption').click();
  }
  await addBarUnit('Athenians', 'hoplite', 400, 600, 180);
  await addBarUnit('Athenians', 'hoplite', 440, 600, 180);
  await addBarUnit('Athenians', 'hoplite', 600, 600, 0);
  await addBarUnit('Spartans', 'hoplite', 600, 680, 180);
  await addBarUnit('Spartans', 'hoplite', 400, 300, 0);
  check(
    'turn-bar controls field three side-a units and two side-b units',
    (await barPage.getByTestId('oob-unit').count()) === 5,
  );
  await barPage.getByTestId('save-scenario').click();
  await waitForSave(barPage);
  await barPage.getByTestId('start-battle-editor').click();
  await barPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await barPage.getByTestId('controller-side-b').selectOption('passive');
  await barPage.getByTestId('begin-battle').click();
  await barPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  await reachHumanTurn(barPage);
  check(
    'turn-bar controls start on the human turn',
    ((await barPage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );

  await barPage.getByTestId('fit-view').click();
  await barPage.waitForTimeout(SETTLE_MS);

  const barOwn = barPage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const barFoe = barPage.getByTestId('battle-oob-side-b').getByTestId('battle-oob-unit');
  const mover1Id = await barOwn.nth(0).getAttribute('data-unit-id');
  const mover2Id = await barOwn.nth(1).getAttribute('data-unit-id');
  const chargerId = await barOwn.nth(2).getAttribute('data-unit-id');
  const targetId = await barFoe.nth(0).getAttribute('data-unit-id');

  async function barCount(testId) {
    return barPage.getByTestId(testId).count();
  }
  async function barText(testId) {
    return ((await barPage.getByTestId(testId).textContent()) ?? '').replace(/\s+/g, ' ').trim();
  }
  // The hidden inspector mirrors stay mounted while the right panel is
  // collapsed, so their text still reads for the mirror checks below.
  async function settleTurnbar() {
    await barPage.waitForFunction(
      () => {
        if (document.querySelector('[data-testid="battle-outcome"]')) return true;
        if (document.querySelector('[data-testid="turnbar-handoff"]')) return true;
        const cont = document.querySelector('[data-testid="turnbar-continue-turn"]');
        if (cont && !cont.disabled) return true;
        if (document.querySelector('[data-testid="turnbar-commit-empty"]')) return true;
        if (document.querySelector('[data-testid="turnbar-commit-draft"]')) return true;
        return false;
      },
      null,
      { timeout: T_BATTLE },
    );
  }
  async function clickTurnbarHandoff(label) {
    const before = await barText('turnbar-handoff');
    await barPage.getByTestId('turnbar-handoff').click();
    await barPage.waitForFunction(
      (previous) => {
        if (document.querySelector('[data-testid="battle-outcome"]')) return true;
        if (document.querySelector('[data-testid="turnbar-commit-empty"]')) return true;
        if (document.querySelector('[data-testid="turnbar-commit-draft"]')) return true;
        const handoff = document.querySelector('[data-testid="turnbar-handoff"]');
        return !!handoff && handoff.textContent !== previous;
      },
      before,
      { timeout: T_BATTLE },
    );
    check(label, true);
  }
  async function clickTurnbarContinue(label) {
    const before = await barPage.getByTestId('round').textContent();
    await barPage.getByTestId('turnbar-continue-turn').click();
    await barPage.waitForFunction(
      (expected) => {
        if (document.querySelector('[data-testid="battle-outcome"]')) return true;
        if (document.querySelector('[data-testid="turnbar-handoff"]')) return true;
        if (document.querySelector('[data-testid="turnbar-commit-empty"]')) return true;
        if (document.querySelector('[data-testid="turnbar-commit-draft"]')) return true;
        return document.querySelector('[data-testid="round"]')?.textContent !== expected;
      },
      before,
      { timeout: T_BATTLE },
    );
    check(label, true);
  }
  async function advanceToHumanViaTurnbar() {
    for (let step = 0; step < 10; step += 1) {
      await settleTurnbar();
      if ((await barCount('battle-outcome')) > 0) return;
      if ((await barCount('turnbar-commit-empty')) > 0) return;
      if ((await barCount('turnbar-commit-draft')) > 0) return;
      if ((await barCount('turnbar-handoff')) > 0) {
        await clickTurnbarHandoff('the turn bar goes through the device handoff');
        continue;
      }
      if ((await barCount('turnbar-continue-turn')) > 0) {
        const enabled = await barPage
          .getByTestId('turnbar-continue-turn')
          .isEnabled()
          .catch(() => false);
        if (enabled) {
          await clickTurnbarContinue('the turn bar resolves the automated turn');
          continue;
        }
      }
    }
    check('the turn bar reaches the human turn', false, 'no drafting controls appeared');
  }

  // With the right panel expanded the turn bar shows no turn-progression
  // control: the inspector owns it alone, with no duplication.
  check(
    'the expanded turn bar shows no turn-progression control',
    (await barCount('turnbar-turn-controls')) === 0,
  );

  // Collapsing the right panel moves the control into the turn bar.
  await barPage.getByTestId('collapse-right-panel').click();
  await barPage.getByTestId('turnbar-turn-controls').waitFor({ timeout: T_SAVE });
  check('the collapsed turn bar shows the turn-progression control', true);
  check(
    'the collapsed turn bar offers the empty commit',
    await barPage.getByTestId('turnbar-commit-empty').isVisible(),
  );

  // One shared confirmation flow: starting it in the inspector shows it in
  // the turn bar, and cancelling in the inspector ends it in both.
  await barPage.getByTestId('expand-right-panel').click();
  await barPage.getByTestId('commit-empty').click();
  await barPage.getByTestId('collapse-right-panel').click();
  await barPage.getByTestId('turnbar-confirm-commit').waitFor({ timeout: T_SAVE });
  check(
    'starting the empty-turn confirmation in the inspector shows it in the turn bar',
    await barPage.getByTestId('turnbar-cancel-commit').isVisible(),
  );
  check(
    'the inspector confirmation stays mounted behind the collapsed panel',
    (await barCount('commit-confirm')) === 1,
  );
  await barPage.getByTestId('expand-right-panel').click();
  await barPage.getByTestId('cancel-commit').click();
  await barPage.getByTestId('collapse-right-panel').click();
  await barPage.waitForFunction(
    () => !document.querySelector('[data-testid="turnbar-confirm-commit"]'),
    null,
    { timeout: T_SAVE },
  );
  check(
    'cancelling in the inspector ends the confirmation in the turn bar',
    (await barCount('commit-confirm')) === 0,
  );

  // And the other way round: starting it in the turn bar shows it in the
  // inspector, and cancelling in the turn bar ends it in both.
  await barPage.getByTestId('turnbar-commit-empty').click();
  await barPage.getByTestId('turnbar-confirm-commit').waitFor({ timeout: T_SAVE });
  check(
    'starting the empty-turn confirmation in the turn bar shows it in the inspector',
    (await barCount('commit-confirm')) === 1,
  );
  await barPage.getByTestId('turnbar-cancel-commit').click();
  await barPage.waitForFunction(
    () => !document.querySelector('[data-testid="commit-confirm"]'),
    null,
    { timeout: T_SAVE },
  );
  check('cancelling in the turn bar ends the confirmation in the inspector', true);

  // Drafting needs the inspector editors, so expand again: a Move plus a
  // deliberately colliding Move, and the engine rejects the second one.
  await barPage.getByTestId('expand-right-panel').click();
  check(
    'the expanded turn bar hides the turn-progression control again',
    (await barCount('turnbar-turn-controls')) === 0,
  );
  await barOwn.nth(0).click();
  await barPage.getByTestId('unit-card-minimize').click();
  await barPage.getByTestId(`start-draft-${mover1Id}`).waitFor({ timeout: T_SAVE });
  await barPage.getByTestId(`start-draft-${mover1Id}`).click();
  await clickMapAt(barPage, 400, 560);
  await barPage.getByTestId(`draft-accepted-${mover1Id}`).waitFor({ timeout: T_SAVE });
  await barOwn.nth(1).click();
  await barPage.getByTestId('unit-card-minimize').click();
  await barPage.getByTestId(`start-draft-${mover2Id}`).waitFor({ timeout: T_SAVE });
  await barPage.getByTestId(`start-draft-${mover2Id}`).click();
  await clickMapAt(barPage, 400, 560);
  await barPage.getByTestId(`draft-rejection-${mover2Id}`).waitFor({ timeout: T_SAVE });
  check('the colliding Move is rejected inline', true);
  const blockedMessage = await barText('commit-blocked');
  check(
    'the rejected Move blocks the inspector commit',
    await barPage.getByTestId('commit-draft').isDisabled(),
  );

  // Collapsed, the turn bar disables its commit under the same rejection
  // and shows the same blocked message as the inspector.
  await barPage.getByTestId('collapse-right-panel').click();
  await barPage.getByTestId('turnbar-commit-blocked').waitFor({ timeout: T_SAVE });
  check(
    'the turn bar disables its commit under the same engine rejection',
    await barPage.getByTestId('turnbar-commit-draft').isDisabled(),
  );
  check(
    'the turn bar shows the same blocked message as the inspector',
    (await barText('turnbar-commit-blocked')) === blockedMessage,
    await barText('turnbar-commit-blocked'),
  );

  // Removing the rejected draft re-enables the commit in both places.
  await barPage.getByTestId('expand-right-panel').click();
  await barPage.getByTestId(`remove-draft-${mover2Id}`).click();
  await barPage.waitForFunction(
    () => document.querySelector('[data-testid="commit-draft"]')?.disabled === false,
    null,
    { timeout: T_SAVE },
  );
  check('removing the rejected Move re-enables the inspector commit', true);
  await barPage.getByTestId('collapse-right-panel').click();
  await barPage.getByTestId('turnbar-commit-draft').waitFor({ timeout: T_SAVE });
  check(
    'removing the rejected Move re-enables the turn-bar commit',
    !(await barPage.getByTestId('turnbar-commit-draft').isDisabled()),
  );

  // A Charge drafts from the highlighted map target while collapsed, and the
  // turn bar offers the two-order commit with the inspector text.
  await barOwn.nth(2).click();
  await barPage.getByTestId('unit-card-minimize').click();
  check(
    'the Charge candidate highlights on the map',
    (await barPage
      .locator(`[data-testid="map-unit"][data-unit-id="${targetId}"]`)
      .getAttribute('data-candidate-charge')) === 'true',
  );
  await clickMapAt(barPage, 600, 680);
  await barPage.waitForFunction(
    (unitId) => !!document.querySelector(`[data-testid="draft-${unitId}"]`),
    chargerId,
    { timeout: T_SAVE },
  );
  check('clicking the highlighted target on the map drafts the Charge', true);
  check(
    'the turn bar commits two orders with the inspector text',
    (await barText('turnbar-commit-draft')) === (await barText('commit-draft')),
    await barText('turnbar-commit-draft'),
  );
  const draftRoundBefore = await barPage.getByTestId('round').textContent();
  await barPage.getByTestId('turnbar-commit-draft').click();
  await barPage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    draftRoundBefore,
    { timeout: T_BATTLE },
  );
  check(
    'committing from the turn bar advances the turn',
    true,
    `${draftRoundBefore} → ${await barText('round')}`,
  );

  // The automated side resolves through the turn bar, then the handoff does.
  await advanceToHumanViaTurnbar();
  check(
    'the turn bar returns to the human turn',
    (await barCount('turnbar-commit-empty')) > 0,
  );

  // An empty turn commits from the turn bar through its confirm step, and
  // confirming there ends the shared confirmation in the inspector too.
  await barPage.getByTestId('turnbar-commit-empty').click();
  await barPage.getByTestId('turnbar-confirm-commit').waitFor({ timeout: T_SAVE });
  check(
    'the turn-bar empty confirmation mirrors into the inspector',
    (await barCount('commit-confirm')) === 1,
  );
  const emptyRoundBefore = await barPage.getByTestId('round').textContent();
  await barPage.getByTestId('turnbar-confirm-commit').click();
  await barPage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    emptyRoundBefore,
    { timeout: T_BATTLE },
  );
  check(
    'confirming the empty turn from the turn bar advances the turn',
    true,
    `${emptyRoundBefore} → ${await barText('round')}`,
  );
  check(
    'confirming ends the confirmation in the inspector too',
    (await barCount('commit-confirm')) === 0,
  );

  // One more automated turn and handoff through the turn bar, then conceding
  // finishes the battle: a finished battle shows no turn-bar control.
  await advanceToHumanViaTurnbar();
  check(
    'the turn bar reaches the next human turn',
    (await barCount('turnbar-commit-empty')) > 0,
  );
  await barPage.getByTestId('concede').click();
  await barPage.getByTestId('concede-confirm').click();
  // The outcome renders in the inspector, so while the panel stays collapsed
  // it is present but hidden: wait for presence, assert the turn-bar control
  // is gone, then expand to see the outcome itself.
  await barPage.waitForFunction(
    () => !!document.querySelector('[data-testid="battle-outcome"]'),
    null,
    { timeout: T_BATTLE },
  );
  check('conceding finishes the battle', true);
  check(
    'a finished battle shows no turn-progression control in the turn bar',
    (await barCount('turnbar-turn-controls')) === 0,
  );
  await barPage.getByTestId('expand-right-panel').click();
  await barPage.getByTestId('battle-outcome').waitFor({ timeout: T_BATTLE });
  check(
    'the finished battle still shows its outcome in the inspector',
    (await barText('outcome-title')).length > 0,
    await barText('outcome-title'),
  );

  await barContext.close();
}
