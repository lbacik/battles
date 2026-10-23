// Headless end-to-end test of the walking skeleton against the production
// build: create → empty battlefield → save → reload → reopen.
//
// Serves `out/` (run `npm run build` first) over loopback HTTP and drives a
// headless browser through the first end-to-end path: an author creates a
// scenario with a title, lands in the editor on an empty battlefield, saves,
// reloads, and reopens the scenario from the library with identical values.
// Records `e2e-report/report.json` plus `e2e-report/trace.log` for the CI
// artifact upload.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'out');
const reportDir = path.join(root, 'e2e-report');

const trace = [];
function log(line) {
  trace.push(`${new Date().toISOString()} ${line}`);
}

const checks = [];
function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

function serveStatic(dir) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };
  return http.createServer((req, res) => {
    log(`${req.method} ${req.url}`);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    let file = path.resolve(dir, pathname.replace(/^\//, '') || 'index.html');
    if (file !== dir && !file.startsWith(`${dir}${path.sep}`)) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (error) {
      if (error?.code === 'EISDIR' || error?.code === 'ENOENT') {
        // Single-page app: unknown paths fall back to index.html so the
        // `?scenario=` editor route serves from the static export.
        try {
          const body = readFileSync(path.join(dir, 'index.html'));
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(body);
          return;
        } catch {
          // Fall through to 404.
        }
      }
      res.writeHead(404);
      res.end('not found');
    }
  });
}

function failReport(reason) {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({ pass: false, checks }, null, 2)}\n`);
  writeFileSync(path.join(reportDir, 'trace.log'), `${trace.join('\n')}\n`);
  console.error(`test:e2e: ${reason} (see e2e-report/)`);
}

mkdirSync(reportDir, { recursive: true });

let indexHtml;
try {
  indexHtml = readFileSync(path.join(outDir, 'index.html'), 'utf8');
} catch {
  failReport('out/index.html is missing; run `npm run build` first.');
  process.exit(1);
}
if (!indexHtml.includes('PÓLIS')) {
  failReport('out/index.html does not look like the PÓLIS app.');
  process.exit(1);
}

let playwright;
try {
  playwright = await import('playwright');
} catch {
  failReport('the `playwright` package is not installed; run `npm ci` first.');
  process.exit(1);
}

const server = serveStatic(outDir);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
log(`serving ${outDir} on ${base}`);

let browser = null;
try {
  browser = await playwright.chromium.launch();
} catch (error) {
  failReport(
    `could not launch headless Chromium (${String(error).replace(/\s+/g, ' ').slice(0, 300)}). ` +
      'Run `npx playwright install chromium` first.',
  );
  await new Promise((resolve) => server.close(resolve));
  process.exit(1);
}

try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  // A Playwright trace of the whole run lands in e2e-report/ next to
  // report.json and trace.log, so the CI artifact carries the failure
  // context, not just the check list.
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on('console', (message) => log(`browser console: ${message.text()}`));
  page.on('pageerror', (error) => log(`browser pageerror: ${String(error)}`));

  // The ten-step editor acceptance scenario (#4) plus persistence steps
  // 1-6 and 8 (#5) run as one coherent story against this scenario, in
  // acceptance order, so the saved, reopened, duplicated, exported, and
  // imported document is the one built in steps 1-8.
  const title = 'Acceptance plain';

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
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
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
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  const resizedDims = await page.getByTestId('battlefield-dims').textContent();
  check(
    'acceptance step 1 sets the battlefield to 1400 x 900 m',
    resizedDims?.includes('1400 × 900') ?? false,
    resizedDims ?? '',
  );

  // Map navigation (issue #75): zoom, pan, fit, and the coordinate readout.
  const fittedViewBox = await page.getByTestId('battlefield-map').getAttribute('viewBox');
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
  await page.waitForTimeout(200);
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
  await page.waitForTimeout(200);
  const btnAnchorBefore = await page.getByTestId('cursor-coords').textContent();
  await page.getByTestId('zoom-in').click();
  await page.mouse.move(btnX, btnY);
  await page.waitForTimeout(200);
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
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  const saveStatus = await page.getByTestId('save-status').textContent();
  check('save reports the saved state', saveStatus === 'Saved', `status=${saveStatus}`);

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  const reloadedTitle = await page.getByTestId('header-title').textContent();
  check('reload keeps the open scenario', reloadedTitle === title, `header=${reloadedTitle}`);

  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
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
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
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

  // Issue #76: scenario properties, undo/redo, and the issues panel.
  const undoButton = page.getByTestId('undo');
  const redoButton = page.getByTestId('redo');
  check('undo history is empty after reopen', await undoButton.isDisabled());
  check('redo history is empty after reopen', await redoButton.isDisabled());

  const warnings = await page.getByTestId('issue-warning').allTextContents();
  check(
    'issues panel warns for each side with no units',
    warnings.length === 2 && warnings.every((warning) => /has no units/.test(warning)),
    warnings.join(' | '),
  );

  // Side colours must differ: committing side B's colour for side A is
  // refused, the field reverts, and the scenario stays saved.
  const colorB = await page.getByTestId('inspector-side-color-1').inputValue();
  await page.getByTestId('inspector-side-color-0').fill(colorB);
  await page.locator('.map-caption').click();
  check(
    'a duplicate side colour is refused',
    await page.getByTestId('inspector-side-color-0-error').isVisible(),
  );
  check(
    'a refused colour leaves the scenario saved',
    !(await page.getByTestId('unsaved-pill').isVisible()),
  );

  // Battlefield dimensions stay within the application limit.
  await page.getByTestId('inspector-width').fill('0');
  await page.locator('.map-caption').click();
  check(
    'an invalid battlefield size is refused',
    await page.getByTestId('inspector-width-error').isVisible(),
  );

  // Editing the title marks the scenario unsaved; undo walks back to the
  // saved version and redo restores the edit.
  await page.getByTestId('inspector-title').fill(`${title} revised`);
  await page.locator('.map-caption').click();
  const editedTitle = await page.getByTestId('inspector-title').inputValue();
  check('editing the title commits', editedTitle === `${title} revised`, editedTitle);
  check(
    'editing the title marks unsaved changes',
    (await page.getByTestId('unsaved-pill').isVisible()) &&
      (await page.getByTestId('header-dirty').isVisible()),
  );
  await undoButton.click();
  check(
    'undo restores the saved title',
    (await page.getByTestId('inspector-title').inputValue()) === title,
  );
  check(
    'undo back to saved clears the unsaved indicator',
    !(await page.getByTestId('unsaved-pill').isVisible()),
  );
  check('redo is available after undo', !(await redoButton.isDisabled()));
  await redoButton.click();
  check(
    'redo restores the edit',
    (await page.getByTestId('inspector-title').inputValue()) === `${title} revised`,
  );

  // A scenario with warnings still saves.
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  check(
    'a scenario with warnings saves',
    (await page.getByTestId('save-status').textContent()) === 'Saved',
  );

  // Issue #79: terrain mode — draw, refuse overlap, nested hills.
  // Map metres (y up from the south-west corner) to client pixels through
  // the live SVG viewBox, so terrain vertices land on exact points.
  async function clickMap(atX, atY) {
    const svg = page.getByTestId('battlefield-map');
    const box = await svg.boundingBox();
    const viewBox = ((await svg.getAttribute('viewBox')) ?? '0 0 1200 800')
      .split(/\s+/)
      .map(Number);
    const dimsText = (await page.getByTestId('battlefield-dims').textContent()) ?? '';
    const dimsMatch = dimsText.match(/([\d.]+) × ([\d.]+)/);
    const fieldH = dimsMatch ? Number(dimsMatch[2]) : 800;
    const clientX = box.x + ((atX - viewBox[0]) / viewBox[2]) * box.width;
    const clientY = box.y + ((fieldH - atY - viewBox[1]) / viewBox[3]) * box.height;
    await page.mouse.click(clientX, clientY);
  }

  await page.getByTestId('mode-map').click();
  check(
    'map editor tab shows the terrain panel',
    await page.getByTestId('terrain-panel').isVisible(),
  );
  await page.getByTestId('fit-view').click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="battlefield-map"]')?.getAttribute('viewBox') ===
      expected,
    fittedViewBox,
  );

  // Draw a forest area and finish from the keyboard.
  await page.getByTestId('terrain-new-category').selectOption('forest');
  await page.getByTestId('terrain-draw-area').click();
  check('drawing shows the map hint', await page.getByTestId('map-terrain-hint').isVisible());
  for (const [vx, vy] of [
    [200, 200],
    [400, 200],
    [400, 400],
    [200, 400],
  ]) {
    await clickMap(vx, vy);
  }
  await page.keyboard.press('Enter');
  const groundRow = page.getByTestId('terrain-ground-row');
  check('drawing a forest adds a ground row', (await groundRow.count()) === 1);

  // Acceptance step 2 also draws rough ground and a settlement.
  await page.getByTestId('terrain-new-category').selectOption('rough');
  await page.getByTestId('terrain-draw-area').click();
  for (const [vx, vy] of [
    [1150, 600],
    [1300, 620],
    [1280, 740],
    [1140, 720],
  ]) {
    await clickMap(vx, vy);
  }
  await page.keyboard.press('Enter');
  await page.getByTestId('terrain-new-category').selectOption('settlement');
  await page.getByTestId('terrain-draw-area').click();
  for (const [vx, vy] of [
    [150, 120],
    [300, 120],
    [310, 230],
    [220, 260],
  ]) {
    await clickMap(vx, vy);
  }
  await page.keyboard.press('Enter');
  check('drawing rough and settlement adds two more rows', (await groundRow.count()) === 3);
  check(
    'the forest renders on the map',
    (await page.getByTestId('terrain-ground').count()) === 1,
  );

  // An overlapping area is refused: the candidate highlights red, the list
  // is unchanged, and Escape clears the refusal.
  await page.getByTestId('terrain-draw-area').click();
  for (const [vx, vy] of [
    [300, 300],
    [500, 300],
    [500, 500],
    [300, 500],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  check('overlapping ground is refused', await page.getByTestId('terrain-refusal').isVisible());
  check(
    'a refused overlap leaves the feature count unchanged',
    (await groundRow.count()) === 3,
  );
  check(
    'a refused overlap highlights the candidate',
    (await page.getByTestId('terrain-refusal-shape').count()) === 1,
  );
  await page.keyboard.press('Escape');
  check(
    'escape clears the refusal',
    (await page.getByTestId('terrain-refusal').count()) === 0,
  );

  // A self-intersecting bowtie is refused the same way.
  await page.getByTestId('terrain-draw-area').click();
  for (const [vx, vy] of [
    [600, 200],
    [800, 400],
    [800, 200],
    [600, 400],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  check(
    'a self-intersecting polygon is refused',
    await page.getByTestId('terrain-refusal').isVisible(),
  );
  check(
    'a refused bowtie leaves the feature count unchanged',
    (await groundRow.count()) === 3,
  );
  await page.keyboard.press('Escape');

  // Hills nest: the first hill is level 1, a hill drawn inside it is level 2.
  await page.getByTestId('terrain-draw-hill').click();
  for (const [vx, vy] of [
    [700, 550],
    [950, 550],
    [950, 750],
    [700, 750],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  const hillRow = page.getByTestId('terrain-hill-row');
  check('drawing a hill adds a hill row', (await hillRow.count()) === 1);
  const hillText = (await hillRow.first().textContent()) ?? '';
  check('the outer hill derives level 1', /level 1/.test(hillText), hillText.slice(0, 80));
  await page.getByTestId('terrain-draw-hill').click();
  for (const [vx, vy] of [
    [760, 610],
    [890, 610],
    [890, 690],
    [760, 690],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  check('a nested hill adds a second row', (await hillRow.count()) === 2);
  const hillTexts = await hillRow.allTextContents();
  check(
    'the nested hill derives level 2',
    hillTexts.some((entry) => /level 2/.test(entry)),
    hillTexts.join(' | ').slice(0, 120),
  );

  // A hill crossing its sibling's boundary is refused.
  await page.getByTestId('terrain-draw-hill').click();
  for (const [vx, vy] of [
    [900, 600],
    [1050, 600],
    [1050, 700],
    [900, 700],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  check('a crossing hill is refused', await page.getByTestId('terrain-refusal').isVisible());
  check('a refused hill leaves the hill count unchanged', (await hillRow.count()) === 2);
  await page.keyboard.press('Escape');

  // Issue #80: rivers and roads — draw a river crossing the forest, then a
  // road crossing both, and change a width. Linear features may cross ground
  // cover, elevation, and each other, so both finishes succeed.
  await page.getByTestId('terrain-new-linear-category').selectOption('river');
  await page.getByTestId('terrain-new-linear-width').fill('18');
  await page.getByTestId('terrain-draw-linear').click();
  check('drawing shows the river hint', await page.getByTestId('map-terrain-hint').isVisible());
  for (const [vx, vy] of [
    [300, 100],
    [300, 350],
    [300, 700],
  ]) {
    await clickMap(vx, vy);
  }
  await page.keyboard.press('Enter');
  const linearRow = page.getByTestId('terrain-linear-row');
  check('drawing a river adds a river row', (await linearRow.count()) === 1);
  check(
    'the river renders on the map at true scale',
    (await page.getByTestId('terrain-linear').count()) === 1,
  );
  check(
    'the river line is 18 m wide',
    (await page.getByTestId('terrain-linear').first().getAttribute('stroke-width')) === '18',
  );

  await page.getByTestId('terrain-new-linear-category').selectOption('road');
  await page.getByTestId('terrain-new-linear-width').fill('6');
  await page.getByTestId('terrain-draw-linear').click();
  for (const [vx, vy] of [
    [100, 300],
    [500, 300],
    [1100, 300],
  ]) {
    await clickMap(vx, vy);
  }
  // The river finished from the keyboard; the road finishes from the button.
  await page.getByTestId('terrain-draw-finish').click();
  check('drawing a road adds a second row', (await linearRow.count()) === 2);
  check(
    'the road crosses the river on the map',
    (await page.getByTestId('terrain-linear').count()) === 2,
  );

  // Escape cancels a river or road draft without adding a feature.
  await page.getByTestId('terrain-draw-linear').click();
  await clickMap(600, 100);
  await page.keyboard.press('Escape');
  check(
    'escape cancels the linear draft',
    (await linearRow.count()) === 2 &&
      (await page.getByTestId('map-terrain-hint').count()) === 0,
  );

  // A width change in the inspector redraws the line to scale and is undoable.
  await linearRow.nth(1).getByTestId('terrain-select').click();
  await page.getByTestId('terrain-linear-width').fill('8');
  await page.keyboard.press('Enter');
  check(
    'widening the road updates its row',
    ((await linearRow.nth(1).textContent()) ?? '').includes('8 m'),
  );
  check(
    'widening the road redraws its line',
    (await page.getByTestId('terrain-linear').nth(1).getAttribute('stroke-width')) === '8',
  );
  await page.getByTestId('undo').click();
  check(
    'undo restores the road width',
    ((await linearRow.nth(1).textContent()) ?? '').includes('6 m'),
  );
  await page.getByTestId('redo').click();
  check(
    'redo restores the width change',
    ((await linearRow.nth(1).textContent()) ?? '').includes('8 m'),
  );

  // A road vertex can be inserted on an edge and deleted again.
  const linearVertex = page.getByTestId('terrain-vertex-handle');
  const linearBefore = await linearVertex.count();
  check('the road shows its vertices', linearBefore === 3);
  await page.getByTestId('terrain-edge-handle').first().click();
  check(
    'inserting a road vertex adds a handle',
    (await linearVertex.count()) === linearBefore + 1,
  );
  await linearVertex.first().click();
  await page.keyboard.press('Delete');
  check('deleting a road vertex removes its handle', (await linearVertex.count()) === linearBefore);

  // Recategorise the forest, insert a vertex on an edge, delete it again.
  await groundRow.first().getByTestId('terrain-select').click();
  await page.getByTestId('terrain-category').selectOption('rough');
  check(
    'recategorising updates the row',
    (await groundRow.first().getAttribute('data-category')) === 'rough',
  );
  const vertexHandle = page.getByTestId('terrain-vertex-handle');
  const verticesBefore = await vertexHandle.count();
  await page.getByTestId('terrain-edge-handle').first().click();
  check(
    'inserting a vertex on an edge adds a handle',
    (await vertexHandle.count()) === verticesBefore + 1,
  );
  await vertexHandle.first().click();
  await page.keyboard.press('Delete');
  check(
    'deleting a vertex removes its handle',
    (await vertexHandle.count()) === verticesBefore,
  );

  // Contours toggle on and off.
  const contoursBefore = await page.getByTestId('toggle-contours').getAttribute('aria-pressed');
  await page.getByTestId('toggle-contours').click();
  const contoursAfter = await page.getByTestId('toggle-contours').getAttribute('aria-pressed');
  check('contours toggle on and off', contoursBefore !== contoursAfter);
  await page.getByTestId('toggle-contours').click();

  // Deleting the area is undoable.
  await page.getByTestId('terrain-delete-feature').click();
  check('deleting the area removes its row', (await groundRow.count()) === 2);
  await page.getByTestId('undo').click();
  check('undo restores the deleted area', (await groundRow.count()) === 3);

  // Terrain persists through a save.
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  check(
    'terrain saves',
    (await page.getByTestId('save-status').textContent()) === 'Saved',
  );

  // Back to battle mode for the order-of-battle checks below.
  await page.getByTestId('mode-battle').click();
  check(
    'battle mode restores the order of battle',
    await page.getByTestId('oob-tab-all').isVisible(),
  );

  // Acceptance step 4: rename the sides Athens and Sparta. The empty-side
  // warnings stay until units are fielded.
  await page.getByTestId('inspector-side-0').fill('Athens');
  await page.locator('.map-caption').click();
  await page.getByTestId('inspector-side-1').fill('Sparta');
  await page.locator('.map-caption').click();
  check(
    'acceptance step 4 renames the sides Athens and Sparta',
    (await page.getByTestId('inspector-side-0').inputValue()) === 'Athens' &&
      (await page.getByTestId('inspector-side-1').inputValue()) === 'Sparta',
  );
  const renamedWarnings = await page.getByTestId('issue-warning').allTextContents();
  check(
    'renamed sides still warn while empty',
    renamedWarnings.length === 2 && renamedWarnings.every((warning) => /has no units/.test(warning)),
    renamedWarnings.join(' | '),
  );

  // Issue #77: order of battle — add, select, edit, duplicate, delete.
  const oobTabAll = page.getByTestId('oob-tab-all');
  const oobTabA = page.getByTestId('oob-tab-0');
  const oobTabB = page.getByTestId('oob-tab-1');
  check(
    'oob filter tabs are visible',
    (await oobTabAll.isVisible()) &&
      (await oobTabA.isVisible()) &&
      (await oobTabB.isVisible()),
  );
  await oobTabA.click();
  check(
    'an oob side tab filters to that side',
    (await page.getByTestId('oob-side-a').isVisible()) &&
      !(await page.getByTestId('oob-side-b').isVisible()),
  );
  await oobTabAll.click();

  await page.getByTestId('oob-add').click();
  const oobUnit = page.getByTestId('oob-unit');
  check('adding a unit creates a row', (await oobUnit.count()) === 1);
  const firstUnitId = await oobUnit.first().getAttribute('data-unit-id');
  const firstRowText = (await oobUnit.first().textContent()) ?? '';
  check(
    'the new unit has the default name',
    /New Unit/.test(firstRowText),
    firstRowText.trim().slice(0, 80),
  );
  const warningsAfterAdd = await page.getByTestId('issue-warning').allTextContents();
  check(
    'adding a unit clears one side warning',
    warningsAfterAdd.length === 1 && /has no units/.test(warningsAfterAdd[0] ?? ''),
    warningsAfterAdd.join(' | '),
  );
  const derived = (await page.getByTestId('unit-derived').textContent()) ?? '';
  check(
    'the inspector derives ranks, frontage, and depth',
    /10 ranks/.test(derived) &&
      /18\.0 m frontage/.test(derived) &&
      /18\.0 m depth/.test(derived),
    (derived ?? '').trim().slice(0, 120),
  );
  check(
    'the inspector shows the formation diagram',
    await page.getByTestId('formation-diagram').isVisible(),
  );

  // Selecting in the list selects the unit on the map and vice versa.
  await oobUnit.first().click();
  const selectedOnMap = page.locator('[data-testid="map-unit"][data-selected="true"]');
  check(
    'selecting in the list selects the unit on the map',
    (await selectedOnMap.count()) === 1 &&
      ((await selectedOnMap.getAttribute('data-unit-id')) === firstUnitId),
  );

  // Editing soldiers updates the derived ranks and depth.
  await page.getByTestId('unit-soldiers').fill('150');
  await page.locator('.map-caption').click();
  const derived150 = (await page.getByTestId('unit-derived').textContent()) ?? '';
  check(
    'editing soldiers updates ranks and depth',
    /15 ranks/.test(derived150) &&
      /18\.0 m frontage/.test(derived150) &&
      /27\.0 m depth/.test(derived150),
    (derived150 ?? '').trim().slice(0, 120),
  );

  // Changing troop type pre-fills that type's normal preset; the preset
  // select then applies the open spacings in one step.
  await page.getByTestId('unit-troop').selectOption('peltast');
  check(
    'changing troop type pre-fills its normal spacing',
    (await page.getByTestId('unit-spacing-lateral').inputValue()) === '1.5' &&
      (await page.getByTestId('unit-spacing-depth').inputValue()) === '1.5',
  );
  await page.getByTestId('unit-preset').selectOption('open');
  const lateralOpen = await page.getByTestId('unit-spacing-lateral').inputValue();
  const depthOpen = await page.getByTestId('unit-spacing-depth').inputValue();
  check(
    'the open preset applies both spacings',
    lateralOpen === '3' && depthOpen === '3',
    `lateral=${lateralOpen} depth=${depthOpen}`,
  );

  // Duplicate names the copy uniquely; selecting on the map drives the
  // inspector back to the first unit.
  await page.getByTestId('unit-duplicate').click();
  check('duplicating adds a second row', (await oobUnit.count()) === 2);
  const oobDupTitles = await oobUnit.allTextContents();
  check(
    'the duplicate is uniquely named',
    oobDupTitles.some((entry) => /copy/.test(entry ?? '')),
    oobDupTitles.join(' | ').slice(0, 120),
  );
  await page.locator(`[data-testid="map-unit"][data-unit-id="${firstUnitId}"]`).click();
  const selectedUnitTitle = await page.getByTestId('unit-title').textContent();
  check(
    'selecting on the map selects the unit in the inspector',
    selectedUnitTitle === 'New Unit',
    selectedUnitTitle ?? '',
  );

  // Issue #78: placing and rotating units on the map. The first unit is
  // selected (from the map click above); the duplicate is the second row.
  const secondUnitId = await oobUnit.nth(1).getAttribute('data-unit-id');
  check(
    'rotation handle appears for the selected unit',
    await page.getByTestId('rotate-handle').isVisible(),
  );

  // Numeric facing edit commits.
  await page.getByTestId('unit-facing').fill('30');
  await page.locator('.map-caption').click();
  check(
    'numeric facing edit commits',
    (await page.getByTestId('unit-facing').inputValue()) === '30',
  );

  // Centre the unit so rotations stay inside the battlefield whatever the
  // default placement is; the second unit stays far away near the top.
  await page.getByTestId('unit-position-x').fill('600');
  await page.getByTestId('unit-position-y').fill('400');
  await page.locator('.map-caption').click();
  check(
    'numeric position edit commits',
    (await page.getByTestId('unit-position-x').inputValue()) === '600' &&
      (await page.getByTestId('unit-position-y').inputValue()) === '400',
  );

  // Rotation handle snaps to 15 degrees: dragging the grip due east of the
  // footprint centre puts the bearing exactly on 90 (the front midpoint
  // sits at the same height as the centre once facing runs east).
  {
    const handleBox = await page.getByTestId('rotate-handle').boundingBox();
    const footBox = await page
      .locator('[data-testid="map-unit"][data-selected="true"] [data-testid="unit-footprint"]')
      .boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(footBox.x + footBox.width / 2 + 180, footBox.y + footBox.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
  }
  check(
    'dragging the rotation handle snaps to 15 degrees',
    (await page.getByTestId('unit-facing').inputValue()) === '90',
  );

  // Holding Shift disables snapping: the same drag with a southward offset
  // lands off the 15-degree grid.
  await page.keyboard.down('Shift');
  {
    const handleBox = await page.getByTestId('rotate-handle').boundingBox();
    const footBox = await page
      .locator('[data-testid="map-unit"][data-selected="true"] [data-testid="unit-footprint"]')
      .boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(footBox.x + footBox.width / 2 + 137, footBox.y + footBox.height / 2 + 23, {
      steps: 12,
    });
    await page.mouse.up();
  }
  await page.keyboard.up('Shift');
  const freeFacing = Number(await page.getByTestId('unit-facing').inputValue());
  check(
    'holding Shift rotates freely without snapping',
    Number.isFinite(freeFacing) && Math.abs(freeFacing % 15) > 0.01,
    `facing=${freeFacing}`,
  );

  // Dragging moves the unit; the move is one undo step.
  const beforeX = await page.getByTestId('unit-position-x').inputValue();
  {
    const footBox = await page
      .locator('[data-testid="map-unit"][data-selected="true"] [data-testid="unit-footprint"]')
      .boundingBox();
    const cx = footBox.x + footBox.width / 2;
    const cy = footBox.y + footBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy, { steps: 10 });
    await page.mouse.up();
  }
  const afterX = await page.getByTestId('unit-position-x').inputValue();
  check(
    'dragging moves the unit',
    Number(afterX) > Number(beforeX),
    `${beforeX} → ${afterX}`,
  );
  await undoButton.click();
  check(
    'the move is one undo step',
    (await page.getByTestId('unit-position-x').inputValue()) === beforeX,
  );
  await redoButton.click();
  check(
    'redo re-applies the move',
    (await page.getByTestId('unit-position-x').inputValue()) === afterX,
  );

  // Dropping onto another unit is refused: the unit returns and both units
  // are highlighted as the conflict.
  await page.locator(`[data-testid="oob-unit"][data-unit-id="${secondUnitId}"]`).click();
  const targetBox = await page
    .locator(`[data-testid="map-unit"][data-unit-id="${firstUnitId}"] [data-testid="unit-footprint"]`)
    .boundingBox();
  const draggedBox = await page
    .locator('[data-testid="map-unit"][data-selected="true"] [data-testid="unit-footprint"]')
    .boundingBox();
  const committedBeforeDrop = await page
    .getByTestId('unit-position-x')
    .getAttribute('data-committed');
  await page.mouse.move(draggedBox.x + draggedBox.width / 2, draggedBox.y + draggedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  check(
    'dropping onto another unit is refused with a highlight',
    (await page.getByTestId('unit-position-x').inputValue()) === committedBeforeDrop &&
      (await page.getByTestId('inspector-unit-position-error').isVisible()) &&
      (await page.locator('[data-testid="map-unit"][data-conflict="true"]').count()) === 2,
  );

  // An out-of-bounds position is refused the same way (the same proposal
  // path backs the drag and the numeric field).
  const committedBeforeOob = await page
    .getByTestId('unit-position-x')
    .getAttribute('data-committed');
  await page.getByTestId('unit-position-x').fill('5000');
  await page.locator('.map-caption').click();
  check(
    'an out-of-bounds position is refused',
    (await page.getByTestId('inspector-unit-position-error').isVisible()) &&
      (await page.getByTestId('unit-position-x').getAttribute('data-committed')) ===
        committedBeforeOob &&
      (await page.locator('[data-testid="map-unit"][data-conflict="true"]').count()) === 1,
  );

  // Touching edge to edge is accepted: park the second unit beside the first
  // with the flank edges flush (both face 180, so the same Y and an X offset
  // of half the frontages keeps every corner inside and apart).
  await page.locator(`[data-testid="oob-unit"][data-unit-id="${firstUnitId}"]`).click();
  await page.getByTestId('unit-facing').fill('180');
  await page.locator('.map-caption').click();
  const firstX = Number(await page.getByTestId('unit-position-x').inputValue());
  const firstY = Number(await page.getByTestId('unit-position-y').inputValue());
  const firstDerived = (await page.getByTestId('unit-derived').textContent()) ?? '';
  const firstFront = Number(/([\d.]+) m frontage/.exec(firstDerived)?.[1]);
  await page.locator(`[data-testid="oob-unit"][data-unit-id="${secondUnitId}"]`).click();
  await page.getByTestId('unit-facing').fill('180');
  await page.locator('.map-caption').click();
  const secondDerived = (await page.getByTestId('unit-derived').textContent()) ?? '';
  const secondFront = Number(/([\d.]+) m frontage/.exec(secondDerived)?.[1]);
  const touchX = Math.round((firstX + (firstFront + secondFront) / 2) * 10) / 10;
  await page.getByTestId('unit-position-x').fill(String(touchX));
  await page.locator('.map-caption').click();
  await page.getByTestId('unit-position-y').fill(String(firstY));
  await page.locator('.map-caption').click();
  check(
    'touching edge to edge is accepted',
    (await page.getByTestId('inspector-unit-position-error').count()) === 0 &&
      (await page.getByTestId('unit-position-x').inputValue()) === String(touchX),
    `touchX=${touchX}`,
  );

  // Structural refusals: files beyond soldiers, a duplicate name, and a
  // spacing outside the application limit.
  await page.getByTestId('unit-files').fill('200');
  await page.locator('.map-caption').click();
  check(
    'files beyond soldiers are refused',
    await page.getByTestId('inspector-unit-files-error').isVisible(),
  );
  await page.getByTestId('unit-name').fill('New Unit copy');
  await page.locator('.map-caption').click();
  check(
    'a duplicate unit name is refused',
    await page.getByTestId('inspector-unit-name-error').isVisible(),
  );
  await page.getByTestId('unit-spacing-lateral').fill('99');
  await page.locator('.map-caption').click();
  check(
    'a spacing outside structural bounds is refused',
    await page.getByTestId('inspector-unit-spacing-lateral-error').isVisible(),
  );

  // Delete both units; the warnings return; undo/redo walks the deletes back.
  await page.getByTestId('unit-delete').click();
  check('deleting removes the selected row', (await oobUnit.count()) === 1);
  await oobUnit.first().click();
  await page.getByTestId('unit-delete').click();
  check('deleting the last unit clears the list', (await oobUnit.count()) === 0);
  const warningsAfterDelete = await page.getByTestId('issue-warning').allTextContents();
  check(
    'the side warnings return when the sides have no units',
    warningsAfterDelete.length === 2,
    warningsAfterDelete.join(' | '),
  );
  await undoButton.click();
  check(
    'undo restores the deleted unit',
    (await oobUnit.count()) === 1 &&
      (await page.getByTestId('issue-warning').count()) === 1,
  );
  await redoButton.click();
  check(
    'redo removes the unit again',
    (await oobUnit.count()) === 0 &&
      (await page.getByTestId('issue-warning').count()) === 2,
  );

  // Acceptance steps 5-8: three units per side from at least two troop types,
  // a spacing preset change, a rotation to 30 degrees, and a refused
  // battlefield shrink. The scenario built here is what steps 9-10 and the
  // persistence steps save, reopen, duplicate, export, and import.
  async function addAcceptanceUnit(spec) {
    await page.getByTestId('oob-add').click();
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="oob-unit"]').length === expected,
      spec.rowCount,
    );
    await page.getByTestId('unit-name').fill(spec.name);
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-side').selectOption({ label: spec.side });
    await page.getByTestId('unit-troop').selectOption(spec.troopType);
    await page.getByTestId('unit-soldiers').fill(String(spec.soldiers));
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-files').fill(String(spec.files));
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-position-x').fill(String(spec.x));
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-position-y').fill(String(spec.y));
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-facing').fill(String(spec.facing));
    await page.locator('.map-caption').click();
  }

  const acceptanceUnits = [
    { name: 'I Athenian taxis', side: 'Athens', troopType: 'hoplite', soldiers: 256, files: 16, x: 500, y: 600, facing: 180, rowCount: 1 },
    { name: 'Athenian peltasts', side: 'Athens', troopType: 'peltast', soldiers: 120, files: 12, x: 750, y: 620, facing: 180, rowCount: 2 },
    { name: 'Athenian cavalry', side: 'Athens', troopType: 'cavalry', soldiers: 80, files: 10, x: 1000, y: 600, facing: 150, rowCount: 3 },
    { name: 'I Spartan mora', side: 'Sparta', troopType: 'hoplite', soldiers: 320, files: 16, x: 550, y: 300, facing: 0, rowCount: 4 },
    { name: 'Spartan archers', side: 'Sparta', troopType: 'archer', soldiers: 100, files: 14, x: 800, y: 280, facing: 0, rowCount: 5 },
    { name: 'Skiritae peltasts', side: 'Sparta', troopType: 'peltast', soldiers: 120, files: 12, x: 1050, y: 300, facing: 30, rowCount: 6 },
  ];
  for (const spec of acceptanceUnits) {
    await addAcceptanceUnit(spec);
  }
  check('acceptance step 5 fields three units per side', (await oobUnit.count()) === 6);
  check(
    'acceptance step 5 clears the empty-side warnings',
    (await page.getByTestId('issue-warning').count()) === 0,
  );
  await page.locator('[data-testid="oob-unit"]', { hasText: 'I Athenian taxis' }).click();
  const taxisDerived = (await page.getByTestId('unit-derived').textContent()) ?? '';
  check(
    'the inspector derives ranks, frontage, and depth',
    /16 ranks/.test(taxisDerived) &&
      /16\.0 m frontage/.test(taxisDerived) &&
      /16\.0 m depth/.test(taxisDerived),
    taxisDerived.trim().slice(0, 120),
  );
  await page.locator('[data-testid="oob-unit"]', { hasText: 'Athenian peltasts' }).click();
  await page.getByTestId('unit-preset').selectOption('open');
  check(
    'acceptance step 5 applies the open spacing preset',
    (await page.getByTestId('unit-spacing-lateral').inputValue()) === '3' &&
      (await page.getByTestId('unit-spacing-depth').inputValue()) === '3',
  );
  await page.locator('[data-testid="oob-unit"]', { hasText: 'Skiritae peltasts' }).click();
  check(
    'acceptance step 5 rotates a unit to 30 degrees',
    (await page.getByTestId('unit-facing').inputValue()) === '30',
  );

  // Acceptance step 7: shrinking the battlefield past a unit is refused and
  // names the blocking unit; the stored size is untouched.
  await page.getByTestId('inspector-width').fill('400');
  await page.locator('.map-caption').click();
  const shrinkError = await page.getByTestId('inspector-width-error').textContent().catch(() => null);
  check(
    'acceptance step 7 refuses a shrink past a unit',
    (await page.getByTestId('inspector-width-error').isVisible()) &&
      /taxis|peltasts|cavalry|mora|archers|Skiritae/i.test(shrinkError ?? ''),
    (shrinkError ?? '').replace(/\s+/g, ' ').slice(0, 160),
  );
  await page.getByTestId('inspector-width').fill('1400');
  await page.locator('.map-caption').click();
  check(
    'the refused shrink leaves the stored size alone',
    (await page.getByTestId('inspector-width-error').count()) === 0 &&
      (await page.getByTestId('inspector-width').inputValue()) === '1400',
  );

  // Acceptance step 8 runs across the whole script: undo and redo cover
  // properties, terrain, and units (title, road width, area delete, unit move
  // and delete above). Save the finished scenario and prove step 9 through
  // the browser: reload and reopen identical to 0.1 m with empty undo history.
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  check(
    'acceptance step 9 reloads the finished scenario',
    (await page.getByTestId('header-title').textContent()) === title,
  );
  check(
    'acceptance step 9 keeps every value identical to 0.1 m',
    ((await page.getByTestId('battlefield-dims').textContent()) ?? '').includes('1400 × 900') &&
      (await page.getByTestId('inspector-width').inputValue()) === '1400' &&
      (await page.getByTestId('inspector-height').inputValue()) === '900' &&
      (await page.getByTestId('oob-unit').count()) === 6 &&
      (await page.getByTestId('issue-warning').count()) === 0 &&
      (await page.getByTestId('terrain-ground-row').count()) === 3 &&
      (await page.getByTestId('terrain-hill-row').count()) === 2 &&
      (await page.getByTestId('terrain-linear-row').count()) === 2,
  );
  await page.locator('[data-testid="oob-unit"]', { hasText: 'I Athenian taxis' }).click();
  check(
    'acceptance step 9 keeps unit positions identical to 0.1 m',
    (await page.getByTestId('unit-position-x').inputValue()) === '500' &&
      (await page.getByTestId('unit-position-y').inputValue()) === '600',
  );
  check(
    'acceptance step 9 reopens with empty undo history',
    (await undoButton.isDisabled()) && (await redoButton.isDisabled()),
  );

  // Leaving the editor with unsaved changes asks for confirmation.
  await page.getByTestId('inspector-description').fill('Revised description.');
  await page.locator('.map-caption').click();
  let leaveDialog = null;
  let leaveAccepted = false;
  page.on('dialog', (dialog) => {
    leaveDialog = dialog.type();
    void (leaveDialog === 'confirm' && leaveAccepted ? dialog.accept() : dialog.dismiss());
  });
  await page.getByTestId('back-to-library').click();
  check(
    'leaving with unsaved changes warns',
    leaveDialog === 'confirm' && (await page.getByTestId('editor').isVisible()),
  );
  leaveAccepted = true;
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  check('confirming the warning leaves the editor', true);
  // The scenario library is complete and safe: duplicate, delete with
  // confirmation, export/import round-trip, rejected files, save conflicts,
  // quota failures, and ruleset/unknown-troop notices. The earlier
  // unsaved-changes guard registered its own dialog handler, which has served
  // its purpose; drop it so the handler below is the only one answering
  // confirmation dialogs from here on.
  page.removeAllListeners('dialog');
  const dialogAction = { next: 'accept' };
  page.on('dialog', async (dialog) => {
    log(`browser dialog: ${dialog.type()} ${dialog.message()}`);
    if (dialogAction.next === 'dismiss') {
      await dialog.dismiss();
    } else {
      await dialog.accept();
    }
    dialogAction.next = 'accept';
  });

  // Duplicate creates a new copy; deleting it asks for confirmation.
  // The previous section already left the editor, so the library is showing.
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const countBeforeDup = await page.getByTestId('scenario-row').count();
  const dupRow = page.getByTestId('scenario-row').filter({ hasText: title });
  await dupRow.getByTestId('duplicate-scenario').click();
  await page.getByText(/Duplicated as/).waitFor({ timeout: 10000 });
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="scenario-row"]').length === expected,
    countBeforeDup + 1,
  );
  check('duplicate adds a new copy', true, `rows=${countBeforeDup} → ${countBeforeDup + 1}`);
  const dupTitles = await page.getByTestId('scenario-row-title').allTextContents();
  check(
    'duplicate suffixes the copy title',
    dupTitles.some((entry) => entry === `${title} (copy)`),
    dupTitles.join(' | '),
  );
  const copyRow = page.getByTestId('scenario-row').filter({ hasText: `${title} (copy)` });
  dialogAction.next = 'dismiss';
  await copyRow.getByTestId('delete-scenario').click();
  await page.waitForTimeout(300);
  check(
    'delete asks for confirmation (dismiss keeps the copy)',
    (await page.getByTestId('scenario-row').count()) === countBeforeDup + 1,
  );
  await copyRow.getByTestId('delete-scenario').click();
  await page.getByText('Scenario deleted.').waitFor({ timeout: 10000 });
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="scenario-row"]').length === expected,
    countBeforeDup,
  );
  check('delete with confirmation removes the copy', true);

  // Persistence steps 2-3: export the finished scenario, delete it from the
  // library, import the file as a new copy with a new identifier and
  // identical content, import the same file again, and prove the two copies
  // are independent. Every value round-trips identical to 0.1 m.
  await page.getByTestId('inspector-title').waitFor({ state: 'detached', timeout: 1000 }).catch(() => {});
  const exportRow = page.getByTestId('scenario-row').filter({ hasText: title }).first();
  await exportRow.getByTestId('open-scenario').click();
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  await page.getByTestId('inspector-width').fill('1400.05');
  await page.getByTestId('inspector-width').blur();
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  const exportUrl = new URL(page.url());
  const exportedId = exportUrl.searchParams.get('scenario');
  const unitsBeforeExport = await page.getByTestId('oob-unit').count();
  const [firstDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.getByTestId('export-open-scenario').click(),
  ]);
  const firstPath = await firstDownload.path();
  const firstJson = readFileSync(firstPath, 'utf8');
  const firstDoc = JSON.parse(firstJson);
  check(
    'export rounds stored values to 0.1 m',
    firstDoc.battlefield.width === 1400.1,
    `width=${firstDoc.battlefield.width}`,
  );
  check(
    'export carries the acceptance units and terrain',
    firstDoc.units.length === 6 &&
      firstDoc.terrainFeatures.length === 7 &&
      firstDoc.sides[0].name === 'Athens' &&
      firstDoc.sides[1].name === 'Sparta',
    `units=${firstDoc.units.length} terrain=${firstDoc.terrainFeatures.length}`,
  );
  const roundTripFile = path.join(reportDir, 'round-trip.json');
  writeFileSync(roundTripFile, firstJson);
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const deleteRow = page.getByTestId('scenario-row').filter({ hasText: title }).first();
  const libCountBeforeDelete = await page.getByTestId('scenario-row').count();
  await deleteRow.getByTestId('delete-scenario').click();
  await page.getByText('Scenario deleted.').waitFor({ timeout: 10000 });
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="scenario-row"]').length === expected,
    libCountBeforeDelete - 1,
  );
  check('persistence step 2 deletes the scenario from the library', true);
  const libCountBefore = await page.getByTestId('scenario-row').count();
  await page.getByTestId('import-file').setInputFiles(roundTripFile);
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  const importedUrl = new URL(page.url());
  const importedId = importedUrl.searchParams.get('scenario');
  check('import assigns a new id', !!importedId && importedId !== exportedId, `${exportedId} → ${importedId}`);
  const importedWidth = await page.getByTestId('inspector-width').inputValue();
  check('import round-trips values identical to 0.1 m', importedWidth === '1400.1', `width=${importedWidth}`);
  check(
    'import restores the units and terrain identical to 0.1 m',
    (await page.getByTestId('oob-unit').count()) === unitsBeforeExport &&
      (await page.getByTestId('terrain-ground-row').count()) === 3 &&
      (await page.getByTestId('terrain-hill-row').count()) === 2 &&
      (await page.getByTestId('terrain-linear-row').count()) === 2 &&
      ((await page.getByTestId('oob-side-a').textContent()) ?? '').includes('Athens'),
  );
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const libCountAfter = await page.getByTestId('scenario-row').count();
  check('import stores a new copy', libCountAfter === libCountBefore + 1, `${libCountBefore} → ${libCountAfter}`);

  // Persistence step 3: importing the same file again stores a second
  // independent copy; editing one never touches the other.
  await page.getByTestId('import-file').setInputFiles(roundTripFile);
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  const secondCopyId = new URL(page.url()).searchParams.get('scenario');
  check(
    'the second import gets its own id',
    !!secondCopyId && secondCopyId !== importedId,
    `${importedId} → ${secondCopyId}`,
  );
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const copiesRow = page.getByTestId('scenario-row').filter({ hasText: title });
  check('two independent copies share the title', (await copiesRow.count()) === 2);
  await copiesRow.nth(0).getByTestId('open-scenario').click();
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  await page.getByTestId('inspector-title').fill('Acceptance plain (edited copy)');
  await page.locator('.map-caption').click();
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const siblingTitles = await page.getByTestId('scenario-row-title').allTextContents();
  check(
    'editing one copy does not change the other',
    siblingTitles.includes('Acceptance plain (edited copy)') && siblingTitles.includes(title),
    siblingTitles.join(' | '),
  );
  const editedRow = page.getByTestId('scenario-row').filter({ hasText: 'Acceptance plain (edited copy)' });
  await editedRow.getByTestId('delete-scenario').click();
  await page.getByText('Scenario deleted.').waitFor({ timeout: 10000 });
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="scenario-row"]').length === expected,
    libCountAfter,
  );
  check('the edited copy deletes, leaving one import', true);

  // Persistence step 5: malformed, wrong-kind, newer-format, unknown-ruleset,
  // and overlapping-units files are each rejected with a specific message and
  // nothing is stored.
  const badJson = path.join(reportDir, 'bad-json.json');
  const badKind = path.join(reportDir, 'bad-kind.json');
  const badVersion = path.join(reportDir, 'bad-version.json');
  const badRuleset = path.join(reportDir, 'bad-ruleset.json');
  const badOverlap = path.join(reportDir, 'bad-overlap.json');
  writeFileSync(badJson, '{{{ not json');
  writeFileSync(badKind, `${JSON.stringify({ kind: 'battle', formatVersion: 1, title: 'Nope' })}\n`);
  writeFileSync(
    badVersion,
    `${JSON.stringify({ kind: 'scenario', formatVersion: 99, title: 'Future', ruleset: { id: 'polis-classical', version: '0.1' } })}\n`,
  );
  writeFileSync(
    badRuleset,
    `${JSON.stringify({ kind: 'scenario', formatVersion: 1, title: 'Foreign', ruleset: { id: 'other-rules', version: '1.0' }, sides: [], units: [], terrainFeatures: [] })}\n`,
  );
  writeFileSync(
    badOverlap,
    `${JSON.stringify({
      kind: 'scenario',
      formatVersion: 1,
      title: 'Overlapping',
      ruleset: { id: 'polis-classical', version: '0.1' },
      battlefield: { width: 1400, height: 900 },
      sides: [
        { id: 'side-a', name: 'Athens', color: '#1d4ed8' },
        { id: 'side-b', name: 'Sparta', color: '#b91c1c' },
      ],
      units: [
        { id: '00000000-0000-4000-8000-000000000001', name: 'First', side: 'side-a', troopType: 'hoplite', soldiers: 100, files: 10, lateralInterval: 1, rankDepth: 1, position: { x: 600, y: 400 }, facing: 0 },
        { id: '00000000-0000-4000-8000-000000000002', name: 'Second', side: 'side-a', troopType: 'hoplite', soldiers: 100, files: 10, lateralInterval: 1, rankDepth: 1, position: { x: 600, y: 400 }, facing: 0 },
      ],
      terrainFeatures: [],
    })}\n`,
  );
  const rowsBeforeBad = await page.getByTestId('scenario-row').count();
  await page.getByTestId('import-file').setInputFiles(badJson);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'not valid JSON',
  );
  const badJsonMsg = await page.getByTestId('import-error').textContent();
  check('malformed file is rejected whole', /not valid JSON/i.test(badJsonMsg ?? ''), badJsonMsg ?? '');
  await page.getByTestId('import-file').setInputFiles(badKind);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'not a scenario',
  );
  const badKindMsg = await page.getByTestId('import-error').textContent();
  check('wrong-kind file is rejected whole', /not a scenario/i.test(badKindMsg ?? ''), badKindMsg ?? '');
  await page.getByTestId('import-file').setInputFiles(badVersion);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'newer than the supported version',
  );
  const badVersionMsg = await page.getByTestId('import-error').textContent();
  check(
    'newer-format file is rejected whole',
    /newer than the supported version/i.test(badVersionMsg ?? ''),
    badVersionMsg ?? '',
  );
  await page.getByTestId('import-file').setInputFiles(badRuleset);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'unknown ruleset',
  );
  const badRulesetMsg = await page.getByTestId('import-error').textContent();
  check(
    'unknown-ruleset file is rejected whole',
    /unknown ruleset/i.test(badRulesetMsg ?? ''),
    badRulesetMsg ?? '',
  );
  await page.getByTestId('import-file').setInputFiles(badOverlap);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'overlap',
  );
  const badOverlapMsg = await page.getByTestId('import-error').textContent();
  check(
    'overlapping-units file is rejected whole',
    /overlap/i.test(badOverlapMsg ?? ''),
    badOverlapMsg ?? '',
  );
  check(
    'rejected files store nothing',
    (await page.getByTestId('scenario-row').count()) === rowsBeforeBad,
    `rows=${rowsBeforeBad}`,
  );

  // Ruleset mismatch and unknown troop-type notices appear as in the tracer.
  const olderRuleset = {
    kind: 'scenario',
    formatVersion: 1,
    id: '00000000-0000-4000-8000-000000000001',
    title: 'E2E Older Ruleset',
    description: '',
    battlefield: { width: 1200, height: 800 },
    sides: [
      { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
      { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
    ],
    ruleset: { id: 'polis-classical', version: '0.0' },
    units: [],
    terrainFeatures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const olderFile = path.join(reportDir, 'older-ruleset.json');
  writeFileSync(olderFile, `${JSON.stringify(olderRuleset, null, 2)}\n`);
  await page.getByTestId('import-file').setInputFiles(olderFile);
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  check('older ruleset imports against the current catalogue', true);
  const rulesetNotice = await page.getByTestId('ruleset-notice').textContent().catch(() => null);
  check(
    'editor shows the ruleset mismatch notice',
    !!rulesetNotice && /Saving rebinds/i.test(rulesetNotice),
    rulesetNotice ?? 'no notice',
  );
  check(
    'editor badges the provisional ruleset',
    await page.getByTestId('provisional-badge').isVisible().catch(() => false),
  );
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });

  const unknownTroop = {
    kind: 'scenario',
    formatVersion: 1,
    id: '00000000-0000-4000-8000-000000000002',
    title: 'E2E Unknown Troop',
    description: '',
    battlefield: { width: 1200, height: 800 },
    sides: [
      { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
      { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
    ],
    ruleset: { id: 'polis-classical', version: '0.1' },
    units: [
      {
        id: '00000000-0000-4000-8000-000000000011',
        name: 'Mystery Unit',
        side: 'side-a',
        troopType: 'mystery-phalanx-xyz',
        soldiers: 100,
        files: 10,
        lateralInterval: 1.8,
        rankDepth: 1.8,
        position: { x: 600, y: 400 },
        facing: 0,
      },
    ],
    terrainFeatures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const unknownFile = path.join(reportDir, 'unknown-troop.json');
  writeFileSync(unknownFile, `${JSON.stringify(unknownTroop, null, 2)}\n`);
  await page.getByTestId('import-file').setInputFiles(unknownFile);
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  const troopWarning = await page.getByTestId('unknown-troop-warning').textContent().catch(() => null);
  check(
    'editor warns about the unknown troop type',
    !!troopWarning && /unknown troop type/i.test(troopWarning),
    troopWarning ?? 'no warning',
  );
  check(
    'order of battle marks the unknown troop type',
    await page.getByTestId('unknown-troop-badge').isVisible().catch(() => false),
  );
  // Persistence step 6: the unknown key saves and survives a reopen verbatim.
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  const reopenedTroopWarning = await page.getByTestId('unknown-troop-warning').textContent().catch(() => null);
  check(
    'the unknown key survives save and reopen',
    !!reopenedTroopWarning && /mystery-phalanx-xyz/i.test(reopenedTroopWarning) &&
      (await page.getByTestId('unknown-troop-badge').isVisible().catch(() => false)),
    reopenedTroopWarning ?? 'no warning',
  );
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });

  // Stored records with an unknown ruleset or a newer format list as
  // unreadable with their cause and offer only raw export or delete.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('polis-scenarios', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('scenarios', 'readwrite');
      const store = tx.objectStore('scenarios');
      const now = new Date().toISOString();
      const base = {
        kind: 'scenario',
        formatVersion: 1,
        title: 'E2E Foreign Ruleset',
        description: '',
        battlefield: { width: 1200, height: 800 },
        sides: [
          { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
          { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
        ],
        units: [],
        terrainFeatures: [],
        createdAt: now,
        updatedAt: now,
      };
      const foreign = { ...base, id: '00000000-0000-4000-8000-000000000021', ruleset: { id: 'other-rules', version: '1.0' } };
      const future = {
        ...base,
        id: '00000000-0000-4000-8000-000000000022',
        title: 'E2E Future Format',
        formatVersion: 99,
        ruleset: { id: 'polis-classical', version: '0.1' },
      };
      store.put({ id: foreign.id, document: foreign, revision: 1, updatedAt: now });
      store.put({ id: future.id, document: future, revision: 1, updatedAt: now });
      tx.oncomplete = () => { db.close(); resolve(undefined); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('scenario-list').waitFor({ timeout: 15000 });
  const foreignRow = page.getByTestId('scenario-row').filter({ hasText: 'E2E Foreign Ruleset' });
  const foreignCause = await foreignRow.getByTestId('scenario-row-cause').textContent().catch(() => null);
  check(
    'library lists the unknown ruleset with its cause',
    !!foreignCause && /unknown ruleset/i.test(foreignCause),
    foreignCause ?? 'no cause',
  );
  check(
    'unreadable entries offer only raw export or delete',
    (await foreignRow.getByTestId('export-raw-scenario').count()) === 1 &&
      (await foreignRow.getByTestId('open-scenario').count()) === 0 &&
      (await foreignRow.getByTestId('duplicate-scenario').count()) === 0,
  );
  const futureRow = page.getByTestId('scenario-row').filter({ hasText: 'E2E Future Format' });
  const futureCause = await futureRow.getByTestId('scenario-row-cause').textContent().catch(() => null);
  check(
    'library lists the newer format with its cause',
    !!futureCause && /newer/i.test(futureCause),
    futureCause ?? 'no cause',
  );

  // A two-tab save conflict is detected and the author chooses how to
  // proceed; nothing is silently overwritten.
  await page.getByTestId('new-scenario-title').fill(`Conflict Probe ${Date.now()}`);
  await page.getByTestId('new-scenario-submit').click();
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  const conflictId = new URL(page.url()).searchParams.get('scenario');
  check('conflict probe opens', !!conflictId, String(conflictId));
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  const page2 = await context.newPage();
  page2.on('console', (message) => log(`browser2 console: ${message.text()}`));
  page2.on('pageerror', (error) => log(`browser2 pageerror: ${String(error)}`));
  await page2.goto(`${base}/?scenario=${encodeURIComponent(conflictId)}`, { waitUntil: 'networkidle' });
  await page2.getByTestId('editor').waitFor({ timeout: 15000 });
  await page2.getByTestId('inspector-title').fill('Conflict Other Tab');
  await page2.getByTestId('inspector-title').blur();
  await page2.getByTestId('save-scenario').click();
  await page2.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  await page.getByTestId('inspector-title').fill('Conflict Mine');
  await page.getByTestId('inspector-title').blur();
  await page.getByTestId('save-scenario').click();
  await page.getByTestId('conflict-dialog').waitFor({ timeout: 10000 });
  const conflictText = await page.getByTestId('conflict-dialog').textContent();
  const conflictRevs = [...(conflictText ?? '').matchAll(/revision (\d+)/g)].map((match) => match[1]);
  check(
    'two-tab save conflict is detected',
    conflictRevs.length >= 2 && conflictRevs[0] !== conflictRevs[1],
    (conflictText ?? '').replace(/\s+/g, ' ').slice(0, 200),
  );
  await page.getByTestId('conflict-cancel').click();
  await page.waitForTimeout(300);
  check('cancel keeps the conflicted edits without storing', !(await page.getByTestId('conflict-dialog').count()));
  await page2.reload({ waitUntil: 'networkidle' });
  await page2.getByTestId('editor').waitFor({ timeout: 15000 });
  const storedAfterCancel = await page2.getByTestId('inspector-title').inputValue();
  check('nothing is silently overwritten on cancel', storedAfterCancel === 'Conflict Other Tab', storedAfterCancel);
  await page.getByTestId('save-scenario').click();
  await page.getByTestId('conflict-dialog').waitFor({ timeout: 10000 });
  await page.getByTestId('conflict-overwrite').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  check('overwrite resolves the conflict', !(await page.getByTestId('conflict-dialog').count()));
  const overwriteStatus = await page.getByTestId('save-status').textContent();
  check('overwrite reports the saved state', overwriteStatus === 'Saved', `status=${overwriteStatus}`);
  await page2.getByTestId('inspector-title').fill('Conflict Stale Tab');
  await page2.getByTestId('inspector-title').blur();
  await page2.getByTestId('save-scenario').click();
  await page2.getByTestId('conflict-dialog').waitFor({ timeout: 10000 });
  await page2.getByTestId('conflict-copy').click();
  await page2.getByText(/Saved as a new copy/).waitFor({ timeout: 10000 });
  const copyId = new URL(page2.url()).searchParams.get('scenario');
  check('save as copy keeps both versions', !!copyId && copyId !== conflictId, `${conflictId} → ${copyId}`);
  await page2.close();

  // A quota failure is reported without losing the open scenario.
  await page.evaluate(() => {
    const proto = IDBObjectStore.prototype;
    const original = proto.put;
    let fired = false;
    proto.put = function put(...args) {
      if (!fired) {
        fired = true;
        proto.put = original;
        const failure = new Error('QuotaExceededError: storage is full');
        failure.name = 'QuotaExceededError';
        throw failure;
      }
      return original.apply(this, args);
    };
  });
  await page.getByTestId('inspector-title').fill('Conflict Mine Quota');
  await page.getByTestId('inspector-title').blur();
  await page.getByTestId('save-scenario').click();
  await page.getByTestId('save-error').waitFor({ timeout: 10000 });
  const quotaMsg = await page.getByTestId('save-error').textContent();
  check(
    'quota failure is reported without losing edits',
    /quota/i.test(quotaMsg ?? '') || /storage is full/i.test(quotaMsg ?? ''),
    quotaMsg ?? 'no message',
  );
  check(
    'open scenario survives the quota failure',
    (await page.getByTestId('inspector-title').inputValue()) === 'Conflict Mine Quota' &&
      (await page.getByTestId('unsaved-pill').count()) === 1,
  );
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  check('save succeeds after the quota failure', true);

  // A refused persistent-storage request is reported in the library.
  const storageContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  await storageContext.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'storage', {
        value: {
          persist: async () => false,
          persisted: async () => false,
        },
        configurable: true,
      });
    } catch {
      // The storage note simply stays silent when it cannot be stubbed.
    }
  });
  const storagePage = await storageContext.newPage();
  storagePage.on('console', (message) => log(`storage console: ${message.text()}`));
  storagePage.on('pageerror', (error) => log(`storage pageerror: ${String(error)}`));
  await storagePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await storagePage.getByTestId('app').waitFor({ timeout: 15000 });
  await storagePage.getByTestId('new-scenario-title').fill(`Storage Probe ${Date.now()}`);
  await storagePage.getByTestId('new-scenario-submit').click();
  await storagePage.getByTestId('editor').waitFor({ timeout: 15000 });
  await storagePage.getByTestId('save-scenario').click();
  await storagePage.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  await storagePage.getByTestId('back-to-library').click();
  await storagePage.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const storageNote = await storagePage.getByTestId('storage-note').textContent();
  check(
    'refused persistent storage is reported',
    /refused|evicted|only backup/i.test(storageNote ?? ''),
    (storageNote ?? '').replace(/\s+/g, ' ').slice(0, 200),
  );
  await storageContext.close();

  // Issue #83: battle flow — setup, refusal, Begin, one turn each way, and
  // resume. Runs in a fresh context with a fixed programmatic seed (there is
  // no seed field in the UI: the seed is drawn at Begin).
  const battleContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const battlePage = await battleContext.newPage();
  battlePage.on('console', (message) => log(`battle console: ${message.text()}`));
  battlePage.on('pageerror', (error) => log(`battle pageerror: ${String(error)}`));
  battlePage.on('dialog', async (dialog) => {
    log(`battle dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await battlePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await battlePage.getByTestId('app').waitFor({ timeout: 15000 });
  await battlePage.evaluate(() => {
    window.__POLIS_TEST_SEED = 7;
  });

  const battleTitle = `Battle Probe ${Date.now()}`;
  await battlePage.getByTestId('new-scenario-title').fill(battleTitle);
  await battlePage.getByTestId('new-scenario-submit').click();
  await battlePage.getByTestId('editor').waitFor({ timeout: 15000 });

  // The editor offers Start battle only without unsaved changes.
  check(
    'start battle is available when the scenario is saved',
    await battlePage.getByTestId('start-battle-editor').isEnabled(),
  );
  const editedBattleTitle = `${battleTitle} edited`;
  await battlePage.getByTestId('inspector-title').fill(editedBattleTitle);
  await battlePage.getByTestId('inspector-title').blur();
  check(
    'start battle is disabled with unsaved changes',
    await battlePage.getByTestId('start-battle-editor').isDisabled(),
  );
  await battlePage.getByTestId('save-scenario').click();
  await battlePage.getByText('Scenario saved.').waitFor({ timeout: 10000 });

  // The empty scenario is unplayable: Begin refuses with every problem.
  await battlePage.getByTestId('start-battle-editor').click();
  await battlePage.getByTestId('battle-setup').waitFor({ timeout: 10000 });
  const setupNameA = await battlePage.getByTestId('setup-side-name-side-a').textContent();
  const setupNameB = await battlePage.getByTestId('setup-side-name-side-b').textContent();
  check(
    'setup shows both side names and colours',
    setupNameA === 'Athenians' && setupNameB === 'Spartans',
    `${setupNameA} | ${setupNameB}`,
  );
  check(
    'setup defaults both controllers to human',
    (await battlePage.getByTestId('controller-side-a').inputValue()) === 'human' &&
      (await battlePage.getByTestId('controller-side-b').inputValue()) === 'human',
  );
  const setupRuleset = await battlePage.getByTestId('setup-ruleset').textContent();
  check(
    'setup shows the ruleset version',
    /polis-classical/.test(setupRuleset ?? ''),
    setupRuleset ?? 'no ruleset',
  );
  check(
    'setup has no seed field',
    (await battlePage.getByTestId('battle-seed').count()) === 0,
  );
  await battlePage.getByTestId('begin-battle').click();
  await battlePage.getByTestId('playability-refusal').waitFor({ timeout: 10000 });
  const problems = await battlePage.getByTestId('playability-problem').allTextContents();
  check(
    'unplayable scenario is refused with every problem',
    problems.length === 2 && problems.every((problem) => /fields no units/.test(problem)),
    problems.join(' | '),
  );
  check(
    'refusal offers open in editor',
    await battlePage.getByTestId('open-in-editor').isVisible(),
  );
  await battlePage.getByTestId('setup-back').click();
  await battlePage.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  check(
    'refused begin creates no battle',
    await battlePage.getByTestId('empty-battles').isVisible(),
  );

  // Refusal names each unit and its reason: import an unplayable fixture with
  // two bad units and start the battle from the library row.
  const unplayableTitle = `E2E Unplayable ${Date.now()}`;
  const unplayable = {
    kind: 'scenario',
    formatVersion: 1,
    id: '00000000-0000-4000-8000-000000000083',
    title: unplayableTitle,
    description: '',
    battlefield: { width: 1200, height: 800 },
    sides: [
      { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
      { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
    ],
    ruleset: { id: 'polis-classical', version: '0.1' },
    units: [
      {
        id: '00000000-0000-4000-8000-000000000084',
        name: 'Mystery Unit',
        side: 'side-a',
        troopType: 'mystery-phalanx-xyz',
        soldiers: 100,
        files: 10,
        lateralInterval: 1.8,
        rankDepth: 1.8,
        position: { x: 200, y: 200 },
        facing: 0,
      },
      {
        id: '00000000-0000-4000-8000-000000000085',
        name: 'Wide Unit',
        side: 'side-b',
        troopType: 'hoplite',
        soldiers: 100,
        files: 10,
        lateralInterval: 99,
        rankDepth: 1.8,
        position: { x: 1000, y: 600 },
        facing: 180,
      },
    ],
    terrainFeatures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const unplayableFile = path.join(reportDir, 'unplayable.json');
  writeFileSync(unplayableFile, `${JSON.stringify(unplayable, null, 2)}\n`);
  await battlePage.getByTestId('import-file').setInputFiles(unplayableFile);
  await battlePage.getByTestId('editor').waitFor({ timeout: 15000 });
  await battlePage.getByTestId('back-to-library').click();
  await battlePage.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const unplayableRow = battlePage.getByTestId('scenario-row').filter({ hasText: unplayableTitle });
  await unplayableRow.getByTestId('start-battle').click();
  await battlePage.getByTestId('battle-setup').waitFor({ timeout: 10000 });
  await battlePage.getByTestId('begin-battle').click();
  await battlePage.getByTestId('playability-refusal').waitFor({ timeout: 10000 });
  const unitProblems = await battlePage.getByTestId('playability-problem').allTextContents();
  check(
    'refusal names each unit and its reason',
    unitProblems.length === 2 &&
      unitProblems.some((problem) => /Mystery Unit/.test(problem) && /unknown troop-type/.test(problem)) &&
      unitProblems.some((problem) => /Wide Unit/.test(problem) && /lateralInterval/.test(problem)),
    unitProblems.join(' | '),
  );
  check(
    'library refusal offers open in editor',
    await battlePage.getByTestId('open-in-editor').isVisible(),
  );
  await battlePage.getByTestId('open-in-editor').click();
  await battlePage.getByTestId('editor').waitFor({ timeout: 15000 });
  check(
    'open in editor opens the refused scenario',
    (await battlePage.getByTestId('header-title').textContent()) === unplayableTitle,
  );
  await battlePage.getByTestId('back-to-library').click();
  await battlePage.getByTestId('scenario-list').waitFor({ timeout: 10000 });

  // Make the scenario playable: one unit per side, then Human vs Passive.
  const playableRow = battlePage.getByTestId('scenario-row').filter({ hasText: editedBattleTitle });
  await playableRow.getByTestId('open-scenario').click();
  await battlePage.getByTestId('editor').waitFor({ timeout: 15000 });
  await battlePage.getByTestId('oob-tab-0').click();
  await battlePage.getByTestId('oob-add').click();
  await battlePage.getByTestId('oob-tab-1').click();
  await battlePage.getByTestId('oob-add').click();
  await battlePage.getByTestId('save-scenario').click();
  await battlePage.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  await battlePage.getByTestId('start-battle-editor').click();
  await battlePage.getByTestId('battle-setup').waitFor({ timeout: 10000 });
  await battlePage.getByTestId('controller-side-b').selectOption('passive');
  await battlePage.getByTestId('begin-battle').click();
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: 15000 });

  // Layout A: order of battle, map, inspector, and the bottom turn bar.
  check(
    'battle screen shows the order of battle',
    (await battlePage.getByTestId('battle-oob-side-a').isVisible()) &&
      (await battlePage.getByTestId('battle-oob-side-b').isVisible()),
  );
  check(
    'battle screen shows the read-only shared map',
    (await battlePage.getByTestId('battle-map-caption').isVisible()) &&
      /read-only/.test((await battlePage.getByTestId('battle-map-caption').textContent()) ?? ''),
  );
  check(
    'battle screen shows the inspector',
    await battlePage.getByTestId('battle-inspector').isVisible(),
  );
  const roundText = await battlePage.getByTestId('round').textContent();
  check(
    'turn bar shows round and round limit',
    /Round 1 \/ \d+ · Turn 1/.test(roundText ?? ''),
    roundText ?? 'no round',
  );
  check(
    'turn bar shows the active side and phase',
    (await battlePage.getByTestId('active-side').isVisible()) &&
      /Phase:/.test((await battlePage.getByTestId('turnbar-phase').textContent()) ?? ''),
  );
  check(
    'battle URL carries the battle id',
    new URL(battlePage.url()).searchParams.has('battle'),
    battlePage.url(),
  );
  const announcement = await battlePage.getByTestId('starting-announcement').textContent();
  check(
    'the starting side is announced',
    /begins — round 1, turn 1/.test(announcement ?? ''),
    announcement ?? 'no announcement',
  );

  // One turn each way: the human side commits an empty turn (with
  // confirmation) and the automated side resolves through the runner and
  // waits for Continue. The starting side is seed-drawn, so either order.
  async function resolveOneTurn() {
    const controller = (await battlePage.getByTestId('turn-controller').textContent()) ?? '';
    if (controller.startsWith('human')) {
      await battlePage.getByTestId('commit-empty').click();
      await battlePage.getByTestId('commit-confirm').waitFor({ timeout: 10000 });
      await battlePage.getByTestId('confirm-commit').click();
    } else {
      check(
        'automated side is labelled a test player',
        /test player/.test(controller),
        controller,
      );
      await battlePage.getByTestId('continue-turn').click();
    }
  }
  await resolveOneTurn();
  await battlePage.getByTestId('turn-result').waitFor({ timeout: 15000 });
  const afterFirst = await battlePage.getByTestId('round').textContent();
  check(
    'the first committed turn resolves',
    afterFirst !== roundText,
    `${roundText} → ${afterFirst}`,
  );
  await resolveOneTurn();
  await battlePage.waitForTimeout(500);
  const afterSecond = await battlePage.getByTestId('round').textContent();
  check(
    'one turn each way resolves',
    afterSecond !== afterFirst,
    `${afterFirst} → ${afterSecond}`,
  );
  check(
    'resolved turns appear on the battle log',
    ((await battlePage.getByTestId('battle-log').textContent()) ?? '').length > 0,
  );

  // Reloading mid-battle resumes the identical state from the Battles list.
  await battlePage.reload({ waitUntil: 'networkidle' });
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: 15000 });
  check(
    'reloading resumes the same battle state',
    (await battlePage.getByTestId('round').textContent()) === afterSecond,
    (await battlePage.getByTestId('round').textContent()) ?? 'no round',
  );
  await battlePage.getByTestId('back-to-battles').click();
  await battlePage.getByTestId('battles-list').waitFor({ timeout: 10000 });
  const battleRows = battlePage.getByTestId('battle-row');
  check('the battles list resumes the battle in progress', (await battleRows.count()) === 1);
  const battleRowMeta = await battlePage.getByTestId('battle-row-meta').textContent();
  check(
    'the battles list shows the in-progress battle',
    /In progress/.test(battleRowMeta ?? ''),
    battleRowMeta ?? 'no meta',
  );
  await battleRows.first().getByTestId('resume-battle').click();
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: 15000 });
  check(
    'resume from the battles list restores the same state',
    (await battlePage.getByTestId('round').textContent()) === afterSecond,
  );
  await battlePage.getByTestId('back-to-battles').click();
  await battlePage.getByTestId('battles-list').waitFor({ timeout: 10000 });
  await battlePage.getByTestId('delete-battle').click();
  await battlePage.getByTestId('empty-battles').waitFor({ timeout: 10000 });
  check('deleting removes the battle', true);

  // Issue #84: Move drafting — available actions and allowance come from the
  // engine, an accepted Move shows a ghost preview, a colliding Move is
  // rejected inline with a highlight, reordering revalidates, and committing
  // applies the turn and saves the battle. Fresh storage, fixed seed.
  const moveContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const movePage = await moveContext.newPage();
  movePage.on('console', (message) => log(`move console: ${message.text()}`));
  movePage.on('pageerror', (error) => log(`move pageerror: ${String(error)}`));
  movePage.on('dialog', async (dialog) => {
    log(`move dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await movePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await movePage.getByTestId('app').waitFor({ timeout: 15000 });
  await movePage.evaluate(() => {
    window.__POLIS_TEST_SEED = 7;
  });

  const moveTitle = `Move Draft Probe ${Date.now()}`;
  await movePage.getByTestId('new-scenario-title').fill(moveTitle);
  await movePage.getByTestId('new-scenario-submit').click();
  await movePage.getByTestId('editor').waitFor({ timeout: 15000 });

  // Two side-a units and one side-b unit, placed apart with known facings.
  async function addMoveUnit(sideLabel, x, y, facing) {
    await movePage.getByTestId('oob-add').click();
    await movePage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await movePage.getByTestId('unit-position-x').fill(String(x));
    await movePage.locator('.map-caption').click();
    await movePage.getByTestId('unit-position-y').fill(String(y));
    await movePage.locator('.map-caption').click();
    await movePage.getByTestId('unit-facing').fill(String(facing));
    await movePage.locator('.map-caption').click();
  }
  await addMoveUnit('Athenians', 500, 600, 180);
  await addMoveUnit('Athenians', 750, 620, 180);
  await addMoveUnit('Spartans', 600, 300, 0);
  check(
    'move drafting fields two side-a units and one side-b unit',
    (await movePage.getByTestId('oob-unit').count()) === 3,
  );
  await movePage.getByTestId('save-scenario').click();
  await movePage.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  await movePage.getByTestId('start-battle-editor').click();
  await movePage.getByTestId('battle-setup').waitFor({ timeout: 10000 });
  await movePage.getByTestId('controller-side-b').selectOption('passive');
  await movePage.getByTestId('begin-battle').click();
  await movePage.getByTestId('battle-screen').waitFor({ timeout: 15000 });

  // Reach the human turn: the starting side is seed-drawn, so resolve the
  // automated side first when it starts.
  for (let step = 0; step < 4; step += 1) {
    const controller = (await movePage.getByTestId('turn-controller').textContent()) ?? '';
    if (controller.startsWith('human')) break;
    await movePage.getByTestId('continue-turn').click();
    await movePage.waitForTimeout(800);
  }
  check(
    'move drafting starts on the human turn',
    ((await movePage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );

  // Map metres (y up from the south-west corner) to client pixels through the
  // live SVG viewBox, so draft legs land on exact points.
  async function clickBattleMap(atX, atY) {
    const svg = movePage.getByTestId('battlefield-map');
    const box = await svg.boundingBox();
    const viewBox = ((await svg.getAttribute('viewBox')) ?? '0 0 1200 800')
      .split(/\s+/)
      .map(Number);
    const fieldH = Number(await svg.getAttribute('data-height'));
    const clientX = box.x + ((atX - viewBox[0]) / viewBox[2]) * box.width;
    const clientY = box.y + ((fieldH - atY - viewBox[1]) / viewBox[3]) * box.height;
    await movePage.mouse.click(clientX, clientY);
  }
  await movePage.getByTestId('fit-view').click();
  await movePage.waitForTimeout(300);

  const ownUnits = movePage
    .getByTestId('battle-oob-side-a')
    .getByTestId('battle-oob-unit');
  const id1 = await ownUnits.nth(0).getAttribute('data-unit-id');
  const id2 = await ownUnits.nth(1).getAttribute('data-unit-id');
  await ownUnits.nth(0).click();
  check(
    'inspector shows the engine Move permission and 90 m allowance',
    ((await movePage.getByTestId('battle-unit-permitted').textContent()) ?? '').includes('Move') &&
      (await movePage.getByTestId('battle-unit-allowance').textContent()) === '90 m',
  );
  check(
    'inspector lists the unavailable order reasons from the engine',
    await movePage.getByTestId('battle-unit-unavailable').isVisible(),
  );

  // An accepted Move: 60 m south, inside the 90 m allowance, shows its ghost.
  await movePage.getByTestId(`start-draft-${id1}`).click();
  await movePage.getByTestId(`draft-editor-${id1}`).waitFor({ timeout: 10000 });
  await clickBattleMap(500, 540);
  await movePage.getByTestId(`draft-accepted-${id1}`).waitFor({ timeout: 10000 });
  check('an accepted Move shows its detail', true);
  check(
    'an accepted Move shows a ghost footprint',
    (await movePage.getByTestId('draft-ghost').count()) >= 1,
  );

  // A colliding Move: the second unit ends on the first unit's destination,
  // so the engine rejects it and names the conflict.
  await ownUnits.nth(1).click();
  await movePage.getByTestId(`start-draft-${id2}`).click();
  await clickBattleMap(500, 540);
  await movePage.getByTestId(`draft-rejection-${id2}`).waitFor({ timeout: 10000 });
  const rejectionText = await movePage.getByTestId(`draft-rejection-${id2}`).textContent();
  check(
    'a colliding Move is rejected inline',
    /collid/i.test(rejectionText ?? ''),
    (rejectionText ?? '').replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    'commit is disabled while an order is rejected',
    await movePage.getByTestId('commit-draft').isDisabled(),
  );
  check(
    'the rejected Move highlights its conflict',
    (await movePage
      .locator(`[data-testid="map-unit"][data-unit-id="${id1}"]`)
      .getAttribute('data-conflict')) === 'true' &&
      (await movePage.getByTestId('conflict-marker').count()) >= 1,
  );

  // Reordering revalidates: the rejected draft moves first and the collision
  // follows the new order, so the commit stays blocked.
  await movePage.getByTestId(`move-draft-down-${id1}`).click();
  await movePage.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-testid="draft-list"] .draft-rows > li')
        ?.getAttribute('data-testid') === expected,
    `draft-${id2}`,
  );
  check('reordering moves the rejected draft first', true);
  check(
    'reordering keeps the commit blocked',
    await movePage.getByTestId('commit-draft').isDisabled(),
  );

  // Removing the rejected draft enables the commit; committing applies the
  // turn and the round advances.
  await movePage.getByTestId(`remove-draft-${id2}`).click();
  await movePage.waitForFunction(
    () => document.querySelector('[data-testid="commit-draft"]')?.disabled === false,
  );
  check('removing the rejected draft enables the commit', true);
  const moveRoundBefore = await movePage.getByTestId('round').textContent();
  await movePage.getByTestId('commit-draft').click();
  await movePage.getByTestId('turn-result').waitFor({ timeout: 15000 });
  await movePage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    moveRoundBefore,
  );
  const moveRoundAfter = await movePage.getByTestId('round').textContent();
  check(
    'committing applies the turn',
    moveRoundAfter !== moveRoundBefore,
    `${moveRoundBefore} → ${moveRoundAfter}`,
  );

  // The committed turn is saved: reload resumes it, the battles list shows one
  // row, resume restores it, and delete clears the list.
  await movePage.reload({ waitUntil: 'networkidle' });
  await movePage.getByTestId('battle-screen').waitFor({ timeout: 15000 });
  check(
    'reloading resumes the committed turn',
    (await movePage.getByTestId('round').textContent()) === moveRoundAfter,
  );
  await movePage.getByTestId('back-to-battles').click();
  await movePage.getByTestId('battles-list').waitFor({ timeout: 10000 });
  check('the battles list shows the committed battle', (await movePage.getByTestId('battle-row').count()) === 1);
  await movePage.getByTestId('resume-battle').click();
  await movePage.getByTestId('battle-screen').waitFor({ timeout: 15000 });
  check(
    'resume restores the committed turn',
    (await movePage.getByTestId('round').textContent()) === moveRoundAfter,
  );
  await movePage.getByTestId('back-to-battles').click();
  await movePage.getByTestId('battles-list').waitFor({ timeout: 10000 });
  await movePage.getByTestId('delete-battle').click();
  await movePage.getByTestId('empty-battles').waitFor({ timeout: 10000 });
  check('deleting clears the committed battle', true);

  await moveContext.close();

  await battleContext.close();

  try {
    await context.tracing.stop({ path: path.join(reportDir, 'trace.zip') });
    check('playwright trace recorded', existsSync(path.join(reportDir, 'trace.zip')));
  } catch (traceError) {
    check('playwright trace recorded', false, String(traceError).split('\n')[0]);
  }
  await context.close();
} catch (error) {
  check('browser test completes', false, String(error).split('\n')[0]);
  try {
    await context.tracing.stop({ path: path.join(reportDir, 'trace.zip') });
  } catch {
    // The trace is best-effort on an already-torn-down context.
  }
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}

const pass = checks.length > 0 && checks.every((entry) => entry.pass);
writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({ pass, checks }, null, 2)}\n`);
writeFileSync(path.join(reportDir, 'trace.log'), `${trace.join('\n')}\n`);
if (pass) {
  console.log(`test:e2e: PASS (${checks.length} checks, report in e2e-report/)`);
} else {
  console.error('test:e2e: FAIL (see e2e-report/)');
}
process.exit(pass ? 0 : 1);
