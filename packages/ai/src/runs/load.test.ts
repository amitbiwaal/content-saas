import type { Principal } from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import { isRunLoadCode, loadContentRun, RUN_LOAD_CODES } from './load.js';
import { toStoredRecords } from './mapping.js';
import type { ContentRunRepository, SaveRunInput, UpdateStatusInput } from './repository.js';
import { deepFreeze, type ContentRun, type ContentRunResult, type RunMetadata } from './run.js';
import type { StoredArtifact, StoredContentRun } from './stored.js';

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

const run: ContentRun = deepFreeze({
  runId: 'run-1',
  workflowId: 'article.draft',
  workflowVersion: 2,
  workflowRef: 'article.draft@2',
  templateVersions: ['planning.outline@7'],
  capability: 'chat',
  metadata,
  state: {
    status: 'completed',
    artifacts: [
      {
        stepId: 'outline',
        promptVersion: 'planning.outline@7',
        providerId: 'openai',
        model: 'gpt-4o-2026-05-01',
        capability: 'chat',
        content: 'An outline.',
        finishReason: 'stop',
        usage: {
          tokens: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
          tokensEstimated: false,
          cost: { currency: 'USD', amount: '0.000225' },
          latencyMs: 12,
        },
        tokens: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        attempts: 1,
        metadata: {},
      },
    ],
    executionId: 'idem-1',
    timings: { createdAt: RUN_AT, compiledAt: RUN_AT, startedAt: RUN_AT, finishedAt: RUN_AT },
  },
});

const RESULT: ContentRunResult = Object.freeze({ outcome: 'completed', run });
const RECORDS = toStoredRecords(RESULT, STORED_AT);

/**
 * A repository that counts its calls and holds whatever it was handed.
 *
 * The only implementation in this package, and it lives in a test — the port
 * exists precisely so that the real one can be written somewhere else.
 */
function fakeRepository(
  overrides: {
    run?: StoredContentRun | null;
    artifacts?: readonly StoredArtifact[];
  } = {},
) {
  const calls = { saveRun: 0, loadRun: 0, loadArtifacts: 0, updateStatus: 0 };
  const saved: SaveRunInput[] = [];
  const statuses: UpdateStatusInput[] = [];

  const repository: ContentRunRepository = {
    saveRun: (input) => {
      calls.saveRun += 1;
      saved.push(input);
      return Promise.resolve();
    },
    loadRun: () => {
      calls.loadRun += 1;
      return Promise.resolve(overrides.run === undefined ? RECORDS.run : overrides.run);
    },
    loadArtifacts: () => {
      calls.loadArtifacts += 1;
      return Promise.resolve(overrides.artifacts ?? RECORDS.artifacts);
    },
    updateStatus: (input) => {
      calls.updateStatus += 1;
      statuses.push(input);
      return Promise.resolve();
    },
  };

  return { repository, calls, saved, statuses };
}

describe('loading a stored run', () => {
  it('returns the run it stored', async () => {
    const { repository } = fakeRepository();
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('loaded');
    if (result.outcome !== 'loaded') return;
    expect(result.run.runId).toBe('run-1');
    expect(result.run.state.artifacts).toHaveLength(1);
  });

  it('returns the stored record alongside the run', async () => {
    // A caller sometimes wants the stored facts — the schema version, the
    // record timestamps — which the `ContentRun` deliberately does not carry.
    const { repository } = fakeRepository();
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('loaded');
    if (result.outcome !== 'loaded') return;
    expect(result.stored.schemaVersion).toBe(1);
    expect(result.stored.createdAt).toBe(STORED_AT);
  });

  it('asks the repository exactly once for each half', async () => {
    const { repository, calls } = fakeRepository();
    await loadContentRun({ repository, runId: 'run-1' });

    expect(calls.loadRun).toBe(1);
    expect(calls.loadArtifacts).toBe(1);
  });

  it('never writes while reading', async () => {
    const { repository, calls } = fakeRepository();
    await loadContentRun({ repository, runId: 'run-1' });

    expect(calls.saveRun).toBe(0);
    expect(calls.updateStatus).toBe(0);
  });

  it('freezes what it returns', async () => {
    const { repository } = fakeRepository();
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(Object.isFrozen(result)).toBe(true);
    if (result.outcome !== 'loaded') return;
    expect(Object.isFrozen(result.run.state.artifacts[0])).toBe(true);
  });
});

