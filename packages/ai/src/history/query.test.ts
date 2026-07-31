import { describe, expect, it } from 'vitest';

import {
  canonicalFilter,
  DEFAULT_RUN_HISTORY_LIMIT,
  isRunHistoryOrder,
  MAX_RUN_HISTORY_LIMIT,
  RUN_HISTORY_ORDERS,
  validateRunHistoryQuery,
  type ResolvedRunHistoryQuery,
  type RunHistoryQuery,
} from './query.js';

const codesOf = (query: RunHistoryQuery): readonly string[] => {
  const result = validateRunHistoryQuery(query);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

const fieldsOf = (query: RunHistoryQuery): readonly string[] => {
  const result = validateRunHistoryQuery(query);
  return result.ok ? [] : result.issues.map((issue) => issue.field);
};

const resolve = (query: RunHistoryQuery): ResolvedRunHistoryQuery => {
  const result = validateRunHistoryQuery(query);
  if (!result.ok) throw new Error(`expected a valid query: ${result.issues[0]?.code ?? ''}`);
  return result.query;
};

describe('the order vocabulary', () => {
  it('offers newest and oldest, and nothing else', () => {
    expect([...RUN_HISTORY_ORDERS]).toEqual(['newest', 'oldest']);
  });

  it('recognises its own members', () => {
    expect(isRunHistoryOrder('newest')).toBe(true);
    expect(isRunHistoryOrder('NEWEST')).toBe(false);
    expect(isRunHistoryOrder('random')).toBe(false);
  });
});

describe('resolving a query', () => {
  it('defaults to the newest page of the default size, with no cursor', () => {
    expect(resolve({})).toEqual({
      filter: {},
      order: 'newest',
      limit: DEFAULT_RUN_HISTORY_LIMIT,
      cursor: null,
    });
  });

  it('keeps what the caller asked for', () => {
    const resolved = resolve({
      filter: { workspaceId: 'ws-1', statuses: ['completed'] },
      order: 'oldest',
      limit: 5,
      cursor: 'abc',
    });

    expect(resolved.filter.workspaceId).toBe('ws-1');
    expect(resolved.order).toBe('oldest');
    expect(resolved.limit).toBe(5);
    expect(resolved.cursor).toBe('abc');
  });

  it('freezes what it returns', () => {
    const resolved = resolve({ filter: { workflowId: 'article.draft' } });

    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.filter)).toBe(true);
  });
});

describe('every filter dimension the increment names', () => {
  it('accepts each one on its own', () => {
    for (const filter of [
      { organizationId: 'org-1' },
      { workspaceId: 'ws-1' },
      { principalId: 'user-1' },
      { workflowId: 'article.draft' },
      { statuses: ['completed'] as const },
      { createdAfter: '2026-07-01T00:00:00.000Z' },
      { createdBefore: '2026-08-01T00:00:00.000Z' },
    ]) {
      expect(validateRunHistoryQuery({ filter }).ok).toBe(true);
    }
  });

  it('accepts all of them together', () => {
    expect(
      validateRunHistoryQuery({
        filter: {
          organizationId: 'org-1',
          workspaceId: 'ws-1',
          principalId: 'user-1',
          workflowId: 'article.draft',
          statuses: ['completed', 'failed'],
          createdAfter: '2026-07-01T00:00:00.000Z',
          createdBefore: '2026-08-01T00:00:00.000Z',
        },
      }).ok,
    ).toBe(true);
  });
});

