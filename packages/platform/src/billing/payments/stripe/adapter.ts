/**
 * The Stripe adapter — the only place that knows Stripe exists.
 *
 * ── Transport is injected, exactly as `CreditsExecutor` is ─────────────────
 * The adapter owns TRANSLATION and the SDK owns TRANSPORT, and separating them
 * is what makes every mapping testable without a network. `StripeTransport` is
 * the seam: three methods, plain JSON in and out, which the SDK implements in a
 * later increment when live calls are in scope. Nothing about the translation
 * changes when it does.
 *
 * The same shape the credits service uses — `authorizeSpend(tx, command)` takes
 * its executor rather than opening a connection — and for the same reason: the
 * logic worth asserting is the part that is not I/O.
 *
 * ── An adapter translates and reports. It never decides ────────────────────
 * The wording is taken from `packages/ai/src/providers/provider.ts`, because
 * the rule is the same one. No retry schedule (`stripe.md` gives retries to the
 * caller, with the same idempotency key), no state change, no ledger entry, no
 * credit grant. A provider that decided anything would be a second billing
 * model.
 *
 * ── Nothing from `wire.ts` leaves this file ────────────────────────────────
 * Every method returns a domain model or a `PaymentResult`. A `StripeEventWire`
 * on a public signature would put Stripe's JSON in the platform's vocabulary
 * and make the second provider impossible.
 */

import { constantTimeEquals, hmacSha256 } from '@contentos/security';

import { BillingError } from '../../errors.js';
import { deepFreeze } from '../../immutable.js';
import {
  failed,
  succeeded,
  type CancelSubscriptionCommand,
  type CreateCheckoutSessionCommand,
  type CreateCustomerCommand,
  type CreatePortalSessionCommand,
  type CreateSubscriptionCommand,
  type PaymentCustomer,
  type PaymentEvent,
  type PaymentProvider,
  type PaymentResult,
  type PaymentSession,
  type PaymentSubscriptionRef,
  type WebhookDelivery,
  type WebhookOutcome,
} from '../provider.js';
import {
  fromStripeCustomer,
  fromStripeSession,
  fromStripeSubscription,
  identifiersOf,
  mapStripeEventType,
  STRIPE_PROVIDER_ID,
  toStripeCancelBody,
  toStripeCheckoutBody,
  toStripeCustomerBody,
  toStripePortalBody,
  toStripeSubscriptionBody,
  type StripeRequestBody,
} from './mapping.js';
import { readInteger, readString, toInstant } from './wire.js';

/**
 * What the adapter needs from the outside world.
 *
 * Deliberately three methods and no client object: an interface exposing a
 * Stripe client would let a caller reach past the adapter, which is the one
 * thing this boundary exists to prevent.
 */
export interface StripeTransport {
  /**
   * One mutating call.
   *
   * `idempotencyKey` is mandatory — `stripe.md`: "the adapter uses Stripe
   * idempotency keys on every mutating call so retries are safe". A transport
   * that dropped it would let a retried checkout charge twice.
   */
  post(
    path: string,
    body: StripeRequestBody,
    idempotencyKey: string,
  ): Promise<StripeTransportResponse>;
}

/** What a transport gives back. JSON, or a reason it could not. */
export type StripeTransportResponse =
  | { readonly ok: true; readonly body: unknown }
  | {
      readonly ok: false;
      /** The provider's HTTP status, where there was one. */
      readonly status: number | null;
      readonly message: string;
    };

export interface StripeAdapterOptions {
  readonly transport: StripeTransport;
  /**
   * The webhook signing secret. `stripe.md`: signature verification happens
   * "before any processing" — an unverified webhook is a forged-payment vector.
   */
  readonly webhookSecret: string;
  /**
   * How far out of date a signature may be, in seconds. Stripe's own default
   * is five minutes; beyond it a captured request is a replay.
   */
  readonly toleranceSeconds?: number;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * An HTTP status, read as one of the four signals `stripe.md` names.
 *
 * 402 is the one that matters: Stripe answers a declined card with it, and
 * treating that as an outage would retry a card that will decline every time.
 */
function failureFor(status: number | null): 'PaymentFailed' | 'ProviderUnavailable' {
  if (status === 402) return 'PaymentFailed';
  if (status !== null && status >= 400 && status < 500 && status !== 429) return 'PaymentFailed';
  return 'ProviderUnavailable';
}

const requireField = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new BillingError('InvalidDeclaration', `'${field}' is required and must be non-empty.`);
  }
  return value;
};

/**
 * Parse Stripe's `Stripe-Signature` header.
 *
 * `t=1614556800,v1=<hex>,v1=<hex>` — more than one `v1` during a secret
 * rotation, and any of them matching is a valid signature.
 */
