/**
 * The usage recorder.
 *
 * Turns one provider response into one canonical usage record. It computes, it
 * validates, and it returns — it writes nothing. Persistence and the
 * `CreditConsumed` emission belong to the increment that owns the table and the
 * outbox transaction, and a recorder that wrote would make metering a database
 * concern rather than an arithmetic one.
 *
 * ── It does not bill ────────────────────────────────────────────────────────
 * It knows tokens, models and dollars. It does not know what a credit is worth,
 * what a plan costs, or whether a customer has paid. `chargeableAmount` is what
 * a ledger WOULD record; nothing here records it.
 */

import type {
  AIResponse,
  AIUsageRecord,
  TokenUsage,
  UsageMetadata,
  UsageResult,
} from '@contentos/contracts';
import { USAGE_METADATA_FIELDS } from '@contentos/contracts';

import { computeCost } from './calculator.js';
import { isDecimalString, ZERO_COST } from './decimal.js';
import type { PricingRegistry } from './pricing.js';

export const USAGE_ERROR_CODES = ['InvalidUsage', 'InvalidMetadata'] as const;

export type UsageErrorCode = (typeof USAGE_ERROR_CODES)[number];

export class UsageError extends Error {
  readonly code: UsageErrorCode;
  readonly issues: readonly string[];

  constructor(code: UsageErrorCode, issues: readonly string[]) {
    super(`${code}: ${issues.join('; ')}.`);
    this.name = 'UsageError';
    this.code = code;
    this.issues = issues;
  }
}

export function isUsageError(value: unknown): value is UsageError {
  return value instanceof UsageError;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every issue at once — a caller wrong in three ways should learn all three. */
function checkTokens(tokens: TokenUsage, cachedTokens: number): readonly string[] {
  const issues: string[] = [];
  if (typeof tokens !== 'object') {
    return ['tokens is required; an unmetered call is an unbilled one'];
  }

  for (const field of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
    const value = tokens[field];
    if (!Number.isInteger(value) || value < 0) {
      issues.push(`${field} must be a non-negative integer, got ${String(value)}`);
    }
  }

  // Two numbers that do not add up mean one of them is wrong, and cost reads
  // both of them.
  if (
    Number.isInteger(tokens.promptTokens) &&
    Number.isInteger(tokens.completionTokens) &&
    Number.isInteger(tokens.totalTokens) &&
    tokens.promptTokens + tokens.completionTokens !== tokens.totalTokens
  ) {
    issues.push(
      `totalTokens (${String(tokens.totalTokens)}) must equal promptTokens + completionTokens (${String(tokens.promptTokens + tokens.completionTokens)})`,
    );
  }

  if (!Number.isInteger(cachedTokens) || cachedTokens < 0) {
    issues.push(`cachedTokens must be a non-negative integer, got ${String(cachedTokens)}`);
  } else if (Number.isInteger(tokens.promptTokens) && cachedTokens > tokens.promptTokens) {
    // A provider reporting cache reads counts them within the prompt tokens;
    // more cached than prompt means the two came from different calls.
    issues.push(
      `cachedTokens (${String(cachedTokens)}) exceeds promptTokens (${String(tokens.promptTokens)}); cache reads are counted within the prompt`,
    );
  }

  return issues;
}

function checkMetadata(metadata: UsageMetadata): readonly string[] {
  const issues: string[] = [];
  const raw = metadata as unknown as Record<string, unknown>;

  for (const field of USAGE_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, field)) {
      issues.push(`'${field}' is required on every usage record`);
    }
  }

  for (const field of ['tenantId', 'organizationId', 'correlationId'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || !UUID.test(value)) {
      issues.push(`${field} must be a UUID, got '${String(value)}'`);
    }
  }
  for (const field of ['idempotencyKey', 'taskType', 'providerId', 'model'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim() === '') {
      issues.push(`${field} is required`);
    }
  }
  // A retry is a real provider call and is metered like any other, so the
  // attempt is what separates two charges from one.
  const attempt = raw['attempt'];
  if (!Number.isInteger(attempt) || (attempt as number) < 1) {
    issues.push(`attempt must be an integer >= 1, got ${String(attempt)}`);
  }
  for (const field of ['promptVersion', 'runId', 'stepId'] as const) {
    const value = raw[field];
    if (value !== null && typeof value !== 'string') {
      issues.push(`${field} must be a string or null, never absent`);
    }
  }

  return issues;
}

