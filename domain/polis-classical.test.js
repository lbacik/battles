// Unit tests for the ruleset package `polis-classical` 1.0. Run with: npm test
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PROVISIONAL_SCENARIO_VERSION,
  RULESET_ID,
  RULESET_PARAMETERS,
  RULESET_PARAMETERS_FILE,
  RULESET_VERSION,
  TROOP_TYPE_CATALOGUE,
  TROOP_TYPE_KEYS,
  getTroopType,
  isCompatibleScenarioRuleset,
  isKnownTroopType,
  rulesetMajor,
  spacingClass,
} from './polis-classical.js';

const here = fileURLToPath(new URL('.', import.meta.url));

describe('polis-classical catalogue', () => {
  it('is versioned 1.0 and keeps the six stable troop-type keys of 0.1', () => {
    assert.equal(RULESET_ID, 'polis-classical');
    assert.equal(RULESET_VERSION, '1.0');
    assert.deepEqual([...TROOP_TYPE_KEYS].sort(), [
      'archer',
      'cavalry',
      'hoplite',
      'light_cavalry',
      'peltast',
      'slinger',
    ]);
    for (const key of TROOP_TYPE_KEYS) {
      assert.ok(getTroopType(key), `missing catalogue entry for ${key}`);
      assert.equal(getTroopType(key).key, key);
    }
    assert.equal(isKnownTroopType('hoplite'), true);
    assert.equal(isKnownTroopType('cataphract'), false);
  });

  it('gives each troop type a display name and spacing presets in metres', () => {
    for (const key of TROOP_TYPE_KEYS) {
      const entry = getTroopType(key);
      assert.ok(entry.displayName.trim(), `${key} needs a display name`);
      for (const preset of ['close', 'normal', 'open']) {
        const { lateralInterval, rankDepth } = entry.presets[preset];
        assert.ok(
          Number.isFinite(lateralInterval) && lateralInterval > 0,
          `${key}.${preset} needs a positive lateral interval`,
        );
        assert.ok(
          Number.isFinite(rankDepth) && rankDepth > 0,
          `${key}.${preset} needs a positive rank depth`,
        );
      }
    }
  });

  it('keeps every preset inside the permitted spacing range', () => {
    for (const key of TROOP_TYPE_KEYS) {
      const entry = getTroopType(key);
      for (const preset of ['close', 'normal', 'open']) {
        const { lateralInterval, rankDepth } = entry.presets[preset];
        const ranges = entry.permittedRanges;
        assert.ok(
          lateralInterval >= ranges.lateralInterval.min &&
            lateralInterval <= ranges.lateralInterval.max,
          `${key}.${preset} lateral interval outside the permitted range`,
        );
        assert.ok(
          rankDepth >= ranges.rankDepth.min && rankDepth <= ranges.rankDepth.max,
          `${key}.${preset} rank depth outside the permitted range`,
        );
      }
      assert.ok(
        entry.permittedRanges.lateralInterval.min <= entry.permittedRanges.lateralInterval.max,
        `${key} lateral interval range is inverted`,
      );
      assert.ok(
        entry.spacingThresholds.closeMax < entry.spacingThresholds.openMin,
        `${key} spacing thresholds are inverted`,
      );
    }
  });

  it('derives the spacing class from the lateral interval', () => {
    const hoplite = getTroopType('hoplite');
    assert.equal(spacingClass('hoplite', hoplite.spacingThresholds.closeMax), 'close');
    assert.equal(spacingClass('hoplite', hoplite.spacingThresholds.openMin), 'open');
    assert.equal(
      spacingClass(
        'hoplite',
        (hoplite.spacingThresholds.closeMax + hoplite.spacingThresholds.openMin) / 2,
      ),
      'normal',
    );
    assert.equal(spacingClass('hoplite', Number.NaN), null);
    assert.equal(spacingClass('cataphract', 1), null);
  });

  it('imports nothing from React or Next.js', () => {
    for (const file of ['geometry.js', 'scenario.js', 'store.js', 'polis-classical.js', 'battle.js']) {
      const source = readFileSync(path.join(here, file), 'utf8');
      assert.ok(!/from\s+['"]react['"]/.test(source), `${file} imports react`);
      assert.ok(!/from\s+['"]next/.test(source), `${file} imports next`);
    }
  });
});

describe('units whose troop type left the catalogue (decision #5 item 13)', () => {
  it('finds every unit with an unknown troop-type key in document order', async () => {
    const { findUnknownTroopTypeUnits, collectUnknownTroopTypeWarnings } = await import(
      './polis-classical.js'
    );
    const { createScenario, generateId } = await import('./scenario.js');
    const document = createScenario({ title: 'Repair probe' });
    const unit = (overrides) => ({
      id: generateId(),
      name: 'Probe taxis',
      side: 'side-a',
      troopType: 'hoplite',
      soldiers: 100,
      files: 10,
      lateralInterval: 1,
      rankDepth: 1,
      position: { x: 600, y: 400 },
      facing: 0,
      ...overrides,
    });
    document.units.push(unit({ name: 'First', troopType: 'hoplite' }));
    document.units.push(unit({ name: 'Strangers', troopType: 'cataphract' }));
    document.units.push(unit({ name: 'Old friends', troopType: 'elephant' }));
    const unknown = findUnknownTroopTypeUnits(document);
    assert.equal(unknown.length, 2);
    assert.deepEqual(
      unknown.map((entry) => entry.troopType),
      ['cataphract', 'elephant'],
    );
    assert.deepEqual(
      unknown.map((entry) => entry.index),
      [1, 2],
    );
    // Structurally invalid (missing) troop types are not "unknown": they stay
    // a structural error, reported by validateScenario instead.
    document.units.push(unit({ name: 'Broken', troopType: '' }));
    assert.equal(findUnknownTroopTypeUnits(document).length, 2);
    const warnings = collectUnknownTroopTypeWarnings(document);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every((warning) => /unknown troop type/.test(warning)));
    assert.ok(warnings.some((warning) => /"Strangers"/.test(warning) && /cataphract/.test(warning)));
  });

  it('stays silent when every key is known', async () => {
    const { findUnknownTroopTypeUnits, collectUnknownTroopTypeWarnings } = await import(
      './polis-classical.js'
    );
    const { createScenario } = await import('./scenario.js');
    assert.deepEqual(findUnknownTroopTypeUnits(createScenario({ title: 'Plain' })), []);
    assert.deepEqual(collectUnknownTroopTypeWarnings(createScenario({ title: 'Plain' })), []);
    assert.deepEqual(findUnknownTroopTypeUnits(null), []);
  });
});

describe('polis-classical 1.0 parameters', () => {
  it('keeps the parameter snapshot in a versioned data file inside the package', () => {
    assert.equal(RULESET_PARAMETERS_FILE, 'polis-classical-parameters-1.0.json');
    const stored = JSON.parse(readFileSync(path.join(here, RULESET_PARAMETERS_FILE), 'utf8'));
    assert.deepEqual({ ...RULESET_PARAMETERS }, stored);
    assert.deepEqual(stored.ruleset, { id: RULESET_ID, version: RULESET_VERSION });
  });

  it('marks the parameter values as tuned for the Engine II gate', () => {
    assert.equal(RULESET_PARAMETERS.status, 'tuned');
    assert.ok(RULESET_PARAMETERS.note.trim().length > 0);
  });
});

describe('polis-classical version compatibility', () => {
  it('starts scenarios with the same identifier and major version', () => {
    assert.equal(isCompatibleScenarioRuleset({ id: 'polis-classical', version: '1.0' }), true);
    assert.equal(isCompatibleScenarioRuleset({ id: 'polis-classical', version: '1.4' }), true);
  });

  it('accepts the provisional 0.1 catalogue version under 1.x', () => {
    assert.equal(PROVISIONAL_SCENARIO_VERSION, '0.1');
    assert.equal(isCompatibleScenarioRuleset({ id: 'polis-classical', version: '0.1' }), true);
  });

  it('refuses anything else as an incompatible ruleset reference', () => {
    assert.equal(isCompatibleScenarioRuleset({ id: 'polis-classical', version: '0.2' }), false);
    assert.equal(isCompatibleScenarioRuleset({ id: 'polis-classical', version: '2.0' }), false);
    assert.equal(isCompatibleScenarioRuleset({ id: 'polis-classical', version: '2.1' }), false);
    assert.equal(isCompatibleScenarioRuleset({ id: 'other-rules', version: '1.0' }), false);
    assert.equal(isCompatibleScenarioRuleset({ id: 'polis-classical', version: '' }), false);
    assert.equal(isCompatibleScenarioRuleset({ id: 'polis-classical' }), false);
    assert.equal(isCompatibleScenarioRuleset({ version: '1.0' }), false);
    assert.equal(isCompatibleScenarioRuleset(null), false);
    assert.equal(isCompatibleScenarioRuleset('polis-classical 1.0'), false);
  });

  it('reads the major version without throwing', () => {
    assert.equal(rulesetMajor('1.0'), 1);
    assert.equal(rulesetMajor(' 0.1 '), 0);
    assert.equal(rulesetMajor('2.0'), 2);
    assert.equal(rulesetMajor(''), null);
    assert.equal(rulesetMajor(null), null);
    assert.equal(rulesetMajor(1), null);
  });
});
