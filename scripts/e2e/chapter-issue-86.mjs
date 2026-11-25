// issue #86: the turn result panel and the battle log (scripts/e2e.mjs lines 3089-3297).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, clickHandoffAndSettle, T_SAVE, T_LOAD, T_BATTLE } from './helpers.mjs';

export async function runIssue86(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #86: the turn result panel, changed-unit highlights, and the battle
  // log after a turn with combat. Fresh storage with a fixed setup seed; the
  // Random opponent draws its own seed, so the run advances turns until a
  // resolved turn lists combat losses (up to 16 steps).
  const combatContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await combatContext.setDefaultTimeout(T_BATTLE);
  const combatPage = await combatContext.newPage();
  combatPage.on('console', (message) => log(`combat console: ${message.text()}`));
  combatPage.on('pageerror', (error) => log(`combat pageerror: ${String(error)}`));
  // Deleting the battle asks for confirmation; an unhandled dialog is
  // dismissed, which would keep the battle.
  combatPage.on('dialog', async (dialog) => {
    log(`combat dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await combatPage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await combatPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await combatPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 7;
  });

  const combatTitle = `Combat Probe ${Date.now()}`;
  await combatPage.getByTestId('new-scenario-title').fill(combatTitle);
  await combatPage.getByTestId('new-scenario-submit').click();
  await combatPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  // Two hoplite blocks head-on, 80 m apart: far enough to place cleanly, close
  // enough to meet within a few turns.
  const combatUnits = [
    { name: 'Athenian taxis', side: 'Athenians', x: 600, y: 440, facing: 180 },
    { name: 'Spartan mora', side: 'Spartans', x: 600, y: 360, facing: 0 },
  ];
  for (const [index, spec] of combatUnits.entries()) {
    await combatPage.getByTestId('oob-add').click();
    await combatPage.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="oob-unit"]').length === expected,
      index + 1,
    );
    await combatPage.getByTestId('unit-name').fill(spec.name);
    await combatPage.locator('.map-caption').click();
    await combatPage.getByTestId('unit-side').selectOption({ label: spec.side });
    await combatPage.getByTestId('unit-troop').selectOption('hoplite');
    await combatPage.getByTestId('unit-soldiers').fill('200');
    await combatPage.locator('.map-caption').click();
    await combatPage.getByTestId('unit-files').fill('16');
    await combatPage.locator('.map-caption').click();
    await combatPage.getByTestId('unit-position-x').fill(String(spec.x));
    await combatPage.locator('.map-caption').click();
    await combatPage.getByTestId('unit-position-y').fill(String(spec.y));
    await combatPage.locator('.map-caption').click();
    await combatPage.getByTestId('unit-facing').fill(String(spec.facing));
    await combatPage.locator('.map-caption').click();
  }
  check(
    'combat probe fields two hoplite units',
    (await combatPage.getByTestId('oob-unit').count()) === 2,
  );
  await combatPage.getByTestId('save-scenario').click();
  await waitForSave(combatPage);
  await combatPage.getByTestId('start-battle-editor').click();
  await combatPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await combatPage.getByTestId('controller-side-b').selectOption('random');
  await combatPage.getByTestId('begin-battle').click();
  await combatPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  // The human side holds (empty commits) while the Random side manoeuvres and
  // charges. Every resolution ends behind the device handoff; an automated
  // side pressed through the handoff resolves at once.
  async function advanceCombatStep() {
    if ((await combatPage.getByTestId('battle-outcome').count()) > 0) return false;
    const roundBefore = (await combatPage.getByTestId('round').textContent()) ?? '';
    const outcomeWait = () =>
      combatPage.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="round"]')?.textContent !== expected ||
          document.querySelector('[data-testid="battle-outcome"]'),
        roundBefore,
        { timeout: T_BATTLE },
      );
    const handoffBefore = (await combatPage.getByTestId('handoff').count()) > 0;
    const controller = (await combatPage.getByTestId('turn-controller').textContent()) ?? '';
    if (handoffBefore) {
      await clickHandoffAndSettle(combatPage);
    }
    if (!controller.startsWith('human')) {
      if (!handoffBefore) {
        // The settled automated first turn is the only place Continue is
        // pressed: it is stable until pressed, so an enabled guard plus the
        // default 60 s wait covers slow first paints without ever touching
        // the transient disabled Continue while a handoff resolution is in
        // flight (issue #157).
        await combatPage.getByTestId('continue-turn').waitFor({ timeout: T_BATTLE });
        if ((await combatPage.getByTestId('handoff').count()) > 0) {
          // A handoff appeared while waiting: the turn already resolved
          // behind it, so there is no settled Continue to press (issue #157).
        } else if (await combatPage.getByTestId('continue-turn').isEnabled()) {
          await combatPage.getByTestId('continue-turn').click();
        }
      }
      await outcomeWait();
      await combatPage.waitForFunction(
        () =>
          document.querySelector('[data-testid="handoff"]') ||
          document.querySelector('[data-testid="battle-outcome"]'),
        null,
        { timeout: T_BATTLE },
      );
      return true;
    }
    await combatPage.getByTestId('commit-empty').waitFor({ timeout: T_BATTLE });
    await combatPage.getByTestId('commit-empty').click();
    await combatPage.getByTestId('commit-confirm').waitFor({ timeout: T_SAVE });
    await combatPage.getByTestId('confirm-commit').click();
    await outcomeWait();
    return true;
  }
  let combatResult = '';
  for (let step = 0; step < 16; step += 1) {
    if (!(await advanceCombatStep())) break;
    combatResult = (await combatPage.getByTestId('turn-result').count()) > 0
      ? ((await combatPage.getByTestId('turn-result').textContent()) ?? '')
      : '';
    if (/lost/i.test(combatResult)) break;
  }
  check(
    'a turn with combat lists losses with their chance outcome',
    /lost/i.test(combatResult) && /draw/i.test(combatResult),
    combatResult.replace(/\s+/g, ' ').slice(0, 240),
  );
  check(
    'the turn result groups contacts, losses, cohesion, and routs',
    /Contacts/.test(combatResult) &&
      /Losses/.test(combatResult) &&
      /Cohesion/.test(combatResult) &&
      /Routs/.test(combatResult),
    combatResult.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'changed units highlight on the battlefield map',
    (await combatPage.locator('[data-testid="map-unit"][data-changed="true"]').count()) >= 1,
    `${await combatPage.locator('[data-testid="map-unit"][data-changed="true"]').count()} marked`,
  );
  check(
    'changed units highlight in the order of battle',
    (await combatPage.locator('[data-testid="battle-oob-unit"][data-changed="true"]').count()) >= 1,
    `${await combatPage.locator('[data-testid="battle-oob-unit"][data-changed="true"]').count()} marked`,
  );
  const combatLog = (await combatPage.getByTestId('battle-log').textContent()) ?? '';
  check(
    'the battle log groups the whole battle by round, turn, and phase',
    /Round \d+ · Turn \d+/.test(combatLog) && /Combat/.test(combatLog),
    combatLog.replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    'the battle log names the fighting units',
    /Athenian taxis/.test(combatLog) && /Spartan mora/.test(combatLog),
  );

  // The resolved turn waits behind the device handoff: pressing it keeps the
  // highlights and unlocks drafting (human) or resolves at once (automated).
  check(
    'the combat turn ends behind the device handoff',
    await combatPage.getByTestId('handoff').isVisible(),
  );
  const combatHandoff = (await combatPage.getByTestId('handoff').textContent()) ?? '';
  check(
    'the device handoff names the next side',
    /— begin your turn/.test(combatHandoff),
    combatHandoff.replace(/\s+/g, ' ').slice(0, 80),
  );
  const combatNext = (await combatPage.getByTestId('turn-controller').textContent()) ?? '';
  await clickHandoffAndSettle(combatPage);
  if (combatNext.startsWith('human')) {
    await combatPage.getByTestId('commit-empty').waitFor({ timeout: T_BATTLE });
    check(
      'highlights persist after the handoff',
      (await combatPage.locator('[data-testid="map-unit"][data-changed="true"]').count()) >= 1,
    );
    check(
      'the handoff unlocks drafting',
      await combatPage.getByTestId('commit-empty').isVisible(),
    );
  } else {
    await combatPage.getByTestId('handoff').waitFor({ timeout: T_BATTLE });
    check('an automated side resolves at once behind a fresh handoff', true);
  }

  // The log and the result survive a reload unchanged.
  const combatRoundBefore = await combatPage.getByTestId('round').textContent();
  const combatResultBefore = (await combatPage.getByTestId('turn-result').textContent()) ?? '';
  const combatLogBefore = (await combatPage.getByTestId('battle-log').textContent()) ?? '';
  await combatPage.reload({ waitUntil: 'networkidle' });
  await combatPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  check(
    'reloading keeps the round after combat',
    (await combatPage.getByTestId('round').textContent()) === combatRoundBefore,
    (await combatPage.getByTestId('round').textContent()) ?? 'no round',
  );
  check(
    'reloading keeps the identical turn result',
    ((await combatPage.getByTestId('turn-result').textContent()) ?? '') === combatResultBefore,
    ((await combatPage.getByTestId('turn-result').textContent()) ?? '').replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'reloading keeps the identical battle log',
    ((await combatPage.getByTestId('battle-log').textContent()) ?? '') === combatLogBefore,
  );
  await combatPage.getByTestId('back-to-battles').click();
  await combatPage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  check(
    'the battles list shows the combat battle',
    (await combatPage.getByTestId('battle-row').count()) === 1,
  );
  await combatPage.getByTestId('delete-battle').click();
  await combatPage.getByTestId('empty-battles').waitFor({ timeout: T_SAVE });
  check('deleting removes the combat battle', true);

  await combatContext.close();
}
