/**
 * AI usage and cost — the metering contracts. FROZEN.
 *
 * Spec: `08-ai-platform/cost-management.md` §"Token accounting",
 * §"Cost computation" and §Attribution.
 *
 * ── Why these live beside AIRequest and not in `packages/ai` ────────────────
 * Cost crosses the capability boundary. `04-platform/credits.md` consumes
 * consumption and `billing.md` reads cost, and both are feature packages that
 * may not import `packages/ai`. A usage record defined next to the meter would
 * be one the ledger could never name.
 *
 * ── The billing boundary, stated first because it is the one that matters ───
 * These contracts know tokens, models and dollars. They do not know what a
 * credit is worth, what a plan costs, how an invoice is produced, or whether a
 * customer has paid. That separation is why a pricing change never touches AI
 * execution code, and why an AI cost model change never touches an invoice.
 */

import type { TokenUsage } from './response.js';

/**
 * A cost, decomposed. Every amount is a decimal STRING.
 *
 * `03-database/tables.md` §1.1 and cost-management.md domain rule 12: amounts
 * are NUMERIC, and floating-point money is prohibited. A rounding error in
 * money is a compliance problem, not a bug — and the format here is
 * deliberately the credits ledger's own, so a total passes to it unconverted.
 */
export interface CostBreakdown {
  /** ISO 4217. */
  readonly currency: string;
  /** What the input tokens cost. Non-negative decimal, six places. */
  readonly promptCost: string;
  readonly completionCost: string;
  /**
   * What the cache-read tokens cost.
   *
   * Present now and normally '0.000000': providers that report prompt caching
   * price those tokens differently, and a field added later would leave every
   * historical row unable to say whether the saving was zero or unmeasured.
   */
  readonly cachedCost: string;
  /** The sum. Recorded rather than derived, so a reader never re-adds it. */
  readonly totalCost: string;
  /**
   * Which price table produced this.
   *
   * Versioned reference data: without the version, a provider price change
   * would silently rewrite the apparent cost of historical work and make
   * month-over-month margin analysis meaningless.
   */
  readonly pricingVersion: string;
  /**
   * True when no price table entry covered this model.
   *
   * The row is still produced, at zero, because a missing price is a
   * configuration defect that would otherwise appear as free work
   * (cost-management.md: "a cost row is never silently dropped").
   */
  readonly unpriced: boolean;
}

/**
 * Every dimension a cost question might be asked from.
 *
 * `correlationId` is the join that makes the rest work: one customer action
 * produces one correlation id, which appears on every call, cost row, span and
 * event it caused — so "this run cost $2.14" is a query, not an estimate. A
 * record without one is a defect (domain rule 9).
 */
export interface UsageMetadata {
  /** Workspace — ADR-017. */
  readonly tenantId: string;
  readonly organizationId: string;
  readonly correlationId: string;
  /**
   * Metering is keyed on `(idempotencyKey, attempt)`, so each genuine provider
   * call meters exactly once and a retried emission never double-charges.
   */
  readonly idempotencyKey: string;
  /** 1 for the first call. A retry is a real call and is metered like any other. */
  readonly attempt: number;
  readonly taskType: string;
  readonly providerId: string;
  readonly model: string;
  /** `'planning.outline@7'` — "did that prompt change cost more?" */
  readonly promptVersion: string | null;
  /** The workflow execution, where one drove the call. */
  readonly runId: string | null;
  /** Which step of it. "Which stage dominates cost?" */
  readonly stepId: string | null;
}

/**
 * One metered call.
 *
 * `tokens` is the existing `TokenUsage` rather than a second count of the same
 * three numbers.
 */
export interface AIUsageRecord {
  readonly tokens: TokenUsage;
  /**
   * True when the provider omitted counts and they were computed locally.
   *
   * Propagates all the way into the cost row and into reconciliation, where a
   * persistently high estimated share is itself an alert.
   */
  readonly estimated: boolean;
  /** Which tokenizer produced or verified the counts. */
  readonly tokenizer: string;
  /** Prompt-cache reads, where the provider reports them. */
  readonly cachedTokens: number;
  /**
   * Recorded so cache savings are measurable rather than invisible.
   * A cache hit costs zero provider tokens and is still a row.
   */
  readonly cacheHit: boolean;
  readonly cost: CostBreakdown;
  readonly metadata: UsageMetadata;
}

/**
 * What the meter produces — the record, and what a ledger would do with it.
 *
 * The ledger-facing half is separate from the measurement because they answer
 * different questions: the record says what happened, and this says what may be
 * charged for it. Nothing here charges anything.
 */
export interface UsageResult {
  readonly record: AIUsageRecord;
  /**
   * The key a ledger entry for this call would carry.
   *
   * Derived from the attempt, so two attempts of one request are two charges
   * and two deliveries of one attempt are one.
   */
  readonly ledgerIdempotencyKey: string;
  /** The amount a ledger would record, in its own format. '0.000000' when unpriced. */
  readonly chargeableAmount: string;
  /** False when nothing should reach a ledger: an unpriced or zero-cost call. */
  readonly chargeable: boolean;
}

/** The field names, frozen — the same discipline `ENVELOPE_FIELDS` applies. */
export const USAGE_METADATA_FIELDS = [
  'tenantId',
  'organizationId',
  'correlationId',
  'idempotencyKey',
  'attempt',
  'taskType',
  'providerId',
  'model',
  'promptVersion',
  'runId',
  'stepId',
] as const;

export type UsageMetadataField = (typeof USAGE_METADATA_FIELDS)[number];
