import { describe, expect, it } from 'vitest';

import { DRAFT_STATUSES } from '../drafts/status.js';
import { RUN_STATUSES } from '../runs/state.js';
import {
  canonicalSearch,
  DEFAULT_SEARCH_LIMIT,
  isSearchKind,
  MAX_SEARCH_LIMIT,
  SEARCH_KINDS,
  SEARCH_ORDERS,
  SUPPORTED_FILTERS,
  validateSearchQuery,
  type ContentSearchQuery,
  type ResolvedSearchQuery,
  type SearchKind,
} from './query.js';

const codesOf = (kind: SearchKind, query: ContentSearchQuery): readonly string[] => {
  const result = validateSearchQuery(kind, query);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

const resolve = (kind: SearchKind, query: ContentSearchQuery = {}): ResolvedSearchQuery => {
  const result = validateSearchQuery(kind, query);
  if (!result.ok) throw new Error(`expected a valid query: ${result.issues[0]?.code ?? ''}`);
  return result.query;
};

describe('the search vocabulary', () => {
  it('searches three things', () => {
    expect([...SEARCH_KINDS]).toEqual(['runs', 'drafts', 'artifacts']);
  });

  it('recognises its own kinds', () => {
    expect(isSearchKind('drafts')).toBe(true);
    expect(isSearchKind('DRAFTS')).toBe(false);
    expect(isSearchKind('templates')).toBe(false);
  });

  it('reuses history’s orders and page bounds rather than restating them', () => {
    expect([...SEARCH_ORDERS]).toEqual(['newest', 'oldest']);
    expect(DEFAULT_SEARCH_LIMIT).toBe(25);
    expect(MAX_SEARCH_LIMIT).toBe(100);
  });
});

describe('resolving a query', () => {
  it('defaults to the newest page of the default size, with no cursor', () => {
    expect(resolve('runs')).toEqual({
      kind: 'runs',
      filter: {},
      order: 'newest',
      limit: DEFAULT_SEARCH_LIMIT,
      cursor: null,
    });
  });

  it('records which kind it is for', () => {
    expect(resolve('drafts').kind).toBe('drafts');
    expect(resolve('artifacts').kind).toBe('artifacts');
  });

  it('freezes what it returns', () => {
    const resolved = resolve('runs', { filter: { workflowId: 'article.draft' } });

    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.filter)).toBe(true);
  });
});

describe('which dimensions each kind supports', () => {
  it('gives runs everything except drafts and tags', () => {
    expect(SUPPORTED_FILTERS.runs).not.toContain('draftId');
    expect(SUPPORTED_FILTERS.runs).not.toContain('tags');
    expect(SUPPORTED_FILTERS.runs).toContain('runId');
  });

  it('gives drafts tags and a draft id, but no run id', () => {
    expect(SUPPORTED_FILTERS.drafts).toContain('tags');
    expect(SUPPORTED_FILTERS.drafts).toContain('draftId');
    expect(SUPPORTED_FILTERS.drafts).not.toContain('runId');
  });

  it('gives artifacts the dimensions of the run they belong to', () => {
    expect(SUPPORTED_FILTERS.artifacts).toContain('runId');
    expect(SUPPORTED_FILTERS.artifacts).toContain('statuses');
    expect(SUPPORTED_FILTERS.artifacts).not.toContain('tags');
    expect(SUPPORTED_FILTERS.artifacts).not.toContain('draftId');
  });

  it('gives every kind the tenancy dimensions', () => {
    for (const kind of SEARCH_KINDS) {
      for (const field of ['organizationId', 'workspaceId', 'principalId', 'workflowId']) {
        expect(SUPPORTED_FILTERS[kind]).toContain(field);
      }
    }
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SUPPORTED_FILTERS)).toBe(true);
    expect(Object.isFrozen(SUPPORTED_FILTERS.runs)).toBe(true);
  });
});

