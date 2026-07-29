/**
 * Organizations Service — `04-platform/organizations.md`.
 *
 * Increment A: provisioning and lifecycle. Membership beyond the first owner,
 * workspaces, SSO, domains and quota are NOT here.
 *
 * ── Atomicity ────────────────────────────────────────────────────────────────
 * Provisioning writes the organization, the first `org_owner` membership, the
 * audit record and the outbox event on ONE transaction handle. There is no
 * commit inside this module and no second connection, so a failure anywhere
 * rolls the whole thing back: **a partial organization — one with no owner —
 * cannot exist** (`02-domain-design/organizations.md` §"Failure Handling").
 *
 * That guarantee is structural, not procedural. `EventPublisher.publish` and
 * `AuditWriter.record` both REQUIRE a transaction handle, so neither can be
 * called outside the transaction that makes them true.
 *
 * ── Connection context ───────────────────────────────────────────────────────
 * `organizations` and `organization_memberships` are two of the five RLS
 * exception tables and carry no policy. `outbox_events` and `audit_log` do, and
 * both key on `app.tenant_id`. Organization work must therefore run under
 * `withTenant({ tenantId: organizationId, organizationId })` — see
 * `organizationEventTenantId` in `./events.ts`, which is where that convention
 * is decided and explained.
 */

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type {
  AuditActorKind,
  AuditContext,
  AuditWriter,
  NewAuditRecord,
} from '@contentos/security';
import { secureId } from '@contentos/security';

import {
  organizationClosed,
  organizationClosureRequested,
  organizationCreated,
  organizationReactivated,
  organizationSuspended,
  organizationEventTenantId,
  type EventContext,
} from './events.js';
import {
  assertTransitionAllowed,
  CLOSURE_WINDOW_DAYS,
  INITIAL_STATUS,
  isOrganizationStatus,
  OrganizationError,
  resolveTarget,
  restoresPreviousStatus,
  type OrganizationStatus,
  type OrganizationTransition,
} from './lifecycle.js';

/**
 * The executable transaction shape.
 *
 * `contracts.Transaction` is an opaque brand so that package acquires no
 * driver dependency; the query surface is asserted here, at the layer that
 * actually issues SQL — the same technique `packages/events` uses for the
 * outbox publisher.
 */
export interface OrganizationExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

export interface AuditActor {
  readonly id: string;
  readonly kind: AuditActorKind;
}

/** Audit actions are enumerated constants, never free text (`16-security/audit.md` rule 6). */
export const ORGANIZATION_AUDIT_ACTIONS = {
  provision: 'organization.created',
  payment_failed: 'organization.past_due',
  payment_recovered: 'organization.payment_recovered',
  suspend: 'organization.suspended',
  reactivate: 'organization.reactivated',
  request_closure: 'organization.closure_requested',
  cancel_closure: 'organization.closure_cancelled',
  close: 'organization.closed',
} as const satisfies Readonly<Record<OrganizationTransition | 'provision', string>>;

export type OrganizationAuditAction =
  (typeof ORGANIZATION_AUDIT_ACTIONS)[keyof typeof ORGANIZATION_AUDIT_ACTIONS];

/**
 * Which recorded action a restoring transition reads its prior status from.
 *
 * Reactivation restores the status in force before the SUSPENSION, and a
 * cancelled closure the status before the CLOSURE REQUEST. Reading the most
 * recent such record is what makes `past_due → suspended → reactivate` land
 * back on `past_due` instead of quietly forgiving a debt.
 */
const RESTORE_SOURCE_ACTION: Readonly<Partial<Record<OrganizationTransition, string>>> = {
  reactivate: ORGANIZATION_AUDIT_ACTIONS.suspend,
  cancel_closure: ORGANIZATION_AUDIT_ACTIONS.request_closure,
};

/** The key the prior status is recorded under, in `audit_log.context->'detail'`. */
export const PREVIOUS_STATUS_KEY = 'previousStatus';

