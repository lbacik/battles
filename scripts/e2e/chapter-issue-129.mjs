// issue #129: reorder the turn's orders from the unit card.
// Runs in today's order against the shared run context; the steps below are
// the steps this section performs today, unchanged.
import { waitForSave, reachHumanTurn, clickMapAt, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue129(ctx) {
  const { browser, check, log } = ctx;
  // Issue #129: when the turn has several drafted orders, the unit context
  // card footer shows the unit's position in the sequential draft
  // (`Order #k of N`) with `Earlier` and `Later` buttons. Reordering
  // re-validates the whole turn submission, so verdicts in the card and the
  // inspector update and the inspector draft list reflects the new order.
  // Fresh storage, fixed seed.
  const reorderContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await reorderContext.setDefaultTimeout(T_BATTLE);
  const reorderPage = await reorderContext.newPage();
  reorderPage.on('console', (message) => log(`reorder console: ${message.text()}`));
  reorderPage.on('pageerror', (error) => log(`reorder pageerror: ${String(error)}`));
  reorderPage.on('dialog', async (dialog) => {
    log(`reorder dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await reorderPage.goto(`${ctx.base}/`, { waitUntil: 'networkidle' });
  await reorderPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await reorderPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 129129;
  });

  const reorderTitle = `Reorder Probe ${Date.now()}`;
  await reorderPage.getByTestId('new-scenario-title').fill(reorderTitle);
  await reorderPage.getByTestId('new-scenario-submit').click();
  await reorderPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  async function addReorderUnit(sideLabel, x, y, facing) {
    await reorderPage.getByTestId('oob-add').click();
    await reorderPage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await reorderPage.getByTestId('unit-position-x').fill(String(x));
    await reorderPage.locator('.map-caption').click();
    await reorderPage.getByTestId('unit-position-y').fill(String(y));
    await reorderPage.locator('.map-caption').click();
    await reorderPage.getByTestId('unit-facing').fill(String(facing));
    await reorderPage.locator('.map-caption').click();
  }
  await addReorderUnit('Athenians', 500, 600, 180);
  await addReorderUnit('Athenians', 750, 620, 180);
  await addReorderUnit('Spartans', 600, 300, 0);
  check(
    'reordering fields two side-a units and one side-b unit',
    (await reorderPage.getByTestId('oob-unit').count()) === 3,
  );
  await reorderPage.getByTestId('save-scenario').click();
  await waitForSave(reorderPage);
  await reorderPage.getByTestId('start-battle-editor').click();
  await reorderPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await reorderPage.getByTestId('controller-side-b').selectOption('passive');
  await reorderPage.getByTestId('begin-battle').click();
  await reorderPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  await reachHumanTurn(reorderPage);
  await reorderPage.getByTestId('fit-view').click();
  await reorderPage.waitForTimeout(SETTLE_MS);

  const reorderOwn = reorderPage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const reorderId1 = await reorderOwn.nth(0).getAttribute('data-unit-id');
  const reorderId2 = await reorderOwn.nth(1).getAttribute('data-unit-id');

  async function ensureCardExpanded() {
    await reorderPage.getByTestId('unit-context-card').waitFor({ timeout: T_SAVE });
    const soldiersVisible = await reorderPage.getByTestId('unit-card-soldiers').isVisible().catch(() => false);
    if (!soldiersVisible) {
      await reorderPage.getByTestId('unit-card-minimize').click();
      await reorderPage.getByTestId('unit-card-soldiers').waitFor({ timeout: T_SAVE });
    }
  }

  async function ensureCardMinimized() {
    await reorderPage.getByTestId('unit-context-card').waitFor({ timeout: T_SAVE });
    const soldiersVisible = await reorderPage.getByTestId('unit-card-soldiers').isVisible().catch(() => false);
    if (soldiersVisible) {
      await reorderPage.getByTestId('unit-card-minimize').click();
      await reorderPage.waitForFunction(
        () => {
          const el = document.querySelector('[data-testid="unit-card-soldiers"]');
          if (!el) return true;
          return el.offsetParent === null;
        },
        null,
        { timeout: T_SAVE },
      );
    }
  }

  // Draft two accepted Moves from the inspector (minimizing the card so the
  // map clicks land on the map instead of the card).
  await reorderOwn.nth(0).click();
  await ensureCardMinimized();
  await reorderPage.getByTestId(`start-draft-${reorderId1}`).click();
  await clickMapAt(reorderPage, 500, 540);
  await reorderPage.getByTestId(`draft-accepted-${reorderId1}`).waitFor({ timeout: T_SAVE });

  await reorderOwn.nth(1).click();
  await ensureCardMinimized();
  await reorderPage.getByTestId(`start-draft-${reorderId2}`).click();
  await clickMapAt(reorderPage, 750, 560);
  await reorderPage.getByTestId(`draft-accepted-${reorderId2}`).waitFor({ timeout: T_SAVE });

  check(
    'two Moves draft accepted',
    (await reorderPage.getByTestId(`draft-accepted-${reorderId1}`).isVisible()) &&
      (await reorderPage.getByTestId(`draft-accepted-${reorderId2}`).isVisible()),
  );

  // The first unit's card footer shows its position with Earlier disabled at
  // the head of the draft.
  await reorderOwn.nth(0).click();
  await ensureCardExpanded();
  await reorderPage.getByTestId(`unit-card-order-${reorderId1}`).waitFor({ timeout: T_SAVE });
  const orderBefore = (await reorderPage.getByTestId(`unit-card-order-${reorderId1}`).textContent()) ?? '';
  check(
    'the card footer shows Order #1 of 2 for the first draft',
    orderBefore.replace(/\s+/g, ' ').includes('Order #1 of 2'),
    orderBefore.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'Earlier is disabled at the head of the draft',
    await reorderPage.getByTestId(`unit-card-move-earlier-${reorderId1}`).isDisabled(),
  );
  check(
    'Later is enabled at the head of the draft',
    await reorderPage.getByTestId(`unit-card-move-later-${reorderId1}`).isEnabled(),
  );

  const firstRowBefore = await reorderPage.evaluate(() => {
    const first = document.querySelector('[data-testid="draft-list"] .draft-rows > li');
    return first?.getAttribute('data-testid') ?? '';
  });
  check(
    'the inspector lists the first draft first',
    firstRowBefore === `draft-${reorderId1}`,
    firstRowBefore,
  );

  // Reorder from the card: moving the first draft later flips the position
  // and the inspector list, staying accepted after the re-validation.
  await reorderPage.getByTestId(`unit-card-move-later-${reorderId1}`).click();
  await reorderPage.waitForFunction(
    (args) =>
      (document.querySelector(`[data-testid="unit-card-order-${args.unitId}"]`)?.textContent ?? '').includes(
        'Order #2 of 2',
      ),
    { unitId: reorderId1 },
    { timeout: T_SAVE },
  );
  const orderAfter = (await reorderPage.getByTestId(`unit-card-order-${reorderId1}`).textContent()) ?? '';
  check(
    'reordering from the card moves the draft to Order #2 of 2',
    orderAfter.replace(/\s+/g, ' ').includes('Order #2 of 2'),
    orderAfter.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'Earlier is enabled at the tail of the draft',
    await reorderPage.getByTestId(`unit-card-move-earlier-${reorderId1}`).isEnabled(),
  );
  check(
    'Later is disabled at the tail of the draft',
    await reorderPage.getByTestId(`unit-card-move-later-${reorderId1}`).isDisabled(),
  );
  await reorderPage.waitForFunction(
    (args) =>
      document
        .querySelector('[data-testid="draft-list"] .draft-rows > li')
        ?.getAttribute('data-testid') === `draft-${args.otherId}`,
    { otherId: reorderId2 },
    { timeout: T_SAVE },
  );
  const firstRowAfter = await reorderPage.evaluate(() => {
    const first = document.querySelector('[data-testid="draft-list"] .draft-rows > li');
    return first?.getAttribute('data-testid') ?? '';
  });
  check(
    'the inspector list reflects the card reorder',
    firstRowAfter === `draft-${reorderId2}`,
    firstRowAfter,
  );
  check(
    'reordering keeps both orders accepted',
    (await reorderPage.getByTestId(`draft-accepted-${reorderId1}`).isVisible()) &&
      (await reorderPage.getByTestId(`draft-accepted-${reorderId2}`).isVisible()),
  );
  check(
    'the card verdict stays accepted after the reorder',
    await reorderPage.getByTestId(`unit-card-accepted-${reorderId1}`).isVisible(),
  );

  // Moving back earlier from the card restores the original order.
  await reorderPage.getByTestId(`unit-card-move-earlier-${reorderId1}`).click();
  await reorderPage.waitForFunction(
    (args) =>
      (document.querySelector(`[data-testid="unit-card-order-${args.unitId}"]`)?.textContent ?? '').includes(
        'Order #1 of 2',
      ),
    { unitId: reorderId1 },
    { timeout: T_SAVE },
  );
  await reorderPage.waitForFunction(
    (args) =>
      document
        .querySelector('[data-testid="draft-list"] .draft-rows > li')
        ?.getAttribute('data-testid') === `draft-${args.unitId}`,
    { unitId: reorderId1 },
    { timeout: T_SAVE },
  );
  check('moving earlier from the card restores Order #1 of 2', true);

  await reorderContext.close();
}
