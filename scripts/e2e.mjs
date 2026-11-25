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
