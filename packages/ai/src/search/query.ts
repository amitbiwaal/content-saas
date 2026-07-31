/**
 * What a caller asks search for.
 *
 * ── One filter shape, three things to search ───────────────────────────────
 * Runs, drafts and artifacts are different records, and not every dimension
 * means something for all three: a run has no tags, an artifact has no draft.
 * Rather than three near-identical filter types, there is one, and each kind
 * declares which dimensions it supports.
 *
 * A dimension a kind cannot honour is REFUSED. That is the whole point: a
 * caller that filtered by tag and received every run in the workspace has been
 * handed a result that looks correct and answers a different question. A
 * refusal is a bug report; a dropped filter is a leak wearing a success.
 *
 * ── Statuses are checked against the vocabulary of what is being searched ──
 * A run is `completed`; a draft is `ready`. Both are statuses, and neither is
 * the other's. Which are valid depends on the kind, and an unknown one is
 * refused rather than treated as "match nothing".
 *
 * ── Nothing here reads a store ─────────────────────────────────────────────
 * A query is a value. This module validates and canonicalises it and stops.
 */

import { isDraftStatus, DRAFT_STATUSES } from '../drafts/status.js';
import { isRunStatus, RUN_STATUSES } from '../runs/state.js';
import type { StoredRecordIssue } from '../runs/stored.js';
import type { RunHistoryCursor } from '../history/cursor.js';
import {
  DEFAULT_RUN_HISTORY_LIMIT,
  MAX_RUN_HISTORY_LIMIT,
  RUN_HISTORY_ORDERS,
  type RunHistoryOrder,
} from '../history/query.js';

/**
 * The cursor a search hands back.
 *
 * The FROZEN history cursor, not a second format: a cursor is the thing that
 * crosses a wire, and two encodings of the same idea would be two things to
 * validate, version and get wrong.
 */
export type SearchCursor = RunHistoryCursor;

export const SEARCH_KINDS = ['runs', 'drafts', 'artifacts'] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export function isSearchKind(value: unknown): value is SearchKind {
  return typeof value === 'string' && (SEARCH_KINDS as readonly string[]).includes(value);
}

/** Ordering and page bounds are history's, reused rather than restated. */
export const SEARCH_ORDERS = RUN_HISTORY_ORDERS;
export const DEFAULT_SEARCH_LIMIT = DEFAULT_RUN_HISTORY_LIMIT;
export const MAX_SEARCH_LIMIT = MAX_RUN_HISTORY_LIMIT;

export type SearchOrder = RunHistoryOrder;

/**
 * Every dimension search knows about.
 *
 * All optional; an absent field means "do not narrow by this". A field that is
 * PRESENT and empty is a caller bug, and is refused rather than treated as
 * absent — the two mean opposite things.
 */
export interface ContentSearchFilter {
  readonly organizationId?: string;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId?: string;
  /** Who made it. Identity, never authority — that is all any of these store. */
  readonly principalId?: string;
  readonly workflowId?: string;
  /** Drafts only. A run does not record which draft produced it. */
  readonly draftId?: string;
  /** Runs and artifacts. A draft has never run. */
  readonly runId?: string;
  /** Checked against the vocabulary of whatever is being searched. */
  readonly statuses?: readonly string[];
  /** Inclusive. The record's own clock, never a row's. */
  readonly createdAfter?: string;
  /** Exclusive, so two adjacent windows never count one thing twice. */
  readonly createdBefore?: string;
  /** Drafts only. Every named tag must be present — narrowing, not widening. */
  readonly tags?: readonly string[];
}

export interface ContentSearchQuery {
  readonly filter?: ContentSearchFilter;
  readonly order?: SearchOrder;
  readonly limit?: number;
  /** Opaque. Produced by a previous page and never built by a caller. */
  readonly cursor?: string;
}

/** The query with every default applied. What the service actually runs. */
export interface ResolvedSearchQuery {
  readonly kind: SearchKind;
  readonly filter: ContentSearchFilter;
  readonly order: SearchOrder;
  readonly limit: number;
  readonly cursor: string | null;
}

export type SearchQueryValidation =
  | { readonly ok: true; readonly query: ResolvedSearchQuery }
  | { readonly ok: false; readonly issues: readonly StoredRecordIssue[] };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const ID_FIELDS = [
  'organizationId',
  'workspaceId',
  'principalId',
  'workflowId',
  'draftId',
  'runId',
] as const;

/**
 * Which dimensions each kind can honour.
 *
 * Declared as data so the answer is one table a reader can see, rather than a
 * condition spread across three code paths that can disagree.
 */
type FilterField = keyof ContentSearchFilter;

export const SUPPORTED_FILTERS: Readonly<Record<SearchKind, readonly FilterField[]>> =
  Object.freeze({
    runs: Object.freeze<FilterField[]>([
      'organizationId',
      'workspaceId',
      'principalId',
      'workflowId',
      'runId',
      'statuses',
      'createdAfter',
      'createdBefore',
    ]),
    drafts: Object.freeze<FilterField[]>([
      'organizationId',
      'workspaceId',
      'principalId',
      'workflowId',
      'draftId',
      'statuses',
      'createdAfter',
      'createdBefore',
      'tags',
    ]),
    // An artifact belongs to a run, so it narrows by everything a run does —
    // including the run's status. It has no tags and no draft of its own.
    artifacts: Object.freeze<FilterField[]>([
      'organizationId',
      'workspaceId',
      'principalId',
      'workflowId',
      'runId',
      'statuses',
      'createdAfter',
      'createdBefore',
    ]),
  });

/** The status vocabulary each kind is filtered by. */
const STATUSES_OF: Readonly<Record<SearchKind, readonly string[]>> = Object.freeze({
  runs: RUN_STATUSES,
  drafts: DRAFT_STATUSES,
  artifacts: RUN_STATUSES,
});

