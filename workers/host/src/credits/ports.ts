/**
 * The credits port, bound to `TenantScopedConnection`.
 *
 * The Credits Service in `packages/platform` takes a transaction handle and
 * nothing else. Opening one under the right tenant is infrastructure, so it is
 * implemented HERE, at the process edge — the feature package is not allowed to
 * reach for a driver.
 *
 * ── Why the release does NOT run in the dispatcher's transaction ────────────
 * The dispatcher opens its transaction under the tenant of the EVENT.
 * `WorkspaceSuspended` is workspace-scoped, so that transaction carries the
 * workspace as `app.tenant_id` — and `credit_holds` is keyed by ORGANIZATION.
 * Every statement against it under a workspace tenant is invisible to RLS and
 * would release exactly nothing, silently.
 *
 * The release therefore runs on its own organization-scoped transaction, the
 * same shape the cascade ports use, and the handler turns an incomplete release
 * into a retryable failure.
 */

import type { Transaction, TenantScopedConnection } from '@contentos/database';
import type { CreditsExecutor } from '@contentos/platform';

/** One organization-scoped transaction, for work against holds and balances. */
export interface CreditsRunner {
  withOrganization<T>(
    organizationId: string,
    work: (tx: CreditsExecutor) => Promise<T>,
  ): Promise<T>;
}

export function createCreditsRunner(connection: TenantScopedConnection): CreditsRunner {
  return {
    withOrganization: (organizationId, work) =>
      connection.withTenant(
        // ADR-029: the credit account is organization-owned, so the
        // organization is both the tenant and the organization here. This is
        // the same convention `credit_holds.tenant_id = organization_id`
        // CHECKs, so a context built any other way cannot write a row at all.
        { tenantId: organizationId, organizationId, source: 'event' },
        (tx: Transaction) => work(tx as CreditsExecutor),
      ),
  };
}
