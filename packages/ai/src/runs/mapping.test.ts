import type { Usage } from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import {
  storedFailureOf,
  toContentRun,
  toStoredArtifacts,
  toStoredRecords,
  toStoredRun,
} from './mapping.js';
import {
  deepFreeze,
  type ContentArtifact,
  type ContentRun,
  type ContentRunResult,
  type RunMetadata,
} from './run.js';
import { CONTENT_RUN_SCHEMA_VERSION, validateStoredArtifact, validateStoredRun } from './stored.js';

const RUN_AT = '2026-07-31T12:00:00.000Z';
const STORED_AT = '2026-07-31T12:00:05.000Z';

const principal: Principal = {
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: new Date(RUN_AT),
  mfaSatisfied: true,
  sessionId: 'session-1',
};

const organization: AdmissionOrganization = { organizationId: 'org-1', status: 'active' };
const workspace: AdmissionWorkspace = {
  workspaceId: 'ws-1',
  organizationId: 'org-1',
  status: 'active',
};

const metadata: RunMetadata = {
  principal,
  organization,
  workspace,
  correlationId: 'corr-1',
  idempotencyKey: 'idem-1',
};

const usage: Usage = {
  tokens: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
  tokensEstimated: true,
  cost: { currency: 'USD', amount: '0.000225' },
  latencyMs: 12,
};

const artifact = (stepId: string, templateId: string): ContentArtifact => ({
  stepId,
  promptVersion: `${templateId}@7`,
  providerId: 'anthropic',
  model: 'claude-x-2026-05-01',
  capability: 'chat',
  content: `the ${stepId} output`,
  finishReason: 'stop',
  usage,
  tokens: usage.tokens,
  attempts: 2,
  metadata: { plannedProviderId: 'openai', chargeableAmount: '0.000225' },
});

const run = (overrides: Partial<ContentRun> = {}): ContentRun =>
  deepFreeze({
    runId: 'run-1',
    workflowId: 'article.draft',
    workflowVersion: 2,
    workflowRef: 'article.draft@2',
    templateVersions: ['planning.outline@7', 'writing.draft@3'],
    capability: 'chat',
    metadata,
    state: {
      status: 'completed',
      artifacts: [artifact('outline', 'planning.outline'), artifact('draft', 'writing.draft')],
      executionId: 'idem-1',
      timings: {
        createdAt: RUN_AT,
        compiledAt: RUN_AT,
        startedAt: RUN_AT,
        finishedAt: RUN_AT,
      },
    },
    ...overrides,
  });

const completed: ContentRunResult = Object.freeze({ outcome: 'completed', run: run() });

// ── Down ────────────────────────────────────────────────────────────────────

