/**
 * The stored shape of a content run.
 *
 * ── Why a separate model at all ────────────────────────────────────────────
 * `ContentRun` is what an orchestrator produces and a caller holds for the
 * duration of one request. `StoredContentRun` is what outlives the process, and
 * the two want different things:
 *
 *   - A stored record carries a SCHEMA VERSION. An in-memory one does not need
 *     one, because the code that made it is the code reading it.
 *   - A stored record carries no `Principal`. A principal is the resolved
 *     authority of ONE request — roles and permissions computed from live
 *     bindings — and writing it down would create a second, stale copy of the
 *     authorization state that `resolvePermissions` exists to compute fresh.
 *     What is stored is WHO ran it, never what they were allowed to do.
 *   - A stored record carries no `Date`, no `Map`, no class. Everything here is
 *     a string, a number, a boolean, or a frozen array of those — which is what
 *     makes it storable by anything, including the SQL-backed repository a
 *     later increment will write.
 *
 * ── Nothing here knows about a database ────────────────────────────────────
 * No driver, no SQL, no ORM, no connection. These are values; a repository port
 * moves them. The one thing that would make this layer hard to replace is a
 * detail of the store leaking into the model, and there is none.
 *
 * ── Schema versions are checked, never migrated ────────────────────────────
 * A record at a version this build does not know is REFUSED. An automatic
 * migration is a write performed by a reader, at read time, against data it may
 * be the only process to have seen — and the version that made the record is
 * the version that understood it. Refusing is loud; guessing is silent.
 */

import type { AICapability } from '@contentos/contracts';

import {
  ADMISSION_ORGANIZATION_STATUSES,
  ADMISSION_WORKSPACE_STATUSES,
  type AdmissionOrganizationStatus,
  type AdmissionWorkspaceStatus,
} from '../gateway/ports.js';
import { isLedgerCompatibleAmount } from '../usage/recorder.js';
import { isRunStatus, type RunStatus } from './state.js';

/**
 * The version this build writes.
 *
 * Monotonic, like every other version in the platform: it is an identity, not a
 * comparison. A record's version says which reader understands it.
 */
export const CONTENT_RUN_SCHEMA_VERSION = 1;

/**
 * Every version this build can READ.
 *
 * Wider than what it writes, so a deployment that rolls back one step can still
 * read what the newer build wrote. Today they coincide because there has only
 * ever been one.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = Object.freeze([1]);

export function isSupportedSchemaVersion(value: unknown): value is number {
  return typeof value === 'number' && SUPPORTED_SCHEMA_VERSIONS.includes(value);
}

/**
 * What every stored record carries, whatever it is a record OF.
 *
 * `createdAt` and `updatedAt` are the RECORD's timestamps — when the row was
 * written and last touched — and are deliberately distinct from the run's own
 * timings, which say when the work happened. Conflating them is how "the run
 * took four hours" turns out to mean "the row was rewritten four hours later".
 */
export interface StoredRecord {
  readonly schemaVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Which prompt produced something, permanently.
 *
 * The anchor (`'planning.outline@7'`) and its two parts, both stored: the
 * anchor is what a human reads and what `promptVersion` carries through
 * metering, and the parts are what a query filters on. Deriving one from the
 * other at read time would put a parser between a record and a question.
 */
export interface StoredPromptReference {
  readonly templateId: string;
  readonly templateVersion: number;
  /** `'planning.outline@7'`. */
  readonly promptVersion: string;
}

/**
 * What one artifact cost, as the ledger would state it.
 *
 * `amount` is a decimal STRING, six places, exactly as `CostEstimate` and the
 * credits ledger require. A float here would lose money on the way to disk,
 * which is the one place the loss is permanent.
 */
export interface StoredUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /** True when the provider omitted counts and the adapter computed them. */
  readonly tokensEstimated: boolean;
  /** ISO 4217. */
  readonly currency: string;
  /** Non-negative decimal, at most six places. */
  readonly amount: string;
  readonly latencyMs: number;
}

