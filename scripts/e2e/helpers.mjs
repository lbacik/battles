// Shared helpers for the end-to-end runner (`npm run test:e2e`).
//
// Moved verbatim from the preamble of scripts/e2e.mjs: trace and check
// helpers, timeout budgets, reusable page helpers, the static server,
// and the failure reporter. The API is the existing helper functions,
// unchanged; chapters import what they use and receive `check` and
// `log` through the shared run context.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const outDir = path.join(root, 'out');
export const reportDir = path.join(root, 'e2e-report');

export const trace = [];
export function log(line) {
  trace.push(`${new Date().toISOString()} ${line}`);
}

export const checks = [];
export function check(name, pass, detail = '') {
  checks.push({ name, pass, detail });
  log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

// Timeout budgets for slower machines (issue #137): CI passes with 10-15 s
// waits, but a loaded small board (e.g. Raspberry Pi 5, 1.5-4 arm64 cores)
// needs multiples of that for IndexedDB saves, first paints, and battle
// resolutions. Longer budgets only delay a real failure — every passing wait
// returns early — so the suite stays fast on CI and stops flaking on slow
// hardware. Bare Playwright waits and clicks inherit the longest budget
// through setDefaultTimeout (applied to every context below).
export const T_SAVE = 30000;
export const T_LOAD = 30000;
export const T_BATTLE = 60000;
export const SETTLE_MS = 1000;
export const STEP_MS = 1500;
export const LAYOUT_MS = 1500;

// Waits for the save just clicked to settle through stable app state, not
// the transient "Scenario saved." toast (2.4 s): the toast can already be
// gone — or still show the previous save — when the wait polls, so a
// toast-only wait flakes both ways on slow machines. The editor exposes the
// saving flag on save-status (data-saving); the clicked save flips it to
// "true" and settles back to "false" with "Saved" once the store lands.
// Observing the in-flight save first ties the wait to the click just made.
export async function waitForSave(page) {
  await page
    .waitForFunction(
      () =>
        document.querySelector('[data-testid="save-status"]')?.getAttribute('data-saving') ===
        'true',
      null,
      { timeout: 5000 },
    )
    .catch(() => {});
  await page.waitForFunction(
    () => {
      const status = document.querySelector('[data-testid="save-status"]');
      return (
        status?.getAttribute('data-saving') === 'false' &&
        (status.textContent ?? '').includes('Saved')
      );
    },
    null,
    { timeout: T_SAVE },
  );
}

// Presses the device handoff and waits for the settled state behind it,
// never for the transient gap in between. Clicking a handoff for a human
// side unlocks drafting (commit-empty appears); clicking one for an
// automated side resolves at once behind a fresh handoff for the next side
// (its text changes) or behind the battle outcome. While the automated turn
// resolves neither is on screen yet, so waiting for "handoff gone" or for
// the pre-click handoff still showing both race (issue #137): the wait can
// miss the gap or pass on the stale handoff before React clears it. Waiting
// for a changed handoff, drafting controls, or the outcome is stable.
export async function clickHandoffAndSettle(battlePage) {
  const handoffBefore = (await battlePage.getByTestId('handoff').textContent()) ?? '';
  await battlePage.getByTestId('handoff').click();
  await battlePage.waitForFunction(
    (previous) => {
      if (document.querySelector('[data-testid="battle-outcome"]')) return true;
      if (document.querySelector('[data-testid="commit-empty"]')) return true;
      if (document.querySelector('[data-testid="continue-turn"]')) return true;
      const handoff = document.querySelector('[data-testid="handoff"]');
      return !!handoff && handoff.textContent !== previous;
    },
    handoffBefore,
    { timeout: T_BATTLE },
  );
}

// Terrain rows live in the Map editor tab, while the editor reopens on the
// battle tab. Count them there and return to the battle tab.
export async function terrainRowCounts(page) {
  await page.getByTestId('mode-map').click();
  const counts = {
    ground: await page.getByTestId('terrain-ground-row').count(),
    hill: await page.getByTestId('terrain-hill-row').count(),
    linear: await page.getByTestId('terrain-linear-row').count(),
  };
  await page.getByTestId('mode-battle').click();
  return counts;
}

export function serveStatic(dir) {
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

export function failReport(reason) {
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(path.join(reportDir, 'report.json'), `${JSON.stringify({ pass: false, checks }, null, 2)}\n`);
  writeFileSync(path.join(reportDir, 'trace.log'), `${trace.join('\n')}\n`);
  console.error(`test:e2e: ${reason} (see e2e-report/)`);
}