describe('refusing a dimension a kind cannot honour', () => {
  it('refuses tags on a run search', () => {
    // A caller that filtered by tag and got every run in the workspace has a
    // result that looks correct and answers a different question.
    expect(codesOf('runs', { filter: { tags: ['article'] } })).toContain('UNSUPPORTED_FILTER');
  });

  it('refuses a draft id on a run search', () => {
    expect(codesOf('runs', { filter: { draftId: 'draft-1' } })).toContain('UNSUPPORTED_FILTER');
  });

  it('refuses a run id on a draft search', () => {
    expect(codesOf('drafts', { filter: { runId: 'run-1' } })).toContain('UNSUPPORTED_FILTER');
  });

  it('refuses tags on an artifact search', () => {
    expect(codesOf('artifacts', { filter: { tags: ['x'] } })).toContain('UNSUPPORTED_FILTER');
  });

  it('names which dimension it was', () => {
    const result = validateSearchQuery('runs', { filter: { tags: ['x'] } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.field).toBe('filter.tags');
  });

  it('accepts a dimension the kind does support', () => {
    expect(codesOf('drafts', { filter: { tags: ['article'] } })).toEqual([]);
    expect(codesOf('runs', { filter: { runId: 'run-1' } })).toEqual([]);
  });

  it('treats an absent field as no filter at all', () => {
    expect(codesOf('runs', { filter: { tags: undefined } })).toEqual([]);
  });
});

describe('statuses are checked against the right vocabulary', () => {
  it('accepts every run status on a run search', () => {
    for (const status of RUN_STATUSES) {
      expect(codesOf('runs', { filter: { statuses: [status] } })).toEqual([]);
    }
  });

  it('accepts every draft status on a draft search', () => {
    for (const status of DRAFT_STATUSES) {
      expect(codesOf('drafts', { filter: { statuses: [status] } })).toEqual([]);
    }
  });

  it('refuses a draft status on a run search', () => {
    // Both are statuses, and neither is the other's.
    expect(codesOf('runs', { filter: { statuses: ['submitted'] } })).toContain('UNKNOWN_STATUS');
  });

  it('refuses a run status on a draft search', () => {
    expect(codesOf('drafts', { filter: { statuses: ['completed'] } })).toContain('UNKNOWN_STATUS');
  });

  it('checks an artifact search against the RUN vocabulary', () => {
    expect(codesOf('artifacts', { filter: { statuses: ['completed'] } })).toEqual([]);
    // 'ready' is BOTH a run and a draft status; 'submitted' is only a draft's.
    expect(codesOf('artifacts', { filter: { statuses: ['submitted'] } })).toContain(
      'UNKNOWN_STATUS',
    );
  });

  it('says what would have been valid', () => {
    const result = validateSearchQuery('drafts', { filter: { statuses: ['completed'] } });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.detail).toMatch(/draft, ready, submitted, discarded/);
  });

  it('refuses an empty status set', () => {
    expect(codesOf('runs', { filter: { statuses: [] } })).toContain('EMPTY');
  });

  it('refuses a repeated status', () => {
    expect(codesOf('runs', { filter: { statuses: ['completed', 'completed'] } })).toContain(
      'DUPLICATE',
    );
  });
});

