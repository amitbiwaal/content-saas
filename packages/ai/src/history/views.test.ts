import { describe, expect, it } from 'vitest';

import {
  CONTENT_RUN_SCHEMA_VERSION,
  type StoredArtifact,
  type StoredContentRun,
} from '../runs/stored.js';
import {
  PERSISTENCE_ONLY_FIELDS,
  summariseUsage,
  toArtifactHistoryView,
  toRunHistoryView,
} from './views.js';

const RUN_AT = '2026-07-31T12:00:00.000Z';
const STORED_AT = '2026-07-31T12:00:09.000Z';

const run = (overrides: Partial<StoredContentRun> = {}): StoredContentRun => ({
  schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
  createdAt: STORED_AT,
  updatedAt: STORED_AT,
  runId: 'run-1',
  status: 'completed',
  execution: {
    executionId: 'idem-1',
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    capability: 'chat',
    organizationId: 'org-1',
    organizationStatus: 'active',
    workspaceId: 'ws-1',
    workspaceStatus: 'active',
    principalId: 'user-1',
    principalKind: 'user',
    principalMethod: 'password',
    correlationId: 'corr-1',
    idempotencyKey: 'idem-1',
    timings: { createdAt: RUN_AT, compiledAt: RUN_AT, startedAt: RUN_AT, finishedAt: RUN_AT },
  },
  templateVersions: [
    { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
    { templateId: 'writing.draft', templateVersion: 3, promptVersion: 'writing.draft@3' },
  ],
  failure: null,
  artifactCount: 2,
  ...overrides,
});

const artifact = (overrides: Partial<StoredArtifact> = {}): StoredArtifact => ({
  schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
  createdAt: STORED_AT,
  updatedAt: STORED_AT,
  runId: 'run-1',
  stepId: 'outline',
  sequence: 0,
  prompt: {
    templateId: 'planning.outline',
    templateVersion: 7,
    promptVersion: 'planning.outline@7',
  },
  providerId: 'anthropic',
  model: 'claude-x-2026-05-01',
  capability: 'chat',
  content: 'An outline.',
  finishReason: 'stop',
  usage: {
    promptTokens: 10,
    completionTokens: 20,
    totalTokens: 30,
    tokensEstimated: false,
    currency: 'USD',
    amount: '0.000225',
    latencyMs: 12,
  },
  attempts: 2,
  metadata: { plannedProviderId: 'openai' },
  ...overrides,
});

describe('the run view', () => {
  it('carries no persistence metadata at all', () => {
    // A dashboard showing these would be showing storage internals, and a
    // client branching on `schemaVersion` would make a migration a breaking
    // change.
    const view = toRunHistoryView(run());

    for (const field of PERSISTENCE_ONLY_FIELDS) {
      expect(Object.keys(view)).not.toContain(field);
    }
  });

  it('carries the workflow identity and version', () => {
    const view = toRunHistoryView(run());

    expect(view.workflowId).toBe('article.draft');
    expect(view.workflowVersion).toBe(2);
    expect(view.workflowRef).toBe('article.draft@2');
    expect(view.capability).toBe('chat');
  });

  it('carries every template version the run pinned', () => {
    expect(toRunHistoryView(run()).templateVersions).toEqual([
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
      { templateId: 'writing.draft', templateVersion: 3, promptVersion: 'writing.draft@3' },
    ]);
  });

  it('carries the run clock, never the record clock', () => {
    const view = toRunHistoryView(run());

    expect(view.timings.createdAt).toBe(RUN_AT);
    expect(JSON.stringify(view)).not.toContain(STORED_AT);
  });

  it('carries tenancy, identity and correlation', () => {
    const view = toRunHistoryView(run());

    expect(view.organizationId).toBe('org-1');
    expect(view.workspaceId).toBe('ws-1');
    expect(view.principalId).toBe('user-1');
    expect(view.principalKind).toBe('user');
    expect(view.correlationId).toBe('corr-1');
    expect(view.executionId).toBe('idem-1');
  });

  it('carries the artifact count, so a list view need not load them', () => {
    expect(toRunHistoryView(run()).artifactCount).toBe(2);
  });

  it('carries a failure as codes, never as prose', () => {
    // A caller branches on a code; internal wording is for an operator, and
    // the store still has it.
    const view = toRunHistoryView(
      run({
        status: 'failed',
        failure: {
          code: 'ExecutionFailed',
          reason: "openai returned 400 for tenant ws-1's request",
          providerCode: 'Validation',
        },
      }),
    );

    expect(view.failure).toEqual({ code: 'ExecutionFailed', providerCode: 'Validation' });
    expect(JSON.stringify(view)).not.toContain('openai returned 400');
  });

  it('has no failure at all on a run that completed', () => {
    expect(toRunHistoryView(run()).failure).toBeNull();
  });

  it('is frozen through', () => {
    const view = toRunHistoryView(run());

    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.timings)).toBe(true);
    expect(Object.isFrozen(view.templateVersions)).toBe(true);
    expect(Object.isFrozen(view.templateVersions[0])).toBe(true);
  });

  it('does not alias the record it came from', () => {
    // A view that shared arrays with a stored record would let a consumer
    // reach back into the thing it was given a copy of.
    const stored = run();
    const view = toRunHistoryView(stored);

    expect(view.templateVersions).not.toBe(stored.templateVersions);
    expect(view.timings).not.toBe(stored.execution.timings);
  });
});

