import { describe, expect, it } from 'vitest';

import {
  CONTENT_RUN_SCHEMA_VERSION,
  isSupportedSchemaVersion,
  parsePromptVersion,
  SUPPORTED_SCHEMA_VERSIONS,
  validateStoredArtifact,
  validateStoredRun,
  type StoredArtifact,
  type StoredContentRun,
} from './stored.js';

const NOW = '2026-07-31T12:00:00.000Z';

const run = (overrides: Partial<StoredContentRun> = {}): StoredContentRun => ({
  schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
  createdAt: NOW,
  updatedAt: NOW,
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
    timings: { createdAt: NOW, compiledAt: NOW, startedAt: NOW, finishedAt: NOW },
  },
  templateVersions: [
    { templateId: 'planning.outline', templateVersion: 7, promptVersion: 'planning.outline@7' },
  ],
  failure: null,
  artifactCount: 1,
  ...overrides,
});

const artifact = (overrides: Partial<StoredArtifact> = {}): StoredArtifact => ({
  schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
  createdAt: NOW,
  updatedAt: NOW,
  runId: 'run-1',
  stepId: 'outline',
  sequence: 0,
  prompt: {
    templateId: 'planning.outline',
    templateVersion: 7,
    promptVersion: 'planning.outline@7',
  },
  providerId: 'openai',
  model: 'gpt-4o-2026-05-01',
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
  attempts: 1,
  metadata: {},
  ...overrides,
});

const codesOf = (result: ReturnType<typeof validateStoredRun>): readonly string[] =>
  result.ok ? [] : result.issues.map((issue) => issue.code);

describe('schema versions', () => {
  it('writes one version and reads every supported one', () => {
    expect(SUPPORTED_SCHEMA_VERSIONS).toContain(CONTENT_RUN_SCHEMA_VERSION);
  });

  it('recognises a supported version', () => {
    expect(isSupportedSchemaVersion(CONTENT_RUN_SCHEMA_VERSION)).toBe(true);
  });

  it('refuses a version this build does not know', () => {
    expect(isSupportedSchemaVersion(2)).toBe(false);
    expect(isSupportedSchemaVersion(0)).toBe(false);
    expect(isSupportedSchemaVersion('1')).toBe(false);
    expect(isSupportedSchemaVersion(undefined)).toBe(false);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(SUPPORTED_SCHEMA_VERSIONS)).toBe(true);
  });
});

describe('validating a stored run', () => {
  it('accepts a well-formed record', () => {
    expect(validateStoredRun(run())).toEqual({ ok: true });
  });

  it('rejects an unsupported schema version', () => {
    expect(codesOf(validateStoredRun(run({ schemaVersion: 99 })))).toContain('UNSUPPORTED_SCHEMA');
  });

  it('says records are refused rather than migrated', () => {
    const result = validateStoredRun(run({ schemaVersion: 99 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.detail).toMatch(/refused rather than migrated/);
  });

  it('rejects a missing run id', () => {
    expect(codesOf(validateStoredRun(run({ runId: '  ' })))).toContain('MISSING');
  });

  it('rejects a status the run machine does not know', () => {
    expect(
      codesOf(validateStoredRun(run({ status: 'paused' as StoredContentRun['status'] }))),
    ).toContain('UNKNOWN_STATUS');
  });

  it('rejects a timestamp that is not ISO', () => {
    expect(codesOf(validateStoredRun(run({ createdAt: 'yesterday' })))).toContain('BAD_TIMESTAMP');
  });

  it('rejects a tenancy status nothing recognises', () => {
    const record = run();
    const broken = {
      ...record,
      execution: {
        ...record.execution,
        workspaceStatus: 'retired' as never,
      },
    };
    expect(codesOf(validateStoredRun(broken))).toContain('UNKNOWN_STATUS');
  });

  it('rejects a prompt anchor that does not parse', () => {
    expect(
      codesOf(
        validateStoredRun(
          run({
            templateVersions: [
              { templateId: 'x', templateVersion: 1, promptVersion: 'not an anchor' },
            ],
          }),
        ),
      ),
    ).toContain('BAD_FORMAT');
  });

  it('rejects an anchor that disagrees with its own parts', () => {
    // The two are stored separately, so they can disagree — and a disagreement
    // means one of them was rewritten by hand.
    expect(
      codesOf(
        validateStoredRun(
          run({
            templateVersions: [
              {
                templateId: 'planning.outline',
                templateVersion: 3,
                promptVersion: 'planning.outline@7',
              },
            ],
          }),
        ),
      ),
    ).toContain('INCONSISTENT');
  });

  it('reports every issue, not the first', () => {
    const result = validateStoredRun({ schemaVersion: 99, runId: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.length).toBeGreaterThan(3);
  });

  it('names where each issue is', () => {
    const result = validateStoredRun(run({ runId: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.field).toBe('run.runId');
  });
});

describe('validating a stored artifact', () => {
  it('accepts a well-formed record', () => {
    expect(validateStoredArtifact(artifact(), 'run-1')).toEqual({ ok: true });
  });

  it('rejects one filed under another run', () => {
    // One run's output under another id is the corruption that ends with a
    // customer reading someone else's content.
    const result = validateStoredArtifact(artifact({ runId: 'run-2' }), 'run-1');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('WRONG_RUN');
  });

  it('rejects an amount the ledger would not accept', () => {
    const broken = artifact();
    const result = validateStoredArtifact({
      ...broken,
      usage: { ...broken.usage, amount: 0.000225 as unknown as string },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('BAD_AMOUNT');
  });

  it('rejects a negative token count', () => {
    const broken = artifact();
    const result = validateStoredArtifact({
      ...broken,
      usage: { ...broken.usage, promptTokens: -1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('BAD_COUNT');
  });

  it('rejects an attempt count below one', () => {
    // An artifact exists because a dispatch happened; zero attempts is a lie.
    const result = validateStoredArtifact(artifact({ attempts: 0 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('BAD_COUNT');
  });

  it('rejects a missing provider or model', () => {
    expect(validateStoredArtifact(artifact({ providerId: '' })).ok).toBe(false);
    expect(validateStoredArtifact(artifact({ model: '' })).ok).toBe(false);
  });

  it('rejects a missing usage record', () => {
    const result = validateStoredArtifact({ ...artifact(), usage: undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain('MISSING');
  });

  it('accepts empty content, which is a real answer', () => {
    expect(validateStoredArtifact(artifact({ content: '' }), 'run-1')).toEqual({ ok: true });
  });
});

describe('parsing a prompt anchor', () => {
  it('splits it into its parts', () => {
    expect(parsePromptVersion('planning.outline@7')).toEqual({
      templateId: 'planning.outline',
      templateVersion: 7,
      promptVersion: 'planning.outline@7',
    });
  });

  it('returns null for anything else', () => {
    expect(parsePromptVersion('planning.outline')).toBeNull();
    expect(parsePromptVersion('planning.outline@')).toBeNull();
    expect(parsePromptVersion('@7')).toBeNull();
    expect(parsePromptVersion('Planning.Outline@7')).toBeNull();
  });

  it('freezes what it returns', () => {
    expect(Object.isFrozen(parsePromptVersion('a.b@1'))).toBe(true);
  });
});
