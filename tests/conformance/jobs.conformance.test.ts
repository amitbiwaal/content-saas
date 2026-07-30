/**
 * Job events against the REAL event platform.
 *
 * `packages/ai` may not import `packages/events`, so nothing inside it can
 * check the things that decide whether a job event actually flows: the frozen
 * envelope validator, a registry composed from BOTH packages' contributions,
 * and the subscription wiring.
 *
 * The composed registry matters most here. `packages/ai` is the first new
 * contribution since the platform's, and a collision between the two — a
 * duplicated type, a producer claimed twice — is a startup failure, not a
 * warning. This is where that is proven.
 */

import { describe, expect, it } from 'vitest';

import {
  AI_EMITTABLE_EVENT_TYPES,
  AI_EVENT_DECLARATIONS,
  AI_REGISTRY_CONTRIBUTION,
  JOB_AGGREGATE,
  JOB_EVENT_TYPES,
  JOB_PRODUCER,
  JOB_RUNNER_GROUP,
  JOB_STREAM,
  jobCancelled,
  jobCompleted,
  jobFailed,
  jobQueued,
  jobStarted,
  type JobService,
} from '@contentos/ai';
import type { DomainEvent } from '@contentos/contracts';
import { composeEventRegistry, createEventSerializer, validateEnvelope } from '@contentos/events';
import { PLATFORM_EVENT_DECLARATIONS, PLATFORM_REGISTRY_CONTRIBUTION } from '@contentos/platform';
import { createJobHandlers } from '@contentos/worker-host';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const JOB = '018f7a1e-0000-7000-7003-000000000001';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const ctx = {
  eventId: EVENT_ID,
  correlationId: CORRELATION,
  causationId: null,
  occurredAt: '2026-07-30T12:00:00.000Z',
};

const payload = {
  jobId: JOB,
  jobType: 'article.generate',
  workspaceId: WS,
  organizationId: ORG,
};

const EVENTS: readonly DomainEvent<unknown>[] = [
  jobQueued(ctx, payload),
  jobStarted(ctx, payload),
  jobCompleted(ctx, payload),
  jobFailed(ctx, payload),
  jobCancelled(ctx, payload),
];

