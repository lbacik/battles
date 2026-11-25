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
// side unlocks drafting (commit-empty or commit-draft appears); clicking one
// for an automated side resolves at once behind a fresh handoff for the next
// side (its text changes) or behind the battle outcome. While the automated
// turn resolves the runner shows a disabled Continue ("Resolving\u2026"): it is
// transient, never a settled state, so it is deliberately not awaited here
// (issue #157). Waiting for a changed handoff, drafting controls, or the
// outcome is stable (issue #137).
export async function clickHandoffAndSettle(battlePage) {
  const handoffBefore = (await battlePage.getByTestId('handoff').textContent()) ?? '';
  await battlePage.getByTestId('handoff').click();
  await battlePage.waitForFunction(
    (previous) => {
      if (document.querySelector('[data-testid="battle-outcome"]')) return true;
      if (document.querySelector('[data-testid="commit-empty"]')) return true;
      if (document.querySelector('[data-testid="commit-draft"]')) return true;
      const handoff = document.querySelector('[data-testid="handoff"]');
      return !!handoff && handoff.textContent !== previous;
    },
    handoffBefore,
    { timeout: T_BATTLE },
  );
}

// Waits for a settled turn state: the battle outcome, the device handoff, an
// enabled Continue for the settled automated first turn, or unlocked human
// drafting (commit-empty/commit-draft with no handoff). The disabled
// Continue shown while an automated turn resolves through the handoff is
// transient and never counts as settled (issue #157): the wait keeps pending
// until the fresh handoff, drafting controls, or outcome behind it appears.
export async function waitForSettledTurn(battlePage) {
  await battlePage.waitForFunction(
    () => {
      if (document.querySelector('[data-testid="battle-outcome"]')) return true;
      if (document.querySelector('[data-testid="handoff"]')) return true;
      const cont = document.querySelector('[data-testid="continue-turn"]');
      if (cont && !cont.disabled) return true;
      if (document.querySelector('[data-testid="commit-empty"]')) return true;
      if (document.querySelector('[data-testid="commit-draft"]')) return true;
      return false;
    },
    null,
    { timeout: T_BATTLE },
  );
}

// Advances to unlocked human drafting, no matter which side started and
// whether the automated side is still waiting or has already resolved
// (issue #157). Each step waits for a settled state first, then acts on what
// is actually showing: a handoff is pressed, a settled Continue is pressed,
// drafting controls mean arrival. The transient disabled Continue while an
// automated turn resolves is never pressed. Controller text alone never
// decides: a human controller behind its own handoff still locks drafting.
export async function reachHumanTurn(battlePage, maxSteps = 10) {
  for (let step = 0; step < maxSteps; step += 1) {
    await waitForSettledTurn(battlePage);
    if ((await battlePage.getByTestId('battle-outcome').count()) > 0) return;
    if ((await battlePage.getByTestId('handoff').count()) > 0) {
      await clickHandoffAndSettle(battlePage);
      continue;
    }
    if ((await battlePage.getByTestId('commit-empty').count()) > 0) return;
    if ((await battlePage.getByTestId('commit-draft').count()) > 0) return;
    if ((await battlePage.getByTestId('continue-turn').count()) > 0) {
      const enabled = await battlePage.getByTestId('continue-turn').isEnabled().catch(() => false);
      if (enabled) {
        const turnBefore = await battlePage.getByTestId('round').textContent();
        await battlePage.getByTestId('continue-turn').click();
        await battlePage.waitForFunction(
          (expected) =>
            document.querySelector('[data-testid="round"]')?.textContent !== expected ||
            document.querySelector('[data-testid="handoff"]') ||
            document.querySelector('[data-testid="battle-outcome"]'),
          turnBefore,
          { timeout: T_BATTLE },
        );
        continue;
      }
    }
  }
  if ((await battlePage.getByTestId('handoff').count()) > 0) {
    await clickHandoffAndSettle(battlePage);
  }
}

// Waits until the inspector for one unit offers an order kind: the permitted
// list names it and its in-place start button is present and enabled. Reading
// immediately after selecting a unit races slow renders (issue #157): the
// inspector may still show the previous unit, so the settled offer is awaited
// before the check and the draft click that follows it.
export async function waitForInspectorOffer(battlePage, unitId, kind) {
  const testId = `start-${kind.toLowerCase()}-${unitId}`;
  await battlePage.waitForFunction(
    ({ expectedTestId, expectedKind }) => {
      const permitted = document.querySelector('[data-testid="battle-unit-permitted"]')?.textContent ?? '';
      if (!permitted.includes(expectedKind)) return false;
      const button = document.querySelector(`[data-testid="${expectedTestId}"]`);
      return !!button && !button.disabled;
    },
    { expectedTestId: testId, expectedKind: kind },
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
