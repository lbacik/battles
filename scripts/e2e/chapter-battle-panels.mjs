// issues #112, #123 and #130: battle panels, tethered card, card dragging (scripts/e2e.mjs lines 2407-2701).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.

export async function runBattlePanels(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  const battlePage = ctx.battlePage;
  // Issue #112: collapsible side panels on the battle screen — the same
  // mechanism as the scenario editor. Each panel collapses to a strip with an
  // expand control, the map takes the freed width without moving its view,
  // and selecting on the map while collapsed shows on expand.
  check(
    'battle panels start expanded on every visit',
    (await battlePage.getByTestId('collapse-left-panel').count()) === 1 &&
      (await battlePage.getByTestId('collapse-right-panel').count()) === 1 &&
      (await battlePage.getByTestId('expand-left-panel').count()) === 0 &&
      (await battlePage.getByTestId('expand-right-panel').count()) === 0 &&
      (await battlePage.getByTestId('battle-left-panel').getAttribute('data-collapsed')) === 'false' &&
      (await battlePage.getByTestId('battle-inspector').getAttribute('data-collapsed')) === 'false',
  );
  check(
    'battle collapse controls expose aria-expanded and accessible labels',
    (await battlePage.getByTestId('collapse-left-panel').getAttribute('aria-expanded')) === 'true' &&
      ((await battlePage.getByTestId('collapse-left-panel').getAttribute('aria-label')) ?? '').toLowerCase().includes('collapse') &&
      (await battlePage.getByTestId('collapse-right-panel').getAttribute('aria-expanded')) === 'true' &&
      ((await battlePage.getByTestId('collapse-right-panel').getAttribute('aria-label')) ?? '').toLowerCase().includes('collapse'),
  );
  const battleExpandedBox = await battlePage.getByTestId('map-viewport').boundingBox();
  const battleViewBoxBefore = await battlePage.getByTestId('battlefield-map').getAttribute('viewBox');
  const battleZoomBefore = await battlePage.getByTestId('battlefield-map').getAttribute('data-zoom');

  // Left panel: collapse widens the map without moving the view.
  await battlePage.getByTestId('collapse-left-panel').click();
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-left-panel"]')?.getAttribute('data-collapsed') === 'true',
  );
  const battleLeftCollapsedBox = await battlePage.getByTestId('map-viewport').boundingBox();
  check(
    'collapsing the battle left panel visibly widens the map',
    (battleExpandedBox?.width ?? 0) > 0 &&
      (battleLeftCollapsedBox?.width ?? 0) > (battleExpandedBox?.width ?? 0) + 50,
    `${battleExpandedBox?.width} → ${battleLeftCollapsedBox?.width}`,
  );
  check(
    'collapsing the battle left panel keeps the battlefield view',
    (await battlePage.getByTestId('battlefield-map').getAttribute('viewBox')) === battleViewBoxBefore &&
      (await battlePage.getByTestId('battlefield-map').getAttribute('data-zoom')) === battleZoomBefore,
  );
  check(
    'the collapsed battle left panel shows an expand control',
    (await battlePage.getByTestId('expand-left-panel').count()) === 1 &&
      (await battlePage.getByTestId('expand-left-panel').getAttribute('aria-expanded')) === 'false' &&
      ((await battlePage.getByTestId('expand-left-panel').getAttribute('aria-label')) ?? '').toLowerCase().includes('expand'),
  );
  // Keyboard: focus the expand control and press Enter to restore.
  await battlePage.getByTestId('expand-left-panel').focus();
  await battlePage.keyboard.press('Enter');
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-left-panel"]')?.getAttribute('data-collapsed') === 'false',
  );
  const battleLeftRestoredBox = await battlePage.getByTestId('map-viewport').boundingBox();
  check(
    'expanding the battle left panel restores the original layout',
    Math.abs((battleLeftRestoredBox?.width ?? 0) - (battleExpandedBox?.width ?? 0)) < 5,
    `${battleLeftCollapsedBox?.width} → ${battleLeftRestoredBox?.width}`,
  );

  // Right panel: collapse widens the map; selecting on the map while
  // collapsed shows in the inspector once expanded. Issuing orders stays
  // available after expanding. The map selects own units while drafting, so
  // the probe selects the enemy in the order of battle first, then its own
  // unit on the map while collapsed.
  const battleActiveSide = ((await battlePage.getByTestId('turn-side').textContent()) ?? '').trim();
  const battleOwnSideTestId = battleActiveSide.includes('Spartan') ? 'battle-oob-side-b' : 'battle-oob-side-a';
  const battleFoeSideTestId = battleOwnSideTestId === 'battle-oob-side-a' ? 'battle-oob-side-b' : 'battle-oob-side-a';
  await battlePage.getByTestId(battleFoeSideTestId).getByTestId('battle-oob-unit').first().click();
  const battleFirstTitle = await battlePage.getByTestId('battle-unit-title').textContent();
  await battlePage.getByTestId('collapse-right-panel').click();
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-inspector"]')?.getAttribute('data-collapsed') === 'true',
  );
  const battleRightCollapsedBox = await battlePage.getByTestId('map-viewport').boundingBox();
  check(
    'collapsing the battle right panel visibly widens the map',
    (battleRightCollapsedBox?.width ?? 0) > (battleExpandedBox?.width ?? 0) + 50,
    `${battleExpandedBox?.width} → ${battleRightCollapsedBox?.width}`,
  );
  check(
    'collapsing the battle right panel keeps the battlefield view',
    (await battlePage.getByTestId('battlefield-map').getAttribute('viewBox')) === battleViewBoxBefore,
  );
  check(
    'the collapsed battle inspector hides its fields behind the expand control',
    (await battlePage.getByTestId('expand-right-panel').count()) === 1 &&
      !(await battlePage.getByTestId('battle-unit-inspector').isVisible()),
  );
  const battleOwnUnitId = await battlePage.getByTestId(battleOwnSideTestId).getByTestId('battle-oob-unit').first().getAttribute('data-unit-id');
  await battlePage.locator(`[data-testid="map-unit"][data-unit-id="${battleOwnUnitId}"]`).click();
  check(
    'selecting on the battle map works while the inspector is collapsed',
    (await battlePage.getByTestId('expand-right-panel').count()) === 1 &&
      (await battlePage.getByTestId('battle-inspector').getAttribute('data-collapsed')) === 'true',
  );
  await battlePage.getByTestId('expand-right-panel').click();
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-inspector"]')?.getAttribute('data-collapsed') === 'false',
  );
  const battleSecondTitle = await battlePage.getByTestId('battle-unit-title').textContent();
  check(
    'expanding the battle inspector shows the selection made while collapsed',
    !!battleSecondTitle && battleSecondTitle !== battleFirstTitle,
    `${battleFirstTitle} → ${battleSecondTitle}`,
  );
  check(
    'issuing orders stays available after expanding the inspector',
    await battlePage.getByTestId('commit-empty').isVisible(),
  );

  // Issue #123: selecting an active-side unit on the map opens the tethered
  // context card beside it, fully inside the map viewport.
  await battlePage.getByTestId('unit-context-card').waitFor({ state: 'visible', timeout: 10000 });
  check(
    'selecting a unit on the map opens the unit context card',
    await battlePage.getByTestId('unit-context-card').isVisible(),
  );
  check(
    'the unit card shows the tether inside the map viewport',
    await battlePage.getByTestId('unit-card-tether').isVisible(),
  );
  const cardTitle = ((await battlePage.getByTestId('unit-card-name').textContent()) ?? '').trim();
  check(
    'the unit card shows the selected unit',
    cardTitle !== '' && cardTitle === ((await battlePage.getByTestId('battle-unit-title').textContent()) ?? '').trim(),
    `${cardTitle}`,
  );
  check(
    'the unit card shows read-only status',
    (await battlePage.getByTestId('unit-card-soldiers').isVisible()) &&
      (await battlePage.getByTestId('unit-card-formation').isVisible()) &&
      (await battlePage.getByTestId('unit-card-allowance').isVisible()) &&
      (await battlePage.getByTestId('unit-card-cohesion').isVisible()),
  );
  {
    const viewportBox = await battlePage.getByTestId('map-viewport').boundingBox();
    const cardBox = await battlePage.getByTestId('unit-context-card').boundingBox();
    const inside =
      !!viewportBox && !!cardBox &&
      cardBox.x >= viewportBox.x - 1 &&
      cardBox.y >= viewportBox.y - 1 &&
      cardBox.x + cardBox.width <= viewportBox.x + viewportBox.width + 1 &&
      cardBox.y + cardBox.height <= viewportBox.y + viewportBox.height + 1;
    check(
      'the unit card sits fully inside the map viewport',
      inside,
      `card=${JSON.stringify(cardBox)} viewport=${JSON.stringify(viewportBox)}`,
    );
  }
  // Issue #130: dragging the card header moves it without panning the map;
  // the snap-back control restores the automatic tethered position.
  check(
    'the snap-back control is hidden at the automatic position',
    (await battlePage.getByTestId('unit-card-snap-back').count()) === 0,
  );
  {
    const viewBoxBefore = await battlePage.getByTestId('battlefield-map').getAttribute('viewBox');
    const autoBox = await battlePage.getByTestId('unit-context-card').boundingBox();
    const headerBox = await battlePage.getByTestId('unit-card-header').boundingBox();
    const startX = (headerBox?.x ?? 0) + (headerBox?.width ?? 0) / 2;
    const startY = (headerBox?.y ?? 0) + (headerBox?.height ?? 0) / 2;
    await battlePage.mouse.move(startX, startY);
    await battlePage.mouse.down();
    await battlePage.mouse.move(startX - 140, startY + 90, { steps: 12 });
    await battlePage.mouse.up();
    await battlePage.waitForFunction(
      () => !!document.querySelector('[data-testid="unit-card-snap-back"]'),
      null,
      { timeout: 10000 },
    );
    const movedBox = await battlePage.getByTestId('unit-context-card').boundingBox();
    const moved =
      !!autoBox && !!movedBox &&
      Math.hypot(movedBox.x - autoBox.x, movedBox.y - autoBox.y) > 20;
    check(
      'dragging the header moves the card',
      moved,
      `auto=${JSON.stringify(autoBox)} moved=${JSON.stringify(movedBox)}`,
    );
    const viewportBox = await battlePage.getByTestId('map-viewport').boundingBox();
    const inside =
      !!viewportBox && !!movedBox &&
      movedBox.x >= viewportBox.x - 1 &&
      movedBox.y >= viewportBox.y - 1 &&
      movedBox.x + movedBox.width <= viewportBox.x + viewportBox.width + 1 &&
      movedBox.y + movedBox.height <= viewportBox.y + viewportBox.height + 1;
    check(
      'the dragged card stays fully inside the map viewport',
      inside,
      `card=${JSON.stringify(movedBox)} viewport=${JSON.stringify(viewportBox)}`,
    );
    check(
      'the tether follows the dragged card',
      await battlePage.getByTestId('unit-card-tether').isVisible(),
    );
    check(
      'dragging the card never pans the map',
      (await battlePage.getByTestId('battlefield-map').getAttribute('viewBox')) === viewBoxBefore,
      `${viewBoxBefore}`,
    );
    check(
      'dragging the card keeps the same unit selected',
      ((await battlePage.getByTestId('unit-card-name').textContent()) ?? '').trim() === cardTitle,
    );
    await battlePage.getByTestId('unit-card-snap-back').click();
    await battlePage.waitForFunction(
      () => !document.querySelector('[data-testid="unit-card-snap-back"]'),
      null,
      { timeout: 10000 },
    );
    const snappedBox = await battlePage.getByTestId('unit-context-card').boundingBox();
    const snappedBack =
      !!autoBox && !!snappedBox &&
      Math.hypot(snappedBox.x - autoBox.x, snappedBox.y - autoBox.y) < 3;
    check(
      'snap-back returns the card to its automatic position',
      snappedBack,
      `auto=${JSON.stringify(autoBox)} snapped=${JSON.stringify(snappedBox)}`,
    );
    // Leave the card moved: reselecting the unit below must reset it.
    const movedAgainBox = await battlePage.getByTestId('unit-card-header').boundingBox();
    const movedAgainX = (movedAgainBox?.x ?? 0) + (movedAgainBox?.width ?? 0) / 2;
    const movedAgainY = (movedAgainBox?.y ?? 0) + (movedAgainBox?.height ?? 0) / 2;
    await battlePage.mouse.move(movedAgainX, movedAgainY);
    await battlePage.mouse.down();
    await battlePage.mouse.move(movedAgainX - 100, movedAgainY + 60, { steps: 8 });
    await battlePage.mouse.up();
    await battlePage.waitForFunction(
      () => !!document.querySelector('[data-testid="unit-card-snap-back"]'),
      null,
      { timeout: 10000 },
    );
  }
  await battlePage.getByTestId('unit-card-minimize').click();
  check(
    'minimizing the unit card collapses it to its header strip',
    !(await battlePage.getByTestId('unit-card-soldiers').isVisible()) &&
      (await battlePage.getByTestId('unit-context-card').isVisible()),
  );
  await battlePage.getByTestId('unit-card-minimize').click();
  check(
    'expanding the unit card restores its status',
    await battlePage.getByTestId('unit-card-soldiers').isVisible(),
  );
  await battlePage.getByTestId('unit-card-close').click();
  await battlePage.waitForFunction(
    () => !document.querySelector('[data-testid="unit-context-card"]'),
    null,
    { timeout: 10000 },
  );
  check(
    'closing the unit card deselects the unit',
    (await battlePage.getByTestId('unit-context-card').count()) === 0,
  );
  await battlePage.locator(`[data-testid="map-unit"][data-unit-id="${battleOwnUnitId}"]`).click();
  await battlePage.getByTestId('unit-context-card').waitFor({ state: 'visible', timeout: 10000 });
  check(
    'reselecting the unit resets the moved card',
    (await battlePage.getByTestId('unit-card-snap-back').count()) === 0,
  );

  // Both panels collapsed: the map takes both widths, then restores.
  await battlePage.getByTestId('collapse-left-panel').click();
  await battlePage.getByTestId('collapse-right-panel').click();
  await battlePage.waitForFunction(
    () =>
      document.querySelector('[data-testid="battle-left-panel"]')?.getAttribute('data-collapsed') === 'true' &&
      document.querySelector('[data-testid="battle-inspector"]')?.getAttribute('data-collapsed') === 'true',
  );
  const battleBothCollapsedBox = await battlePage.getByTestId('map-viewport').boundingBox();
  check(
    'collapsing both battle panels widens the map further',
    (battleBothCollapsedBox?.width ?? 0) > (battleRightCollapsedBox?.width ?? 0) + 50 &&
      (battleBothCollapsedBox?.width ?? 0) > (battleLeftCollapsedBox?.width ?? 0) + 50,
    `${battleExpandedBox?.width} → ${battleBothCollapsedBox?.width}`,
  );
  check(
    'both battle panels collapsed keep the battlefield view',
    (await battlePage.getByTestId('battlefield-map').getAttribute('viewBox')) === battleViewBoxBefore,
  );
  await battlePage.getByTestId('expand-left-panel').click();
  await battlePage.getByTestId('expand-right-panel').click();
  await battlePage.waitForFunction(
    () =>
      document.querySelector('[data-testid="battle-left-panel"]')?.getAttribute('data-collapsed') === 'false' &&
      document.querySelector('[data-testid="battle-inspector"]')?.getAttribute('data-collapsed') === 'false',
  );
  const battleBothRestoredBox = await battlePage.getByTestId('map-viewport').boundingBox();
  check(
    'expanding both battle panels restores the original layout',
    Math.abs((battleBothRestoredBox?.width ?? 0) - (battleExpandedBox?.width ?? 0)) < 5,
    `${battleBothCollapsedBox?.width} → ${battleBothRestoredBox?.width}`,
  );
}
