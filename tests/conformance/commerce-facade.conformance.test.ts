/**
 * The Commercial Facade against the components it must not become.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT DELEGATES. No lifecycle rule, no arithmetic, no signature check and no
 *    plan validation is written here; each is called from the component that
 *    owns it. Structural, per module.
 *
 * 2. IT COMPOSES, NEVER CONSTRUCTS. No `new`, no factory call, no default
 *    dependency, no global. Everything arrives as an interface.
 *
 * 3. IT IS THE SAME FACADE THE CONTENT PLATFORM ALREADY HAS. One request
 *    union, one result union, refusals as values, tenancy from the context.
 *    A second convention for one job would be the thing to avoid.
 *
 * 4. NO STRIPE, NO AI, NO DATABASE, NO HTTP.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  COMMERCIAL_ERROR_CODES,
  COMMERCIAL_OPERATIONS,
  createCommercialService,
  isCommercialErrorCode,
  isCommercialOperation,
  validateCommercialRequest,
  type CommercialRequest,
  type CommercialService,
  type CommercialServiceOptions,
} from '@contentos/platform';
import { describe, expect, it } from 'vitest';

const commerceDir = new URL('../../packages/platform/src/commerce/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, commerceDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/** Every module this increment added, excluding the test fixture. */
const MODULES = ['model.ts', 'validation.ts', 'service.ts'] as const;

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// ── 1 · It delegates ────────────────────────────────────────────────────────

describe('the facade writes none of the logic it coordinates', () => {
  it('declares no lifecycle of its own', () => {
    // Billing owns the subscription machine; a second table here would be the
    // one every caller actually hit.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/TRANSITION_RULES|SUBSCRIPTION_STATUSES\s*=|canTransition\s*\(/);
      expect(code).not.toMatch(/(?:const|let)\s+\w*(?:STATUSES|TRANSITIONS)\s*=/);
    }
  });

  it('does no money arithmetic', () => {
    // Availability, balance and settlement each have an owner, and all three
    // work in scaled integers that a facade re-deriving them would get wrong.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/parseAmount|formatAmount|subtractAmounts|addAmounts|ScaledAmount/);
      expect(code).not.toMatch(/[+\-*/]\s*BigInt|\bbigint\b/);
    }
  });

  it('verifies no signature and parses no webhook body', () => {
    // The adapter owns both. A facade that read a byte of the body would be a
    // second place a forged webhook could be accepted.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/hmac|createHmac|JSON\.parse|signature[A-Z]?\w*\s*=/i);
    }
  });

  it('validates no plan and computes no period', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/createPlanLimits|assertSubscribable|firstPeriod|nextPeriod/);
    }
  });

  it('calls the owners instead', () => {
    const service = codeOf('service.ts');

    expect(service).toMatch(/createBillingAccount\(/);
    expect(service).toMatch(/createSubscription\(/);
    expect(service).toMatch(/changePlan\(/);
    expect(service).toMatch(/applyTransition\(/);
    expect(service).toMatch(/calculateAvailability\(/);
  });

  it('takes the balance from the ledger repository, never a local fold', () => {
    const service = codeOf('service.ts');

    expect(service).toMatch(/ledger\.calculateBalance\(/);
    expect(service).not.toMatch(/calculateBalance\(\{/);
  });

  it('appends nothing to the ledger and grants no credit', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/appendEntry|recordGrant|grantCredits|LedgerEntry/);
      expect(code).not.toMatch(/authorizeSpend|recordConsumption|planConsumption|planSettlement/);
    }
  });

  it('implements no invoice, tax or refund', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(
        /(?:interface|type|class|function|const)\s+\w*(?:Invoice|Tax|Refund|Coupon)/i,
      );
    }
  });
});

// ── 2 · It composes, never constructs ───────────────────────────────────────

describe('every dependency is injected', () => {
  it('constructs nothing', () => {
    // No `new`, no factory call, no default. That is what "no service locator,
    // no globals" means when it is structural rather than a promise.
    // `new Set(...)` to dedupe a local array is not a dependency; constructing
    // a provider, a service or a client would be.
    const BUILT_IN = /\bnew (?:Set|Map|Error|Date|Promise|URL)\b/g;
    for (const file of MODULES) {
      const code = codeOf(file).replace(BUILT_IN, '');
      expect(code).not.toMatch(/\bnew [A-Z]/);
      expect(code).not.toMatch(
        /createStripeProvider|createCreditsService|createCreditLedgerService/,
      );
    }
  });

  it('has no default for any dependency', () => {
    // A default would be a dependency nobody chose, reached by whoever forgot.
    const service = codeOf('service.ts');
    expect(service).not.toMatch(/options\.\w+ \?\?/);
  });

  it('takes all eight ports as interfaces', () => {
    const service = codeOf('service.ts');
    for (const port of [
      'accounts: BillingAccountRepository',
      'subscriptions: SubscriptionRepository',
      'plans: PlanRepository',
      'ledger: CreditLedgerRepository',
      'reservations: CreditReservationRepository',
      'provider: PaymentProvider',
      'paymentCustomers: PaymentCustomerRepository',
      'paymentEvents: PaymentEventRepository',
    ]) {
      expect(service).toContain(port);
    }
  });

  it('holds a PaymentProvider, not an adapter', () => {
    // The facade has no way to know which provider it holds, which is what
    // keeps Stripe an implementation detail.
    const service = codeOf('service.ts');
    expect(service).not.toMatch(/StripeAdapter|StripeTransport|stripe/i);
  });

  it('is composable from interfaces alone', () => {
    // If this compiles and runs, nothing concrete is required.
    const options: CommercialServiceOptions | null = null;
    const built: CommercialService | null = null;

    expect([options, built]).toEqual([null, null]);
    expect(typeof createCommercialService).toBe('function');
  });

  it('reads no clock and generates no id', () => {
    // Every timestamp and id it passes on came in with the request.
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|randomUUID|secureId/);
    }
  });
});

