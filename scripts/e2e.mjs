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
