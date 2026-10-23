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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
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
