/**
 * TenantContext — `16-security/tenant-isolation.md`.
 *
 * Two rules that must be read together:
 *   1. The tenant is NEVER read from a request payload, header, or query parameter.
 *   2. The candidate tenant set comes from the authenticated identity; the
 *      ADDRESSED RESOURCE selects which one.
 *
 * No global mutable state: propagation uses `AsyncLocalStorage`, so a context
 * is scoped to an async subtree and cannot be reassigned by another request.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Subject } from '../authn/subject.js';

/** Where a context came from. Retained for audit; NEVER used to vary enforcement. */
export type TenantContextSource = 'request' | 'event' | 'replay' | 'scheduled';

/**
 * Immutable, and enforced by the type. There is no setter, no mutation method,
 * and no re-scoping operation — work for a different tenant requires
 * constructing a new context, which forces the establishment rules to run again
 * rather than letting a value be edited in place.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly source: TenantContextSource;
  readonly establishedAt: Date;
}

/**
 * The resource being addressed. `tenantId` is resolved FROM THE RESOURCE,
 * never from the request (`16-security/authorization.md`).
 */
export interface ResourceRef {
  readonly kind: string;
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly ownerId: string | null;
}

export class TenantContextError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TenantContextError';
    this.code = code;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validation is total: a context either satisfies every rule or is not
 * constructed. There is no partial context and no nullable variant — a nullable
 * context would be checked inconsistently and would eventually be treated as
 * permissive.
 */
export function validateTenantContext(candidate: {
  tenantId: string;
  organizationId: string;
}): void {
  if (!UUID.test(candidate.tenantId)) {
    throw new TenantContextError('INVALID_TENANT_ID', 'tenantId must be a UUID.');
  }
  if (!UUID.test(candidate.organizationId)) {
    throw new TenantContextError('INVALID_ORGANIZATION_ID', 'organizationId must be a UUID.');
  }
  if (candidate.tenantId === candidate.organizationId) {
    throw new TenantContextError(
      'TENANT_EQUALS_ORGANIZATION',
      'tenantId must not equal organizationId — the workspace is the isolation key and the organization is above it (ADR-017).',
    );
  }
}

function build(
  tenantId: string,
  organizationId: string,
  source: TenantContextSource,
  now: () => Date,
): TenantContext {
  validateTenantContext({ tenantId, organizationId });
  return Object.freeze({
    tenantId,
    organizationId,
    source,
    establishedAt: now(),
  });
}

/** Resolves which workspaces a subject may reach. Reads an RLS exception table. */
export interface MembershipResolver {
  /** Workspace ids the subject holds an active membership in. */
  workspacesFor(subjectId: string): Promise<readonly string[]>;
}

export interface TenantContextFactoryOptions {
  readonly memberships: MembershipResolver;
  readonly now?: () => Date;
}

export interface TenantContextFactory {
  fromRequest(subject: Subject, resource: ResourceRef): Promise<TenantContext>;
  fromEvent(event: { tenantId: string; organizationId: string }): TenantContext;
  fromSchedule(tenantId: string, organizationId: string, job: string): Promise<TenantContext>;
}

export function createTenantContextFactory(
  options: TenantContextFactoryOptions,
): TenantContextFactory {
  const now = options.now ?? ((): Date => new Date());

  return {
    async fromRequest(subject, resource): Promise<TenantContext> {
      // Rule 2: the candidate set comes from the authenticated identity...
      const candidates = await options.memberships.workspacesFor(subject.subjectId);
      // ...and the ADDRESSED RESOURCE selects which one.
      if (!candidates.includes(resource.tenantId)) {
        throw new TenantContextError(
          'NO_MEMBERSHIP',
          'The subject holds no membership in the addressed resource tenant.',
        );
      }
      return build(resource.tenantId, resource.organizationId, 'request', now);
    },

    // Throws on malformed identifiers rather than returning a partial context,
    // so an event missing tenancy cannot be handled at all.
    fromEvent(event): TenantContext {
      return build(event.tenantId, event.organizationId, 'event', now);
    },

    fromSchedule(tenantId, organizationId): Promise<TenantContext> {
      return Promise.resolve(build(tenantId, organizationId, 'scheduled', now));
    },
  };
}

// ── Propagation ──────────────────────────────────────────────────────────────

const storage = new AsyncLocalStorage<TenantContext>();

export interface TenantIsolation {
  withTenantContext<T>(ctx: TenantContext, work: () => Promise<T>): Promise<T>;
  assertTenantMatch(ctx: TenantContext, row: { tenantId: string }): void;
  /** Throws outside a scope — NEVER returns null. */
  currentContext(): TenantContext;
  /** Non-throwing probe, for code that legitimately runs both in and out of scope. */
  hasContext(): boolean;
}

export const tenantIsolation: TenantIsolation = {
  withTenantContext<T>(ctx: TenantContext, work: () => Promise<T>): Promise<T> {
    return storage.run(ctx, work);
  },

  assertTenantMatch(ctx: TenantContext, row: { tenantId: string }): void {
    if (row.tenantId !== ctx.tenantId) {
      // A cross-tenant read that reached application code is a security
      // incident, not a validation error (`tenant-isolation.md`).
      throw new TenantContextError(
        'CROSS_TENANT_ACCESS',
        'A row from a different tenant reached application code.',
      );
    }
  },

  /**
   * Throws rather than returning null. A nullable accessor invites
   * `ctx?.tenantId`, which silently produces `undefined` — a query matching
   * nothing, or a cache key of `cos:undefined:` shared across every context
   * that made the same mistake.
   */
  currentContext(): TenantContext {
    const ctx = storage.getStore();
    if (ctx === undefined) {
      throw new TenantContextError(
        'NO_TENANT_CONTEXT',
        'currentContext() called outside a tenant scope. Pre-tenant work uses the typed withoutTenant path.',
      );
    }
    return ctx;
  },

  hasContext(): boolean {
    return storage.getStore() !== undefined;
  },
};
