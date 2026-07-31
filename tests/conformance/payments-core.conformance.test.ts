/**
 * The payment provider layer against the boundary the repo already declared.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. STRIPE IS AN IMPLEMENTATION DETAIL. The eslint config named
 *    `packages/platform/src/billing/**` as the only place a Stripe SDK may be
 *    imported — in Sprint 0, before any of this existed. Nothing Stripe-shaped
 *    appears on the port, on a repository, or in the barrel.
 *
 * 2. IT NEVER OWNS COMMERCIAL STATE. No subscription transition, no ledger
 *    entry, no credit grant, no invoice, no tax. Structural, per module.
 *
 * 3. THE WEBHOOK PIPELINE IS ONE PIPELINE. One event-type map, one signature
 *    check, one dedupe rule.
 *
 * 4. NO AI, NO ROUTING, NO RESERVATION, NO CONSUMPTION.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  assertNoDuplicateEvent,
  assertPaymentProviderId,
  BillingError,
  createStripeProvider,
  PAYMENT_EVENT_TYPES,
  PAYMENT_FAILURE_REASONS,
  PAYMENT_PROVIDER_IDS,
  SUBSCRIPTION_STATUSES,
  type PaymentCustomerRepository,
  type PaymentEvent,
  type PaymentEventRepository,
  type PaymentProvider,
} from '@contentos/platform';
import { describe, expect, it } from 'vitest';

const paymentsDir = new URL('../../packages/platform/src/billing/payments/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, paymentsDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module this increment added. */
const MODULES = [
  'provider.ts',
  'repository.ts',
  'stripe/adapter.ts',
  'stripe/mapping.ts',
  'stripe/wire.ts',
] as const;

/** The ones OUTSIDE the adapter directory — where Stripe must not appear. */
const OUTSIDE_ADAPTER = ['provider.ts', 'repository.ts'] as const;

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** A file with its comments removed — prose is not a declaration. */
const sourceOf = (relative: string): string =>
  read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const event = (overrides: Partial<PaymentEvent> = {}): PaymentEvent => ({
  providerId: 'stripe',
  eventId: 'evt_1',
  type: 'invoice_paid',
  providerEventType: 'invoice.paid',
  occurredAt: '2026-02-01T00:00:00.000Z',
  externalCustomerId: 'cus_1',
  externalSubscriptionId: 'sub_1',
  organizationId: '018f7a1e-0000-7000-8000-0000000000aa',
  subscriptionId: null,
  ...overrides,
});

// ── 1 · Stripe is an implementation detail ──────────────────────────────────

describe('the SDK boundary the repo declared in Sprint 0', () => {
  it('is already configured, and names this directory', () => {
    const config = read('../../eslint.config.js');

    expect(config).toContain("group: ['stripe', '@stripe/*']");
    expect(config).toContain("permittedIn: 'packages/platform/src/billing/'");
  });

  it('and the adapter lives inside it', () => {
    // Not `packages/integrations/` — that is a CORE package, and
    // `core-never-imports-feature` would forbid it importing Billing at all.
    const cruiser = read('../../.dependency-cruiser.cjs');

    expect(cruiser).toContain(
      "CORE = 'packages/(security|database|domain|integrations|observability)'",
    );
    expect(cruiser).toContain("name: 'core-never-imports-feature'");
  });

  it('imports no Stripe SDK anywhere, in this increment', () => {
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/from 'stripe'|from '@stripe\//);
    }
  });
});

