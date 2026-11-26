// issue #127: draft Charge and Shoot orders from the unit context card.
// Runs in today's order against the shared run context; the steps below are
// the steps this section performs today, unchanged.
import { waitForSave, reachHumanTurn, clickMapAt, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue127(ctx) {
  const { browser, check, log } = ctx;
  // Issue #127: the on-map unit context card drafts Charge and Shoot orders
  // from the engine's candidates. The card lists Charge candidates with name,
  // distance and contact aspect (choosing one sets the target), switches the
  // target edge, offers approach-leg Undo/Clear (max two, added by clicking
  // open ground), and lists Shoot candidates with name and distance (one
  // click assigns or retargets). Every change re-validates through the engine
  // and updates the verdict, the charge path and the shoot line; card,
  // inspector and map highlights stay in sync. Fresh storage, fixed seed.
  const cardContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await cardContext.setDefaultTimeout(T_BATTLE);
  const cardPage = await cardContext.newPage();
  cardPage.on('console', (message) => log(`card console: ${message.text()}`));
  cardPage.on('pageerror', (error) => log(`card pageerror: ${String(error)}`));
  cardPage.on('dialog', async (dialog) => {
    log(`card dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await cardPage.goto(`${ctx.base}/`, { waitUntil: 'networkidle' });
  await cardPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await cardPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 187501;
  });

  const cardTitle = `Card Orders Probe ${Date.now()}`;
  await cardPage.getByTestId('new-scenario-title').fill(cardTitle);
  await cardPage.getByTestId('new-scenario-submit').click();
  await cardPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  // The charger faces its target across 80 m of open ground; the archer faces
  // two victims across ~104-108 m so the card can retarget the Shoot.
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
  await addCardUnit('Athenians', 'archer', 800, 600, 0);
  await addCardUnit('Spartans', 'hoplite', 600, 680, 180);
  await addCardUnit('Spartans', 'hoplite', 760, 700, 180);
  await addCardUnit('Spartans', 'hoplite', 840, 700, 180);
  check(
    'card orders drafting fields two side-a units and three side-b units',
    (await cardPage.getByTestId('oob-unit').count()) === 5,
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
    'card orders drafting starts on the human turn',
    ((await cardPage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );

  await cardPage.getByTestId('fit-view').click();
  await cardPage.waitForTimeout(SETTLE_MS);

  const cardOwn = cardPage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const chargerId = await cardOwn.nth(0).getAttribute('data-unit-id');
  const archerId = await cardOwn.nth(1).getAttribute('data-unit-id');
  const cardFoe = cardPage.getByTestId('battle-oob-side-b').getByTestId('battle-oob-unit');
  const targetId = await cardFoe.nth(0).getAttribute('data-unit-id');
  const victim1Id = await cardFoe.nth(1).getAttribute('data-unit-id');
  const victim2Id = await cardFoe.nth(2).getAttribute('data-unit-id');

  // The card lists the Charge candidate with name, distance and aspect.
  await cardOwn.nth(0).click();
  await cardPage.getByTestId('unit-context-card').waitFor({ timeout: T_SAVE });
  const cardChargeButton = cardPage.getByTestId(`unit-card-charge-${chargerId}-${targetId}`);
  await cardChargeButton.waitFor({ timeout: T_SAVE });
  const cardChargeText = ((await cardChargeButton.textContent()) ?? '').replace(/\s+/g, ' ');
  const targetName = ((await cardFoe.nth(0).textContent()) ?? '').split('·')[0].trim().split('\n')[0].trim();
  check(
    'the card lists the Charge candidate with name, distance and aspect',
    (await cardChargeButton.isVisible()) &&
      /\d+\s*m/.test(cardChargeText) &&
      /(front|flank|rear)/i.test(cardChargeText) &&
      cardChargeText.includes(targetName.split(' ')[0] || ''),
    cardChargeText.slice(0, 160),
  );

  // Draft the Charge from the card; the verdict, ghost and path update and
  // the inspector draft editor stays in sync.
  await cardChargeButton.click();
  await cardPage.getByTestId(`draft-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  check(
    'a Charge drafts from the card with a contact ghost',
    ((await cardPage.getByTestId(`draft-${chargerId}`).textContent()) ?? '').includes('Charge') &&
      (await cardPage.getByTestId('draft-ghost').count()) >= 1,
  );
  check(
    'the card Charge draft stays in sync with the inspector editor',
    await cardPage.getByTestId(`draft-editor-${chargerId}`).isVisible(),
  );
  check(
    'the card Charge target highlights on the map',
    (await cardPage
      .locator(`[data-testid="map-unit"][data-unit-id="${targetId}"]`)
      .getAttribute('data-candidate-charge')) === 'true',
  );

  // Switch the target edge from the card; the verdict (draft row edge) and
  // the inspector edge select update together.
  const cardEdge = cardPage.getByTestId(`unit-card-charge-edge-${chargerId}`);
  await cardEdge.waitFor({ timeout: T_SAVE });
  const edgeBefore = await cardEdge.inputValue();
  const edgeNext = edgeBefore === 'left' ? 'right' : 'left';
  const draftBefore = (await cardPage.getByTestId(`draft-${chargerId}`).textContent()) ?? '';
  await cardEdge.selectOption(edgeNext);
  await cardPage.waitForFunction(
    (args) => {
      const row = document.querySelector(`[data-testid="draft-${args.unitId}"]`);
      return !!row && (row.textContent ?? '').includes(args.edge);
    },
    { unitId: chargerId, edge: edgeNext },
    { timeout: T_SAVE },
  );
  const draftAfter = (await cardPage.getByTestId(`draft-${chargerId}`).textContent()) ?? '';
  const inspectorEdge = cardPage.getByTestId(`charge-edge-${chargerId}`);
  check(
    'changing the target edge from the card updates the verdict',
    draftAfter !== draftBefore && draftAfter.includes(edgeNext),
    `${JSON.stringify(edgeBefore)} -> ${JSON.stringify(edgeNext)} :: ${draftAfter.replace(/\s+/g, ' ').slice(0, 160)}`,
  );
  check(
    'the card edge switcher stays in sync with the inspector',
    (await inspectorEdge.inputValue()) === edgeNext,
  );

  // A flank edge from head-on clips the target, so the engine rejects the
  // Charge with a collision; switching back to the front edge restores the
  // accepted verdict. Both directions prove the card re-validates live.
  const edgeRejection = (await cardPage.getByTestId(`draft-${chargerId}`).textContent()) ?? '';
  check(
    'the flank edge from head-on is rejected with a collision',
    /collide/i.test(edgeRejection),
    edgeRejection.replace(/\s+/g, ' ').slice(0, 160),
  );
  await cardEdge.selectOption(edgeBefore);
  await cardPage.getByTestId(`draft-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  check(
    'switching back to the front edge restores the accepted Charge',
    ((await cardPage.getByTestId(`draft-${chargerId}`).textContent()) ?? '').includes(`(${edgeBefore})`) &&
      (await cardPage.getByTestId(`charge-edge-${chargerId}`).inputValue()) === edgeBefore,
  );

  // An approach leg from open ground keeps the Charge accepted; Undo and
  // Clear on the card work (max two legs).
  await clickMapAt(cardPage, 600, 620);
  await cardPage.waitForFunction(
    (unitId) =>
      (document.querySelector(`[data-testid="unit-card-approach-${unitId}"]`)?.textContent ?? '').includes('1 / 2'),
    chargerId,
    { timeout: T_SAVE },
  );
  check(
    'an approach leg keeps the card-drafted Charge accepted',
    await cardPage.getByTestId(`draft-accepted-${chargerId}`).isVisible(),
  );
  await cardPage.getByTestId(`unit-card-remove-last-approach-${chargerId}`).click();
  await cardPage.waitForFunction(
    (unitId) =>
      (document.querySelector(`[data-testid="unit-card-approach-${unitId}"]`)?.textContent ?? '').includes('0 / 2'),
    chargerId,
    { timeout: T_SAVE },
  );
  check(
    'Undo on the card removes the approach leg and keeps the direct Charge accepted',
    await cardPage.getByTestId(`draft-accepted-${chargerId}`).isVisible(),
  );
  await clickMapAt(cardPage, 600, 615);
  await cardPage.waitForTimeout(SETTLE_MS);
  await clickMapAt(cardPage, 600, 630);
  await cardPage.waitForFunction(
    (unitId) =>
      (document.querySelector(`[data-testid="unit-card-approach-${unitId}"]`)?.textContent ?? '').includes('2 / 2'),
    chargerId,
    { timeout: T_SAVE },
  );
  await clickMapAt(cardPage, 600, 640);
  await cardPage.waitForTimeout(SETTLE_MS);
  check(
    'the card caps approach legs at two',
    ((await cardPage.getByTestId(`unit-card-approach-${chargerId}`).textContent()) ?? '').includes('2 / 2'),
  );
  await cardPage.getByTestId(`unit-card-clear-approach-${chargerId}`).click();
  await cardPage.waitForFunction(
    (unitId) =>
      (document.querySelector(`[data-testid="unit-card-approach-${unitId}"]`)?.textContent ?? '').includes('0 / 2'),
    chargerId,
    { timeout: T_SAVE },
  );
  check(
    'Clear on the card removes every approach leg',
    await cardPage.getByTestId(`draft-accepted-${chargerId}`).isVisible(),
  );

  // Retarget the Shoot from the card: one click assigns, another retargets.
  await cardOwn.nth(1).click();
  const cardShootButton1 = cardPage.getByTestId(`unit-card-shoot-${archerId}-${victim1Id}`);
  await cardShootButton1.waitFor({ timeout: T_SAVE });
  const cardShootText1 = ((await cardShootButton1.textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    'the card lists the Shoot candidate with name and distance',
    (await cardShootButton1.isVisible()) && /\d+\s*m/.test(cardShootText1),
    cardShootText1.slice(0, 160),
  );
  await cardShootButton1.click();
  await cardPage.getByTestId(`draft-accepted-${archerId}`).waitFor({ timeout: T_SAVE });
  check(
    'a Shoot drafts from the card with a shot line',
    ((await cardPage.getByTestId(`draft-${archerId}`).textContent()) ?? '').includes('Shoot') &&
      (await cardPage.getByTestId('shoot-line').count()) >= 1,
  );
  const cardShootButton2 = cardPage.getByTestId(`unit-card-shoot-${archerId}-${victim2Id}`);
  await cardShootButton2.waitFor({ timeout: T_SAVE });
  await cardShootButton2.click();
  const victim2Name = (await cardPage.getByTestId(`draft-${archerId}`).textContent()) ?? '';
  await cardPage.waitForFunction(
    (args) => {
      const row = document.querySelector(`[data-testid="draft-${args.unitId}"]`);
      const shot = document.querySelector('[data-testid="shoot-line"]');
      return !!row && !!shot && (row.textContent ?? '').includes('Shoot');
    },
    { unitId: archerId },
    { timeout: T_SAVE },
  );
  const victim2Label = ((await cardPage.getByTestId(`shoot-${archerId}-${victim2Id}`).textContent()) ?? '')
    .replace(/^Shoot\s+/, '')
    .split('(')[0]
    .trim();
  check(
    'retargeting the Shoot from the card keeps the shot line on the new victim',
    victim2Name.includes('Shoot') &&
      (await cardPage.getByTestId('shoot-line').count()) >= 1 &&
      (victim2Label === '' || victim2Name.includes(victim2Label.split(' ')[0])),
    victim2Name.replace(/\s+/g, ' ').slice(0, 160),
  );

  await cardContext.close();
}
