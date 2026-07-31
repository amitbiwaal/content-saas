/**
 * Request validation for the Commercial Facade.
 *
 * ── Completeness and agreement. Nothing else ───────────────────────────────
 * "Is this request well-formed, does it name the things it must, and does what
 * it names agree with who is asking." Every other question — is this plan
 * subscribable, may this reservation be settled, is this signature valid — has
 * an owner, and a second copy here would be the copy every caller actually hit.
 *
 * So there is no plan lookup, no status check, no signature verification and no
 * arithmetic in this file. It refuses a request that could not possibly be
 * served; it never predicts what the answer would have been.
 *
 * ── Ownership is checked against the CONTEXT ───────────────────────────────
 * A record's organization must equal the context's. The failure this prevents
 * is one customer's subscription cancelled, or another's balance read, by a
 * caller who named an id it happened to know.
 */

import { isPlanCode } from '../billing/plan.js';
import { isBillingCycle } from '../billing/period.js';
import type { CommercialContext, CommercialRequest } from './model.js';
import { isCommercialOperation } from './model.js';

export interface RequestIssue {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

const present = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';

const missing = (field: string, detail: string): RequestIssue => ({
  field,
  code: 'MissingIdentifier',
  detail,
});

const invalid = (field: string, detail: string): RequestIssue => ({
  field,
  code: 'InvalidRequest',
  detail,
});

/**
 * The context every operation needs, whatever it is.
 *
 * A request with no organization cannot be served by any of them, and one with
 * no trace produces an answer nobody can correlate with the question.
 */
export function validateCommercialContext(context: CommercialContext): readonly RequestIssue[] {
  const issues: RequestIssue[] = [];

  if (!present(context.organizationId)) {
    issues.push(
      missing('context.organizationId', 'Every commercial operation resolves at an organization.'),
    );
  }
  if (!present(context.requestId)) {
    issues.push(missing('context.requestId', 'An answer with no request id cannot be correlated.'));
  }
  if (!present(context.correlationId)) {
    issues.push(
      missing('context.correlationId', 'A customer action is traced across every call it causes.'),
    );
  }
  if (!present(context.at)) {
    issues.push(
      missing(
        'context.at',
        'Every downstream model takes its instant from the request; a facade that read its own clock would make two of them disagree.',
      ),
    );
  }
  if (context.principal.subjectId.trim() === '') {
    issues.push(
      missing('context.principal', 'A commercial operation is always attributable to a subject.'),
    );
  }

  return issues;
}

/**
 * Everything a request must carry to be served at all.
 *
 * Returns the issues; the caller decides what to do with them. A validator that
 * threw would put two conventions in one layer.
 */
export function validateCommercialRequest(request: CommercialRequest): readonly RequestIssue[] {
  const issues: RequestIssue[] = [...validateCommercialContext(request.context)];

  if (!isCommercialOperation(request.operation)) {
    issues.push(
      invalid('operation', `'${String(request.operation)}' is not a commercial operation.`),
    );
    return Object.freeze(issues);
  }

  switch (request.operation) {
    case 'createBillingAccount': {
      const { payload } = request;
      if (!present(payload.currency)) {
        issues.push(missing('payload.currency', 'An account is denominated in a currency.'));
      }
      if (payload.workspaceId !== undefined && payload.workspaceId !== null) {
        if (!present(payload.workspaceId)) {
          issues.push(
            invalid(
              'payload.workspaceId',
              'A workspace must be named or absent; an empty string is neither.',
            ),
          );
        }
      }
      break;
    }

    case 'createSubscription': {
      const { payload } = request;
      if (!present(payload.subscriptionId)) {
        issues.push(missing('payload.subscriptionId', 'A subscription is identified once.'));
      }
      if (!isPlanCode(payload.planCode)) {
        issues.push(invalid('payload.planCode', `'${String(payload.planCode)}' is not a plan.`));
      }
      if (!isBillingCycle(payload.cycle)) {
        issues.push(invalid('payload.cycle', `'${String(payload.cycle)}' is not a billing cycle.`));
      }
      break;
    }

    case 'changePlan': {
      const { payload } = request;
      if (!present(payload.subscriptionId)) {
        issues.push(missing('payload.subscriptionId', 'Which subscription is changing plan.'));
      }
      if (!isPlanCode(payload.planCode)) {
        issues.push(invalid('payload.planCode', `'${String(payload.planCode)}' is not a plan.`));
      }
      break;
    }

    case 'cancelSubscription': {
      const { payload } = request;
      if (!present(payload.subscriptionId)) {
        issues.push(missing('payload.subscriptionId', 'Which subscription is being cancelled.'));
      }
      if (!present(payload.idempotencyKey)) {
        issues.push(
          missing(
            'payload.idempotencyKey',
            'A retried cancellation must reach the provider once; the provider has no undo.',
          ),
        );
      }
      break;
    }

    case 'createCheckoutSession': {
      const { payload } = request;
      if (!present(payload.externalPriceId)) {
        issues.push(missing('payload.externalPriceId', 'What is being bought.'));
      }
      if (!present(payload.successUrl)) {
        issues.push(missing('payload.successUrl', 'Where the customer returns on success.'));
      }
      if (!present(payload.cancelUrl)) {
        issues.push(missing('payload.cancelUrl', 'Where the customer returns on cancellation.'));
      }
      if (!present(payload.idempotencyKey)) {
        issues.push(
          missing(
            'payload.idempotencyKey',
            'A retried checkout must create one session, not two charges.',
          ),
        );
      }
      break;
    }

    case 'createPortalSession': {
      if (!present(request.payload.returnUrl)) {
        issues.push(missing('payload.returnUrl', 'Where the customer returns from the portal.'));
      }
      break;
    }

    case 'receiveWebhook': {
      const { payload } = request;
      if (!present(payload.payload)) {
        issues.push(missing('payload.payload', 'A webhook body, byte-for-byte.'));
      }
      if (!present(payload.signatureHeader)) {
        issues.push(
          missing(
            'payload.signatureHeader',
            'An unsigned webhook is a forged-payment vector; it is refused before it is read.',
          ),
        );
      }
      break;
    }

    case 'loadCommercialSummary':
      // The organization is the whole question, and the context carries it.
      break;
  }

  return Object.freeze(issues);
}

/**
 * Does this record belong to the organization asking?
 *
 * Returns an issue rather than throwing, so it composes with the rest of
 * validation. The failure it prevents is one customer's commercial state
 * reached by another who guessed an id.
 */
export function ownershipIssue(
  context: CommercialContext,
  record: { readonly organizationId: string } | null,
  what: string,
  field: string,
): RequestIssue | null {
  if (record === null) return null;
  if (record.organizationId === context.organizationId) return null;

  return {
    field,
    code: 'OwnershipMismatch',
    // Deliberately does not echo the OTHER organization's id back: a caller
    // that guessed an id should not learn whose it was.
    detail: `${what} does not belong to organization '${context.organizationId}'.`,
  };
}