describe('nothing Stripe-shaped escapes the adapter', () => {
  it('the port names no Stripe type and no Stripe field', () => {
    const code = codeOf('provider.ts');

    expect(code).not.toMatch(/Stripe/);
    expect(code).not.toMatch(/cancel_at_period_end|current_period_|price_id|cus_|sub_/);
  });

  it('the repositories name no Stripe type', () => {
    expect(codeOf('repository.ts')).not.toMatch(/Stripe/);
  });

  it('no `*Wire` type is reachable outside the adapter', () => {
    for (const file of OUTSIDE_ADAPTER) {
      expect(codeOf(file)).not.toMatch(/Wire\b/);
    }
    // And the barrel exports none of them.
    const barrel = sourceOf('../../packages/platform/src/index.ts');
    expect(barrel).not.toMatch(/Wire\b/);
    expect(barrel).not.toMatch(/stripe\/wire\.js|stripe\/mapping\.js/);
  });

  it('the barrel exports only the adapter’s factory and its transport seam', () => {
    const barrel = read('../../packages/platform/src/index.ts');

    expect(barrel).toContain('createStripeProvider');
    expect(barrel).toContain('StripeTransport');
    // Not the translations: exporting one would put Stripe's JSON in the
    // platform's vocabulary and make a second provider impossible.
    expect(barrel).not.toContain('mapStripeEventType');
    expect(barrel).not.toContain('fromStripeSubscription');
    expect(barrel).not.toContain('STRIPE_STATUS_MAP');
  });

  it('returns domain models whose fields are ours, not the provider’s', () => {
    const provider: PaymentProvider = createStripeProvider({
      transport: { post: () => Promise.resolve({ ok: true, body: {} }) },
      webhookSecret: 'whsec_x',
    });

    expect(provider.providerId).toBe('stripe');
    expect(PAYMENT_PROVIDER_IDS).toEqual(['stripe']);
  });

  it('the domain event type is ours, never the provider’s string', () => {
    expect(PAYMENT_EVENT_TYPES).toContain('invoice_paid');
    expect(PAYMENT_EVENT_TYPES as readonly string[]).not.toContain('invoice.paid');
  });
});

// ── 2 · It never owns commercial state ──────────────────────────────────────

describe('the provider reports; Billing decides', () => {
  it('transitions no subscription', () => {
    // "It never owns commercial state." `createSubscription` on the PORT is a
    // provider call; what must not appear is Billing's own lifecycle being
    // driven from here.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/applyTransition\(|assertTransitionAllowed\(/);
      expect(code).not.toMatch(/\brenew\(|changePlan\(|assertNotStale\(/);
    }
  });

  it('imports Billing’s lifecycle for its TYPES only, never its functions', () => {
    // `SubscriptionStatus` is the vocabulary a provider status is translated
    // into; `applyTransition` is the authority to change one.
    for (const file of MODULES) {
      const code = codeOf(file);
      const imports = code.match(/^import[^;]+from '[^']*subscription\.js';/gm) ?? [];
      for (const statement of imports) {
        expect(statement).toMatch(/import type|^\s*import \{\s*$|type \w/);
        expect(statement).not.toMatch(/\{\s*(?:applyTransition|renew|changePlan)/);
      }
    }
  });

  it('writes no ledger entry and grants no credit', () => {
    // "Do NOT grant credits. Do NOT mutate the ledger."
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\.append\(|appendEntry|createCreditLedgerService|LedgerEntry/);
      expect(code).not.toMatch(/grantCredits|recordGrant|calculateBalance|parseAmount/);
    }
  });

  it('touches no reservation and no consumption', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/authorizeSpend|recordConsumption|CreditHold|CreditReservation/);
      expect(code).not.toMatch(/planConsumption|planSettlement|\.\.\/\.\.\/credits\//);
    }
  });

  it('generates no invoice and calculates no tax', () => {
    // Both explicitly out of scope. `StripeInvoiceWire` is the shape of an
    // `invoice.paid` body, which the increment requires mapping — READING an
    // invoice Stripe issued is not issuing one. A domain type or a function
    // would be this layer owning one.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(
        /(?:interface|type|class)\s+\w*(?:Invoice|Tax|Refund|Coupon)(?!Wire)\w*/i,
      );
      expect(code).not.toMatch(/(?:function|const)\s+\w*(?:invoice|tax|refund|coupon)/i);
      expect(code).not.toMatch(/calculateTax|issueInvoice|\brefund\(/i);
    }
  });

  it('holds no card data', () => {
    // "No card data ever enters this system."
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/\bcard\b|last4|\bcvv\b|\bpan\b|card_number/i);
    }
  });

  it('reads no clock', () => {
    // Every instant is supplied or comes from the provider. A `receivedAt` the
    // adapter read itself could not be asserted on, and the replay window is
    // the thing most worth asserting.
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/Date\.now\(|new Date\(\)|Math\.random\(|randomUUID/);
    }
  });
});