describe('mapping a run down to its record', () => {
  it('produces a record its own validator accepts', () => {
    expect(validateStoredRun(toStoredRun({ run: run(), now: STORED_AT }))).toEqual({ ok: true });
  });

  it('stamps the schema version this build writes', () => {
    expect(toStoredRun({ run: run(), now: STORED_AT }).schemaVersion).toBe(
      CONTENT_RUN_SCHEMA_VERSION,
    );
  });

  it('uses the supplied timestamp for the record, and the run clock for the run', () => {
    // Conflating the two is how "the run took five seconds" turns out to mean
    // "the row was written five seconds later".
    const stored = toStoredRun({ run: run(), now: STORED_AT });

    expect(stored.createdAt).toBe(STORED_AT);
    expect(stored.updatedAt).toBe(STORED_AT);
    expect(stored.execution.timings.createdAt).toBe(RUN_AT);
  });

  it('preserves the workflow identity and version', () => {
    const stored = toStoredRun({ run: run(), now: STORED_AT });

    expect(stored.execution.workflowId).toBe('article.draft');
    expect(stored.execution.workflowVersion).toBe(2);
    expect(stored.execution.workflowRef).toBe('article.draft@2');
    expect(stored.execution.capability).toBe('chat');
  });

  it('preserves every template version, split into its parts', () => {
    expect(toStoredRun({ run: run(), now: STORED_AT }).templateVersions).toEqual([
      { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
      { templateId: 'writing.draft', templateVersion: 3, promptVersion: 'writing.draft@3' },
    ]);
  });

  it('preserves tenancy and correlation', () => {
    const { execution } = toStoredRun({ run: run(), now: STORED_AT });

    expect(execution.organizationId).toBe('org-1');
    expect(execution.workspaceId).toBe('ws-1');
    expect(execution.correlationId).toBe('corr-1');
    expect(execution.idempotencyKey).toBe('idem-1');
    expect(execution.executionId).toBe('idem-1');
  });

  it('stores who ran it, and nothing about what they were allowed to do', () => {
    const stored = toStoredRun({ run: run(), now: STORED_AT });
    const flat = JSON.stringify(stored);

    expect(stored.execution.principalId).toBe('user-1');
    expect(stored.execution.principalKind).toBe('user');
    expect(stored.execution.principalMethod).toBe('password');
    // Authorization state resolved for ONE request must not become a durable
    // second copy of itself.
    expect(flat).not.toContain('editor');
    expect(flat).not.toContain('article:execute');
    expect(flat).not.toContain('session-1');
  });

  it('records the count of artifacts, so a partial read is detectable', () => {
    expect(toStoredRun({ run: run(), now: STORED_AT }).artifactCount).toBe(2);
  });

  it('carries the failure of a run that did not complete', () => {
    const failed: ContentRunResult = {
      outcome: 'failed',
      run: run(),
      code: 'ExecutionFailed',
      reason: 'The provider refused.',
      providerCode: 'ContentFiltered',
    };

    expect(storedFailureOf(failed)).toEqual({
      code: 'ExecutionFailed',
      reason: 'The provider refused.',
      providerCode: 'ContentFiltered',
    });
    expect(storedFailureOf(completed)).toBeNull();
  });

  it('is frozen through', () => {
    const stored = toStoredRun({ run: run(), now: STORED_AT });

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.execution)).toBe(true);
    expect(Object.isFrozen(stored.execution.timings)).toBe(true);
    expect(Object.isFrozen(stored.templateVersions)).toBe(true);
  });
});

describe('mapping artifacts down', () => {
  it('produces records the artifact validator accepts', () => {
    for (const stored of toStoredArtifacts({ run: run(), now: STORED_AT })) {
      expect(validateStoredArtifact(stored, 'run-1')).toEqual({ ok: true });
    }
  });

  it('stores the position rather than relying on array order', () => {
    expect(
      toStoredArtifacts({ run: run(), now: STORED_AT }).map((stored) => stored.sequence),
    ).toEqual([0, 1]);
  });

  it('preserves the provider and model that actually ran', () => {
    const [first] = toStoredArtifacts({ run: run(), now: STORED_AT });

    expect(first?.providerId).toBe('anthropic');
    expect(first?.model).toBe('claude-x-2026-05-01');
  });

  it('preserves token usage, the estimated flag and the cost', () => {
    const [first] = toStoredArtifacts({ run: run(), now: STORED_AT });

    expect(first?.usage).toEqual({
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      tokensEstimated: true,
      currency: 'USD',
      amount: '0.000225',
      latencyMs: 12,
    });
  });

  it('keeps the cost as a decimal string', () => {
    expect(typeof toStoredArtifacts({ run: run(), now: STORED_AT })[0]?.usage.amount).toBe(
      'string',
    );
  });

  it('preserves the prompt reference', () => {
    expect(toStoredArtifacts({ run: run(), now: STORED_AT })[0]?.prompt).toEqual({
      templateId: 'planning.outline',
      templateVersion: 7,
      promptVersion: 'planning.outline@7',
    });
  });

  it('preserves the attempt count and the carried metadata', () => {
    const [first] = toStoredArtifacts({ run: run(), now: STORED_AT });

    expect(first?.attempts).toBe(2);
    expect(first?.metadata).toEqual({
      plannedProviderId: 'openai',
      chargeableAmount: '0.000225',
    });
  });

  it('files every artifact under its own run', () => {
    for (const stored of toStoredArtifacts({ run: run(), now: STORED_AT })) {
      expect(stored.runId).toBe('run-1');
    }
  });

  it('is frozen through', () => {
    const stored = toStoredArtifacts({ run: run(), now: STORED_AT });

    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored[0])).toBe(true);
    expect(Object.isFrozen(stored[0]?.usage)).toBe(true);
  });
});

