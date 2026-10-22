// PÓLIS tracer bullet — scenario library trust helpers (framework-free).
//
// The editor manages the scenario library through the narrow scenario store
// interface (ADR 0003). This module holds the pure rules that keep authors
// from losing work or silently overwriting it, so the editor and the unit
// tests share them: duplicating as a new copy, detecting when the stored
// revision moved since the scenario was opened (another tab), classifying
// library entries that cannot be read, exporting such entries raw, and
// recognising quota failures. It imports only the domain model
// (`scenario.js`): no DOM, no IndexedDB, no React or Next.js.
//
// Save atomicity itself is a store property — every store implementation must
// validate and deep-clone before it mutates anything, so a failed save (for
// example a quota error) rejects and leaves the previous version intact —
// and this module keeps the editor honest about it: `performSave` never
// swallows the store error, so the caller keeps its unsaved-changes state.

import {
  SCENARIO_FORMAT_VERSION,
  classifyRulesetReference,
  cloneScenario,
  generateId,
  scenarioFileName,
  validateScenario,
} from './scenario.js';

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

// Newest first; entries without a timestamp sort last. Shared by every
// store implementation so the library orders entries the same way.
export function compareLibraryEntries(a, b) {
  if (a.updatedAt === b.updatedAt) return 0;
  if (a.updatedAt === null || a.updatedAt === undefined) return 1;
  if (b.updatedAt === null || b.updatedAt === undefined) return -1;
  return a.updatedAt < b.updatedAt ? 1 : -1;
}

// True when the document targets a newer format version than this
// application supports. Such documents are never opened, duplicated, or
// migrated: the stored data is left untouched.
export function isUnsupportedDocument(document, options = {}) {
  const supportedVersion = Number.isInteger(options.supportedVersion)
    ? options.supportedVersion
    : SCENARIO_FORMAT_VERSION;
  return (
    !!document &&
    typeof document === 'object' &&
    Number.isInteger(document.formatVersion) &&
    document.formatVersion > supportedVersion
  );
}

function titleOf(document) {
  return isNonEmptyString(document?.title) ? document.title : '(untitled)';
}

// Thrown by performSave when the stored revision moved since the scenario
// was opened. The editor catches it and asks the author to choose between
// overwriting and saving as a copy; nothing has been stored at that point.
export class SaveConflictError extends Error {
  constructor({ loadedRevision = null, storedRevision = null } = {}) {
    super(
      `This scenario changed since it was opened (stored revision ${storedRevision}, ` +
        `loaded revision ${loadedRevision}). Choose Overwrite or Save as copy.`,
    );
    this.name = 'SaveConflictError';
    this.code = 'save-conflict';
    this.loadedRevision = loadedRevision;
    this.storedRevision = storedRevision;
  }
}

// True when the stored revision moved since the scenario was loaded: both
// revisions are known integers and they differ. Unknown revisions (a new,
// never-saved scenario, or a record without a counter) never conflict.
export function detectSaveConflict(loadedRevision, storedRevision) {
  return (
    Number.isInteger(loadedRevision) &&
    Number.isInteger(storedRevision) &&
    loadedRevision !== storedRevision
  );
}

// Save through the store interface with conflict detection. Validates first
// (the store validates again), raises SaveConflictError instead of silently
// overwriting unless overwrite is true, and lets any store failure — quota
// errors included — propagate untouched so the caller keeps the previous
// version and its unsaved-changes indicator.
export async function performSave(store, document, options = {}) {
  const loadedRevision = options.loadedRevision ?? null;
  const storedRevision = options.storedRevision ?? null;
  const overwrite = options.overwrite === true;
  const errors = validateScenario(document);
  if (errors.length > 0) {
    throw new Error(`Invalid scenario: ${errors.join('; ')}`);
  }
  if (!overwrite && detectSaveConflict(loadedRevision, storedRevision)) {
    throw new SaveConflictError({ loadedRevision, storedRevision });
  }
  return await store.save(document);
}

// Duplicate a scenario document as a new copy: same content, new identifier,
// suffixed title, and fresh timestamps. Library metadata (such as the
// revision counter) never travels with the copy: the next save assigns
// revision 1. Throws when the source cannot be read.
export function duplicateScenario(document) {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw new Error('Cannot duplicate: no scenario document.');
  }
  const copy = cloneScenario(document);
  copy.id = generateId();
  const title = isNonEmptyString(copy.title) ? copy.title.trim() : '';
  // The library form limits titles to 120 characters; keep the copy editable.
  copy.title = (title ? `${title} (copy)` : 'Untitled (copy)').slice(0, 120);
  const now = new Date().toISOString();
  copy.createdAt = now;
  copy.updatedAt = now;
  delete copy.revision;
  const errors = validateScenario(copy);
  if (errors.length > 0) {
    throw new Error(`Cannot duplicate: ${errors.join('; ')}`);
  }
  return copy;
}

