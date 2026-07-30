/**
 * Credit Ledger Service — `04-platform/credits.md`.
 *
 * T3.4 delivers the ledger foundation and nothing above it: `append`, `read`,
 * and lookup by idempotency key. There is deliberately no balance here, no
 * `authorizeSpend`, no hold, and no settlement — "never compute balance by
 * summing the ledger on a request path" is a rule this module cannot break,
 * because it has no path that sums.
 *
 * ── Atomicity ───────────────────────────────────────────────────────────────
 * The ledger row, its audit record where one is required, and its outbox event
 * are written on ONE transaction handle. There is no commit in this module and
 * no second connection, so an entry that was published but not recorded — or
 * recorded but not published — cannot exist. `EventPublisher.publish` and
 * `AuditWriter.record` both REQUIRE the handle, so neither can be called
 * outside the transaction that makes it true (ADR-020).
 *
 * ── Connection context ──────────────────────────────────────────────────────
 * `credit_ledger_entries` carries the canonical tenant policy and the database
 * CHECKs `tenant_id = organization_id`. Ledger work therefore runs under
 * `withTenant({ tenantId: organizationId, organizationId })`, the same context
 * organization lifecycle work uses. Under a WORKSPACE tenant context every
 * write here is rejected by WITH CHECK, which is the intended outcome: the
 * credit account is organization-owned.
 */

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import type { AuditActorKind, AuditContext, AuditWriter } from '@contentos/security';
import { secureId } from '@contentos/security';

import {
  creditAdjusted,
  creditConsumed,
  creditExpired,
  creditGranted,
  creditRefunded,
  creditEventTenantId,
  type CreditEventContext,
} from './events.js';
import {
  assertValidAmount,
  isLedgerDirection,
  isLedgerEntryType,
  LedgerError,
  resolveDirection,
  type LedgerDirection,
  type LedgerEntry,
  type LedgerEntryType,
} from './ledger.js';

/**
 * The executable transaction shape.
 *
 * `contracts.Transaction` is an opaque brand so that package acquires no driver
 * dependency; the query surface is asserted here, at the layer that issues SQL.
 */
export interface LedgerExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

export interface LedgerActor {
  readonly id: string;
  readonly kind: AuditActorKind;
}

/** Audit actions are enumerated constants, never free text (`16-security/audit.md`). */
export const CREDIT_AUDIT_ACTIONS = {
  adjustment: 'credits.adjusted',
} as const;

/** The largest page the ledger will serve. */
export const MAX_LEDGER_PAGE = 200;
export const DEFAULT_LEDGER_PAGE = 50;

const ENTRY_COLUMNS = `
  id,
  tenant_id          AS "tenantId",
  organization_id    AS "organizationId",
  workspace_id       AS "workspaceId",
  entry_type         AS "entryType",
  amount::text       AS "amount",
  direction,
  idempotency_key    AS "idempotencyKey",
  reference_entry_id AS "referenceEntryId",
  reason,
  correlation_id     AS "correlationId",
  created_by         AS "createdBy",
  metadata,
  created_at         AS "createdAt"`;

/**
 * The append.
 *
 * `ON CONFLICT DO NOTHING` rather than a prior SELECT: a check-then-act would
 * let two concurrent retries of the same AI call both pass the check and charge
 * twice. The constraint decides, and an insert that hit the conflict returns no
 * row — which is how the caller learns to converge on the existing entry rather
 * than by catching an error after the audit row was already written.
 */
const INSERT_ENTRY_SQL = `
  INSERT INTO credit_ledger_entries (
    tenant_id, organization_id, workspace_id, entry_type, amount, direction,
    idempotency_key, reference_entry_id, reason, correlation_id, created_by, metadata
  ) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING ${ENTRY_COLUMNS}`;

const SELECT_BY_IDEMPOTENCY_KEY_SQL = `
  SELECT ${ENTRY_COLUMNS}
    FROM credit_ledger_entries
   WHERE tenant_id = $1 AND idempotency_key = $2`;

