/**
 * Credit ledger events — `04-platform/credits.md` §Events.
 *
 * This increment delivers the LEDGER vocabulary only: the five events that
 * correspond one-to-one with the five `entry_type` values. `CreditHeld`,
 * `CreditSettled`, `CreditReleased`, `CreditsLow` and `CreditsExhausted` belong
 * to the hold protocol and the balance engine, neither of which exists yet;
 * declaring them now would register event types nothing can emit.
 *
 * This module BUILDS envelopes. It does not publish them — publication goes
 * through the transactional outbox in the state-changing transaction (ADR-020),
 * and `packages/platform` may not import `packages/events`.
 *
 * ── Payloads carry identifiers and scalars, never the reason text ───────────
 * `reason` is operator-written free text on adjustments and support actions. An
 * event reaches notification channels and webhook subscribers with weaker
 * controls than the row does, so the payload carries `entryId` and a consumer
 * that genuinely needs the narrative reads the row under its own authority.
 * There is deliberately nowhere in these types to put it.
 *
 * ── Amounts travel as strings ───────────────────────────────────────────────
 * `amount` is `NUMERIC(20,6)`. Serialising it as a JSON number would round-trip
 * through an IEEE-754 double and silently lose money at the sixth decimal — the
 * one class of defect a financial ledger cannot absorb, because there is no
 * UPDATE path to correct it afterwards.
 */

import type { DomainEvent } from '@contentos/contracts';

/** Attribution on DLQ entries and contract ownership. */
export const CREDIT_PRODUCER = 'platform.credits';

/**
 * The aggregate, and therefore the outbox partition and ordering key.
 *
 * One credit account per organization: balance resolves there, so that is the
 * granularity at which entries must stay ordered. `aggregateId` is the
 * organization id.
 */
export const CREDIT_ACCOUNT_AGGREGATE = 'CreditAccount';

export const CREDIT_EVENT_TYPES = [
  'CreditGranted',
  'CreditConsumed',
  'CreditRefunded',
  'CreditAdjusted',
  'CreditExpired',
] as const;

export type CreditEventType = (typeof CREDIT_EVENT_TYPES)[number];

/** Common to every ledger event: which row, whose account, how much, which way. */
export interface CreditLedgerEventPayload {
  readonly entryId: string;
  readonly organizationId: string;
  /** Decimal string. Never a JSON number — see the module note. */
  readonly amount: string;
  readonly direction: 'credit' | 'debit';
}

export interface CreditGrantedPayload extends CreditLedgerEventPayload {
  readonly direction: 'credit';
}

/** The only entry type that names a workspace: consumption is attributed. */
export interface CreditConsumedPayload extends CreditLedgerEventPayload {
  readonly direction: 'debit';
  readonly workspaceId: string;
}

/** A compensating entry. `referenceEntryId` is the charge being reversed. */
export interface CreditRefundedPayload extends CreditLedgerEventPayload {
  readonly direction: 'credit';
  readonly referenceEntryId: string | null;
}

/** Support may add or remove, so the direction is carried rather than implied. */
export type CreditAdjustedPayload = CreditLedgerEventPayload;

export interface CreditExpiredPayload extends CreditLedgerEventPayload {
  readonly direction: 'debit';
}

export type CreditEventPayload =
  | CreditGrantedPayload
  | CreditConsumedPayload
  | CreditRefundedPayload
  | CreditAdjustedPayload
  | CreditExpiredPayload;

export interface CreditEventContext {
  readonly eventId: string;
  readonly correlationId: string;
  /** Null for a root event — a user-initiated action rather than a reaction. */
  readonly causationId: string | null;
  readonly occurredAt: string;
}

/**
 * The tenant a credit event is published under.
 *
 * The same convention as `organizationEventTenantId`, and it holds for the same
 * reason: the credit account is an organization-owned aggregate, so the
 * organization IS its isolation boundary (ADR-029). It is restated here as a
 * named function rather than reused across a package boundary so that the
 * ledger's choice is visible at the ledger, and it matches
 * `credit_ledger_entries.tenant_id`, which the database CHECKs.
 */
export function creditEventTenantId(organizationId: string): string {
  return organizationId;
}

function envelope<T extends CreditLedgerEventPayload>(
  eventType: CreditEventType,
  ctx: CreditEventContext,
  payload: T,
): DomainEvent<T> {
  return {
    eventId: ctx.eventId,
    eventType,
    eventVersion: 1,
    aggregateType: CREDIT_ACCOUNT_AGGREGATE,
    aggregateId: payload.organizationId,
    tenantId: creditEventTenantId(payload.organizationId),
    organizationId: payload.organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: CREDIT_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}

export function creditGranted(
  ctx: CreditEventContext,
  payload: CreditGrantedPayload,
): DomainEvent<CreditGrantedPayload> {
  return envelope('CreditGranted', ctx, payload);
}

export function creditConsumed(
  ctx: CreditEventContext,
  payload: CreditConsumedPayload,
): DomainEvent<CreditConsumedPayload> {
  return envelope('CreditConsumed', ctx, payload);
}

export function creditRefunded(
  ctx: CreditEventContext,
  payload: CreditRefundedPayload,
): DomainEvent<CreditRefundedPayload> {
  return envelope('CreditRefunded', ctx, payload);
}

export function creditAdjusted(
  ctx: CreditEventContext,
  payload: CreditAdjustedPayload,
): DomainEvent<CreditAdjustedPayload> {
  return envelope('CreditAdjusted', ctx, payload);
}

export function creditExpired(
  ctx: CreditEventContext,
  payload: CreditExpiredPayload,
): DomainEvent<CreditExpiredPayload> {
  return envelope('CreditExpired', ctx, payload);
}
