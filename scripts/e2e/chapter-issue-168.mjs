// issue #168: opposing-unit card with target-first Charge/Shoot.
// Runs in today's order against the shared run context; fresh storage, fixed seed.
import { waitForSave, reachHumanTurn, clickMapAt, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue168(ctx) {
  const { browser, check, log } = ctx;
  // Issue #168: clicking an enemy that is not a Charge/Shoot candidate of
  // the selected friendly unit (or with nothing friendly selected) selects
  // the enemy and opens the same MapChrome card in an opposing variant;
  // right-clicking any unit selects it without the browser menu; the
  // opposing card lists Charge with / Shoot with hunters from the engine and
  // drafts through the shared controller, then selects the friendly unit.
  const opposingContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await opposingContext.setDefaultTimeout(T_BATTLE);
  const opposingPage = await opposingContext.newPage();
  opposingPage.on('console', (message) => log(`opposing console: ${message.text()}`));
  opposingPage.on('pageerror', (error) => log(`opposing pageerror: ${String(error)}`));
  opposingPage.on('dialog', async (dialog) => {
    log(`opposing dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await opposingPage.goto(`${ctx.base}/`, { waitUntil: 'networkidle' });
  await opposingPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await opposingPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 168168;
  });

  const opposingTitle = `Opposing Probe ${Date.now()}`;
  await opposingPage.getByTestId('new-scenario-title').fill(opposingTitle);
  await opposingPage.getByTestId('new-scenario-submit').click();
  await opposingPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  async function addOpposingUnit(sideLabel, troop, x, y, facing) {
    await opposingPage.getByTestId('oob-add').click();
    await opposingPage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await opposingPage.getByTestId('unit-troop').selectOption(troop);
    await opposingPage.getByTestId('unit-position-x').fill(String(x));
    await opposingPage.locator('.map-caption').click();
    await opposingPage.getByTestId('unit-position-y').fill(String(y));
    await opposingPage.locator('.map-caption').click();
    await opposingPage.getByTestId('unit-facing').fill(String(facing));
    await opposingPage.locator('.map-caption').click();
  }
  // Charger faces its target across 80 m of open ground; the archer stands
  // 50 m east of the charger, still facing north, so both list the target as
  // a Charge candidate while only the archer (missile range) lists it as a
  // Shoot candidate. The isolated Spartan stands far away with no hunters.
  await addOpposingUnit('Athenians', 'hoplite', 600, 600, 0);
  await addOpposingUnit('Athenians', 'archer', 650, 600, 0);
  await addOpposingUnit('Spartans', 'hoplite', 600, 680, 180);
  await addOpposingUnit('Spartans', 'hoplite', 300, 300, 0);
  check(
    'opposing probe fields two side-a units and two side-b units',
    (await opposingPage.getByTestId('oob-unit').count()) === 4,
  );
  await opposingPage.getByTestId('save-scenario').click();
  await waitForSave(opposingPage);
  await opposingPage.getByTestId('start-battle-editor').click();
  await opposingPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await opposingPage.getByTestId('controller-side-b').selectOption('passive');
  await opposingPage.getByTestId('begin-battle').click();
  await opposingPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  await reachHumanTurn(opposingPage);
  check(
    'opposing drafting starts on the human turn',
    ((await opposingPage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );

  await opposingPage.getByTestId('fit-view').click();
  await opposingPage.waitForTimeout(SETTLE_MS);

  const opposingOwn = opposingPage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const opposingFoe = opposingPage.getByTestId('battle-oob-side-b').getByTestId('battle-oob-unit');
  const chargerId = await opposingOwn.nth(0).getAttribute('data-unit-id');
  const archerId = await opposingOwn.nth(1).getAttribute('data-unit-id');
  const targetId = await opposingFoe.nth(0).getAttribute('data-unit-id');
  const isolatedId = await opposingFoe.nth(1).getAttribute('data-unit-id');

  // Clicking the enemy target with nothing friendly selected opens the
  // opposing-unit card with its read-only stats.
  await clickMapAt(opposingPage, 600, 680);
  await opposingPage.getByTestId('unit-context-card').waitFor({ timeout: T_SAVE });
  check(
    'clicking a non-candidate enemy opens exactly one opposing card',
    (await opposingPage.getByTestId('unit-context-card').count()) === 1,
  );
  check(
    'the opposing card shows the enemy read-only stats',
    (await opposingPage.getByTestId('unit-card-troop').isVisible()) &&
      (await opposingPage.getByTestId('unit-card-soldiers').isVisible()) &&
      (await opposingPage.getByTestId('unit-card-formation').isVisible()) &&
      (await opposingPage.getByTestId('unit-card-cohesion').isVisible()),
  );
  check(
    'the opposing card hides the reach allowance',
    (await opposingPage.getByTestId('unit-card-allowance').count()) === 0,
  );
  check(
    'the opposing card has no order-kind buttons',
    (await opposingPage.getByTestId(`unit-card-orders-${targetId}`).count()) === 0,
  );
  check(
    'the opposing card has no Charge section',
    (await opposingPage.getByTestId(`unit-card-charge-section-${targetId}`).count()) === 0,
  );
  check(
    'the opposing card has no Shoot section',
    (await opposingPage.getByTestId(`unit-card-shoot-section-${targetId}`).count()) === 0,
  );
  check(
    'the opposing card has no Reform controls',
    (await opposingPage.getByTestId(`card-reform-${targetId}`).count()) === 0,
  );
  check(
    'the opposing card has no draft footer',
    (await opposingPage.getByTestId(`unit-card-footer-${targetId}`).count()) === 0,
  );
  check(
    'the opposing card lists Charge with the charger',
    await opposingPage.getByTestId(`charge-with-${chargerId}`).isVisible(),
  );
  check(
    'the opposing card lists Charge with the archer',
    await opposingPage.getByTestId(`charge-with-${archerId}`).isVisible(),
  );
  check(
    'the opposing card lists Shoot with the archer',
    await opposingPage.getByTestId(`shoot-with-${archerId}`).isVisible(),
  );
  check(
    'the opposing card lists no Shoot with the hoplite charger',
    (await opposingPage.getByTestId(`shoot-with-${chargerId}`).count()) === 0,
  );

  // The opposing card drags by its header, shows snap-back, stays in view.
  {
    const headerBox = await opposingPage.getByTestId('unit-card-header').boundingBox();
    const startX = (headerBox?.x ?? 0) + (headerBox?.width ?? 0) / 2;
    const startY = (headerBox?.y ?? 0) + (headerBox?.height ?? 0) / 2;
    await opposingPage.mouse.move(startX, startY);
    await opposingPage.mouse.down();
    await opposingPage.mouse.move(startX - 120, startY + 70, { steps: 10 });
    await opposingPage.mouse.up();
    await opposingPage.waitForFunction(
      () => !!document.querySelector('[data-testid="unit-card-snap-back"]'),
      null,
      { timeout: T_SAVE },
    );
    check(
      'the opposing card shows snap-back after a drag',
      (await opposingPage.getByTestId('unit-card-snap-back').count()) === 1,
    );
    const movedBox = await opposingPage.getByTestId('unit-context-card').boundingBox();
    const viewportBox = await opposingPage.getByTestId('map-viewport').boundingBox();
    const inside =
      !!viewportBox &&
      !!movedBox &&
      movedBox.x >= viewportBox.x - 1 &&
      movedBox.y >= viewportBox.y - 1 &&
      movedBox.x + movedBox.width <= viewportBox.x + viewportBox.width + 1 &&
      movedBox.y + movedBox.height <= viewportBox.y + viewportBox.height + 1;
    check(
      'the dragged opposing card stays inside the map viewport',
      inside,
      `card=${JSON.stringify(movedBox)} viewport=${JSON.stringify(viewportBox)}`,
    );
    check(
      'exactly one opposing card stays rendered while dragged',
      (await opposingPage.getByTestId('unit-context-card').count()) === 1,
    );
    await opposingPage.getByTestId('unit-card-snap-back').click();
    await opposingPage.waitForFunction(
      () => !document.querySelector('[data-testid="unit-card-snap-back"]'),
      null,
      { timeout: T_SAVE },
    );
  }

  // Charge with drafts the order for the friendly unit, selects it, and its
  // card shows the draft with the footer verdict; inspector and map agree.
  await opposingPage.getByTestId(`charge-with-${chargerId}`).click();
  await opposingPage.getByTestId(`unit-card-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  check(
    'Charge with drafts the friendly Charge with an acceptance verdict',
    /accepted/i.test(
      ((await opposingPage.getByTestId(`unit-card-accepted-${chargerId}`).textContent()) ?? ''),
    ),
  );
  check(
    'the friendly card shows the drafted Charge after Charge with',
    await opposingPage.getByTestId(`unit-card-orders-${chargerId}`).isVisible(),
  );
  check(
    'the inspector shows the Charge with draft editor after Charge with',
    await opposingPage.getByTestId(`draft-editor-${chargerId}`).isVisible(),
  );
  check(
    'the Charge with draft shows its contact ghost on the map',
    (await opposingPage.getByTestId('draft-ghost').count()) >= 1,
  );
  const cardChargeVerdict = ((await opposingPage.getByTestId(`unit-card-accepted-${chargerId}`).textContent()) ?? '').replace(/\s+/g, ' ');
  const inspectorChargeVerdict = ((await opposingPage.getByTestId(`draft-accepted-${chargerId}`).textContent()) ?? '').replace(/\s+/g, ' ');
  check(
    'the Charge with card verdict matches the inspector verdict',
    cardChargeVerdict === inspectorChargeVerdict && /accepted/i.test(cardChargeVerdict),
    `${cardChargeVerdict.slice(0, 160)} :: ${inspectorChargeVerdict.slice(0, 160)}`,
  );

  // The isolated enemy has no hunters, so its card shows the hint.
  await clickMapAt(opposingPage, 300, 300);
  await opposingPage.getByTestId(`unit-card-opposing-${isolatedId}`).waitFor({ timeout: T_SAVE });
  check(
    'an enemy with no hunters shows the no attack hint',
    /No unit can attack this target\./.test(
      ((await opposingPage.getByTestId(`unit-card-no-attack-${isolatedId}`).textContent()) ?? ''),
    ),
  );
  check(
    'an enemy with no hunters offers no Charge with buttons',
    (await opposingPage.locator('[data-testid^="charge-with-"]').count()) === 0,
  );
  check(
    'an enemy with no hunters offers no Shoot with buttons',
    (await opposingPage.locator('[data-testid^="shoot-with-"]').count()) === 0,
  );

  async function rightClickMapAt(page, atX, atY) {
    const svg = page.getByTestId('battlefield-map');
    const fieldH = Number(await svg.getAttribute('data-height'));
    const { clientX, clientY } = await svg.evaluate(
      (el, [ux, uy]) => {
        const p = el.createSVGPoint();
        p.x = ux;
        p.y = uy;
        const s = p.matrixTransform(el.getScreenCTM());
        return { clientX: s.x, clientY: s.y };
      },
      [atX, fieldH - atY],
    );
    await page.mouse.click(clientX, clientY, { button: 'right' });
  }

  // Right-clicking the friendly charger selects it and opens its normal card.
  await rightClickMapAt(opposingPage, 600, 600);
  await opposingPage.getByTestId(`unit-card-orders-${chargerId}`).waitFor({ timeout: T_SAVE });
  check(
    'right-clicking a friendly unit opens its normal card',
    (await opposingPage.getByTestId('unit-context-card').count()) === 1 &&
      (await opposingPage.getByTestId(`unit-card-orders-${chargerId}`).isVisible()),
  );

  // Right-clicking the enemy target selects it and opens its opposing card
  // without the browser context menu.
  await rightClickMapAt(opposingPage, 600, 680);
  await opposingPage.getByTestId(`unit-card-opposing-${targetId}`).waitFor({ timeout: T_SAVE });
  check(
    'right-clicking an enemy opens its opposing card',
    (await opposingPage.getByTestId('unit-context-card').count()) === 1 &&
      (await opposingPage.getByTestId(`charge-with-${chargerId}`).isVisible()),
  );

  // Clicking a candidate enemy with the friendly charger selected still
  // drafts/retargets as before: the selection stays friendly with a verdict.
  await opposingPage.getByTestId(`charge-with-${chargerId}`).click();
  await opposingPage.getByTestId(`unit-card-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  await clickMapAt(opposingPage, 600, 680);
  await opposingPage.waitForTimeout(SETTLE_MS);
  check(
    'clicking a candidate enemy keeps the friendly selection with its draft',
    (await opposingPage.getByTestId(`unit-card-orders-${chargerId}`).isVisible()) &&
      (await opposingPage.getByTestId(`unit-card-opposing-${targetId}`).count()) === 0,
  );
  check(
    'the retargeted Charge keeps its acceptance verdict',
    (await opposingPage.getByTestId(`unit-card-accepted-${chargerId}`).count()) === 1,
  );

  await opposingContext.close();
}
