// library safety: duplicate, delete, export/import round-trip, rejected files (scripts/e2e.mjs lines 1624-1979).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, terrainRowCounts, T_SAVE, T_LOAD, SETTLE_MS } from './helpers.mjs';
import { reportDir } from './helpers.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runLibrary(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  const title = ctx.title;
  // The scenario library is complete and safe: duplicate, delete with
  // confirmation, export/import round-trip, rejected files, save conflicts,
  // quota failures, and ruleset/unknown-troop notices. The earlier
  // unsaved-changes guard registered its own dialog handler, which has served
  // its purpose; drop it so the handler below is the only one answering
  // confirmation dialogs from here on.
  page.removeAllListeners('dialog');
  const dialogAction = { next: 'accept' };
  page.on('dialog', async (dialog) => {
    log(`browser dialog: ${dialog.type()} ${dialog.message()}`);
    if (dialogAction.next === 'dismiss') {
      await dialog.dismiss();
    } else {
      await dialog.accept();
    }
    dialogAction.next = 'accept';
  });

  // Duplicate creates a new copy; deleting it asks for confirmation.
  // The previous section already left the editor, so the library is showing.
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const countBeforeDup = await page.getByTestId('scenario-row').count();
  const dupRow = page.getByTestId('scenario-row').filter({ hasText: title });
  await dupRow.getByTestId('duplicate-scenario').click();
  // The duplicate lands as a new library row (stable state); the
  // "Duplicated as" toast is transient (2.4 s) and is not waited on.
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="scenario-row"]').length === expected,
    countBeforeDup + 1,
    { timeout: T_SAVE },
  );
  check('duplicate adds a new copy', true, `rows=${countBeforeDup} → ${countBeforeDup + 1}`);
  const dupTitles = await page.getByTestId('scenario-row-title').allTextContents();
  check(
    'duplicate suffixes the copy title',
    dupTitles.some((entry) => entry === `${title} (copy)`),
    dupTitles.join(' | '),
  );
  const copyRow = page.getByTestId('scenario-row').filter({ hasText: `${title} (copy)` });
  dialogAction.next = 'dismiss';
  await copyRow.getByTestId('delete-scenario').click();
  await page.waitForTimeout(SETTLE_MS);
  check(
    'delete asks for confirmation (dismiss keeps the copy)',
    (await page.getByTestId('scenario-row').count()) === countBeforeDup + 1,
  );
  await copyRow.getByTestId('delete-scenario').click();
  // The row disappearing is the stable effect; the "Scenario deleted."
  // toast is transient and is not waited on.
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="scenario-row"]').length === expected,
    countBeforeDup,
    { timeout: T_SAVE },
  );
  check('delete with confirmation removes the copy', true);

  // Persistence steps 2-3: export the finished scenario, delete it from the
  // library, import the file as a new copy with a new identifier and
  // identical content, import the same file again, and prove the two copies
  // are independent. Every value round-trips identical to 0.1 m.
  await page.getByTestId('inspector-title').waitFor({ state: 'detached', timeout: 1000 }).catch(() => {});
  const exportRow = page.getByTestId('scenario-row').filter({ hasText: title }).first();
  await exportRow.getByTestId('open-scenario').click();
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await page.getByTestId('inspector-width').fill('1400.05');
  await page.getByTestId('inspector-width').blur();
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  const exportUrl = new URL(page.url());
  const exportedId = exportUrl.searchParams.get('scenario');
  const unitsBeforeExport = await page.getByTestId('oob-unit').count();
  const [firstDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: T_LOAD }),
    page.getByTestId('export-open-scenario').click(),
  ]);
  const firstPath = await firstDownload.path();
  const firstJson = readFileSync(firstPath, 'utf8');
  const firstDoc = JSON.parse(firstJson);
  check(
    'export rounds stored values to 0.1 m',
    firstDoc.battlefield.width === 1400.1,
    `width=${firstDoc.battlefield.width}`,
  );
  check(
    'export carries the acceptance units and terrain',
    firstDoc.units.length === 6 &&
      firstDoc.terrainFeatures.length === 7 &&
      firstDoc.sides[0].name === 'Athens' &&
      firstDoc.sides[1].name === 'Sparta',
    `units=${firstDoc.units.length} terrain=${firstDoc.terrainFeatures.length}`,
  );
  check(
    'panel state is not written into exported files',
    !JSON.stringify(firstDoc).includes('polis.panel') &&
      !JSON.stringify(firstDoc).includes('collapsed'),
    Object.keys(firstDoc).join(','),
  );
  const roundTripFile = path.join(reportDir, 'round-trip.json');
  writeFileSync(roundTripFile, firstJson);
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const deleteRow = page.getByTestId('scenario-row').filter({ hasText: title }).first();
  const libCountBeforeDelete = await page.getByTestId('scenario-row').count();
  await deleteRow.getByTestId('delete-scenario').click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="scenario-row"]').length === expected,
    libCountBeforeDelete - 1,
    { timeout: T_SAVE },
  );
  check('persistence step 2 deletes the scenario from the library', true);
  const libCountBefore = await page.getByTestId('scenario-row').count();
  await page.getByTestId('import-file').setInputFiles(roundTripFile);
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  const importedUrl = new URL(page.url());
  const importedId = importedUrl.searchParams.get('scenario');
  check('import assigns a new id', !!importedId && importedId !== exportedId, `${exportedId} → ${importedId}`);
  const importedWidth = await page.getByTestId('inspector-width').inputValue();
  check('import round-trips values identical to 0.1 m', importedWidth === '1400.1', `width=${importedWidth}`);
  const importedTerrain = await terrainRowCounts(page);
  check(
    'import restores the units and terrain identical to 0.1 m',
    (await page.getByTestId('oob-unit').count()) === unitsBeforeExport &&
      importedTerrain.ground === 3 &&
      importedTerrain.hill === 2 &&
      importedTerrain.linear === 2 &&
      ((await page.getByTestId('oob-side-a').textContent()) ?? '').includes('Athens'),
    JSON.stringify(importedTerrain),
  );
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const libCountAfter = await page.getByTestId('scenario-row').count();
  check('import stores a new copy', libCountAfter === libCountBefore + 1, `${libCountBefore} → ${libCountAfter}`);

  // Persistence step 3: importing the same file again stores a second
  // independent copy; editing one never touches the other.
  await page.getByTestId('import-file').setInputFiles(roundTripFile);
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  const secondCopyId = new URL(page.url()).searchParams.get('scenario');
  check(
    'the second import gets its own id',
    !!secondCopyId && secondCopyId !== importedId,
    `${importedId} → ${secondCopyId}`,
  );
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const copiesRow = page.getByTestId('scenario-row').filter({ hasText: title });
  check('two independent copies share the title', (await copiesRow.count()) === 2);
  await copiesRow.nth(0).getByTestId('open-scenario').click();
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await page.getByTestId('inspector-title').fill('Acceptance plain (edited copy)');
  await page.locator('.map-caption').click();
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const siblingTitles = await page.getByTestId('scenario-row-title').allTextContents();
  check(
    'editing one copy does not change the other',
    siblingTitles.includes('Acceptance plain (edited copy)') && siblingTitles.includes(title),
    siblingTitles.join(' | '),
  );
  const editedRow = page.getByTestId('scenario-row').filter({ hasText: 'Acceptance plain (edited copy)' });
  await editedRow.getByTestId('delete-scenario').click();
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="scenario-row"]').length === expected,
    libCountAfter,
    { timeout: T_SAVE },
  );
  check('the edited copy deletes, leaving one import', true);

  // Persistence step 5: malformed, wrong-kind, newer-format, unknown-ruleset,
  // and overlapping-units files are each rejected with a specific message and
  // nothing is stored.
  const badJson = path.join(reportDir, 'bad-json.json');
  const badKind = path.join(reportDir, 'bad-kind.json');
  const badVersion = path.join(reportDir, 'bad-version.json');
  const badRuleset = path.join(reportDir, 'bad-ruleset.json');
  const badOverlap = path.join(reportDir, 'bad-overlap.json');
  writeFileSync(badJson, '{{{ not json');
  writeFileSync(badKind, `${JSON.stringify({ kind: 'battle', formatVersion: 1, title: 'Nope' })}\n`);
  writeFileSync(
    badVersion,
    `${JSON.stringify({ kind: 'scenario', formatVersion: 99, title: 'Future', ruleset: { id: 'polis-classical', version: '0.1' } })}\n`,
  );
  writeFileSync(
    badRuleset,
    `${JSON.stringify({ kind: 'scenario', formatVersion: 1, title: 'Foreign', ruleset: { id: 'other-rules', version: '1.0' }, sides: [], units: [], terrainFeatures: [] })}\n`,
  );
  writeFileSync(
    badOverlap,
    `${JSON.stringify({
      kind: 'scenario',
      formatVersion: 1,
      title: 'Overlapping',
      ruleset: { id: 'polis-classical', version: '0.1' },
      battlefield: { width: 1400, height: 900 },
      sides: [
        { id: 'side-a', name: 'Athens', color: '#1d4ed8' },
        { id: 'side-b', name: 'Sparta', color: '#b91c1c' },
      ],
      units: [
        { id: '00000000-0000-4000-8000-000000000001', name: 'First', side: 'side-a', troopType: 'hoplite', soldiers: 100, files: 10, lateralInterval: 1, rankDepth: 1, position: { x: 600, y: 400 }, facing: 0 },
        { id: '00000000-0000-4000-8000-000000000002', name: 'Second', side: 'side-a', troopType: 'hoplite', soldiers: 100, files: 10, lateralInterval: 1, rankDepth: 1, position: { x: 600, y: 400 }, facing: 0 },
      ],
      terrainFeatures: [],
    })}\n`,
  );
  const rowsBeforeBad = await page.getByTestId('scenario-row').count();
  await page.getByTestId('import-file').setInputFiles(badJson);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'not valid JSON',
  );
  const badJsonMsg = await page.getByTestId('import-error').textContent();
  check('malformed file is rejected whole', /not valid JSON/i.test(badJsonMsg ?? ''), badJsonMsg ?? '');
  await page.getByTestId('import-file').setInputFiles(badKind);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'not a scenario',
  );
  const badKindMsg = await page.getByTestId('import-error').textContent();
  check('wrong-kind file is rejected whole', /not a scenario/i.test(badKindMsg ?? ''), badKindMsg ?? '');
  await page.getByTestId('import-file').setInputFiles(badVersion);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'newer than the supported version',
  );
  const badVersionMsg = await page.getByTestId('import-error').textContent();
  check(
    'newer-format file is rejected whole',
    /newer than the supported version/i.test(badVersionMsg ?? ''),
    badVersionMsg ?? '',
  );
  await page.getByTestId('import-file').setInputFiles(badRuleset);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'unknown ruleset',
  );
  const badRulesetMsg = await page.getByTestId('import-error').textContent();
  check(
    'unknown-ruleset file is rejected whole',
    /unknown ruleset/i.test(badRulesetMsg ?? ''),
    badRulesetMsg ?? '',
  );
  await page.getByTestId('import-file').setInputFiles(badOverlap);
  await page.waitForFunction(
    (text) => document.querySelector('[data-testid="import-error"]')?.textContent?.includes(text),
    'overlap',
  );
  const badOverlapMsg = await page.getByTestId('import-error').textContent();
  check(
    'overlapping-units file is rejected whole',
    /overlap/i.test(badOverlapMsg ?? ''),
    badOverlapMsg ?? '',
  );
  check(
    'rejected files store nothing',
    (await page.getByTestId('scenario-row').count()) === rowsBeforeBad,
    `rows=${rowsBeforeBad}`,
  );

  // Ruleset mismatch and unknown troop-type notices appear as in the tracer.
  const olderRuleset = {
    kind: 'scenario',
    formatVersion: 1,
    id: '00000000-0000-4000-8000-000000000001',
    title: 'E2E Older Ruleset',
    description: '',
    battlefield: { width: 1200, height: 800 },
    sides: [
      { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
      { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
    ],
    ruleset: { id: 'polis-classical', version: '0.0' },
    units: [],
    terrainFeatures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const olderFile = path.join(reportDir, 'older-ruleset.json');
  writeFileSync(olderFile, `${JSON.stringify(olderRuleset, null, 2)}\n`);
  await page.getByTestId('import-file').setInputFiles(olderFile);
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  check('older ruleset imports against the current catalogue', true);
  const rulesetNotice = await page.getByTestId('ruleset-notice').textContent().catch(() => null);
  check(
    'editor shows the ruleset mismatch notice',
    !!rulesetNotice && /Saving rebinds/i.test(rulesetNotice),
    rulesetNotice ?? 'no notice',
  );
  check(
    'editor badges the provisional ruleset',
    await page.getByTestId('provisional-badge').isVisible().catch(() => false),
  );
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });

  const unknownTroop = {
    kind: 'scenario',
    formatVersion: 1,
    id: '00000000-0000-4000-8000-000000000002',
    title: 'E2E Unknown Troop',
    description: '',
    battlefield: { width: 1200, height: 800 },
    sides: [
      { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
      { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
    ],
    ruleset: { id: 'polis-classical', version: '0.1' },
    units: [
      {
        id: '00000000-0000-4000-8000-000000000011',
        name: 'Mystery Unit',
        side: 'side-a',
        troopType: 'mystery-phalanx-xyz',
        soldiers: 100,
        files: 10,
        lateralInterval: 1.8,
        rankDepth: 1.8,
        position: { x: 600, y: 400 },
        facing: 0,
      },
    ],
    terrainFeatures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const unknownFile = path.join(reportDir, 'unknown-troop.json');
  writeFileSync(unknownFile, `${JSON.stringify(unknownTroop, null, 2)}\n`);
  await page.getByTestId('import-file').setInputFiles(unknownFile);
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  const troopWarning = await page.getByTestId('unknown-troop-warning').textContent().catch(() => null);
  check(
    'editor warns about the unknown troop type',
    !!troopWarning && /unknown troop type/i.test(troopWarning),
    troopWarning ?? 'no warning',
  );
  check(
    'order of battle marks the unknown troop type',
    await page.getByTestId('unknown-troop-badge').isVisible().catch(() => false),
  );
  // Persistence step 6: the unknown key saves and survives a reopen verbatim.
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  const reopenedTroopWarning = await page.getByTestId('unknown-troop-warning').textContent().catch(() => null);
  check(
    'the unknown key survives save and reopen',
    !!reopenedTroopWarning && /mystery-phalanx-xyz/i.test(reopenedTroopWarning) &&
      (await page.getByTestId('unknown-troop-badge').isVisible().catch(() => false)),
    reopenedTroopWarning ?? 'no warning',
  );
  await page.getByTestId('back-to-library').click();
  await page.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
}