// Classify one raw stored record for the library list. Records are read
// defensively: whatever another tab, an older build, or a quota failure left
// behind must list as unreadable with its cause (or as needing a newer
// application) instead of crashing the library. Never mutates its input.
//
// Statuses: 'ok' (openable), 'unreadable' (listed with a cause; only raw
// export or delete), 'unsupported-version' (a newer format version than this
// application supports; never opened, stored data untouched).
export function classifyStoredRecord(record, options = {}) {
  const supportedVersion = Number.isInteger(options.supportedVersion)
    ? options.supportedVersion
    : SCENARIO_FORMAT_VERSION;
  const revision =
    record && Number.isInteger(record.revision) ? record.revision : null;
  const updatedAt =
    record && typeof record.updatedAt === 'string' ? record.updatedAt : null;
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return {
      id: null,
      title: '(unreadable)',
      revision,
      updatedAt,
      status: 'unreadable',
      cause: 'Stored record is not an object.',
    };
  }
  const id = isNonEmptyString(record.id) ? record.id : null;
  const document = record.document;
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    return {
      id,
      title: '(unreadable)',
      revision,
      updatedAt,
      status: 'unreadable',
      cause: 'Stored data is not a scenario document.',
    };
  }
  if (revision === null) {
    return {
      id,
      title: titleOf(document),
      revision,
      updatedAt,
      status: 'unreadable',
      cause: 'Stored record has no revision counter.',
    };
  }
  if (
    Number.isInteger(document.formatVersion) &&
    document.formatVersion > supportedVersion
  ) {
    return {
      id,
      title: titleOf(document),
      revision,
      updatedAt,
      status: 'unsupported-version',
      cause:
        `Format version ${document.formatVersion} is newer than the supported ` +
        `version ${supportedVersion}. Open it with a newer application; the ` +
        `stored data was left untouched.`,
    };
  }
  // Ruleset mismatch (decision #5 item 12): an unknown ruleset identifier or
  // a newer version of the same ruleset is never opened; the stored data is
  // left untouched. The entry lists as unreadable with its cause and offers
  // only raw export or delete. An older version of the same ruleset stays
  // openable: it resolves against the current catalogue and an explicit Save
  // rebinds the reference.
  const classification = classifyRulesetReference(document.ruleset);
  if (classification.status === 'unknown-ruleset' || classification.status === 'newer') {
    return {
      id,
      title: titleOf(document),
      revision,
      updatedAt,
      status: 'unreadable',
      cause:
        classification.status === 'unknown-ruleset'
          ? `Stored scenario references ${classification.cause}; the stored data was left untouched.`
          : `Stored scenario ${classification.cause}.`,
    };
  }
  let errors = [];
  try {
    errors = validateScenario(document);
  } catch (error) {
    return {
      id,
      title: titleOf(document),
      revision,
      updatedAt,
      status: 'unreadable',
      cause: `Stored scenario cannot be read: ${error.message}`,
    };
  }
  if (errors.length > 0) {
    const extra = errors.length > 1 ? ` (+${errors.length - 1} more)` : '';
    return {
      id,
      title: titleOf(document),
      revision,
      updatedAt,
      status: 'unreadable',
      cause: `Stored scenario is invalid: ${errors[0]}${extra}`,
    };
  }
  return {
    id,
    title: document.title,
    revision,
    updatedAt,
    status: 'ok',
    cause: null,
  };
}

// Export a stored record without reading it: the raw stored data (or the
// record itself when there is no document) serialised to JSON. Used for
// unreadable entries and for documents with a newer format version, which
// the validating exporter must refuse.
export function exportRawRecord(record) {
  const document =
    record &&
    typeof record === 'object' &&
    record.document &&
    typeof record.document === 'object'
      ? record.document
      : record;
  const rawTitle =
    document && isNonEmptyString(document.title)
      ? document.title.trim()
      : 'unreadable-scenario';
  const base = scenarioFileName(rawTitle).replace(/\.json$/, '');
  let json;
  try {
    json = `${JSON.stringify(document ?? record, null, 2)}\n`;
  } catch {
    json = `${String(document ?? record)}\n`;
  }
  return { fileName: `${base}-raw.json`, json };
}

// Recognise browser storage quota failures (IndexedDB QuotaExceededError and
// its legacy shape) so the editor can name the problem instead of showing a
// bare failure. Anything else is not a quota error.
export function isQuotaError(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'QuotaExceededError') return true;
  if (error.code === 22 || error.code === 'QUOTA_EXCEEDED') return true;
  return /quota/i.test(error.message || '');
}
