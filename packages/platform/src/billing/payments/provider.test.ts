import { describe, expect, it } from 'vitest';

import { BillingError, type BillingErrorCode } from '../errors.js';
import {
  assertNoDuplicateEvent,
  assertPaymentOwnership,
  assertPaymentProviderId,
  failed,
  isPaymentEventType,
  isPaymentFailureReason,
  isPaymentProviderId,
  PAYMENT_EVENT_TYPES,
  PAYMENT_FAILURE_REASONS,
  PAYMENT_PROVIDER_IDS,
  PAYMENT_SESSION_KINDS,
  RETRYABLE_FAILURE_REASONS,
  succeeded,
  type PaymentEvent,
} from './provider.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const AT = '2026-02-01T00:00:00.000Z';

const codeOf = (call: () => unknown): BillingErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof BillingError) return error.code;
    throw error;
  }
};

const event = (overrides: Partial<PaymentEvent> = {}): PaymentEvent => ({
  providerId: 'stripe',
  eventId: 'evt_1',
  type: 'invoice_paid',
  providerEventType: 'invoice.paid',
  occurredAt: AT,
  externalCustomerId: 'cus_1',
  externalSubscriptionId: 'sub_1',
  organizationId: ORG,
  subscriptionId: null,
  ...overrides,
});

// ── The vocabulary ──────────────────────────────────────────────────────────

