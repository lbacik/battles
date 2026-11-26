// issue #113: the battle screen remembers collapsed panels across reloads (scripts/e2e.mjs lines 2702-2875).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { T_SAVE, T_LOAD, T_BATTLE, STEP_MS } from './helpers.mjs';

export async function runIssue113Battle(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  const battlePage = ctx.battlePage;
  const roundText = ctx.roundText;
  // Issue #113: the battle screen remembers collapsed panels across reloads,
  // independently of the editor. Panel state is browser-only UI preference.
  await battlePage.getByTestId('collapse-left-panel').click();
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-left-panel"]')?.getAttribute('data-collapsed') === 'true',
  );
  check(
    'battle panel state is stored in the browser only',
    (await battlePage.evaluate(() => window.localStorage.getItem('polis.panel.battle.left'))) === 'true' &&
      (await battlePage.evaluate(() => window.localStorage.getItem('polis.panel.editor.left'))) === null,
  );
  await battlePage.reload({ waitUntil: 'networkidle' });
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-left-panel"]')?.getAttribute('data-collapsed') === 'true',
    null,
    { timeout: T_SAVE },
  );
  check(
    'collapsing the battle left panel survives a reload',
    (await battlePage.getByTestId('battle-left-panel').getAttribute('data-collapsed')) === 'true' &&
      (await battlePage.getByTestId('battle-inspector').getAttribute('data-collapsed')) === 'false' &&
      (await battlePage.getByTestId('expand-left-panel').count()) === 1,
  );
  await battlePage.getByTestId('expand-left-panel').click();
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-left-panel"]')?.getAttribute('data-collapsed') === 'false',
  );
  await battlePage.getByTestId('collapse-right-panel').click();
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-inspector"]')?.getAttribute('data-collapsed') === 'true',
  );
  await battlePage.reload({ waitUntil: 'networkidle' });
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-inspector"]')?.getAttribute('data-collapsed') === 'true',
    null,
    { timeout: T_SAVE },
  );
  check(
    'collapsing the battle right panel survives a reload independently',
    (await battlePage.getByTestId('battle-left-panel').getAttribute('data-collapsed')) === 'false' &&
      (await battlePage.getByTestId('battle-inspector').getAttribute('data-collapsed')) === 'true' &&
      (await battlePage.getByTestId('expand-right-panel').count()) === 1,
  );
  await battlePage.getByTestId('expand-right-panel').click();
  await battlePage.waitForFunction(
    () => document.querySelector('[data-testid="battle-inspector"]')?.getAttribute('data-collapsed') === 'false',
  );
  // A corrupt stored preference falls back to expanded without errors: the
  // battle still loads and both panels start expanded.
  await battlePage.evaluate(() => {
    window.localStorage.setItem('polis.panel.battle.left', 'garbage!!!');
    window.localStorage.setItem('polis.panel.battle.right', '{bad json');
  });
  await battlePage.reload({ waitUntil: 'networkidle' });
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  await battlePage.waitForTimeout(STEP_MS);
  check(
    'a corrupt battle preference falls back to expanded without errors',
    (await battlePage.getByTestId('battle-left-panel').getAttribute('data-collapsed')) === 'false' &&
      (await battlePage.getByTestId('battle-inspector').getAttribute('data-collapsed')) === 'false' &&
      (await battlePage.getByTestId('collapse-left-panel').count()) === 1 &&
      (await battlePage.getByTestId('collapse-right-panel').count()) === 1,
  );

  // One turn each way: the human side commits an empty turn (with
  // confirmation) and the automated side resolves through the runner and
  // waits for Continue. Every resolution ends behind the device handoff, so
  // each step below first presses "<Side> — begin your turn" when it is
  // showing. The starting side is seed-drawn, so either order.
  async function settleAfterHandoff(previous) {
    await battlePage.waitForFunction(
      (expected) => {
        if (document.querySelector('[data-testid="battle-outcome"]')) return true;
        if (document.querySelector('[data-testid="commit-empty"]')) return true;
        if (document.querySelector('[data-testid="commit-draft"]')) return true;
        const handoff = document.querySelector('[data-testid="handoff"]');
        return !!handoff && handoff.textContent !== expected;
      },
      previous,
      { timeout: T_BATTLE },
    );
  }
  async function advanceOneStep() {
    if ((await battlePage.getByTestId('handoff').count()) > 0) {
      const label = (await battlePage.getByTestId('handoff').textContent()) ?? '';
      check(
        'the device handoff names the next side',
        /— begin your turn/.test(label),
        label.replace(/\s+/g, ' ').slice(0, 80),
      );
      // A human side unlocks drafting; an automated side resolves at once
      // behind a fresh handoff. Waiting for a *changed* handoff (not merely
      // any handoff, and never the transient gap) keeps slow machines from
      // passing on the stale pre-click handoff or missing the gap.
      await battlePage.getByTestId('handoff').click();
      await settleAfterHandoff(label);
      return;
    }
    const controller = (await battlePage.getByTestId('turn-controller').textContent()) ?? '';
    if (controller.startsWith('human')) {
      await battlePage.getByTestId('commit-empty').click();
      await battlePage.getByTestId('commit-confirm').waitFor({ timeout: T_SAVE });
      await battlePage.getByTestId('confirm-commit').click();
    } else {
      check(
        'automated side is labelled a test player',
        /test player/.test(controller),
        controller,
      );
      // The settled automated first turn is the only place Continue is
      // pressed: re-check for a handoff that may have appeared while the
      // controller text was read, so a resolved turn behind its handoff is
      // never missed for a 60 s wait on a gone Continue (issue #157).
      await battlePage.getByTestId('continue-turn').waitFor({ timeout: T_BATTLE });
      if ((await battlePage.getByTestId('handoff').count()) === 0) {
        if (await battlePage.getByTestId('continue-turn').isEnabled()) {
          await battlePage.getByTestId('continue-turn').click();
        }
      }
    }
  }
  await advanceOneStep();
  await battlePage.getByTestId('turn-result').waitFor({ timeout: T_BATTLE });
  const afterFirst = await battlePage.getByTestId('round').textContent();
  check(
    'the first committed turn resolves',
    afterFirst !== roundText,
    `${roundText} → ${afterFirst}`,
  );
  check(
    'the resolved turn ends behind the device handoff',
    await battlePage.getByTestId('handoff').isVisible(),
  );
  await advanceOneStep();
  await advanceOneStep();
  await battlePage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    afterFirst,
    { timeout: T_BATTLE },
  );
  const afterSecond = await battlePage.getByTestId('round').textContent();
  check(
    'one turn each way resolves',
    afterSecond !== afterFirst,
    `${afterFirst} → ${afterSecond}`,
  );
  check(
    'resolved turns appear on the battle log',
    ((await battlePage.getByTestId('battle-log').textContent()) ?? '').length > 0,
  );

  // Reloading mid-battle resumes the identical state from the Battles list.
  await battlePage.reload({ waitUntil: 'networkidle' });
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  check(
    'reloading resumes the same battle state',
    (await battlePage.getByTestId('round').textContent()) === afterSecond,
    (await battlePage.getByTestId('round').textContent()) ?? 'no round',
  );
  await battlePage.getByTestId('back-to-battles').click();
  await battlePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  const battleRows = battlePage.getByTestId('battle-row');
  check('the battles list resumes the battle in progress', (await battleRows.count()) === 1);
  const battleRowMeta = await battlePage.getByTestId('battle-row-meta').textContent();
  check(
    'the battles list shows the in-progress battle',
    /In progress/.test(battleRowMeta ?? ''),
    battleRowMeta ?? 'no meta',
  );
  await battleRows.first().getByTestId('resume-battle').click();
  await battlePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  check(
    'resume from the battles list restores the same state',
    (await battlePage.getByTestId('round').textContent()) === afterSecond,
  );
  await battlePage.getByTestId('back-to-battles').click();
  await battlePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  await battlePage.getByTestId('delete-battle').click();
  await battlePage.getByTestId('empty-battles').waitFor({ timeout: T_SAVE });
  check('deleting removes the battle', true);
}