/** Exactly once per genuine provider call: the request, and which attempt. */
export function ledgerKeyFor(idempotencyKey: string, attempt: number): string {
  return `${idempotencyKey}#${String(attempt)}`;
}

export interface RecordUsageOptions {
  readonly tokens: TokenUsage;
  readonly metadata: UsageMetadata;
  readonly pricing: PricingRegistry;
  /** True when the provider omitted counts and they were computed locally. */
  readonly estimated?: boolean;
  readonly tokenizer?: string;
  readonly cachedTokens?: number;
  readonly cacheHit?: boolean;
}

/** Where counts came from when nobody said. Recorded, never guessed at later. */
export const UNKNOWN_TOKENIZER = 'unknown';

/**
 * Meter one call.
 *
 * Validation runs first: an invalid record priced anyway would put a wrong
 * number somewhere a right one is expected, and the cost path is the one place
 * that must never be approximately correct.
 */
export function recordUsage(options: RecordUsageOptions): UsageResult {
  const cachedTokens = options.cachedTokens ?? 0;

  const tokenIssues = checkTokens(options.tokens, cachedTokens);
  if (tokenIssues.length > 0) throw new UsageError('InvalidUsage', tokenIssues);

  const metadataIssues = checkMetadata(options.metadata);
  if (metadataIssues.length > 0) throw new UsageError('InvalidMetadata', metadataIssues);

  const cost = computeCost(
    {
      tokens: options.tokens,
      cachedTokens,
      providerId: options.metadata.providerId,
      model: options.metadata.model,
    },
    options.pricing,
  );

  const record: AIUsageRecord = Object.freeze({
    tokens: Object.freeze({ ...options.tokens }),
    estimated: options.estimated ?? false,
    tokenizer: options.tokenizer ?? UNKNOWN_TOKENIZER,
    cachedTokens,
    cacheHit: options.cacheHit ?? false,
    cost,
    metadata: Object.freeze({ ...options.metadata }),
  });

  // Zero is not charged: a ledger entry for nothing is a row that costs more to
  // store and reconcile than the amount it records.
  const chargeable = !cost.unpriced && cost.totalCost !== ZERO_COST;

  return Object.freeze({
    record,
    ledgerIdempotencyKey: ledgerKeyFor(options.metadata.idempotencyKey, options.metadata.attempt),
    chargeableAmount: cost.totalCost,
    chargeable,
  });
}

/**
 * Meter a provider response.
 *
 * The convenience the caller actually has: an `AIResponse` carries the counts
 * and the identity, and everything else is attribution the caller already
 * holds. `providerId` and `model` come from the RESPONSE — the model that
 * actually ran is not necessarily the one asked for, and pricing the wrong one
 * is how a fallback becomes invisible in the cost report.
 */
export function recordResponseUsage(
  response: AIResponse,
  attribution: Omit<UsageMetadata, 'providerId' | 'model' | 'idempotencyKey'>,
  pricing: PricingRegistry,
  extra: {
    readonly tokenizer?: string;
    readonly cachedTokens?: number;
    readonly cacheHit?: boolean;
  } = {},
): UsageResult {
  return recordUsage({
    tokens: response.usage.tokens,
    estimated: response.usage.tokensEstimated,
    metadata: {
      ...attribution,
      idempotencyKey: response.idempotencyKey,
      providerId: response.providerId,
      model: response.model,
    },
    pricing,
    ...(extra.tokenizer === undefined ? {} : { tokenizer: extra.tokenizer }),
    ...(extra.cachedTokens === undefined ? {} : { cachedTokens: extra.cachedTokens }),
    ...(extra.cacheHit === undefined ? {} : { cacheHit: extra.cacheHit }),
  });
}

/**
 * Whether an amount is one the credits ledger would accept.
 *
 * Exported because "ledger-compatible" is a claim, and a claim about a format
 * should be checkable by the thing that makes it.
 */
export function isLedgerCompatibleAmount(amount: unknown): boolean {
  return isDecimalString(amount);
}