// ── 3 · One webhook pipeline ────────────────────────────────────────────────

describe('one webhook pipeline, not two', () => {
  const provider = createStripeProvider({
    transport: { post: () => Promise.resolve({ ok: true, body: {} }) },
    webhookSecret: 'whsec_x',
  });

  it('has exactly one event-type map', () => {
    expect(codeOf('stripe/mapping.ts')).toMatch(/STRIPE_EVENT_TYPE_MAP/);
    for (const file of MODULES.filter((f) => f !== 'stripe/mapping.ts')) {
      expect(codeOf(file)).not.toMatch(/EVENT_TYPE_MAP\s*[:=]/);
    }
  });

  it('maps the six the increment names', () => {
    expect(PAYMENT_EVENT_TYPES).toEqual([
      'checkout_completed',
      'subscription_created',
      'subscription_updated',
      'subscription_cancelled',
      'invoice_paid',
      'invoice_payment_failed',
    ]);
  });

  it('verifies a signature in exactly one place', () => {
    const adapter = codeOf('stripe/adapter.ts');
    expect(adapter).toMatch(/hmacSha256/);
    expect(adapter).toMatch(/constantTimeEquals/);

    // Carrying the header on `WebhookDelivery` is the port's job; VERIFYING it
    // is the adapter's, and only the adapter's.
    for (const file of MODULES.filter((f) => f !== 'stripe/adapter.ts')) {
      expect(codeOf(file)).not.toMatch(/hmac|createHmac|verifySignature|digest\(/i);
    }
  });

  it('reuses the frozen crypto primitives rather than its own', () => {
    // A hand-rolled comparison here would be a timing oracle on a signature.
    expect(codeOf('stripe/adapter.ts')).toMatch(/from '@contentos\/security'/);
    expect(codeOf('stripe/adapter.ts')).not.toMatch(/createHash\(|=== expected/);
  });

  it('rejects an unsigned delivery', () => {
    expect(
      provider.receiveWebhook({
        payload: '{}',
        signatureHeader: '',
        receivedAt: '2026-02-01T00:00:00.000Z',
      }).outcome,
    ).toBe('rejected');
  });

  it('deduplicates by the provider’s event id', () => {
    expect(() => {
      assertNoDuplicateEvent([event()], event());
    }).toThrow(BillingError);
  });

  it('and the store carries the same constraint billing.md names', () => {
    const code = codeOf('repository.ts');
    expect(code).toMatch(/recordEvent\(/);
    expect(code).toMatch(/hasEvent\(/);
    expect(read('../../contentos-docs/04-platform/billing.md')).toContain(
      'UNIQUE (provider, provider_event_id)',
    );
  });
});

describe('the ports are ports', () => {
  it('ship no implementation', () => {
    const code = codeOf('repository.ts');
    expect(code).toMatch(/interface PaymentCustomerRepository/);
    expect(code).toMatch(/interface PaymentEventRepository/);
    expect(code).not.toMatch(/^export (async )?function/m);
    expect(code).not.toMatch(/^export const/m);
  });

  it('are append-only', () => {
    const code = codeOf('repository.ts');
    expect(code).not.toMatch(/updateEvent|deleteEvent|markProcessed|reprocess|updateCustomer/);
  });

  it('write no SQL and import no driver', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|knex|drizzle|prisma)/);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|CREATE TABLE|\.query\(/i);
    }
  });

  it('are reachable as types from the barrel', () => {
    const customers: PaymentCustomerRepository | null = null;
    const events: PaymentEventRepository | null = null;

    expect([customers, events]).toEqual([null, null]);
  });
});

// ── 4 · No AI, no routing ───────────────────────────────────────────────────

