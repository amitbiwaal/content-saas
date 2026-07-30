/**
 * Registry declaration validation.
 *
 * Every case here is a startup failure, and each is written to prove the
 * failure is DETECTED rather than that a valid set passes — a validator that
 * accepts everything also passes the happy-path test.
 */
import { describe, expect, it } from 'vitest';

import type { EventTypeDeclaration, RegistryContribution } from '@contentos/contracts';

import {
  assertNoIssues,
  RegistryValidationError,
  validateContributionCoverage,
  validateDeclarations,
  type RegistryIssueCode,
} from './validation.js';

function declaration(over: Partial<EventTypeDeclaration> = {}): EventTypeDeclaration {
  return {
    eventType: 'ArticlePublished',
    version: 1,
    state: 'active',
    stream: 'article',
    producer: 'content-platform',
    tenantScope: 'workspace',
    consumers: [],
    ...over,
  };
}

function codes(declarations: readonly EventTypeDeclaration[]): RegistryIssueCode[] {
  return validateDeclarations(declarations).map((i) => i.code);
}

describe('a valid declaration set', () => {
  it('reports nothing', () => {
    expect(validateDeclarations([declaration()])).toEqual([]);
  });

  it('accepts several versions of one type', () => {
    expect(
      codes([
        declaration({ version: 1, state: 'deprecated' }),
        declaration({ version: 2, state: 'active' }),
      ]),
    ).toEqual([]);
  });

  it('accepts distinct types from distinct producers', () => {
    expect(
      codes([
        declaration(),
        declaration({ eventType: 'WorkspaceCreated', producer: 'platform.workspaces' }),
      ]),
    ).toEqual([]);
  });
});

describe('duplicate detection', () => {
  it('rejects the same event type and version twice', () => {
    expect(codes([declaration(), declaration()])).toContain('DUPLICATE_DECLARATION');
  });

  // Otherwise the winner is whichever package loaded last.
  it('rejects one event type claimed by two producers', () => {
    const issues = validateDeclarations([
      declaration({ version: 1 }),
      declaration({ version: 2, producer: 'someone-else' }),
    ]);
    expect(issues.map((i) => i.code)).toContain('DUPLICATE_PRODUCER');
    expect(issues.find((i) => i.code === 'DUPLICATE_PRODUCER')?.detail).toContain('someone-else');
  });

  it('accepts one producer owning many types', () => {
    expect(codes([declaration(), declaration({ eventType: 'ArticleArchived' })])).toEqual([]);
  });

  // Two groups sharing a name share a Redis offset, so each sees a fraction of
  // the stream and both believe they saw all of it.
  it('rejects one consumer group claimed by two components', () => {
    const consumer = {
      consumerGroup: 'read-models',
      versions: [1],
      criticality: 'standard' as const,
      handlerIdempotencyKey: 'k',
      onUnknownVersion: 'dead-letter' as const,
    };
    expect(
      codes([
        declaration({ consumers: [{ ...consumer, component: 'projections' }] }),
        declaration({
          eventType: 'ArticleArchived',
          consumers: [{ ...consumer, component: 'analytics' }],
        }),
      ]),
    ).toContain('DUPLICATE_CONSUMER_GROUP');
  });
});

describe('version sequence', () => {
  it('rejects a gap', () => {
    expect(codes([declaration({ version: 1 }), declaration({ version: 3 })])).toContain(
      'INVALID_VERSION_SEQUENCE',
    );
  });

  it('rejects a set that does not start at 1', () => {
    expect(codes([declaration({ version: 2 })])).toContain('INVALID_VERSION_SEQUENCE');
  });

  it('rejects a non-integer or zero version', () => {
    expect(codes([declaration({ version: 0 })])).toContain('MALFORMED_DECLARATION');
    expect(codes([declaration({ version: 1.5 })])).toContain('MALFORMED_DECLARATION');
  });
});

