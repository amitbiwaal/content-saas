/**
 * Organization → workspace suspension cascade.
 *
 * `organizations.md` rule 15 and `workspaces.md` §"Suspension cascade":
 * suspension and reactivation cascade to every workspace the organization owns,
 * and "reactivation restores each workspace to its recorded prior status rather
 * than forcing `active`".
 *
 * ── Why it is asynchronous and per-workspace ────────────────────────────────
 * The same reason the membership cascade is: `workspaces` is keyed
 * `id = current_setting('app.tenant_id')`, so one transaction reaches one
 * workspace. "An organization with three hundred workspaces must not block the
 * request that triggered suspension", and the handler is therefore "idempotent
 * per workspaceId, retried to completion".
 *
 * ── Idempotence is the state machine's, not a flag's ────────────────────────
 * `suspend` is permitted only from `active` and `reactivate` only from
 * `suspended`. So a workspace already in the target state has no arrow to
 * follow and is skipped — no write, no audit record, NO DUPLICATE EVENT. A
 * second run of a completed cascade does nothing at all, and that falls out of
 * the transitions rather than out of bookkeeping that could drift.
 *
 * It is also what keeps "a workspace archived before an organization suspension
 * stays archived" true: there is no arrow from `archived` to `suspended`, so the
 * cascade never touches it, and no arrow back either, so reactivation leaves it
 * alone too.
 *
 * ── Reactivation does not lift a suspension it did not cause ────────────────
 * A workspace suspended by a policy action, independently of any organization
 * event, must NOT be reactivated when the organization is. The two are
 * different decisions. The cascade marks its own suspensions in the audit
 * detail and, on reactivation, restores only the workspaces carrying its own
 * mark. Anything else is left suspended, which is the meaning of restoring the
 * previously recorded state rather than blindly going active.
 */

import type { AuditContext } from '@contentos/security';

import {
  canTransitionWorkspace,
  isWorkspaceStatus,
  WorkspaceError,
  type WorkspaceTransition,
} from '../workspaces/lifecycle.js';
import {
  WORKSPACE_AUDIT_ACTIONS,
  type WorkspaceExecutor,
  type WorkspaceService,
} from '../workspaces/service.js';

/**
 * The audit-detail key marking a suspension as this cascade's work.
 *
 * Its VALUE is the organization id, so a mark left by one organization cannot
 * be read as authority to reactivate under another.
 */
export const ORGANIZATION_CASCADE_KEY = 'organizationCascade';

export interface OrganizationWorkspace {
  readonly workspaceId: string;
  readonly status: string;
}

/**
 * The port the cascade needs from the connection layer.
 *
 * `listWorkspaces` reads through the org-scoped, read-only `workspaces_org_read`
 * policy; `withWorkspace` opens one tenant-scoped transaction per workspace.
 * Both are infrastructure — `TenantScopedConnection` in `packages/database` —
 * so they arrive as a port rather than a driver dependency.
 */
export interface OrganizationWorkspaceRunner {
  listWorkspaces(organizationId: string): Promise<readonly OrganizationWorkspace[]>;
  withWorkspace<T>(
    workspaceId: string,
    organizationId: string,
    work: (tx: WorkspaceExecutor) => Promise<T>,
  ): Promise<T>;
}

export type CascadeSkipReason =
  /** No arrow from the workspace's current status — already correct, or archived. */
  | 'not-applicable'
  /** Suspended by something other than this organization's cascade. */
  | 'suspended-independently';

export interface SuspensionCascadeSkip {
  readonly workspaceId: string;
  readonly reason: CascadeSkipReason;
}

export interface SuspensionCascadeFailure {
  readonly workspaceId: string;
  readonly error: Error;
}

export interface SuspensionCascadeResult {
  readonly organizationId: string;
  readonly transition: WorkspaceTransition;
  readonly workspacesVisited: number;
  readonly applied: readonly string[];
  readonly skipped: readonly SuspensionCascadeSkip[];
  readonly failed: readonly SuspensionCascadeFailure[];
  /** True when every workspace reached a terminal outcome. Retry while false. */
  readonly complete: boolean;
}

export interface SuspensionCascadeRequest {
  readonly organizationId: string;
  /** A service actor: the platform executing a decision already taken. */
  readonly actor: { readonly id: string; readonly kind: 'service' | 'operator' };
  readonly correlationId: string;
  /** The `OrganizationSuspended` / `OrganizationReactivated` event id. */
  readonly causationId: string | null;
  readonly reason?: string;
  readonly context?: AuditContext;
}

export interface SuspensionCascadeOptions {
  readonly workspaces: WorkspaceService;
  readonly runner: OrganizationWorkspaceRunner;
  /** A stalled cascade is paged on; a DLQ entry here is a revenue-integrity failure. */
  readonly onWorkspaceFailed?: (workspaceId: string, error: Error) => void;
}

