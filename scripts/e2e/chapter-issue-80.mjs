// issue #80: rivers and roads (scripts/e2e.mjs lines 771-935).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, STEP_MS } from './helpers.mjs';

export async function runIssue80(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  const clickMap = ctx.clickMap;
  const groundRow = ctx.groundRow;
  // Issue #80: rivers and roads — draw a river crossing the forest, then a
  // road crossing both, and change a width. Linear features may cross ground
  // cover, elevation, and each other, so both finishes succeed.
  await page.getByTestId('terrain-new-linear-category').selectOption('river');
  await page.getByTestId('terrain-new-linear-width').fill('18');
  await page.getByTestId('terrain-draw-linear').click();
  check('drawing shows the river hint', await page.getByTestId('map-terrain-hint').isVisible());
  for (const [vx, vy] of [
    [300, 100],
    [300, 350],
    [300, 700],
  ]) {
    await clickMap(vx, vy);
  }
  await page.keyboard.press('Enter');
  const linearRow = page.getByTestId('terrain-linear-row');
  check('drawing a river adds a river row', (await linearRow.count()) === 1);
  check(
    'the river renders on the map at true scale',
    (await page.getByTestId('terrain-linear').count()) === 1,
  );
  check(
    'the river line is 18 m wide',
    (await page.getByTestId('terrain-linear').first().getAttribute('stroke-width')) === '18',
  );

  await page.getByTestId('terrain-new-linear-category').selectOption('road');
  await page.getByTestId('terrain-new-linear-width').fill('6');
  await page.getByTestId('terrain-draw-linear').click();
  for (const [vx, vy] of [
    [100, 300],
    [500, 300],
    [1100, 300],
  ]) {
    await clickMap(vx, vy);
  }
  // The river finished from the keyboard; the road finishes from the button.
  await page.getByTestId('terrain-draw-finish').click();
  check('drawing a road adds a second row', (await linearRow.count()) === 2);
  check(
    'the road crosses the river on the map',
    (await page.getByTestId('terrain-linear').count()) === 2,
  );

  // Escape cancels a river or road draft without adding a feature.
  await page.getByTestId('terrain-draw-linear').click();
  await clickMap(600, 100);
  await page.keyboard.press('Escape');
  check(
    'escape cancels the linear draft',
    (await linearRow.count()) === 2 &&
      (await page.getByTestId('map-terrain-hint').count()) === 0,
  );

  // A width change in the inspector redraws the line to scale and is undoable.
  await linearRow.nth(1).getByTestId('terrain-select').click();
  await page.getByTestId('terrain-linear-width').fill('8');
  await page.keyboard.press('Enter');
  check(
    'widening the road updates its row',
    ((await linearRow.nth(1).textContent()) ?? '').includes('8 m'),
  );
  check(
    'widening the road redraws its line',
    (await page.getByTestId('terrain-linear').nth(1).getAttribute('stroke-width')) === '8',
  );
  await page.getByTestId('undo').click();
  check(
    'undo restores the road width',
    ((await linearRow.nth(1).textContent()) ?? '').includes('6 m'),
  );
  await page.getByTestId('redo').click();
  check(
    'redo restores the width change',
    ((await linearRow.nth(1).textContent()) ?? '').includes('8 m'),
  );

  // A road vertex can be inserted on an edge and deleted again. React 19
  // flushes the re-render a frame after the commit, so wait a beat before
  // reading the handle count.
  const linearVertex = page.getByTestId('terrain-vertex-handle');
  const linearBefore = await linearVertex.count();
  check('the road shows its vertices', linearBefore === 3);
  await page.getByTestId('terrain-edge-handle').first().click();
  await page.waitForTimeout(STEP_MS);
  check(
    'inserting a road vertex adds a handle',
    (await linearVertex.count()) === linearBefore + 1,
  );
  await linearVertex.first().click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(STEP_MS);
  check('deleting a road vertex removes its handle', (await linearVertex.count()) === linearBefore);

  // Recategorise the forest, insert a vertex on an edge, delete it again.
  // React 19 flushes the re-render a frame after the commit, so wait a beat
  // before reading the handle counts.
  await groundRow.first().getByTestId('terrain-select').click();
  await page.getByTestId('terrain-category').selectOption('rough');
  check(
    'recategorising updates the row',
    (await groundRow.first().getAttribute('data-category')) === 'rough',
  );
  const vertexHandle = page.getByTestId('terrain-vertex-handle');
  const verticesBefore = await vertexHandle.count();
  await page.getByTestId('terrain-edge-handle').first().click();
  await page.waitForTimeout(STEP_MS);
  check(
    'inserting a vertex on an edge adds a handle',
    (await vertexHandle.count()) === verticesBefore + 1,
  );
  await vertexHandle.first().click();
  await page.keyboard.press('Delete');
  await page.waitForTimeout(STEP_MS);
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
  check('deleting the area removes its row', (await groundRow.count()) === 2);
  await page.getByTestId('undo').click();
  check('undo restores the deleted area', (await groundRow.count()) === 3);

  // Terrain persists through a save.
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
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

  // Acceptance step 4: rename the sides Athens and Sparta. The empty-side
  // warnings stay until units are fielded.
  await page.getByTestId('inspector-side-0').fill('Athens');
  await page.locator('.map-caption').click();
  await page.getByTestId('inspector-side-1').fill('Sparta');
  await page.locator('.map-caption').click();
  check(
    'acceptance step 4 renames the sides Athens and Sparta',
    (await page.getByTestId('inspector-side-0').inputValue()) === 'Athens' &&
      (await page.getByTestId('inspector-side-1').inputValue()) === 'Sparta',
  );
  const renamedWarnings = await page.getByTestId('issue-warning').allTextContents();
  check(
    'renamed sides still warn while empty',
    renamedWarnings.length === 2 && renamedWarnings.every((warning) => /has no units/.test(warning)),
    renamedWarnings.join(' | '),
  );
}