const INSERT_ORGANIZATION_SQL = `
  INSERT INTO organizations (slug, name, status, created_by, updated_by)
  VALUES ($1,$2,$3,$4,$4)
  RETURNING id, version`;

const INSERT_OWNER_SQL = `
  INSERT INTO organization_memberships (
    organization_id, user_id, role, status, created_by, updated_by
  ) VALUES ($1,$2,'org_owner','active',$3,$3)
  RETURNING id`;

const SELECT_ORGANIZATION_SQL = `
  SELECT id, slug, name, status, version
    FROM organizations
   WHERE id = $1 AND deleted_at IS NULL`;

/**
 * Optimistic concurrency — `02-domain-design/organizations.md` §Performance.
 *
 * The version predicate is what serialises two interleaved transitions. The
 * loser updates zero rows and is told so, rather than silently overwriting a
 * decision it never saw.
 */
const UPDATE_STATUS_SQL = `
  UPDATE organizations
     SET status = $1, version = version + 1, updated_at = now(), updated_by = $2
   WHERE id = $3 AND version = $4 AND deleted_at IS NULL
  RETURNING version`;

const SELECT_RECORDED_PREVIOUS_SQL = `
  SELECT context -> 'detail' ->> '${PREVIOUS_STATUS_KEY}' AS previous_status
    FROM audit_log
   WHERE organization_id = $1
     AND target_kind = 'organization'
     AND target_id = $2
     AND action = $3
   ORDER BY created_at DESC, id DESC
   LIMIT 1`;

const UNIQUE_VIOLATION = '23505';

/**
 * `organizations` has exactly one unique key — the slug — so a unique violation
 * on its insert can only be a slug collision. The constraint name is checked
 * when the driver supplies it and not required when it does not.
 */
function isSlugConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as Record<string, unknown>;
  if (record['code'] !== UNIQUE_VIOLATION) return false;
  const constraint = record['constraint'];
  return typeof constraint !== 'string' || constraint.includes('slug');
}

export interface OrganizationServiceOptions {
  readonly publisher: EventPublisher;
  readonly audit: AuditWriter;
  /** Server clock. Never client-supplied — the audit record depends on it. */
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

export interface ProvisionOrganizationCommand {
  readonly slug: string;
  readonly name: string;
  /** Becomes the first `org_owner`, active immediately. */
  readonly ownerUserId: string;
  readonly actor: AuditActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly reason?: string;
  readonly context?: AuditContext;
}

export interface ProvisionedOrganization {
  readonly organizationId: string;
  readonly ownerMembershipId: string;
  readonly ownerUserId: string;
  readonly status: OrganizationStatus;
  readonly version: number;
}

export interface TransitionOrganizationCommand {
  readonly organizationId: string;
  readonly transition: OrganizationTransition;
  /** Mandatory including on success: a privileged action needs a justification. */
  readonly reason: string;
  readonly actor: AuditActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
  /** An explicit precondition. Omitted, the version read in this transaction is used. */
  readonly expectedVersion?: number;
  readonly context?: AuditContext;
}

export interface OrganizationTransitionResult {
  readonly organizationId: string;
  readonly previousStatus: OrganizationStatus;
  readonly status: OrganizationStatus;
  readonly version: number;
  /** Null where the contract defines no event for this transition. */
  readonly event: DomainEvent<unknown> | null;
}

export interface OrganizationService {
  provision(
    tx: OrganizationExecutor,
    command: ProvisionOrganizationCommand,
  ): Promise<ProvisionedOrganization>;
  transition(
    tx: OrganizationExecutor,
    command: TransitionOrganizationCommand,
  ): Promise<OrganizationTransitionResult>;
}

const EMPTY_CONTEXT: AuditContext = {
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
};

function withDetail(base: AuditContext, detail: Readonly<Record<string, string>>): AuditContext {
  return { ...base, detail: { ...base.detail, ...detail } };
}

interface OrganizationStateRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
  readonly version: number;
}

