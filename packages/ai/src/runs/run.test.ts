import type { Usage } from '@contentos/contracts';
import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import {
  deepFreeze,
  isRunFailureCode,
  RUN_FAILURE_CODES,
  totalTokens,
  withState,
  type ContentArtifact,
  type ContentRun,
  type RunMetadata,
} from './run.js';

const NOW = new Date('2026-07-31T12:00:00.000Z');

const principal: Principal = {
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  roles: ['editor'],
  permissions: ['article:execute'],
  authenticatedAt: NOW,
  mfaSatisfied: true,
  sessionId: null,
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

const usage = (prompt: number, completion: number): Usage => ({
  tokens: { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion },
  tokensEstimated: false,
  cost: { currency: 'USD', amount: '0.000100' },
  latencyMs: 12,
});

const artifact = (stepId: string, prompt: number, completion: number): ContentArtifact => ({
  stepId,
  promptVersion: `${stepId}@4`,
  providerId: 'openai',
  model: 'gpt-4o-2026-05-01',
  capability: 'chat',
  content: `the ${stepId} output`,
  finishReason: 'stop',
  usage: usage(prompt, completion),
  tokens: usage(prompt, completion).tokens,
  attempts: 1,
  metadata: {},
});

const run = (artifacts: readonly ContentArtifact[] = []): ContentRun =>
  deepFreeze({
    runId: 'run-1',
    workflowId: 'article.draft',
    workflowVersion: 1,
    workflowRef: 'article.draft@1',
    templateVersions: ['planning.outline@4', 'writing.draft@4'],
    capability: 'chat',
    metadata,
    state: {
      status: 'running',
      artifacts,
      executionId: 'idem-1',
      timings: {
        createdAt: NOW.toISOString(),
        compiledAt: NOW.toISOString(),
        startedAt: NOW.toISOString(),
        finishedAt: null,
      },
    },
  });

describe('the run record', () => {
  it('is frozen through, not just at the top', () => {
    const value = run([artifact('outline', 10, 20)]);

    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.state)).toBe(true);
    expect(Object.isFrozen(value.state.timings)).toBe(true);
    expect(Object.isFrozen(value.state.artifacts)).toBe(true);
    expect(Object.isFrozen(value.state.artifacts[0])).toBe(true);
    expect(Object.isFrozen(value.templateVersions)).toBe(true);
  });

  it('refuses mutation', () => {
    const value = run();
    expect(() => {
      (value as { runId: string }).runId = 'other';
    }).toThrow();
  });

  it('carries the provenance an artifact must be explainable from', () => {
    const value = run([artifact('outline', 1, 1)]);
    const [first] = value.state.artifacts;

    expect(first?.promptVersion).toBe('outline@4');
    expect(first?.providerId).toBe('openai');
    expect(first?.model).toBe('gpt-4o-2026-05-01');
    expect(value.workflowRef).toBe('article.draft@1');
    expect(value.templateVersions).toEqual(['planning.outline@4', 'writing.draft@4']);
  });
});

describe('advancing a run', () => {
  it('produces a new record and leaves the previous one intact', () => {
    const before = run();
    const after = withState(before, { status: 'completed' });

    expect(after).not.toBe(before);
    expect(after.state.status).toBe('completed');
    expect(before.state.status).toBe('running');
  });

  it('keeps the fields it was not asked to change', () => {
    const before = run([artifact('outline', 1, 1)]);
    const after = withState(before, { status: 'completed' });

    expect(after.state.artifacts).toHaveLength(1);
    expect(after.state.executionId).toBe('idem-1');
    expect(after.runId).toBe(before.runId);
  });

  it('freezes what it returns', () => {
    expect(Object.isFrozen(withState(run(), { status: 'completed' }).state)).toBe(true);
  });
});

describe('totalTokens', () => {
  it('sums every artifact', () => {
    expect(totalTokens(run([artifact('a', 10, 20), artifact('b', 5, 7)]))).toEqual({
      promptTokens: 15,
      completionTokens: 27,
      totalTokens: 42,
    });
  });

  it('is zero for a run that produced nothing', () => {
    expect(totalTokens(run())).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
  });
});

describe('the failure taxonomy', () => {
  it('covers each failure the increment names', () => {
    expect([...RUN_FAILURE_CODES]).toEqual([
      'WorkflowUnresolved',
      'TemplateUnresolved',
      'CompilationFailed',
      'RuntimeFailed',
      'ExecutionFailed',
      'StreamingUnsupported',
      'Cancelled',
      'Timeout',
    ]);
  });

  it('recognises its own members and nothing else', () => {
    expect(isRunFailureCode('Timeout')).toBe(true);
    expect(isRunFailureCode('timeout')).toBe(false);
    expect(isRunFailureCode('Exploded')).toBe(false);
  });
});