// ── 3 · The same facade shape ───────────────────────────────────────────────

describe('it is the shape the Content Platform facade already established', () => {
  it('has one request union and one result union', () => {
    const model = codeOf('model.ts');
    expect(model).toMatch(/export type CommercialRequest =/);
    expect(model).toMatch(/export type CommercialResult =/);
  });

  it('answers with a success or a refusal, and never throws', () => {
    const model = codeOf('model.ts');
    expect(model).toMatch(/outcome: 'ok'/);
    expect(model).toMatch(/outcome: 'refused'/);

    // Every throw in the service is inside a delegate's own guard, never on
    // the way out: the only `throw` statements are absent entirely.
    expect(codeOf('service.ts')).not.toMatch(/^\s*throw /m);
  });

  it('has one execute that dispatches to the named methods', () => {
    const service = codeOf('service.ts');
    expect(service).toMatch(/execute\(request: CommercialRequest\)/);
    for (const operation of COMMERCIAL_OPERATIONS) {
      expect(service).toContain(`case '${operation}':`);
    }
  });

  it('names exactly the eight operations the increment lists', () => {
    expect(COMMERCIAL_OPERATIONS).toEqual([
      'createBillingAccount',
      'createSubscription',
      'changePlan',
      'cancelSubscription',
      'createCheckoutSession',
      'createPortalSession',
      'receiveWebhook',
      'loadCommercialSummary',
    ]);
    expect(isCommercialOperation('mintCredits')).toBe(false);
  });

  it('contributes its delegates’ codes rather than restating them', () => {
    // A caller branching on a billing failure sees the code billing gave it.
    for (const code of ['PlanNotFound', 'IncompatiblePlan', 'InvalidTransition', 'StaleVersion']) {
      expect(isCommercialErrorCode(code)).toBe(true);
    }
    expect(new Set(COMMERCIAL_ERROR_CODES).size).toBe(COMMERCIAL_ERROR_CODES.length);
  });

  it('returns the trace and nothing more about the caller', () => {
    // Returning the principal would be sending a caller its own authority back
    // down the wire.
    expect(codeOf('model.ts')).toMatch(
      /interface CommercialTrace \{\s*readonly requestId: string;\s*readonly correlationId: string;\s*\}/,
    );
  });

  it('mirrors the Content facade, which had the same answers', () => {
    const content = read('../../packages/ai/src/facade/model.ts');
    expect(content).toMatch(/export type ContentRequest =/);
    expect(content).toMatch(/outcome: 'refused'/);
  });
});

describe('tenancy comes from the context', () => {
  it('has no workspace on the commercial context', () => {
    // `billing.md`: "A workspace is never billed." A context carrying one would
    // invite a caller to scope a subscription to it.
    const model = codeOf('model.ts');
    const start = model.indexOf('interface CommercialContext');
    expect(start).toBeGreaterThan(-1);

    // To the interface's own closing brace — comments are already stripped, so
    // a section marker would not survive to delimit it.
    const contextBlock = model.slice(start, model.indexOf('\n}', start));
    expect(contextBlock).toMatch(/organizationId/);
    expect(contextBlock).not.toMatch(/workspace/i);
  });

  it('no payload names an organization', () => {
    // A payload naming one is how a caller subscribes somebody else.
    const model = codeOf('model.ts');
    const payloads = model.slice(
      model.indexOf('// ── Payloads'),
      model.indexOf('interface Envelope'),
    );
    expect(payloads).not.toMatch(/organizationId/);
  });

  it('and the service takes it from the context', () => {
    expect(codeOf('service.ts')).toMatch(/organizationId: context\.organizationId/);
  });

  it('refuses a request with no organization before any delegate is reached', () => {
    const issues = validateCommercialRequest({
      operation: 'loadCommercialSummary',
      context: {
        principal: { subjectId: 'x' } as never,
        organizationId: '',
        requestId: 'r',
        correlationId: 'c',
        at: '2026-03-01T00:00:00.000Z',
      },
      payload: {},
    } as CommercialRequest);

    expect(issues.map((issue) => issue.field)).toContain('context.organizationId');
  });
});

