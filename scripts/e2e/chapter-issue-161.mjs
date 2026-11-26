// issue #161: order actions, verdict and Hold inside the existing unit context card.
// Runs in today's order against the shared run context; the steps below are
// the steps this section performs today, unchanged.
import { waitForSave, reachHumanTurn, waitForInspectorOffer, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue161(ctx) {
  const { browser, check, log } = ctx;
  // Issue #161: the on-map unit context card is the place for orders. The
  // card already exists in MapChrome; this chapter proves the order actions
  // were built inside it: six kind buttons enabled only from the engine's
  // availableActions with the engine's reason on the gated kinds, a
  // no-reachable-target hint for a permitted kind with no candidates, a
  // one-click Withdraw from the card with its ghost and verdict, Hold
  // clearing the draft, card/inspector sync, and exactly one card. Fresh
  // storage, fixed seed.
  const cardContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await cardContext.setDefaultTimeout(T_BATTLE);
  const cardPage = await cardContext.newPage();
  cardPage.on('console', (message) => log(`card161 console: ${message.text()}`));
  cardPage.on('pageerror', (error) => log(`card161 pageerror: ${String(error)}`));
  cardPage.on('dialog', async (dialog) => {
    log(`card161 dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await cardPage.goto(`${ctx.base}/`, { waitUntil: 'networkidle' });
  await cardPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await cardPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 187501;
  });

  const cardTitle = `Card Orders Probe 161 ${Date.now()}`;
  await cardPage.getByTestId('new-scenario-title').fill(cardTitle);
  await cardPage.getByTestId('new-scenario-submit').click();
  await cardPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  // The charger faces its target across 80 m of open ground; the isolated
  // hoplite stands far away facing off so the engine names no Charge
  // candidate in its forward arc.
  async function addCardUnit(sideLabel, troop, x, y, facing) {
    await cardPage.getByTestId('oob-add').click();
    await cardPage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await cardPage.getByTestId('unit-troop').selectOption(troop);
    await cardPage.getByTestId('unit-position-x').fill(String(x));
    await cardPage.locator('.map-caption').click();
    await cardPage.getByTestId('unit-position-y').fill(String(y));
    await cardPage.locator('.map-caption').click();
    await cardPage.getByTestId('unit-facing').fill(String(facing));
    await cardPage.locator('.map-caption').click();
  }
  await addCardUnit('Athenians', 'hoplite', 600, 600, 0);
  await addCardUnit('Athenians', 'hoplite', 400, 300, 180);
  await addCardUnit('Spartans', 'hoplite', 600, 680, 180);
  await addCardUnit('Spartans', 'hoplite', 1000, 300, 0);
  check(
    'card order actions field two side-a units and two side-b units',
    (await cardPage.getByTestId('oob-unit').count()) === 4,
  );
  await cardPage.getByTestId('save-scenario').click();
  await waitForSave(cardPage);
  await cardPage.getByTestId('start-battle-editor').click();
  await cardPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await cardPage.getByTestId('controller-side-b').selectOption('passive');
  await cardPage.getByTestId('begin-battle').click();
  await cardPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  await reachHumanTurn(cardPage);
  check(
    'card order actions start on the human turn',
    ((await cardPage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );

  await cardPage.getByTestId('fit-view').click();
  await cardPage.waitForTimeout(SETTLE_MS);

  const cardOwn = cardPage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const chargerId = await cardOwn.nth(0).getAttribute('data-unit-id');
  const isolatedId = await cardOwn.nth(1).getAttribute('data-unit-id');

  // Selecting the charger opens exactly one MapChrome card with six order
  // buttons; the Steady unit's Rally is gated with the engine's reason.
  await cardOwn.nth(0).click();
  await cardPage.getByTestId('unit-context-card').waitFor({ timeout: T_SAVE });
  check(
    'exactly one unit context card is rendered while a unit is selected',
    (await cardPage.getByTestId('unit-context-card').count()) === 1,
  );
  for (const kind of ['move', 'charge', 'shoot', 'reform', 'withdraw', 'rally']) {
    check(
      `the card offers a ${kind} order button`,
      await cardPage.getByTestId(`unit-card-order-${kind}-${chargerId}`).isVisible(),
    );
  }
  const rallyReason = ((await cardPage.getByTestId(`unit-card-order-reason-rally-${chargerId}`).textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    'a gated kind shows the engine reason on the card',
    (await cardPage.getByTestId(`unit-card-order-rally-${chargerId}`).isDisabled()) &&
      /no need to rally/i.test(rallyReason),
    rallyReason.slice(0, 160),
  );

  // The isolated hoplite is permitted to charge in principle but names no
  // candidate, so the card disables Charge with a no-reachable-target hint.
  await cardOwn.nth(1).click();
  await cardPage.getByTestId(`unit-card-orders-${isolatedId}`).waitFor({ timeout: T_SAVE });
  check(
    'exactly one unit context card is rendered after reselecting',
    (await cardPage.getByTestId('unit-context-card').count()) === 1,
  );
  const noTargetHint = ((await cardPage.getByTestId(`unit-card-no-target-charge-${isolatedId}`).textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    'a permitted kind with no candidates shows a no reachable target hint',
    (await cardPage.getByTestId(`unit-card-order-charge-${isolatedId}`).isDisabled()) &&
      /no reachable target/i.test(noTargetHint),
    noTargetHint.slice(0, 160),
  );

  // Drafting the Charge from the card's kind button validates live: the card
  // shows the acceptance verdict while the inspector edits the same draft.
  await cardOwn.nth(0).click();
  await cardPage.getByTestId(`unit-card-order-charge-${chargerId}`).waitFor({ timeout: T_SAVE });
  await cardPage.getByTestId(`unit-card-order-charge-${chargerId}`).click();
  await cardPage.getByTestId(`unit-card-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  const cardChargeVerdict = ((await cardPage.getByTestId(`unit-card-accepted-${chargerId}`).textContent()) ?? '').replace(/\s+/g, ' ');
  const inspectorChargeVerdict = ((await cardPage.getByTestId(`draft-accepted-${chargerId}`).textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    'a Charge drafts from the card kind button with an acceptance verdict',
    /accepted/i.test(cardChargeVerdict) && cardChargeVerdict === inspectorChargeVerdict,
    cardChargeVerdict.slice(0, 160),
  );
  check(
    'the card Charge draft stays in sync with the inspector editor',
    await cardPage.getByTestId(`draft-editor-${chargerId}`).isVisible(),
  );
  check(
    'the card-drafted Charge shows its contact ghost on the map',
    (await cardPage.getByTestId('draft-ghost').count()) >= 1,
  );

  // Committing the card-drafted Charge engages the charger; the next human
  // turn offers Withdraw, which drafts from the card in one click with its
  // step-back ghost and verdict.
  const chargeRoundBefore = await cardPage.getByTestId('round').textContent();
  await cardPage.getByTestId('commit-draft').click();
  await cardPage.getByTestId('turn-result').waitFor({ timeout: T_BATTLE });
  await cardPage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    chargeRoundBefore,
    { timeout: T_BATTLE },
  );
  await reachHumanTurn(cardPage);
  await cardOwn.nth(0).click();
  await waitForInspectorOffer(cardPage, chargerId, 'Withdraw');
  check(
    'the engaged charger offers Withdraw after the committed Charge',
    await cardPage.getByTestId(`unit-card-order-withdraw-${chargerId}`).isVisible(),
  );
  await cardPage.getByTestId(`unit-card-order-withdraw-${chargerId}`).click();
  await cardPage.getByTestId(`unit-card-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  const cardWithdrawVerdict = ((await cardPage.getByTestId(`unit-card-accepted-${chargerId}`).textContent()) ?? '').replace(/\s+/g, ' ');
  const inspectorWithdrawVerdict = ((await cardPage.getByTestId(`draft-accepted-${chargerId}`).textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    'a Withdraw drafts from the card in one click with its verdict',
    /accepted/i.test(cardWithdrawVerdict) && cardWithdrawVerdict === inspectorWithdrawVerdict,
    cardWithdrawVerdict.slice(0, 160),
  );
  check(
    'the card Withdraw draft shows its step-back ghost on the map',
    (await cardPage.getByTestId('draft-ghost').count()) >= 1,
  );
  check(
    'the card Withdraw draft stays in sync with the inspector editor',
    await cardPage.getByTestId(`draft-editor-${chargerId}`).isVisible(),
  );

  // Hold on the card clears the draft everywhere: the card verdict and the
  // inspector draft row disappear together.
  await cardPage.getByTestId(`unit-card-hold-${chargerId}`).click();
  await cardPage.waitForFunction(
    (unitId) => !document.querySelector(`[data-testid="draft-${unitId}"]`),
    chargerId,
    { timeout: T_SAVE },
  );
  check(
    'Hold on the card clears the draft from the inspector',
    (await cardPage.getByTestId(`draft-${chargerId}`).count()) === 0,
  );
  check(
    'Hold on the card clears the card verdict',
    (await cardPage.getByTestId(`unit-card-accepted-${chargerId}`).count()) === 0 &&
      (await cardPage.getByTestId(`unit-card-hold-${chargerId}`).count()) === 0,
  );

  await cardContext.close();
}