describe('refusing the rest', () => {
  it('refuses a present-but-empty id', () => {
    expect(codesOf('runs', { filter: { workspaceId: '   ' } })).toContain('BLANK');
  });

  it('refuses an empty tag set', () => {
    expect(codesOf('drafts', { filter: { tags: [] } })).toContain('EMPTY');
  });

  it('refuses a blank tag', () => {
    expect(codesOf('drafts', { filter: { tags: ['ok', ' '] } })).toContain('BLANK');
  });

  it('refuses a timestamp that is not ISO', () => {
    expect(codesOf('runs', { filter: { createdAfter: 'last tuesday' } })).toContain(
      'BAD_TIMESTAMP',
    );
  });

  it('refuses a window that selects no time at all', () => {
    expect(
      codesOf('runs', {
        filter: {
          createdAfter: '2026-08-01T00:00:00.000Z',
          createdBefore: '2026-07-01T00:00:00.000Z',
        },
      }),
    ).toContain('EMPTY_WINDOW');
  });

  it('refuses equal bounds, because the window is half-open', () => {
    expect(
      codesOf('runs', {
        filter: {
          createdAfter: '2026-07-01T00:00:00.000Z',
          createdBefore: '2026-07-01T00:00:00.000Z',
        },
      }),
    ).toContain('EMPTY_WINDOW');
  });

  it('refuses an order it does not have', () => {
    expect(codesOf('runs', { order: 'random' as 'newest' })).toContain('UNKNOWN_ORDER');
  });

  it('refuses a page size outside its bounds rather than clamping', () => {
    for (const limit of [0, -1, 1.5, MAX_SEARCH_LIMIT + 1]) {
      expect(codesOf('runs', { limit })).toContain('OUT_OF_RANGE');
    }
  });

  it('accepts the bounds themselves', () => {
    expect(validateSearchQuery('runs', { limit: 1 }).ok).toBe(true);
    expect(validateSearchQuery('runs', { limit: MAX_SEARCH_LIMIT }).ok).toBe(true);
  });

  it('refuses a present-but-empty cursor', () => {
    expect(codesOf('runs', { cursor: '' })).toContain('BLANK');
  });

  it('reports every issue, not the first', () => {
    const result = validateSearchQuery('runs', {
      filter: { tags: ['x'], workspaceId: '' },
      limit: 0,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThanOrEqual(3);
  });
});

describe('the canonical form of a search', () => {
  it('is stable for the same query', () => {
    const query = { filter: { workspaceId: 'ws-1', statuses: ['completed'] } };
    expect(canonicalSearch(resolve('runs', query))).toBe(canonicalSearch(resolve('runs', query)));
  });

  it('differs by KIND, so a draft cursor is never read on an artifact search', () => {
    expect(canonicalSearch(resolve('drafts'))).not.toBe(canonicalSearch(resolve('artifacts')));
    expect(canonicalSearch(resolve('runs'))).not.toBe(canonicalSearch(resolve('artifacts')));
  });

  it('does not depend on the order values were written in', () => {
    expect(
      canonicalSearch(resolve('runs', { filter: { statuses: ['failed', 'completed'] } })),
    ).toBe(canonicalSearch(resolve('runs', { filter: { statuses: ['completed', 'failed'] } })));
    expect(canonicalSearch(resolve('drafts', { filter: { tags: ['b', 'a'] } }))).toBe(
      canonicalSearch(resolve('drafts', { filter: { tags: ['a', 'b'] } })),
    );
  });

  it('differs when any dimension differs', () => {
    const base = canonicalSearch(resolve('drafts'));

    for (const query of [
      { filter: { organizationId: 'org-1' } },
      { filter: { workspaceId: 'ws-1' } },
      { filter: { principalId: 'user-1' } },
      { filter: { workflowId: 'article.draft' } },
      { filter: { draftId: 'draft-1' } },
      { filter: { statuses: ['ready'] } },
      { filter: { tags: ['article'] } },
      { filter: { createdAfter: '2026-07-01T00:00:00.000Z' } },
      { filter: { createdBefore: '2026-08-01T00:00:00.000Z' } },
      { order: 'oldest' as const },
    ]) {
      expect(canonicalSearch(resolve('drafts', query))).not.toBe(base);
    }
  });

  it('never confuses one dimension for another', () => {
    expect(canonicalSearch(resolve('drafts', { filter: { organizationId: 'a' } }))).not.toBe(
      canonicalSearch(resolve('drafts', { filter: { workspaceId: 'a' } })),
    );
  });

  it('does not depend on the page size, which does not change the sequence', () => {
    expect(canonicalSearch(resolve('runs', { limit: 5 }))).toBe(
      canonicalSearch(resolve('runs', { limit: 50 })),
    );
  });
});