describe('refusing to load', () => {
  it('refuses an unknown run', async () => {
    const { repository } = fakeRepository({ run: null });
    const result = await loadContentRun({ repository, runId: 'run-missing' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('UnknownRun');
  });

  it('does not go looking for artifacts of a run that is not there', async () => {
    const { repository, calls } = fakeRepository({ run: null });
    await loadContentRun({ repository, runId: 'run-missing' });

    expect(calls.loadArtifacts).toBe(0);
  });

  it('refuses a record at an unsupported schema version', async () => {
    const { repository } = fakeRepository({ run: { ...RECORDS.run, schemaVersion: 99 } });
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleSchema');
    expect(result.reason).toMatch(/refused rather than migrated/);
  });

  it('reports an unsupported version as a schema problem, not as corruption', async () => {
    // A record from a newer build fails structural checks too; reporting THOSE
    // sends someone hunting for corruption in a record that is merely newer.
    const { repository } = fakeRepository({
      run: { ...RECORDS.run, schemaVersion: 99, runId: '' },
    });
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleSchema');
  });

  it('refuses a corrupted run record, naming every issue', async () => {
    const { repository } = fakeRepository({
      run: { ...RECORDS.run, runId: '', status: 'paused' as StoredContentRun['status'] },
    });
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
    expect(result.issues.map((issue) => issue.code)).toContain('UNKNOWN_STATUS');
  });

  it('refuses an artifact filed under another run', async () => {
    const [first] = RECORDS.artifacts;
    const { repository } = fakeRepository({
      artifacts: [{ ...(first as StoredArtifact), runId: 'run-2' }],
    });
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
    expect(result.issues.map((issue) => issue.code)).toContain('WRONG_RUN');
  });

  it('refuses an artifact at an unsupported schema version', async () => {
    const [first] = RECORDS.artifacts;
    const { repository } = fakeRepository({
      artifacts: [{ ...(first as StoredArtifact), schemaVersion: 99 }],
    });
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleSchema');
  });

  it('refuses when fewer artifacts come back than the run recorded', async () => {
    // A partial write or a partial read; either way the run silently lost work.
    const { repository } = fakeRepository({ artifacts: [] });
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('CorruptRecord');
    expect(result.issues.map((issue) => issue.code)).toContain('COUNT_MISMATCH');
  });

  it('never returns a partial run alongside a refusal', async () => {
    const { repository } = fakeRepository({ artifacts: [] });
    const result = await loadContentRun({ repository, runId: 'run-1' });

    expect(result.outcome).toBe('refused');
    expect('run' in result).toBe(false);
  });
});

describe('the load vocabulary', () => {
  it('names the three ways a load can be refused', () => {
    expect([...RUN_LOAD_CODES]).toEqual(['UnknownRun', 'IncompatibleSchema', 'CorruptRecord']);
  });

  it('recognises its own members and nothing else', () => {
    expect(isRunLoadCode('UnknownRun')).toBe(true);
    expect(isRunLoadCode('unknownRun')).toBe(false);
    expect(isRunLoadCode('Exploded')).toBe(false);
  });
});

describe('the repository port', () => {
  it('takes the timestamp it should write, rather than reading a clock', async () => {
    const { repository, statuses } = fakeRepository();
    await repository.updateStatus({ runId: 'run-1', status: 'cancelled', updatedAt: STORED_AT });

    expect(statuses).toEqual([{ runId: 'run-1', status: 'cancelled', updatedAt: STORED_AT }]);
  });

  it('saves a run and its artifacts in one call', async () => {
    const { repository, saved } = fakeRepository();
    await repository.saveRun(RECORDS);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.run.runId).toBe('run-1');
    expect(saved[0]?.artifacts).toHaveLength(1);
  });
});
