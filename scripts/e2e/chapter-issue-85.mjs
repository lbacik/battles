// issue #85: full-orders drafting - Charge, Shoot, Reform, Withdraw (scripts/e2e.mjs lines 3298-3623).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, reachHumanTurn, waitForInspectorOffer, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';

export async function runIssue85(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #85: full-orders drafting — Charge, Shoot, Reform, Withdraw, and
  // Rally through the battle screen. Charge and Shoot draft from the engine's
  // candidate lists (inspector buttons and map highlights), Reform drafts
  // through its form with spacing presets, Withdraw and Rally draft in place
  // from the inspector. Every draft validates live with ghosts and inline
  // rejections; a Reform with no files is rejected; a Move, a Charge, and a
  // deliberately colliding Move are drafted together; and a Withdraw that
  // disorders the charger unlocks a Rally next turn. Fresh storage, fixed
  // seed 99 (side-a starts, and the seed-drawn withdraw disorders).
  const fullContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await fullContext.setDefaultTimeout(T_BATTLE);
  const fullPage = await fullContext.newPage();
  fullPage.on('console', (message) => log(`full console: ${message.text()}`));
  fullPage.on('pageerror', (error) => log(`full pageerror: ${String(error)}`));
  fullPage.on('dialog', async (dialog) => {
    log(`full dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await fullPage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await fullPage.getByTestId('app').waitFor({ timeout: T_LOAD });
  // The seed fixes every draw of this story. With it the Athenians start and
  // the seventh draw (the Withdraw good-order chance, 0.5) fails at 0.945, so
  // the charger is disordered and the next human turn can Rally.
  await fullPage.evaluate(() => {
    window.__POLIS_TEST_SEED = 187501;
  });

  const fullTitle = `Full Orders Probe ${Date.now()}`;
  await fullPage.getByTestId('new-scenario-title').fill(fullTitle);
  await fullPage.getByTestId('new-scenario-submit').click();
  await fullPage.getByTestId('editor').waitFor({ timeout: T_LOAD });

  // The probe geometry from the engine suite: the charger faces its target
  // across 80 m of open ground, the archer faces its victim across 100 m.
  async function addFullUnit(sideLabel, troop, x, y, facing) {
    await fullPage.getByTestId('oob-add').click();
    await fullPage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await fullPage.getByTestId('unit-troop').selectOption(troop);
    await fullPage.getByTestId('unit-position-x').fill(String(x));
    await fullPage.locator('.map-caption').click();
    await fullPage.getByTestId('unit-position-y').fill(String(y));
    await fullPage.locator('.map-caption').click();
    await fullPage.getByTestId('unit-facing').fill(String(facing));
    await fullPage.locator('.map-caption').click();
  }
  await addFullUnit('Athenians', 'hoplite', 400, 600, 180);
  await addFullUnit('Athenians', 'hoplite', 440, 600, 180);
  await addFullUnit('Athenians', 'hoplite', 600, 600, 0);
  await addFullUnit('Athenians', 'archer', 800, 600, 0);
  await addFullUnit('Athenians', 'hoplite', 1000, 600, 0);
  await addFullUnit('Spartans', 'hoplite', 600, 680, 180);
  await addFullUnit('Spartans', 'hoplite', 800, 700, 180);
  await addFullUnit('Spartans', 'hoplite', 400, 300, 0);
  check(
    'full-orders drafting fields five side-a units and three side-b units',
    (await fullPage.getByTestId('oob-unit').count()) === 8,
  );
  await fullPage.getByTestId('save-scenario').click();
  await waitForSave(fullPage);
  await fullPage.getByTestId('start-battle-editor').click();
  await fullPage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await fullPage.getByTestId('controller-side-b').selectOption('passive');
  await fullPage.getByTestId('begin-battle').click();
  await fullPage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });

  // Reach the human turn: the starting side is seed-drawn, so resolve the
  // automated side first when it starts. Every resolved turn ends behind the
  // device handoff (issue #86), which must be pressed before the next side
  // drafts or continues.
  async function reachFullHumanTurn() {
    // The shared helper waits for a settled turn first and advances behind
    // the handoff or the settled Continue, never assuming whether the
    // automated side is still waiting or has already resolved. Controller
    // text alone never decides: a human controller behind its own handoff
    // still locks drafting, and the disabled Continue while an automated
    // turn resolves is never pressed (issue #157).
    await reachHumanTurn(fullPage);
  }
  await reachFullHumanTurn();
  check(
    'full-orders drafting starts on the human turn',
    ((await fullPage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );

  // Map metres (y up from the south-west corner) to client pixels through the
  // live SVG viewBox, so approach and leg points land on exact points.
  async function clickFullMap(atX, atY) {
    const svg = fullPage.getByTestId('battlefield-map');
    const box = await svg.boundingBox();
    const viewBox = ((await svg.getAttribute('viewBox')) ?? '0 0 1200 800')
      .split(/\s+/)
      .map(Number);
    const fieldH = Number(await svg.getAttribute('data-height'));
    const clientX = box.x + ((atX - viewBox[0]) / viewBox[2]) * box.width;
    const clientY = box.y + ((fieldH - atY - viewBox[1]) / viewBox[3]) * box.height;
    await fullPage.mouse.click(clientX, clientY);
  }
  await fullPage.getByTestId('fit-view').click();
  await fullPage.waitForTimeout(SETTLE_MS);

  const fullOwn = fullPage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const fullFoe = fullPage.getByTestId('battle-oob-side-b').getByTestId('battle-oob-unit');
  const mover1Id = await fullOwn.nth(0).getAttribute('data-unit-id');
  const mover2Id = await fullOwn.nth(1).getAttribute('data-unit-id');
  const chargerId = await fullOwn.nth(2).getAttribute('data-unit-id');
  const archerId = await fullOwn.nth(3).getAttribute('data-unit-id');
  const reformerId = await fullOwn.nth(4).getAttribute('data-unit-id');
  const targetId = await fullFoe.nth(0).getAttribute('data-unit-id');
  const victimId = await fullFoe.nth(1).getAttribute('data-unit-id');

  // The inspector lists every kind with the engine's candidates.
  await fullOwn.nth(3).click();
  check(
    'inspector shows the engine Shoot permission and 110 m allowance',
    ((await fullPage.getByTestId('battle-unit-permitted').textContent()) ?? '').includes('Shoot') &&
      (await fullPage.getByTestId('battle-unit-allowance').textContent()) === '110 m',
  );
  check(
    'inspector lists the Shoot candidate from the engine',
    await fullPage.getByTestId(`shoot-${archerId}-${victimId}`).isVisible(),
  );
  await fullOwn.nth(2).click();
  check(
    'inspector lists the Charge candidate from the engine',
    await fullPage.getByTestId(`charge-${chargerId}-${targetId}`).isVisible(),
  );
  check(
    'the Charge candidate highlights on the map',
    (await fullPage
      .locator(`[data-testid="map-unit"][data-unit-id="${targetId}"]`)
      .getAttribute('data-candidate-charge')) === 'true',
  );
  await fullOwn.nth(3).click();
  check(
    'the Shoot candidate highlights on the map',
    (await fullPage
      .locator(`[data-testid="map-unit"][data-unit-id="${victimId}"]`)
      .getAttribute('data-candidate-shoot')) === 'true',
  );
  await fullOwn.nth(4).click();
  check(
    'inspector lists Reform among the permitted orders',
    ((await fullPage.getByTestId('battle-unit-permitted').textContent()) ?? '').includes('Reform'),
  );

  // A Charge drafted from its candidate validates with a contact ghost; an
  // optional approach leg keeps it accepted.
  await fullOwn.nth(2).click();
  await fullPage.getByTestId(`charge-${chargerId}-${targetId}`).click();
  await fullPage.getByTestId(`draft-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  check(
    'a Charge drafts from its candidate with a contact ghost',
    ((await fullPage.getByTestId(`draft-${chargerId}`).textContent()) ?? '').includes('Charge') &&
      (await fullPage.getByTestId('draft-ghost').count()) >= 1,
  );
  await clickFullMap(600, 620);
  await fullPage.waitForTimeout(SETTLE_MS);
  check(
    'an approach leg keeps the Charge accepted',
    await fullPage.getByTestId(`draft-accepted-${chargerId}`).isVisible(),
  );
  await fullPage.getByTestId(`remove-last-approach-${chargerId}`).click();
  await fullPage.waitForTimeout(SETTLE_MS);
  check(
    'removing the approach leg keeps the direct Charge accepted',
    await fullPage.getByTestId(`draft-accepted-${chargerId}`).isVisible(),
  );

  // A Shoot drafted from its candidate validates with its shot line.
  await fullOwn.nth(3).click();
  await fullPage.getByTestId(`shoot-${archerId}-${victimId}`).click();
  await fullPage.getByTestId(`draft-accepted-${archerId}`).waitFor({ timeout: T_SAVE });
  check(
    'a Shoot drafts from its candidate with a shot line',
    ((await fullPage.getByTestId(`draft-${archerId}`).textContent()) ?? '').includes('Shoot') &&
      (await fullPage.getByTestId('shoot-line').count()) >= 1,
  );

  // A Reform drafted through its form validates with the new footprint; a
  // spacing preset keeps it accepted.
  await fullOwn.nth(4).click();
  await fullPage.getByTestId(`start-reform-${reformerId}`).click();
  await fullPage.getByTestId(`reform-files-${reformerId}`).fill('8');
  await fullPage.getByTestId(`draft-accepted-${reformerId}`).waitFor({ timeout: T_SAVE });
  check(
    'a Reform validates through its form with the new footprint',
    ((await fullPage.getByTestId(`draft-accepted-${reformerId}`).textContent()) ?? '').includes('8 files') &&
      (await fullPage.getByTestId('draft-ghost').count()) >= 2,
  );
  await fullPage.getByTestId(`apply-preset-${reformerId}-open`).click();
  await fullPage.waitForTimeout(SETTLE_MS);
  check(
    'a spacing preset keeps the Reform accepted',
    await fullPage.getByTestId(`draft-accepted-${reformerId}`).isVisible(),
  );

  // A Reform with no files is rejected inline and blocks the commit; removing
  // it enables the commit again.
  await fullPage.getByTestId(`reform-files-${reformerId}`).fill('0');
  await fullPage.getByTestId(`draft-rejection-${reformerId}`).waitFor({ timeout: T_SAVE });
  const reformRejection = await fullPage.getByTestId(`draft-rejection-${reformerId}`).textContent();
  check(
    'a Reform with no files is rejected inline',
    /invalid Reform|bad-files/i.test(reformRejection ?? ''),
    (reformRejection ?? '').replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    'commit is disabled while a Reform is rejected',
    await fullPage.getByTestId('commit-draft').isDisabled(),
  );
  await fullPage.getByTestId(`remove-draft-${reformerId}`).click();
  await fullPage.waitForFunction(
    () => document.querySelector('[data-testid="commit-draft"]')?.disabled === false,
  );
  check('removing the rejected Reform enables the commit', true);

  // A Move and a deliberately colliding Move: the second Move ends on the
  // first unit's destination, so the engine rejects it and names the conflict.
  await fullOwn.nth(0).click();
  await fullPage.getByTestId(`start-draft-${mover1Id}`).click();
  await clickFullMap(400, 560);
  await fullPage.getByTestId(`draft-accepted-${mover1Id}`).waitFor({ timeout: T_SAVE });
  await fullOwn.nth(1).click();
  await fullPage.getByTestId(`start-draft-${mover2Id}`).click();
  await clickFullMap(400, 560);
  await fullPage.getByTestId(`draft-rejection-${mover2Id}`).waitFor({ timeout: T_SAVE });
  check(
    'a colliding Move is rejected inline with its conflict',
    /collid/i.test((await fullPage.getByTestId(`draft-rejection-${mover2Id}`).textContent()) ?? ''),
  );
  check(
    'commit stays disabled while the Move collides',
    await fullPage.getByTestId('commit-draft').isDisabled(),
  );
  await fullPage.getByTestId(`remove-draft-${mover2Id}`).click();
  await fullPage.waitForFunction(
    () => document.querySelector('[data-testid="commit-draft"]')?.disabled === false,
  );

  // Committing the Charge, the Shoot, and the Move advances the turn.
  const fullRoundBefore = await fullPage.getByTestId('round').textContent();
  await fullPage.getByTestId('commit-draft').click();
  await fullPage.getByTestId('turn-result').waitFor({ timeout: T_BATTLE });
  await fullPage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    fullRoundBefore,
  );
  check(
    'committing the Charge, the Shoot, and the Move advances the turn',
    true,
    `${fullRoundBefore} → ${await fullPage.getByTestId('round').textContent()}`,
  );

  // The automated side resolves, then the engaged charger withdraws: the
  // ghost shows the step back and the commit advances the turn.
  await reachFullHumanTurn();
  await fullOwn.nth(2).click();
  // The engaged state is awaited before it is asserted: on slow hardware the
  // inspector may still show the previous unit when read (issue #157).
  await waitForInspectorOffer(fullPage, chargerId, 'Withdraw');
  check(
    'inspector offers Withdraw to the engaged charger',
    await fullPage.getByTestId(`start-withdraw-${chargerId}`).isVisible(),
  );
  await fullPage.getByTestId(`start-withdraw-${chargerId}`).click();
  await fullPage.getByTestId(`draft-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  check(
    'a Withdraw drafts in place with its step-back ghost',
    (await fullPage.getByTestId('draft-ghost').count()) >= 1,
  );
  const withdrawRoundBefore = await fullPage.getByTestId('round').textContent();
  await fullPage.getByTestId('commit-draft').click();
  await fullPage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    withdrawRoundBefore,
  );
  check('committing the Withdraw advances the turn', true);

  // The seed-drawn withdraw disorders the charger, so the next human turn
  // offers Rally and the Rally validates in place.
  await reachFullHumanTurn();
  await fullOwn.nth(2).click();
  // The disordered state is awaited before it is asserted: the seed-drawn
  // withdraw disorders, but the inspector read races slow renders (issue #157).
  await waitForInspectorOffer(fullPage, chargerId, 'Rally');
  check(
    'inspector offers Rally to the disordered charger',
    ((await fullPage.getByTestId('battle-unit-permitted').textContent()) ?? '').includes('Rally') &&
      (await fullPage.getByTestId(`start-rally-${chargerId}`).isVisible()),
  );
  await fullPage.getByTestId(`start-rally-${chargerId}`).click();
  await fullPage.getByTestId(`draft-accepted-${chargerId}`).waitFor({ timeout: T_SAVE });
  const rallyDetail = await fullPage.getByTestId(`draft-accepted-${chargerId}`).textContent();
  check(
    'a Rally drafts in place for the disordered charger',
    /rallies from Disordered/i.test(rallyDetail ?? ''),
    (rallyDetail ?? '').replace(/\s+/g, ' ').slice(0, 160),
  );
  const rallyRoundBefore = await fullPage.getByTestId('round').textContent();
  await fullPage.getByTestId('commit-draft').click();
  await fullPage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    rallyRoundBefore,
  );
  check('committing the Rally advances the turn', true);

  await fullContext.close();
}
