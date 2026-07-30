/**
 * Registry composition — one registry per process, or no process.
 *
 * These are the checks that need the handlers as well as the declarations, so
 * they can only be made where the process is assembled.
 */
import { describe, expect, it } from 'vitest';

import type {
  DomainEvent,
  EventTypeDeclaration,
  RegistryContribution,
  TenantContext,
} from '@contentos/contracts';

import type { GuardExecutor } from '../delivery/guards.js';
import type { RegisteredHandler } from '../delivery/dispatcher.js';
import { composeEventRegistry } from './composition.js';
import { RegistryValidationError } from './validation.js';

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

function withConsumer(group: string, over: Partial<EventTypeDeclaration> = {}) {
  return declaration({
    ...over,
    consumers: [
      {
        consumerGroup: group,
        component: 'projections',
        versions: [1],
        criticality: 'standard',
        handlerIdempotencyKey: 'k',
        onUnknownVersion: 'dead-letter',
      },
    ],
  });
}

function contribution(over: Partial<RegistryContribution> = {}): RegistryContribution {
  return { source: '@contentos/test', declarations: [declaration()], emits: [], ...over };
}

function handler(over: Partial<RegisteredHandler> = {}): RegisteredHandler {
  return {
    eventType: 'ArticlePublished',
    version: 1,
    group: 'read-models',
    tenantScope: 'workspace',
    handle: (
      _e: DomainEvent<unknown>,
      _c: TenantContext,
      _t: GuardExecutor,
      _s: AbortSignal,
    ): Promise<void> => Promise.resolve(),
    ...over,
  };
}

function codesOf(fn: () => unknown): string[] {
  try {
    fn();
    return [];
  } catch (error: unknown) {
    if (error instanceof RegistryValidationError) return error.issues.map((i) => i.code);
    throw error;
  }
}

describe('composition', () => {
  it('builds a working registry from one contribution', () => {
    const composed = composeEventRegistry({ contributions: [contribution()] });
    expect(composed.registry.isRegistered('ArticlePublished', 1)).toBe(true);
    expect(composed.declarations).toHaveLength(1);
    expect(composed.registry.streamFor('ArticlePublished')).toBe('article');
  });

  it('merges several contributions into one registry', () => {
    const composed = composeEventRegistry({
      contributions: [
        contribution({ source: 'a' }),
        contribution({
          source: 'b',
          declarations: [declaration({ eventType: 'WorkspaceCreated', producer: 'p2' })],
        }),
      ],
    });
    expect(composed.declarations).toHaveLength(2);
    expect(composed.registry.isRegistered('WorkspaceCreated', 1)).toBe(true);
  });

  it('exposes each type’s declared tenant scope', () => {
    const composed = composeEventRegistry({
      contributions: [
        contribution({
          declarations: [
            declaration(),
            declaration({
              eventType: 'OrganizationCreated',
              producer: 'p2',
              tenantScope: 'organization',
            }),
          ],
        }),
      ],
    });
    expect(composed.tenantScopeOf('ArticlePublished', 1)).toBe('workspace');
    expect(composed.tenantScopeOf('OrganizationCreated', 1)).toBe('organization');
    expect(composed.tenantScopeOf('Unknown', 1)).toBeUndefined();
  });
});

describe('composition refuses to start on an invalid set', () => {
  it('throws rather than returning a broken registry', () => {
    expect(() =>
      composeEventRegistry({
        contributions: [contribution({ declarations: [declaration(), declaration()] })],
      }),
    ).toThrow(RegistryValidationError);
  });

  it('surfaces declaration and coverage failures together', () => {
    const codes = codesOf(() =>
      composeEventRegistry({
        contributions: [
          contribution({
            declarations: [declaration({ version: 2 })],
            emits: ['SomethingUndeclared'],
          }),
        ],
      }),
    );
    expect(codes).toContain('INVALID_VERSION_SEQUENCE');
    expect(codes).toContain('UNDECLARED_EMITTED_EVENT');
  });
});

describe('handler checks', () => {
  // A declared group with no handler means events accumulate against an offset
  // nobody advances, and the first symptom is a lag alert hours later.
  it('rejects a declared consumer group with no handler', () => {
    const codes = codesOf(() =>
      composeEventRegistry({
        contributions: [contribution({ declarations: [withConsumer('read-models')] })],
        handlers: [handler({ group: 'something-else', eventType: 'ArticlePublished' })],
      }),
    );
    expect(codes).toContain('CONSUMER_GROUP_WITHOUT_HANDLER');
  });

  it('accepts a declared group whose handler is registered', () => {
    expect(() =>
      composeEventRegistry({
        contributions: [contribution({ declarations: [withConsumer('read-models')] })],
        handlers: [handler()],
      }),
    ).not.toThrow();
  });

  // Code that will never be called looks like working software, which makes it
  // the more misleading of the two omissions.
  it('rejects a handler with no declaration', () => {
    expect(
      codesOf(() =>
        composeEventRegistry({
          contributions: [contribution()],
          handlers: [handler({ eventType: 'NeverDeclared' })],
        }),
      ),
    ).toContain('HANDLER_WITHOUT_DECLARATION');
  });

  // ADR-029: reconstructing workspace context from an organization-scoped
  // event reads zero rows and never errors.
  it('rejects a handler whose tenant scope disagrees with the declaration', () => {
    const codes = codesOf(() =>
      composeEventRegistry({
        contributions: [
          contribution({
            declarations: [
              withConsumer('read-models', {
                eventType: 'OrganizationSuspended',
                producer: 'platform.organizations',
                tenantScope: 'organization',
              }),
            ],
          }),
        ],
        handlers: [handler({ eventType: 'OrganizationSuspended', tenantScope: 'workspace' })],
      }),
    );
    expect(codes).toContain('HANDLER_SCOPE_MISMATCH');
  });

  it('accepts a handler whose scope matches', () => {
    expect(() =>
      composeEventRegistry({
        contributions: [
          contribution({
            declarations: [
              withConsumer('read-models', {
                eventType: 'OrganizationSuspended',
                producer: 'platform.organizations',
                tenantScope: 'organization',
              }),
            ],
          }),
        ],
        handlers: [handler({ eventType: 'OrganizationSuspended', tenantScope: 'organization' })],
      }),
    ).not.toThrow();
  });
});

describe('producer-only processes', () => {
  // The API declares the same types but runs none of their consumers.
  // Requiring handlers there would make every new worker group break its start.
  it('does not require handlers when requireHandlers is false', () => {
    expect(() =>
      composeEventRegistry({
        contributions: [contribution({ declarations: [withConsumer('read-models')] })],
        requireHandlers: false,
      }),
    ).not.toThrow();
  });

  it('requires them by default once any handler is supplied', () => {
    expect(
      codesOf(() =>
        composeEventRegistry({
          contributions: [
            contribution({
              declarations: [
                withConsumer('read-models'),
                withConsumer('analytics', { eventType: 'ArticleArchived' }),
              ],
            }),
          ],
          handlers: [handler()],
        }),
      ),
    ).toContain('CONSUMER_GROUP_WITHOUT_HANDLER');
  });

  it('composes with no handlers at all — the relay-only deployment', () => {
    expect(() => composeEventRegistry({ contributions: [contribution()] })).not.toThrow();
  });
});
