// issue #79: terrain mode - draw, refuse overlap, nested hills (scripts/e2e.mjs lines 597-770).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { clickMapAt } from './helpers.mjs';

export async function runIssue79(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  const fittedViewBox = ctx.fittedViewBox;
  // Issue #79: terrain mode — draw, refuse overlap, nested hills.
  // Map metres (y up from the south-west corner) to client pixels through
  // the SVG's own transform, so terrain vertices land on exact points even
  // when the drawing is letterboxed.
  async function clickMap(atX, atY) {
    await clickMapAt(page, atX, atY);
  }
  ctx.clickMap = clickMap;

  await page.getByTestId('mode-map').click();
  check(
    'map editor tab shows the terrain panel',
    await page.getByTestId('terrain-panel').isVisible(),
  );
  await page.getByTestId('fit-view').click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector('[data-testid="battlefield-map"]')?.getAttribute('viewBox') ===
      expected,
    fittedViewBox,
  );

  // Draw a forest area and finish from the keyboard.
  await page.getByTestId('terrain-new-category').selectOption('forest');
  await page.getByTestId('terrain-draw-area').click();
  check('drawing shows the map hint', await page.getByTestId('map-terrain-hint').isVisible());
  for (const [vx, vy] of [
    [200, 200],
    [400, 200],
    [400, 400],
    [200, 400],
  ]) {
    await clickMap(vx, vy);
  }
  await page.keyboard.press('Enter');
  const groundRow = page.getByTestId('terrain-ground-row');
  ctx.groundRow = groundRow;
  check('drawing a forest adds a ground row', (await groundRow.count()) === 1);

  // Acceptance step 2 also draws rough ground and a settlement.
  await page.getByTestId('terrain-new-category').selectOption('rough');
  await page.getByTestId('terrain-draw-area').click();
  for (const [vx, vy] of [
    [1150, 600],
    [1300, 620],
    [1280, 740],
    [1140, 720],
  ]) {
    await clickMap(vx, vy);
  }
  await page.keyboard.press('Enter');
  await page.getByTestId('terrain-new-category').selectOption('settlement');
  await page.getByTestId('terrain-draw-area').click();
  for (const [vx, vy] of [
    [150, 120],
    [300, 120],
    [310, 190],
    [220, 195],
  ]) {
    await clickMap(vx, vy);
  }
  await page.keyboard.press('Enter');
  check('drawing rough and settlement adds two more rows', (await groundRow.count()) === 3);
  // Three ground areas are drawn by now (forest, rough, settlement): the map
  // shows one shape per ground feature.
  check(
    'the forest renders on the map',
    (await page.getByTestId('terrain-ground').count()) === 3,
    `ground=${await page.getByTestId('terrain-ground').count()}`,
  );

  // An overlapping area is refused: the candidate highlights red, the list
  // is unchanged, and Escape clears the refusal.
  await page.getByTestId('terrain-draw-area').click();
  for (const [vx, vy] of [
    [300, 300],
    [500, 300],
    [500, 500],
    [300, 500],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  check('overlapping ground is refused', await page.getByTestId('terrain-refusal').isVisible());
  check(
    'a refused overlap leaves the feature count unchanged',
    (await groundRow.count()) === 3,
  );
  check(
    'a refused overlap highlights the candidate',
    (await page.getByTestId('terrain-refusal-shape').count()) === 1,
  );
  await page.keyboard.press('Escape');
  check(
    'escape clears the refusal',
    (await page.getByTestId('terrain-refusal').count()) === 0,
  );

  // A self-intersecting bowtie is refused the same way.
  await page.getByTestId('terrain-draw-area').click();
  for (const [vx, vy] of [
    [600, 200],
    [800, 400],
    [800, 200],
    [600, 400],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  check(
    'a self-intersecting polygon is refused',
    await page.getByTestId('terrain-refusal').isVisible(),
  );
  check(
    'a refused bowtie leaves the feature count unchanged',
    (await groundRow.count()) === 3,
  );
  await page.keyboard.press('Escape');

  // Hills nest: the first hill is level 1, a hill drawn inside it is level 2.
  await page.getByTestId('terrain-draw-hill').click();
  for (const [vx, vy] of [
    [700, 550],
    [950, 550],
    [950, 750],
    [700, 750],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  const hillRow = page.getByTestId('terrain-hill-row');
  check('drawing a hill adds a hill row', (await hillRow.count()) === 1);
  const hillText = (await hillRow.first().textContent()) ?? '';
  check('the outer hill derives level 1', /level 1/.test(hillText), hillText.slice(0, 80));
  await page.getByTestId('terrain-draw-hill').click();
  for (const [vx, vy] of [
    [760, 610],
    [890, 610],
    [890, 690],
    [760, 690],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  check('a nested hill adds a second row', (await hillRow.count()) === 2);
  const hillTexts = await hillRow.allTextContents();
  check(
    'the nested hill derives level 2',
    hillTexts.some((entry) => /level 2/.test(entry)),
    hillTexts.join(' | ').slice(0, 120),
  );

  // A hill crossing its sibling's boundary is refused.
  await page.getByTestId('terrain-draw-hill').click();
  for (const [vx, vy] of [
    [900, 600],
    [1050, 600],
    [1050, 700],
    [900, 700],
  ]) {
    await clickMap(vx, vy);
  }
  await page.getByTestId('terrain-draw-finish').click();
  check('a crossing hill is refused', await page.getByTestId('terrain-refusal').isVisible());
  check('a refused hill leaves the hill count unchanged', (await hillRow.count()) === 2);
  await page.keyboard.press('Escape');
}
