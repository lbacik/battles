// issue #88: local battle gate on a fixed setup seed (scripts/e2e.mjs lines 3836-4300).
// Runs in today's order against the shared run context; the steps
// below are the steps this section performs today, unchanged.
import { waitForSave, clickHandoffAndSettle, T_SAVE, T_LOAD, T_BATTLE, SETTLE_MS } from './helpers.mjs';
import { reportDir } from './helpers.mjs';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

export async function runIssue88Gate(ctx) {
  const { page, context, browser, base, check, log } = ctx;
  // Issue #88: local battle gate — one coherent story on a fixed setup seed:
  // (1) starting an unplayable reference is refused, naming the unit;
  // (2) open in editor, fix the problem, save; (3) start Human vs Passive;
  // (4) a Move, a Charge, and a deliberately colliding order see the
  // collision rejected inline with its highlight, the draft is reordered so
  // the culprit flips, and the surviving orders commit; (5) the turn result
  // and the battle log show the outcome; (6) reload mid-battle and resume;
  // (7) play on to a concession; (8) start a rematch. Fresh storage; the
  // seed is fixed by the harness through window.__POLIS_TEST_SEED (there is
  // no seed field in the UI: the seed is drawn at Begin).
  const gateContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await gateContext.setDefaultTimeout(T_BATTLE);
  const gatePage = await gateContext.newPage();
  gatePage.on('console', (message) => log(`gate console: ${message.text()}`));
  gatePage.on('pageerror', (error) => log(`gate pageerror: ${String(error)}`));
  gatePage.on('dialog', async (dialog) => {
    log(`gate dialog: ${dialog.type()} ${dialog.message()}`);
    await dialog.accept();
  });
  await gatePage.goto(`${base}/`, { waitUntil: 'networkidle' });
  await gatePage.getByTestId('app').waitFor({ timeout: T_LOAD });
  await gatePage.evaluate(() => {
    window.__POLIS_TEST_SEED = 7;
  });

  // The unplayable reference: one good unit and one hoplite spaced at 5 m,
  // past the 4 m hoplite maximum — structurally stored, unplayable at Begin.
  const gateTitle = `Gate Probe ${Date.now()}`;
  const gateReference = {
    kind: 'scenario',
    formatVersion: 1,
    id: '00000000-0000-4000-8000-000000000881',
    title: gateTitle,
    description: '',
    battlefield: { width: 1200, height: 800 },
    sides: [
      { id: 'side-a', name: 'Athenians', color: '#1d4ed8' },
      { id: 'side-b', name: 'Spartans', color: '#b91c1c' },
    ],
    ruleset: { id: 'polis-classical', version: '0.1' },
    units: [
      {
        id: '00000000-0000-4000-8000-000000000882',
        name: 'Gate taxis',
        side: 'side-a',
        troopType: 'hoplite',
        soldiers: 100,
        files: 10,
        lateralInterval: 1.8,
        rankDepth: 1.8,
        position: { x: 500, y: 600 },
        facing: 180,
      },
      {
        id: '00000000-0000-4000-8000-000000000883',
        name: 'Spartan mora',
        side: 'side-b',
        troopType: 'hoplite',
        soldiers: 100,
        files: 10,
        lateralInterval: 5,
        rankDepth: 1.8,
        position: { x: 500, y: 300 },
        facing: 0,
      },
    ],
    terrainFeatures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const gateFile = path.join(reportDir, 'gate-reference.json');
  writeFileSync(gateFile, `${JSON.stringify(gateReference, null, 2)}\n`);
  await gatePage.getByTestId('import-file').setInputFiles(gateFile);
  await gatePage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  await gatePage.getByTestId('back-to-library').click();
  await gatePage.getByTestId('scenario-list').waitFor({ timeout: T_SAVE });

  // Step 1: starting the unplayable reference is refused, naming the unit.
  const gateRow = gatePage.getByTestId('scenario-row').filter({ hasText: gateTitle });
  await gateRow.getByTestId('start-battle').click();
  await gatePage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await gatePage.getByTestId('begin-battle').click();
  await gatePage.getByTestId('playability-refusal').waitFor({ timeout: T_SAVE });
  const gateProblems = await gatePage.getByTestId('playability-problem').allTextContents();
  check(
    'gate: an unplayable reference is refused, naming the unit',
    gateProblems.length === 1 &&
      gateProblems.some(
        (problem) => /Spartan mora/.test(problem) && /lateralInterval/.test(problem),
      ),
    gateProblems.join(' | '),
  );
  check(
    'gate: the refusal offers open in editor',
    await gatePage.getByTestId('open-in-editor').isVisible(),
  );

  // Step 2: open in editor, fix the spacing through the inspector, save.
  await gatePage.getByTestId('open-in-editor').click();
  await gatePage.getByTestId('editor').waitFor({ timeout: T_LOAD });
  check(
    'gate: open in editor opens the refused reference',
    (await gatePage.getByTestId('header-title').textContent()) === gateTitle,
  );
  await gatePage.getByTestId('oob-tab-all').click();
  await gatePage.locator('[data-testid="oob-unit"]', { hasText: 'Spartan mora' }).click();
  await gatePage.getByTestId('unit-inspector').waitFor({ timeout: T_SAVE });
  check(
    'gate: the bad unit is selected for the fix',
    (await gatePage.getByTestId('unit-title').textContent()) === 'Spartan mora',
  );
  await gatePage.getByTestId('unit-spacing-lateral').fill('1.8');
  await gatePage.locator('.map-caption').click();
  await gatePage.getByTestId('save-scenario').click();
  await waitForSave(gatePage);
  check(
    'gate: the fixed reference saves',
    (await gatePage.getByTestId('save-status').textContent()) === 'Saved',
  );

  // The gate lines form in the same editor: two movers and a charger facing
  // the fixed line across open ground. The charger faces its target across
  // 80 m, the movers head 40 m south to the same destination.
  async function addGateUnit(name, sideLabel, x, y, facing) {
    await gatePage.getByTestId('oob-add').click();
    await gatePage.getByTestId('unit-name').fill(name);
    await gatePage.locator('.map-caption').click();
    await gatePage.getByTestId('unit-side').selectOption({ label: sideLabel });
    await gatePage.getByTestId('unit-troop').selectOption('hoplite');
    await gatePage.getByTestId('unit-position-x').fill(String(x));
    await gatePage.locator('.map-caption').click();
    await gatePage.getByTestId('unit-position-y').fill(String(y));
    await gatePage.locator('.map-caption').click();
    await gatePage.getByTestId('unit-facing').fill(String(facing));
    await gatePage.locator('.map-caption').click();
  }
  await addGateUnit('Gate mover one', 'Athenians', 400, 600, 180);
  await addGateUnit('Gate mover two', 'Athenians', 440, 600, 180);
  await addGateUnit('Gate charger', 'Athenians', 600, 600, 0);
  await addGateUnit('Gate target', 'Spartans', 600, 680, 180);
  await addGateUnit('Gate extra', 'Spartans', 400, 300, 0);
  check(
    'gate: the fixed reference fields the battle lines',
    (await gatePage.getByTestId('oob-unit').count()) === 7,
  );
  await gatePage.getByTestId('save-scenario').click();
  await waitForSave(gatePage);

  // Step 3: start Human vs Passive from the fixed reference.
  await gatePage.getByTestId('start-battle-editor').click();
  await gatePage.getByTestId('battle-setup').waitFor({ timeout: T_SAVE });
  await gatePage.getByTestId('controller-side-b').selectOption('passive');
  check(
    'gate: setup fields Human vs Passive',
    (await gatePage.getByTestId('controller-side-a').inputValue()) === 'human' &&
      (await gatePage.getByTestId('controller-side-b').inputValue()) === 'passive',
  );
  await gatePage.getByTestId('begin-battle').click();
  await gatePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  const gateRoundStart = await gatePage.getByTestId('round').textContent();
  check(
    'gate: Human vs Passive begins on round 1, turn 1',
    /Round 1 \/ \d+ · Turn 1/.test(gateRoundStart ?? '') &&
      new URL(gatePage.url()).searchParams.has('battle'),
    gateRoundStart ?? 'no round',
  );

  // Reach the human turn: the starting side is seed-drawn, so resolve the
  // automated side first when it starts. Every resolution ends behind the
  // device handoff, which is what unlocks drafting.
  for (let step = 0; step < 4; step += 1) {
    if ((await gatePage.getByTestId('battle-outcome').count()) > 0) break;
    const controller = (await gatePage.getByTestId('turn-controller').textContent()) ?? '';
    if (controller.startsWith('human')) break;
    if ((await gatePage.getByTestId('handoff').count()) > 0) {
      await clickHandoffAndSettle(gatePage);
    } else {
      const gateTurnBefore = await gatePage.getByTestId('round').textContent();
      await gatePage.getByTestId('continue-turn').click();
      await gatePage.waitForFunction(
        (expected) =>
          document.querySelector('[data-testid="round"]')?.textContent !== expected ||
          document.querySelector('[data-testid="handoff"]') ||
          document.querySelector('[data-testid="battle-outcome"]'),
        gateTurnBefore,
        { timeout: T_BATTLE },
      );
    }
  }
  if ((await gatePage.getByTestId('handoff').count()) > 0) {
    await clickHandoffAndSettle(gatePage);
  }
  check(
    'gate: drafting starts on the human turn',
    ((await gatePage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );

  // Map metres (y up from the south-west corner) to client pixels through the
  // live SVG viewBox, so draft legs land on exact points.
  async function clickGateMap(atX, atY) {
    const svg = gatePage.getByTestId('battlefield-map');
    const box = await svg.boundingBox();
    const viewBox = ((await svg.getAttribute('viewBox')) ?? '0 0 1200 800')
      .split(/\s+/)
      .map(Number);
    const fieldH = Number(await svg.getAttribute('data-height'));
    const clientX = box.x + ((atX - viewBox[0]) / viewBox[2]) * box.width;
    const clientY = box.y + ((fieldH - atY - viewBox[1]) / viewBox[3]) * box.height;
    await gatePage.mouse.click(clientX, clientY);
  }
  await gatePage.getByTestId('fit-view').click();
  await gatePage.waitForTimeout(SETTLE_MS);

  const gateOwn = gatePage.getByTestId('battle-oob-side-a').getByTestId('battle-oob-unit');
  const gateFoe = gatePage.getByTestId('battle-oob-side-b').getByTestId('battle-oob-unit');
  const gateMoverOne =
    await gateOwn.filter({ hasText: 'Gate mover one' }).getAttribute('data-unit-id');
  const gateMoverTwo =
    await gateOwn.filter({ hasText: 'Gate mover two' }).getAttribute('data-unit-id');
  const gateCharger =
    await gateOwn.filter({ hasText: 'Gate charger' }).getAttribute('data-unit-id');
  const gateTarget =
    await gateFoe.filter({ hasText: 'Gate target' }).getAttribute('data-unit-id');

  // Step 4: a Move, a Charge, and a deliberately colliding order. The second
  // Move ends overlapping the first unit's destination, so the engine rejects it and
  // names the conflict.
  await gateOwn.filter({ hasText: 'Gate mover one' }).click();
  await gatePage.getByTestId(`start-draft-${gateMoverOne}`).click();
  await clickGateMap(400, 560);
  await gatePage.getByTestId(`draft-accepted-${gateMoverOne}`).waitFor({ timeout: T_SAVE });
  check(
    'gate: a Move drafts with its ghost',
    (await gatePage.getByTestId('draft-ghost').count()) >= 1,
  );
  await gateOwn.filter({ hasText: 'Gate charger' }).click();
  await gatePage.getByTestId(`charge-${gateCharger}-${gateTarget}`).click();
  await gatePage.getByTestId(`draft-accepted-${gateCharger}`).waitFor({ timeout: T_SAVE });
  check(
    'gate: a Charge drafts from its candidate',
    ((await gatePage.getByTestId(`draft-${gateCharger}`).textContent()) ?? '').includes('Charge'),
  );
  // Mover two ends 10 m east of mover one's destination, so the footprints
  // overlap. The leg stays inside the 45-degree forward arc (exactly 45 would
  // bill the doubled sideways rate and overrun the allowance once reordered).
  await gateOwn.filter({ hasText: 'Gate mover two' }).click();
  await gatePage.getByTestId(`start-draft-${gateMoverTwo}`).click();
  await clickGateMap(410, 560);
  await gatePage.getByTestId(`draft-rejection-${gateMoverTwo}`).waitFor({ timeout: T_SAVE });
  const gateCollision = await gatePage.getByTestId(`draft-rejection-${gateMoverTwo}`).textContent();
  check(
    'gate: a colliding order is rejected inline',
    /collid/i.test(gateCollision ?? ''),
    (gateCollision ?? '').replace(/\s+/g, ' ').slice(0, 160),
  );
  check(
    'gate: the commit stays disabled while the order collides',
    await gatePage.getByTestId('commit-draft').isDisabled(),
  );
  check(
    'gate: the collision highlights its conflict',
    (await gatePage
      .locator(`[data-testid="map-unit"][data-unit-id="${gateMoverOne}"]`)
      .getAttribute('data-conflict')) === 'true' &&
      (await gatePage.getByTestId('conflict-marker').count()) >= 1,
  );

  // Reordering revalidates: moving the rejected draft first flips the culprit
  // to the now-later order, and the commit stays blocked.
  await gatePage.getByTestId(`move-draft-up-${gateMoverTwo}`).click();
  await gatePage.getByTestId(`move-draft-up-${gateMoverTwo}`).click();
  await gatePage.waitForFunction(
    (expected) =>
      document
        .querySelector('[data-testid="draft-list"] .draft-rows > li')
        ?.getAttribute('data-testid') === expected,
    `draft-${gateMoverTwo}`,
    { timeout: T_SAVE },
  );
  await gatePage.getByTestId(`draft-rejection-${gateMoverOne}`).waitFor({ timeout: T_SAVE });
  check(
    'gate: reordering flips the culprit to the now-later order',
    /collid/i.test(
      (await gatePage.getByTestId(`draft-rejection-${gateMoverOne}`).textContent()) ?? '',
    ),
  );
  check(
    'gate: the first order is accepted after the reorder',
    await gatePage.getByTestId(`draft-accepted-${gateMoverTwo}`).isVisible(),
  );
  check(
    'gate: the highlight follows the reordered collision',
    (await gatePage
      .locator(`[data-testid="map-unit"][data-unit-id="${gateMoverTwo}"]`)
      .getAttribute('data-conflict')) === 'true',
  );
  check(
    'gate: reordering keeps the commit blocked',
    await gatePage.getByTestId('commit-draft').isDisabled(),
  );

  // Removing the rejected order enables the commit; committing the Move and
  // the Charge advances the turn.
  await gatePage.getByTestId(`remove-draft-${gateMoverOne}`).click();
  await gatePage.waitForFunction(
    () => document.querySelector('[data-testid="commit-draft"]')?.disabled === false,
    null,
    { timeout: T_SAVE },
  );
  check('gate: removing the rejected order enables the commit', true);
  const gateRoundBefore = await gatePage.getByTestId('round').textContent();
  await gatePage.getByTestId('commit-draft').click();
  await gatePage.getByTestId('turn-result').waitFor({ timeout: T_BATTLE });
  await gatePage.waitForFunction(
    (expected) => document.querySelector('[data-testid="round"]')?.textContent !== expected,
    gateRoundBefore,
    { timeout: T_BATTLE },
  );
  check('gate: committing the Move and the Charge advances the turn', true);

  // Step 5: the turn result panel and the battle log show the outcome.
  const gateResult = (await gatePage.getByTestId('turn-result').textContent()) ?? '';
  check(
    'gate: the turn result shows the committed outcome',
    /Contacts/.test(gateResult) &&
      /Gate charger/.test(gateResult) &&
      /Gate target/.test(gateResult),
    gateResult.replace(/\s+/g, ' ').slice(0, 200),
  );
  const gateLog = (await gatePage.getByTestId('battle-log').textContent()) ?? '';
  check(
    'gate: the battle log shows the outcome',
    /Round \d+ · Turn \d+/.test(gateLog) &&
      /Gate charger/.test(gateLog) &&
      /Gate target/.test(gateLog),
    gateLog.replace(/\s+/g, ' ').slice(0, 200),
  );

  // Step 6: reload mid-battle and resume from the battles list.
  const gateRoundAfter = await gatePage.getByTestId('round').textContent();
  await gatePage.reload({ waitUntil: 'networkidle' });
  await gatePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  check(
    'gate: reloading resumes the committed turn',
    (await gatePage.getByTestId('round').textContent()) === gateRoundAfter,
  );
  check(
    'gate: the log survives the reload',
    /Gate charger/.test((await gatePage.getByTestId('battle-log').textContent()) ?? ''),
  );
  await gatePage.getByTestId('back-to-battles').click();
  await gatePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  check(
    'gate: the battles list keeps the battle in progress',
    (await gatePage.getByTestId('battle-row').count()) === 1,
  );
  await gatePage.getByTestId('resume-battle').click();
  await gatePage.getByTestId('battle-screen').waitFor({ timeout: T_LOAD });
  check(
    'gate: resume restores the committed turn',
    (await gatePage.getByTestId('round').textContent()) === gateRoundAfter,
  );

  // Step 7: play on to a concession. Behind the handoff it is nobody's turn,
  // so press through it (resolving the passive side when it is up) until the
  // human side is up, then concede with confirmation.
  for (let step = 0; step < 8; step += 1) {
    if ((await gatePage.getByTestId('battle-outcome').count()) > 0) break;
    if ((await gatePage.getByTestId('handoff').count()) > 0) {
      await clickHandoffAndSettle(gatePage);
      continue;
    }
    if ((await gatePage.getByTestId('battle-outcome').count()) > 0) break;
    const controller = (await gatePage.getByTestId('turn-controller').textContent()) ?? '';
    if (controller.startsWith('human')) break;
    await gatePage.getByTestId('continue-turn').click();
    await gatePage.getByTestId('handoff').waitFor({ timeout: T_BATTLE });
  }
  check(
    'gate: the human side is up to concede',
    ((await gatePage.getByTestId('turn-controller').textContent()) ?? '').startsWith('human'),
  );
  check('gate: concede is offered', await gatePage.getByTestId('concede').isEnabled());
  const gateConceder = ((await gatePage.getByTestId('active-side').textContent()) ?? '').trim();
  await gatePage.getByTestId('concede').click();
  await gatePage.getByTestId('concede-confirm').click();
  await gatePage.getByTestId('battle-outcome').waitFor({ timeout: T_BATTLE });
  const gateBattleId = new URL(gatePage.url()).searchParams.get('battle');
  const gateOutcomeTitle = (await gatePage.getByTestId('outcome-title').textContent()) ?? '';
  const gateOutcomeReason = (await gatePage.getByTestId('outcome-reason').textContent()) ?? '';
  check(
    'gate: the concession names the winner',
    /wins/.test(gateOutcomeTitle),
    gateOutcomeTitle,
  );
  check(
    'gate: the outcome names who conceded',
    gateOutcomeReason.includes(gateConceder) && /conceded/i.test(gateOutcomeReason),
    gateOutcomeReason.slice(0, 160),
  );
  check(
    'gate: the outcome lists both sides losses',
    (await gatePage.getByTestId('outcome-losses').locator('li').count()) === 2,
  );
  check(
    'gate: the battle log records the concession',
    /conceded/i.test((await gatePage.getByTestId('battle-log').textContent()) ?? ''),
  );
  check(
    'gate: the finished battle is read-only',
    (await gatePage.getByTestId('commit-empty').count()) === 0 &&
      (await gatePage.getByTestId('continue-turn').count()) === 0 &&
      (await gatePage.getByTestId('concede').count()) === 0 &&
      (await gatePage.getByTestId('rematch').isVisible()),
  );

  // Step 8: a rematch starts a new battle from the snapshot; both battles are
  // listed, then deleted.
  await gatePage.getByTestId('rematch').click();
  await gatePage.getByTestId('starting-announcement').waitFor({ timeout: T_BATTLE });
  const gateRematchRound = (await gatePage.getByTestId('round').textContent()) ?? '';
  const gateRematchId = new URL(gatePage.url()).searchParams.get('battle');
  const gateRematchAnnouncement =
    (await gatePage.getByTestId('starting-announcement').textContent()) ?? '';
  check(
    'gate: the rematch opens round 1, turn 1',
    /Round 1 \/ \d+ · Turn 1/.test(gateRematchRound),
    gateRematchRound,
  );
  check(
    'gate: the rematch announces itself',
    /rematch — round 1, turn 1/.test(gateRematchAnnouncement),
    gateRematchAnnouncement.replace(/\s+/g, ' ').slice(0, 120),
  );
  check(
    'gate: the rematch is a new battle',
    !!gateRematchId && gateRematchId !== gateBattleId,
    `${gateBattleId} → ${gateRematchId}`,
  );
  await gatePage.getByTestId('back-to-battles').click();
  await gatePage.getByTestId('battles-list').waitFor({ timeout: T_SAVE });
  check(
    'gate: the rematch keeps the finished battle on the list',
    (await gatePage.getByTestId('battle-row').count()) === 2,
  );
  await gatePage
    .locator(`[data-testid="battle-row"][data-battle-id="${gateRematchId}"]`)
    .getByTestId('delete-battle')
    .click();
  await gatePage.waitForFunction(
    () => document.querySelectorAll('[data-testid="battle-row"]').length === 1,
    null,
    { timeout: T_LOAD },
  );
  await gatePage
    .locator(`[data-testid="battle-row"][data-battle-id="${gateBattleId}"]`)
    .getByTestId('delete-battle')
    .click();
  await gatePage.getByTestId('empty-battles').waitFor({ timeout: T_SAVE });
  check('gate: deleting clears both battles', true);

  await gateContext.close();
}
