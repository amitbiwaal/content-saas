/**
 * `AIResponse`, `Usage`, `TokenUsage`, `CostEstimate` — the canonical response
 * side. FROZEN.
 *
 * Spec: `08-ai-platform/ai-gateway.md` §Outputs and
 * `provider-adapters.md` §"Normalization contract" — every adapter must produce
 * output indistinguishable in SHAPE from every other adapter. Two adapters that
 * disagree about where the token counts live make provider substitution a
 * refactor, which is the one thing this port exists to prevent.
 */

/**
 * The fixed set. Every vendor's finish reason maps to exactly one
 * (provider-adapters.md §"Normalization contract").
 */
export const FINISH_REASONS = ['stop', 'length', 'content_filter', 'tool_call'] as const;

export type FinishReason = (typeof FINISH_REASONS)[number];

export function isFinishReason(value: unknown): value is FinishReason {
  return typeof value === 'string' && (FINISH_REASONS as readonly string[]).includes(value);
}

/**
 * Token counts, ALWAYS populated.
 *
 * Where a provider omits them the adapter computes them with the model's
 * tokenizer and marks the usage estimated. A provider that omits counts would
 * otherwise produce silent under-metering — the customer is billed for less
 * than they used, and nothing anywhere reports a discrepancy.
 */
export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/**
 * What one call is expected to cost.
 *
 * ── A decimal STRING, never a number ────────────────────────────────────────
 * This value reaches the credits ledger, and `04-platform/credits.md` stores
 * money as NUMERIC(20,6). An IEEE-754 double cannot represent common decimal
 * values (`0.1 + 0.2`) and loses integer precision past 2^53, so a float here
 * would put a rounding error directly into the charge path. The format is
 * deliberately identical to the ledger's — a non-negative decimal with at most
 * six places — so a cost can be handed to it without conversion.
 *
 * The Gateway spec writes `cost: { usd: number }`. This is the one place this
 * increment departs from it, for the reason above, and the departure matches
 * the choice the credits increments already made.
 *
 * ESTIMATE, not charge. Nothing here is the record of what was billed; the
 * ledger is. Cost CALCULATION belongs to `cost-management.md` and is not in
 * this increment — this is the shape that carries the number, not the thing
 * that computes it.
 */
export interface CostEstimate {
  /** ISO 4217. 'USD' today; present so a second currency is not a migration. */
  readonly currency: string;
  /** Non-negative decimal, at most six places. Never a float. */
  readonly amount: string;
}

/**
 * The whole meterable record of one call.
 *
 * `TokenUsage` counts tokens; `Usage` is what a metering consumer needs to
 * act — the counts, whether they can be trusted, what they are expected to
 * cost, and how long it took. They are separate types because the first is a
 * fact about the model and the second is a fact about the call.
 */
export interface Usage {
  readonly tokens: TokenUsage;
  /**
   * True when the provider omitted counts and the adapter computed them.
   *
   * Commercially load-bearing: it is what keeps reconciliation honest, and a
   * rising rate of it means metering accuracy is degrading
   * (`cost-management.md`).
   */
  readonly tokensEstimated: boolean;
  readonly cost: CostEstimate;
  readonly latencyMs: number;
}

export interface AIResponse {
  /** Echoes the request's `idempotencyKey`, tying a response to its cause. */
  readonly idempotencyKey: string;
  /**
   * Which adapter produced this.
   *
   * Visible only within the adapter layer and to metering — nothing above the
   * Gateway may branch on it, because the moment something does, provider
   * substitution stops being a configuration change.
   */
  readonly providerId: string;
  /** The model that actually ran, which is not necessarily the one asked for. */
  readonly model: string;
  /**
   * Plain string, whitespace and encoding normalized, with no vendor-specific
   * leading tokens, markers or wrappers.
   *
   * Structured content arrives with response validation
   * (`response-validation.md`), which is not in this increment. Widening this
   * to a union then is a deliberate contract change, not an accident.
   */
  readonly content: string;
  readonly finishReason: FinishReason;
  readonly usage: Usage;
  /**
   * Vendor request ids and response headers — OPAQUE.
   *
   * Retained because it is what makes a support conversation with a vendor
   * possible three weeks later. Never interpreted, never allowed to influence
   * behaviour, and never surfaced to callers: vendor headers leak account
   * identifiers and internal endpoints (provider-adapters.md §Security).
   */
  readonly providerMetadata: Readonly<Record<string, unknown>>;
}

/** The response field names, frozen. */
export const AI_RESPONSE_FIELDS = [
  'idempotencyKey',
  'providerId',
  'model',
  'content',
  'finishReason',
  'usage',
  'providerMetadata',
] as const;

export type AIResponseField = (typeof AI_RESPONSE_FIELDS)[number];