export function createOrganizationService(
  options: OrganizationServiceOptions,
): OrganizationService {
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;
  const { publisher, audit } = options;

  function eventContext(command: {
    readonly correlationId: string;
    readonly causationId?: string | null;
  }): EventContext {
    return {
      eventId: newEventId(),
      correlationId: command.correlationId,
      causationId: command.causationId ?? null,
      occurredAt: now().toISOString(),
    };
  }

  /**
   * The audit record for an organization action.
   *
   * `tenantId` matches the event convention rather than being NULL. A NULL
   * tenant is writable but invisible to every tenant-scoped read, and these
   * records have to be readable — an organization console lists them, and a
   * restoring transition reads its own prior status back out of them.
   */
  function auditEntry(
    organizationId: string,
    action: OrganizationAuditAction,
    command: {
      readonly actor: AuditActor;
      readonly correlationId: string;
      readonly context?: AuditContext;
    },
    reason: string,
    detail: Readonly<Record<string, string>>,
  ): NewAuditRecord {
    const tenantId = organizationEventTenantId(organizationId);
    return {
      tenantId,
      organizationId,
      actorId: command.actor.id,
      actorKind: command.actor.kind,
      correlationId: command.correlationId,
      action,
      target: { kind: 'organization', id: organizationId, tenantId },
      result: 'success',
      reason,
      context: withDetail(command.context ?? EMPTY_CONTEXT, detail),
    };
  }

  async function readRecordedPreviousStatus(
    tx: OrganizationExecutor,
    organizationId: string,
    transition: OrganizationTransition,
  ): Promise<string | null> {
    const action = RESTORE_SOURCE_ACTION[transition];
    if (action === undefined) return null;

    const rows = await tx.query<{ previous_status: string | null }>(SELECT_RECORDED_PREVIOUS_SQL, [
      organizationId,
      organizationId,
      action,
    ]);
    return rows[0]?.previous_status ?? null;
  }

  function eventFor(
    transition: OrganizationTransition,
    organizationId: string,
    ctx: EventContext,
    reason: string,
  ): DomainEvent<unknown> | null {
    switch (transition) {
      case 'suspend':
        return organizationSuspended(ctx, {
          organizationId,
          reason,
          suspendedAt: ctx.occurredAt,
        });
      case 'reactivate':
        return organizationReactivated(ctx, { organizationId });
      case 'request_closure':
        return organizationClosureRequested(ctx, {
          organizationId,
          purgeAfter: new Date(
            Date.parse(ctx.occurredAt) + CLOSURE_WINDOW_DAYS * 24 * 60 * 60 * 1000,
          ).toISOString(),
        });
      case 'close':
        return organizationClosed(ctx, { organizationId, closedAt: ctx.occurredAt });
      // `payment_failed`, `payment_recovered` and `cancel_closure` define no
      // emitted event in the contract (`02-domain-design/organizations.md`
      // §"Domain Events"). The first two are REACTIONS to Commerce events —
      // re-emitting would echo them back. All three are still audited; adding
      // an event type is a registry change, which is Event Platform.
      case 'payment_failed':
      case 'payment_recovered':
      case 'cancel_closure':
        return null;
    }
  }

  return {
    async provision(tx, command) {
      const ctx = eventContext(command);

      let created: OrganizationStateRow | undefined;
      try {
        const rows = await tx.query<{ id: string; version: number }>(INSERT_ORGANIZATION_SQL, [
          command.slug,
          command.name,
          INITIAL_STATUS,
          command.actor.id,
        ]);
        const row = rows[0];
        if (row === undefined) {
          throw new OrganizationError(
            'OrganizationNotFound',
            'The organization insert returned no row; provisioning cannot continue.',
          );
        }
        created = {
          id: row.id,
          slug: command.slug,
          name: command.name,
          status: INITIAL_STATUS,
          version: row.version,
        };
      } catch (error: unknown) {
        // The database decides a slug race, not a prior SELECT — a check-then-act
        // would let two concurrent provisions both pass the check.
        if (isSlugConflict(error)) {
          throw new OrganizationError(
            'SlugAlreadyTaken',
            `Organization slug '${command.slug}' is already taken; slugs are globally unique and immutable.`,
          );
        }
        throw error;
      }

      const organizationId = created.id;

      // The first owner, ACTIVE immediately. An organization whose only owner is
      // still `invited` has no active owner, which is the state rule 2
      // (last-owner protection) exists to make impossible.
      const ownerRows = await tx.query<{ id: string }>(INSERT_OWNER_SQL, [
        organizationId,
        command.ownerUserId,
        command.actor.id,
      ]);
      const ownerMembershipId = ownerRows[0]?.id;
      if (ownerMembershipId === undefined) {
        throw new OrganizationError(
          'OrganizationNotFound',
          'The first owner membership insert returned no row; the organization would have no owner.',
        );
      }

      await audit.record(
        tx,
        auditEntry(
          organizationId,
          ORGANIZATION_AUDIT_ACTIONS.provision,
          command,
          command.reason ?? 'Organization provisioned.',
          { status: INITIAL_STATUS, ownerUserId: command.ownerUserId },
        ),
      );

      // Last, so that envelope and registry validation — which run inside
      // `publish`, before commit — roll the organization back with them.
      await publisher.publish(
        tx,
        organizationCreated(ctx, {
          organizationId,
          name: command.name,
          slug: command.slug,
          createdBy: command.ownerUserId,
        }),
      );

      return {
        organizationId,
        ownerMembershipId,
        ownerUserId: command.ownerUserId,
        status: INITIAL_STATUS,
        version: created.version,
      };
    },

    async transition(tx, command) {
      const rows = await tx.query<OrganizationStateRow>(SELECT_ORGANIZATION_SQL, [
        command.organizationId,
      ]);
      const current = rows[0];
      if (current === undefined) {
        // Cross-organization access is answered as absence, consistent with the
        // workspace rule: existence itself is not disclosed.
        throw new OrganizationError(
          'OrganizationNotFound',
          `Organization '${command.organizationId}' does not exist.`,
        );
      }
      if (!isOrganizationStatus(current.status)) {
        throw new OrganizationError(
          'InvalidTransition',
          `Organization '${command.organizationId}' holds unknown status '${current.status}'.`,
        );
      }

      const from: OrganizationStatus = current.status;
      assertTransitionAllowed(from, command.transition);

      const recordedPrevious = restoresPreviousStatus(command.transition)
        ? await readRecordedPreviousStatus(tx, command.organizationId, command.transition)
        : null;
      const next = resolveTarget(command.transition, recordedPrevious);

      const expectedVersion = command.expectedVersion ?? current.version;
      const updated = await tx.query<{ version: number }>(UPDATE_STATUS_SQL, [
        next,
        command.actor.id,
        command.organizationId,
        expectedVersion,
      ]);
      const version = updated[0]?.version;
      if (version === undefined) {
        throw new OrganizationError(
          'ConcurrentModification',
          `Organization '${command.organizationId}' changed under this transaction; expected version ${String(expectedVersion)}.`,
        );
      }

      const ctx = eventContext(command);

      // `previousStatus` is the whole point of this record: it is what a later
      // `reactivate` or `cancel_closure` reads back to restore.
      await audit.record(
        tx,
        auditEntry(
          command.organizationId,
          ORGANIZATION_AUDIT_ACTIONS[command.transition],
          command,
          command.reason,
          { [PREVIOUS_STATUS_KEY]: from, status: next, transition: command.transition },
        ),
      );

      const event = eventFor(command.transition, command.organizationId, ctx, command.reason);
      if (event !== null) {
        await publisher.publish(tx, event);
      }

      return {
        organizationId: command.organizationId,
        previousStatus: from,
        status: next,
        version,
        event,
      };
    },
  };
}
