// issue #126: draft Move orders from the unit context card.
// Runs in today's order against the shared run context; the steps below are
// the steps this section performs today, unchanged.
import { waitForSave, reachHumanTurn, clickMapAt, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue126(ctx) {
  const { browser, check, log } = ctx;
  // Issue #126: a player drafts and edits a Move order entirely from the unit
  // context card. After choosing Move, the card shows the leg count (0/3 …
  // 3/3) while up to three leg points land by clicking open ground; quick
  // wheeling buttons and a numeric facing field adjust the facing alongside
  // the map rotation handle; Undo leg and Clear edit the legs. Ghost
  // footprints, leg paths and the engine verdict update live, the card and
  // the inspector show the same draft, and — with the right-hand inspector
  // panel collapsed — a Move drafted from the card commits from the bottom
  // turn bar. Fresh storage, fixed seed.
  const moveCardContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await moveCardContext.setDefaultTimeout(T_BATTLE);
  const moveCardPage = await moveCardContext.newPage();
  moveCardPage.on('console', (message) => log(`move card console: ${message.text()}`));
  moveCardPage.on('pageerror', (error) => log(`move card pageerror: ${String(error)}`));
  moveCardPage.on('dialog', async (dialog) => {
    log(`move card dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await moveCardPage.goto(`${ctx.base}/`, { waitUntil: 'networkidle' });
  await moveCardPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await moveCardPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 126;
  });

  const moveCardTitle = `Move Card Probe ${Date.now()}`;
  await moveCardPage.getByTestId('new-scenario-title').fill(moveCardTitle);
  await moveCardPage.getByTestId('new-scenario-submit').click();
  await moveCardPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  async function addMoveCardUnit(sideLabel, x, y, facing) {
    await moveCardPage.getByTestId('oob-add').click();
    await moveCardPage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await moveCardPage.getByTestId('unit-position-x').fill(String(x));
    await moveCardPage.locator('.map-caption').click();
    await moveCardPage.getByTestId('unit-position-y').fill(String(y));
    await moveCardPage.locator('.map-caption').click();
    await moveCardPage.getByTestId('unit-facing').fill(String(facing));
    await moveCardPage.locator('.map-caption').click();
  }
  await addMoveCardUnit('Athenians', 500, 600, 180);
  await addMoveCardUnit('Athenians', 750, 620, 180);
  await addMoveCardUnit('Spartans', 600, 300, 0);
  check(
    'move card probe fields two side-a units and one side-b unit',
    (await moveCardPage.getByTestId('oob-unit').count()) === 3,
  );
  await moveCardPage.getByTestId('save-scenario').click();
  await waitForSave(moveCardPage);
  await moveCardPage.getByTestId('start-battle-editor').click();
  await moveCardPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await moveCardPage.getByTestId('controller-side-b').selectOption('passive');
  await moveCardPage.getByTestId('begin-battle').click();
  await moveCardPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  await reachHumanTurn(moveCardPage);
  check(
    'move card probe starts on the human turn',
    ((await moveCardPage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );
  await moveCardPage.getByTestId('fit-view').click();
  await moveCardPage.waitForTimeout(SETTLE_MS);

  const moveCardOwn = moveCardPage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const moverId = await moveCardOwn.nth(0).getAttribute('data-unit-id');
  const secondId = await moveCardOwn.nth(1).getAttribute('data-unit-id');

  async function ensureCardExpanded() {
    await moveCardPage.getByTestId('unit-context-card').waitFor({ timeout: T_SAVE });
    const soldiersVisible = await moveCardPage.getByTestId('unit-card-soldiers').isVisible().catch(() => false);
    if (!soldiersVisible) {
      await moveCardPage.getByTestId('unit-card-minimize').click();
      await moveCardPage.getByTestId('unit-card-soldiers').waitFor({ timeout: T_SAVE });
    }
  }

  async function ensureCardMinimized() {
    await moveCardPage.getByTestId('unit-context-card').waitFor({ timeout: T_SAVE });
    const soldiersVisible = await moveCardPage.getByTestId('unit-card-soldiers').isVisible().catch(() => false);
    if (soldiersVisible) {
      await moveCardPage.getByTestId('unit-card-minimize').click();
      await moveCardPage.waitForFunction(
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

  // Choosing Move on the card (not the inspector) opens the card Move draft
  // with an empty leg count and disabled Undo/Clear.
  await moveCardOwn.nth(0).click();
  await moveCardPage.getByTestId(`start-draft-${moverId}`).waitFor({ timeout: T_SAVE });
  check(
    'unit context card shows for the selected unit',
    await moveCardPage.getByTestId('unit-context-card').isVisible(),
  );
  await ensureCardExpanded();
  check(
    'card offers the Move order',
    await moveCardPage.getByTestId(`unit-card-order-move-${moverId}`).isVisible(),
  );
  await moveCardPage.getByTestId(`unit-card-order-move-${moverId}`).click();
  await moveCardPage.getByTestId(`unit-card-move-section-${moverId}`).waitFor({ timeout: T_SAVE });
  const legsBefore = await moveCardPage.getByTestId(`unit-card-move-legs-${moverId}`).textContent();
  check(
    'choosing Move on the card shows the 0/3 leg count',
    (legsBefore ?? '').replace(/\s+/g, ' ').includes('0 / 3'),
    (legsBefore ?? '').replace(/\s+/g, ' ').slice(0, 60),
  );
  check(
    'card Undo leg and Clear start disabled with no legs',
    (await moveCardPage.getByTestId(`unit-card-undo-leg-${moverId}`).isDisabled()) &&
      (await moveCardPage.getByTestId(`unit-card-clear-legs-${moverId}`).isDisabled()),
  );

  // Legs land by clicking open ground (the card is minimized so the clicks
  // reach the map); the counter, the ghost, the leg path and the verdict
  // update live.
  await ensureCardMinimized();
  await clickMapAt(moveCardPage, 500, 540);
  await ensureCardExpanded();
  await moveCardPage.waitForFunction(
    (unitId) => document.querySelector(`[data-testid="unit-card-move-legs-${unitId}"]`)?.textContent?.includes('1 / 3'),
    moverId,
    { timeout: T_SAVE },
  );
  const legsAfter = await moveCardPage.getByTestId(`unit-card-move-legs-${moverId}`).textContent();
  check(
    'an open-ground map click drafts the first leg on the card',
    (legsAfter ?? '').replace(/\s+/g, ' ').includes('1 / 3'),
    (legsAfter ?? '').replace(/\s+/g, ' ').slice(0, 60),
  );
  check(
    'card Undo leg and Clear enable with a leg drafted',
    (await moveCardPage.getByTestId(`unit-card-undo-leg-${moverId}`).isEnabled()) &&
      (await moveCardPage.getByTestId(`unit-card-clear-legs-${moverId}`).isEnabled()),
  );
  await moveCardPage.getByTestId(`unit-card-accepted-${moverId}`).waitFor({ timeout: T_SAVE });
  const cardVerdict = await moveCardPage.getByTestId(`unit-card-accepted-${moverId}`).textContent();
  check(
    'the card-drafted Move validates with a ghost, a leg path and an accepted verdict',
    (await moveCardPage.getByTestId('draft-ghost').count()) >= 1 &&
      (await moveCardPage.getByTestId('draft-path').count()) >= 1 &&
      (cardVerdict ?? '').includes('Accepted'),
    `${(cardVerdict ?? '').trim().slice(0, 80)} ghosts=${await moveCardPage.getByTestId('draft-ghost').count()} paths=${await moveCardPage.getByTestId('draft-path').count()}`,
  );

  // Card and inspector show the same Move draft.
  await moveCardPage.getByTestId(`draft-editor-${moverId}`).waitFor({ timeout: T_SAVE });
  const cardLegs = (await moveCardPage.getByTestId(`unit-card-move-section-${moverId}`).textContent()) ?? '';
  const inspectorLegs = (await moveCardPage.getByTestId(`draft-editor-${moverId}`).textContent()) ?? '';
  const firstLegPoint = (cardLegs.match(/\(\d+\.\d+, \d+\.\d+\)/) ?? [])[0] ?? '';
  check(
    'card and inspector show the same Move draft',
    firstLegPoint !== '' && inspectorLegs.includes(firstLegPoint),
    `leg=${firstLegPoint} inspector=${inspectorLegs.replace(/\s+/g, ' ').slice(0, 120)}`,
  );

  // Wheeling from the card turns the latest leg; the numeric facing fields on
  // the card, in the inspector and behind the rotation handle stay in sync.
  await moveCardPage.getByTestId(`unit-card-wheel-${moverId}-plus-15`).click();
  await moveCardPage.waitForFunction(
    (unitId) => document.querySelector(`[data-testid="unit-card-move-facing-${unitId}"]`)?.value !== '',
    moverId,
    { timeout: T_SAVE },
  );
  const cardFacing = await moveCardPage.getByTestId(`unit-card-move-facing-${moverId}`).inputValue();
  const inspectorFacing = await moveCardPage.getByTestId(`draft-facing-${moverId}`).inputValue();
  check(
    'wheeling from the card turns the facing on the card and in the inspector',
    cardFacing !== '' && cardFacing === inspectorFacing,
    `card=${cardFacing} inspector=${inspectorFacing}`,
  );
  check(
    'the rotation handle stays available on the card-drafted Move',
    (await moveCardPage.getByTestId('rotate-handle').count()) >= 1,
  );
  check(
    'the wheeled Move keeps its ghost and accepted verdict',
    (await moveCardPage.getByTestId('draft-ghost').count()) >= 1 &&
      await moveCardPage.getByTestId(`unit-card-accepted-${moverId}`).isVisible(),
  );

  // The numeric facing field on the card edits the same draft.
  await moveCardPage.getByTestId(`unit-card-move-facing-${moverId}`).fill('180');
  await moveCardPage.waitForFunction(
    (args) => document.querySelector(`[data-testid="draft-facing-${args}"]`)?.value === '180',
    moverId,
    { timeout: T_SAVE },
  );
  const inspectorFacingAfter = await moveCardPage.getByTestId(`draft-facing-${moverId}`).inputValue();
  check(
    'typing a facing on the card updates the inspector facing',
    inspectorFacingAfter === '180',
    `inspector=${inspectorFacingAfter}`,
  );

  // A second leg lands south of the first; Undo leg drops back to one leg and
  // Clear empties the draft and disables both buttons again.
  await ensureCardMinimized();
  await clickMapAt(moveCardPage, 500, 490);
  await ensureCardExpanded();
  await moveCardPage.waitForFunction(
    (unitId) => document.querySelector(`[data-testid="unit-card-move-legs-${unitId}"]`)?.textContent?.includes('2 / 3'),
    moverId,
    { timeout: T_SAVE },
  );
  check(
    'a second open-ground click drafts the second leg on the card',
    ((await moveCardPage.getByTestId(`unit-card-move-legs-${moverId}`).textContent()) ?? '').includes('2 / 3'),
  );
  await moveCardPage.getByTestId(`unit-card-undo-leg-${moverId}`).click();
  await moveCardPage.waitForFunction(
    (unitId) => document.querySelector(`[data-testid="unit-card-move-legs-${unitId}"]`)?.textContent?.includes('1 / 3'),
    moverId,
    { timeout: T_SAVE },
  );
  check(
    'card Undo leg removes the latest leg',
    ((await moveCardPage.getByTestId(`unit-card-move-legs-${moverId}`).textContent()) ?? '').includes('1 / 3'),
  );
  await moveCardPage.getByTestId(`unit-card-clear-legs-${moverId}`).click();
  await moveCardPage.waitForFunction(
    (unitId) => document.querySelector(`[data-testid="unit-card-move-legs-${unitId}"]`)?.textContent?.includes('0 / 3'),
    moverId,
    { timeout: T_SAVE },
  );
  check(
    'card Clear empties the legs and disables Undo and Clear again',
    (await moveCardPage.getByTestId(`unit-card-undo-leg-${moverId}`).isDisabled()) &&
      (await moveCardPage.getByTestId(`unit-card-clear-legs-${moverId}`).isDisabled()),
  );

  // With the right-hand inspector panel collapsed, a Move drafted entirely
  // from the card commits from the bottom turn bar.
  await moveCardOwn.nth(0).click();
  await ensureCardExpanded();
  await moveCardPage.getByTestId(`unit-card-hold-${moverId}`).click();
  await moveCardOwn.nth(1).click();
  await moveCardPage.getByTestId(`start-draft-${secondId}`).waitFor({ timeout: T_SAVE });
  await moveCardPage.getByTestId('collapse-right-panel').click();
  await moveCardPage.getByTestId('expand-right-panel').waitFor({ timeout: T_SAVE });
  check(
    'the inspector collapses while the map card stays usable',
    (await moveCardPage.getByTestId('battle-inspector').getAttribute('data-collapsed')) === 'true' &&
      (await moveCardPage.getByTestId('unit-context-card').isVisible()),
  );
  await ensureCardExpanded();
  await moveCardPage.getByTestId(`unit-card-order-move-${secondId}`).click();
  await moveCardPage.getByTestId(`unit-card-move-section-${secondId}`).waitFor({ timeout: T_SAVE });
  await ensureCardMinimized();
  await clickMapAt(moveCardPage, 750, 560);
  await ensureCardExpanded();
  await moveCardPage.waitForFunction(
    (unitId) => document.querySelector(`[data-testid="unit-card-move-legs-${unitId}"]`)?.textContent?.includes('1 / 3'),
    secondId,
    { timeout: T_SAVE },
  );
  await moveCardPage.getByTestId(`unit-card-accepted-${secondId}`).waitFor({ timeout: T_SAVE });
  const turnbarCommit = moveCardPage.getByTestId('turnbar-commit-draft');
  check(
    'a card-drafted Move with a collapsed inspector offers the turn bar commit',
    await turnbarCommit.isVisible() && await turnbarCommit.isEnabled(),
  );
  const roundBefore = await moveCardPage.getByTestId('round').textContent();
  await turnbarCommit.click();
  await moveCardPage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    roundBefore,
    { timeout: T_BATTLE },
  );
  const roundAfter = await moveCardPage.getByTestId('round').textContent();
  check(
    'committing from the turn bar applies the card-drafted turn',
    roundAfter !== roundBefore,
    `${roundBefore} → ${roundAfter}`,
  );

  await moveCardContext.close();
}
