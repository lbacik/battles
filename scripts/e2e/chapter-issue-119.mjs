// issue #119: the app renders at any viewport width (scripts/e2e.mjs lines 4484-4692).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, T_SAVE, T_LOAD, T_BATTLE } from './helpers.mjs';

export async function runIssue119(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #119: the app renders at any viewport width. No 1280 px gate, no
  // notice, no breakpoint: the library, the editor, and a battle all render
  // at 1024x768 and at 800x700. The map column keeps a 360 px minimum (tool
  // rail plus display tools stay usable); when the panels plus that minimum
  // do not fit, the page scrolls horizontally. Header and toolbar items wrap
  // instead of overlapping. Geometry is asserted through bounding boxes
  // against the viewport, following the collapsible-panel pattern.
  function rectsOverlap(a, b) {
    if (!a || !b) return false;
    return (
      a.x < b.x + b.width - 1 &&
      b.x < a.x + a.width - 1 &&
      a.y < b.y + b.height - 1 &&
      b.y < a.y + a.height - 1
    );
  }

  async function narrowProbe(viewportWidth, viewportHeight, label) {
    const narrowContext = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
    });
  await narrowContext.setDefaultTimeout(T_BATTLE);
    const narrowPage = await narrowContext.newPage();
    narrowPage.on('console', (message) => log(`narrow ${label} console: ${message.text()}`));
    narrowPage.on('pageerror', (error) => log(`narrow ${label} pageerror: ${String(error)}`));
    narrowPage.on('dialog', async (dialog) => {
      log(`narrow ${label} dialog: ${dialog.type()} ${dialog.message()}`);
      await dialog.accept();
    });
    await narrowPage.goto(`${base}/`, { waitUntil: 'networkidle' });
    await narrowPage.getByTestId('app').waitFor({ timeout: T_LOAD });
    check(
      `narrow ${label}: no narrow-viewport notice exists`,
      (await narrowPage.locator('#narrow-notice').count()) === 0,
    );
    check(
      `narrow ${label}: app container is visible`,
      await narrowPage.getByTestId('app').isVisible(),
    );
    const appBox = await narrowPage.getByTestId('app').boundingBox();
    check(
      `narrow ${label}: library renders`,
      !!appBox && appBox.width > 0 && (await narrowPage.getByTestId('new-scenario-title').isVisible()),
      JSON.stringify(appBox),
    );

    const narrowTitle = `Narrow ${label} ${Date.now()}`;
    await narrowPage.getByTestId('new-scenario-title').fill(narrowTitle);
    await narrowPage.getByTestId('new-scenario-submit').click();
    await narrowPage.getByTestId('editor').waitFor({ timeout: T_LOAD });
    check(
      `narrow ${label}: editor renders`,
      await narrowPage.getByTestId('editor').isVisible(),
    );
    check(
      `narrow ${label}: editor notice is absent`,
      (await narrowPage.locator('#narrow-notice').count()) === 0,
    );

    // The map viewport keeps the usable minimum.
    const narrowMapBox = await narrowPage.getByTestId('map-viewport').boundingBox();
    check(
      `narrow ${label}: map viewport keeps the minimum width`,
      !!narrowMapBox && narrowMapBox.width >= 360,
      JSON.stringify(narrowMapBox),
    );

    // Key editor controls are visible and clickable (scrolled into view first
    // at 800x700, like the acceptance criteria allow).
    for (const testId of ['save-scenario', 'collapse-left-panel', 'collapse-right-panel']) {
      const control = narrowPage.getByTestId(testId);
      await control.scrollIntoViewIfNeeded();
      check(
        `narrow ${label}: ${testId} is visible and clickable`,
        (await control.isVisible()) && (await control.isEnabled()),
      );
    }
    const narrowSaveBox = await narrowPage.getByTestId('save-scenario').boundingBox();
    check(
      `narrow ${label}: Save sits inside the viewport once scrolled into view`,
      !!narrowSaveBox &&
        narrowSaveBox.x >= -1 &&
        narrowSaveBox.x + narrowSaveBox.width <= viewportWidth + 1,
      JSON.stringify(narrowSaveBox),
    );

    // Header and editor toolbar items do not overlap at narrow widths.
    const toolbarIds = [
      'back-to-library',
      'undo',
      'redo',
      'export-open-scenario',
      'start-battle-editor',
      'save-scenario',
    ];
    const toolbarBoxes = [];
    for (const testId of toolbarIds) {
      const control = narrowPage.getByTestId(testId);
      await control.scrollIntoViewIfNeeded();
      toolbarBoxes.push([testId, await control.boundingBox()]);
    }
    // The header brand and title wrap instead of overlapping the toolbar.
    const brandBox = await narrowPage.locator('.brand').boundingBox();
    const headerTitleBox = await narrowPage.getByTestId('header-title').boundingBox();
    const allBoxes = [...toolbarBoxes.map(([, box]) => box), brandBox, headerTitleBox];
    let overlapFound = '';
    for (let i = 0; i < toolbarBoxes.length; i += 1) {
      for (let j = i + 1; j < toolbarBoxes.length; j += 1) {
        if (rectsOverlap(toolbarBoxes[i][1], toolbarBoxes[j][1])) {
          overlapFound = `${toolbarBoxes[i][0]} overlaps ${toolbarBoxes[j][0]}`;
        }
      }
      for (const other of [brandBox, headerTitleBox]) {
        if (rectsOverlap(toolbarBoxes[i][1], other)) {
          overlapFound = `${toolbarBoxes[i][0]} overlaps the header`;
        }
      }
    }
    const boxesVisible = toolbarBoxes.every(([, box]) => !!box && box.width > 0 && box.height > 0);
    check(`narrow ${label}: header and toolbar items do not overlap`, overlapFound === '' && boxesVisible, overlapFound || JSON.stringify(toolbarBoxes.map(([id, box]) => [id, box])));
    void allBoxes;

    // Collapsing a side panel visibly widens the map, as at 1440 px.
    const narrowExpandedBox = await narrowPage.getByTestId('map-viewport').boundingBox();
    await narrowPage.getByTestId('collapse-left-panel').scrollIntoViewIfNeeded();
    await narrowPage.getByTestId('collapse-left-panel').click();
    await narrowPage.waitForFunction(
      () => document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'true',
    );
    const narrowCollapsedBox = await narrowPage.getByTestId('map-viewport').boundingBox();
    check(
      `narrow ${label}: collapsing a panel visibly widens the map`,
      (narrowExpandedBox?.width ?? 0) > 0 &&
        (narrowCollapsedBox?.width ?? 0) > (narrowExpandedBox?.width ?? 0) + 20,
      `${narrowExpandedBox?.width} → ${narrowCollapsedBox?.width}`,
    );
    check(
      `narrow ${label}: collapsed map keeps the minimum width`,
      (narrowCollapsedBox?.width ?? 0) >= 360,
      `${narrowCollapsedBox?.width}`,
    );
    await narrowPage.getByTestId('expand-left-panel').scrollIntoViewIfNeeded();
    await narrowPage.getByTestId('expand-left-panel').click();
    await narrowPage.waitForFunction(
      () => document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'false',
    );

    // Field one unit per side so the scenario can begin a battle.
    await narrowPage.getByTestId('oob-add').scrollIntoViewIfNeeded();
    await narrowPage.getByTestId('oob-add').click();
    await narrowPage.waitForFunction(
      () => document.querySelectorAll('[data-testid="oob-unit"]').length === 1,
    );
    await narrowPage.getByTestId('oob-add').click();
    await narrowPage.waitForFunction(
      () => document.querySelectorAll('[data-testid="oob-unit"]').length === 2,
    );
    await narrowPage.locator('[data-testid="oob-unit"]').nth(1).click();
    await narrowPage.getByTestId('unit-side').selectOption({ index: 1 });
    await narrowPage.getByTestId('save-scenario').scrollIntoViewIfNeeded();
    await narrowPage.getByTestId('save-scenario').click();
    await waitForSave(narrowPage);
    await narrowPage.getByTestId('start-battle-editor').scrollIntoViewIfNeeded();
    check(
      `narrow ${label}: Start battle stays usable`,
      await narrowPage.getByTestId('start-battle-editor').isEnabled(),
    );
    await narrowPage.getByTestId('start-battle-editor').click();
    await narrowPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
    await narrowPage.getByTestId('begin-battle').click();
    await narrowPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
    check(
      `narrow ${label}: battle renders`,
      await narrowPage.getByTestId('battle-screen').isVisible(),
    );
    const battleMapBox = await narrowPage.getByTestId('map-viewport').boundingBox();
    check(
      `narrow ${label}: battle map keeps the minimum width`,
      !!battleMapBox && battleMapBox.width >= 360,
      JSON.stringify(battleMapBox),
    );
    for (const testId of ['round', 'active-side', 'concede', 'collapse-left-panel', 'collapse-right-panel']) {
      const control = narrowPage.getByTestId(testId);
      await control.scrollIntoViewIfNeeded();
      check(
        `narrow ${label}: battle ${testId} is visible`,
        await control.isVisible(),
        testId,
      );
    }
    const battleExpanded = await narrowPage.getByTestId('map-viewport').boundingBox();
    await narrowPage.getByTestId('collapse-right-panel').scrollIntoViewIfNeeded();
    await narrowPage.getByTestId('collapse-right-panel').click();
    await narrowPage.waitForFunction(
      () => document.querySelector('[data-testid="battle-inspector"]')?.getAttribute('data-collapsed') === 'true',
    );
    const battleCollapsed = await narrowPage.getByTestId('map-viewport').boundingBox();
    check(
      `narrow ${label}: collapsing the battle panel visibly widens the map`,
      (battleExpanded?.width ?? 0) > 0 &&
        (battleCollapsed?.width ?? 0) > (battleExpanded?.width ?? 0) + 20,
      `${battleExpanded?.width} → ${battleCollapsed?.width}`,
    );
    await narrowContext.close();
  }

  await narrowProbe(1024, 768, '1024x768');
  await narrowProbe(800, 700, '800x700');
}
