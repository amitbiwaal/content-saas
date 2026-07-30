/**
 * Hold-protocol and threshold events — `04-platform/credits.md` §Events.
 *
 * T3.4 deliberately left these undeclared: "declaring them now would register
 * event types nothing can emit." The hold protocol and the balance engine exist
 * as of this increment, so they are declared here beside the service that emits
 * them.
 *
 * They live in their own module rather than in `events.ts` because that one is
 * about the LEDGER — five events, one per `entry_type`, each naming a row. A
 * hold is not a ledger row and a threshold crossing is not a movement; folding
 * them into `CreditLedgerEventPayload` would give both a mandatory `entryId`
 * neither has.
 *
 * ── Amounts travel as strings, for the same reason ──────────────────────────
 * A JSON number round-trips through an IEEE-754 double. A balance a consumer
 * rebuilt from these events must equal the ledger to the sixth decimal, or
 * reconciliation reports a discrepancy nobody can explain.
 *
 * ── No reason text, and no free-text release cause ──────────────────────────
 * Same rule as the ledger events: the payload carries identifiers and scalars.
 * A consumer needing the narrative reads the row under its own authority.
 */

import type { DomainEvent } from '@contentos/contracts';

import { CREDIT_ACCOUNT_AGGREGATE, CREDIT_PRODUCER, type CreditEventContext } from './events.js';

export const CREDIT_HOLD_EVENT_TYPES = ['CreditHeld', 'CreditSettled', 'CreditReleased'] as const;

export const CREDIT_THRESHOLD_EVENT_TYPES = ['CreditsLow', 'CreditsExhausted'] as const;

export type CreditHoldEventType = (typeof CREDIT_HOLD_EVENT_TYPES)[number];
export type CreditThresholdEventType = (typeof CREDIT_THRESHOLD_EVENT_TYPES)[number];

/** Common to the three hold events. */
export interface CreditHoldEventPayload {
  readonly holdId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly runId: string;
  /** The reserved maximum, as a decimal string. */
  readonly amount: string;
}

export interface CreditHeldPayload extends CreditHoldEventPayload {
  readonly expiresAt: string;
}

export interface CreditSettledPayload extends CreditHoldEventPayload {
  /** What was actually charged. The remainder was never deducted. */
  readonly consumed: string;
  /** `amount − consumed`, released by the settlement. */
  readonly released: string;
}

/**
 * A release, whichever way the hold left `held`.
 *
 * `cause` distinguishes an orchestrator releasing a failed run from the TTL
 * sweep reclaiming a stranded one, and from a suspension releasing everything.
 * They are the same state change but page for different reasons — a sweep
 * release usually means a lost workflow.
 */
export type ReleaseCause = 'failed' | 'cancelled' | 'expired' | 'suspended';

export interface CreditReleasedPayload extends CreditHoldEventPayload {
  readonly cause: ReleaseCause;
  /** Recorded against the hold before it closed; never deducted twice. */
  readonly consumed: string;
}

/**
 * The threshold events.
 *
 * Published on the TRANSITION into a state and never again while it holds. A
 * balance that sits below the threshold for a week produces one event, not one
 * per consumption — `credit_balances.threshold_state` is what remembers.
 */
export interface CreditsThresholdPayload {
  readonly organizationId: string;
  readonly balance: string;
  /** The configured threshold that was crossed. */
  readonly threshold: string;
  readonly previousState: 'ok' | 'low' | 'exhausted';
}

function envelope<T extends { readonly organizationId: string }>(
  eventType: CreditHoldEventType | CreditThresholdEventType,
  ctx: CreditEventContext,
  payload: T,
): DomainEvent<T> {
  return {
    eventId: ctx.eventId,
    eventType,
    eventVersion: 1,
    // The same aggregate as the ledger: one credit account per organization, so
    // a hold and the entries it produces stay ordered against each other.
    aggregateType: CREDIT_ACCOUNT_AGGREGATE,
    aggregateId: payload.organizationId,
    tenantId: payload.organizationId,
    organizationId: payload.organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: CREDIT_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}

export function creditHeld(
  ctx: CreditEventContext,
  payload: CreditHeldPayload,
): DomainEvent<CreditHeldPayload> {
  return envelope('CreditHeld', ctx, payload);
}

export function creditSettled(
  ctx: CreditEventContext,
  payload: CreditSettledPayload,
): DomainEvent<CreditSettledPayload> {
  return envelope('CreditSettled', ctx, payload);
}

export function creditReleased(
  ctx: CreditEventContext,
  payload: CreditReleasedPayload,
): DomainEvent<CreditReleasedPayload> {
  return envelope('CreditReleased', ctx, payload);
}

export function creditsLow(
  ctx: CreditEventContext,
  payload: CreditsThresholdPayload,
): DomainEvent<CreditsThresholdPayload> {
  return envelope('CreditsLow', ctx, payload);
}

export function creditsExhausted(
  ctx: CreditEventContext,
  payload: CreditsThresholdPayload,
): DomainEvent<CreditsThresholdPayload> {
  return envelope('CreditsExhausted', ctx, payload);
}