describe('refusing a filter rather than ignoring it', () => {
  it('refuses a present-but-empty id', () => {
    // Omitted and empty mean opposite things; treating one as the other is how
    // a caller that asked for one workspace receives every workspace's runs.
    expect(codesOf({ filter: { workspaceId: '   ' } })).toContain('BLANK');
  });

  it('names which filter was wrong', () => {
    expect(fieldsOf({ filter: { principalId: '' } })).toContain('filter.principalId');
  });

  it('refuses an empty status set', () => {
    // It matches nothing, and an empty page reads as "there are no runs".
    expect(codesOf({ filter: { statuses: [] } })).toContain('EMPTY');
  });

  it('refuses a status nothing recognises', () => {
    expect(codesOf({ filter: { statuses: ['paused' as unknown as 'completed'] } })).toContain(
      'UNKNOWN_STATUS',
    );
  });

  it('refuses a repeated status', () => {
    expect(codesOf({ filter: { statuses: ['completed', 'completed'] } })).toContain('DUPLICATE');
  });

  it('refuses a timestamp that is not ISO', () => {
    expect(codesOf({ filter: { createdAfter: 'last tuesday' } })).toContain('BAD_TIMESTAMP');
  });

  it('refuses a window that selects no time at all', () => {
    expect(
      codesOf({
        filter: {
          createdAfter: '2026-08-01T00:00:00.000Z',
          createdBefore: '2026-07-01T00:00:00.000Z',
        },
      }),
    ).toContain('EMPTY_WINDOW');
  });

  it('refuses equal bounds, because the window is half-open', () => {
    expect(
      codesOf({
        filter: {
          createdAfter: '2026-07-01T00:00:00.000Z',
          createdBefore: '2026-07-01T00:00:00.000Z',
        },
      }),
    ).toContain('EMPTY_WINDOW');
  });

  it('accepts a window one millisecond wide', () => {
    expect(
      validateRunHistoryQuery({
        filter: {
          createdAfter: '2026-07-01T00:00:00.000Z',
          createdBefore: '2026-07-01T00:00:00.001Z',
        },
      }).ok,
    ).toBe(true);
  });

  it('refuses an order it does not have', () => {
    expect(codesOf({ order: 'random' as 'newest' })).toContain('UNKNOWN_ORDER');
  });

  it('refuses a page size outside its bounds rather than clamping', () => {
    // Clamping silently would make a caller's page size a suggestion, and a
    // cursor issued for one size and read with another is how a page vanishes.
    expect(codesOf({ limit: 0 })).toContain('OUT_OF_RANGE');
    expect(codesOf({ limit: -1 })).toContain('OUT_OF_RANGE');
    expect(codesOf({ limit: 1.5 })).toContain('OUT_OF_RANGE');
    expect(codesOf({ limit: MAX_RUN_HISTORY_LIMIT + 1 })).toContain('OUT_OF_RANGE');
  });

  it('accepts the bounds themselves', () => {
    expect(validateRunHistoryQuery({ limit: 1 }).ok).toBe(true);
    expect(validateRunHistoryQuery({ limit: MAX_RUN_HISTORY_LIMIT }).ok).toBe(true);
  });

  it('refuses a present-but-empty cursor', () => {
    expect(codesOf({ cursor: '' })).toContain('BLANK');
  });

  it('reports every issue, not the first', () => {
    const result = validateRunHistoryQuery({
      filter: { workspaceId: '', statuses: [] },
      limit: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the canonical form of a query', () => {
  it('is stable for the same query', () => {
    const query = { filter: { workspaceId: 'ws-1', statuses: ['completed'] as const } };
    expect(canonicalFilter(resolve(query))).toBe(canonicalFilter(resolve(query)));
  });

  it('does not depend on the order the statuses were written in', () => {
    expect(canonicalFilter(resolve({ filter: { statuses: ['failed', 'completed'] } }))).toBe(
      canonicalFilter(resolve({ filter: { statuses: ['completed', 'failed'] } })),
    );
  });

  it('differs when any dimension differs', () => {
    const base = canonicalFilter(resolve({}));

    for (const query of [
      { filter: { organizationId: 'org-1' } },
      { filter: { workspaceId: 'ws-1' } },
      { filter: { principalId: 'user-1' } },
      { filter: { workflowId: 'article.draft' } },
      { filter: { statuses: ['completed'] as const } },
      { filter: { createdAfter: '2026-07-01T00:00:00.000Z' } },
      { filter: { createdBefore: '2026-08-01T00:00:00.000Z' } },
      { order: 'oldest' as const },
    ]) {
      expect(canonicalFilter(resolve(query))).not.toBe(base);
    }
  });

  it('never confuses one dimension for another', () => {
    // 'org-1' in `organizationId` and 'org-1' in `workspaceId` are different
    // queries, and a canonical form that concatenated values would say they are
    // the same.
    expect(canonicalFilter(resolve({ filter: { organizationId: 'a' } }))).not.toBe(
      canonicalFilter(resolve({ filter: { workspaceId: 'a' } })),
    );
  });

  it('does not depend on the page size, which does not change the sequence', () => {
    expect(canonicalFilter(resolve({ limit: 5 }))).toBe(canonicalFilter(resolve({ limit: 50 })));
  });
});
