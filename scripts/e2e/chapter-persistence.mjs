// persistence: unknown records, save conflicts, quota, storage refusal (scripts/e2e.mjs lines 1980-2174).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runPersistence(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  const title = ctx.title;
  // Stored records with an unknown ruleset or a newer format list as
  // unreadable with their cause and offer only raw export or delete.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('polis-scenarios', 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('scenarios', 'readwrite');
      const store = tx.objectStore('scenarios');
      const now = new Date().toISOString();
      const base = {
        kind: 'scenario',
        formatVersion: 1,
        title: 'E2E Foreign Ruleset',
        description: '',
        battlefield: { width: 1200, height: 800 },
        sides: [
          { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
          { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
        ],
        units: [],
        terrainFeatures: [],
        createdAt: now,
        updatedAt: now,
      };
      const foreign = { ...base, id: '00000000-0000-4000-8000-000000000021', ruleset: { id: 'other-rules', version: '1.0' } };
      const future = {
        ...base,
        id: '00000000-0000-4000-8000-000000000022',
        title: 'E2E Future Format',
        formatVersion: 99,
        ruleset: { id: 'polis-classical', version: '0.1' },
      };
      store.put({ id: foreign.id, document: foreign, revision: 1, updatedAt: now });
      store.put({ id: future.id, document: future, revision: 1, updatedAt: now });
      tx.oncomplete = () => { db.close(); resolve(undefined); };
      tx.onerror = () => reject(tx.error);
    };
  }));
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByTestId('scenario-list').waitFor({ timeout: T_LOAD });
  const foreignRow = page.getByTestId('scenario-row').filter({ hasText: 'E2E Foreign Ruleset' });
  const foreignCause = await foreignRow.getByTestId('scenario-row-cause').textContent().catch(() => null);
  check(
    'library lists the unknown ruleset with its cause',
    !!foreignCause && /unknown ruleset/i.test(foreignCause),
    foreignCause ?? 'no cause',
  );
  check(
    'unreadable entries offer only raw export or delete',
    (await foreignRow.getByTestId('export-raw-scenario').count()) === 1 &&
      (await foreignRow.getByTestId('open-scenario').count()) === 0 &&
      (await foreignRow.getByTestId('duplicate-scenario').count()) === 0,
  );
  const futureRow = page.getByTestId('scenario-row').filter({ hasText: 'E2E Future Format' });
  const futureCause = await futureRow.getByTestId('scenario-row-cause').textContent().catch(() => null);
  check(
    'library lists the newer format with its cause',
    !!futureCause && /newer/i.test(futureCause),
    futureCause ?? 'no cause',
  );

  // A two-tab save conflict is detected and the author chooses how to
  // proceed; nothing is silently overwritten.
  await page.getByTestId('new-scenario-title').fill(`Conflict Probe ${Date.now()}`);
  await page.getByTestId('new-scenario-submit').click();
  await page.getByTestId('editor').waitFor({ timeout: T_LOAD });
  const conflictId = new URL(page.url()).searchParams.get('scenario');
  check('conflict probe opens', !!conflictId, String(conflictId));
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  const page2 = await context.newPage();
  page2.on('console', (message) => log(`browser2 console: ${message.text()}`));
  page2.on('pageerror', (error) => log(`browser2 pageerror: ${String(error)}`));
  await page2.goto(`${base}/?scenario=${encodeURIComponent(conflictId)}`, { waitUntil: 'networkidle' });
  await page2.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await page2.getByTestId('inspector-title').fill('Conflict Other Tab');
  await page2.getByTestId('inspector-title').blur();
  await page2.getByTestId('save-scenario').click();
  await waitForSave(page2);
  await page.getByTestId('inspector-title').fill('Conflict Mine');
  await page.getByTestId('inspector-title').blur();
  await page.getByTestId('save-scenario').click();
  await page.getByTestId('conflict-dialog').waitFor({ timeout: T_SAVE });
  const conflictText = await page.getByTestId('conflict-dialog').textContent();
  const conflictRevs = [...(conflictText ?? '').matchAll(/revision (\d+)/g)].map((match) => match[1]);
  check(
    'two-tab save conflict is detected',
    conflictRevs.length >= 2 && conflictRevs[0] !== conflictRevs[1],
    (conflictText ?? '').replace(/\s+/g, ' ').slice(0, 200),
  );
  await page.getByTestId('conflict-cancel').click();
  await page.waitForTimeout(SETTLE_MS);
  check('cancel keeps the conflicted edits without storing', !(await page.getByTestId('conflict-dialog').count()));
  await page2.reload({ waitUntil: 'networkidle' });
  await page2.getByTestId('editor').waitFor({ timeout: T_LOAD });
  const storedAfterCancel = await page2.getByTestId('inspector-title').inputValue();
  check('nothing is silently overwritten on cancel', storedAfterCancel === 'Conflict Other Tab', storedAfterCancel);
  await page.getByTestId('save-scenario').click();
  await page.getByTestId('conflict-dialog').waitFor({ timeout: T_SAVE });
  await page.getByTestId('conflict-overwrite').click();
  await waitForSave(page);
  check('overwrite resolves the conflict', !(await page.getByTestId('conflict-dialog').count()));
  const overwriteStatus = await page.getByTestId('save-status').textContent();
  check('overwrite reports the saved state', overwriteStatus === 'Saved', `status=${overwriteStatus}`);
  await page2.getByTestId('inspector-title').fill('Conflict Stale Tab');
  await page2.getByTestId('inspector-title').blur();
  await page2.getByTestId('save-scenario').click();
  await page2.getByTestId('conflict-dialog').waitFor({ timeout: T_SAVE });
  await page2.getByTestId('conflict-copy').click();
  // The copy opens under a new scenario id (stable state); the transient
  // "Saved as a new copy" toast is not waited on.
  await page2.waitForFunction(
    (previous) => new URL(window.location.href).searchParams.get('scenario') !== previous,
    conflictId,
    { timeout: T_SAVE },
  );
  const copyId = new URL(page2.url()).searchParams.get('scenario');
  check('save as copy keeps both versions', !!copyId && copyId !== conflictId, `${conflictId} → ${copyId}`);
  await page2.close();

  // A quota failure is reported without losing the open scenario.
  await page.evaluate(() => {
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
  await page.getByTestId('inspector-title').fill('Conflict Mine Quota');
  await page.getByTestId('inspector-title').blur();
  await page.getByTestId('save-scenario').click();
  await page.getByTestId('save-error').waitFor({ timeout: T_SAVE });
  const quotaMsg = await page.getByTestId('save-error').textContent();
  check(
    'quota failure is reported without losing edits',
    /quota/i.test(quotaMsg ?? '') || /storage is full/i.test(quotaMsg ?? ''),
    quotaMsg ?? 'no message',
  );
  check(
    'open scenario survives the quota failure',
    (await page.getByTestId('inspector-title').inputValue()) === 'Conflict Mine Quota' &&
      (await page.getByTestId('unsaved-pill').count()) === 1,
  );
  await page.getByTestId('save-scenario').click();
  await waitForSave(page);
  check('save succeeds after the quota failure', true);

  // A refused persistent-storage request is reported in the library.
  const storageContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  });
  await storageContext.setDefaultTimeout(T_BATTLE);
  await storageContext.addInitScript(() => {
    try {
      Object.defineProperty(navigator, 'storage', {
        value: {
          persist: async () => false,
          persisted: async () => false,
        },
        configurable: true,
      });
    } catch {
      // The storage note simply stays silent when it cannot be stubbed.
    }
  });
  const storagePage = await storageContext.newPage();
  storagePage.on('console', (message) => log(`storage console: ${message.text()}`));
  storagePage.on('pageerror', (error) => log(`storage pageerror: ${String(error)}`));
  await storagePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await storagePage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await storagePage.getByTestId('new-scenario-title').fill(`Storage Probe ${Date.now()}`);
  await storagePage.getByTestId('new-scenario-submit').click();
  await storagePage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await storagePage.getByTestId('save-scenario').click();
  await waitForSave(storagePage);
  await storagePage.getByTestId('back-to-library').click();
  await storagePage.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });
  const storageNote = await storagePage.getByTestId('storage-note').textContent();
  check(
    'refused persistent storage is reported',
    /refused|evicted|only backup/i.test(storageNote ?? ''),
    (storageNote ?? '').replace(/\s+/g, ' ').slice(0, 200),
  );
  await storageContext.close();
}