/** When each stage of the run happened. The run's clock, not the record's. */
export interface StoredTimings {
  readonly createdAt: string;
  readonly compiledAt: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

/**
 * Everything about the execution that is not an artifact.
 *
 * `principalId`, `principalKind` and `principalMethod` are identity — who ran
 * it and how they proved it. Roles and permissions are deliberately absent: see
 * the file header.
 */
export interface StoredExecutionMetadata {
  /** The runtime execution. Null when the run never compiled. */
  readonly executionId: string | null;
  readonly workflowId: string;
  /** The monotonic identity the runtime recorded as `definitionVersion`. */
  readonly workflowVersion: number;
  /** `'article.draft@2'`. */
  readonly workflowRef: string;
  readonly capability: AICapability;
  readonly organizationId: string;
  readonly organizationStatus: AdmissionOrganizationStatus;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId: string;
  readonly workspaceStatus: AdmissionWorkspaceStatus;
  readonly principalId: string;
  readonly principalKind: string;
  readonly principalMethod: string;
  readonly correlationId: string;
  readonly idempotencyKey: string;
  readonly timings: StoredTimings;
}

/** Why a stored run did not complete. Null on one that did. */
export interface StoredFailure {
  readonly code: string;
  readonly reason: string;
  /** The adapter's own code, where a provider failed. */
  readonly providerCode: string | null;
}

export interface StoredArtifact extends StoredRecord {
  /** The run this belongs to. Checked on load — a mismatch is corruption. */
  readonly runId: string;
  readonly stepId: string;
  /**
   * Position in the run, stored rather than implied by array order.
   *
   * A store that returns rows unordered would otherwise reorder a run's output
   * silently, and "the draft came before the outline" is not a failure anyone
   * notices until a customer reads it.
   */
  readonly sequence: number;
  readonly prompt: StoredPromptReference;
  readonly providerId: string;
  readonly model: string;
  readonly capability: AICapability;
  readonly content: string;
  readonly finishReason: string;
  readonly usage: StoredUsage;
  readonly attempts: number;
  /** Carried verbatim, never interpreted — here or on the way back out. */
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface StoredContentRun extends StoredRecord {
  readonly runId: string;
  readonly status: RunStatus;
  readonly execution: StoredExecutionMetadata;
  /** The prompts this run pinned at compile time, in step order. */
  readonly templateVersions: readonly StoredPromptReference[];
  readonly failure: StoredFailure | null;
  /** How many artifacts belong to it. Checked against what a load returns. */
  readonly artifactCount: number;
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * One thing wrong with a record.
 *
 * The `{ field, code, detail }` shape every validator in the platform uses —
 * the AI request validator, the workflow validator, the blueprint validator.
 * A fourth shape would be a fourth thing for a reader to learn.
 */
export interface StoredRecordIssue {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export type StoredRecordValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly StoredRecordIssue[] };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const PROMPT_VERSION = /^([a-z][a-z0-9]*(\.[a-z0-9]+)*)@(\d+)$/;

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO.test(value);
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Every issue is reported, not the first — a bad record is diagnosed once. */
class Issues {
  readonly list: StoredRecordIssue[] = [];
  add(field: string, code: string, detail: string): void {
    this.list.push({ field, code, detail });
  }
  get result(): StoredRecordValidation {
    return this.list.length === 0 ? { ok: true } : { ok: false, issues: Object.freeze(this.list) };
  }
}

function checkRecord(record: Partial<StoredRecord>, issues: Issues, where: string): void {
  if (!isSupportedSchemaVersion(record.schemaVersion)) {
    issues.add(
      `${where}.schemaVersion`,
      'UNSUPPORTED_SCHEMA',
      `'${String(record.schemaVersion)}' is not a schema version this build reads (${SUPPORTED_SCHEMA_VERSIONS.join(', ')}). Records are refused rather than migrated on read.`,
    );
  }
  if (!isTimestamp(record.createdAt)) {
    issues.add(`${where}.createdAt`, 'BAD_TIMESTAMP', `'${String(record.createdAt)}' is not ISO.`);
  }
  if (!isTimestamp(record.updatedAt)) {
    issues.add(`${where}.updatedAt`, 'BAD_TIMESTAMP', `'${String(record.updatedAt)}' is not ISO.`);
  }
}

function checkPrompt(
  reference: Partial<StoredPromptReference> | undefined,
  issues: Issues,
  where: string,
): void {
  if (reference === undefined || typeof reference !== 'object') {
    issues.add(
      where,
      'MISSING',
      'A prompt reference is required; it is what makes an artifact explainable.',
    );
    return;
  }
  const match = PROMPT_VERSION.exec(String(reference.promptVersion));
  if (match === null) {
    issues.add(
      `${where}.promptVersion`,
      'BAD_FORMAT',
      `'${String(reference.promptVersion)}' is not a prompt anchor like 'planning.outline@7'.`,
    );
    return;
  }
  // The anchor and its parts are stored separately, so they can disagree — and
  // a disagreement means one of them was rewritten by hand.
  if (match[1] !== reference.templateId || Number(match[3]) !== reference.templateVersion) {
    issues.add(
      where,
      'INCONSISTENT',
      `'${String(reference.promptVersion)}' does not agree with ${String(reference.templateId)}@${String(reference.templateVersion)}.`,
    );
  }
}

function checkUsage(usage: Partial<StoredUsage> | undefined, issues: Issues, where: string): void {
  if (usage === undefined || typeof usage !== 'object') {
    issues.add(
      where,
      'MISSING',
      'Usage is required; an artifact nobody can price is one nobody can bill.',
    );
    return;
  }
  for (const field of ['promptTokens', 'completionTokens', 'totalTokens', 'latencyMs'] as const) {
    if (!isCount(usage[field])) {
      issues.add(
        `${where}.${field}`,
        'BAD_COUNT',
        `'${String(usage[field])}' is not a non-negative integer.`,
      );
    }
  }
  // The same decimal rule the credits ledger applies — reused, not restated.
  if (!isLedgerCompatibleAmount(usage.amount)) {
    issues.add(
      `${where}.amount`,
      'BAD_AMOUNT',
      `'${String(usage.amount)}' is not a decimal string the ledger would accept.`,
    );
  }
  if (typeof usage.currency !== 'string' || usage.currency.length !== 3) {
    issues.add(`${where}.currency`, 'BAD_CURRENCY', `'${String(usage.currency)}' is not ISO 4217.`);
  }
}

/**
 * Is this a run record this build can read?
 *
 * Structure and schema together, because a caller loading a run has one
 * question — "can I trust this?" — and splitting the answer across two calls
 * invites one of them to be forgotten.
 */
export function validateStoredRun(record: Partial<StoredContentRun>): StoredRecordValidation {
  const issues = new Issues();
  checkRecord(record, issues, 'run');

  if (typeof record.runId !== 'string' || record.runId.trim() === '') {
    issues.add(
      'run.runId',
      'MISSING',
      'A stored run needs an id; it is how everything else finds it.',
    );
  }
  if (!isRunStatus(record.status)) {
    issues.add(
      'run.status',
      'UNKNOWN_STATUS',
      `'${String(record.status)}' is not a run status this build knows.`,
    );
  }
  if (!isCount(record.artifactCount)) {
    issues.add(
      'run.artifactCount',
      'BAD_COUNT',
      `'${String(record.artifactCount)}' is not a non-negative integer.`,
    );
  }

  // Widened deliberately: this is UNTRUSTED input, whatever the declared type
  // says. A record restored from a backup taken mid-write is missing fields the
  // compiler believes are always there.
  const execution = record.execution as Partial<StoredExecutionMetadata> | undefined;
  if (execution === undefined || typeof execution !== 'object') {
    issues.add(
      'run.execution',
      'MISSING',
      'A run without its execution metadata is unattributable.',
    );
  } else {
    for (const field of [
      'workflowId',
      'workflowRef',
      'organizationId',
      'workspaceId',
      'principalId',
      'correlationId',
      'idempotencyKey',
    ] as const) {
      const value: unknown = execution[field];
      if (typeof value !== 'string' || value.trim() === '') {
        issues.add(`run.execution.${field}`, 'MISSING', `'${field}' is required.`);
      }
    }
    if (!isCount(execution.workflowVersion)) {
      issues.add(
        'run.execution.workflowVersion',
        'BAD_COUNT',
        `'${String(execution.workflowVersion)}' is not a non-negative integer.`,
      );
    }
    const timings = execution.timings as Partial<StoredTimings> | undefined;
    if (!isTimestamp(timings?.createdAt)) {
      issues.add(
        'run.execution.timings.createdAt',
        'BAD_TIMESTAMP',
        `'${String(timings?.createdAt)}' is not ISO.`,
      );
    }
    // The tenancy statuses AS THEY WERE. Checked against the same vocabularies
    // admission uses, so a record cannot carry a status nothing recognises.
    if (
      !(ADMISSION_ORGANIZATION_STATUSES as readonly string[]).includes(
        execution.organizationStatus as string,
      )
    ) {
      issues.add(
        'run.execution.organizationStatus',
        'UNKNOWN_STATUS',
        `'${String(execution.organizationStatus)}' is not an organization status.`,
      );
    }
    if (
      !(ADMISSION_WORKSPACE_STATUSES as readonly string[]).includes(
        execution.workspaceStatus as string,
      )
    ) {
      issues.add(
        'run.execution.workspaceStatus',
        'UNKNOWN_STATUS',
        `'${String(execution.workspaceStatus)}' is not a workspace status.`,
      );
    }
  }

  if (!Array.isArray(record.templateVersions)) {
    issues.add(
      'run.templateVersions',
      'MISSING',
      'A run pins its prompts; the list is required, even empty.',
    );
  } else {
    (record.templateVersions as readonly Partial<StoredPromptReference>[]).forEach(
      (reference, index) => {
        checkPrompt(reference, issues, `run.templateVersions[${String(index)}]`);
      },
    );
  }

  return issues.result;
}

/** Is this an artifact record this build can read, and does it belong here? */
export function validateStoredArtifact(
  record: Partial<StoredArtifact>,
  runId?: string,
): StoredRecordValidation {
  const issues = new Issues();
  checkRecord(record, issues, 'artifact');

  if (typeof record.runId !== 'string' || record.runId.trim() === '') {
    issues.add('artifact.runId', 'MISSING', 'An artifact belongs to a run; the id is required.');
  } else if (runId !== undefined && record.runId !== runId) {
    // One run's output filed under another is the corruption that turns into a
    // customer reading someone else's content.
    issues.add(
      'artifact.runId',
      'WRONG_RUN',
      `This artifact belongs to '${record.runId}', not '${runId}'.`,
    );
  }
  if (typeof record.stepId !== 'string' || record.stepId.trim() === '') {
    issues.add('artifact.stepId', 'MISSING', 'An artifact records which step produced it.');
  }
  if (!isCount(record.sequence)) {
    issues.add('artifact.sequence', 'BAD_COUNT', `'${String(record.sequence)}' is not an index.`);
  }
  if (typeof record.content !== 'string') {
    issues.add('artifact.content', 'MISSING', 'The generated text is the artifact.');
  }
  if (typeof record.providerId !== 'string' || record.providerId.trim() === '') {
    issues.add('artifact.providerId', 'MISSING', 'Which provider produced this is required.');
  }
  if (typeof record.model !== 'string' || record.model.trim() === '') {
    issues.add('artifact.model', 'MISSING', 'Which model produced this is required.');
  }
  if (!isCount(record.attempts) || record.attempts < 1) {
    issues.add(
      'artifact.attempts',
      'BAD_COUNT',
      `'${String(record.attempts)}' is not a dispatch count; an artifact took at least one.`,
    );
  }

  checkPrompt(record.prompt, issues, 'artifact.prompt');
  checkUsage(record.usage, issues, 'artifact.usage');

  return issues.result;
}

/** Split `'planning.outline@7'`. Null when it is not one. */
export function parsePromptVersion(promptVersion: string): StoredPromptReference | null {
  const match = PROMPT_VERSION.exec(promptVersion);
  if (match === null) return null;
  return Object.freeze({
    templateId: match[1] as string,
    templateVersion: Number(match[3]),
    promptVersion,
  });
}
