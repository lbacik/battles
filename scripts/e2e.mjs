// Headless end-to-end test of the walking skeleton against the production
// build: create → empty battlefield → save → reload → reopen.
//
// Serves `out/` (run `npm run build` first) over loopback HTTP and drives a
// headless browser through the first end-to-end path: an author creates a
// scenario with a title, lands in the editor on an empty battlefield, saves,
// reloads, and reopens the scenario from the library with identical values.
// Later sections prove the local battle gate (issue #88) as one coherent
// story — an unplayable reference refused naming the unit, the editor fix,
// Human vs Passive, a Move plus a Charge plus a colliding order with reorder
// and commit, the turn result and the battle log, reload-resume, concession,
// and rematch — then Human vs Random with a fixed seed to an end condition.
// Records `e2e-report/report.json` plus `e2e-report/trace.log` for the CI
// artifact upload.
//
// The run itself lives in scripts/e2e/: one shared helpers module plus one
// chapter module per section (or small group of related sections). This file
// stays the `npm run test:e2e` entry point: it keeps the preamble, guards,
// server, browser lifecycle, tracing and reporting, and runs the chapters in
// today's order against the same context and page. Exit code and console
// output keep their current shape.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

import path from 'node:path';

import {
  outDir,
  reportDir,
  trace,
  checks,
  check,
  log,
  T_BATTLE,
  waitForSave,
  serveStatic,
  failReport,
} from './e2e/helpers.mjs';

