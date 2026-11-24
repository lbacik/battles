// issue #120: full-height app shell (scripts/e2e.mjs lines 4693-4876).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, T_SAVE, T_LOAD, T_BATTLE, LAYOUT_MS } from './helpers.mjs';

export async function runIssue120(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #120: full-height app shell — the scenario editor fills the window.
  // Geometry is asserted through bounding boxes on the same page across
  // viewport resizes: the workspace bottom sits at the viewport height minus
  // its outer margin, growing the viewport grows the map viewport by the same
  // amount, and the map's drawn area matches its container. A short viewport
  // keeps the 560 px workspace floor with vertical page scroll; a save error
  // still fits; tall side panels scroll internally without growing the page;
  // and the library background reaches the window bottom.
  const shellContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await shellContext.setDefaultTimeout(T_BATTLE);
  const shellPage = await shellContext.newPage();
  shellPage.on('console', (message) => log(`shell console: ${message.text()}`));
  shellPage.on('pageerror', (error) => log(`shell pageerror: ${String(error)}`));
  shellPage.on('dialog', async (dialog) => {
    log(`shell dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await shellPage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await shellPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  const shellTitle = `Shell Probe ${Date.now()}`;
  await shellPage.getByTestId('new-scenario-title').fill(shellTitle);
  await shellPage.getByTestId('new-scenario-submit').click();
  await shellPage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  // Enough units that both side panels overflow the workspace at 900 px, so
  // the internal-scroll checks below are meaningful.
  for (let index = 0; index < 16; index += 1) {
    await shellPage.getByTestId('oob-add').click();
    await shellPage.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="oob-unit"]').length === expected,
      index + 1,
    );
  }
  await shellPage.getByTestId('save-scenario').click();
  await waitForSave(shellPage);
  async function shellWorkspaceBox() {
    return shellPage.getByTestId('editor-workspace').boundingBox();
  }
  async function shellMapViewportBox() {
    return shellPage.getByTestId('map-viewport').boundingBox();
  }
  const shellWs900 = await shellWorkspaceBox();
  check(
    'shell: workspace bottom sits at the viewport height minus its margin at 1440x900',
    !!shellWs900 && Math.abs(shellWs900.y + shellWs900.height - (900 - 20)) <= 12,
    JSON.stringify(shellWs900),
  );
  const shellMap900 = await shellMapViewportBox();
  const shellSvg900 = await shellPage.getByTestId('battlefield-map').boundingBox();
  check(
    'shell: map drawn area matches its container at 1440x900',
    !!shellMap900 &&
      !!shellSvg900 &&
      Math.abs(shellSvg900.width - shellMap900.width) <= 2 &&
      Math.abs(shellSvg900.height - shellMap900.height) <= 2,
    `viewport=${JSON.stringify(shellMap900)} svg=${JSON.stringify(shellSvg900)}`,
  );
  await shellPage.setViewportSize({ width: 1440, height: 1200 });
  await shellPage.waitForTimeout(LAYOUT_MS);
  const shellWs1200 = await shellWorkspaceBox();
  check(
    'shell: workspace bottom sits at the viewport height minus its margin at 1440x1200',
    !!shellWs1200 && Math.abs(shellWs1200.y + shellWs1200.height - (1200 - 20)) <= 12,
    JSON.stringify(shellWs1200),
  );
  const shellMap1200 = await shellMapViewportBox();
  check(
    'shell: growing the viewport height grows the map viewport by the same amount',
    !!shellMap900 &&
      !!shellMap1200 &&
      Math.abs(shellMap1200.height - shellMap900.height - 300) <= 16,
    `${shellMap900?.height} → ${shellMap1200?.height}`,
  );
  const shellSvg1200 = await shellPage.getByTestId('battlefield-map').boundingBox();
  check(
    'shell: map drawn area matches its container after the resize',
    !!shellMap1200 &&
      !!shellSvg1200 &&
      Math.abs(shellSvg1200.width - shellMap1200.width) <= 2 &&
      Math.abs(shellSvg1200.height - shellMap1200.height) <= 2,
    `viewport=${JSON.stringify(shellMap1200)} svg=${JSON.stringify(shellSvg1200)}`,
  );
  await shellPage.setViewportSize({ width: 1440, height: 500 });
  await shellPage.waitForTimeout(LAYOUT_MS);
  const shellWs500 = await shellWorkspaceBox();
  const shellShort = await shellPage.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
  }));
  check(
    'shell: below the minimum layout height the workspace stays at its minimum height',
    !!shellWs500 && shellWs500.height >= 558,
    JSON.stringify(shellWs500),
  );
  check(
    'shell: below the minimum layout height the page scrolls vertically',
    shellShort.scrollHeight > shellShort.innerHeight + 8,
    JSON.stringify(shellShort),
  );
  await shellPage.setViewportSize({ width: 1440, height: 900 });
  await shellPage.waitForTimeout(LAYOUT_MS);
  const shellWsRestored = await shellWorkspaceBox();
  check(
    'shell: restoring the viewport restores the workspace fit',
    !!shellWsRestored && Math.abs(shellWsRestored.y + shellWsRestored.height - (900 - 20)) <= 12,
    JSON.stringify(shellWsRestored),
  );
  // A save error pushes the workspace down without pushing it out of the
  // window: stub the store once so the next save fails, then save again.
  await shellPage.evaluate(() => {
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
  await shellPage.getByTestId('inspector-title').fill(`${shellTitle} quota`);
  await shellPage.locator('.map-caption').click();
  await shellPage.getByTestId('save-scenario').click();
  await shellPage.getByTestId('save-error').waitFor({ timeout: T_SAVE });
  const shellWsError = await shellWorkspaceBox();
  check(
    'shell: with a save error the workspace still fits the window',
    !!shellWsError &&
      Math.abs(shellWsError.y + shellWsError.height - (900 - 20)) <= 24 &&
      (await shellPage.getByTestId('save-error').isVisible()),
    JSON.stringify(shellWsError),
  );
  await shellPage.getByTestId('save-scenario').click();
  await waitForSave(shellPage);
  const shellPanels = await shellPage.evaluate(() => {
    const left = document.querySelector('[data-testid="editor-left-panel"]');
    const right = document.querySelector('[data-testid="inspector"]');
    return {
      left: left ? { scrollHeight: left.scrollHeight, clientHeight: left.clientHeight } : null,
      right: right ? { scrollHeight: right.scrollHeight, clientHeight: right.clientHeight } : null,
      pageScrollHeight: document.documentElement.scrollHeight,
      innerHeight: window.innerHeight,
    };
  });
  check(
    'shell: the order of battle scrolls internally when taller than the workspace',
    !!shellPanels.left && shellPanels.left.scrollHeight > shellPanels.left.clientHeight + 4,
    JSON.stringify(shellPanels.left),
  );
  check(
    'shell: the inspector scrolls internally when taller than the workspace',
    !!shellPanels.right && shellPanels.right.scrollHeight > shellPanels.right.clientHeight + 4,
    JSON.stringify(shellPanels.right),
  );
  check(
    'shell: tall panels do not grow the page past the window at normal sizes',
    shellPanels.pageScrollHeight <= shellPanels.innerHeight + 8,
    JSON.stringify({ pageScrollHeight: shellPanels.pageScrollHeight, innerHeight: shellPanels.innerHeight }),
  );
  await shellPage.getByTestId('back-to-library').click();
  await shellPage.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const shellLibrary = await shellPage.evaluate(() => {
    const app = document.querySelector('[data-testid="app"]');
    const box = app?.getBoundingClientRect() ?? null;
    return {
      box: box ? { y: box.y, height: box.height } : null,
      innerHeight: window.innerHeight,
      background: app ? getComputedStyle(app).backgroundColor : null,
    };
  });
  check(
    'shell: the library background reaches the bottom of the window with no seam',
    !!shellLibrary.box &&
      shellLibrary.box.y + shellLibrary.box.height >= shellLibrary.innerHeight - 2 &&
      !!shellLibrary.background &&
      shellLibrary.background !== 'rgba(0, 0, 0, 0)',
    JSON.stringify(shellLibrary),
  );
  await shellContext.close();
}