export interface SuspensionCascade {
  /** `OrganizationSuspended` → suspend every eligible workspace. */
  suspend(request: SuspensionCascadeRequest): Promise<SuspensionCascadeResult>;
  /** `OrganizationReactivated` → restore the workspaces this cascade suspended. */
  reactivate(request: SuspensionCascadeRequest): Promise<SuspensionCascadeResult>;
}

const SELECT_CASCADE_MARK_SQL = `
  SELECT context -> 'detail' ->> '${ORGANIZATION_CASCADE_KEY}' AS cascade_of
    FROM audit_log
   WHERE tenant_id = $1
     AND target_kind = 'workspace'
     AND target_id = $2
     AND action = $3
   ORDER BY created_at DESC, id DESC
   LIMIT 1`;

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

const DEFAULT_CONTEXT: AuditContext = {
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
};

export function createSuspensionCascade(options: SuspensionCascadeOptions): SuspensionCascade {
  const { workspaces, runner } = options;

  /**
   * The audit context carrying this cascade's mark.
   *
   * The workspace service merges a caller's `detail` beneath its own, so the
   * mark survives alongside `previousStatus` and `transition` without this
   * module touching the frozen service.
   */
  function markedContext(request: SuspensionCascadeRequest): AuditContext {
    const base = request.context ?? DEFAULT_CONTEXT;
    return {
      ...base,
      detail: { ...base.detail, [ORGANIZATION_CASCADE_KEY]: request.organizationId },
    };
  }

  async function run(
    request: SuspensionCascadeRequest,
    transition: WorkspaceTransition,
    reason: string,
    eligible: (tx: WorkspaceExecutor, workspaceId: string) => Promise<CascadeSkipReason | null>,
  ): Promise<SuspensionCascadeResult> {
    const listed = await runner.listWorkspaces(request.organizationId);

    const applied: string[] = [];
    const skipped: SuspensionCascadeSkip[] = [];
    const failed: SuspensionCascadeFailure[] = [];

    for (const workspace of listed) {
      // Pre-filter on the listed status to avoid opening a transaction that
      // could only be refused. The status is re-read and re-validated inside
      // the transition, so a stale entry costs a retry rather than correctness.
      if (
        !isWorkspaceStatus(workspace.status) ||
        !canTransitionWorkspace(workspace.status, transition)
      ) {
        skipped.push({ workspaceId: workspace.workspaceId, reason: 'not-applicable' });
        continue;
      }

      try {
        const outcome = await runner.withWorkspace(
          workspace.workspaceId,
          request.organizationId,
          async (tx) => {
            const ineligible = await eligible(tx, workspace.workspaceId);
            if (ineligible !== null) return ineligible;

            await workspaces.transition(tx, {
              workspaceId: workspace.workspaceId,
              transition,
              reason,
              actor: request.actor,
              correlationId: request.correlationId,
              causationId: request.causationId,
              context: markedContext(request),
            });
            return null;
          },
        );

        if (outcome === null) applied.push(workspace.workspaceId);
        else skipped.push({ workspaceId: workspace.workspaceId, reason: outcome });
      } catch (error: unknown) {
        // The status moved between listing and acting. Not a failure: the
        // workspace is simply no longer eligible, and re-running agrees.
        if (error instanceof WorkspaceError && error.code === 'InvalidTransition') {
          skipped.push({ workspaceId: workspace.workspaceId, reason: 'not-applicable' });
          continue;
        }
        // One workspace failing must not strand the rest.
        const wrapped = asError(error);
        failed.push({ workspaceId: workspace.workspaceId, error: wrapped });
        options.onWorkspaceFailed?.(workspace.workspaceId, wrapped);
      }
    }

    return {
      organizationId: request.organizationId,
      transition,
      workspacesVisited: listed.length,
      applied,
      skipped,
      failed,
      complete: failed.length === 0,
    };
  }

  return {
    async suspend(request) {
      return run(
        request,
        'suspend',
        request.reason ?? 'Organization suspended; workspace suspended by cascade.',
        // Every workspace the state machine allows is suspended; there is
        // nothing further to check.
        () => Promise.resolve(null),
      );
    },

    async reactivate(request) {
      return run(
        request,
        'reactivate',
        request.reason ?? 'Organization reactivated; workspace restored by cascade.',
        async (tx, workspaceId) => {
          const rows = await tx.query<{ cascade_of: string | null }>(SELECT_CASCADE_MARK_SQL, [
            workspaceId,
            workspaceId,
            WORKSPACE_AUDIT_ACTIONS.suspend,
          ]);
          const cascadeOf = rows[0]?.cascade_of ?? null;
          // Only this organization's own cascade may lift the suspension it
          // caused. A policy suspension carries no mark and stays in force.
          return cascadeOf === request.organizationId ? null : 'suspended-independently';
        },
      );
    },
  };
}
