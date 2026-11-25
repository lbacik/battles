// issue #113: the editor remembers collapsed panels across reloads (scripts/e2e.mjs lines 1539-1623).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { T_SAVE, T_LOAD, STEP_MS } from './helpers.mjs';

export async function runIssue113Editor(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #113: the editor remembers collapsed panels across reloads, per
  // panel and independently of the battle screen. Panel state is a
  // browser-only preference: it never reaches the scenario document.
  await page.getByTestId('collapse-left-panel').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'true',
  );
  check(
    'editor panel state is stored in the browser only',
    (await page.evaluate(() => window.localStorage.getItem('polis.panel.editor.left'))) === 'true' &&
      (await page.evaluate(() => window.localStorage.getItem('polis.panel.battle.left'))) === null,
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'true',
    null,
    { timeout: T_SAVE },
  );
  check(
    'collapsing the editor left panel survives a reload',
    (await page.getByTestId('editor-left-panel').getAttribute('data-collapsed')) === 'true' &&
      (await page.getByTestId('inspector').getAttribute('data-collapsed')) === 'false' &&
      (await page.getByTestId('expand-left-panel').count()) === 1,
  );
  await page.getByTestId('expand-left-panel').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="editor-left-panel"]')?.getAttribute('data-collapsed') === 'false',
  );
  await page.getByTestId('collapse-right-panel').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="inspector"]')?.getAttribute('data-collapsed') === 'true',
  );
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="inspector"]')?.getAttribute('data-collapsed') === 'true',
    null,
    { timeout: T_SAVE },
  );
  check(
    'collapsing the editor right panel survives a reload independently',
    (await page.getByTestId('editor-left-panel').getAttribute('data-collapsed')) === 'false' &&
      (await page.getByTestId('inspector').getAttribute('data-collapsed')) === 'true' &&
      (await page.getByTestId('expand-right-panel').count()) === 1,
  );
  await page.getByTestId('expand-right-panel').click();
  await page.waitForFunction(
    () => document.querySelector('[data-testid="inspector"]')?.getAttribute('data-collapsed') === 'false',
  );
  // A corrupt stored preference falls back to expanded without errors: the
  // editor still loads and both panels start expanded.
  await page.evaluate(() => {
    window.localStorage.setItem('polis.panel.editor.left', 'garbage!!!');
    window.localStorage.setItem('polis.panel.editor.right', '{bad json');
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await page.waitForTimeout(STEP_MS);
  check(
    'a corrupt editor preference falls back to expanded without errors',
    (await page.getByTestId('editor-left-panel').getAttribute('data-collapsed')) === 'false' &&
      (await page.getByTestId('inspector').getAttribute('data-collapsed')) === 'false' &&
      (await page.getByTestId('collapse-left-panel').count()) === 1 &&
      (await page.getByTestId('collapse-right-panel').count()) === 1,
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
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  check('confirming the warning leaves the editor', true);
}
