// PÓLIS scenario model — file exchange (export and import) (framework-free).
//
// Split from `domain/scenario.js` behind its public entry point; this module
// imports only other domain modules.

import { KNOWN_RULESET_IDS, RULESET_ID, RULESET_VERSION, SCENARIO_FORMAT_VERSION, SCENARIO_KIND, cloneScenario, generateId, isNonEmptyString } from './document.js';

import { roundScenarioToTenth } from './rounding.js';

import { assertValidScenario, validateScenario } from './validation.js';

import { classifyRulesetReference } from './ruleset.js';

// --- File exchange (ADR 0003) -------------------------------------------
// Export writes the stored document; import adds it back as a new copy
// with a new identifier. A failed import rejects the whole file and adds
// nothing: callers only save after parsing succeeds.

export class ScenarioImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ScenarioImportError';
    this.code = code;
  }
}

// File name for an exported scenario, after its title.
export function scenarioFileName(title) {
  const clean = String(title || '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${clean || 'scenario'}.json`;
}

// Serialize the stored document for export: kind, format version, and
// ruleset reference travel with it; library metadata never does.
export function exportScenario(document) {
  assertValidScenario(document);
  const copy = cloneScenario(document);
  delete copy.revision;
  const rounded = roundScenarioToTenth(copy);
  return {
    fileName: scenarioFileName(copy.title),
    json: `${JSON.stringify(rounded, null, 2)}\n`,
  };
}

// Parse an exported file without assigning a new identifier. Throws a
// ScenarioImportError with a specific message for: a non-JSON file,
// another document kind, a higher format version, an unknown ruleset
// identifier, and structurally invalid content (naming the problem).
export function parseScenarioImport(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new ScenarioImportError(
      'not-json',
      'Import failed: the file is not valid JSON.',
    );
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ScenarioImportError(
      'invalid-content',
      'Import failed: the file does not hold a scenario document.',
    );
  }
  if (data.kind !== SCENARIO_KIND) {
    const actual = isNonEmptyString(data.kind) ? `"${data.kind}"` : 'unknown';
    throw new ScenarioImportError(
      'not-scenario-kind',
      `Import failed: this file holds a ${actual} document, not a scenario.`,
    );
  }
  if (!Number.isInteger(data.formatVersion)) {
    throw new ScenarioImportError(
      'invalid-content',
      'Import failed: formatVersion must be an integer.',
    );
  }
  if (data.formatVersion > SCENARIO_FORMAT_VERSION) {
    throw new ScenarioImportError(
      'unsupported-version',
      `Import failed: format version ${data.formatVersion} is newer than the supported version ${SCENARIO_FORMAT_VERSION}.`,
    );
  }
  const rulesetId = data.ruleset?.id;
  if (!isNonEmptyString(rulesetId) || !KNOWN_RULESET_IDS.includes(rulesetId)) {
    throw new ScenarioImportError(
      'unknown-ruleset',
      `Import failed: unknown ruleset "${isNonEmptyString(rulesetId) ? rulesetId : 'missing'}". This editor supports "${RULESET_ID}".`,
    );
  }
  // An older version of the same ruleset opens (keys resolve against the
  // current catalogue; an explicit Save rebinds the reference). A newer
  // version is refused, and the library is left unchanged.
  if (isNonEmptyString(data.ruleset?.version)) {
    const classification = classifyRulesetReference(data.ruleset);
    if (classification.status === 'newer') {
      throw new ScenarioImportError(
        'unsupported-ruleset-version',
        `Import failed: ruleset ${data.ruleset.id} ${data.ruleset.version} is newer than the installed ${RULESET_VERSION}.`,
      );
    }
  }
  const normalized = roundScenarioToTenth(cloneScenario(data));
  const errors = validateScenario(normalized);
  if (errors.length > 0) {
    throw new ScenarioImportError(
      'invalid-content',
      `Import failed: ${errors.join('; ')}`,
    );
  }
  return normalized;
}

// Parse an exported file and return it as a new copy: same content, new
// identifier. The caller saves the copy; nothing is stored on failure.
export function importScenarioDocument(text) {
  const parsed = parseScenarioImport(text);
  const copy = cloneScenario(parsed);
  copy.id = generateId();
  return copy;
}