describe('tenant scope — ADR-029', () => {
  // Required by the type; validated anyway, because "never inferred" has to
  // hold at the boundary where types stop.
  it('rejects a missing scope', () => {
    const bad = { ...declaration(), tenantScope: undefined } as unknown as EventTypeDeclaration;
    expect(codes([bad])).toContain('MISSING_TENANT_SCOPE');
  });

  it('rejects a scope outside the closed set', () => {
    const bad = { ...declaration(), tenantScope: 'project' } as unknown as EventTypeDeclaration;
    const issues = validateDeclarations([bad]);
    expect(issues.map((i) => i.code)).toContain('MISSING_TENANT_SCOPE');
    expect(issues[0]?.detail).toContain('never inferred');
  });

  it('accepts both members of the set', () => {
    expect(codes([declaration({ tenantScope: 'workspace' })])).toEqual([]);
    expect(codes([declaration({ tenantScope: 'organization' })])).toEqual([]);
  });
});

describe('malformed declarations', () => {
  const CASES: readonly (readonly [string, Partial<EventTypeDeclaration>])[] = [
    ['a non-PascalCase event type', { eventType: 'article_published' }],
    ['an empty event type', { eventType: '' }],
    ['an unknown state', { state: 'sunsetting' as EventTypeDeclaration['state'] }],
    ['an empty stream', { stream: '' }],
    ['an empty producer', { producer: '' }],
  ];

  for (const [label, over] of CASES) {
    it(`rejects ${label}`, () => {
      expect(codes([declaration(over)])).toContain('MALFORMED_DECLARATION');
    });
  }
});

describe('consumers reference declared versions', () => {
  it('rejects a consumer declaring an undeclared version', () => {
    expect(
      codes([
        declaration({
          consumers: [
            {
              consumerGroup: 'read-models',
              component: 'projections',
              versions: [2],
              criticality: 'standard',
              handlerIdempotencyKey: 'k',
              onUnknownVersion: 'dead-letter',
            },
          ],
        }),
      ]),
    ).toContain('UNKNOWN_CONSUMER_EVENT');
  });
});

describe('contribution coverage — every emitted type is declared', () => {
  function contribution(over: Partial<RegistryContribution> = {}): RegistryContribution {
    return {
      source: '@contentos/platform',
      declarations: [declaration()],
      emits: ['ArticlePublished'],
      ...over,
    };
  }

  it('accepts a package whose emitted types are all declared', () => {
    expect(validateContributionCoverage([contribution()])).toEqual([]);
  });

  // The check that would have caught Sprint 1 shipping nineteen event types
  // with no declarations.
  it('rejects a type a package can emit but nothing declares', () => {
    const issues = validateContributionCoverage([
      contribution({ emits: ['ArticlePublished', 'ArticleArchived'] }),
    ]);
    expect(issues.map((i) => i.code)).toEqual(['UNDECLARED_EMITTED_EVENT']);
    expect(issues[0]?.detail).toContain('could never be published');
  });

  it('lets one package declare a type another emits', () => {
    expect(
      validateContributionCoverage([
        contribution({ source: 'a', declarations: [declaration()], emits: [] }),
        contribution({ source: 'b', declarations: [], emits: ['ArticlePublished'] }),
      ]),
    ).toEqual([]);
  });
});

describe('assertNoIssues', () => {
  it('passes silently on an empty list', () => {
    expect(() => {
      assertNoIssues([]);
    }).not.toThrow();
  });

  // Fail fast, and say everything that is wrong at once — fixing a bad
  // composition one restart at a time is how a short job becomes a long one.
  it('throws with every issue listed', () => {
    let caught: unknown;
    try {
      assertNoIssues(validateDeclarations([declaration({ version: 3, stream: '' })]));
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RegistryValidationError);
    const issues = (caught as RegistryValidationError).issues;
    expect(issues.length).toBeGreaterThan(1);
    expect((caught as Error).message).toContain('must not start');
  });
});
