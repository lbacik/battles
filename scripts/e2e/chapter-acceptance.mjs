// create, empty battlefield, save, reload, and reopen (scripts/e2e.mjs lines 220-518).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, T_SAVE, T_LOAD, SETTLE_MS } from './helpers.mjs';

export async function runAcceptance(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // The ten-step editor acceptance scenario (#4) plus persistence steps
  // 1-6 and 8 (#5) run as one coherent story against this scenario, in
  // acceptance order, so the saved, reopened, duplicated, exported, and
  // imported document is the one built in steps 1-8.
  const title = 'Acceptance plain';
  ctx.title = title;

  await page.goto(`${base}/`, { waitUntil: 'networkidle' });
  check('library screen loads', await page.getByTestId('app').isVisible());

  // Creating requires a title: the submit stays disabled while blank.
  check(
    'New scenario requires a title',
    await page.getByTestId('new-scenario-submit').isDisabled(),
  );
  await page.getByTestId('new-scenario-title').fill(title);
  await page.getByTestId('new-scenario-submit').click();

  // The editor opens on an empty battlefield.
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  check('creating a scenario opens the editor', true);
  const headerTitle = await page.getByTestId('header-title').textContent();
  check('header shows the scenario title', headerTitle === title, `header=${headerTitle}`);
  const dims = await page.getByTestId('battlefield-dims').textContent();
  check('battlefield shows the default size', dims?.includes('1200 × 800') ?? false, dims ?? '');
  const mapBox = await page.getByTestId('battlefield-map').boundingBox();
  const mapScale = mapBox && mapBox.width > 0 && mapBox.height > 0;
  check('battlefield map is drawn to scale', !!mapScale, JSON.stringify(mapBox));
  const mapWidth = await page.getByTestId('battlefield-map').getAttribute('data-width');
  const mapHeight = await page.getByTestId('battlefield-map').getAttribute('data-height');
  check(
    'battlefield map uses the default true-scale dimensions',
    mapWidth === '1200' && mapHeight === '800',
    `data-width=${mapWidth} data-height=${mapHeight}`,
  );

  // Acceptance step 1: a description and a 1400 x 900 m battlefield. The map
  // navigation checks below run against the resized battlefield.
  await page.getByTestId('inspector-description').fill('Editor acceptance probe: steps 1-10.');
  await page.locator('.map-caption').click();
  await page.getByTestId('inspector-width').fill('1400');
  await page.locator('.map-caption').click();
  await page.getByTestId('inspector-height').fill('900');
  await page.locator('.map-caption').click();
  check(
    'acceptance step 1 keeps the description',
    (await page.getByTestId('inspector-description').inputValue()) ===
      'Editor acceptance probe: steps 1-10.',
  );
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  const resizedDims = await page.getByTestId('battlefield-dims').textContent();
  check(
    'acceptance step 1 sets the battlefield to 1400 x 900 m',
    resizedDims?.includes('1400 × 900') ?? false,
    resizedDims ?? '',
  );

  // Map navigation (issue #75): zoom, pan, fit, and the coordinate readout.
  const fittedViewBox = await page.getByTestId('battlefield-map').getAttribute('viewBox');
  ctx.fittedViewBox = fittedViewBox;
  check('map starts fitted to the battlefield', !!fittedViewBox, fittedViewBox ?? '');
  check(
    'select is the default map tool',
    (await page.getByTestId('map-tool-select').getAttribute('aria-pressed')) === 'true',
  );
  const zoomBefore = await page.getByTestId('map-zoom-level').textContent();
  check('map zoom starts at 100%', zoomBefore === '100%', `zoom=${zoomBefore}`);
  const scaleBefore = await page.getByTestId('scale-bar').evaluate((node) => node.style.width);
  const scaleLabel = await page.getByTestId('scale-bar-label').textContent();
  check(
    'scale bar shows a round distance in metres',
    /^(1|2|5|10|20|50|100|200|500|1000|2000) (m|km)$/.test((scaleLabel ?? '').trim()),
    `scale=${scaleLabel} width=${scaleBefore}`,
  );

  await page.getByTestId('zoom-in').click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="map-zoom-level"]')?.textContent !== expected,
    zoomBefore,
  );
  const zoomIn = await page.getByTestId('map-zoom-level').textContent();
  const zoomedViewBox = await page.getByTestId('battlefield-map').getAttribute('viewBox');
  check(
    'zoom control zooms in',
    zoomIn !== zoomBefore && zoomedViewBox !== fittedViewBox,
    `zoom=${zoomBefore} → ${zoomIn}`,
  );
  const scaleZoomed = await page.getByTestId('scale-bar').evaluate((node) => node.style.width);
  check(
    'scale bar stays correct at the new zoom',
    scaleZoomed !== scaleBefore,
    `width=${scaleBefore} → ${scaleZoomed}`,
  );

  await page.getByTestId('zoom-out').click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="map-zoom-level"]')?.textContent === expected,
    zoomBefore,
  );
  check('zoom control zooms back out', true);

  // Zooming keeps the point under the cursor fixed (keyboard path): hover a
  // map point, zoom with `+`, and the readout at the same screen pixel must
  // not move.
  const keyBox = (await page.getByTestId('battlefield-map').boundingBox()) ?? mapBox;
  const keyX = keyBox.x + keyBox.width / 4;
  const keyY = keyBox.y + keyBox.height / 4;
  await page.mouse.move(keyX, keyY);
  await page.waitForTimeout(SETTLE_MS);
  const keyAnchorBefore = await page.getByTestId('cursor-coords').textContent();
  await page.keyboard.press('+');
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="map-zoom-level"]')?.textContent !== expected,
    zoomBefore,
  );
  const keyAnchorAfter = await page.getByTestId('cursor-coords').textContent();
  check(
    'keyboard zoom keeps the cursor point fixed',
    keyAnchorBefore === keyAnchorAfter,
    `${keyAnchorBefore} → ${keyAnchorAfter}`,
  );
  await page.getByTestId('fit-view').click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="battlefield-map"]')?.getAttribute('viewBox') === expected,
    fittedViewBox,
  );

  // Zoom control keeps the last map point fixed: hover, record, click `+`
  // (the pointer travels onto the button, which must not re-anchor), move
  // back to the same pixel, and the readout must match.
  const btnBox = (await page.getByTestId('battlefield-map').boundingBox()) ?? mapBox;
  const btnX = btnBox.x + btnBox.width / 4;
  const btnY = btnBox.y + btnBox.height / 4;
  await page.mouse.move(btnX, btnY);
  await page.waitForTimeout(SETTLE_MS);
  const btnAnchorBefore = await page.getByTestId('cursor-coords').textContent();
  await page.getByTestId('zoom-in').click();
  await page.mouse.move(btnX, btnY);
  await page.waitForTimeout(SETTLE_MS);
  const btnAnchorAfter = await page.getByTestId('cursor-coords').textContent();
  check(
    'zoom control keeps the cursor point fixed',
    btnAnchorBefore === btnAnchorAfter,
    `${btnAnchorBefore} → ${btnAnchorAfter}`,
  );
  await page.getByTestId('fit-view').click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="battlefield-map"]')?.getAttribute('viewBox') === expected,
    fittedViewBox,
  );

  // Wheel zoom around the cursor.
  const zoomAttrBefore = await page.getByTestId('battlefield-map').getAttribute('data-zoom');
  const wheelBox = (await page.getByTestId('battlefield-map').boundingBox()) ?? mapBox;
  await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2);
  await page.mouse.wheel(0, -240);
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="battlefield-map"]')?.getAttribute('data-zoom') !== expected,
    zoomAttrBefore,
  );
  check('wheel zooms the map', true);

  // Fit restores the whole battlefield.
  await page.getByTestId('fit-view').click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="battlefield-map"]')?.getAttribute('viewBox') === expected,
    fittedViewBox,
  );
  check('fit shows the whole battlefield', true);

  // Hand tool pans by dragging; V switches back to select.
  await page.getByTestId('map-tool-hand').click();
  check(
    'hand tool activates',
    (await page.getByTestId('map-tool-hand').getAttribute('aria-pressed')) === 'true',
  );
  const panBox = (await page.getByTestId('battlefield-map').boundingBox()) ?? mapBox;
  const panStart = await page.getByTestId('battlefield-map').getAttribute('viewBox');
  await page.mouse.move(panBox.x + panBox.width / 2, panBox.y + panBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(panBox.x + panBox.width / 2 + 120, panBox.y + panBox.height / 2 + 60, { steps: 8 });
  await page.mouse.up();
  const panEnd = await page.getByTestId('battlefield-map').getAttribute('viewBox');
  check('hand tool pans the map', panEnd !== panStart, `${panStart} → ${panEnd}`);
  await page.keyboard.press('v');
  check(
    'V switches back to the select tool',
    (await page.getByTestId('map-tool-select').getAttribute('aria-pressed')) === 'true',
  );
  await page.keyboard.press('h');
  check(
    'H switches to the hand tool',
    (await page.getByTestId('map-tool-hand').getAttribute('aria-pressed')) === 'true',
  );
  await page.keyboard.press('v');

  // Fit after panning restores the fitted view.
  await page.getByTestId('fit-view').click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="battlefield-map"]')?.getAttribute('viewBox') === expected,
    fittedViewBox,
  );
  check('fit restores the view after panning', true);

  // Space-held panning: with the select tool active, holding Space and
  // dragging pans the map. Blur first so Space isn't swallowed by a button.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  const spaceStart = await page.getByTestId('battlefield-map').getAttribute('viewBox');
  const spaceBox = (await page.getByTestId('battlefield-map').boundingBox()) ?? mapBox;
  await page.mouse.move(spaceBox.x + spaceBox.width / 2, spaceBox.y + spaceBox.height / 2);
  await page.keyboard.down('Space');
  await page.mouse.down();
  await page.mouse.move(spaceBox.x + spaceBox.width / 2 - 90, spaceBox.y + spaceBox.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Space');
  const spaceEnd = await page.getByTestId('battlefield-map').getAttribute('viewBox');
  check('space-held drag pans the map', spaceEnd !== spaceStart, `${spaceStart} → ${spaceEnd}`);
  await page.getByTestId('fit-view').click();
  await page.waitForFunction(
    (expected) => document.querySelector('[data-testid="battlefield-map"]')?.getAttribute('viewBox') === expected,
    fittedViewBox,
  );

  // Cursor coordinates read out in map metres.
  const coordBox = (await page.getByTestId('battlefield-map').boundingBox()) ?? mapBox;
  await page.mouse.move(coordBox.x + coordBox.width / 2, coordBox.y + coordBox.height / 2);
  const coords = await page.getByTestId('cursor-coords').textContent();
  const coordMatch = (coords ?? '').match(/X (-?[\d.]+) m · Y (-?[\d.]+) m/);
  const coordInside =
    coordMatch !== null &&
    Number(coordMatch[1]) >= 0 &&
    Number(coordMatch[1]) <= 1400 &&
    Number(coordMatch[2]) >= 0 &&
    Number(coordMatch[2]) <= 900;
  check('cursor coordinates read out in metres', coordInside, coords ?? '');

  // Grid and labels toggle on and off.
  await page.getByTestId('toggle-grid').click();
  check('grid toggles off', !(await page.getByTestId('map-grid').isVisible()));
  await page.getByTestId('toggle-grid').click();
  check('grid toggles on', await page.getByTestId('map-grid').isVisible());
  const labelsBefore = await page.getByTestId('toggle-labels').getAttribute('aria-pressed');
  await page.getByTestId('toggle-labels').click();
  const labelsAfter = await page.getByTestId('toggle-labels').getAttribute('aria-pressed');
  check('labels toggle on and off', labelsBefore !== labelsAfter, `${labelsBefore} → ${labelsAfter}`);
  const sideAEmpty = await page.getByTestId('oob-side-a').getAttribute('data-empty');
  const sideBEmpty = await page.getByTestId('oob-side-b').getAttribute('data-empty');
  check('order of battle is empty for both sides', sideAEmpty === 'true' && sideBEmpty === 'true');
  const terrainCount = await page.getByTestId('inspector-terrain-count').textContent();
  check('inspector shows no terrain features', terrainCount === '0', `terrain=${terrainCount}`);

  // Save, then reload and reopen from the library with identical values.
  const editorUrl = page.url();
  const scenarioId = new URL(editorUrl).searchParams.get('scenario');
  check('editor URL carries the scenario id', !!scenarioId, editorUrl);
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  const saveStatus = await page.getByTestId('save-status').textContent();
  check('save reports the saved state', saveStatus === 'Saved', `status=${saveStatus}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  const reloadedTitle = await page.getByTestId('header-title').textContent();
  check('reload keeps the open scenario', reloadedTitle === title, `header=${reloadedTitle}`);

  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const rows = await page.getByTestId('scenario-row-title').allTextContents();
  check('library lists the saved scenario', rows.includes(title), rows.join(' | '));
  const metas = await page.getByTestId('scenario-row-meta').allTextContents();
  check(
    'library shows when the scenario was saved',
    metas.some((meta) => /Last saved/.test(meta) && !/never saved/.test(meta)),
    metas.join(' | '),
  );

  const row = page.getByTestId('scenario-row').filter({ hasText: title });
  await row.getByTestId('open-scenario').click();
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  const reopenedTitle = await page.getByTestId('editor-title').textContent();
  const reopenedDims = await page.getByTestId('battlefield-dims').textContent();
  const inspectorTitle = await page.getByTestId('inspector-title').inputValue();
  const inspectorWidth = await page.getByTestId('inspector-width').inputValue();
  const inspectorHeight = await page.getByTestId('inspector-height').inputValue();
  const reopenedA = await page.getByTestId('oob-side-a').getAttribute('data-empty');
  const reopenedB = await page.getByTestId('oob-side-b').getAttribute('data-empty');
  check(
    'reopened scenario keeps identical values',
    reopenedTitle === title &&
      (reopenedDims?.includes('1400 × 900') ?? false) &&
      inspectorTitle === title &&
      inspectorWidth === '1400' &&
      inspectorHeight === '900' &&
      reopenedA === 'true' &&
      reopenedB === 'true',
    `title=${reopenedTitle} dims=${reopenedDims} inspector=${inspectorTitle}/${inspectorWidth}/${inspectorHeight}`,
  );
}
