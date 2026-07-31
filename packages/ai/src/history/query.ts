/**
 * What a caller asks history for.
 *
 * ── Every filter is checked, and none is ever ignored ──────────────────────
 * A filter that cannot be honoured is REFUSED, never dropped. Silently ignoring
 * one is the worst failure this layer can have: a caller that asked for one
 * workspace and received every workspace's runs has been handed a tenancy
 * breach that looks like a successful response. A refusal is a bug report; a
 * dropped filter is a leak.
 *
 * ── Contradictions are refused too ─────────────────────────────────────────
 * An empty time window, an empty status set, a blank id — each is a query that
 * can only ever return nothing, and returning nothing looks exactly like "there
 * are no runs". The caller almost always built the query wrong, and an empty
 * page tells them the opposite.
 *
 * ── Ordering is total, which is what makes paging correct ──────────────────
 * `createdAt` alone is not a key: two runs started in the same millisecond
 * would have no defined order, and a cursor pointing at one of them could skip
 * or repeat the other. The order is (createdAt, runId), and `runId` is unique,
 * so the sequence is total and a keyset cursor addresses exactly one position.
 *
 * ── It is the RUN's clock that is filtered ─────────────────────────────────
 * `createdAt` here means when the run was created, not when its row was
 * written. The record's own timestamps are persistence metadata and never
 * appear in this layer at all.
 */

import { isRunStatus, type RunStatus } from '../runs/state.js';
import type { StoredRecordIssue } from '../runs/stored.js';

/** Newest first by default: a history view is read from the top. */
export const RUN_HISTORY_ORDERS = ['newest', 'oldest'] as const;

export type RunHistoryOrder = (typeof RUN_HISTORY_ORDERS)[number];

export function isRunHistoryOrder(value: unknown): value is RunHistoryOrder {
  return typeof value === 'string' && (RUN_HISTORY_ORDERS as readonly string[]).includes(value);
}

export const DEFAULT_RUN_HISTORY_LIMIT = 25;

/**
 * The most a single page may hold.
 *
 * A bound, not a suggestion. Without one, a caller asking for a million runs
 * makes one query the whole store's problem, and the failure arrives as a
 * timeout somewhere unrelated.
 */
export const MAX_RUN_HISTORY_LIMIT = 100;

/**
 * What to narrow by.
 *
 * Every field is optional, and an absent field means "do not narrow by this".
 * A field that is PRESENT and empty is a caller bug, and is refused rather
 * than treated as absent — the two mean opposite things.
 */
export interface RunHistoryFilter {
  readonly organizationId?: string;
  /** The workspace IS the tenant (ADR-017). */
  readonly workspaceId?: string;
  /** Who ran it. Identity, never authority — that is all history stores. */
  readonly principalId?: string;
  readonly workflowId?: string;
  /** Any of these. An empty array is a contradiction, not "any status". */
  readonly statuses?: readonly RunStatus[];
  /** Inclusive. The run's own clock. */
  readonly createdAfter?: string;
  /** Exclusive, so two adjacent windows never count one run twice. */
  readonly createdBefore?: string;
}

export interface RunHistoryQuery {
  readonly filter?: RunHistoryFilter;
  readonly order?: RunHistoryOrder;
  readonly limit?: number;
  /** Opaque. Produced by a previous page and never built by a caller. */
  readonly cursor?: string;
}

/** The query with every default applied. What the service actually runs. */
export interface ResolvedRunHistoryQuery {
  readonly filter: RunHistoryFilter;
  readonly order: RunHistoryOrder;
  readonly limit: number;
  readonly cursor: string | null;
}

export type RunHistoryQueryValidation =
  | { readonly ok: true; readonly query: ResolvedRunHistoryQuery }
  | { readonly ok: false; readonly issues: readonly StoredRecordIssue[] };

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const ID_FIELDS = ['organizationId', 'workspaceId', 'principalId', 'workflowId'] as const;

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Check a query, and resolve its defaults.
 *
 * One pass rather than two, because a caller has one question — "will this
 * run?" — and a validator that answers it without producing the thing that
 * runs invites the defaults to be applied twice, differently.
 */
