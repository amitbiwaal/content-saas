/**
 * The balance read model — `04-platform/credits.md` §Performance.
 *
 * "Balance is a read model, updated by the consumption consumer, with the
 *  ledger as the rebuild source. Computing balance by aggregating a 10⁹-row
 *  ledger on every request is not viable, and caching an aggregate without a
 *  rebuild path is worse."
 *
 * ── Never return an incorrect balance ───────────────────────────────────────
 * Every read compares the projection's watermark against the ledger BEFORE
 * trusting it. If a single entry has landed since, the projection is not used —
 * the read aggregates the ledger directly and says so in `source`.
 *
 * "Balance read model stale → Authorization falls back to a direct ledger
 *  aggregate for that organization — slower but correct. Never authorize from a
 *  known-stale model."
 *
 * That is the whole design: a stale projection produces a SLOW answer, never a
 * wrong one. A cache that cannot detect its own staleness is the failure this
 * avoids, and it is why the watermark is stored rather than a timestamp — a
 * clock says how old the row is, not whether anything happened.
 *
 * ── Available is not stored ─────────────────────────────────────────────────
 * `available = balance − sum(amount − consumed of OPEN holds)`. Holds reserve
 * by arithmetic, so releasing one is a state change and never a compensating
 * write. There is no second place credits can be double-counted or forgotten —
 * and the `− consumed` is what keeps a charge from being subtracted twice, once
 * as a ledger debit and again as a live reservation.
 */

import {
  formatAmount,
  parseAmount,
  subtractAmounts,
  sumOrZero,
  ZERO,
  type ScaledAmount,
} from './amount.js';

/** Where a balance figure came from. Surfaced so a fallback is observable. */
export type BalanceSource = 'projection' | 'ledger';

export type ThresholdState = 'ok' | 'low' | 'exhausted';

export interface BalanceReading {
  readonly organizationId: string;
  /** `credited − debited`, exact. */
  readonly balance: string;
  readonly credited: string;
  readonly debited: string;
  /** The unspent part of open holds — what is still committed elsewhere. */
  readonly held: string;
  /** `balance − held` — what a new authorization may draw on. */
  readonly available: string;
  readonly source: BalanceSource;
  /**
   * True when the projection was behind and the ledger was read instead. The
   * figure is correct either way; this is what the alert fires on.
   */
  readonly projectionStale: boolean;
  readonly entriesProjected: number;
}

