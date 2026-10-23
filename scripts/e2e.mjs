// Headless end-to-end test of the walking skeleton against the production
// build: create → empty battlefield → save → reload → reopen.
//
// Serves `out/` (run `npm run build` first) over loopback HTTP and drives a
// headless browser through the first end-to-end path: an author creates a
// scenario with a title, lands in the editor on an empty battlefield, saves,
// reloads, and reopens the scenario from the library with identical values.
// Records `e2e-report/report.json` plus `e2e-report/trace.log` for the CI
// artifact upload.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  const page = await context.newPage();
  page.on('console', (message) => log(`browser console: ${message.text()}`));
  page.on('pageerror', (error) => log(`browser pageerror: ${String(error)}`));

  const title = `E2E Probe ${Date.now()}`;

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
    Number(coordMatch[1]) <= 1200 &&
    Number(coordMatch[2]) >= 0 &&
    Number(coordMatch[2]) <= 800;
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
      (reopenedDims?.includes('1200 × 800') ?? false) &&
      inspectorTitle === title &&
      inspectorWidth === '1200' &&
      inspectorHeight === '800' &&
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
    (await groundRow.count()) === 1,
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
    (await groundRow.count()) === 1,
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
  check('deleting the area removes its row', (await groundRow.count()) === 0);
  await page.getByTestId('undo').click();
  check('undo restores the deleted area', (await groundRow.count()) === 1);

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

  // Export then import round-trips every value identical to 0.1 m; the import
  // gets a new id.
  await page.getByTestId('inspector-title').waitFor({ state: 'detached', timeout: 1000 }).catch(() => {});
  const exportRow = page.getByTestId('scenario-row').filter({ hasText: title });
  await exportRow.getByTestId('open-scenario').click();
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  await page.getByTestId('inspector-width').fill('1200.05');
  await page.getByTestId('inspector-width').blur();
  await page.getByTestId('save-scenario').click();
  await page.getByText('Scenario saved.').waitFor({ timeout: 10000 });
  const exportUrl = new URL(page.url());
  const exportedId = exportUrl.searchParams.get('scenario');
  const [firstDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.getByTestId('export-open-scenario').click(),
  ]);
  const firstPath = await firstDownload.path();
  const firstJson = readFileSync(firstPath, 'utf8');
  const firstDoc = JSON.parse(firstJson);
  check(
    'export rounds stored values to 0.1 m',
    firstDoc.battlefield.width === 1200.1,
    `width=${firstDoc.battlefield.width}`,
  );
  const roundTripFile = path.join(reportDir, 'round-trip.json');
  writeFileSync(roundTripFile, firstJson);
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const libCountBefore = await page.getByTestId('scenario-row').count();
  await page.getByTestId('import-file').setInputFiles(roundTripFile);
  await page.getByTestId('editor').waitFor({ timeout: 15000 });
  const importedUrl = new URL(page.url());
  const importedId = importedUrl.searchParams.get('scenario');
  check('import assigns a new id', !!importedId && importedId !== exportedId, `${exportedId} → ${importedId}`);
  const importedWidth = await page.getByTestId('inspector-width').inputValue();
  check('import round-trips values identical to 0.1 m', importedWidth === '1200.1', `width=${importedWidth}`);
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: 10000 });
  const libCountAfter = await page.getByTestId('scenario-row').count();
  check('import stores a new copy', libCountAfter === libCountBefore + 1, `${libCountBefore} → ${libCountAfter}`);

  // Malformed, wrong-kind, and newer-format files are rejected with specific
  // messages and nothing is stored.
  const badJson = path.join(reportDir, 'bad-json.json');
  const badKind = path.join(reportDir, 'bad-kind.json');
  const badVersion = path.join(reportDir, 'bad-version.json');
  writeFileSync(badJson, '{{{ not json');
  writeFileSync(badKind, `${JSON.stringify({ kind: 'battle', formatVersion: 1, title: 'Nope' })}\n`);
  writeFileSync(
    badVersion,
    `${JSON.stringify({ kind: 'scenario', formatVersion: 99, title: 'Future', ruleset: { id: 'polis-classical', version: '0.1' } })}\n`,
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

  await context.close();
} catch (error) {
  check('browser test completes', false, String(error).split('\n')[0]);
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