describe('job events satisfy the frozen envelope contract', () => {
  for (const event of EVENTS) {
    it(`${event.eventType} validates`, () => {
      const result = validateEnvelope(event);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  }

  it('builds one envelope per declared type', () => {
    expect(EVENTS.map((e) => e.eventType).sort()).toEqual([...JOB_EVENT_TYPES].sort());
  });

  // `workspaces.id` IS `tenant_id` (ADR-017), and ordering is per JOB — a
  // JobCompleted overtaking its own JobStarted is the failure that matters.
  it('carries the workspace as tenant and the job as aggregate', () => {
    for (const event of EVENTS) {
      expect(event, event.eventType).toMatchObject({
        eventVersion: 1,
        aggregateType: JOB_AGGREGATE,
        aggregateId: JOB,
        tenantId: WS,
        organizationId: ORG,
        producer: JOB_PRODUCER,
      });
    }
  });

  // Same rule as the ledger, settings and notification events: an event
  // reaches consumers with weaker controls than the row does.
  it('carries no reason text on a failure or a cancellation', () => {
    const REASON = 'provider-timeout-after-three-attempts-7731';
    for (const event of [jobFailed(ctx, payload), jobCancelled(ctx, payload)]) {
      expect(JSON.stringify(event.payload), event.eventType).not.toContain(REASON);
      expect(Object.keys(event.payload as object), event.eventType).not.toContain('reason');
    }
  });
});

describe('the AI contribution composes with the platform', () => {
  // The first new registry contribution since Sprint 1. A duplicated type or a
  // producer claimed twice is a startup failure, not a warning.
  const composed = composeEventRegistry({
    contributions: [PLATFORM_REGISTRY_CONTRIBUTION, AI_REGISTRY_CONTRIBUTION],
  });

  it('builds without a collision against everything Sprint 1 declared', () => {
    expect(() =>
      composeEventRegistry({
        contributions: [PLATFORM_REGISTRY_CONTRIBUTION, AI_REGISTRY_CONTRIBUTION],
      }),
    ).not.toThrow();
  });

  for (const eventType of JOB_EVENT_TYPES) {
    it(`registers and validates ${eventType}`, () => {
      expect(composed.registry.isRegistered(eventType, 1)).toBe(true);
      const event = EVENTS.find((e) => e.eventType === eventType);
      expect(event).toBeDefined();
      if (event === undefined) return;
      const result = composed.registry.validate(event);
      expect(result.ok, JSON.stringify(result)).toBe(true);
    });
  }

  it('routes the whole family to the job stream', () => {
    for (const eventType of JOB_EVENT_TYPES) {
      expect(composed.registry.streamFor(eventType), eventType).toBe(JOB_STREAM);
    }
  });

  // The dispatcher reads the scope from HERE, not from the handler.
  it('resolves the job scope through the composed registry', () => {
    for (const eventType of JOB_EVENT_TYPES) {
      expect(composed.tenantScopeOf(eventType, 1), eventType).toBe('workspace');
    }
  });

  // A job event per AI call is the highest-volume family the platform will
  // carry; sharing a stream would set every other consumer's lag to it.
  it('keeps the job stream separate from every platform stream', () => {
    const platformStreams = new Set(PLATFORM_EVENT_DECLARATIONS.map((d) => d.stream));
    expect(platformStreams.has(JOB_STREAM)).toBe(false);
  });

  it('declares no job type the platform already declares', () => {
    const platformTypes = new Set(PLATFORM_EVENT_DECLARATIONS.map((d) => d.eventType));
    for (const eventType of JOB_EVENT_TYPES) {
      expect(platformTypes.has(eventType), eventType).toBe(false);
    }
  });

  it('declares every type it can emit, and nothing it cannot', () => {
    expect([...AI_EMITTABLE_EVENT_TYPES].sort()).toEqual([...JOB_EVENT_TYPES].sort());
    expect(AI_EVENT_DECLARATIONS.map((d) => d.eventType).sort()).toEqual(
      [...AI_EMITTABLE_EVENT_TYPES].sort(),
    );
  });

  it('scopes every job type to the workspace', () => {
    for (const declaration of AI_EVENT_DECLARATIONS) {
      expect(declaration.tenantScope, declaration.eventType).toBe('workspace');
      expect(declaration.version, declaration.eventType).toBe(1);
      expect(declaration.state, declaration.eventType).toBe('active');
    }
  });
});

describe('the runner is subscribed, and only to JobQueued', () => {
  const byType = new Map(AI_EVENT_DECLARATIONS.map((d) => [d.eventType, d]));

  it('declares the runner group on JobQueued', () => {
    expect((byType.get('JobQueued')?.consumers ?? []).map((c) => c.consumerGroup)).toEqual([
      JOB_RUNNER_GROUP,
    ]);
  });

  // Composition refuses to start a group with no handler, so the other four
  // are emitted and nothing reacts.
  it('declares no consumer for the other four', () => {
    for (const eventType of JOB_EVENT_TYPES.filter((t) => t !== 'JobQueued')) {
      expect(byType.get(eventType)?.consumers, eventType).toEqual([]);
    }
  });

  it('marks the runner critical and dead-lettering', () => {
    const consumer = (byType.get('JobQueued')?.consumers ?? [])[0];
    expect(consumer?.component).toBe('workers.host.jobs');
    expect(consumer?.criticality).toBe('critical');
    expect(consumer?.onUnknownVersion).toBe('dead-letter');
    expect(consumer?.versions).toEqual([1]);
  });

  // The registry refuses a handler whose scope disagrees with the declaration,
  // and refuses a handler that targets a type nobody declared.
  it('composes a worker registry with the runner handler attached', () => {
    const handlers = createJobHandlers({ jobs: {} as JobService });
    expect(() =>
      composeEventRegistry({
        contributions: [PLATFORM_REGISTRY_CONTRIBUTION, AI_REGISTRY_CONTRIBUTION],
        handlers,
        requireHandlers: false,
      }),
    ).not.toThrow();
  });

  // Without the AI contribution the runner's handler has no declaration —
  // startup fails rather than the worker running blind on an unknown type.
  it('refuses to compose the runner without the AI contribution', () => {
    expect(() =>
      composeEventRegistry({
        contributions: [PLATFORM_REGISTRY_CONTRIBUTION],
        handlers: createJobHandlers({ jobs: {} as JobService }),
        requireHandlers: false,
      }),
    ).toThrow(/JobQueued/);
  });
});

describe('replay compatibility', () => {
  const serializer = createEventSerializer();

  for (const event of EVENTS) {
    it(`${event.eventType} survives serialize → deserialize`, () => {
      expect(serializer.deserialize(serializer.serialize(event))).toEqual(event);
    });

    it(`${event.eventType} survives the Redis Streams field encoding`, () => {
      expect(serializer.fromStreamFields(serializer.toStreamFields(event))).toEqual(event);
    });
  }

  // The runner reads `jobId` off a replayed envelope to decide what to start.
  it('preserves the identifiers the runner reads', () => {
    const restored = serializer.deserialize(serializer.serialize(jobQueued(ctx, payload)));
    expect(restored.payload).toEqual(payload);
    expect(restored.tenantId).toBe(WS);
  });
});
