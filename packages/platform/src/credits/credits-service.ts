/**
 * Credits Service — `04-platform/credits.md`.
 *
 * Hold → consume → settle over the immutable ledger. The ledger schema is
 * frozen; nothing here writes an entry except through `CreditLedgerService`.
 *
 * ── Where correctness actually comes from ───────────────────────────────────
 * Four mechanisms, none of them application logic that can be forgotten:
 *
 *   1. A transaction-scoped ADVISORY LOCK on the organization serialises
 *      authorization. Two parallel run starts cannot both read the same
 *      available balance and both reserve it.
 *   2. `UNIQUE (tenant_id, run_id)` makes a retried `authorizeSpend` converge
 *      on the hold it already created instead of reserving twice.
 *   3. `UNIQUE (tenant_id, idempotency_key)` on the ledger makes a retried
 *      consumption converge. `consumed` advances ONLY when that insert really
 *      wrote a row, so the hold and the ledger cannot disagree.
 *   4. `SELECT ... FOR UPDATE` on the hold serialises concurrent consumptions
 *      against it, and `CHECK (consumed <= amount)` is the database's own
 *      backstop on the reservation bound.
 *
 * Remove any one and the remaining three still refuse to double-charge; that
 * redundancy is deliberate for a financial path.
 *
 * ── Atomicity ───────────────────────────────────────────────────────────────
 * Every operation takes ONE transaction handle. There is no commit in this
 * module and no second connection, so a hold that was published but not
 * written — or a charge recorded without its event — cannot exist (ADR-020).
 *
 * ── Connection context ──────────────────────────────────────────────────────
 * Holds, balances and the ledger are all keyed `tenant_id = organization_id`
 * and the database CHECKs it. Every call therefore runs under
 * `withTenant({ tenantId: organizationId, organizationId })` (ADR-029).
 */

import type { DomainEvent, EventPublisher, Transaction } from '@contentos/contracts';
import { secureId } from '@contentos/security';

import {
  compareAmounts,
  formatAmount,
  parseAmount,
  parseSigned,
  subtractAmounts,
} from './amount.js';
import {
  parseThreshold,
  projectBalance,
  readBalance,
  type BalanceExecutor,
  type BalanceReading,
  type ProjectionResult,
} from './balance.js';
import type { CreditEventContext } from './events.js';
import {
  creditHeld,
  creditReleased,
  creditSettled,
  creditsExhausted,
  creditsLow,
  type ReleaseCause,
} from './hold-events.js';
import {
  assertFitsWithinHold,
  DEFAULT_HOLD_TTL_MS,
  HoldError,
  InsufficientCreditsError,
  isHoldState,
  type CreditHold,
} from './holds.js';
import type { LedgerEntry } from './ledger.js';
import type { CreditLedgerService, LedgerActor, LedgerExecutor } from './service.js';

