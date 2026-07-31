/**
 * Content search — one read model over runs, drafts and artifacts.
 *
 *   query → validate for the kind → keyset criteria → store → hits
 *
 * ── It reads, and only reads ───────────────────────────────────────────────
 * No provider, no runtime, no orchestrator, no draft service write path. There
 * is no `saveRun`, `saveDraft`, `updateDraft`, `updateStatus` or `deleteDraft`
 * call anywhere in this module: search discovers what exists and changes none
 * of it.
 *
 * ── Runs are not searched here. They are searched by HISTORY ───────────────
 * `searchRuns` maps a search query onto a `RunHistoryQuery` and hands it to the
 * S4.5 service, then projects what comes back. Every filter, every record
 * check, the ordering and the paging are history's, unchanged — which is what
 * "no duplicate query logic" has to mean if it means anything. What search adds
 * is the OTHER two kinds and one vocabulary across all three.
 *
 * ── Drafts and artifacts share one pager, on the FROZEN cursor ─────────────
 * Neither had keyset paging before. Both get it here from `createCursor` and
 * `decodeCursor` — the same format, the same version, the same fingerprint
 * scheme history issues. There is no second cursor anywhere in this package.
 *
 * ── Ordering is enforced, not assumed ──────────────────────────────────────
 * Every slice is sorted before it is paged, whatever order the store returned
 * it in. Cursor paging is only correct over a total order, and a store that
 * returned rows unordered would otherwise produce pages that skip and repeat
 * while looking entirely normal.
 *
 * ── No offset, anywhere ────────────────────────────────────────────────────
 * There is no `offset`, no page number and no `skip` in this module.
 */

import type { Page } from '@contentos/contracts';

import type { ContentDraft } from '../drafts/draft.js';
import type { DraftStatus } from '../drafts/status.js';
import { createCursor, decodeCursor, encodeCursor } from '../history/cursor.js';
import type { RunHistoryFilter, RunHistoryQuery } from '../history/query.js';
import { createRunHistory, RUN_HISTORY_CODES } from '../history/service.js';
import { toArtifactHistoryView } from '../history/views.js';
import type { RunStatus } from '../runs/state.js';
import {
  isSupportedSchemaVersion,
  validateStoredArtifact,
  type StoredArtifact,
  type StoredRecordIssue,
} from '../runs/stored.js';
import { artifactHit, draftHit, runHit, type SearchHit } from './hits.js';
import {
  canonicalSearch,
  validateSearchQuery,
  type ContentSearchQuery,
  type ResolvedSearchQuery,
  type SearchKind,
} from './query.js';
import type { ArtifactSearchPosition, ContentSearchStore, DraftSearchPosition } from './store.js';

/**
 * Why a search was refused.
 *
 * History's codes, spread in rather than restated, plus the one thing only
 * search can refuse: a dimension the kind being searched cannot honour.
 */
export const SEARCH_CODES = [...RUN_HISTORY_CODES, 'UnsupportedFilter', 'UnknownDraft'] as const;

export type SearchCode = (typeof SEARCH_CODES)[number];

export function isSearchCode(value: unknown): value is SearchCode {
  return typeof value === 'string' && (SEARCH_CODES as readonly string[]).includes(value);
}

export interface SearchRefusal {
  readonly outcome: 'refused';
  readonly code: SearchCode;
  /** For operators. Never returned to a caller — see `ai/http.ts`. */
  readonly reason: string;
  readonly issues: readonly StoredRecordIssue[];
}

/** One page of results. The platform's `Page<T>`, not a second shape. */
export type SearchPage = Page<SearchHit>;

export type SearchResult = { readonly outcome: 'ok'; readonly page: SearchPage } | SearchRefusal;

export interface ContentSearchService {
  searchRuns(query?: ContentSearchQuery): Promise<SearchResult>;
  searchDrafts(query?: ContentSearchQuery): Promise<SearchResult>;
  searchArtifacts(query?: ContentSearchQuery): Promise<SearchResult>;
}

export interface ContentSearchOptions {
  readonly store: ContentSearchStore;
}

const refuse = (
  code: SearchCode,
  reason: string,
  issues: readonly StoredRecordIssue[] = [],
): SearchRefusal => Object.freeze({ outcome: 'refused' as const, code, reason, issues });

const page = (items: readonly SearchHit[], nextCursor: string | null): SearchResult =>
  Object.freeze({
    outcome: 'ok' as const,
    page: Object.freeze({
      items: Object.freeze([...items]),
      nextCursor,
      hasMore: nextCursor !== null,
    }),
  });

