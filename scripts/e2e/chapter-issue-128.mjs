// issue #128: draft Reform orders from the unit context card.
// Runs in today's order against the shared run context.
import { waitForSave, reachHumanTurn, waitForInspectorOffer, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue128(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #128: a player reshapes a unit with a Reform order from the unit
  // context card — one-click spacing presets from the troop catalogue, quick
  // file-count steppers, and a live files × ranks readout. The ghost
  // footprint and the engine verdict update after every click; the card and
  // the inspector show the same Reform draft.
  const cardContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await cardContext.setDefaultTimeout(T_BATTLE);
  const cardPage = await cardContext.newPage();
  cardPage.on('console', (message) => log(`card reform console: ${message.text()}`));
  cardPage.on('pageerror', (error) => log(`card reform pageerror: ${String(error)}`));
  cardPage.on('dialog', async (dialog) => {
    log(`card reform dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await cardPage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await cardPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await cardPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 128;
  });

  const cardTitle = `Reform Card Probe ${Date.now()}`;
  await cardPage.getByTestId('new-scenario-title').fill(cardTitle);
  await cardPage.getByTestId('new-scenario-submit').click();
  await cardPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  async function addCardUnit(index, sideLabel, troop, soldiers, files, x, y, facing) {
    await cardPage.getByTestId('oob-add').click();
    await cardPage.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="oob-unit"]').length === expected,
      index + 1,
    );
    await cardPage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await cardPage.getByTestId('unit-troop').selectOption(troop);
    await cardPage.getByTestId('unit-soldiers').fill(String(soldiers));
    await cardPage.locator('.map-caption').click();
    await cardPage.getByTestId('unit-files').fill(String(files));
    await cardPage.locator('.map-caption').click();
    await cardPage.getByTestId('unit-position-x').fill(String(x));
    await cardPage.locator('.map-caption').click();
    await cardPage.getByTestId('unit-position-y').fill(String(y));
    await cardPage.locator('.map-caption').click();
    await cardPage.getByTestId('unit-facing').fill(String(facing));
    await cardPage.locator('.map-caption').click();
  }

  // Central reformer with room to widen under the open preset, a second own
  // unit far away, and one distant enemy so the battle starts.
  await addCardUnit(0, 'Athenians', 'hoplite', 100, 8, 500, 400, 0);
  await addCardUnit(1, 'Athenians', 'hoplite', 100, 10, 900, 400, 180);
  await addCardUnit(2, 'Spartans', 'hoplite', 100, 10, 900, 150, 180);
  check(
    'reform card probe fields three units',
    (await cardPage.getByTestId('oob-unit').count()) === 3,
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
    'reform card probe starts on the human turn',
    ((await cardPage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );
  await cardPage.getByTestId('fit-view').click();
  await cardPage.waitForTimeout(SETTLE_MS);

  const own = cardPage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const reformerId = await own.nth(0).getAttribute('data-unit-id');
  await own.nth(0).click();
  await waitForInspectorOffer(cardPage, reformerId, 'Reform');
  check(
    'unit context card shows for the selected unit',
    await cardPage.getByTestId('unit-context-card').isVisible(),
  );
  check(
    'card offers a Draft Reform start',
    await cardPage.getByTestId(`card-start-reform-${reformerId}`).isVisible(),
  );

  // Draft the Reform from the card (not the inspector).
  await cardPage.getByTestId(`card-start-reform-${reformerId}`).click();
  await cardPage.getByTestId(`card-reform-${reformerId}`).waitFor({ timeout: T_SAVE });
  const cardReadoutBefore = await cardPage.getByTestId(`card-reform-readout-${reformerId}`).textContent();
  const filesBefore = Number((cardReadoutBefore ?? '').split('×')[0].replace(/[^0-9]/g, ''));
  const ranksBefore = Number((cardReadoutBefore ?? '').split('×')[1]?.replace(/[^0-9]/g, ''));
  check(
    'drafting a Reform from the card shows the live files × ranks readout',
    Number.isInteger(filesBefore) && filesBefore >= 1 && Number.isInteger(ranksBefore) && ranksBefore >= 1,
    (cardReadoutBefore ?? '').trim().slice(0, 80),
  );
  await cardPage.getByTestId(`draft-editor-${reformerId}`).waitFor({ timeout: T_SAVE });
  const inspectorReadoutBefore = await cardPage.getByTestId(`reform-readout-${reformerId}`).textContent();
  check(
    'card and inspector show the same Reform draft',
    (inspectorReadoutBefore ?? '').trim() === (cardReadoutBefore ?? '').trim(),
    `card=${(cardReadoutBefore ?? '').trim()} inspector=${(inspectorReadoutBefore ?? '').trim()}`,
  );
  await cardPage.getByTestId(`card-draft-accepted-${reformerId}`).waitFor({ timeout: T_SAVE });
  const verdictBefore = await cardPage.getByTestId(`card-draft-accepted-${reformerId}`).textContent();
  check(
    'card Reform validates with a ghost and an accepted verdict',
    new RegExp(`${filesBefore} files`).test(verdictBefore ?? '') && (await cardPage.getByTestId('draft-ghost').count()) >= 1,
    `${(verdictBefore ?? '').trim().slice(0, 80)} ghosts=${await cardPage.getByTestId('draft-ghost').count()}`,
  );

  // A catalogue preset from the card keeps the Reform accepted.
  await cardPage.getByTestId(`card-apply-preset-${reformerId}-open`).click();
  await cardPage.waitForTimeout(SETTLE_MS);
  check(
    'a catalogue preset from the card keeps the Reform accepted',
    await cardPage.getByTestId(`card-draft-accepted-${reformerId}`).isVisible(),
  );

  // Stepping files from the card updates the readout and the verdict.
  await cardPage.getByTestId(`card-step-files-${reformerId}-plus-2`).click();
  await cardPage.waitForTimeout(SETTLE_MS);
  const cardReadoutAfter = await cardPage.getByTestId(`card-reform-readout-${reformerId}`).textContent();
  const inspectorReadoutAfter = await cardPage.getByTestId(`reform-readout-${reformerId}`).textContent();
  const filesAfter = Number((cardReadoutAfter ?? '').split('×')[0].replace(/[^0-9]/g, ''));
  check(
    'stepping files from the card updates the readout',
    filesAfter === filesBefore + 2,
    `${(cardReadoutBefore ?? '').trim()} → ${(cardReadoutAfter ?? '').trim()}`,
  );
  check(
    'inspector readout follows the card file stepper',
    (inspectorReadoutAfter ?? '').trim() === (cardReadoutAfter ?? '').trim(),
    `card=${(cardReadoutAfter ?? '').trim()} inspector=${(inspectorReadoutAfter ?? '').trim()}`,
  );
  const verdictAfter = await cardPage.getByTestId(`card-draft-accepted-${reformerId}`).textContent();
  check(
    'stepping files from the card updates the verdict',
    new RegExp(`${filesAfter} files`).test(verdictAfter ?? '') && (verdictBefore ?? '').trim() !== (verdictAfter ?? '').trim(),
    `${(verdictBefore ?? '').trim().slice(0, 60)} → ${(verdictAfter ?? '').trim().slice(0, 60)}`,
  );

  // A rejected Reform from the shared draft shows the engine's message on
  // both surfaces.
  await cardPage.getByTestId(`reform-files-${reformerId}`).fill('0');
  await cardPage.getByTestId(`card-draft-rejection-${reformerId}`).waitFor({ timeout: T_SAVE });
  const cardRejection = await cardPage.getByTestId(`card-draft-rejection-${reformerId}`).textContent();
  const inspectorRejection = await cardPage.getByTestId(`draft-rejection-${reformerId}`).textContent();
  check(
    'a rejected Reform shows the engine message on the card',
    /invalid Reform|bad-files/i.test(cardRejection ?? ''),
    (cardRejection ?? '').replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    'card and inspector share the rejected Reform verdict',
    (inspectorRejection ?? '').trim() === (cardRejection ?? '').trim(),
    `card=${(cardRejection ?? '').trim().slice(0, 80)} inspector=${(inspectorRejection ?? '').trim().slice(0, 80)}`,
  );

  await cardContext.close();
}