export interface CreditsExecutor extends Transaction, BalanceExecutor {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

/**
 * Transaction-scoped advisory lock on the organization.
 *
 * `_xact_` matters: it releases on commit OR rollback, so a failed
 * authorization cannot strand it and there is no unlock path to forget. Two int
 * keys with the first naming the purpose, so it cannot collide with the
 * workspace-quota or membership locks elsewhere in the platform.
 */
const AUTHORIZE_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('credit_authorization'), hashtext($1))`;

const HOLD_COLUMNS = `
  id,
  tenant_id       AS "tenantId",
  organization_id AS "organizationId",
  workspace_id    AS "workspaceId",
  run_id          AS "runId",
  amount::text    AS "amount",
  consumed::text  AS "consumed",
  state,
  expires_at      AS "expiresAt",
  reason,
  correlation_id  AS "correlationId",
  created_by      AS "createdBy",
  metadata,
  created_at      AS "createdAt",
  settled_at      AS "settledAt",
  released_at     AS "releasedAt"`;

const SELECT_HOLD_BY_RUN_SQL = `
  SELECT ${HOLD_COLUMNS} FROM credit_holds WHERE tenant_id = $1 AND run_id = $2`;

/**
 * `FOR UPDATE` is what serialises concurrent consumptions against one hold.
 * Under READ COMMITTED the second waiter re-reads the committed row, so it sees
 * `consumed` already advanced rather than the value it queued behind.
 */
const SELECT_HOLD_FOR_UPDATE_SQL = `
  SELECT ${HOLD_COLUMNS} FROM credit_holds WHERE tenant_id = $1 AND id = $2 FOR UPDATE`;

const SELECT_HOLD_SQL = `SELECT ${HOLD_COLUMNS} FROM credit_holds WHERE tenant_id = $1 AND id = $2`;

const INSERT_HOLD_SQL = `
  INSERT INTO credit_holds (
    tenant_id, organization_id, workspace_id, run_id, amount, state,
    expires_at, reason, correlation_id, created_by, metadata
  ) VALUES ($1,$1,$2,$3,$4::numeric,'held',$5,$6,$7,$8,$9::jsonb)
  ON CONFLICT (tenant_id, run_id) DO NOTHING
  RETURNING ${HOLD_COLUMNS}`;

const ADVANCE_CONSUMED_SQL = `
  UPDATE credit_holds
     SET consumed = consumed + $3::numeric, updated_at = now()
   WHERE tenant_id = $1 AND id = $2 AND state = 'held'
  RETURNING ${HOLD_COLUMNS}`;

const SETTLE_HOLD_SQL = `
  UPDATE credit_holds
     SET state = 'settled', settled_at = now(), updated_at = now()
   WHERE tenant_id = $1 AND id = $2 AND state = 'held'
  RETURNING ${HOLD_COLUMNS}`;

const RELEASE_HOLD_SQL = `
  UPDATE credit_holds
     SET state = 'released', released_at = now(), updated_at = now()
   WHERE tenant_id = $1 AND id = $2 AND state = 'held'
  RETURNING ${HOLD_COLUMNS}`;

/**
 * Bulk release. Matching nothing is success, not an error — that is what makes
 * a suspension cascade converge when it is retried.
 */
const RELEASE_OPEN_HOLDS_SQL = `
  UPDATE credit_holds
     SET state = 'released', released_at = now(), updated_at = now()
   WHERE tenant_id = $1
     AND state = 'held'
     AND ($2::uuid IS NULL OR workspace_id = $2::uuid)
  RETURNING ${HOLD_COLUMNS}`;

const EXPIRE_HOLDS_SQL = `
  UPDATE credit_holds
     SET state = 'expired', released_at = now(), updated_at = now()
   WHERE tenant_id = $1 AND state = 'held' AND expires_at <= $2
  RETURNING ${HOLD_COLUMNS}`;

interface HoldRow {
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly amount: string;
  readonly consumed: string;
  readonly state: string;
  readonly expiresAt: string | Date;
  readonly reason: string;
  readonly correlationId: string;
  readonly createdBy: string | null;
  readonly metadata: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string | Date;
  readonly settledAt: string | Date | null;
  readonly releasedAt: string | Date | null;
}

const iso = (value: string | Date): string => (value instanceof Date ? value.toISOString() : value);
const isoOrNull = (value: string | Date | null): string | null =>
  value === null ? null : iso(value);

function toHold(row: HoldRow): CreditHold {
  if (!isHoldState(row.state)) {
    throw new HoldError(
      'InvalidHoldState',
      `Hold ${row.id} holds unknown state '${row.state}'; the schema and this module have diverged.`,
    );
  }
  return {
    id: row.id,
    tenantId: row.tenantId,
    organizationId: row.organizationId,
    workspaceId: row.workspaceId,
    runId: row.runId,
    amount: row.amount,
    consumed: row.consumed,
    state: row.state,
    expiresAt: iso(row.expiresAt),
    reason: row.reason,
    correlationId: row.correlationId,
    createdBy: row.createdBy,
    metadata: row.metadata ?? {},
    createdAt: iso(row.createdAt),
    settledAt: isoOrNull(row.settledAt),
    releasedAt: isoOrNull(row.releasedAt),
  };
}

export interface AuthorizeSpendCommand {
  readonly organizationId: string;
  readonly workspaceId: string;
  /** Idempotency key for the reservation. Temporal retries `authorizeSpend`. */
  readonly runId: string;
  /** The estimated MAXIMUM. This is the bound on worst-case spend. */
  readonly estimatedMax: string;
  readonly reason: string;
  readonly actor: LedgerActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly ttlMs?: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuthorizationResult {
  readonly hold: CreditHold;
  /** False when a retry converged on the reservation already made. */
  readonly created: boolean;
  readonly available: string;
  readonly event: DomainEvent<unknown> | null;
  /** Holds the TTL sweep reclaimed on the way in. */
  readonly expired: readonly CreditHold[];
}

export interface RecordConsumptionCommand {
  readonly organizationId: string;
  readonly holdId: string;
  readonly amount: string;
  /**
   * Derived from `(workflow_id, step, attempt-invariant)` so a Temporal retry
   * cannot double-charge (`credits.md` §Security). Required: an unkeyed
   * consumption has no way to converge.
   */
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly actor: LedgerActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ConsumptionResult {
  readonly entry: LedgerEntry;
  readonly hold: CreditHold;
  /** False when a retry converged on a charge already recorded. */
  readonly created: boolean;
  readonly events: readonly DomainEvent<unknown>[];
  readonly projection: ProjectionResult | null;
}

export interface CloseHoldCommand {
  readonly organizationId: string;
  readonly holdId: string;
  readonly actor: LedgerActor;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface ReleaseHoldCommand extends CloseHoldCommand {
  readonly cause: ReleaseCause;
}

export interface HoldClosureResult {
  readonly hold: CreditHold;
  /** True when the hold was already terminal and this call changed nothing. */
  readonly converged: boolean;
  readonly event: DomainEvent<unknown> | null;
}

export interface BulkReleaseCommand {
  readonly organizationId: string;
  /** Omitted, every open hold in the organization is released. */
  readonly workspaceId?: string | null;
  readonly cause: ReleaseCause;
  readonly correlationId: string;
  readonly causationId?: string | null;
}

export interface BulkReleaseResult {
  readonly released: readonly CreditHold[];
  readonly events: readonly DomainEvent<unknown>[];
}

export interface CreditsServiceOptions {
  readonly ledger: CreditLedgerService;
  readonly publisher: EventPublisher;
  /**
   * Balance at or below which `CreditsLow` fires. Parsed once here so a
   * malformed configuration fails at construction rather than on the first
   * customer's run start.
   */
  readonly lowBalanceThreshold: string;
  readonly holdTtlMs?: number;
  readonly now?: () => Date;
  readonly newEventId?: () => string;
}

export interface CreditsService {
  authorizeSpend(tx: CreditsExecutor, command: AuthorizeSpendCommand): Promise<AuthorizationResult>;
  recordConsumption(
    tx: CreditsExecutor,
    command: RecordConsumptionCommand,
  ): Promise<ConsumptionResult>;
  settle(tx: CreditsExecutor, command: CloseHoldCommand): Promise<HoldClosureResult>;
  release(tx: CreditsExecutor, command: ReleaseHoldCommand): Promise<HoldClosureResult>;
  /** The TTL sweep for one organization. */
  expireStaleHolds(
    tx: CreditsExecutor,
    organizationId: string,
    correlationId: string,
  ): Promise<BulkReleaseResult>;
  /** What a suspension does. Idempotent: a second run releases nothing. */
  releaseOpenHolds(tx: CreditsExecutor, command: BulkReleaseCommand): Promise<BulkReleaseResult>;
  balanceOf(tx: CreditsExecutor, organizationId: string): Promise<BalanceReading>;
  findHoldByRun(
    tx: CreditsExecutor,
    organizationId: string,
    runId: string,
  ): Promise<CreditHold | null>;
  findHold(tx: CreditsExecutor, organizationId: string, holdId: string): Promise<CreditHold | null>;
}

export function createCreditsService(options: CreditsServiceOptions): CreditsService {
  const now = options.now ?? ((): Date => new Date());
  const newEventId = options.newEventId ?? secureId;
  const ttlMs = options.holdTtlMs ?? DEFAULT_HOLD_TTL_MS;
  const lowThreshold = parseThreshold(options.lowBalanceThreshold);
  const { ledger, publisher } = options;

  function ctx(command: {
    readonly correlationId: string;
    readonly causationId?: string | null;
  }): CreditEventContext {
    return {
      eventId: newEventId(),
      correlationId: command.correlationId,
      causationId: command.causationId ?? null,
      occurredAt: now().toISOString(),
    };
  }

  const releasedEvent = (hold: CreditHold, cause: ReleaseCause, c: CreditEventContext) =>
    creditReleased(c, {
      holdId: hold.id,
      organizationId: hold.organizationId,
      workspaceId: hold.workspaceId,
      runId: hold.runId,
      amount: hold.amount,
      consumed: hold.consumed,
      cause,
    });

  /**
   * Reclaim holds whose TTL elapsed, publishing one release each.
   *
   * Run on the way into `authorizeSpend` as well as by the sweep: a stranded
   * hold reduces available balance invisibly, and the organization trying to
   * start a run is exactly who is harmed by it.
   */
  async function expire(
    tx: CreditsExecutor,
    organizationId: string,
    command: { readonly correlationId: string; readonly causationId?: string | null },
  ): Promise<BulkReleaseResult> {
    const rows = await tx.query<HoldRow>(EXPIRE_HOLDS_SQL, [organizationId, now().toISOString()]);
    const released = rows.map(toHold);
    const events: DomainEvent<unknown>[] = [];
    for (const hold of released) {
      const event = releasedEvent(hold, 'expired', ctx(command));
      await publisher.publish(tx, event);
      events.push(event);
    }
    return { released, events };
  }

  /**
   * Re-project and publish a threshold crossing if the state changed.
   *
   * Publishing lives here rather than at each call site so "only on transition"
   * is decided in ONE place — `credit_balances.threshold_state` is both the
   * memory and the guard, updated in this same transaction.
   */
  async function projectAndNotify(
    tx: CreditsExecutor,
    organizationId: string,
    command: { readonly correlationId: string; readonly causationId?: string | null },
  ): Promise<{ projection: ProjectionResult; events: readonly DomainEvent<unknown>[] }> {
    const projection = await projectBalance(tx, organizationId, lowThreshold);
    if (!projection.transitioned || projection.threshold === 'ok') {
      // Recovering to `ok` is recorded but not announced: there is no
      // `CreditsRecovered` in the contract, and inventing one would put an
      // undeclared type on the bus.
      return { projection, events: [] };
    }

    const payload = {
      organizationId,
      balance: projection.balance,
      threshold: formatAmount(lowThreshold),
      previousState: projection.previousThreshold,
    };
    const event =
      projection.threshold === 'exhausted'
        ? creditsExhausted(ctx(command), payload)
        : creditsLow(ctx(command), payload);
    await publisher.publish(tx, event);
    return { projection, events: [event] };
  }

  async function loadHold(
    tx: CreditsExecutor,
    organizationId: string,
    holdId: string,
    sql: string,
  ): Promise<CreditHold | null> {
    const rows = await tx.query<HoldRow>(sql, [organizationId, holdId]);
    const row = rows[0];
    return row === undefined ? null : toHold(row);
  }

  /** Shared by settle and release: both are one guarded transition. */
  async function close(
    tx: CreditsExecutor,
    command: CloseHoldCommand,
    sql: string,
    event: (hold: CreditHold, c: CreditEventContext) => DomainEvent<unknown>,
  ): Promise<HoldClosureResult> {
    const rows = await tx.query<HoldRow>(sql, [command.organizationId, command.holdId]);
    const row = rows[0];

    if (row === undefined) {
      // Either it does not exist, or it is already terminal. Those need
      // different answers: the first is a bug, the second is a retry.
      const existing = await loadHold(tx, command.organizationId, command.holdId, SELECT_HOLD_SQL);
      if (existing === null) {
        throw new HoldError('HoldNotFound', `Hold '${command.holdId}' does not exist.`);
      }
      // Converge, and report the state it actually reached. Overwriting a
      // release with a settle would hide that two deciders disagreed.
      return { hold: existing, converged: true, event: null };
    }

    const hold = toHold(row);
    const published = event(hold, ctx(command));
    await publisher.publish(tx, published);
    return { hold, converged: false, event: published };
  }

  return {
    async authorizeSpend(tx, command) {
      const requested = parseAmount(command.estimatedMax);

      // 1 · Serialise every authorization for this organization. Without it,
      // two parallel run starts read the same available balance and both
      // reserve it — the double-spend this protocol exists to prevent.
      await tx.query(AUTHORIZE_LOCK_SQL, [command.organizationId]);

      // 2 · Reclaim anything stranded, so a crashed orchestrator does not keep
      // this organization out of its own credits.
      const swept = await expire(tx, command.organizationId, command);

      // 3 · A retry converges on the reservation it already made. Safe as a
      // check-then-act ONLY because of the lock above; the unique constraint is
      // the backstop for anything that bypasses this path.
      const existing = await tx.query<HoldRow>(SELECT_HOLD_BY_RUN_SQL, [
        command.organizationId,
        command.runId,
      ]);
      const priorRow = existing[0];
      if (priorRow !== undefined) {
        const reading = await readBalance(tx, command.organizationId);
        return {
          hold: toHold(priorRow),
          created: false,
          available: reading.available,
          event: null,
          expired: swept.released,
        };
      }

      // 4 · Correct even if the projection is behind — `readBalance` falls back
      // to aggregating the ledger rather than answering from a stale row.
      //
      // `available` is signed: an out-of-order correction can put an
      // organization below zero, and clamping that to zero here would report a
      // shortfall smaller than the one actually owed.
      const reading = await readBalance(tx, command.organizationId);
      const available = parseSigned(reading.available);

      if (compareAmounts(available, requested) === -1) {
        // Refused BEFORE any provider call. This is the 402.
        throw new InsufficientCreditsError(
          reading.available,
          command.estimatedMax,
          formatAmount(subtractAmounts(requested, available)),
        );
      }

      const expiresAt = new Date(now().getTime() + (command.ttlMs ?? ttlMs)).toISOString();
      const inserted = await tx.query<HoldRow>(INSERT_HOLD_SQL, [
        command.organizationId,
        command.workspaceId,
        command.runId,
        command.estimatedMax,
        expiresAt,
        command.reason,
        command.correlationId,
        command.actor.id,
        JSON.stringify(command.metadata ?? {}),
      ]);

      const row = inserted[0];
      if (row === undefined) {
        // The unique constraint fired despite the lock — another path created
        // it. Converge rather than fail: the reservation exists either way.
        const raced = await tx.query<HoldRow>(SELECT_HOLD_BY_RUN_SQL, [
          command.organizationId,
          command.runId,
        ]);
        const winner = raced[0];
        if (winner === undefined) {
          throw new HoldError(
            'HoldNotFound',
            `Hold for run '${command.runId}' conflicted but no hold holds that run id; credit_holds and its unique index disagree.`,
          );
        }
        return {
          hold: toHold(winner),
          created: false,
          available: reading.available,
          event: null,
          expired: swept.released,
        };
      }

      const hold = toHold(row);
      const event = creditHeld(ctx(command), {
        holdId: hold.id,
        organizationId: hold.organizationId,
        workspaceId: hold.workspaceId,
        runId: hold.runId,
        amount: hold.amount,
        expiresAt: hold.expiresAt,
      });
      await publisher.publish(tx, event);

      return {
        hold,
        created: true,
        available: formatAmount(subtractAmounts(available, requested)),
        event,
        expired: swept.released,
      };
    },

    async recordConsumption(tx, command) {
      const amount = parseAmount(command.amount);

      // The row lock is what makes two concurrent charges against one hold
      // serialise; the second re-reads the committed `consumed` rather than the
      // value it queued behind.
      const hold = await loadHold(
        tx,
        command.organizationId,
        command.holdId,
        SELECT_HOLD_FOR_UPDATE_SQL,
      );
      if (hold === null) {
        throw new HoldError(
          'HoldNotFound',
          `Hold '${command.holdId}' does not exist. Every code path that spends must hold a valid hold id.`,
        );
      }
      // A retry converges BEFORE the bound is checked, and the order matters.
      // The final charge of a run fills its hold exactly, so on retry the
      // remaining headroom is zero and the bound would reject the very charge
      // it already accepted — turning a Temporal retry of the last AI call into
      // an error instead of a no-op.
      //
      // Safe as a check-then-act because the row lock above serialises every
      // consumption against this hold; the ledger's unique index is still the
      // backstop for anything arriving by another path.
      const alreadyRecorded = await ledger.findByIdempotencyKey(
        tx as unknown as LedgerExecutor,
        command.organizationId,
        command.idempotencyKey,
      );
      if (alreadyRecorded !== null) {
        return { entry: alreadyRecorded, hold, created: false, events: [], projection: null };
      }

      assertFitsWithinHold(hold, amount);

      // The ledger decides whether this charge is new. Its unique index is the
      // single source of truth for "did this happen", which is why `consumed`
      // is advanced from the result rather than from the request.
      const appended = await ledger.append(tx as unknown as LedgerExecutor, {
        organizationId: command.organizationId,
        workspaceId: hold.workspaceId,
        entryType: 'consumption',
        amount: command.amount,
        idempotencyKey: command.idempotencyKey,
        reason: command.reason,
        actor: command.actor,
        correlationId: command.correlationId,
        ...(command.causationId === undefined ? {} : { causationId: command.causationId }),
        metadata: { ...(command.metadata ?? {}), holdId: hold.id, runId: hold.runId },
      });

      if (!appended.created) {
        // A retry of a charge already recorded. Nothing moves: no second entry,
        // no second event, and `consumed` stays where the winning call left it.
        return {
          entry: appended.entry,
          hold,
          created: false,
          events: [],
          projection: null,
        };
      }

      const advanced = await tx.query<HoldRow>(ADVANCE_CONSUMED_SQL, [
        command.organizationId,
        command.holdId,
        command.amount,
      ]);
      const advancedRow = advanced[0];
      if (advancedRow === undefined) {
        // The hold closed between the lock and this update. Impossible while
        // the row lock is held, so it means the invariant is broken — fail
        // rather than leave a charge recorded against a closed reservation.
        throw new HoldError(
          'HoldNotOpen',
          `Hold '${command.holdId}' closed while a consumption was being recorded against it.`,
        );
      }

      const { projection, events: thresholdEvents } = await projectAndNotify(
        tx,
        command.organizationId,
        command,
      );

      return {
        entry: appended.entry,
        hold: toHold(advancedRow),
        created: true,
        events: [...(appended.event === null ? [] : [appended.event]), ...thresholdEvents],
        projection,
      };
    },

    settle(tx, command) {
      return close(tx, command, SETTLE_HOLD_SQL, (hold, c) =>
        creditSettled(c, {
          holdId: hold.id,
          organizationId: hold.organizationId,
          workspaceId: hold.workspaceId,
          runId: hold.runId,
          amount: hold.amount,
          consumed: hold.consumed,
          // The remainder was never deducted — leaving `held` releases it by
          // arithmetic, so there is no compensating write to get wrong.
          released: formatAmount(
            subtractAmounts(parseAmount(hold.amount), parseAmount(hold.consumed)),
          ),
        }),
      );
    },

    release(tx, command) {
      return close(tx, command, RELEASE_HOLD_SQL, (hold, c) =>
        releasedEvent(hold, command.cause, c),
      );
    },

    expireStaleHolds(tx, organizationId, correlationId) {
      return expire(tx, organizationId, { correlationId });
    },

    async releaseOpenHolds(tx, command) {
      const rows = await tx.query<HoldRow>(RELEASE_OPEN_HOLDS_SQL, [
        command.organizationId,
        command.workspaceId ?? null,
      ]);
      const released = rows.map(toHold);
      const events: DomainEvent<unknown>[] = [];
      for (const hold of released) {
        const event = releasedEvent(hold, command.cause, ctx(command));
        await publisher.publish(tx, event);
        events.push(event);
      }
      return { released, events };
    },

    balanceOf(tx, organizationId) {
      return readBalance(tx, organizationId);
    },

    async findHoldByRun(tx, organizationId, runId) {
      const rows = await tx.query<HoldRow>(SELECT_HOLD_BY_RUN_SQL, [organizationId, runId]);
      const row = rows[0];
      return row === undefined ? null : toHold(row);
    },

    findHold(tx, organizationId, holdId) {
      return loadHold(tx, organizationId, holdId, SELECT_HOLD_SQL);
    },
  };
}
