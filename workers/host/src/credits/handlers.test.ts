/**
 * The credit hold-release handlers.
 *
 * The load-bearing assertion is the tenant one: `WorkspaceSuspended` is
 * workspace-scoped, but holds are keyed by ORGANIZATION. A handler that ran the
 * release on the dispatcher's transaction would match no rows under RLS and
 * report success — silently leaving a suspended customer's credits reserved.
 */
import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';
import type { GuardExecutor } from '@contentos/events';
import {
  CREDITS_ORGANIZATION_RELEASE_GROUP,
  CREDITS_WORKSPACE_RELEASE_GROUP,
  type BulkReleaseCommand,
  type BulkReleaseResult,
  type CreditsExecutor,
  type CreditsService,
} from '@contentos/platform';

import { createCreditsHandlers, HoldReleaseFailedError } from './handlers.js';
import type { CreditsRunner } from './ports.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

interface Recorded {
  readonly scopes: string[];
  readonly commands: BulkReleaseCommand[];
}

function harness(options: { fail?: Error } = {}) {
  const recorded: Recorded = { scopes: [], commands: [] };

  const runner: CreditsRunner = {
    withOrganization(organizationId, work) {
      recorded.scopes.push(organizationId);
      return work({} as CreditsExecutor);
    },
  };

  const credits = {
    releaseOpenHolds(
      _tx: CreditsExecutor,
      command: BulkReleaseCommand,
    ): Promise<BulkReleaseResult> {
      recorded.commands.push(command);
      if (options.fail !== undefined) return Promise.reject(options.fail);
      return Promise.resolve({ released: [], events: [] });
    },
  } as unknown as CreditsService;

  return { handlers: createCreditsHandlers({ credits, runner }), recorded };
}

function event(eventType: string, over: Partial<DomainEvent<unknown>> = {}): DomainEvent<unknown> {
  return {
    eventId: EVENT_ID,
    eventType,
    eventVersion: 1,
    aggregateType: eventType.startsWith('Workspace') ? 'Workspace' : 'Organization',
    aggregateId: eventType.startsWith('Workspace') ? WS : ORG,
    tenantId: eventType.startsWith('Workspace') ? WS : ORG,
    organizationId: ORG,
    correlationId: CORRELATION,
    causationId: null,
    producer: 'platform.workspaces',
    occurredAt: '2026-07-30T12:00:00.000Z',
    payload: eventType.startsWith('Workspace') ? { workspaceId: WS } : { organizationId: ORG },
    ...over,
  } as DomainEvent<unknown>;
}

const run = async (
  handlers: ReturnType<typeof harness>['handlers'],
  eventType: string,
  e = event(eventType),
): Promise<void> => {
  const handler = handlers.find((h) => h.eventType === eventType);
  expect(handler, eventType).toBeDefined();
  if (handler === undefined) return;
  await handler.handle(
    e,
    { tenantId: e.tenantId, organizationId: e.organizationId, source: 'event' },
    {} as GuardExecutor,
    new AbortController().signal,
  );
};

describe('the two handlers, and nothing else subscribes', () => {
  it('handles exactly the two suspension events', () => {
    const { handlers } = harness();
    expect(handlers.map((h) => h.eventType).sort()).toEqual([
      'OrganizationSuspended',
      'WorkspaceSuspended',
    ]);
  });

  it('puts each in its own group', () => {
    const { handlers } = harness();
    const groups = new Map(handlers.map((h) => [h.eventType, h.group]));
    expect(groups.get('OrganizationSuspended')).toBe(CREDITS_ORGANIZATION_RELEASE_GROUP);
    expect(groups.get('WorkspaceSuspended')).toBe(CREDITS_WORKSPACE_RELEASE_GROUP);
  });

  // Composition refuses to register a handler whose scope disagrees with the
  // declaration, so these must match ADR-029 exactly.
  it('declares the scope each event actually carries', () => {
    const { handlers } = harness();
    const scopes = new Map(handlers.map((h) => [h.eventType, h.tenantScope]));
    expect(scopes.get('OrganizationSuspended')).toBe('organization');
    expect(scopes.get('WorkspaceSuspended')).toBe('workspace');
  });
});

describe('an organization suspension releases the whole account', () => {
  it('releases with no workspace filter', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, 'OrganizationSuspended');

    expect(recorded.commands).toHaveLength(1);
    expect(recorded.commands[0]).toMatchObject({
      organizationId: ORG,
      workspaceId: null,
      cause: 'suspended',
    });
  });

  it('runs under the organization tenant', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, 'OrganizationSuspended');
    expect(recorded.scopes).toEqual([ORG]);
  });
});

describe('a workspace suspension releases only that workspace', () => {
  it('passes the workspace as a filter', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, 'WorkspaceSuspended');

    expect(recorded.commands[0]).toMatchObject({
      organizationId: ORG,
      workspaceId: WS,
      cause: 'suspended',
    });
  });

  // The whole reason the port exists: the event's tenant is the workspace, and
  // holds are keyed by organization.
  it('runs under the ORGANIZATION tenant, not the workspace', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, 'WorkspaceSuspended');
    expect(recorded.scopes).toEqual([ORG]);
    expect(recorded.scopes).not.toContain(WS);
  });

  it('falls back to the envelope tenant when the payload omits the workspace', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, 'WorkspaceSuspended', event('WorkspaceSuspended', { payload: {} }));
    expect(recorded.commands[0]?.workspaceId).toBe(WS);
  });

  // A malformed payload is a contract violation, not a transient fault.
  it('dead-letters when no organization can be determined', async () => {
    const { handlers } = harness();
    const malformed = event('WorkspaceSuspended', { organizationId: '' });
    await expect(run(handlers, 'WorkspaceSuspended', malformed)).rejects.toMatchObject({
      code: 'SchemaViolation',
    });
  });
});

describe('causation and correlation are carried through', () => {
  it('ties the release to the suspension that caused it', async () => {
    const { handlers, recorded } = harness();
    await run(handlers, 'OrganizationSuspended');
    expect(recorded.commands[0]).toMatchObject({
      correlationId: CORRELATION,
      causationId: EVENT_ID,
    });
  });
});

describe('a failed release retries rather than dead-letters', () => {
  it('wraps the cause in a transient failure', async () => {
    const { handlers } = harness({ fail: new Error('connection reset') });
    await expect(run(handlers, 'OrganizationSuspended')).rejects.toThrow(HoldReleaseFailedError);
  });

  it('names the scope, the id and the underlying cause', async () => {
    const { handlers } = harness({ fail: new Error('connection reset') });
    try {
      await run(handlers, 'WorkspaceSuspended');
      expect.unreachable('must fail');
    } catch (error) {
      const e = error as HoldReleaseFailedError;
      expect(e.code).toBe('HoldReleaseFailed');
      expect(e.message).toContain('workspace');
      expect(e.message).toContain(WS);
      expect(e.message).toContain('connection reset');
    }
  });

  // Not one of the terminal codes, so the retry engine classifies it transient.
  // A suspended customer with credits still reserved is worth trying again.
  it('uses a code that is not terminal', async () => {
    const { handlers } = harness({ fail: new Error('boom') });
    try {
      await run(handlers, 'OrganizationSuspended');
      expect.unreachable('must fail');
    } catch (error) {
      expect((error as HoldReleaseFailedError).code).toBe('HoldReleaseFailed');
      expect(['SchemaViolation', 'UnknownEventType']).not.toContain(
        (error as HoldReleaseFailedError).code,
      );
    }
  });
});
