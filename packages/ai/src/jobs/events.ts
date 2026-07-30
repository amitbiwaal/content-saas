/**
 * Job lifecycle events.
 *
 * One per transition plus the creation, so the five states are observable from
 * the stream without reading the table. This module BUILDS envelopes; it does
 * not publish them — publication goes through the transactional outbox in the
 * state-changing transaction (ADR-020), and `packages/ai` may not import
 * `packages/events` any more than any other feature package may.
 *
 * ── Workspace-scoped ────────────────────────────────────────────────────────
 * A job is work done in a workspace, and `workspaces.id` IS `tenant_id`
 * (ADR-017). The job is its own aggregate, so `aggregateId` is the job id:
 * ordering per job is what a consumer needs, and a `JobCompleted` overtaking
 * its own `JobStarted` is the only ordering failure that matters here.
 *
 * ── No reason on the wire ───────────────────────────────────────────────────
 * `JobFailed` and `JobCancelled` carry no reason text. It is operator- or
 * caller-written free text, and an event reaches consumers with weaker controls
 * than the row does — the same rule the ledger, settings and notification
 * events follow. A consumer that needs the why reads the job under its own
 * authority. There is deliberately no field here it could travel in.
 */

import type { DomainEvent } from '@contentos/contracts';

/** Attribution on DLQ entries and contract ownership. */
export const JOB_PRODUCER = 'ai.jobs';

/** The aggregate, and therefore the ordering key: one job. */
export const JOB_AGGREGATE = 'Job';

export const JOB_EVENT_TYPES = [
  'JobQueued',
  'JobStarted',
  'JobCompleted',
  'JobFailed',
  'JobCancelled',
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];

/**
 * Common to every job event: which job, of what kind, where.
 *
 * `jobType` is carried because a consumer routes on it, and it is a declared
 * identifier rather than caller content.
 */
export interface JobEventPayload {
  readonly jobId: string;
  readonly jobType: string;
  readonly workspaceId: string;
  readonly organizationId: string;
}

export type JobQueuedPayload = JobEventPayload;
export type JobStartedPayload = JobEventPayload;
export type JobCompletedPayload = JobEventPayload;
export type JobFailedPayload = JobEventPayload;
export type JobCancelledPayload = JobEventPayload;

export interface JobEventContext {
  readonly eventId: string;
  readonly correlationId: string;
  /** Null for a root job — one a user started rather than one an event caused. */
  readonly causationId: string | null;
  readonly occurredAt: string;
}

function envelope(
  eventType: JobEventType,
  ctx: JobEventContext,
  payload: JobEventPayload,
): DomainEvent<JobEventPayload> {
  return {
    eventId: ctx.eventId,
    eventType,
    eventVersion: 1,
    aggregateType: JOB_AGGREGATE,
    aggregateId: payload.jobId,
    // The workspace IS the tenant (ADR-017).
    tenantId: payload.workspaceId,
    organizationId: payload.organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: JOB_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}

export function jobQueued(
  ctx: JobEventContext,
  payload: JobQueuedPayload,
): DomainEvent<JobQueuedPayload> {
  return envelope('JobQueued', ctx, payload);
}

export function jobStarted(
  ctx: JobEventContext,
  payload: JobStartedPayload,
): DomainEvent<JobStartedPayload> {
  return envelope('JobStarted', ctx, payload);
}

export function jobCompleted(
  ctx: JobEventContext,
  payload: JobCompletedPayload,
): DomainEvent<JobCompletedPayload> {
  return envelope('JobCompleted', ctx, payload);
}

export function jobFailed(
  ctx: JobEventContext,
  payload: JobFailedPayload,
): DomainEvent<JobFailedPayload> {
  return envelope('JobFailed', ctx, payload);
}

export function jobCancelled(
  ctx: JobEventContext,
  payload: JobCancelledPayload,
): DomainEvent<JobCancelledPayload> {
  return envelope('JobCancelled', ctx, payload);
}

/** Which event a transition produces. Creation produces `JobQueued`. */
export const EVENT_FOR_TRANSITION = {
  start: 'JobStarted',
  complete: 'JobCompleted',
  fail: 'JobFailed',
  cancel: 'JobCancelled',
} as const satisfies Readonly<Record<string, JobEventType>>;