describe('provider ids', () => {
  it('name Stripe as the v1 provider', () => {
    expect(PAYMENT_PROVIDER_IDS).toEqual(['stripe']);
  });

  it('reject anything else', () => {
    expect(isPaymentProviderId('razorpay')).toBe(false);
    expect(isPaymentProviderId('STRIPE')).toBe(false);
    expect(isPaymentProviderId(null)).toBe(false);
  });

  it('refuse an unknown provider by name', () => {
    expect(codeOf(() => assertPaymentProviderId('paypal'))).toBe('UnknownProvider');
  });

  it('say which providers exist when they refuse', () => {
    let message = '';
    try {
      assertPaymentProviderId('paypal');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('stripe');
  });

  it('return the id when it is known', () => {
    expect(assertPaymentProviderId('stripe')).toBe('stripe');
  });
});

describe('event types', () => {
  it('are the six the increment names', () => {
    expect(PAYMENT_EVENT_TYPES).toEqual([
      'checkout_completed',
      'subscription_created',
      'subscription_updated',
      'subscription_cancelled',
      'invoice_paid',
      'invoice_payment_failed',
    ]);
  });

  it('reject a provider’s own type string', () => {
    // Ours is the vocabulary; `invoice.paid` is Stripe's.
    expect(isPaymentEventType('invoice.paid')).toBe(false);
    expect(isPaymentEventType('invoice_paid')).toBe(true);
  });
});

describe('session kinds', () => {
  it('are the two provider-hosted surfaces', () => {
    // Card entry happens on the provider's surface; that is the PCI-scope
    // reduction billing.md calls non-negotiable.
    expect(PAYMENT_SESSION_KINDS).toEqual(['checkout', 'portal']);
  });
});

describe('failure reasons', () => {
  it('are the four stripe.md names, and no others', () => {
    expect(PAYMENT_FAILURE_REASONS).toEqual([
      'PaymentFailed',
      'WebhookInvalid',
      'ProviderUnavailable',
      'ReconciliationError',
    ]);
  });

  it('reject anything else', () => {
    expect(isPaymentFailureReason('CardDeclined')).toBe(false);
    expect(isPaymentFailureReason(null)).toBe(false);
  });

  it('mark only an outage retryable', () => {
    // Retrying a declined card declines again; retrying a 5xx is the documented
    // behaviour, with the same idempotency key.
    expect(RETRYABLE_FAILURE_REASONS).toEqual(['ProviderUnavailable']);
    expect(failed('ProviderUnavailable', 'x').outcome).toBe('failed');
  });
});

// ── Results ─────────────────────────────────────────────────────────────────

describe('PaymentResult', () => {
  it('carries a value on success', () => {
    const result = succeeded({ id: 'x' });

    expect(result.outcome).toBe('succeeded');
    if (result.outcome === 'succeeded') expect(result.value).toEqual({ id: 'x' });
  });

  it('carries the reason and detail on failure', () => {
    const result = failed('PaymentFailed', 'Your card was declined.');

    expect(result.outcome).toBe('failed');
    if (result.outcome === 'failed') {
      expect(result.failure.reason).toBe('PaymentFailed');
      expect(result.failure.detail).toBe('Your card was declined.');
      expect(result.failure.retryable).toBe(false);
    }
  });

  it('derives retryable from the reason rather than trusting a caller', () => {
    const outage = failed('ProviderUnavailable', 'HTTP 503');
    const declined = failed('PaymentFailed', 'declined');

    if (outage.outcome === 'failed') expect(outage.failure.retryable).toBe(true);
    if (declined.outcome === 'failed') expect(declined.failure.retryable).toBe(false);
  });

  it('freezes both arms through', () => {
    const ok = succeeded({ id: 'x' });
    const bad = failed('WebhookInvalid', 'nope');

    expect(Object.isFrozen(ok)).toBe(true);
    expect(Object.isFrozen(bad)).toBe(true);
    if (bad.outcome === 'failed') expect(Object.isFrozen(bad.failure)).toBe(true);
  });
});

// ── Ownership ───────────────────────────────────────────────────────────────

describe('assertPaymentOwnership', () => {
  const expected = { organizationId: ORG, accountId: ORG };

  it('admits a record belonging to the organization', () => {
    expect(
      codeOf(() => {
        assertPaymentOwnership(expected, { organizationId: ORG }, 'Customer cus_1');
      }),
    ).toBeNull();
  });

  it('refuses one belonging to another', () => {
    // At a payment provider, this charges the wrong card.
    expect(
      codeOf(() => {
        assertPaymentOwnership(expected, { organizationId: 'other' }, 'Customer cus_1');
      }),
    ).toBe('OwnershipMismatch');
  });

  it('refuses an account that is not its organization', () => {
    // The billing account IS the organization (S5.5); if they disagree, a check
    // comparing only one of them proves nothing.
    expect(
      codeOf(() => {
        assertPaymentOwnership(
          { organizationId: ORG, accountId: 'some-other-account' },
          { organizationId: ORG },
          'Customer cus_1',
        );
      }),
    ).toBe('OwnershipMismatch');
  });

  it('names the record and both organizations', () => {
    let message = '';
    try {
      assertPaymentOwnership(expected, { organizationId: 'other' }, 'Customer cus_1');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('Customer cus_1');
    expect(message).toContain('other');
    expect(message).toContain(ORG);
  });
});

// ── Duplicate webhooks ──────────────────────────────────────────────────────

describe('assertNoDuplicateEvent', () => {
  it('admits the first delivery', () => {
    expect(
      codeOf(() => {
        assertNoDuplicateEvent([], event());
      }),
    ).toBeNull();
  });

  it('refuses a redelivery of the same event', () => {
    // Stripe redelivers at least once; processing it twice would apply it twice.
    expect(
      codeOf(() => {
        assertNoDuplicateEvent([event()], event());
      }),
    ).toBe('DuplicateWebhook');
  });

  it('refuses even when the payload details differ', () => {
    // The event id is the identity. A redelivery with an expanded field is the
    // same event.
    expect(
      codeOf(() => {
        assertNoDuplicateEvent([event()], event({ externalSubscriptionId: 'sub_2' }));
      }),
    ).toBe('DuplicateWebhook');
  });

  it('admits a different event id', () => {
    expect(
      codeOf(() => {
        assertNoDuplicateEvent([event()], event({ eventId: 'evt_2' }));
      }),
    ).toBeNull();
  });

  it('scopes the id to its provider', () => {
    // `UNIQUE (provider, provider_event_id)` — two providers may both use
    // `evt_1` and mean different things.
    expect(
      codeOf(() => {
        assertNoDuplicateEvent([{ ...event(), providerId: 'stripe' }], {
          ...event(),
          providerId: 'stripe',
        });
      }),
    ).toBe('DuplicateWebhook');
  });

  it('names the event and the provider', () => {
    let message = '';
    try {
      assertNoDuplicateEvent([event()], event());
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('evt_1');
    expect(message).toContain('stripe');
  });
});
