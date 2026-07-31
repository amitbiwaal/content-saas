/**
 * Run history — the read model.
 *
 *   query → validate → keyset criteria → store → validate records → views
 *
 * ── It reads. That is the whole of it ──────────────────────────────────────
 * No provider, no runtime, no orchestration, and no write of any kind: there is
 * no `saveRun` and no `updateStatus` call anywhere in this file. The permission
 * to update a status exists on the port; this layer does not use it, because
 * none of the four operations it offers is one that would.
 *
 * ── Nothing loaded is trusted ──────────────────────────────────────────────
 * Every record that comes back is put through S4.4's own validators before it
 * becomes a view. Stored data is input: written by an earlier build, possibly
 * restored from a backup taken mid-write, possibly edited by hand. Mapping it
 * straight into a read model would put a record nobody checked in front of a
 * dashboard, and the failure would surface as a run with no usage.
 *
 * A corrupt record REFUSES THE PAGE rather than being skipped. Dropping it
 * would hand back a page that looks complete and is not, and silent data loss
 * is the one failure nobody goes looking for.
 *
 * ── Ordering is enforced here, not assumed ─────────────────────────────────
 * The slice is sorted by (createdAt, runId) before it is paged, whatever order
 * the store returned it in. Cursor pagination is only correct over a total
 * order, and a store that returned rows unordered would otherwise produce pages
 * that skip and repeat while looking entirely normal.
 *
 * ── No offset, anywhere ────────────────────────────────────────────────────
 * There is no `offset`, no `page` number and no `skip` in this module. See
 * `cursor.ts` for why.
 */

import type { Page } from '@contentos/contracts';

import { RUN_LOAD_CODES } from '../runs/load.js';
import {
  isSupportedSchemaVersion,
  validateStoredArtifact,
  validateStoredRun,
  type StoredArtifact,
  type StoredContentRun,
  type StoredRecordIssue,
} from '../runs/stored.js';
import { createCursor, decodeCursor, encodeCursor } from './cursor.js';
import {
  canonicalFilter,
  validateRunHistoryQuery,
  type ResolvedRunHistoryQuery,
  type RunHistoryQuery,
} from './query.js';
import type { ContentRunHistoryStore, StoredRunCriteria, StoredRunPosition } from './store.js';
import {
  summariseUsage,
  toArtifactHistoryView,
  toRunHistoryView,
  type ArtifactHistoryView,
  type RunHistoryView,
  type RunUsageSummary,
} from './views.js';

/**
 * Why a read was refused.
 *
 * The three record-level codes are S4.4's, spread in rather than restated, so
 * "a corrupt record is a `CorruptRecord`" stays one fact in one place.
 */
export const RUN_HISTORY_CODES = [
  ...RUN_LOAD_CODES,
  'InvalidFilter',
  'InvalidCursor',
  'IncompatibleCursor',
] as const;

export type RunHistoryCode = (typeof RUN_HISTORY_CODES)[number];

export function isRunHistoryCode(value: unknown): value is RunHistoryCode {
  return typeof value === 'string' && (RUN_HISTORY_CODES as readonly string[]).includes(value);
}

export interface RunHistoryRefusal {
  readonly outcome: 'refused';
  readonly code: RunHistoryCode;
  /** For operators. Never returned to a caller — see `ai/http.ts`. */
  readonly reason: string;
  readonly issues: readonly StoredRecordIssue[];
}

/**
 * One page of history.
 *
 * The platform's own `Page<T>` — `items`, `nextCursor`, `hasMore` — rather than
 * a second pagination shape that means the same thing. `nextCursor` is opaque,
 * and null when this is the last page.
 */
export type RunHistoryPage = Page<RunHistoryView>;

export type RunHistoryResult =
  | { readonly outcome: 'ok'; readonly page: RunHistoryPage }
  | RunHistoryRefusal;

export type RunLookupResult =
  | { readonly outcome: 'found'; readonly run: RunHistoryView }
  | RunHistoryRefusal;

export type ArtifactHistoryResult =
  | {
      readonly outcome: 'ok';
      /** In step order. */
      readonly artifacts: readonly ArtifactHistoryView[];
      readonly usage: RunUsageSummary;
    }
  | RunHistoryRefusal;