describe('the artifact view', () => {
  it('carries no persistence metadata at all', () => {
    const view = toArtifactHistoryView(artifact());

    for (const field of PERSISTENCE_ONLY_FIELDS) {
      expect(Object.keys(view)).not.toContain(field);
    }
  });

  it('carries the generated text and the step that produced it', () => {
    const view = toArtifactHistoryView(artifact());

    expect(view.stepId).toBe('outline');
    expect(view.content).toBe('An outline.');
    expect(view.finishReason).toBe('stop');
    expect(view.sequence).toBe(0);
  });

  it('carries the provider and model that actually ran', () => {
    const view = toArtifactHistoryView(artifact());

    expect(view.providerId).toBe('anthropic');
    expect(view.model).toBe('claude-x-2026-05-01');
  });

  it('carries usage, unchanged and still a decimal string', () => {
    const view = toArtifactHistoryView(artifact());

    expect(view.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      tokensEstimated: false,
      currency: 'USD',
      amount: '0.000225',
      latencyMs: 12,
    });
    expect(typeof view.usage.amount).toBe('string');
  });

  it('carries the prompt reference and the attempt count', () => {
    const view = toArtifactHistoryView(artifact());

    expect(view.prompt.promptVersion).toBe('planning.outline@7');
    expect(view.attempts).toBe(2);
  });

  it('carries the artifact metadata verbatim', () => {
    expect(toArtifactHistoryView(artifact()).metadata).toEqual({ plannedProviderId: 'openai' });
  });

  it('is frozen through', () => {
    const view = toArtifactHistoryView(artifact());

    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.usage)).toBe(true);
    expect(Object.isFrozen(view.metadata)).toBe(true);
  });
});

describe('summarising usage', () => {
  it('adds every artifact up', () => {
    expect(
      summariseUsage([toArtifactHistoryView(artifact()), toArtifactHistoryView(artifact())]),
    ).toEqual({
      promptTokens: 20,
      completionTokens: 40,
      totalTokens: 60,
      artifacts: 2,
      tokensEstimated: false,
    });
  });

  it('is zero for a run that produced nothing', () => {
    expect(summariseUsage([])).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      artifacts: 0,
      tokensEstimated: false,
    });
  });

  it('calls the whole total an estimate when any part of it is one', () => {
    // Reporting an estimate as measured is how a reconciliation gap becomes
    // invisible.
    const measured = toArtifactHistoryView(artifact());
    const estimated = toArtifactHistoryView(
      artifact({ usage: { ...artifact().usage, tokensEstimated: true } }),
    );

    expect(summariseUsage([measured, estimated]).tokensEstimated).toBe(true);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(summariseUsage([]))).toBe(true);
  });
});