export function validateRunHistoryQuery(query: RunHistoryQuery): RunHistoryQueryValidation {
  const issues: StoredRecordIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push({ field, code, detail });
  };

  const filter = query.filter ?? {};

  for (const field of ID_FIELDS) {
    const value = filter[field];
    if (value !== undefined && isBlank(value)) {
      add(
        `filter.${field}`,
        'BLANK',
        `'${field}' is present and empty. Omit it to match every ${field.replace(/Id$/, '')}; an empty one matches nothing, which is not what a caller ever means.`,
      );
    }
  }

  if (filter.statuses !== undefined) {
    if (filter.statuses.length === 0) {
      add(
        'filter.statuses',
        'EMPTY',
        'An empty status set matches nothing, and an empty page reads as "there are no runs". Omit the filter to match every status.',
      );
    }
    const seen = new Set<string>();
    for (const status of filter.statuses) {
      if (!isRunStatus(status)) {
        add(
          'filter.statuses',
          'UNKNOWN_STATUS',
          `'${String(status)}' is not a run status. Refused rather than dropped: a query narrowed by a status nobody recognises would silently widen.`,
        );
      }
      if (seen.has(status)) {
        add('filter.statuses', 'DUPLICATE', `'${status}' appears more than once.`);
      }
      seen.add(status);
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
    // Half-open [after, before): equal bounds are an empty window, and a
    // reversed pair is one the caller built backwards.
    add(
      'filter.createdBefore',
      'EMPTY_WINDOW',
      `'${createdAfter}' to '${createdBefore}' selects no time at all; the window is [createdAfter, createdBefore).`,
    );
  }

  if (query.order !== undefined && !isRunHistoryOrder(query.order)) {
    add(
      'order',
      'UNKNOWN_ORDER',
      `'${String(query.order)}' is not an order. Available: ${RUN_HISTORY_ORDERS.join(', ')}.`,
    );
  }

  const limit = query.limit ?? DEFAULT_RUN_HISTORY_LIMIT;
  if (
    query.limit !== undefined &&
    (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_RUN_HISTORY_LIMIT)
  ) {
    // Clamping silently would make a caller's page size a suggestion, and a
    // cursor issued for one size read with another is how a page goes missing.
    add(
      'limit',
      'OUT_OF_RANGE',
      `'${String(query.limit)}' is not a page size between 1 and ${String(MAX_RUN_HISTORY_LIMIT)}.`,
    );
  }

  if (query.cursor !== undefined && isBlank(query.cursor)) {
    add('cursor', 'BLANK', 'A cursor is present and empty; omit it to ask for the first page.');
  }

  if (issues.length > 0) return { ok: false, issues: Object.freeze(issues) };

  return {
    ok: true,
    query: Object.freeze({
      filter: Object.freeze({ ...filter }),
      order: query.order ?? 'newest',
      limit,
      cursor: query.cursor ?? null,
    }),
  };
}

/**
 * The filter, as one canonical string.
 *
 * Every field in a fixed order, absent ones marked — so two filters that mean
 * the same thing produce the same string and two that differ never collide.
 * This is what a cursor is fingerprinted against.
 */
export function canonicalFilter(query: ResolvedRunHistoryQuery): string {
  const { filter } = query;
  const parts = [
    `order=${query.order}`,
    ...ID_FIELDS.map((field) => `${field}=${filter[field] ?? ''}`),
    `statuses=${filter.statuses === undefined ? '' : [...filter.statuses].sort().join(',')}`,
    `after=${filter.createdAfter ?? ''}`,
    `before=${filter.createdBefore ?? ''}`,
  ];
  return parts.join('&');
}
