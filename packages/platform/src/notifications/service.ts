/**
 * The Notification Service — `04-platform/notifications.md`.
 *
 * The record and its delivery outcome. No dispatch, no adapter, no retry
 * engine: "a notification failure never fails the operation that triggered it",
 * and nothing here is on a producing service's path in the first place.
 *
 * ── The record is immutable except for whether it arrived ───────────────────
 * `type`, `payload`, `tenant_id` and `created_at` cannot be rewritten by the
 * application role at all — table-level UPDATE is revoked and re-granted on the
 * four delivery columns (migration 0024). This module cannot violate that even
 * by accident, which is the point: what a notification SAID is evidence, and
 * "were they told?" is a question delivery records exist to answer.
 *
 * ── Creation is idempotent by construction ──────────────────────────────────
 * `UNIQUE (tenant_id, dedupe_key)` with `ON CONFLICT DO NOTHING` — the same
 * shape the ledger uses. A redelivered event produces one notification, and the
 * caller learns which by whether a row came back rather than by catching an
 * error after it had already acted.
 *
 * ── No retry engine ─────────────────────────────────────────────────────────
 * `markFailed` records an outcome; it does not schedule anything. Retry belongs
 * to the channel adapters, which do not exist. A retry loop here would be a
 * second delivery mechanism competing with the one that eventually arrives.
 */

import type { Transaction } from '@contentos/contracts';
import type { AuditActorKind, AuditContext, AuditWriter } from '@contentos/security';

import {
  NotificationError,
  type NotificationRegistry,
  type NotificationChannel,
} from './registry.js';

export interface NotificationExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

/**
 * The states reachable without a channel adapter.
 *
 * `notifications.md` also names `sent`, `bounced` and `suppressed`. Each needs
 * a delivery attempt or a preference to have happened, and a state nothing can
 * enter is a vocabulary nobody can trust.
 */
export const NOTIFICATION_STATUSES = ['pending', 'delivered', 'failed'] as const;

export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export function isNotificationStatus(value: string): value is NotificationStatus {
  return (NOTIFICATION_STATUSES as readonly string[]).includes(value);
}

export interface NotificationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  /** Null for an account-level notification. */
  readonly workspaceId: string | null;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly status: NotificationStatus;
  readonly dedupeKey: string;
  readonly correlationId: string;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly failedAt: string | null;
  readonly failureReason: string | null;
}

export interface NotificationActor {
  readonly id: string;
  readonly kind: AuditActorKind;
}

/** Audit actions are enumerated constants, never free text. */
export const NOTIFICATION_AUDIT_ACTIONS = {
  delivery_failed: 'notification.delivery_failed',
} as const;

/** The largest page the inbox will serve. */
export const MAX_NOTIFICATION_PAGE = 200;
export const DEFAULT_NOTIFICATION_PAGE = 50;

const COLUMNS = `
  id,
  tenant_id       AS "tenantId",
  organization_id AS "organizationId",
  workspace_id    AS "workspaceId",
  type,
  payload,
  status,
  dedupe_key      AS "dedupeKey",
  correlation_id  AS "correlationId",
  created_at      AS "createdAt",
  delivered_at    AS "deliveredAt",
  failed_at       AS "failedAt",
  failure_reason  AS "failureReason"`;

/**
 * `ON CONFLICT DO NOTHING` rather than a prior SELECT: a check-then-act would
 * let two concurrent deliveries of one event both pass the check. The
 * constraint decides, and an insert that hit the conflict returns no row.
 */
const INSERT_SQL = `
  INSERT INTO notifications (
    tenant_id, organization_id, workspace_id, type, payload,
    dedupe_key, correlation_id
  ) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
  ON CONFLICT (tenant_id, dedupe_key) DO NOTHING
  RETURNING ${COLUMNS}`;

const SELECT_BY_DEDUPE_SQL = `
  SELECT ${COLUMNS} FROM notifications WHERE tenant_id = $1 AND dedupe_key = $2`;

const SELECT_BY_ID_SQL = `
  SELECT ${COLUMNS} FROM notifications WHERE tenant_id = $1 AND id = $2`;

/**
 * Keyset pagination on `(created_at, id)`.
 *
 * OFFSET skips or repeats rows as earlier pages shift under concurrent writes,
 * and an inbox is written to while it is being read. `id` is a uuidv7, so the
 * pair is a total order even when two notifications share a timestamp.
 */
const SELECT_PAGE_SQL = `
  SELECT ${COLUMNS}
    FROM notifications
   WHERE tenant_id = $1
     AND ($2::uuid IS NULL OR workspace_id = $2::uuid)
     AND ($3::text IS NULL OR status = $3::text)
     AND ($4::timestamptz IS NULL
          OR (created_at, id) < ($4::timestamptz, $5::uuid))
   ORDER BY created_at DESC, id DESC
   LIMIT $6`;

