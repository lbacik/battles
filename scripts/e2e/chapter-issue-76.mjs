// issue #76: scenario properties, undo/redo, and the issues panel (scripts/e2e.mjs lines 519-596).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave } from './helpers.mjs';

export async function runIssue76(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  const title = ctx.title;
  // Issue #76: scenario properties, undo/redo, and the issues panel.
  const undoButton = page.getByTestId('undo');
  const redoButton = page.getByTestId('redo');
  ctx.undoButton = undoButton;
  ctx.redoButton = redoButton;
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
  // Restore the acceptance title: steps 9-10 and the persistence steps
  // reopen, duplicate, and export the scenario under its original name.
  await page.getByTestId('inspector-title').fill(title);
  await page.locator('.map-caption').click();
  check(
    'the title edit can be reverted by hand',
    (await page.getByTestId('inspector-title').inputValue()) === title,
  );

  // A scenario with warnings still saves.
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  check(
    'a scenario with warnings saves',
    (await page.getByTestId('save-status').textContent()) === 'Saved',
  );
}