const isKnownStatus = (kind: SearchKind, status: string): boolean =>
  kind === 'drafts' ? isDraftStatus(status) : isRunStatus(status);

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Check a query for one kind, and resolve its defaults.
 *
 * One pass rather than two, for the reason the history validator gives: a
 * caller has one question — "will this run?" — and a validator that answers it
 * without producing the thing that runs invites the defaults to be applied
 * twice, differently.
 */
export function validateSearchQuery(
  kind: SearchKind,
  query: ContentSearchQuery,
): SearchQueryValidation {
  const issues: StoredRecordIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push({ field, code, detail });
  };

  const filter = query.filter ?? {};
  const supported = SUPPORTED_FILTERS[kind];

  // ── Dimensions this kind cannot honour ───────────────────────────────────
  for (const field of Object.keys(filter) as (keyof ContentSearchFilter)[]) {
    if (filter[field] === undefined) continue;
    if (!supported.includes(field)) {
      add(
        `filter.${field}`,
        'UNSUPPORTED_FILTER',
        `A ${kind} search cannot narrow by '${String(field)}'. Refused rather than ignored: a result that quietly answered a different question would look correct.`,
      );
    }
  }

  for (const field of ID_FIELDS) {
    const value = filter[field];
    if (value !== undefined && isBlank(value)) {
      add(
        `filter.${field}`,
        'BLANK',
        `'${String(field)}' is present and empty. Omit it to match everything; an empty one matches nothing, which is not what a caller ever means.`,
      );
    }
  }

  if (filter.statuses !== undefined && supported.includes('statuses')) {
    if (filter.statuses.length === 0) {
      add(
        'filter.statuses',
        'EMPTY',
        'An empty status set matches nothing, and an empty page reads as "there is nothing here". Omit the filter to match every status.',
      );
    }
    const seen = new Set<string>();
    for (const status of filter.statuses) {
      if (!isKnownStatus(kind, status)) {
        add(
          'filter.statuses',
          'UNKNOWN_STATUS',
          `'${String(status)}' is not a ${kind === 'drafts' ? 'draft' : 'run'} status. Available: ${STATUSES_OF[kind].join(', ')}.`,
        );
      }
      if (seen.has(status)) {
        add('filter.statuses', 'DUPLICATE', `'${status}' appears more than once.`);
      }
      seen.add(status);
    }
  }

  if (filter.tags !== undefined && supported.includes('tags')) {
    if (filter.tags.length === 0) {
      add('filter.tags', 'EMPTY', 'An empty tag set matches nothing. Omit the filter instead.');
    }
    for (const tag of filter.tags) {
      if (isBlank(tag)) add('filter.tags', 'BLANK', 'A tag is present and empty.');
    }
  }

  for (const field of ['createdAfter', 'createdBefore'] as const) {
    const value = filter[field];
    if (value !== undefined && (typeof value !== 'string' || !ISO.test(value))) {
      add(`filter.${field}`, 'BAD_TIMESTAMP', `'${String(value)}' is not an ISO timestamp.`);
    }
  }

  const { createdAfter, createdBefore } = filter;
  if (
    typeof createdAfter === 'string' &&
    typeof createdBefore === 'string' &&
    ISO.test(createdAfter) &&
    ISO.test(createdBefore) &&
    createdAfter >= createdBefore
  ) {
    // Half-open [after, before): equal bounds select no time at all, and a
    // reversed pair is one the caller built backwards.
    add(
      'filter.createdBefore',
      'EMPTY_WINDOW',
      `'${createdAfter}' to '${createdBefore}' selects no time at all; the window is [createdAfter, createdBefore).`,
    );
  }

  if (query.order !== undefined && !(SEARCH_ORDERS as readonly string[]).includes(query.order)) {
    add(
      'order',
      'UNKNOWN_ORDER',
      `'${String(query.order)}' is not an order. Available: ${SEARCH_ORDERS.join(', ')}.`,
    );
  }

  const limit = query.limit ?? DEFAULT_SEARCH_LIMIT;
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_SEARCH_LIMIT)
  ) {
    // Clamping silently would make a caller's page size a suggestion, and a
    // cursor issued for one size read with another is how a page goes missing.
    add(
      'limit',
      'OUT_OF_RANGE',
      `'${String(query.limit)}' is not a page size between 1 and ${String(MAX_SEARCH_LIMIT)}.`,
    );
  }

  if (query.cursor !== undefined && isBlank(query.cursor)) {
    add('cursor', 'BLANK', 'A cursor is present and empty; omit it to ask for the first page.');
  }

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };

  return {
    ok: true,
    query: Object.freeze({
      kind,
      filter: Object.freeze({ ...filter }),
      order: query.order ?? 'newest',
      limit,
      cursor: query.cursor ?? null,
    }),
  };
}

/**
 * The query, as one canonical string.
 *
 * Every dimension in a fixed order, the KIND included — so a cursor issued for
 * a draft search can never be read back on an artifact search. Two queries that
 * mean the same thing produce the same string; two that differ never collide.
 */
export function canonicalSearch(query: ResolvedSearchQuery): string {
  const { filter } = query;
  return [
    `kind=${query.kind}`,
    `order=${query.order}`,
    ...ID_FIELDS.map((field) => `${field}=${filter[field] ?? ''}`),
    `statuses=${filter.statuses === undefined ? '' : [...filter.statuses].sort().join(',')}`,
    `tags=${filter.tags === undefined ? '' : [...filter.tags].sort().join(',')}`,
    `after=${filter.createdAfter ?? ''}`,
    `before=${filter.createdBefore ?? ''}`,
  ].join('&');
}
