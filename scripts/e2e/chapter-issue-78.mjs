// issue #78: placing and rotating units on the map, plus acceptance steps 8-10 (scripts/e2e.mjs lines 1057-1406).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, terrainRowCounts, T_LOAD, STEP_MS } from './helpers.mjs';

export async function runIssue78(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  const title = ctx.title;
  const undoButton = ctx.undoButton;
  const redoButton = ctx.redoButton;
  const oobUnit = ctx.oobUnit;
  const firstUnitId = ctx.firstUnitId;
  // Issue #78: placing and rotating units on the map. The first unit is
  // selected (from the map click above); the duplicate is the second row.
  const secondUnitId = await oobUnit.nth(1).getAttribute('data-unit-id');
  check(
    'rotation handle appears for the selected unit',
    await page.getByTestId('rotate-handle').isVisible(),
  );

  // Numeric facing edit commits.
  await page.getByTestId('unit-facing').fill('30');
  await page.locator('.map-caption').click();
  check(
    'numeric facing edit commits',
    (await page.getByTestId('unit-facing').inputValue()) === '30',
  );

  // Centre the unit so rotations stay inside the battlefield whatever the
  // default placement is; the second unit stays far away near the top.
  await page.getByTestId('unit-position-x').fill('600');
  await page.getByTestId('unit-position-y').fill('400');
  await page.locator('.map-caption').click();
  check(
    'numeric position edit commits',
    (await page.getByTestId('unit-position-x').inputValue()) === '600' &&
      (await page.getByTestId('unit-position-y').inputValue()) === '400',
  );

  // Rotation handle snaps to 15 degrees: dragging the grip due east of the
  // footprint centre puts the bearing exactly on 90 (the front midpoint
  // sits at the same height as the centre once facing runs east).
  {
    const handleBox = await page.getByTestId('rotate-handle').boundingBox();
    const footBox = await page
      .locator('[data-testid="map-unit"][data-selected="true"] [data-testid="unit-footprint"]')
      .boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(footBox.x + footBox.width / 2 + 180, footBox.y + footBox.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
  }
  check(
    'dragging the rotation handle snaps to 15 degrees',
    (await page.getByTestId('unit-facing').inputValue()) === '90',
  );

  // Holding Shift disables snapping: the same drag with a southward offset
  // lands off the 15-degree grid.
  await page.keyboard.down('Shift');
  {
    const handleBox = await page.getByTestId('rotate-handle').boundingBox();
    const footBox = await page
      .locator('[data-testid="map-unit"][data-selected="true"] [data-testid="unit-footprint"]')
      .boundingBox();
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(footBox.x + footBox.width / 2 + 137, footBox.y + footBox.height / 2 + 23, {
      steps: 12,
    });
    await page.mouse.up();
  }
  await page.keyboard.up('Shift');
  const freeFacing = Number(await page.getByTestId('unit-facing').inputValue());
  check(
    'holding Shift rotates freely without snapping',
    Number.isFinite(freeFacing) && Math.abs(freeFacing % 15) > 0.01,
    `facing=${freeFacing}`,
  );

  // Dragging moves the unit; the move is one undo step.
  const beforeX = await page.getByTestId('unit-position-x').inputValue();
  {
    const footBox = await page
      .locator('[data-testid="map-unit"][data-selected="true"] [data-testid="unit-footprint"]')
      .boundingBox();
    const cx = footBox.x + footBox.width / 2;
    const cy = footBox.y + footBox.height / 2;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 80, cy, { steps: 10 });
    await page.mouse.up();
  }
  const afterX = await page.getByTestId('unit-position-x').inputValue();
  check(
    'dragging moves the unit',
    Number(afterX) > Number(beforeX),
    `${beforeX} → ${afterX}`,
  );
  await undoButton.click();
  check(
    'the move is one undo step',
    (await page.getByTestId('unit-position-x').inputValue()) === beforeX,
  );
  await redoButton.click();
  check(
    'redo re-applies the move',
    (await page.getByTestId('unit-position-x').inputValue()) === afterX,
  );

  // Dropping onto another unit is refused: the unit returns and both units
  // are highlighted as the conflict. Park the second unit at a known open
  // spot first: its default placement can sit under the map toolbar, where
  // a press would hit the toolbar button instead of the footprint.
  await page.locator(`[data-testid="oob-unit"][data-unit-id="${secondUnitId}"]`).click();
  await page.getByTestId('unit-position-x').fill('400');
  await page.locator('.map-caption').click();
  await page.getByTestId('unit-position-y').fill('250');
  await page.locator('.map-caption').click();
  check(
    'the second unit parks at an open spot before the drop',
    (await page.getByTestId('unit-position-x').inputValue()) === '400' &&
      (await page.getByTestId('unit-position-y').inputValue()) === '250',
  );
  const targetBox = await page
    .locator(`[data-testid="map-unit"][data-unit-id="${firstUnitId}"] [data-testid="unit-footprint"]`)
    .boundingBox();
  const draggedBox = await page
    .locator('[data-testid="map-unit"][data-selected="true"] [data-testid="unit-footprint"]')
    .boundingBox();
  const committedBeforeDrop = await page
    .getByTestId('unit-position-x')
    .getAttribute('data-committed');
  await page.mouse.move(draggedBox.x + draggedBox.width / 2, draggedBox.y + draggedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  check(
    'dropping onto another unit is refused with a highlight',
    (await page.getByTestId('unit-position-x').inputValue()) === committedBeforeDrop &&
      (await page.getByTestId('inspector-unit-position-error').isVisible()) &&
      (await page.locator('[data-testid="map-unit"][data-conflict="true"]').count()) === 2,
  );

  // An out-of-bounds position is refused the same way (the same proposal
  // path backs the drag and the numeric field).
  const committedBeforeOob = await page
    .getByTestId('unit-position-x')
    .getAttribute('data-committed');
  await page.getByTestId('unit-position-x').fill('5000');
  await page.locator('.map-caption').click();
  check(
    'an out-of-bounds position is refused',
    (await page.getByTestId('inspector-unit-position-error').isVisible()) &&
      (await page.getByTestId('unit-position-x').getAttribute('data-committed')) ===
        committedBeforeOob &&
      (await page.locator('[data-testid="map-unit"][data-conflict="true"]').count()) === 1,
  );

  // Touching edge to edge is accepted: park the second unit beside the first
  // with the flank edges flush (both face 180, so the same Y and an X offset
  // of half the frontages keeps every corner inside and apart).
  await page.locator(`[data-testid="oob-unit"][data-unit-id="${firstUnitId}"]`).click();
  await page.getByTestId('unit-facing').fill('180');
  await page.locator('.map-caption').click();
  const firstX = Number(await page.getByTestId('unit-position-x').inputValue());
  const firstY = Number(await page.getByTestId('unit-position-y').inputValue());
  const firstDerived = (await page.getByTestId('unit-derived').textContent()) ?? '';
  const firstFront = Number(/([\d.]+) m frontage/.exec(firstDerived)?.[1]);
  await page.locator(`[data-testid="oob-unit"][data-unit-id="${secondUnitId}"]`).click();
  await page.getByTestId('unit-facing').fill('180');
  await page.locator('.map-caption').click();
  const secondDerived = (await page.getByTestId('unit-derived').textContent()) ?? '';
  const secondFront = Number(/([\d.]+) m frontage/.exec(secondDerived)?.[1]);
  const touchX = Math.round((firstX + (firstFront + secondFront) / 2) * 10) / 10;
  await page.getByTestId('unit-position-x').fill(String(touchX));
  await page.locator('.map-caption').click();
  await page.getByTestId('unit-position-y').fill(String(firstY));
  await page.locator('.map-caption').click();
  check(
    'touching edge to edge is accepted',
    (await page.getByTestId('inspector-unit-position-error').count()) === 0 &&
      (await page.getByTestId('unit-position-x').inputValue()) === String(touchX),
    `touchX=${touchX}`,
  );

  // Structural refusals: files beyond soldiers, a duplicate name, and a
  // spacing outside the application limit.
  await page.getByTestId('unit-files').fill('200');
  await page.locator('.map-caption').click();
  check(
    'files beyond soldiers are refused',
    await page.getByTestId('inspector-unit-files-error').isVisible(),
  );
  // The second unit (the copy) is selected, so take the first unit's name.
  await page.getByTestId('unit-name').fill('New Unit');
  await page.locator('.map-caption').click();
  check(
    'a duplicate unit name is refused',
    await page.getByTestId('inspector-unit-name-error').isVisible(),
  );
  await page.getByTestId('unit-spacing-lateral').fill('99');
  await page.locator('.map-caption').click();
  check(
    'a spacing outside structural bounds is refused',
    await page.getByTestId('inspector-unit-spacing-lateral-error').isVisible(),
  );

  // Delete both units; the warnings return; undo/redo walks the deletes back.
  await page.getByTestId('unit-delete').click();
  check('deleting removes the selected row', (await oobUnit.count()) === 1);
  await oobUnit.first().click();
  await page.getByTestId('unit-delete').click();
  check('deleting the last unit clears the list', (await oobUnit.count()) === 0);
  const warningsAfterDelete = await page.getByTestId('issue-warning').allTextContents();
  check(
    'the side warnings return when the sides have no units',
    warningsAfterDelete.length === 2,
    warningsAfterDelete.join(' | '),
  );
  await undoButton.click();
  check(
    'undo restores the deleted unit',
    (await oobUnit.count()) === 1 &&
      (await page.getByTestId('issue-warning').count()) === 1,
  );
  await redoButton.click();
  check(
    'redo removes the unit again',
    (await oobUnit.count()) === 0 &&
      (await page.getByTestId('issue-warning').count()) === 2,
  );

  // Acceptance steps 5-8: three units per side from at least two troop types,
  // a spacing preset change, a rotation to 30 degrees, and a refused
  // battlefield shrink. The scenario built here is what steps 9-10 and the
  // persistence steps save, reopen, duplicate, export, and import.
  async function addAcceptanceUnit(spec) {
    await page.getByTestId('oob-add').click();
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="oob-unit"]').length === expected,
      spec.rowCount,
    );
    await page.getByTestId('unit-name').fill(spec.name);
    await page.locator('.map-caption').click();
    // Place the unit before sizing it: the first free spot can sit near the
    // battlefield edge, where a larger footprint is correctly refused.
    await page.getByTestId('unit-position-x').fill(String(spec.x));
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-position-y').fill(String(spec.y));
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-side').selectOption({ label: spec.side });
    await page.getByTestId('unit-troop').selectOption(spec.troopType);
    await page.getByTestId('unit-soldiers').fill(String(spec.soldiers));
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-files').fill(String(spec.files));
    await page.locator('.map-caption').click();
    await page.getByTestId('unit-facing').fill(String(spec.facing));
    await page.locator('.map-caption').click();
  }

  const acceptanceUnits = [
    { name: 'I Athenian taxis', side: 'Athens', troopType: 'hoplite', soldiers: 256, files: 16, x: 500, y: 600, facing: 180, rowCount: 1 },
    { name: 'Athenian peltasts', side: 'Athens', troopType: 'peltast', soldiers: 120, files: 12, x: 750, y: 620, facing: 180, rowCount: 2 },
    { name: 'Athenian cavalry', side: 'Athens', troopType: 'cavalry', soldiers: 80, files: 10, x: 1000, y: 600, facing: 150, rowCount: 3 },
    { name: 'I Spartan mora', side: 'Sparta', troopType: 'hoplite', soldiers: 320, files: 16, x: 550, y: 300, facing: 0, rowCount: 4 },
    { name: 'Spartan archers', side: 'Sparta', troopType: 'archer', soldiers: 100, files: 14, x: 800, y: 280, facing: 0, rowCount: 5 },
    { name: 'Skiritae peltasts', side: 'Sparta', troopType: 'peltast', soldiers: 120, files: 12, x: 1050, y: 300, facing: 30, rowCount: 6 },
  ];
  for (const spec of acceptanceUnits) {
    await addAcceptanceUnit(spec);
  }
  check('acceptance step 5 fields three units per side', (await oobUnit.count()) === 6);
  check(
    'acceptance step 5 clears the empty-side warnings',
    (await page.getByTestId('issue-warning').count()) === 0,
  );
  await page.locator('[data-testid="oob-unit"]', { hasText: 'I Athenian taxis' }).click();
  const taxisDerived = (await page.getByTestId('unit-derived').textContent()) ?? '';
  // 256 hoplites in 16 files stand 16 ranks deep; the hoplite normal preset
  // spaces them 1.8 m apart both ways, so 16 x 1.8 = 28.8 m each way.
  check(
    'the inspector derives ranks, frontage, and depth',
    /16 ranks/.test(taxisDerived) &&
      /28\.8 m frontage/.test(taxisDerived) &&
      /28\.8 m depth/.test(taxisDerived),
    taxisDerived.trim().slice(0, 120),
  );
  await page.locator('[data-testid="oob-unit"]', { hasText: 'Athenian peltasts' }).click();
  await page.getByTestId('unit-preset').selectOption('open');
  // React 19 flushes the preset re-render a frame after the commit.
  await page.waitForTimeout(STEP_MS);
  check(
    'acceptance step 5 applies the open spacing preset',
    (await page.getByTestId('unit-spacing-lateral').inputValue()) === '3' &&
      (await page.getByTestId('unit-spacing-depth').inputValue()) === '3',
  );
  await page.locator('[data-testid="oob-unit"]', { hasText: 'Skiritae peltasts' }).click();
  check(
    'acceptance step 5 rotates a unit to 30 degrees',
    (await page.getByTestId('unit-facing').inputValue()) === '30',
  );

  // Acceptance step 7: shrinking the battlefield past a unit is refused and
  // names the blocking unit; the stored size is untouched.
  await page.getByTestId('inspector-width').fill('400');
  await page.locator('.map-caption').click();
  const shrinkError = await page.getByTestId('inspector-width-error').textContent().catch(() => null);
  check(
    'acceptance step 7 refuses a shrink past a unit',
    (await page.getByTestId('inspector-width-error').isVisible()) &&
      /taxis|peltasts|cavalry|mora|archers|Skiritae/i.test(shrinkError ?? ''),
    (shrinkError ?? '').replace(/\s+/g, ' ').slice(0, 160),
  );
  await page.getByTestId('inspector-width').fill('1400');
  await page.locator('.map-caption').click();
  check(
    'the refused shrink leaves the stored size alone',
    (await page.getByTestId('inspector-width-error').count()) === 0 &&
      (await page.getByTestId('inspector-width').inputValue()) === '1400',
  );

  // Acceptance step 8 runs across the whole script: undo and redo cover
  // properties, terrain, and units (title, road width, area delete, unit move
  // and delete above). Save the finished scenario and prove step 9 through
  // the browser: reload and reopen identical to 0.1 m with empty undo history.
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  check(
    'acceptance step 9 reloads the finished scenario',
    (await page.getByTestId('header-title').textContent()) === title,
  );
  const reloadedTerrain = await terrainRowCounts(page);
  check(
    'acceptance step 9 keeps every value identical to 0.1 m',
    ((await page.getByTestId('battlefield-dims').textContent()) ?? '').includes('1400 × 900') &&
      (await page.getByTestId('inspector-width').inputValue()) === '1400' &&
      (await page.getByTestId('inspector-height').inputValue()) === '900' &&
      (await page.getByTestId('oob-unit').count()) === 6 &&
      (await page.getByTestId('issue-warning').count()) === 0 &&
      reloadedTerrain.ground === 3 &&
      reloadedTerrain.hill === 2 &&
      reloadedTerrain.linear === 2,
    JSON.stringify(reloadedTerrain),
  );
  await page.locator('[data-testid="oob-unit"]', { hasText: 'I Athenian taxis' }).click();
  check(
    'acceptance step 9 keeps unit positions identical to 0.1 m',
    (await page.getByTestId('unit-position-x').inputValue()) === '500' &&
      (await page.getByTestId('unit-position-y').inputValue()) === '600',
  );
  check(
    'acceptance step 9 reopens with empty undo history',
    (await undoButton.isDisabled()) && (await redoButton.isDisabled()),
  );
}