/**
 * An artifact's position, as the two fields a cursor carries.
 *
 * The frozen cursor names a position with an ordering key and a tiebreak. For a
 * run the tiebreak is its id; for an artifact it is the run id AND the step
 * index, because one run holds several. Packing them into the one field keeps
 * the cursor format single — see the module header.
 */
const packArtifact = (runId: string, sequence: number): string => `${runId}#${String(sequence)}`;

function unpackArtifact(packed: string): { runId: string; sequence: number } | null {
  const at = packed.lastIndexOf('#');
  if (at <= 0) return null;
  const sequence = Number(packed.slice(at + 1));
  if (!Number.isInteger(sequence) || sequence < 0) return null;
  return { runId: packed.slice(0, at), sequence };
}

/** One comparison, used by both pagers. Total, so paging is exact. */
function ascending(leftKey: string, leftTie: string, rightKey: string, rightTie: string): number {
  if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
  if (leftTie !== rightTie) return leftTie < rightTie ? -1 : 1;
  return 0;
}

export function createContentSearch(options: ContentSearchOptions): ContentSearchService {
  const { store } = options;
  // The S4.5 service, over the same store. Run search IS history search.
  const history = createRunHistory({ store });

  function resolved(
    kind: SearchKind,
    query: ContentSearchQuery,
  ): ResolvedSearchQuery | SearchRefusal {
    const validation = validateSearchQuery(kind, query);
    if (validation.ok) return validation.query;

    // A dimension the kind cannot honour gets its own code: it is a different
    // mistake from a malformed value, and a caller fixes it differently.
    const unsupported = validation.issues.some((issue) => issue.code === 'UNSUPPORTED_FILTER');
    return refuse(
      unsupported ? 'UnsupportedFilter' : 'InvalidFilter',
      'The search cannot be run as asked.',
      validation.issues,
    );
  }

  /** Read the cursor a caller handed back, against the query it arrived with. */
  function position(
    query: ResolvedSearchQuery,
  ): { key: string; tie: string } | null | SearchRefusal {
    if (query.cursor === null) return null;
    const decoded = decodeCursor(query.cursor, canonicalSearch(query));
    if (decoded.outcome === 'refused') return refuse(decoded.code, decoded.reason);
    return { key: decoded.cursor.createdAt, tie: decoded.cursor.runId };
  }

  const nextCursorFor = (query: ResolvedSearchQuery, key: string, tie: string): string =>
    encodeCursor(createCursor({ createdAt: key, runId: tie, canonical: canonicalSearch(query) }));

  return {
    // ── Runs: history's query, projected ─────────────────────────────────
    async searchRuns(input: ContentSearchQuery = {}): Promise<SearchResult> {
      const query = resolved('runs', input);
      if ('outcome' in query) return query;

      const { filter } = query;

      // A search naming one run is a lookup. Answered through the frozen
      // by-id contract rather than by asking a query engine for one row.
      if (filter.runId !== undefined) {
        const found = await history.getRunById(filter.runId);
        if (found.outcome === 'refused') return refuse(found.code, found.reason, found.issues);
        return page([runHit(found.run)], null);
      }

      const historyFilter: RunHistoryFilter = {
        ...(filter.organizationId === undefined ? {} : { organizationId: filter.organizationId }),
        ...(filter.workspaceId === undefined ? {} : { workspaceId: filter.workspaceId }),
        ...(filter.principalId === undefined ? {} : { principalId: filter.principalId }),
        ...(filter.workflowId === undefined ? {} : { workflowId: filter.workflowId }),
        ...(filter.statuses === undefined
          ? {}
          : { statuses: filter.statuses as readonly RunStatus[] }),
        ...(filter.createdAfter === undefined ? {} : { createdAfter: filter.createdAfter }),
        ...(filter.createdBefore === undefined ? {} : { createdBefore: filter.createdBefore }),
      };

      const historyQuery: RunHistoryQuery = {
        filter: historyFilter,
        order: query.order,
        limit: query.limit,
        ...(query.cursor === null ? {} : { cursor: query.cursor }),
      };

      const result = await history.listRuns(historyQuery);
      if (result.outcome === 'refused') {
        return refuse(result.code, result.reason, result.issues);
      }

      return page(result.page.items.map(runHit), result.page.nextCursor);
    },

    // ── Drafts ───────────────────────────────────────────────────────────
    async searchDrafts(input: ContentSearchQuery = {}): Promise<SearchResult> {
      const query = resolved('drafts', input);
      if ('outcome' in query) return query;

      const at = position(query);
      if (at !== null && 'outcome' in at) return at;

      const { filter } = query;
      const after: DraftSearchPosition | null =
        at === null ? null : { updatedAt: at.key, draftId: at.tie };

      const slice = await store.queryDrafts({
        organizationId: filter.organizationId ?? null,
        workspaceId: filter.workspaceId ?? null,
        principalId: filter.principalId ?? null,
        workflowId: filter.workflowId ?? null,
        draftId: filter.draftId ?? null,
        statuses:
          filter.statuses === undefined
            ? null
            : Object.freeze([...(filter.statuses as readonly DraftStatus[])]),
        tags: filter.tags === undefined ? null : Object.freeze([...filter.tags]),
        createdAfter: filter.createdAfter ?? null,
        createdBefore: filter.createdBefore ?? null,
        after,
        order: query.order,
        // One more than the page, which is how `hasMore` is learned without a
        // second query and without a count.
        limit: query.limit + 1,
      });

      // Enforced, not assumed. A draft's ordering key is when it last changed.
      const ordered = [...slice.drafts].sort((left, right) => {
        const value = ascending(left.updatedAt, left.draftId, right.updatedAt, right.draftId);
        return query.order === 'newest' ? -value : value;
      });

      const kept = ordered.slice(0, query.limit);
      const last: ContentDraft | undefined = kept[kept.length - 1];

      return page(
        kept.map(draftHit),
        ordered.length > query.limit && last !== undefined
          ? nextCursorFor(query, last.updatedAt, last.draftId)
          : null,
      );
    },

    // ── Artifacts ────────────────────────────────────────────────────────
    async searchArtifacts(input: ContentSearchQuery = {}): Promise<SearchResult> {
      const query = resolved('artifacts', input);
      if ('outcome' in query) return query;

      const at = position(query);
      if (at !== null && 'outcome' in at) return at;

      let after: ArtifactSearchPosition | null = null;
      if (at !== null) {
        const unpacked = unpackArtifact(at.tie);
        if (unpacked === null) {
          return refuse('InvalidCursor', 'The cursor does not name an artifact position.');
        }
        after = { createdAt: at.key, runId: unpacked.runId, sequence: unpacked.sequence };
      }

      const { filter } = query;
      const slice = await store.queryArtifacts({
        organizationId: filter.organizationId ?? null,
        workspaceId: filter.workspaceId ?? null,
        principalId: filter.principalId ?? null,
        workflowId: filter.workflowId ?? null,
        runId: filter.runId ?? null,
        statuses:
          filter.statuses === undefined
            ? null
            : Object.freeze([...(filter.statuses as readonly RunStatus[])]),
        createdAfter: filter.createdAfter ?? null,
        createdBefore: filter.createdBefore ?? null,
        after,
        order: query.order,
        limit: query.limit + 1,
      });

      // Nothing loaded is trusted. The same validators the persistence layer
      // ships, in the same order — schema first, so a record from a newer build
      // does not read as corruption.
      const issues: StoredRecordIssue[] = [];
      for (const artifact of slice.artifacts) {
        if (!isSupportedSchemaVersion(artifact.schemaVersion)) {
          return refuse(
            'IncompatibleSchema',
            `An artifact of run '${artifact.runId}' is at schema version ${String(artifact.schemaVersion)}, which this build does not read.`,
          );
        }
        const validation = validateStoredArtifact(artifact, artifact.runId);
        if (!validation.ok) issues.push(...validation.issues);
      }
      if (issues.length > 0) {
        // One corrupt record refuses the PAGE. Skipping it would hand back a
        // page that looks complete and is not.
        return refuse(
          'CorruptRecord',
          'The page holds an artifact this build cannot trust.',
          Object.freeze(issues),
        );
      }

      const clockOf = (artifact: StoredArtifact): string =>
        slice.runCreatedAt[artifact.runId] ?? artifact.createdAt;

      const ordered = [...slice.artifacts].sort((left, right) => {
        const value = ascending(
          clockOf(left),
          packArtifact(left.runId, left.sequence),
          clockOf(right),
          packArtifact(right.runId, right.sequence),
        );
        return query.order === 'newest' ? -value : value;
      });

      const kept = ordered.slice(0, query.limit);
      const last: StoredArtifact | undefined = kept[kept.length - 1];

      return page(
        kept.map((artifact) => artifactHit(toArtifactHistoryView(artifact))),
        ordered.length > query.limit && last !== undefined
          ? nextCursorFor(query, clockOf(last), packArtifact(last.runId, last.sequence))
          : null,
      );
    },
  };
}
