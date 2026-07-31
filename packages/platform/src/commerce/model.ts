/**
 * The Commercial Platform's one entry point.
 *
 * ── Everything a caller may ask for, in one vocabulary ─────────────────────
 * Eight operations, one request shape, one response shape. A REST controller,
 * a webhook endpoint and an admin UI all speak this and nothing else; whether
 * an operation is served by Billing, Credits or the payment provider is a fact
 * about the inside, and it stays inside.
 *
 * The shape is the Content Management Facade's, deliberately. That surface
 * already answered "what does an entry point look like here" — one request
 * union, one response union, refusals as values, tenancy from the context —
 * and a second answer would mean two conventions for one job.
 *
 * ── Tenancy comes from the CONTEXT, never from a payload ───────────────────
 * A payload names a plan or a price. It does not name an organization, because
 * that is a resolved fact about the request and a payload is something a caller
 * typed. Taking it from the context is what stops a caller subscribing another
 * organization, or reading its balance, by asking nicely.
 *
 * ── There is no workspace here ─────────────────────────────────────────────
 * `billing.md`: "It resolves at the organization level (ADR-017). A workspace
 * is never billed." A commercial context carrying one would invite a caller to
 * scope a subscription to it, which is the thing the billing model rules out.
 *
 * ── A declined card is a SUCCESSFUL request ────────────────────────────────
 * `createCheckoutSession` succeeds when the provider was asked and answered.
 * What the provider said is data on the response. Conflating the two would make
 * "the platform refused you" and "your card was declined" the same answer, and
 * they call for opposite actions.
 */

import type { Principal } from '@contentos/security';

import type { BillingAccount } from '../billing/account.js';
import type { CommercialPlan, PlanCode } from '../billing/plan.js';
import type { PaymentSession } from '../billing/payments/provider.js';
import type { Subscription } from '../billing/subscription.js';
import type { BillingCycle } from '../billing/period.js';
import type { AvailabilityReading } from '../credits/availability.js';
import type { LedgerBalance } from '../credits/aggregate.js';
import type { CreditReservation } from '../credits/reservation.js';

export const COMMERCIAL_OPERATIONS = [
  'createBillingAccount',
  'createSubscription',
  'changePlan',
  'cancelSubscription',
  'createCheckoutSession',
  'createPortalSession',
  'receiveWebhook',
  'loadCommercialSummary',
] as const;

export type CommercialOperation = (typeof COMMERCIAL_OPERATIONS)[number];

export function isCommercialOperation(value: unknown): value is CommercialOperation {
  return typeof value === 'string' && (COMMERCIAL_OPERATIONS as readonly string[]).includes(value);
}

/**
 * Who is asking, for which organization, under what trace.
 *
 * Every field is RESOLVED — the principal by authentication, the organization
 * by the directory, the ids by the edge. Nothing here is constructed by this
 * layer; a facade that could mint a principal would be a way around
 * authentication rather than a way into the platform.
 */
export interface CommercialContext {
  readonly principal: Principal;
  /** The commercial boundary. Billing resolves here and nowhere else. */
  readonly organizationId: string;
  /** This request. Echoed back so a caller can correlate one answer. */
  readonly requestId: string;
  /** This customer action, across every call it causes. */
  readonly correlationId: string;
  /**
   * When the request is being served.
   *
   * Supplied, never read from a clock here. Every downstream model — a
   * subscription's `updatedAt`, a billing period, an account's `createdAt` —
   * takes its instant from the caller, and a facade that read its own would
   * make two of them disagree inside one request.
   */
  readonly at: string;
}

// ── Payloads ────────────────────────────────────────────────────────────────

/** Tenancy is absent on purpose — see the file header. */
export interface CreateBillingAccountPayload {
  /** ISO-4217. What the customer is charged in, not what the ledger counts. */
  readonly currency: string;
  /** Attribution for reporting. Never a billing boundary. */
  readonly workspaceId?: string | null;
  readonly providerRef?: string | null;
}

export interface CreateSubscriptionPayload {
  readonly subscriptionId: string;
  readonly planCode: PlanCode;
  readonly cycle: BillingCycle;
  readonly providerRef?: string | null;
}

export interface ChangePlanPayload {
  readonly subscriptionId: string;
  readonly planCode: PlanCode;
}

export interface CancelSubscriptionPayload {
  readonly subscriptionId: string;
  /** Defaults to cancelling at period end, so a customer keeps what they paid for. */
  readonly atPeriodEnd?: boolean;
  readonly idempotencyKey: string;
}

export interface CreateCheckoutSessionPayload {
  /** The provider's identifier for what is being bought. Opaque here. */
  readonly externalPriceId: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
  readonly idempotencyKey: string;
}

