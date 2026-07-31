/**
 * Loading a stored run back into a `ContentRun`.
 *
 *   run id → stored run → validated → immutable ContentRun
 *
 * ── A refusal is a value ───────────────────────────────────────────────────
 * The same shape resolution, routing and admission use. "There is no such run"
 * and "that record is not one this build reads" are answers a caller acts on,
 * not exceptional conditions, and a caller that must `catch` to discover one
 * will eventually forget.
 *
 * ── Every record is validated before it is trusted ─────────────────────────
 * Stored data is INPUT. It was written by some earlier build, possibly edited
 * by hand, possibly restored from a backup taken mid-write. Mapping it straight
 * into a `ContentRun` would put a record nobody checked into the type the whole
 * platform trusts — and the failure would surface much later, as a run with no
 * usage or an artifact belonging to someone else.
 *
 * ── Nothing is migrated ────────────────────────────────────────────────────
 * A record at an unknown schema version is refused with `IncompatibleSchema`.
 * There is no upgrade path here and no `migrate` function anywhere in this
 * module: a reader that rewrites what it reads is a write nobody asked for,
 * performed by the process least equipped to know whether it is right.
 */

import type { ContentRun } from './run.js';
import type { ContentRunRepository } from './repository.js';
import { toContentRun } from './mapping.js';
import {
  isSupportedSchemaVersion,
  validateStoredArtifact,
  validateStoredRun,
  type StoredArtifact,
  type StoredContentRun,
  type StoredRecordIssue,
} from './stored.js';

export const RUN_LOAD_CODES = ['UnknownRun', 'IncompatibleSchema', 'CorruptRecord'] as const;

export type RunLoadCode = (typeof RUN_LOAD_CODES)[number];

export function isRunLoadCode(value: unknown): value is RunLoadCode {
  return typeof value === 'string' && (RUN_LOAD_CODES as readonly string[]).includes(value);
}

export type RunLoadResult =
  | {
      readonly outcome: 'loaded';
      readonly run: ContentRun;
      /** The record it came from, for a caller that wants the stored facts. */
      readonly stored: StoredContentRun;
      readonly artifacts: readonly StoredArtifact[];
    }
  | {
      readonly outcome: 'refused';
      readonly code: RunLoadCode;
      /** For operators. Never returned to a caller — see `ai/http.ts`. */
      readonly reason: string;
      readonly issues: readonly StoredRecordIssue[];
    };

export interface LoadContentRunOptions {
  readonly repository: ContentRunRepository;
  readonly runId: string;
}

const refuse = (
  code: RunLoadCode,
  reason: string,
  issues: readonly StoredRecordIssue[] = [],
): RunLoadResult => Object.freeze({ outcome: 'refused' as const, code, reason, issues });

export async function loadContentRun(options: LoadContentRunOptions): Promise<RunLoadResult> {
  const { repository, runId } = options;

  const stored = await repository.loadRun(runId);
  if (stored === null) {
    return refuse('UnknownRun', `There is no stored run '${runId}'.`);
  }

  // Schema first, and separately from structure. A record from a newer build
  // will fail structural checks too, and reporting THOSE would send someone
  // hunting for corruption in a record that is merely from the future.
  if (!isSupportedSchemaVersion(stored.schemaVersion)) {
    return refuse(
      'IncompatibleSchema',
      `Run '${runId}' is at schema version ${String(stored.schemaVersion)}, which this build does not read. Records are refused rather than migrated.`,
    );
  }

  const runValidation = validateStoredRun(stored);
  if (!runValidation.ok) {
    return refuse(
      'CorruptRecord',
      `Run '${runId}' is not a record this build can trust.`,
      runValidation.issues,
    );
  }

  const artifacts = await repository.loadArtifacts(runId);

  const issues: StoredRecordIssue[] = [];
  for (const artifact of artifacts) {
    if (!isSupportedSchemaVersion(artifact.schemaVersion)) {
      return refuse(
        'IncompatibleSchema',
        `An artifact of run '${runId}' is at schema version ${String(artifact.schemaVersion)}, which this build does not read.`,
      );
    }
    const validation = validateStoredArtifact(artifact, runId);
    if (!validation.ok) issues.push(...validation.issues);
  }

  // A count that disagrees with what came back means a partial write or a
  // partial read, and both produce a run that silently lost work.
  if (artifacts.length !== stored.artifactCount) {
    issues.push({
      field: 'run.artifactCount',
      code: 'COUNT_MISMATCH',
      detail: `The run records ${String(stored.artifactCount)} artifact(s); the store returned ${String(artifacts.length)}.`,
    });
  }

  if (issues.length > 0) {
    return refuse(
      'CorruptRecord',
      `Run '${runId}' has artifacts this build cannot trust.`,
      Object.freeze(issues),
    );
  }

  return Object.freeze({
    outcome: 'loaded' as const,
    run: toContentRun({ run: stored, artifacts }),
    stored,
    artifacts: Object.freeze([...artifacts]),
  });
}
