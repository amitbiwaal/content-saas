/**
 * The Commerce error taxonomy — one per module, as everywhere else here.
 *
 * `OrganizationError`, `FeatureFlagError`, `SettingsError`, `HoldError` and
 * `LedgerError` each belong to one module and carry a typed code. This follows
 * that convention rather than extending one of them: a caller catching a
 * billing failure should not have to know that a plan and a credit hold share
 * an error class, and `HoldErrorCode` gaining `PlanNotFound` would make the
 * credits taxonomy describe things credits knows nothing about.
 */

export type BillingErrorCode =
  /** A status change the lifecycle does not permit. */
  | 'InvalidTransition'
  /** A subscription id that already exists. Ids are assigned once. */
  | 'DuplicateSubscription'
  /** Two live subscriptions for one organization. The table forbids it. */
  | 'SubscriptionConflict'
  | 'SubscriptionNotFound'
  | 'PlanNotFound'
  /** A plan a subscription may not be on — retired, or entitling the unknown. */
  | 'IncompatiblePlan'
  /** A billing cycle outside the two the period arithmetic knows. */
  | 'InvalidBillingCycle'
  /** A period whose bounds do not describe an interval. */
  | 'InvalidBillingPeriod'
  /** A limit, currency or identifier that is not the shape it must be. */
  | 'InvalidDeclaration'
  /** An identifier changed on a record that is supposed to carry it forever. */
  | 'ImmutableFieldChanged'
  /** The record belongs to a different organization than the caller assumed. */
  | 'OwnershipMismatch'
  /** An older version of a record arriving after a newer one. */
  | 'StaleVersion'
  // ── Added by the payment provider layer ───────────────────────────────────
  // One taxonomy for one module. A payment failure that a provider REPORTS is
  // a `PaymentResult` value, not one of these — these are the ways a caller,
  // or a forged request, is wrong.
  /** A provider id this build does not know. */
  | 'UnknownProvider'
  /** A webhook body that is not the shape a webhook has. */
  | 'MalformedWebhook'
  /** A webhook whose event id has already been recorded. */
  | 'DuplicateWebhook';

export class BillingError extends Error {
  readonly code: BillingErrorCode;

  constructor(code: BillingErrorCode, message: string) {
    super(message);
    this.name = 'BillingError';
    this.code = code;
  }
}