export interface CreatePortalSessionPayload {
  readonly returnUrl: string;
}

/**
 * A webhook, exactly as it arrived.
 *
 * Raw bytes, because a signature covers bytes. Re-serialising the body before
 * it reaches here would invalidate it.
 */
export interface ReceiveWebhookPayload {
  readonly payload: string;
  readonly signatureHeader: string;
}

/** No payload: the organization is the whole question, and it is on the context. */
export type LoadCommercialSummaryPayload = Readonly<Record<string, never>>;

interface Envelope<Operation extends CommercialOperation, Payload> {
  readonly operation: Operation;
  readonly context: CommercialContext;
  readonly payload: Payload;
}

/**
 * One request, whatever is being asked.
 *
 * A discriminated union rather than eight entry types: one handler can accept
 * all of it, and a caller narrows on `operation` instead of choosing a function
 * name before it has parsed the body.
 */
export type CommercialRequest =
  | Envelope<'createBillingAccount', CreateBillingAccountPayload>
  | Envelope<'createSubscription', CreateSubscriptionPayload>
  | Envelope<'changePlan', ChangePlanPayload>
  | Envelope<'cancelSubscription', CancelSubscriptionPayload>
  | Envelope<'createCheckoutSession', CreateCheckoutSessionPayload>
  | Envelope<'createPortalSession', CreatePortalSessionPayload>
  | Envelope<'receiveWebhook', ReceiveWebhookPayload>
  | Envelope<'loadCommercialSummary', LoadCommercialSummaryPayload>;

// ── The read model ──────────────────────────────────────────────────────────

/**
 * Everything commercially true about an organization, in one answer.
 *
 * A READ MODEL. Every field is fetched from the component that owns it and
 * carried through unchanged — there is no field here this layer computes,
 * except `available`, which is the frozen S5.2 calculation called rather than
 * copied.
 *
 * Nullable where the fact may genuinely not exist: an organization with no
 * account has no subscription and no plan, and a summary that invented empty
 * ones would tell a caller it had checked something it had not.
 */
export interface CommercialSummary {
  readonly organizationId: string;
  readonly account: BillingAccount | null;
  /** The one live subscription, or null. Terminal ones are not live. */
  readonly subscription: Subscription | null;
  /** The plan that subscription is on. Null when there is no subscription. */
  readonly plan: CommercialPlan | null;
  /** From the ledger. Never derived from reservations. */
  readonly balance: LedgerBalance;
  /** `balance − unspent active reservations`. The S5.2 calculation. */
  readonly available: AvailabilityReading;
  /** The reservations holding credits down right now. */
  readonly activeReservations: readonly CreditReservation[];
}

// ── Responses ───────────────────────────────────────────────────────────────

/** What came back. Narrowed by `kind`, never by which field is populated. */
export type CommercialData =
  | { readonly kind: 'account'; readonly account: BillingAccount }
  | { readonly kind: 'subscription'; readonly subscription: Subscription }
  | { readonly kind: 'session'; readonly session: PaymentSession }
  | {
      readonly kind: 'webhook';
      /**
       * What receiving it produced. `ignored` is a success: the provider sends
       * types this build does not map, and refusing them would make it retry.
       */
      readonly accepted: boolean;
      readonly eventId: string;
      readonly eventType: string | null;
      /** False when the event had already been recorded. */
      readonly recorded: boolean;
    }
  | { readonly kind: 'summary'; readonly summary: CommercialSummary };

/**
 * The trace a caller gets back.
 *
 * The two ids and nothing else. Returning the principal would be sending a
 * caller its own authority back down the wire.
 */
export interface CommercialTrace {
  readonly requestId: string;
  readonly correlationId: string;
}

export interface CommercialSuccess {
  readonly outcome: 'ok';
  readonly operation: CommercialOperation;
  readonly trace: CommercialTrace;
  readonly data: CommercialData;
}

export interface CommercialRefusal {
  readonly outcome: 'refused';
  /**
   * What was ASKED for.
   *
   * A string rather than a `CommercialOperation`, because a refusal can name
   * one that does not exist — which is the whole of what `InvalidOperation`
   * says.
   */
  readonly operation: string;
  readonly trace: CommercialTrace;
  readonly code: string;
  /** For operators. Never returned to a caller. */
  readonly reason: string;
  readonly issues: readonly {
    readonly field: string;
    readonly code: string;
    readonly detail: string;
  }[];
}

/**
 * The answer to any commercial request.
 *
 * Named `CommercialResult` because the increment names it that; it is the same
 * success-or-refusal union `ContentResponse` is, for the same reason — an entry
 * point that could throw would make every caller wrap it, and the first one
 * that forgot would turn a service fault into a 500 with no code.
 */
export type CommercialResult = CommercialSuccess | CommercialRefusal;
