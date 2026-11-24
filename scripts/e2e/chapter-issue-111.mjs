// issue #111: collapsible side panels in the editor (scripts/e2e.mjs lines 1407-1538).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.

export async function runIssue111(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #111: collapsible side panels — each panel collapses to a strip
  // with an expand control, the map takes the freed width without moving its
  // view, and selecting on the map while collapsed shows on expand.
  check(
    'panels start expanded on every visit',
    (await page.getByTestId('collapse-left-panel').count()) === 1 &&
      (await page.getByTestId('collapse-right-panel').count()) === 1 &&
      (await page.getByTestId('expand-left-panel').count()) === 0 &&
      (await page.getByTestId('expand-right-panel').count()) === 0 &&
      (await page.getByTestId('editor-left-panel').getAttribute('data-collapsed')) === 'false' &&
      (await page.getByTestId('inspector').getAttribute('data-collapsed')) === 'false',
  );
  check(
    'collapse controls expose aria-expanded and accessible labels',
    (await page.getByTestId('collapse-left-panel').getAttribute('aria-expanded')) === 'true' &&
      ((await page.getByTestId('collapse-left-panel').getAttribute('aria-label')) ?? '').toLowerCase().includes('collapse') &&
      (await page.getByTestId('collapse-right-panel').getAttribute('aria-expanded')) === 'true' &&
      ((await page.getByTestId('collapse-right-panel').getAttribute('aria-label')) ?? '').toLowerCase().includes('collapse'),
  );
  const panelsExpandedBox = await page.getByTestId('map-viewport').boundingBox();
  const panelsViewBoxBefore = await page.getByTestId('battlefield-map').getAttribute('viewBox');
  const panelsZoomBefore = await page.getByTestId('battlefield-map').getAttribute('data-zoom');

  // Left panel: collapse widens the map without moving the view.
  await page.getByTestId('collapse-left-panel').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'true',
  );
  const leftCollapsedBox = await page.getByTestId('map-viewport').boundingBox();
  check(
    'collapsing the left panel visibly widens the map',
    (panelsExpandedBox?.width ?? 0) > 0 &&
      (leftCollapsedBox?.width ?? 0) > (panelsExpandedBox?.width ?? 0) + 50,
    `${panelsExpandedBox?.width} → ${leftCollapsedBox?.width}`,
  );
  check(
    'collapsing the left panel keeps the battlefield view',
    (await page.getByTestId('battlefield-map').getAttribute('viewBox')) === panelsViewBoxBefore &&
      (await page.getByTestId('battlefield-map').getAttribute('data-zoom')) === panelsZoomBefore,
  );
  check(
    'the collapsed left panel shows an expand control',
    (await page.getByTestId('expand-left-panel').count()) === 1 &&
      (await page.getByTestId('expand-left-panel').getAttribute('aria-expanded')) === 'false' &&
      ((await page.getByTestId('expand-left-panel').getAttribute('aria-label')) ?? '').toLowerCase().includes('expand'),
  );
  // Keyboard: focus the expand control and press Enter to restore.
  await page.getByTestId('expand-left-panel').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'false',
  );
  const leftRestoredBox = await page.getByTestId('map-viewport').boundingBox();
  check(
    'expanding the left panel restores the original layout',
    Math.abs((leftRestoredBox?.width ?? 0) - (panelsExpandedBox?.width ?? 0)) < 5,
    `${leftCollapsedBox?.width} → ${leftRestoredBox?.width}`,
  );

  // Right panel: collapse widens the map; selecting on the map while
  // collapsed shows in the inspector once expanded.
  await page.getByTestId('collapse-right-panel').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="inspector"]')?.getAttribute('data-collapsed') === 'true',
  );
  const rightCollapsedBox = await page.getByTestId('map-viewport').boundingBox();
  check(
    'collapsing the right panel visibly widens the map',
    (rightCollapsedBox?.width ?? 0) > (panelsExpandedBox?.width ?? 0) + 50,
    `${panelsExpandedBox?.width} → ${rightCollapsedBox?.width}`,
  );
  check(
    'collapsing the right panel keeps the battlefield view',
    (await page.getByTestId('battlefield-map').getAttribute('viewBox')) === panelsViewBoxBefore,
  );
  check(
    'the collapsed inspector hides its fields behind the expand control',
    (await page.getByTestId('expand-right-panel').count()) === 1 &&
      !(await page.getByTestId('unit-position-x').isVisible()),
  );
  const cavalryUnitId = await page
    .locator('[data-testid="oob-unit"]', { hasText: 'Athenian cavalry' })
    .getAttribute('data-unit-id');
  await page.locator(`[data-testid="map-unit"][data-unit-id="${cavalryUnitId}"]`).click();
  check(
    'selecting on the map works while the inspector is collapsed',
    (await page.getByTestId('expand-right-panel').count()) === 1 &&
      (await page.getByTestId('inspector').getAttribute('data-collapsed')) === 'true',
  );
  await page.getByTestId('expand-right-panel').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="inspector"]')?.getAttribute('data-collapsed') === 'false',
  );
  check(
    'expanding the inspector shows the selection made while collapsed',
    (await page.getByTestId('unit-title').textContent()) === 'Athenian cavalry',
    (await page.getByTestId('unit-title').textContent()) ?? 'no selection',
  );

  // Both panels collapsed: the map takes both widths, then restores.
  await page.getByTestId('collapse-left-panel').click();
  await page.getByTestId('collapse-right-panel').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'true' &&
      document.querySelector('[data-testid="inspector"]')?.getAttribute('data-collapsed') === 'true',
  );
  const bothCollapsedBox = await page.getByTestId('map-viewport').boundingBox();
  check(
    'collapsing both panels widens the map further',
    (bothCollapsedBox?.width ?? 0) > (rightCollapsedBox?.width ?? 0) + 50 &&
      (bothCollapsedBox?.width ?? 0) > (leftCollapsedBox?.width ?? 0) + 50,
    `${panelsExpandedBox?.width} → ${bothCollapsedBox?.width}`,
  );
  check(
    'both panels collapsed keep the battlefield view',
    (await page.getByTestId('battlefield-map').getAttribute('viewBox')) === panelsViewBoxBefore,
  );
  await page.getByTestId('expand-left-panel').click();
  await page.getByTestId('expand-right-panel').click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'false' &&
      document.querySelector('[data-testid="inspector"]')?.getAttribute('data-collapsed') === 'false',
  );
  const bothRestoredBox = await page.getByTestId('map-viewport').boundingBox();
  check(
    'expanding both panels restores the original layout',
    Math.abs((bothRestoredBox?.width ?? 0) - (panelsExpandedBox?.width ?? 0)) < 5,
    `${bothCollapsedBox?.width} → ${bothRestoredBox?.width}`,
  );
}