describe('both halves of one save', () => {
  it('produces the run and its artifacts together', () => {
    const input = toStoredRecords(completed, STORED_AT);

    expect(input.run.runId).toBe('run-1');
    expect(input.artifacts).toHaveLength(2);
    expect(input.run.artifactCount).toBe(input.artifacts.length);
  });

  it('carries the failure of a failed run onto the record', () => {
    const input = toStoredRecords(
      {
        outcome: 'failed',
        run: run(),
        code: 'Timeout',
        reason: 'The run ran out of budget.',
        providerCode: null,
      },
      STORED_AT,
    );

    expect(input.run.failure?.code).toBe('Timeout');
  });
});

// ── Back up ─────────────────────────────────────────────────────────────────

describe('mapping a record back up to a run', () => {
  const roundTrip = (): ContentRun => {
    const input = toStoredRecords(completed, STORED_AT);
    return toContentRun({ run: input.run, artifacts: input.artifacts });
  };

  it('restores the run identity, version and status', () => {
    const restored = roundTrip();

    expect(restored.runId).toBe('run-1');
    expect(restored.workflowId).toBe('article.draft');
    expect(restored.workflowVersion).toBe(2);
    expect(restored.workflowRef).toBe('article.draft@2');
    expect(restored.state.status).toBe('completed');
  });

  it('restores the template versions as the anchors a run carries', () => {
    expect(roundTrip().templateVersions).toEqual(['planning.outline@7', 'writing.draft@3']);
  });

  it('restores every artifact, in order, with its content', () => {
    const { artifacts } = roundTrip().state;

    expect(artifacts.map((entry) => entry.stepId)).toEqual(['outline', 'draft']);
    expect(artifacts[0]?.content).toBe('the outline output');
  });

  it('restores usage exactly, including the estimated flag', () => {
    expect(roundTrip().state.artifacts[0]?.usage).toEqual(usage);
  });

  it('restores the timings', () => {
    expect(roundTrip().state.timings).toEqual({
      createdAt: RUN_AT,
      compiledAt: RUN_AT,
      startedAt: RUN_AT,
      finishedAt: RUN_AT,
    });
  });

  it('orders artifacts by their stored sequence, not by what the store returned', () => {
    const input = toStoredRecords(completed, STORED_AT);
    const restored = toContentRun({ run: input.run, artifacts: [...input.artifacts].reverse() });

    expect(restored.state.artifacts.map((entry) => entry.stepId)).toEqual(['outline', 'draft']);
  });

  it('rebuilds a principal that grants nothing', () => {
    // A loaded run says who ran it. It never says what they may do now —
    // answering that means authenticating again.
    const { principal: restored } = roundTrip().metadata;

    expect(restored.subjectId).toBe('user-1');
    expect(restored.kind).toBe('user');
    expect(restored.roles).toEqual([]);
    expect(restored.permissions).toEqual([]);
    expect(restored.mfaSatisfied).toBe(false);
    expect(restored.sessionId).toBeNull();
  });

  it('restores the tenancy the run acted in', () => {
    const restored = roundTrip().metadata;

    expect(restored.organization).toEqual({ organizationId: 'org-1', status: 'active' });
    expect(restored.workspace).toEqual({
      workspaceId: 'ws-1',
      organizationId: 'org-1',
      status: 'active',
    });
    expect(restored.correlationId).toBe('corr-1');
  });

  it('is frozen through', () => {
    const restored = roundTrip();

    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.state.artifacts[0])).toBe(true);
  });

  it('round-trips everything except the principal, which fails closed', () => {
    const original = run();
    const restored = roundTrip();

    expect({ ...restored, metadata: { ...restored.metadata, principal: null } }).toEqual({
      ...original,
      metadata: { ...original.metadata, principal: null },
    });
  });
});