export interface RunHistoryService {
  /** One run, by id. Artifacts are a separate call — a list view needs neither. */
  getRunById(runId: string): Promise<RunLookupResult>;
  listRuns(query?: RunHistoryQuery): Promise<RunHistoryResult>;
  listArtifacts(runId: string): Promise<ArtifactHistoryResult>;
  /** `listRuns` pinned to one workflow. A query naming another is refused. */
  listByWorkflow(workflowId: string, query?: RunHistoryQuery): Promise<RunHistoryResult>;
}

export interface RunHistoryOptions {
  readonly store: ContentRunHistoryStore;
}

const refuse = (
  code: RunHistoryCode,
  reason: string,
  issues: readonly StoredRecordIssue[] = [],
): RunHistoryRefusal => Object.freeze({ outcome: 'refused' as const, code, reason, issues });

/**
 * Admit a stored run, or say why not.
 *
 * Schema first and separately: a record from a newer build fails structural
 * checks too, and reporting THOSE sends someone hunting for corruption in a
 * record that is merely from the future. The same order `loadContentRun` uses,
 * against the same validators.
 */
function admitRun(stored: StoredContentRun): RunHistoryRefusal | null {
  if (!isSupportedSchemaVersion(stored.schemaVersion)) {
    return refuse(
      'IncompatibleSchema',
      `Run '${stored.runId}' is at schema version ${String(stored.schemaVersion)}, which this build does not read. Records are refused rather than migrated.`,
    );
  }
  const validation = validateStoredRun(stored);
  return validation.ok
    ? null
    : refuse(
        'CorruptRecord',
        `Run '${stored.runId}' is not a record this build can trust.`,
        validation.issues,
      );
}

function admitArtifact(stored: StoredArtifact, runId: string): RunHistoryRefusal | null {
  if (!isSupportedSchemaVersion(stored.schemaVersion)) {
    return refuse(
      'IncompatibleSchema',
      `An artifact of run '${runId}' is at schema version ${String(stored.schemaVersion)}, which this build does not read.`,
    );
  }
  const validation = validateStoredArtifact(stored, runId);
  return validation.ok
    ? null
    : refuse(
        'CorruptRecord',
        `An artifact of run '${runId}' is not a record this build can trust.`,
        validation.issues,
      );
}

/** (createdAt, runId), in the requested direction. Total, because ids are unique. */
function compare(
  left: StoredContentRun,
  right: StoredContentRun,
  order: ResolvedRunHistoryQuery['order'],
): number {
  const leftAt = left.execution.timings.createdAt;
  const rightAt = right.execution.timings.createdAt;

  let ascending = 0;
  if (leftAt < rightAt) ascending = -1;
  else if (leftAt > rightAt) ascending = 1;
  else if (left.runId < right.runId) ascending = -1;
  else if (left.runId > right.runId) ascending = 1;

  return order === 'newest' ? -ascending : ascending;
}

function criteriaOf(
  query: ResolvedRunHistoryQuery,
  after: StoredRunPosition | null,
): StoredRunCriteria {
  const { filter } = query;
  return Object.freeze({
    organizationId: filter.organizationId ?? null,
    workspaceId: filter.workspaceId ?? null,
    principalId: filter.principalId ?? null,
    workflowId: filter.workflowId ?? null,
    statuses: filter.statuses === undefined ? null : Object.freeze([...filter.statuses]),
    createdAfter: filter.createdAfter ?? null,
    createdBefore: filter.createdBefore ?? null,
    after,
    order: query.order,
    // One more than the page, which is how `hasMore` is learned without a
    // second query and without a count.
    limit: query.limit + 1,
  });
}