import { runAcceptance } from './e2e/chapter-acceptance.mjs';
import { runIssue76 } from './e2e/chapter-issue-76.mjs';
import { runIssue79 } from './e2e/chapter-issue-79.mjs';
import { runIssue80 } from './e2e/chapter-issue-80.mjs';
import { runIssue77 } from './e2e/chapter-issue-77.mjs';
import { runIssue78 } from './e2e/chapter-issue-78.mjs';
import { runIssue111 } from './e2e/chapter-issue-111.mjs';
import { runIssue113Editor } from './e2e/chapter-issue-113-editor.mjs';
import { runLibrary } from './e2e/chapter-library.mjs';
import { runPersistence } from './e2e/chapter-persistence.mjs';
import { runIssue83 } from './e2e/chapter-issue-83.mjs';
import { runBattlePanels } from './e2e/chapter-battle-panels.mjs';
import { runIssue113Battle } from './e2e/chapter-issue-113-battle.mjs';
import { runIssue84 } from './e2e/chapter-issue-84.mjs';
import { runIssue86 } from './e2e/chapter-issue-86.mjs';
import { runIssue85 } from './e2e/chapter-issue-85.mjs';
import { runIssue87Concede } from './e2e/chapter-issue-87-concede.mjs';
import { runIssue88Gate } from './e2e/chapter-issue-88-gate.mjs';
import { runIssue87End } from './e2e/chapter-issue-87-end.mjs';
import { runIssue119 } from './e2e/chapter-issue-119.mjs';
import { runIssue120 } from './e2e/chapter-issue-120.mjs';
import { runIssue127 } from './e2e/chapter-issue-127.mjs';
import { runIssue128 } from './e2e/chapter-issue-128.mjs';
import { runIssue129 } from './e2e/chapter-issue-129.mjs';

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
  await context.setDefaultTimeout(T_BATTLE);
  // A Playwright trace of the whole run lands in e2e-report/ next to
  // report.json and trace.log, so the CI artifact carries the failure
  // context, not just the check list.
  await context.tracing.start({ screenshots: true, snapshots: true });
  const page = await context.newPage();
  page.on('console', (message) => log(`browser console: ${message.text()}`));
  page.on('pageerror', (error) => log(`browser pageerror: ${String(error)}`));

  // Shared run context: the single browser context and page the editor

  // chapters drive, the browser and server base they share, the check

  // helpers, and the values one chapter hands to later ones (never

  // module-level globals that depend on import order).

  const ctx = { page, context, browser, base, check, log };

  await runAcceptance(ctx);
  await runIssue76(ctx);
  await runIssue79(ctx);
  await runIssue80(ctx);
  await runIssue77(ctx);
  await runIssue78(ctx);
  await runIssue111(ctx);
  await runIssue113Editor(ctx);
  await runLibrary(ctx);
  await runPersistence(ctx);
  await runIssue83(ctx);
  await runBattlePanels(ctx);
  await runIssue113Battle(ctx);
  await runIssue84(ctx);
  await runIssue86(ctx);
  await runIssue85(ctx);
  await runIssue87Concede(ctx);
  await runIssue88Gate(ctx);
  await runIssue87End(ctx);
  await runIssue119(ctx);
  await runIssue120(ctx);
  await runIssue127(ctx);
  await runIssue128(ctx);
  await runIssue129(ctx);

  // Issue #121: full-height battle shell — the battle screen fills the window
  // with the turn bar flush against the bottom edge. Geometry is asserted
  // through bounding boxes on the same page across viewport resizes: the turn
  // bar bottom equals the viewport height at 1440x900 and 1440x1200, growing
  // the viewport grows the map viewport by the same amount, and the map's
  // drawn area matches its container with the battlefield still visible. A
  // short viewport keeps the 560 px workspace floor with vertical page scroll;
  // the order of battle scrolls internally while the inspector and the battle
  // log stay scrollable without growing the page.
  const battleShellContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const battleShellPage = await battleShellContext.newPage();
  battleShellPage.on('console', (message) => log(`battle shell console: ${message.text()}`));
  battleShellPage.on('pageerror', (error) => log(`battle shell pageerror: ${String(error)}`));
  battleShellPage.on('dialog', async (dialog) => {
    log(`battle shell dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await battleShellPage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await battleShellPage.getByTestId('app').waitFor({ timeout: 15000 });
  const battleShellTitle = `Battle Shell Probe ${Date.now()}`;
  await battleShellPage.getByTestId('new-scenario-title').fill(battleShellTitle);
  await battleShellPage.getByTestId('new-scenario-submit').click();
  await battleShellPage.getByTestId('editor').waitFor({ timeout: 15000 });
  // Enough units that the order of battle overflows the workspace at 900 px,
  // so the internal-scroll checks below are meaningful. Units are split
  // across both sides through the order-of-battle filter tabs so the scenario
  // can begin a battle.
  await battleShellPage.getByTestId('oob-tab-0').click();
  for (let index = 0; index < 8; index += 1) {
    await battleShellPage.getByTestId('oob-add').click();
    await battleShellPage.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="oob-unit"]').length === expected,
      index + 1,
    );
  }
  await battleShellPage.getByTestId('oob-tab-1').click();
  for (let index = 8; index < 16; index += 1) {
    await battleShellPage.getByTestId('oob-add').click();
    await battleShellPage.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="oob-unit"]').length === expected,
      index - 7,
    );
  }
  await battleShellPage.getByTestId('oob-tab-all').click();
  await battleShellPage.getByTestId('save-scenario').click();
  await waitForSave(battleShellPage);
  await battleShellPage.getByTestId('start-battle-editor').click();
  await battleShellPage.getByTestId('battle-setup').waitFor({ timeout: 10000 });
  await battleShellPage.getByTestId('begin-battle').click();
  await battleShellPage.getByTestId('battle-screen').waitFor({ timeout: 15000 });
  async function battleShellTurnBarBox() {
    return battleShellPage.getByTestId('turn-bar').boundingBox();
  }
  async function battleShellWorkspaceBox() {
    return battleShellPage.getByTestId('battle-workspace').boundingBox();
  }
  async function battleShellMapViewportBox() {
    return battleShellPage.getByTestId('map-viewport').boundingBox();
  }
  const battleShellTurn900 = await battleShellTurnBarBox();
  check(
    'battle shell: turn bar bottom sits at the viewport height at 1440x900',
    !!battleShellTurn900 && Math.abs(battleShellTurn900.y + battleShellTurn900.height - 900) <= 1,
    JSON.stringify(battleShellTurn900),
  );
  const battleShellMap900 = await battleShellMapViewportBox();
  const battleShellSvg900 = await battleShellPage.getByTestId('battlefield-map').boundingBox();
  check(
    'battle shell: map drawn area matches its container at 1440x900',
    !!battleShellMap900 &&
      !!battleShellSvg900 &&
      Math.abs(battleShellSvg900.width - battleShellMap900.width) <= 2 &&
      Math.abs(battleShellSvg900.height - battleShellMap900.height) <= 2,
    `viewport=${JSON.stringify(battleShellMap900)} svg=${JSON.stringify(battleShellSvg900)}`,
  );
  const battleShellViewBoxBefore = await battleShellPage
    .getByTestId('battlefield-map')
    .getAttribute('viewBox');
  await battleShellPage.setViewportSize({ width: 1440, height: 1200 });
  await battleShellPage.waitForTimeout(600);
  const battleShellTurn1200 = await battleShellTurnBarBox();
  check(
    'battle shell: turn bar bottom sits at the viewport height at 1440x1200',
    !!battleShellTurn1200 && Math.abs(battleShellTurn1200.y + battleShellTurn1200.height - 1200) <= 1,
    JSON.stringify(battleShellTurn1200),
  );
  const battleShellMap1200 = await battleShellMapViewportBox();
  check(
    'battle shell: growing the viewport height grows the map viewport by the same amount',
    !!battleShellMap900 &&
      !!battleShellMap1200 &&
      Math.abs(battleShellMap1200.height - battleShellMap900.height - 300) <= 16,
    `${battleShellMap900?.height} → ${battleShellMap1200?.height}`,
  );
  const battleShellSvg1200 = await battleShellPage.getByTestId('battlefield-map').boundingBox();
  check(
    'battle shell: map drawn area matches its container after the resize',
    !!battleShellMap1200 &&
      !!battleShellSvg1200 &&
      Math.abs(battleShellSvg1200.width - battleShellMap1200.width) <= 2 &&
      Math.abs(battleShellSvg1200.height - battleShellMap1200.height) <= 2,
    `viewport=${JSON.stringify(battleShellMap1200)} svg=${JSON.stringify(battleShellSvg1200)}`,
  );
  const battleShellViewBoxAfter = await battleShellPage
    .getByTestId('battlefield-map')
    .getAttribute('viewBox');
  check(
    'battle shell: the battlefield view does not jump away on resize',
    !!battleShellViewBoxBefore &&
      !!battleShellViewBoxAfter &&
      battleShellViewBoxAfter === battleShellViewBoxBefore,
    `${battleShellViewBoxBefore} → ${battleShellViewBoxAfter}`,
  );
  check(
    'battle shell: the battlefield stays visible after the resize',
    (await battleShellPage.getByTestId('battlefield-map').isVisible()) &&
      ((await battleShellPage.locator('[data-testid="map-unit"]').count()) > 0) &&
      (await battleShellPage.locator('[data-testid="map-unit"]').first().isVisible()),
    `viewBox=${battleShellViewBoxAfter}`,
  );
  await battleShellPage.setViewportSize({ width: 1440, height: 500 });
  await battleShellPage.waitForTimeout(600);
  const battleShellWs500 = await battleShellWorkspaceBox();
  const battleShellShort = await battleShellPage.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  check(
    'battle shell: below the minimum layout height the workspace stays at its minimum height',
    !!battleShellWs500 && battleShellWs500.height >= 558,
    JSON.stringify(battleShellWs500),
  );
  check(
    'battle shell: below the minimum layout height the page scrolls vertically',
    battleShellShort.scrollHeight > battleShellShort.innerHeight + 8,
    JSON.stringify(battleShellShort),
  );
  await battleShellPage.setViewportSize({ width: 1440, height: 900 });
  await battleShellPage.waitForTimeout(600);
  const battleShellTurnRestored = await battleShellTurnBarBox();
  check(
    'battle shell: restoring the viewport restores the turn bar fit',
    !!battleShellTurnRestored && Math.abs(battleShellTurnRestored.y + battleShellTurnRestored.height - 900) <= 1,
    JSON.stringify(battleShellTurnRestored),
  );
  const battleShellStructure = await battleShellPage.evaluate(() => {
    const root = document.querySelector('[data-testid="battle-screen"]');
    const children = root
      ? Array.from(root.children).map((element) => element.getAttribute('data-testid') || element.className)
      : [];
    return { children };
  });
  check(
    'battle shell: nothing but the turn bar sits below the battle workspace',
    battleShellStructure.children.length === 2 &&
      battleShellStructure.children[0] === 'battle-workspace' &&
      battleShellStructure.children[1] === 'turn-bar',
    JSON.stringify(battleShellStructure),
  );
  const battleShellPanels = await battleShellPage.evaluate(() => {
    const left = document.querySelector('[data-testid="battle-left-panel"]');
    const right = document.querySelector('[data-testid="battle-inspector"]');
    const log = document.querySelector('.battle-log-scroll');
    const overflowOf = (element) => (element ? getComputedStyle(element).overflowY : null);
    return {
      left: left
        ? { scrollHeight: left.scrollHeight, clientHeight: left.clientHeight, overflowY: overflowOf(left) }
        : null,
      right: right
        ? { scrollHeight: right.scrollHeight, clientHeight: right.clientHeight, overflowY: overflowOf(right) }
        : null,
      log: log
        ? { scrollHeight: log.scrollHeight, clientHeight: log.clientHeight, overflowY: overflowOf(log) }
        : null,
      pageScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    };
  });
  check(
    'battle shell: the order of battle scrolls internally when taller than the workspace',
    !!battleShellPanels.left && battleShellPanels.left.scrollHeight > battleShellPanels.left.clientHeight + 4,
    JSON.stringify(battleShellPanels.left),
  );
  check(
    'battle shell: the inspector stays scrollable inside its panel',
    !!battleShellPanels.right &&
      (battleShellPanels.right.overflowY === 'auto' || battleShellPanels.right.overflowY === 'scroll'),
    JSON.stringify(battleShellPanels.right),
  );
  check(
    'battle shell: the battle log stays scrollable inside its panel',
    !!battleShellPanels.log &&
      (battleShellPanels.log.overflowY === 'auto' || battleShellPanels.log.overflowY === 'scroll'),
    JSON.stringify(battleShellPanels.log),
  );
  check(
    'battle shell: tall panels do not grow the page past the window at normal sizes',
    battleShellPanels.pageScrollHeight <= battleShellPanels.innerHeight + 8,
    JSON.stringify({ pageScrollHeight: battleShellPanels.pageScrollHeight, innerHeight: battleShellPanels.innerHeight }),
  );
  await battleShellContext.close();


  if (ctx.battleContext) await ctx.battleContext.close();

  try {
    await context.tracing.stop({ path: path.join(reportDir, 'trace.zip') });
    check('playwright trace recorded', existsSync(path.join(reportDir, 'trace.zip')));
  } catch (traceError) {
    check('playwright trace recorded', false, String(traceError).split('\n')[0]);
  }
  await context.close();
} catch (error) {
  // Record the first few lines so the report names the failing locator
  // (the first line alone is only the generic TimeoutError).
  const detail = String(error).split('\n').slice(0, 5).join('\n').slice(0, 500);
  check('browser test completes', false, detail);
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
