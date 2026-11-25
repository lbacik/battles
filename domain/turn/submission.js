// PÓLIS engine — submission envelope and JSON Schema (framework-free).
//
// Moved verbatim from `../turn.js` (#140): the submission shape, its
// schema, and the hand-written parser returning a deep copy.

import { SUBMISSION_FORMAT_VERSION } from './constants.js';
import { cloneValue, isRecord } from './shared.js';

// --- Submission envelope and JSON Schema ------------------------------------
// A submission is `{ formatVersion, battleId, turnNumber, side, orders[] }`
// and an order is `{ unitId, kind, ...parameters }` (Hold takes no
// parameters). The schema below parses untrusted input: `parseSubmission`
// enforces it by hand — the prototype has no dependencies — and returns a
// deep copy, throwing a `SubmissionParseError` that names the first problem.

// JSON Schema (draft 2020-12) for a turn submission. Kept as data so the
// editor, the harness, and future validators can share it.
export const SUBMISSION_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://polis.example/schemas/turn-submission/v1',
  title: 'Turn submission',
  type: 'object',
  required: ['formatVersion', 'battleId', 'turnNumber', 'side', 'orders'],
  additionalProperties: false,
  properties: Object.freeze({
    formatVersion: Object.freeze({ const: SUBMISSION_FORMAT_VERSION }),
    battleId: Object.freeze({ type: 'string', minLength: 1 }),
    turnNumber: Object.freeze({ type: 'integer', minimum: 1 }),
    side: Object.freeze({ type: 'string', minLength: 1 }),
    orders: Object.freeze({
      type: 'array',
      items: Object.freeze({
        type: 'object',
        required: Object.freeze(['unitId', 'kind']),
        additionalProperties: true,
        properties: Object.freeze({
          unitId: Object.freeze({ type: 'string', minLength: 1 }),
          kind: Object.freeze({ type: 'string', minLength: 1 }),
        }),
      }),
    }),
  }),
});

export class SubmissionParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SubmissionParseError';
    this.code = 'invalid-submission';
  }
}

// Parse untrusted input against `SUBMISSION_SCHEMA`. Returns a deep copy of
// the submission; throws a `SubmissionParseError` naming the first problem.
export function parseSubmission(untrusted) {
  if (!isRecord(untrusted)) {
    throw new SubmissionParseError('A submission must be an object.');
  }
  const allowed = new Set(Object.keys(SUBMISSION_SCHEMA.properties));
  for (const key of Object.keys(untrusted)) {
    if (!allowed.has(key)) {
      throw new SubmissionParseError(`A submission must not hold "${key}".`);
    }
  }
  for (const key of SUBMISSION_SCHEMA.required) {
    if (untrusted[key] === undefined) {
      throw new SubmissionParseError(`A submission requires "${key}".`);
    }
  }
  if (untrusted.formatVersion !== SUBMISSION_FORMAT_VERSION) {
    throw new SubmissionParseError(
      `Unsupported submission format version ${JSON.stringify(untrusted.formatVersion)} ` +
        `(this engine reads version ${SUBMISSION_FORMAT_VERSION}).`,
    );
  }
  if (typeof untrusted.battleId !== 'string' || untrusted.battleId.trim() === '') {
    throw new SubmissionParseError('A submission requires a non-empty battle id.');
  }
  if (!Number.isInteger(untrusted.turnNumber) || untrusted.turnNumber < 1) {
    throw new SubmissionParseError('A submission requires a turn number of at least 1.');
  }
  if (typeof untrusted.side !== 'string' || untrusted.side.trim() === '') {
    throw new SubmissionParseError('A submission requires a non-empty side.');
  }
  if (!Array.isArray(untrusted.orders)) {
    throw new SubmissionParseError('A submission requires an orders array.');
  }
  untrusted.orders.forEach((order, index) => {
    if (!isRecord(order)) {
      throw new SubmissionParseError(`Order ${index} must be an object.`);
    }
    if (typeof order.unitId !== 'string' || order.unitId.trim() === '') {
      throw new SubmissionParseError(`Order ${index} requires a non-empty unit id.`);
    }
    if (typeof order.kind !== 'string' || order.kind.trim() === '') {
      throw new SubmissionParseError(`Order ${index} requires a non-empty order kind.`);
    }
  });
  return cloneValue(untrusted);
}