function parseSignatureHeader(header: string): { timestamp: number; signatures: string[] } | null {
  let timestamp: number | null = null;
  const signatures: string[] = [];

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator === -1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();

    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isSafeInteger(parsed) && parsed > 0) timestamp = parsed;
    } else if (key === 'v1' && value !== '') {
      signatures.push(value);
    }
  }

  return timestamp === null || signatures.length === 0 ? null : { timestamp, signatures };
}

export function createStripeProvider(options: StripeAdapterOptions): PaymentProvider {
  const { transport } = options;
  const webhookSecret = requireField(options.webhookSecret, 'webhookSecret');
  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;

  /**
   * One mutating call, with its response read into a domain model.
   *
   * `describe` builds the request rather than the caller passing it built, so a
   * guard that throws does so INSIDE this async function and surfaces as a
   * rejected promise. A method typed `Promise<T>` that throws synchronously
   * would be caught by a caller's `try`/`await` but not by its `.catch()`, and
   * the two would disagree about whether a bug is catchable.
   */
  async function call<T>(
    describe: () => {
      readonly path: string;
      readonly body: StripeRequestBody;
      readonly idempotencyKey: string;
    },
    read: (wire: unknown) => T | null,
    what: string,
  ): Promise<PaymentResult<T>> {
    const { path, body, idempotencyKey } = describe();
    requireField(idempotencyKey, 'idempotencyKey');

    const response = await transport.post(path, body, idempotencyKey);

    if (!response.ok) {
      return failed(failureFor(response.status), response.message);
    }

    const value = read(response.body);
    if (value === null) {
      // The call succeeded and the answer is unusable. Reporting it as success
      // would put a half-built record into the platform; reporting it as an
      // outage would retry a call that already worked.
      return failed(
        'ReconciliationError',
        `Stripe accepted the ${what} but its response could not be read as one. The provider's state and ours may have diverged.`,
      );
    }
    return succeeded(value);
  }

  return deepFreeze({
    providerId: STRIPE_PROVIDER_ID,

    createCustomer(command: CreateCustomerCommand): Promise<PaymentResult<PaymentCustomer>> {
      return call(
        () => {
          requireField(command.organizationId, 'organizationId');
          requireField(command.email, 'email');

          if (command.accountId !== command.organizationId) {
            // The billing account IS the organization (S5.5). A command where
            // they disagree would open a provider customer against nothing.
            throw new BillingError(
              'OwnershipMismatch',
              `Billing account '${command.accountId}' is not organization '${command.organizationId}'. A billing account is its organization.`,
            );
          }

          return {
            path: '/v1/customers',
            body: toStripeCustomerBody(command),
            idempotencyKey: command.idempotencyKey,
          };
        },
        (wire) =>
          fromStripeCustomer(wire, {
            organizationId: command.organizationId,
            // Stripe stamps its own `created`; this reads the one it returns
            // rather than a clock, so two readers agree.
            createdAt: toInstant(readInteger(wire, 'created')) ?? command.idempotencyKey,
          }),
        'customer',
      );
    },

    createCheckoutSession(
      command: CreateCheckoutSessionCommand,
    ): Promise<PaymentResult<PaymentSession>> {
      return call(
        () => {
          requireField(command.organizationId, 'organizationId');
          requireField(command.externalCustomerId, 'externalCustomerId');
          requireField(command.externalPriceId, 'externalPriceId');

          return {
            path: '/v1/checkout/sessions',
            body: toStripeCheckoutBody(command),
            idempotencyKey: command.idempotencyKey,
          };
        },
        (wire) =>
          fromStripeSession(wire, {
            organizationId: command.organizationId,
            kind: 'checkout',
            createdAt: toInstant(readInteger(wire, 'created')) ?? command.idempotencyKey,
          }),
        'checkout session',
      );
    },

    createPortalSession(
      command: CreatePortalSessionCommand,
    ): Promise<PaymentResult<PaymentSession>> {
      return call(
        () => {
          requireField(command.organizationId, 'organizationId');
          requireField(command.externalCustomerId, 'externalCustomerId');

          return {
            path: '/v1/billing_portal/sessions',
            body: toStripePortalBody(command),
            // A portal session is read-only for the customer and Stripe assigns
            // no idempotency semantics to it; the customer id is what makes a
            // repeat harmless.
            idempotencyKey: `portal:${command.externalCustomerId}`,
          };
        },
        (wire) =>
          fromStripeSession(wire, {
            organizationId: command.organizationId,
            kind: 'portal',
            createdAt: toInstant(readInteger(wire, 'created')) ?? command.returnUrl,
          }),
        'portal session',
      );
    },

    createSubscription(
      command: CreateSubscriptionCommand,
    ): Promise<PaymentResult<PaymentSubscriptionRef>> {
      return call(
        () => {
          requireField(command.organizationId, 'organizationId');
          requireField(command.externalCustomerId, 'externalCustomerId');
          requireField(command.externalPriceId, 'externalPriceId');

          return {
            path: '/v1/subscriptions',
            body: toStripeSubscriptionBody(command),
            idempotencyKey: command.idempotencyKey,
          };
        },
        (wire) => fromStripeSubscription(wire, { organizationId: command.organizationId }),
        'subscription',
      );
    },

    cancelSubscription(
      command: CancelSubscriptionCommand,
    ): Promise<PaymentResult<PaymentSubscriptionRef>> {
      return call(
        () => {
          requireField(command.organizationId, 'organizationId');
          requireField(command.externalSubscriptionId, 'externalSubscriptionId');

          return {
            // An UPDATE, not a DELETE. Deleting ends the subscription
            // immediately and takes away time the customer has already paid
            // for; `billing.md` cancels at period end so they keep it.
            path: `/v1/subscriptions/${command.externalSubscriptionId}`,
            body: toStripeCancelBody(command),
            idempotencyKey: command.idempotencyKey,
          };
        },
        (wire) => fromStripeSubscription(wire, { organizationId: command.organizationId }),
        'cancellation',
      );
    },

    receiveWebhook(delivery: WebhookDelivery): WebhookOutcome {
      const parsed = parseSignatureHeader(delivery.signatureHeader);
      if (parsed === null) {
        return rejected('The Stripe-Signature header is missing a timestamp or a v1 signature.');
      }

      // Replay window, checked BEFORE the HMAC: a captured request stays
      // validly signed forever, so the signature alone does not make it fresh.
      const receivedAt = Date.parse(delivery.receivedAt);
      if (Number.isNaN(receivedAt)) {
        return rejected(`'receivedAt' is not an instant: '${delivery.receivedAt}'.`);
      }
      const ageSeconds = Math.abs(receivedAt / 1000 - parsed.timestamp);
      if (ageSeconds > tolerance) {
        return rejected(
          `The signature is ${String(Math.round(ageSeconds))}s out of date; the tolerance is ${String(tolerance)}s. Outside it, a captured request is a replay.`,
        );
      }

      const expected = hmacSha256(
        Buffer.from(webhookSecret, 'utf8'),
        Buffer.from(`${String(parsed.timestamp)}.${delivery.payload}`, 'utf8'),
      ).toString('hex');

      // Constant-time, and every candidate is compared: a rotation has two
      // valid secrets, and short-circuiting on the first match would leak
      // which one through timing.
      let matched = false;
      for (const signature of parsed.signatures) {
        if (constantTimeEquals(signature, expected)) matched = true;
      }
      if (!matched) {
        return rejected('The signature does not match. This may be a spoofed request.');
      }

      let envelope: unknown;
      try {
        envelope = JSON.parse(delivery.payload);
      } catch {
        return rejected('The webhook body is signed but is not JSON.');
      }

      const eventId = readString(envelope, 'id');
      const providerEventType = readString(envelope, 'type');
      const occurredAt = toInstant(readInteger(envelope, 'created'));

      if (eventId === null || providerEventType === null || occurredAt === null) {
        return rejected('The webhook envelope has no id, type or created timestamp.');
      }

      const type = mapStripeEventType(providerEventType);
      if (type === null) {
        // Not an error. Stripe sends dozens of types to one endpoint, and
        // failing on the ones we do not map would make it retry for days.
        return deepFreeze({
          outcome: 'ignored' as const,
          providerId: STRIPE_PROVIDER_ID,
          eventId,
          providerEventType,
        });
      }

      const object: unknown =
        typeof envelope === 'object' && envelope !== null
          ? ((envelope as { data?: { object?: unknown } }).data?.object ?? null)
          : null;

      if (object === null) {
        return rejected(`Event '${eventId}' (${providerEventType}) carries no object.`);
      }

      const identifiers = identifiersOf(providerEventType, object);

      const event: PaymentEvent = deepFreeze({
        providerId: STRIPE_PROVIDER_ID,
        eventId,
        type,
        providerEventType,
        occurredAt,
        externalCustomerId: identifiers.externalCustomerId,
        externalSubscriptionId: identifiers.externalSubscriptionId,
        organizationId: identifiers.organizationId,
        subscriptionId: identifiers.subscriptionId,
      });

      return deepFreeze({ outcome: 'accepted' as const, event });
    },
  });
}

function rejected(detail: string): WebhookOutcome {
  return deepFreeze({
    outcome: 'rejected' as const,
    failure: { reason: 'WebhookInvalid' as const, detail, retryable: false },
  });
}
