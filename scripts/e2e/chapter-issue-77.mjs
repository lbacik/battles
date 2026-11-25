// issue #77: order of battle - add, select, edit, duplicate, delete (scripts/e2e.mjs lines 936-1056).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { T_SAVE, STEP_MS } from './helpers.mjs';

export async function runIssue77(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #77: order of battle — add, select, edit, duplicate, delete.
  const oobTabAll = page.getByTestId('oob-tab-all');
  const oobTabA = page.getByTestId('oob-tab-0');
  const oobTabB = page.getByTestId('oob-tab-1');
  check(
    'oob filter tabs are visible',
    (await oobTabAll.isVisible()) &&
      (await oobTabA.isVisible()) &&
      (await oobTabB.isVisible()),
  );
  await oobTabA.click();
  check(
    'an oob side tab filters to that side',
    (await page.getByTestId('oob-side-a').isVisible()) &&
      !(await page.getByTestId('oob-side-b').isVisible()),
  );
  await oobTabAll.click();

  await page.getByTestId('oob-add').click();
  const oobUnit = page.getByTestId('oob-unit');
  ctx.oobUnit = oobUnit;
  check('adding a unit creates a row', (await oobUnit.count()) === 1);
  const firstUnitId = await oobUnit.first().getAttribute('data-unit-id');
  ctx.firstUnitId = firstUnitId;
  const firstRowText = (await oobUnit.first().textContent()) ?? '';
  check(
    'the new unit has the default name',
    /New Unit/.test(firstRowText),
    firstRowText.trim().slice(0, 80),
  );
  const warningsAfterAdd = await page.getByTestId('issue-warning').allTextContents();
  check(
    'adding a unit clears one side warning',
    warningsAfterAdd.length === 1 && /has no units/.test(warningsAfterAdd[0] ?? ''),
    warningsAfterAdd.join(' | '),
  );
  const derived = (await page.getByTestId('unit-derived').textContent()) ?? '';
  check(
    'the inspector derives ranks, frontage, and depth',
    /10 ranks/.test(derived) &&
      /18\.0 m frontage/.test(derived) &&
      /18\.0 m depth/.test(derived),
    (derived ?? '').trim().slice(0, 120),
  );
  check(
    'the inspector shows the formation diagram',
    await page.getByTestId('formation-diagram').isVisible(),
  );

  // Selecting in the list selects the unit on the map and vice versa.
  await oobUnit.first().click();
  const selectedOnMap = page.locator('[data-testid="map-unit"][data-selected="true"]');
  check(
    'selecting in the list selects the unit on the map',
    (await selectedOnMap.count()) === 1 &&
      ((await selectedOnMap.getAttribute('data-unit-id')) === firstUnitId),
  );

  // Centre the new unit before enlarging it: the first free spot sits near
  // the battlefield edge, where a deeper or more open footprint would fall
  // outside and be correctly refused. A central unit has room to grow, so
  // the soldiers and preset edits below commit instead of refusing.
  await page.getByTestId('unit-position-x').fill('600');
  await page.locator('.map-caption').click();
  await page.getByTestId('unit-position-y').fill('400');
  await page.locator('.map-caption').click();
  await page.waitForTimeout(STEP_MS);

  // Editing soldiers updates the derived ranks and depth. React 19 flushes
  // the re-render a frame after the commit, so wait a beat before reading.
  await page.getByTestId('unit-soldiers').fill('150');
  await page.locator('.map-caption').click();
  await page.waitForTimeout(STEP_MS);
  const derived150 = (await page.getByTestId('unit-derived').textContent()) ?? '';
  check(
    'editing soldiers updates ranks and depth',
    /15 ranks/.test(derived150) &&
      /18\.0 m frontage/.test(derived150) &&
      /27\.0 m depth/.test(derived150),
    (derived150 ?? '').trim().slice(0, 120),
  );

  // Changing troop type pre-fills that type's normal preset; the preset
  // select then applies the open spacings in one step. React 19 flushes the
  // re-render a frame after the commit, so wait a beat before reading.
  await page.getByTestId('unit-troop').selectOption('peltast');
  await page.waitForTimeout(STEP_MS);
  check(
    'changing troop type pre-fills its normal spacing',
    (await page.getByTestId('unit-spacing-lateral').inputValue()) === '1.5' &&
      (await page.getByTestId('unit-spacing-depth').inputValue()) === '1.5',
  );
  await page.getByTestId('unit-preset').selectOption('open');
  await page.waitForTimeout(STEP_MS);
  const lateralOpen = await page.getByTestId('unit-spacing-lateral').inputValue();
  const depthOpen = await page.getByTestId('unit-spacing-depth').inputValue();
  check(
    'the open preset applies both spacings',
    lateralOpen === '3' && depthOpen === '3',
    `lateral=${lateralOpen} depth=${depthOpen}`,
  );

  // Duplicate names the copy uniquely; selecting on the map drives the
  // inspector back to the first unit. React 19 flushes the duplicate
  // re-render a frame after the commit, so settle before clicking the map.
  await page.getByTestId('unit-duplicate').click();
  check('duplicating adds a second row', (await oobUnit.count()) === 2);
  const oobDupTitles = await oobUnit.allTextContents();
  check(
    'the duplicate is uniquely named',
    oobDupTitles.some((entry) => /copy/.test(entry ?? '')),
    oobDupTitles.join(' | ').slice(0, 120),
  );
  await page.locator(`[data-testid="map-unit"][data-unit-id="${firstUnitId}"]`).waitFor({ state: 'visible', timeout: T_SAVE });
  await page.waitForTimeout(STEP_MS);
  await page.locator(`[data-testid="map-unit"][data-unit-id="${firstUnitId}"]`).click();
  const selectedUnitTitle = await page.getByTestId('unit-title').textContent();
  check(
    'selecting on the map selects the unit in the inspector',
    selectedUnitTitle === 'New Unit',
    selectedUnitTitle ?? '',
  );
}