/**
 * Guarded transitions: `status = 'pending'` in the predicate.
 *
 * A second call matches nothing, which is what makes both marks idempotent
 * without a read-then-write, and what stops a late delivery confirmation
 * overwriting a recorded failure.
 */
const MARK_DELIVERED_SQL = `
  UPDATE notifications
     SET status = 'delivered', delivered_at = now()
   WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
  RETURNING ${COLUMNS}`;

const MARK_FAILED_SQL = `
  UPDATE notifications
     SET status = 'failed', failed_at = now(), failure_reason = $3
   WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
  RETURNING ${COLUMNS}`;

interface Row {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly workspaceId: string | null;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>> | null;
  readonly status: string;
  readonly dedupeKey: string;
  readonly correlationId: string;
  readonly createdAt: string | Date;
  readonly deliveredAt: string | Date | null;
  readonly failedAt: string | Date | null;
  readonly failureReason: string | null;
}

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);
const isoOrNull = (value: string | Date | null): string | null =>
  value === null ? null : iso(value);

function toRecord(row: Row): NotificationRecord {
  if (!isNotificationStatus(row.status)) {
    throw new NotificationError(
      'InvalidDeclaration',
      `Notification ${row.id} holds unknown status '${row.status}'; the schema and this module have diverged.`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    type: row.type,
    payload: row.payload ?? {},
    status: row.status,
    dedupeKey: row.dedupeKey,
    correlationId: row.correlationId,
    createdAt: iso(row.createdAt),
    deliveredAt: isoOrNull(row.deliveredAt),
    failedAt: isoOrNull(row.failedAt),
    failureReason: row.failureReason,
  };
}

export interface CreateNotificationCommand {
  readonly organizationId: string;
  /** Omitted for an account-level notification. */
  readonly workspaceId?: string | null;
  readonly type: string;
  /**
   * Identifiers and short scalars only. "A notification says 'the quality gate
   * blocked article X with 3 issues'; the detail is behind a link requiring
   * authorization."
   */
  readonly payload?: Readonly<Record<string, unknown>>;
  /** Usually the producing event's id: one event, one notification. */
  readonly dedupeKey: string;
  readonly correlationId: string;
}

export interface CreateNotificationResult {
  readonly notification: NotificationRecord;
  /** False when the dedupe key had already been used and this call converged. */
  readonly created: boolean;
}

export interface NotificationPageQuery {
  readonly organizationId: string;
  readonly workspaceId?: string | null;
  readonly status?: NotificationStatus | null;
  readonly limit?: number;
  readonly cursor?: NotificationCursor | null;
}

/** Position in a `(created_at DESC, id DESC)` scan. */
export interface NotificationCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface NotificationPage {
  readonly notifications: readonly NotificationRecord[];
  /** Null when the page was not full — there is nothing after it. */
  readonly nextCursor: NotificationCursor | null;
}

export interface MarkDeliveredCommand {
  readonly organizationId: string;
  readonly notificationId: string;
  readonly channel: NotificationChannel;
}

export interface MarkFailedCommand {
  readonly organizationId: string;
  readonly notificationId: string;
  readonly channel: NotificationChannel;
  /** Mandatory. A failure nobody wrote a reason for cannot be acted on. */
  readonly reason: string;
  readonly actor: NotificationActor;
  readonly correlationId: string;
  readonly context?: AuditContext;
}

export interface MarkResult {
  readonly notification: NotificationRecord;
  /** True when the notification was already terminal and this changed nothing. */
  readonly converged: boolean;
}

export interface NotificationServiceOptions {
  readonly registry: NotificationRegistry;
  readonly audit: AuditWriter;
}

export interface NotificationService {
  create(
    tx: NotificationExecutor,
    command: CreateNotificationCommand,
  ): Promise<CreateNotificationResult>;
  read(tx: NotificationExecutor, query: NotificationPageQuery): Promise<NotificationPage>;
  markDelivered(tx: NotificationExecutor, command: MarkDeliveredCommand): Promise<MarkResult>;
  markFailed(tx: NotificationExecutor, command: MarkFailedCommand): Promise<MarkResult>;
  findById(
    tx: NotificationExecutor,
    organizationId: string,
    notificationId: string,
  ): Promise<NotificationRecord | null>;
  findByDedupeKey(
    tx: NotificationExecutor,
    organizationId: string,
    dedupeKey: string,
  ): Promise<NotificationRecord | null>;
}

const EMPTY_CONTEXT: AuditContext = {
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
};

export function createNotificationService(
  options: NotificationServiceOptions,
): NotificationService {
  const { registry, audit } = options;

  async function load(
    tx: NotificationExecutor,
    organizationId: string,
    sql: string,
    key: string,
  ): Promise<NotificationRecord | null> {
    const rows = await tx.query<Row>(sql, [organizationId, key]);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  /** Shared by both marks: one guarded transition, converging when it is late. */
  async function mark(
    tx: NotificationExecutor,
    organizationId: string,
    notificationId: string,
    sql: string,
    params: readonly unknown[],
  ): Promise<MarkResult> {
    const rows = await tx.query<Row>(sql, [organizationId, notificationId, ...params]);
    const row = rows[0];
    if (row !== undefined) return { notification: toRecord(row), converged: false };

    // Either it does not exist, or it is already terminal. Those need different
    // answers: the first is a bug, the second is a repeated callback.
    const existing = await load(tx, organizationId, SELECT_BY_ID_SQL, notificationId);
    if (existing === null) {
      throw new NotificationError(
        'NotificationNotFound',
        `Notification '${notificationId}' does not exist.`,
      );
    }
    // Report the state it actually reached. Overwriting a recorded failure with
    // a late delivery would erase the evidence of the failure.
    return { notification: existing, converged: true };
  }

  return {
    async create(tx, command) {
      // The type must be declared. A notification nobody can explain is one
      // nobody can render, route, or decide a preference for.
      registry.require(command.type);
      if (command.dedupeKey.trim() === '') {
        throw new NotificationError(
          'InvalidDeclaration',
          'A notification needs a dedupe key; without one a redelivered event produces a second copy.',
        );
      }

      const workspaceId = command.workspaceId ?? null;
      const inserted = await tx.query<Row>(INSERT_SQL, [
        // The tenant is the organization for every class this increment
        // produces; ADR-029, and the column CHECK admits nothing else unless a
        // workspace is named as the tenant.
        command.organizationId,
        command.organizationId,
        workspaceId,
        command.type,
        JSON.stringify(command.payload ?? {}),
        command.dedupeKey,
        command.correlationId,
      ]);

      const row = inserted[0];
      if (row !== undefined) return { notification: toRecord(row), created: true };

      // The key was already used. Converge on the winner: a redelivered event
      // is not an error, it is the same notification arriving twice.
      const existing = await load(
        tx,
        command.organizationId,
        SELECT_BY_DEDUPE_SQL,
        command.dedupeKey,
      );
      if (existing === null) {
        throw new NotificationError(
          'NotificationNotFound',
          `Dedupe key '${command.dedupeKey}' conflicted but no notification holds it; the table and its unique index disagree.`,
        );
      }
      return { notification: existing, created: false };
    },

    async read(tx, query) {
      // Clamped rather than rejected: the caller asked for more than a page,
      // and a page is what an inbox promises.
      const requested = query.limit ?? DEFAULT_NOTIFICATION_PAGE;
      const limit = Math.max(1, Math.min(requested, MAX_NOTIFICATION_PAGE));

      const rows = await tx.query<Row>(SELECT_PAGE_SQL, [
        query.organizationId,
        query.workspaceId ?? null,
        query.status ?? null,
        query.cursor?.createdAt ?? null,
        query.cursor?.id ?? null,
        limit,
      ]);

      const notifications = rows.map(toRecord);
      const last = notifications.at(-1);
      return {
        notifications,
        nextCursor:
          notifications.length === limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      };
    },

    markDelivered(tx, command) {
      return mark(tx, command.organizationId, command.notificationId, MARK_DELIVERED_SQL, []);
    },

    async markFailed(tx, command) {
      if (command.reason.trim() === '') {
        throw new NotificationError(
          'InvalidDeclaration',
          'A delivery failure carries a reason; the record is evidence for "were they told?", and an unexplained failure answers nothing.',
        );
      }

      const result = await mark(
        tx,
        command.organizationId,
        command.notificationId,
        MARK_FAILED_SQL,
        [command.reason],
      );
      if (result.converged) return result;

      // Failures are audited and successes are not. "Delivery records are audit
      // evidence for 'were they told?', which matters for security alerts and
      // billing notices" — and an undelivered MANDATORY class is exactly the
      // case someone will need to reconstruct. Auditing every success instead
      // would double the write volume of the highest-volume path to record
      // that nothing went wrong.
      const declaration = registry.find(result.notification.type);
      await audit.record(tx, {
        tenantId: result.notification.tenantId,
        organizationId: result.notification.organizationId,
        actorId: command.actor.id,
        actorKind: command.actor.kind,
        correlationId: command.correlationId,
        action: NOTIFICATION_AUDIT_ACTIONS.delivery_failed,
        target: {
          kind: 'notification',
          id: result.notification.id,
          tenantId: result.notification.tenantId,
        },
        result: 'failure',
        reason: command.reason,
        context: {
          ...(command.context ?? EMPTY_CONTEXT),
          detail: {
            ...(command.context ?? EMPTY_CONTEXT).detail,
            notificationType: result.notification.type,
            channel: command.channel,
            mandatory: String(declaration?.mandatory ?? false),
          },
        },
      });

      return result;
    },

    findById(tx, organizationId, notificationId) {
      return load(tx, organizationId, SELECT_BY_ID_SQL, notificationId);
    },

    findByDedupeKey(tx, organizationId, dedupeKey) {
      return load(tx, organizationId, SELECT_BY_DEDUPE_SQL, dedupeKey);
    },
  };
}