const SELECT_BY_ID_SQL = `
  SELECT ${ENTRY_COLUMNS}
    FROM credit_ledger_entries
   WHERE tenant_id = $1 AND id = $2`;

/**
 * Keyset pagination on `(created_at, id)`.
 *
 * OFFSET degrades linearly and, on an append-only table under concurrent
 * writes, skips or repeats rows as earlier pages shift. `(created_at DESC, id
 * DESC)` matches `ix_credit_ledger_entries__tenant_created` and `id` is a
 * uuidv7, so the pair is a total order even when two entries share a timestamp.
 */
const SELECT_PAGE_SQL = `
  SELECT ${ENTRY_COLUMNS}
    FROM credit_ledger_entries
   WHERE tenant_id = $1
     AND ($2::uuid IS NULL OR workspace_id = $2::uuid)
     AND ($3::timestamptz IS NULL
          OR (created_at, id) < ($3::timestamptz, $4::uuid))
   ORDER BY created_at DESC, id DESC
   LIMIT $5`;

interface LedgerRow {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly workspaceId: string | null;
  readonly entryType: string;
  readonly amount: string;
  readonly direction: string;
  readonly idempotencyKey: string | null;
  readonly referenceEntryId: string | null;
  readonly reason: string;
  readonly correlationId: string;
  readonly createdBy: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string | Date;
}

/**
 * The row as the database returned it, narrowed to the model's types.
 *
 * `entry_type` and `direction` are CHECK-constrained columns, so a value
 * outside the vocabulary means the schema and this module have diverged. That
 * is worth failing on rather than widening the type to absorb.
 */
