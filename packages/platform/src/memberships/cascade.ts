/**
 * Organization membership revocation cascade.
 *
 * `organizations.md` rule 9: "Removing someone from the organization revokes
 * every workspace membership they hold within it." `workspaces.md` lists
 * `OrgMembershipRevoked` under CONSUMED events with exactly that reaction.
 *
 * ── Why this is not one transaction ─────────────────────────────────────────
 * Rule 9 says "in one transaction", and it cannot be. Every
 * `workspace_memberships` row is protected by
 * `tenant_id = current_setting('app.tenant_id')`, and one transaction has one
 * tenant setting, so a single statement cannot reach a user's rows across many
 * workspaces. Not a limitation to work around — it IS the isolation guarantee.
 *
 * So the cascade is what the event tables already describe: the organization
 * revocation commits with its `OrgMembershipRevoked` event, and this runs
 * afterwards, once per workspace, each in its own tenant-scoped transaction.
 * That is also why the requirement is IDEMPOTENCE rather than atomicity — a
 * single UPDATE would need no such property, and a retried per-workspace
 * handler needs nothing else.
 *
 * ── Which workspaces ────────────────────────────────────────────────────────
 * The user's workspace memberships cannot be enumerated across tenants either,
 * for the same reason. The organization's WORKSPACES can be: the second,
 * read-only `workspaces_org_read` policy exists for precisely this. So the
 * cascade walks the organization's workspaces and revokes where a membership is
 * found — which is why "not a member" is an ordinary outcome here, not an error.
 */

import type { AuditContext } from '@contentos/security';

import { MembershipError } from './membership.js';
import type { MembershipActor, MembershipExecutor } from './organization-memberships.js';
import type { WorkspaceMembershipService } from './workspace-memberships.js';

/**
 * The port the cascade needs from the connection layer.
 *
 * It is a port rather than a direct dependency because opening a transaction
 * per tenant is infrastructure — `TenantScopedConnection.withTenant` in
 * `packages/database` — and this package is not allowed to reach for a driver.
 */
export interface WorkspaceScopedRunner {
  /** Workspace ids owned by the organization, read under organization context. */
  listWorkspaceIds(organizationId: string): Promise<readonly string[]>;
  /** Runs `work` in a transaction scoped to one workspace as its tenant. */
  withWorkspace<T>(
    workspaceId: string,
    organizationId: string,
    work: (tx: MembershipExecutor) => Promise<T>,
  ): Promise<T>;
}

export interface CascadeRequest {
  readonly organizationId: string;
  /** The user whose organization membership was revoked. */
  readonly userId: string;
  /** A service actor: this is the platform executing a decision already taken. */
  readonly actor: MembershipActor;
  readonly correlationId: string;
  /** The `OrgMembershipRevoked` event id, tying each revocation to its cause. */
  readonly causationId: string | null;
  readonly reason?: string;
  readonly context?: AuditContext;
}

export interface CascadeOutcome {
  readonly workspaceId: string;
  readonly result: 'revoked' | 'already-revoked' | 'not-a-member' | 'failed';
  readonly error?: Error;
}

export interface CascadeResult {
  readonly organizationId: string;
  readonly userId: string;
  readonly workspacesVisited: number;
  readonly revoked: readonly string[];
  readonly alreadyRevoked: readonly string[];
  readonly notMember: readonly string[];
  readonly failed: readonly CascadeOutcome[];
  /** True when every workspace reached a terminal state. Retry while false. */
  readonly complete: boolean;
}

export interface MembershipCascadeOptions {
  readonly workspaces: WorkspaceMembershipService;
  readonly runner: WorkspaceScopedRunner;
  /** Counts workspaces whose revocation failed, for the alert on a stalled cascade. */
  readonly onWorkspaceFailed?: (workspaceId: string, error: Error) => void;
}

export interface MembershipCascade {
  revokeAcrossWorkspaces(request: CascadeRequest): Promise<CascadeResult>;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function createMembershipCascade(options: MembershipCascadeOptions): MembershipCascade {
  const { workspaces, runner } = options;

  return {
    async revokeAcrossWorkspaces(request) {
      const workspaceIds = await runner.listWorkspaceIds(request.organizationId);

      const revoked: string[] = [];
      const alreadyRevoked: string[] = [];
      const notMember: string[] = [];
      const failed: CascadeOutcome[] = [];

      for (const workspaceId of workspaceIds) {
        try {
          const outcome = await runner.withWorkspace(
            workspaceId,
            request.organizationId,
            async (tx) => {
              return workspaces.revoke(tx, {
                workspaceId,
                organizationId: request.organizationId,
                userId: request.userId,
                actor: request.actor,
                correlationId: request.correlationId,
                causationId: request.causationId,
                reason:
                  request.reason ?? 'Organization membership revoked; workspace access withdrawn.',
                ...(request.context === undefined ? {} : { context: request.context }),
                // See the field's own documentation: an ex-member keeping live
                // access is the worse of the two failures.
                overrideLastAdminProtection: true,
              });
            },
          );

          // `changed: false` means the membership was already revoked — the
          // idempotent path, and the reason a retry is safe.
          if (outcome.changed) revoked.push(workspaceId);
          else alreadyRevoked.push(workspaceId);
        } catch (error: unknown) {
          // A user who never joined this workspace is an ordinary outcome, not
          // a failure: the cascade walks workspaces, not memberships.
          if (error instanceof MembershipError && error.code === 'MembershipNotFound') {
            notMember.push(workspaceId);
            continue;
          }
          // One workspace failing must not strand the rest. The caller retries;
          // every workspace already handled takes the idempotent path.
          const wrapped = asError(error);
          failed.push({ workspaceId, result: 'failed', error: wrapped });
          options.onWorkspaceFailed?.(workspaceId, wrapped);
        }
      }

      return {
        organizationId: request.organizationId,
        userId: request.userId,
        workspacesVisited: workspaceIds.length,
        revoked,
        alreadyRevoked,
        notMember,
        failed,
        complete: failed.length === 0,
      };
    },
  };
}