// ── 4 · No Stripe, no AI, no database ───────────────────────────────────────

describe('the modules depend on nothing they may not', () => {
  it('import no Stripe SDK and no adapter', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from 'stripe'|from '@stripe\//);
      expect(code).not.toMatch(/payments\/stripe\//);
    }
  });

  it('import nothing from the AI platform or provider routing', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/ai/);
      expect(code).not.toMatch(/ModelProvider|routeRequest|selectProvider|RoutingPolicy/);
      expect(code).not.toMatch(/orchestrat|workflowRuntime|promptTemplate|modelTier/i);
    }
  });

  it('import no database driver and write no SQL', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|knex|drizzle|prisma)/);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|CREATE TABLE|\.query\(|Transaction/i);
    }
  });

  it('make no HTTP call', () => {
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/fetch\(|axios|got\(|https?:\/\/[a-z]/);
    }
  });

  it('reach credits only through its ports and its published calculation', () => {
    const service = codeOf('service.ts');
    expect(service).toMatch(/from '\.\.\/credits\/repository\.js'/);
    expect(service).toMatch(/from '\.\.\/credits\/reservation-repository\.js'/);
    expect(service).toMatch(/from '\.\.\/credits\/availability\.js'/);
    // Not the service, not the executor, not the holds table.
    expect(service).not.toMatch(/credits-service|CreditsExecutor|credits\/holds/);
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: `CommercialResult` is the increment’s name for a response union', () => {
    // The Content facade calls the same shape `ContentResponse`. The increment
    // names this one `CommercialResult`; the vocabulary is its, the shape is
    // the one already established.
    expect(codeOf('model.ts')).toMatch(/export type CommercialResult =/);
  });

  it('DEVIATION: the context carries `at`, which the Content facade does not', () => {
    // Every commercial model takes its instant from the caller — an account's
    // `createdAt`, a subscription's `updatedAt`, a webhook's replay window. A
    // facade that read its own clock would make two of them disagree inside
    // one request.
    expect(codeOf('model.ts')).toMatch(/readonly at: string;/);
  });

  it('DEVIATION: `cancelSubscription` calls the provider BEFORE it writes', () => {
    // "Stripe is the source of truth for money." A record written first and a
    // provider call that then failed would stop billing a customer who is
    // still being charged.
    const service = codeOf('service.ts');
    const cancel = service.slice(
      service.indexOf('cancelSubscription(request)'),
      service.indexOf('createCheckoutSession(request)'),
    );
    expect(cancel.indexOf('provider.cancelSubscription')).toBeLessThan(
      cancel.indexOf('subscriptions.saveSubscription'),
    );
  });

  it('DEVIATION: an ignored webhook is a SUCCESS', () => {
    // The provider sends types this build does not map; refusing them would
    // make it redeliver for days.
    expect(codeOf('service.ts')).toMatch(/outcome === 'ignored'/);
  });

  it('DEVIATION: a refusal never echoes another organization’s id', () => {
    // A caller that guessed an id should not learn whose it was.
    expect(codeOf('validation.ts')).toMatch(
      /does not belong to organization '\$\{context\.organizationId\}'/,
    );
  });

  it('DEVIATION: the summary reads a bounded page of reservations', () => {
    // A summary is a page a customer looks at; an unbounded read would make one
    // organization's answer arbitrarily slow. Exact availability is the store's
    // to compute when precision matters.
    expect(codeOf('service.ts')).toMatch(/ACTIVE_RESERVATION_PAGE = \d+/);
  });

  it('DEVIATION: a BillingError keeps its own code', () => {
    // Flattening it to `ServiceFailed` would lose what the taxonomy already
    // said and send an operator looking in the wrong place.
    expect(codeOf('service.ts')).toMatch(/error instanceof BillingError/);
    expect(codeOf('service.ts')).toMatch(/error\.code/);
  });
});
