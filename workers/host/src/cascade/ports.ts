/**
 * The cascade ports, bound to `TenantScopedConnection`.
 *
 * The cascade libraries in `packages/platform` are pure orchestration over two
 * ports. Opening a transaction per tenant is infrastructure, so the ports are
 * implemented HERE, at the process edge, and not in the feature package — which
 * is not allowed to reach for a driver.
 *
 * Nothing below touches a pool or a client. Every statement runs on a handle
 * `TenantScopedConnection` supplied, which is what keeps `SET LOCAL` and the
 * query it protects on the same backend connection.
 *
 * ── Listing an organization's workspaces ────────────────────────────────────
 * `workspaces` carries TWO policies: `workspaces_tenant_isolation` keyed on
 * `id = app.tenant_id`, and the read-only `workspaces_org_read` keyed on
 * `organization_id = app.organization_id`. Policies are OR'd, so a read that
 * sets `app.organization_id` sees the organization's workspaces — which is
 * exactly what that second policy exists for.
 *
 * `withoutTenant` cannot be used: it sets NEITHER variable, so the org policy
 * matches nothing and the read returns zero rows. The listing therefore runs
 * under `withTenant({ tenantId: organizationId, organizationId })`, the
 * organization-scoped convention of ADR-029. The tenant half matches no
 * workspace, and is not meant to — the org policy is doing the work.
 */

import type { Transaction, TenantScopedConnection } from '@contentos/database';
import type {
  MembershipExecutor,
  OrganizationWorkspace,
  OrganizationWorkspaceRunner,
  WorkspaceExecutor,
  WorkspaceScopedRunner,
} from '@contentos/platform';

/**
 * Read-only, and only the two columns the cascades branch on.
 *
 * `deleted_at IS NULL` because a purged workspace is not a cascade target; it
 * has no state left to change.
 */
const LIST_WORKSPACES_SQL = `
  SELECT id, status
    FROM workspaces
   WHERE organization_id = $1 AND deleted_at IS NULL
   ORDER BY id`;

interface WorkspaceRow {
  readonly id: string;
  readonly status: string;
}

export interface CascadeRunners {
  readonly memberships: WorkspaceScopedRunner;
  readonly workspaces: OrganizationWorkspaceRunner;
}

/**
 * Both cascade ports over one connection.
 *
 * They share the listing query and the per-workspace transaction; only the
 * shape each cascade wants differs. Implementing them together keeps the two
 * from drifting into different ideas of which workspaces belong to an
 * organization.
 */
export function createCascadeRunners(connection: TenantScopedConnection): CascadeRunners {
  async function listWorkspaces(organizationId: string): Promise<readonly OrganizationWorkspace[]> {
    return connection.withTenant(
      { tenantId: organizationId, organizationId, source: 'event' },
      async (tx: Transaction) => {
        const rows = await tx.query<WorkspaceRow>(LIST_WORKSPACES_SQL, [organizationId]);
        return rows.map((r) => ({ workspaceId: r.id, status: r.status }));
      },
    );
  }

  /**
   * One tenant-scoped transaction per workspace.
   *
   * This is where the cascade's per-workspace unit of work commits or rolls
   * back on its own — the reason the cascade converges under retry rather than
   * needing to be atomic across an organization.
   */
  function withWorkspace<T>(
    workspaceId: string,
    organizationId: string,
    work: (tx: Transaction) => Promise<T>,
  ): Promise<T> {
    return connection.withTenant({ tenantId: workspaceId, organizationId, source: 'event' }, work);
  }

  return {
    memberships: {
      listWorkspaceIds: async (organizationId): Promise<readonly string[]> =>
        (await listWorkspaces(organizationId)).map((w) => w.workspaceId),
      withWorkspace: (workspaceId, organizationId, work) =>
        withWorkspace(workspaceId, organizationId, (tx) => work(tx as MembershipExecutor)),
    },
    workspaces: {
      listWorkspaces,
      withWorkspace: (workspaceId, organizationId, work) =>
        withWorkspace(workspaceId, organizationId, (tx) => work(tx as WorkspaceExecutor)),
    },
  };
}
