import { describe, expect, it } from 'vitest';

import type { Subject } from '../authn/subject.js';
import {
  createTenantContextFactory,
  TenantContextError,
  tenantIsolation,
  validateTenantContext,
  type ResourceRef,
} from './context.js';

const AT = new Date('2026-07-29T10:00:00Z');
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const OTHER_WS = '018f7a1e-0000-7000-8000-0000000000cc';

const subject: Subject = {
  subjectId: 'user-1',
  kind: 'user',
  authenticatedAt: AT,
  method: 'password',
  mfaSatisfied: true,
  sessionId: 's1',
};

const resource: ResourceRef = {
  kind: 'article',
  id: 'a1',
  tenantId: WS,
  organizationId: ORG,
  ownerId: null,
};

const factory = (workspaces: readonly string[] = [WS]) =>
  createTenantContextFactory({
    memberships: { workspacesFor: () => Promise.resolve(workspaces) },
    now: () => AT,
  });

describe('validation', () => {
  it('accepts a well-formed pair', () => {
    expect(() => {
      validateTenantContext({ tenantId: WS, organizationId: ORG });
    }).not.toThrow();
  });

  it('rejects a non-UUID tenantId', () => {
    expect(() => {
      validateTenantContext({ tenantId: 'ws-1', organizationId: ORG });
    }).toThrow(TenantContextError);
  });

  it('rejects a non-UUID organizationId', () => {
    expect(() => {
      validateTenantContext({ tenantId: WS, organizationId: 'org' });
    }).toThrow(/organizationId/);
  });

  // The workspace is the isolation key; the organization is above it (ADR-017).
  it('rejects tenantId equal to organizationId', () => {
    expect(() => {
      validateTenantContext({ tenantId: WS, organizationId: WS });
    }).toThrow(/must not equal/);
  });
});

describe('establishment', () => {
  it('resolves from the resource once membership is confirmed', async () => {
    const ctx = await factory().fromRequest(subject, resource);
    expect(ctx.tenantId).toBe(WS);
    expect(ctx.organizationId).toBe(ORG);
    expect(ctx.source).toBe('request');
    expect(ctx.establishedAt).toEqual(AT);
  });

  // The candidate set comes from identity; the resource selects which one.
  it('refuses a resource the subject holds no membership in', async () => {
    await expect(factory([OTHER_WS]).fromRequest(subject, resource)).rejects.toThrow(
      /no membership/i,
    );
  });

  it('never takes the tenant from a request-supplied value', async () => {
    // Even with a plausible id, an absent membership denies.
    await expect(factory([]).fromRequest(subject, resource)).rejects.toThrow(TenantContextError);
  });

  it('builds an event context and marks its source', () => {
    const ctx = factory().fromEvent({ tenantId: WS, organizationId: ORG });
    expect(ctx.source).toBe('event');
  });

  // Throws rather than returning a partial context.
  it('refuses a malformed event context', () => {
    expect(() => factory().fromEvent({ tenantId: 'nope', organizationId: ORG })).toThrow(
      TenantContextError,
    );
  });

  it('builds a scheduled context', async () => {
    const ctx = await factory().fromSchedule(WS, ORG, 'nightly');
    expect(ctx.source).toBe('scheduled');
  });

  it('produces a frozen, immutable context', async () => {
    const ctx = await factory().fromRequest(subject, resource);
    expect(Object.isFrozen(ctx)).toBe(true);
  });
});

describe('propagation — no global mutable state', () => {
  const ctx = { tenantId: WS, organizationId: ORG, source: 'request' as const, establishedAt: AT };

  it('throws outside a scope rather than returning null', () => {
    expect(() => tenantIsolation.currentContext()).toThrow(/outside a tenant scope/);
  });

  it('reports absence without throwing', () => {
    expect(tenantIsolation.hasContext()).toBe(false);
  });

  it('exposes the context inside the scope', async () => {
    await tenantIsolation.withTenantContext(ctx, () => {
      expect(tenantIsolation.currentContext().tenantId).toBe(WS);
      return Promise.resolve();
    });
  });

  it('does not leak after the scope ends', async () => {
    await tenantIsolation.withTenantContext(ctx, () => Promise.resolve());
    expect(tenantIsolation.hasContext()).toBe(false);
  });

  it('propagates across await boundaries', async () => {
    await tenantIsolation.withTenantContext(ctx, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(tenantIsolation.currentContext().tenantId).toBe(WS);
    });
  });

  it('keeps concurrent scopes isolated', async () => {
    const [a, b] = await Promise.all([
      tenantIsolation.withTenantContext({ ...ctx, tenantId: WS }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return tenantIsolation.currentContext().tenantId;
      }),
      tenantIsolation.withTenantContext({ ...ctx, tenantId: OTHER_WS }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return tenantIsolation.currentContext().tenantId;
      }),
    ]);
    expect([a, b]).toEqual([WS, OTHER_WS]);
  });

  it('restores the outer scope on exit from a nested one', async () => {
    await tenantIsolation.withTenantContext(ctx, async () => {
      await tenantIsolation.withTenantContext({ ...ctx, tenantId: OTHER_WS }, () =>
        Promise.resolve(),
      );
      expect(tenantIsolation.currentContext().tenantId).toBe(WS);
    });
  });
});

describe('assertTenantMatch', () => {
  const ctx = { tenantId: WS, organizationId: ORG, source: 'request' as const, establishedAt: AT };

  it('accepts a row from the same tenant', () => {
    expect(() => {
      tenantIsolation.assertTenantMatch(ctx, { tenantId: WS });
    }).not.toThrow();
  });

  // A cross-tenant row reaching application code is a security incident.
  it('rejects a row from a different tenant', () => {
    expect(() => {
      tenantIsolation.assertTenantMatch(ctx, { tenantId: OTHER_WS });
    }).toThrow(/CROSS_TENANT_ACCESS|different tenant/);
  });
});