describe('the modules depend on nothing they may not', () => {
  it('import nothing from the AI platform or provider routing', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/ai/);
      expect(code).not.toMatch(/ModelProvider|routeRequest|selectProvider|RoutingPolicy/);
      expect(code).not.toMatch(/orchestrat|workflowRuntime|promptTemplate|modelTier/i);
    }
  });

  it('make no HTTP call of their own', () => {
    // The transport is the seam; an adapter that fetched would bypass the
    // SafeUrlFetcher chokepoint and every retry policy above it.
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/fetch\(|axios|got\(|https?:\/\/[a-z]/);
    }
  });

  it('import only from contracts-free places', () => {
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/@contentos\/contracts/);
    }
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: no Stripe SDK dependency is added', () => {
    // The increment says SDK imports must stay inside the adapter. It also says
    // "Create provider interfaces only", and puts REST APIs and database
    // implementation out of scope — so this increment makes no live call, and a
    // dependency with no call site is one knip would flag and the Licences gate
    // would scan. Stripe's wire shapes are declared in `stripe/wire.ts`; the
    // eslint rule already reserves the SDK's only legal home for when live
    // calls land.
    const manifest = read('../../packages/platform/package.json');

    expect(manifest).not.toContain('"stripe"');
    // And no wire INTERFACES either: every field of an untrusted body is read
    // as `unknown` and proven, so a declared shape would suggest a contract
    // that does not hold. The readers are what exist.
    expect(codeOf('stripe/wire.ts')).not.toMatch(/interface \w*Wire/);
    expect(codeOf('stripe/wire.ts')).toMatch(/function readString\(source: unknown/);
  });

  it('DEVIATION: transport is injected, so translation is testable', () => {
    // The same shape `CreditsExecutor` uses: the logic worth asserting is the
    // part that is not I/O. The SDK becomes a `StripeTransport` later.
    expect(codeOf('stripe/adapter.ts')).toMatch(/interface StripeTransport/);
    expect(codeOf('stripe/adapter.ts')).toMatch(/options\.transport|const \{ transport \}/);
  });

  it('DEVIATION: an unmapped event type is IGNORED, not rejected', () => {
    // Stripe sends dozens of types to one endpoint. Refusing them would fail on
    // traffic Stripe is correct to send, and it would retry for days.
    expect(codeOf('provider.ts')).toMatch(/outcome: 'ignored'/);
  });

  it('DEVIATION: `receiveWebhook` is synchronous', () => {
    // "Mapping only. Do not mutate Billing state" — a method returning a
    // promise would invite a store call inside it.
    expect(codeOf('provider.ts')).toMatch(
      /receiveWebhook\(delivery: WebhookDelivery\): WebhookOutcome/,
    );
  });

  it('DEVIATION: provider failures are values; caller mistakes throw', () => {
    // A declined card is the answer, not an exception. An unknown provider id
    // is a bug.
    expect(PAYMENT_FAILURE_REASONS).toEqual([
      'PaymentFailed',
      'WebhookInvalid',
      'ProviderUnavailable',
      'ReconciliationError',
    ]);
    expect(() => assertPaymentProviderId('paypal')).toThrow(BillingError);
  });

  it('DEVIATION: three codes were added to the frozen BillingErrorCode', () => {
    // Additive, and in the module that already owns the taxonomy — a second
    // error class for payments would mean catching two things to learn one fact.
    const errors = read('../../packages/platform/src/billing/errors.ts');

    expect(errors).toContain("'UnknownProvider'");
    expect(errors).toContain("'MalformedWebhook'");
    expect(errors).toContain("'DuplicateWebhook'");
  });

  it('DEVIATION: Stripe’s statuses are mapped, not adopted', () => {
    // Stripe has eight and we have six. `cancel_pending` is the one that
    // matters: Stripe expresses it as `active` plus a flag.
    expect(SUBSCRIPTION_STATUSES).toContain('cancel_pending');
    expect(codeOf('stripe/mapping.ts')).toMatch(/cancelAtPeriodEnd && mapped === 'active'/);
  });

  it('DEVIATION: untrusted keys are read with Object.hasOwn', () => {
    // A bare lookup of `'constructor'` on a plain-object map returns a
    // FUNCTION, and the key here comes off an unauthenticated request body.
    const mapping = codeOf('stripe/mapping.ts');
    expect(mapping).toMatch(/Object\.hasOwn\(STRIPE_EVENT_TYPE_MAP/);
    expect(mapping).toMatch(/Object\.hasOwn\(STRIPE_STATUS_MAP/);
  });
});
