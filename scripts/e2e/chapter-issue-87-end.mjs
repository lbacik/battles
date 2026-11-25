// issue #87: a fixed-seed battle plays to an end condition (scripts/e2e.mjs lines 4301-4483).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, T_SAVE, T_LOAD, T_BATTLE } from './helpers.mjs';

export async function runIssue87End(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #87: a fixed-seed battle plays to an end condition — an army break
  // or the round limit — and the outcome screen shows the winner or the draw,
  // the reason, and both sides' losses. The Random opponent draws its own
  // seed, so the run is not turn-identical, but the battle seed is fixed and
  // the end condition is asserted structurally.
  const endContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await endContext.setDefaultTimeout(T_BATTLE);
  const endPage = await endContext.newPage();
  endPage.on('console', (message) => log(`end console: ${message.text()}`));
  endPage.on('pageerror', (error) => log(`end pageerror: ${String(error)}`));
  endPage.on('dialog', async (dialog) => {
    log(`end dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await endPage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await endPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await endPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 7;
  });

  const endProbeTitle = `End Probe ${Date.now()}`;
  await endPage.getByTestId('new-scenario-title').fill(endProbeTitle);
  await endPage.getByTestId('new-scenario-submit').click();
  await endPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  // Two hoplite blocks head-on, 80 m apart: far enough to place cleanly, close
  // enough to meet within a few turns.
  const endUnits = [
    { name: 'Athenian taxis', side: 'Athenians', x: 600, y: 440, facing: 180 },
    { name: 'Spartan mora', side: 'Spartans', x: 600, y: 360, facing: 0 },
  ];
  for (const [index, spec] of endUnits.entries()) {
    await endPage.getByTestId('oob-add').click();
    await endPage.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="oob-unit"]').length === expected,
      index + 1,
    );
    await endPage.getByTestId('unit-name').fill(spec.name);
    await endPage.locator('.map-caption').click();
    await endPage.getByTestId('unit-side').selectOption({ label: spec.side });
    await endPage.getByTestId('unit-troop').selectOption('hoplite');
    await endPage.getByTestId('unit-soldiers').fill('200');
    await endPage.locator('.map-caption').click();
    await endPage.getByTestId('unit-files').fill('16');
    await endPage.locator('.map-caption').click();
    await endPage.getByTestId('unit-position-x').fill(String(spec.x));
    await endPage.locator('.map-caption').click();
    await endPage.getByTestId('unit-position-y').fill(String(spec.y));
    await endPage.locator('.map-caption').click();
    await endPage.getByTestId('unit-facing').fill(String(spec.facing));
    await endPage.locator('.map-caption').click();
  }
  check(
    'end probe fields two hoplite units',
    (await endPage.getByTestId('oob-unit').count()) === 2,
  );
  await endPage.getByTestId('save-scenario').click();
  await waitForSave(endPage);
  await endPage.getByTestId('start-battle-editor').click();
  await endPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await endPage.getByTestId('controller-side-b').selectOption('random');
  await endPage.getByTestId('begin-battle').click();
  await endPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  // The automated side's own turn never offers concede: the button stays
  // disabled while the test player is up.
  if ((await endPage.getByTestId('continue-turn').count()) > 0) {
    check(
      "concede is unavailable on the automated side's turn",
      await endPage.getByTestId('concede').isDisabled(),
    );
  }

  // The human side holds (empty commits) while the Random side manoeuvres.
  // Every resolution ends behind the device handoff; the round limit ends the
  // battle after the last turn of the limit round at the latest.
  async function advanceEndStep() {
    if ((await endPage.getByTestId('battle-outcome').count()) > 0) return false;
    if ((await endPage.getByTestId('handoff').count()) > 0) {
      // Pressing the handoff either unlocks the human side (its commit
      // appears) or resolves the automated side at once behind a fresh
      // handoff for the other side (its text changes). In between, while the
      // automated turn resolves, neither is on screen yet.
      const handoffBefore = await endPage.getByTestId('handoff').textContent();
      await endPage.getByTestId('handoff').click();
      await endPage.waitForFunction(
        (previous) => {
          if (document.querySelector('[data-testid="battle-outcome"]')) return true;
          if (document.querySelector('[data-testid="commit-empty"]')) return true;
          const handoff = document.querySelector('[data-testid="handoff"]');
          return !!handoff && handoff.textContent !== previous;
        },
        handoffBefore,
        { timeout: T_BATTLE },
      );
      return true;
    }
    const endController = (await endPage.getByTestId('turn-controller').textContent()) ?? '';
    if (!endController.startsWith('human')) {
      await endPage.getByTestId('continue-turn').click();
      await endPage.waitForFunction(
        () =>
          document.querySelector('[data-testid="handoff"]') ||
          document.querySelector('[data-testid="battle-outcome"]'),
        null,
        { timeout: T_BATTLE },
      );
      return true;
    }
    await endPage.getByTestId('commit-empty').click();
    await endPage.getByTestId('commit-confirm').waitFor({ timeout: T_SAVE });
    await endPage.getByTestId('confirm-commit').click();
    await endPage.waitForFunction(
      () =>
        document.querySelector('[data-testid="handoff"]') ||
        document.querySelector('[data-testid="battle-outcome"]'),
      null,
      { timeout: T_BATTLE },
    );
    return true;
  }
  for (let step = 0; step < 36; step += 1) {
    if (!(await advanceEndStep())) break;
  }
  check(
    'a fixed-seed battle reaches an end condition',
    (await endPage.getByTestId('battle-outcome').count()) > 0,
  );
  const endOutcomeTitle = (await endPage.getByTestId('outcome-title').textContent()) ?? '';
  const endOutcomeReason = (await endPage.getByTestId('outcome-reason').textContent()) ?? '';
  check(
    'the outcome names a winner or a draw',
    /wins|Draw/.test(endOutcomeTitle),
    endOutcomeTitle,
  );
  check(
    'the outcome gives the end-condition reason',
    /break|round limit|concession/i.test(endOutcomeReason),
    endOutcomeReason.slice(0, 200),
  );
  if (/round limit/i.test(endOutcomeReason)) {
    const endMargin = (await endPage.getByTestId('outcome-margin').textContent()) ?? '';
    check(
      'the round limit shows both lost shares and the margin',
      /Draw margin/.test(endMargin) && /difference/.test(endMargin) &&
        (await endPage.getByTestId('outcome-losses').locator('li').count()) === 2,
      endMargin.slice(0, 160),
    );
  } else {
    check(
      "the outcome lists both sides' losses",
      (await endPage.getByTestId('outcome-losses').locator('li').count()) === 2,
    );
  }
  const endLog = (await endPage.getByTestId('battle-log').textContent()) ?? '';
  check(
    'the battle log records the battle end',
    /wins|draw/i.test(endLog),
    endLog.replace(/\s+/g, ' ').slice(-200),
  );

  // The end state survives a reload unchanged.
  await endPage.reload({ waitUntil: 'networkidle' });
  await endPage.getByTestId('battle-outcome').waitFor({ timeout: T_BATTLE });
  check(
    'reloading keeps the end-condition outcome',
    ((await endPage.getByTestId('outcome-title').textContent()) ?? '') === endOutcomeTitle,
  );
  await endPage.getByTestId('back-to-battles').click();
  await endPage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  check(
    'the battles list shows the ended battle',
    (await endPage.getByTestId('battle-row').count()) === 1 &&
      /Finished/.test((await endPage.getByTestId('battle-row-meta').textContent()) ?? ''),
  );
  await endPage.getByTestId('delete-battle').click();
  await endPage.getByTestId('empty-battles').waitFor({ timeout: T_SAVE });
  check('deleting removes the ended battle', true);

  await endContext.close();
}