export function createRunHistory(options: RunHistoryOptions): RunHistoryService {
  const { store } = options;

  async function list(query: RunHistoryQuery): Promise<RunHistoryResult> {
    const validation = validateRunHistoryQuery(query);
    if (!validation.ok) {
      return refuse(
        'InvalidFilter',
        'The query cannot be run as asked.',
        // Every issue, so a caller fixes a query in one pass rather than four.
        validation.issues,
      );
    }

    const resolved = validation.query;
    const canonical = canonicalFilter(resolved);

    let after: StoredRunPosition | null = null;
    if (resolved.cursor !== null) {
      const decoded = decodeCursor(resolved.cursor, canonical);
      if (decoded.outcome === 'refused') return refuse(decoded.code, decoded.reason);
      after = { createdAt: decoded.cursor.createdAt, runId: decoded.cursor.runId };
    }

    const slice = await store.queryRuns(criteriaOf(resolved, after));

    for (const stored of slice.runs) {
      const problem = admitRun(stored);
      if (problem !== null) return problem;
    }

    // Enforced, not assumed. See the file header.
    const ordered = [...slice.runs].sort((left, right) => compare(left, right, resolved.order));
    const hasMore = ordered.length > resolved.limit;
    const page = ordered.slice(0, resolved.limit);
    const last = page[page.length - 1];

    return Object.freeze({
      outcome: 'ok' as const,
      page: Object.freeze({
        items: Object.freeze(page.map(toRunHistoryView)),
        // A cursor only where there is somewhere to go. Emitting one on the
        // last page invites a caller to fetch an empty page forever.
        nextCursor:
          hasMore && last !== undefined
            ? encodeCursor(
                createCursor({
                  createdAt: last.execution.timings.createdAt,
                  runId: last.runId,
                  canonical,
                }),
              )
            : null,
        hasMore,
      }),
    });
  }

  return {
    async getRunById(runId: string): Promise<RunLookupResult> {
      if (runId.trim() === '') {
        return refuse('UnknownRun', 'A run id is required.');
      }

      const stored = await store.loadRun(runId);
      if (stored === null) return refuse('UnknownRun', `There is no stored run '${runId}'.`);

      const problem = admitRun(stored);
      if (problem !== null) return problem;

      return Object.freeze({ outcome: 'found' as const, run: toRunHistoryView(stored) });
    },

    listRuns: (query: RunHistoryQuery = {}): Promise<RunHistoryResult> => list(query),

    async listArtifacts(runId: string): Promise<ArtifactHistoryResult> {
      if (runId.trim() === '') {
        return refuse('UnknownRun', 'A run id is required.');
      }

      // The run first: artifacts belonging to nothing are the corruption case,
      // and `artifactCount` is what makes a partial read detectable at all.
      const stored = await store.loadRun(runId);
      if (stored === null) return refuse('UnknownRun', `There is no stored run '${runId}'.`);

      const problem = admitRun(stored);
      if (problem !== null) return problem;

      const artifacts = await store.loadArtifacts(runId);
      for (const artifact of artifacts) {
        const fault = admitArtifact(artifact, runId);
        if (fault !== null) return fault;
      }

      if (artifacts.length !== stored.artifactCount) {
        return refuse(
          'CorruptRecord',
          `Run '${runId}' has artifacts this build cannot trust.`,
          Object.freeze([
            {
              field: 'run.artifactCount',
              code: 'COUNT_MISMATCH',
              detail: `The run records ${String(stored.artifactCount)} artifact(s); the store returned ${String(artifacts.length)}.`,
            },
          ]),
        );
      }

      const views = Object.freeze(
        [...artifacts]
          .sort((left, right) => left.sequence - right.sequence)
          .map(toArtifactHistoryView),
      );

      return Object.freeze({
        outcome: 'ok' as const,
        artifacts: views,
        usage: summariseUsage(views),
      });
    },

    listByWorkflow(workflowId: string, query: RunHistoryQuery = {}): Promise<RunHistoryResult> {
      const asked = query.filter?.workflowId;
      if (asked !== undefined && asked !== workflowId) {
        // Two workflows named in one query. Honouring either silently would
        // answer a question the caller did not ask.
        return Promise.resolve(
          refuse('InvalidFilter', 'The query cannot be run as asked.', [
            {
              field: 'filter.workflowId',
              code: 'CONTRADICTORY',
              detail: `The listing is for '${workflowId}' and the filter names '${asked}'.`,
            },
          ]),
        );
      }

      return list({ ...query, filter: { ...query.filter, workflowId } });
    },
  };
}