function toEntry(row: LedgerRow): LedgerEntry {
  if (!isLedgerEntryType(row.entryType)) {
    throw new LedgerError(
      'InvalidEntryType',
      `Ledger row ${row.id} holds unknown entry type '${row.entryType}'.`,
    );
  }
  if (!isLedgerDirection(row.direction)) {
    throw new LedgerError(
      'InvalidDirection',
      `Ledger row ${row.id} holds unknown direction '${row.direction}'.`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    entryType: row.entryType,
    amount: row.amount,
    direction: row.direction,
    idempotencyKey: row.idempotencyKey,
    referenceEntryId: row.referenceEntryId,
    reason: row.reason,
    correlationId: row.correlationId,
    createdBy: row.createdBy,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt,
  };
}

export interface AppendEntryCommand {
  readonly organizationId: string;
  /** Required for `consumption`, rejected for every other type. */
  readonly workspaceId?: string | null;
  readonly entryType: LedgerEntryType;
  /** Decimal string, non-negative. Never a number — see `ledger.ts`. */
  readonly amount: string;
  /** Required for `adjustment`; a contradiction for any other type. */
  readonly direction?: LedgerDirection;
  readonly idempotencyKey?: string | null;
  readonly referenceEntryId?: string | null;
  /** Mandatory. A ledger movement nobody wrote a reason for cannot be reviewed. */
  readonly reason: string;
  readonly actor: LedgerActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly context?: AuditContext;
}

export interface AppendResult {
  readonly entry: LedgerEntry;
  /**
   * False when the idempotency key had already been used and this call
   * converged on the existing entry. No second row, no second event.
   */
  readonly created: boolean;
  /** Null on convergence: the event was published by the call that won. */
  readonly event: DomainEvent<unknown> | null;
}

export interface LedgerPageQuery {
  readonly organizationId: string;
  /** Attribution filter. Omitted, the whole organization's ledger is read. */
  readonly workspaceId?: string | null;
  readonly limit?: number;
  readonly cursor?: LedgerCursor | null;
}

/** Position in a `(created_at DESC, id DESC)` scan. */
export interface LedgerCursor {
  readonly createdAt: string;
  readonly id: string;
}

export interface LedgerPage {
  readonly entries: readonly LedgerEntry[];
  /** Null when the page was not full — there is nothing after it. */
  readonly nextCursor: LedgerCursor | null;
}

export interface CreditLedgerServiceOptions {
  readonly publisher: EventPublisher;
  readonly audit: AuditWriter;
  /** Server clock. Never client-supplied. */
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

export interface CreditLedgerService {
  append(tx: LedgerExecutor, command: AppendEntryCommand): Promise<AppendResult>;
  read(tx: LedgerExecutor, query: LedgerPageQuery): Promise<LedgerPage>;
  findByIdempotencyKey(
    tx: LedgerExecutor,
    organizationId: string,
    idempotencyKey: string,
  ): Promise<LedgerEntry | null>;
  findById(
    tx: LedgerExecutor,
    organizationId: string,
    entryId: string,
  ): Promise<LedgerEntry | null>;
}

const EMPTY_CONTEXT: AuditContext = {
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
};

/** Only `consumption` is attributed to a workspace. */
function assertWorkspaceShape(entryType: LedgerEntryType, workspaceId: string | null): void {
  if (entryType === 'consumption' && workspaceId === null) {
    throw new LedgerError(
      'WorkspaceRequired',
      'A consumption entry must name the workspace the work happened in; that attribution is what makes per-client reporting possible.',
    );
  }
  if (entryType !== 'consumption' && workspaceId !== null) {
    throw new LedgerError(
      'WorkspaceNotAllowed',
      `Entry type '${entryType}' is an organization-level movement and cannot be attributed to a workspace.`,
    );
  }
}

export function createCreditLedgerService(
  options: CreditLedgerServiceOptions,
): CreditLedgerService {
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;
  const { publisher, audit } = options;

  function eventFor(entry: LedgerEntry, ctx: CreditEventContext): DomainEvent<unknown> {
    const base = {
      entryId: entry.id,
      organizationId: entry.organizationId,
      amount: entry.amount,
    };
    switch (entry.entryType) {
      case 'grant':
        return creditGranted(ctx, { ...base, direction: 'credit' });
      case 'consumption':
        // `assertWorkspaceShape` has already refused a consumption without one.
        return creditConsumed(ctx, {
          ...base,
          direction: 'debit',
          workspaceId: entry.workspaceId ?? '',
        });
      case 'refund':
        return creditRefunded(ctx, {
          ...base,
          direction: 'credit',
          referenceEntryId: entry.referenceEntryId,
        });
      case 'adjustment':
        return creditAdjusted(ctx, { ...base, direction: entry.direction });
      case 'expiry':
        return creditExpired(ctx, { ...base, direction: 'debit' });
    }
  }

  return {
    async append(tx, command) {
      const workspaceId = command.workspaceId ?? null;
      const idempotencyKey = command.idempotencyKey ?? null;

      if (!isLedgerEntryType(command.entryType)) {
        throw new LedgerError(
          'InvalidEntryType',
          `'${String(command.entryType)}' is not a ledger entry type.`,
        );
      }
      if (command.reason.trim() === '') {
        throw new LedgerError(
          'ReasonRequired',
          'Every ledger movement carries a reason; the row is immutable, so there is no later opportunity to explain it.',
        );
      }
      assertValidAmount(command.amount);
      assertWorkspaceShape(command.entryType, workspaceId);
      const direction = resolveDirection(command.entryType, command.direction);

      const tenantId = creditEventTenantId(command.organizationId);
      const inserted = await tx.query<LedgerRow>(INSERT_ENTRY_SQL, [
        tenantId,
        workspaceId,
        command.entryType,
        command.amount,
        direction,
        idempotencyKey,
        command.referenceEntryId ?? null,
        command.reason,
        command.correlationId,
        command.actor.id,
        JSON.stringify(command.metadata ?? {}),
      ]);

      const row = inserted[0];
      if (row === undefined) {
        // The key was already used. Converge on the winner rather than failing:
        // a retried AI call is not an error, it is the same charge arriving
        // twice. No second row, no second event, no second audit record.
        if (idempotencyKey === null) {
          throw new LedgerError(
            'EntryNotFound',
            'The ledger insert returned no row and no idempotency key was supplied, so there is nothing to converge on.',
          );
        }
        const existing = await tx.query<LedgerRow>(SELECT_BY_IDEMPOTENCY_KEY_SQL, [
          tenantId,
          idempotencyKey,
        ]);
        const winner = existing[0];
        if (winner === undefined) {
          throw new LedgerError(
            'DuplicateIdempotencyKey',
            `Idempotency key '${idempotencyKey}' conflicted but no entry holds it; the ledger and its unique index disagree.`,
          );
        }
        return { entry: toEntry(winner), created: false, event: null };
      }

      const entry = toEntry(row);

      // Adjustments, and only adjustments, are audited: "produce both a ledger
      // row and an audit row in one transaction" (credits.md §Security). The
      // other four types are machine-generated at 10⁹ scale and the ledger IS
      // their record — duplicating every consumption into `audit_log` would
      // double the write volume of the highest-volume path in the platform to
      // record what the immutable row beside it already says.
      if (entry.entryType === 'adjustment') {
        await audit.record(tx, {
          tenantId,
          organizationId: entry.organizationId,
          actorId: command.actor.id,
          actorKind: command.actor.kind,
          correlationId: command.correlationId,
          action: CREDIT_AUDIT_ACTIONS.adjustment,
          target: { kind: 'credit_ledger_entry', id: entry.id, tenantId },
          result: 'success',
          reason: entry.reason,
          context: {
            ...(command.context ?? EMPTY_CONTEXT),
            detail: {
              ...(command.context ?? EMPTY_CONTEXT).detail,
              entryType: entry.entryType,
              direction: entry.direction,
              amount: entry.amount,
            },
          },
        });
      }

      // Last, so that envelope and registry validation — which run inside
      // `publish`, before commit — roll the ledger row back with them.
      const event = eventFor(entry, {
        eventId: newEventId(),
        correlationId: command.correlationId,
        causationId: command.causationId ?? null,
        occurredAt: now().toISOString(),
      });
      await publisher.publish(tx, event);

      return { entry, created: true, event };
    },

    async read(tx, query) {
      // "An unbounded history request is refused rather than served slowly"
      // (credits.md §Performance). Clamped rather than rejected: the caller
      // asked for more than a page, and a page is what the API promises.
      const requested = query.limit ?? DEFAULT_LEDGER_PAGE;
      const limit = Math.max(1, Math.min(requested, MAX_LEDGER_PAGE));

      const rows = await tx.query<LedgerRow>(SELECT_PAGE_SQL, [
        creditEventTenantId(query.organizationId),
        query.workspaceId ?? null,
        query.cursor?.createdAt ?? null,
        query.cursor?.id ?? null,
        limit,
      ]);

      const entries = rows.map(toEntry);
      const last = entries.at(-1);
      return {
        entries,
        nextCursor:
          entries.length === limit && last !== undefined
            ? { createdAt: last.createdAt, id: last.id }
            : null,
      };
    },

    async findByIdempotencyKey(tx, organizationId, idempotencyKey) {
      const rows = await tx.query<LedgerRow>(SELECT_BY_IDEMPOTENCY_KEY_SQL, [
        creditEventTenantId(organizationId),
        idempotencyKey,
      ]);
      const row = rows[0];
      return row === undefined ? null : toEntry(row);
    },

    async findById(tx, organizationId, entryId) {
      const rows = await tx.query<LedgerRow>(SELECT_BY_ID_SQL, [
        creditEventTenantId(organizationId),
        entryId,
      ]);
      const row = rows[0];
      return row === undefined ? null : toEntry(row);
    },
  };
}