export interface BalanceExecutor {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

/**
 * The projection row, if there is one. An organization with no ledger history
 * has none, and that is the normal state on day one.
 */
const SELECT_PROJECTION_SQL = `
  SELECT credited::text        AS credited,
         debited::text         AS debited,
         entries_projected     AS "entriesProjected",
         projected_through_at  AS "throughAt",
         projected_through_id  AS "throughId",
         threshold_state       AS "thresholdState"
    FROM credit_balances
   WHERE tenant_id = $1`;

/**
 * Has anything landed since the watermark?
 *
 * `(created_at, id)` is the ledger's own ordering and matches
 * `ix_credit_ledger_entries__tenant_created`, so this is a bounded index probe
 * rather than a scan. A NULL watermark means nothing has been projected, so any
 * row at all makes the projection stale.
 */
const SELECT_STALE_SQL = `
  SELECT EXISTS (
    SELECT 1
      FROM credit_ledger_entries
     WHERE tenant_id = $1
       AND ($2::timestamptz IS NULL
            OR (created_at, id) > ($2::timestamptz, $3::uuid))
  ) AS stale`;

/**
 * The rebuild source, WITH the watermark it was computed through.
 *
 * Exact: PostgreSQL sums NUMERIC without loss.
 *
 * The count and the watermark come from ONE statement on purpose. Read
 * separately they get separate snapshots under READ COMMITTED, and an entry
 * landing between them yields `entries = 0` alongside a non-null watermark —
 * which `ck_credit_balances__watermark_matches_count` rejects, failing a
 * projection for a reason that has nothing to do with the balance. A scalar
 * subquery shares the enclosing statement's snapshot, so the pair is always
 * consistent.
 */
const AGGREGATE_LEDGER_SQL = `
  SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::text AS credited,
         COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)::text  AS debited,
         count(*)::int                                                      AS entries,
         max(created_at)                                                    AS "throughAt",
         (SELECT last.id
            FROM credit_ledger_entries last
           WHERE last.tenant_id = $1
           ORDER BY last.created_at DESC, last.id DESC
           LIMIT 1)                                                         AS "throughId"
    FROM credit_ledger_entries
   WHERE tenant_id = $1`;

/**
 * The UNSPENT portion of open holds — `amount - consumed`, not `amount`.
 *
 * What is already consumed is a debit in the ledger, so counting the whole
 * reservation would subtract it twice. A pipeline that had spent most of its
 * hold would show its customer a balance far below the real one, and refuse
 * runs there were credits for.
 *
 * `state = 'held'` matches `ix_credit_holds__open_by_tenant`, so settled history
 * is never scanned — this runs on the critical path of every run start.
 */
const SUM_OPEN_HOLDS_SQL = `
  SELECT COALESCE(SUM(amount - consumed), 0)::text AS held
    FROM credit_holds
   WHERE tenant_id = $1 AND state = 'held'`;

const UPSERT_PROJECTION_SQL = `
  INSERT INTO credit_balances (
    tenant_id, organization_id, credited, debited, entries_projected,
    projected_through_at, projected_through_id, projected_at, updated_at
  ) VALUES ($1,$1,$2::numeric,$3::numeric,$4,$5,$6, now(), now())
  ON CONFLICT (tenant_id) DO UPDATE
     SET credited             = EXCLUDED.credited,
         debited              = EXCLUDED.debited,
         entries_projected    = EXCLUDED.entries_projected,
         projected_through_at = EXCLUDED.projected_through_at,
         projected_through_id = EXCLUDED.projected_through_id,
         projected_at         = now(),
         updated_at           = now()
  RETURNING threshold_state AS "thresholdState"`;

const UPDATE_THRESHOLD_SQL = `
  UPDATE credit_balances
     SET threshold_state = $2, updated_at = now()
   WHERE tenant_id = $1`;

interface ProjectionRow {
  readonly credited: string;
  readonly debited: string;
  readonly entriesProjected: number | string;
  readonly throughAt: string | Date | null;
  readonly throughId: string | null;
  readonly thresholdState: string;
}

interface AggregateRow {
  readonly credited: string;
  readonly debited: string;
  readonly entries: number;
  readonly throughAt: string | Date | null;
  readonly throughId: string | null;
}

const iso = (value: string | Date | null): string | null =>
  value instanceof Date ? value.toISOString() : value;

/**
 * Classify a balance against the configured threshold.
 *
 * Exhausted takes precedence: at or below zero there is nothing to warn about
 * being low, and reporting `low` there would understate the situation.
 */
export function classifyThreshold(
  balance: ScaledAmount,
  lowThreshold: ScaledAmount,
): ThresholdState {
  if (balance <= ZERO) return 'exhausted';
  if (balance <= lowThreshold) return 'low';
  return 'ok';
}

export function isThresholdState(value: string): value is ThresholdState {
  return value === 'ok' || value === 'low' || value === 'exhausted';
}

/**
 * Read a balance that is correct, whatever the projection's state.
 *
 * Three statements on the hot path when the projection is current: the row, the
 * staleness probe, the open-hold sum. Two more only when it is behind.
 */
export async function readBalance(
  tx: BalanceExecutor,
  organizationId: string,
): Promise<BalanceReading> {
  const projections = await tx.query<ProjectionRow>(SELECT_PROJECTION_SQL, [organizationId]);
  const projection = projections[0];

  const staleRows = await tx.query<{ stale: boolean }>(SELECT_STALE_SQL, [
    organizationId,
    projection === undefined ? null : iso(projection.throughAt),
    projection?.throughId ?? null,
  ]);
  const behind = staleRows[0]?.stale ?? true;
  const usable = projection !== undefined && !behind;

  let credited: ScaledAmount;
  let debited: ScaledAmount;
  let entries: number;

  if (usable) {
    credited = sumOrZero(projection.credited);
    debited = sumOrZero(projection.debited);
    entries = Number(projection.entriesProjected);
  } else {
    // The fallback. Slower, and always right.
    const rows = await tx.query<AggregateRow>(AGGREGATE_LEDGER_SQL, [organizationId]);
    const aggregate = rows[0];
    credited = sumOrZero(aggregate?.credited);
    debited = sumOrZero(aggregate?.debited);
    entries = aggregate?.entries ?? 0;
  }

  const heldRows = await tx.query<{ held: string }>(SUM_OPEN_HOLDS_SQL, [organizationId]);
  const held = sumOrZero(heldRows[0]?.held);
  const balance = subtractAmounts(credited, debited);

  return {
    organizationId,
    balance: formatAmount(balance),
    credited: formatAmount(credited),
    debited: formatAmount(debited),
    held: formatAmount(held),
    available: formatAmount(subtractAmounts(balance, held)),
    source: usable ? 'projection' : 'ledger',
    projectionStale: behind,
    entriesProjected: entries,
  };
}

export interface ProjectionResult {
  readonly organizationId: string;
  readonly balance: string;
  readonly entriesProjected: number;
  /** The threshold state before this projection ran. */
  readonly previousThreshold: ThresholdState;
  readonly threshold: ThresholdState;
  /** True only on a change — what "publish on transition" is decided by. */
  readonly transitioned: boolean;
}

/**
 * Rebuild the projection for one organization from the ledger.
 *
 * A full re-aggregate rather than an incremental delta. Applying deltas means
 * the read model can drift from the ledger if one is ever applied twice or lost,
 * and a drift in a financial projection is exactly what "the drift would be
 * undetectable" warns about. Re-aggregation is idempotent by construction: run
 * it any number of times, in any order, and the row equals the ledger.
 *
 * Writes the new threshold state in the SAME statement path as the sums, so a
 * transition cannot be recorded without the balance that caused it.
 */
export async function projectBalance(
  tx: BalanceExecutor,
  organizationId: string,
  lowThreshold: ScaledAmount,
): Promise<ProjectionResult> {
  const rows = await tx.query<AggregateRow>(AGGREGATE_LEDGER_SQL, [organizationId]);
  const aggregate = rows[0];
  const credited = sumOrZero(aggregate?.credited);
  const debited = sumOrZero(aggregate?.debited);
  const entries = aggregate?.entries ?? 0;

  const upserted = await tx.query<{ thresholdState: string }>(UPSERT_PROJECTION_SQL, [
    organizationId,
    formatAmount(credited),
    formatAmount(debited),
    entries,
    aggregate === undefined ? null : iso(aggregate.throughAt),
    aggregate?.throughId ?? null,
  ]);

  // The row's state BEFORE this call: ON CONFLICT DO UPDATE leaves
  // `threshold_state` alone, so RETURNING gives the value already there.
  const recorded = upserted[0]?.thresholdState ?? 'ok';
  const previousThreshold: ThresholdState = isThresholdState(recorded) ? recorded : 'ok';

  const balance = subtractAmounts(credited, debited);
  const threshold = classifyThreshold(balance, lowThreshold);

  if (threshold !== previousThreshold) {
    await tx.query(UPDATE_THRESHOLD_SQL, [organizationId, threshold]);
  }

  return {
    organizationId,
    balance: formatAmount(balance),
    entriesProjected: entries,
    previousThreshold,
    threshold,
    transitioned: threshold !== previousThreshold,
  };
}

/**
 * The reconciliation check: does the projection equal the ledger?
 *
 * "Any reconciliation discrepancy pages." This is what the daily job asserts,
 * and what the Sprint Gate asserts after a concurrent load.
 */
export async function reconcile(
  tx: BalanceExecutor,
  organizationId: string,
): Promise<{ readonly matches: boolean; readonly projected: string; readonly ledger: string }> {
  const projections = await tx.query<ProjectionRow>(SELECT_PROJECTION_SQL, [organizationId]);
  const projection = projections[0];

  const rows = await tx.query<AggregateRow>(AGGREGATE_LEDGER_SQL, [organizationId]);
  const aggregate = rows[0];
  const ledger = subtractAmounts(sumOrZero(aggregate?.credited), sumOrZero(aggregate?.debited));

  const projected =
    projection === undefined
      ? ZERO
      : subtractAmounts(sumOrZero(projection.credited), sumOrZero(projection.debited));

  return {
    matches: projected === ledger,
    projected: formatAmount(projected),
    ledger: formatAmount(ledger),
  };
}

/** Parse a configured threshold once, at construction, so a bad value fails early. */
export function parseThreshold(value: string): ScaledAmount {
  return parseAmount(value);
}
