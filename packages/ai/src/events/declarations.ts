/**
 * The AI Platform's event registry declarations.
 *
 * Spec: `13-event-platform/event-registry.md` — source-controlled, loaded at
 * startup, never a runtime table. The same shape `packages/platform` uses, and
 * for the same reason: declaring an event type is a statement by the package
 * that PRODUCES it, and it belongs beside the builders that emit it.
 *
 * ── One stream, one aggregate family ────────────────────────────────────────
 * Jobs get their own stream. Ordering is per `aggregateId` — per JOB — so
 * splitting the five types across streams would buy nothing and multiply
 * consumer-group bookkeeping. Keeping them off the platform streams matters
 * more: a job event per AI call is the highest-volume family the platform will
 * carry, and sharing a stream would set every organization lifecycle
 * consumer's lag to whatever that volume sustains.
 *
 * ── One consumer, declared with its handler ─────────────────────────────────
 * `JobQueued` alone has a consumer: the runner that moves a job to `running`.
 * The other four are emitted and nothing reacts — composition refuses to start
 * a group with no handler, so a group is declared in the increment that
 * supplies one.
 */

import type {
  ConsumerDeclaration,
  EventTypeDeclaration,
  RegistryContribution,
} from '@contentos/contracts';

import { JOB_EVENT_TYPES, JOB_PRODUCER } from '../jobs/events.js';

/** This package identifies itself in diagnostics and collision detection. */
export const AI_REGISTRY_SOURCE = '@contentos/ai';

export const JOB_STREAM = 'job';

/**
 * The runner group.
 *
 * Named for what it does rather than for the event it reads, because the moves
 * it will eventually make — dispatching real work inside `running` — are what
 * later increments add to it.
 */
export const JOB_RUNNER_GROUP = 'ai-job-runner';

/** The component hosting it — the single worker binary. */
const JOB_RUNNER_COMPONENT = 'workers.host.jobs';

const runnerConsumer = (consumerGroup: string): ConsumerDeclaration => ({
  consumerGroup,
  component: JOB_RUNNER_COMPONENT,
  versions: [1],
  // A queued job nobody started is work a customer asked for and never got.
  criticality: 'critical',
  handlerIdempotencyKey: consumerGroup,
  onUnknownVersion: 'dead-letter',
});

/** Which group, if any, consumes a given type. */
const CONSUMERS_BY_TYPE: Readonly<Record<string, readonly ConsumerDeclaration[]>> = {
  JobQueued: [runnerConsumer(JOB_RUNNER_GROUP)],
};

/**
 * Workspace-scoped: `workspaces.id` IS `tenant_id` (ADR-017), and a job is work
 * done in a workspace.
 */
export const AI_EVENT_DECLARATIONS: readonly EventTypeDeclaration[] = JOB_EVENT_TYPES.map(
  (eventType) => ({
    eventType,
    version: 1,
    state: 'active',
    stream: JOB_STREAM,
    producer: JOB_PRODUCER,
    tenantScope: 'workspace',
    consumers: CONSUMERS_BY_TYPE[eventType] ?? [],
  }),
);

/**
 * Every event type this package's builders can produce.
 *
 * Derived from the builders' own constant rather than re-listed, so a new type
 * cannot be added to a builder without appearing here — and composition then
 * fails until it is declared.
 */
export const AI_EMITTABLE_EVENT_TYPES: readonly string[] = [...JOB_EVENT_TYPES];

/** What a composition root includes to register this package's event types. */
export const AI_REGISTRY_CONTRIBUTION: RegistryContribution = {
  source: AI_REGISTRY_SOURCE,
  declarations: AI_EVENT_DECLARATIONS,
  emits: AI_EMITTABLE_EVENT_TYPES,
};
