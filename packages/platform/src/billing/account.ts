/**
 * The billing account — the commercial identity of an organization.
 *
 * ── The account IS the organization ────────────────────────────────────────
 * `billing.md`: "It resolves at the organization level (ADR-017). A workspace
 * is never billed; an agency has one subscription covering fifty client
 * workspaces, and usage is attributed per workspace for reporting while the
 * invoice is singular."
 *
 * So `BillingAccountId` is the organization's id. There is no `billing_accounts`
 * table in the specification and this increment adds none: `subscriptions`
 * keys on `organization_id`, and `organizations` already carries `billing_ref`
 * and `plan_limits`. A separate account id would be a second thing to reconcile
 * against the organization, and the first time they disagreed nobody would know
 * which was right.
 *
 * ── `status` is the organization's status, not a second one ────────────────
 * `organizations.status` is already `active | past_due | suspended |
 * pending_closure | closed`, with named `payment_failed` and
 * `payment_recovered` transitions. That IS the account's commercial standing,
 * it is stored in exactly one column, and `organizations.md` owns moving it.
 * `BillingStatus` is therefore an alias, not a parallel vocabulary — two
 * statuses for one fact would drift, and the drift would be invisible until a
 * customer was suspended in one and paying in the other.
 *
 * ── The workspace is attribution, never a billing boundary ─────────────────
 * The increment asks for an optional workspace. It is carried for reporting —
 * "usage is attributed per workspace for reporting while the invoice is
 * singular" — and `assertOneAccountPerOrganization` refuses to let it become a
 * second account. A workspace-scoped account would split one agency's invoice
 * fifty ways.
 *
 * ── Currency is not the ledger's currency ──────────────────────────────────
 * `LEDGER_CURRENCY` is `'credits'`: what the ledger denominates in. A billing
 * account's currency is what the customer is charged in. Conflating them would
 * price a credit at one unit of a currency nobody agreed to.
 */

import type { OrganizationStatus } from '../organizations/lifecycle.js';
import { isOrganizationStatus } from '../organizations/lifecycle.js';
import { BillingError } from './errors.js';
import { deepFreeze } from './immutable.js';

/**
 * A billing account's identity: the organization's id.
 *
 * An alias rather than a brand, for the reason `ReservationId` is one — every
 * call site already passes an organization id as a string, and a brand would
 * buy nothing but a cast at each of them.
 */
export type BillingAccountId = string;

/**
 * An account's commercial standing.
 *
 * `OrganizationStatus`, because that is where it is stored and who owns moving
 * it. Not re-declared: see the note above.
 */
export type BillingStatus = OrganizationStatus;

export function isBillingStatus(value: unknown): value is BillingStatus {
  return typeof value === 'string' && isOrganizationStatus(value);
}

/**
 * The statuses in which an account may be charged and may spend.
 *
 * `past_due` is included: `billing.md` says a provider outage must never
 * suspend a paying customer, and dunning is a grace period. `suspended`,
 * `pending_closure` and `closed` are not — those are Organizations' decisions,
 * already taken.
 */
export const BILLABLE_STATUSES: readonly BillingStatus[] = Object.freeze(['active', 'past_due']);

/** ISO-4217: three uppercase letters. The standard, not a list invented here. */
const CURRENCY = /^[A-Z]{3}$/;

/**
 * What the customer is charged in.
 *
 * Validated by shape rather than against an allowlist. An allowlist here would
 * be this increment deciding which markets the product sells in, which is a
 * commercial decision and OQ-13 ("regional payment providers"), not an
 * architectural one.
 */
export type BillingCurrency = string;

export function assertBillingCurrency(value: unknown): BillingCurrency {
  if (typeof value !== 'string' || !CURRENCY.test(value)) {
    throw new BillingError(
      'InvalidDeclaration',
      `'${String(value)}' is not an ISO-4217 currency code (three uppercase letters, e.g. 'USD').`,
    );
  }
  return value;
}

export interface BillingAccount {
  /** The organization's id. A billing account is not a second record. */
  readonly accountId: BillingAccountId;
  readonly organizationId: string;
  /**
   * Attribution only. Null for the ordinary case: the account covers the whole
   * organization. Never a billing boundary — a workspace is never billed.
   */
  readonly workspaceId: string | null;
  readonly currency: BillingCurrency;
  readonly status: BillingStatus;
  /**
   * The payment provider's identifier — `organizations.billing_ref`. Carried,
   * never interpreted, and never used to reach a provider from here.
   */
  readonly providerRef: string | null;
  readonly createdAt: string;
}

const requireField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BillingError('InvalidDeclaration', `'${field}' is required and must be non-empty.`);
  }
  return value;
};

export function createBillingAccount(input: {
  readonly organizationId: string;
  readonly workspaceId?: string | null;
  readonly currency: BillingCurrency;
  readonly status: BillingStatus;
  readonly providerRef?: string | null;
  readonly createdAt: string;
}): BillingAccount {
  requireField(input.organizationId, 'organizationId');
  requireField(input.createdAt, 'createdAt');

  if (!isBillingStatus(input.status)) {
    throw new BillingError(
      'InvalidDeclaration',
      `'${String(input.status)}' is not a billing status. An account's standing is the organization's status, which organizations.md owns.`,
    );
  }

  const workspaceId = input.workspaceId ?? null;
  if (workspaceId !== null && workspaceId.trim() === '') {
    throw new BillingError(
      'InvalidDeclaration',
      "'workspaceId' must be a real workspace or null; an empty string is neither.",
    );
  }

  return deepFreeze({
    // The organization's id. Deliberately the same value, not derived from it.
    accountId: input.organizationId,
    organizationId: input.organizationId,
    workspaceId,
    currency: assertBillingCurrency(input.currency),
    status: input.status,
    providerRef: input.providerRef ?? null,
    createdAt: input.createdAt,
  });
}

/** May this account be charged and may its organization spend? */
export function isBillable(account: BillingAccount): boolean {
  return BILLABLE_STATUSES.includes(account.status);
}

/**
 * Refuse a second account for one organization.
 *
 * Including a workspace-scoped one. The workspace field is attribution; letting
 * it key a second account would split an agency's single invoice across fifty
 * client workspaces, which is exactly what `billing.md` rules out.
 */
export function assertOneAccountPerOrganization(
  existing: readonly BillingAccount[],
  incoming: BillingAccount,
): void {
  for (const account of existing) {
    if (account.organizationId === incoming.organizationId) {
      throw new BillingError(
        'OwnershipMismatch',
        `Organization '${incoming.organizationId}' already has a billing account. A workspace is never billed separately — the workspace field is attribution for reporting, and the invoice is singular.`,
      );
    }
  }
}

/**
 * Refuse a record that belongs to another organization.
 *
 * The ownership check the increment names. Cheap, and the failure it prevents
 * is a subscription's entitlements resolving for a customer who did not buy
 * them.
 */
export function assertOwnedBy(
  account: BillingAccount,
  record: { readonly organizationId: string },
  what: string,
): void {
  if (record.organizationId !== account.organizationId) {
    throw new BillingError(
      'OwnershipMismatch',
      `${what} belongs to organization '${record.organizationId}', not '${account.organizationId}'.`,
    );
  }
}
