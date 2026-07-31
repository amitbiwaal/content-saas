/**
 * The posture services against in-memory ports and the real audit service.
 *
 * The unit suite checks each model on values. This runs a whole assessment
 * cycle — declare policies, scan, record, triage, rescan, report — through the
 * services, and asserts the two things only the wiring can show: that a
 * privileged posture action lands in the REAL audit log as a valid chain link,
 * and that a rescan of an unchanged system files nothing new.
 */

import { describe, expect, it } from 'vitest';

import { createAuditService } from '../audit/service.js';
import { createPersistentAuditWriter, type AuditExecutor } from '../audit/persistent-writer.js';
import { verifyChainLink, type AuditRecord } from '../audit/writer.js';
import type { Principal } from '../authn/principal.js';
import {
  buildSecurityReport,
  newFindings,
  type ScanResult,
  type SecurityAssessment,
} from './assessment.js';
import { SecurityError } from './errors.js';
import type { SecurityFinding } from './finding.js';
import { createSecurityPolicy, type SecurityPolicy } from './policy.js';
import type {
  AssessmentSlice,
  FindingSlice,
  PolicySlice,
  SecurityAssessmentRepository,
  SecurityFindingRepository,
  SecurityPolicyRepository,
} from './repository.js';
import {
  createSecurityAssessmentService,
  createSecurityPolicyService,
  POSTURE_ACTIONS,
  toAuditEvent,
} from './service.js';
import { THREATS } from './threats.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const AT = '2026-03-01T00:00:00.000Z';
const DONE = '2026-03-01T00:05:00.000Z';
const NOW = '2026-03-01T12:00:00.000Z';

const principal = Object.freeze({
  subjectId: '018f7a1e-0000-7000-8000-000000000001',
  kind: 'user',
  organizationId: ORG,
  roles: Object.freeze([]),
  permissions: Object.freeze([]),
  sessionId: '018f7a1e-0000-7000-8000-000000000002',
}) as unknown as Principal;

/** In-memory ports. They model uniqueness and nothing else. */
function stores() {
  const policyRows: SecurityPolicy[] = [];
  const findingRows: SecurityFinding[] = [];
  const assessmentRows: SecurityAssessment[] = [];

  const policies: SecurityPolicyRepository = {
    savePolicy(policy) {
      if (policyRows.some((p) => p.policyId === policy.policyId)) {
        throw new SecurityError('InvalidPolicy', 'policyId', 'That policy id already exists.');
      }
      policyRows.push(policy);
      return Promise.resolve(policy);
    },
    loadPolicy(policyId) {
      return Promise.resolve(policyRows.find((p) => p.policyId === policyId) ?? null);
    },
    listPolicies(query): Promise<PolicySlice> {
      const statuses = query.statuses;
      return Promise.resolve({
        policies: policyRows.filter((p) => statuses === null || statuses.includes(p.status)),
      });
    },
  };

  const findings: SecurityFindingRepository = {
    recordFindings(incoming) {
      // Idempotent on fingerprint — a rescan must not file the same problem.
      for (const finding of incoming) {
        if (!findingRows.some((f) => f.fingerprint === finding.fingerprint)) {
          findingRows.push(finding);
        }
      }
      return Promise.resolve(incoming);
    },
    loadFinding(findingId) {
      return Promise.resolve(findingRows.find((f) => f.findingId === findingId) ?? null);
    },
    findByFingerprint(fingerprint) {
      return Promise.resolve(findingRows.find((f) => f.fingerprint === fingerprint) ?? null);
    },
    transitionFinding(input) {
      const index = findingRows.findIndex((f) => f.findingId === input.findingId);
      const current = findingRows[index];
      if (current === undefined) {
        throw new SecurityError('MissingField', 'findingId', 'No such finding.');
      }
      const moved: SecurityFinding = { ...current, status: input.status };
      findingRows[index] = moved;
      return Promise.resolve(moved);
    },
    listFindings(): Promise<FindingSlice> {
      return Promise.resolve({ findings: [...findingRows], next: null });
    },
  };

  const assessments: SecurityAssessmentRepository = {
    saveAssessment(assessment) {
      assessmentRows.push(assessment);
      return Promise.resolve(assessment);
    },
    loadAssessment(assessmentId) {
      return Promise.resolve(assessmentRows.find((a) => a.assessmentId === assessmentId) ?? null);
    },
    listAssessments(): Promise<AssessmentSlice> {
      return Promise.resolve({ assessments: [...assessmentRows] });
    },
  };

  return { policies, findings, assessments, policyRows, findingRows, assessmentRows };
}

const rlsPolicy = (): SecurityPolicy =>
  createSecurityPolicy({
    policyId: 'rls.tenant-isolation',
    title: 'Every tenant table carries an RLS policy.',
    threatIds: ['T-06'],
    category: 'tenant_isolation',
    enforcement: 'enforced',
    status: 'active',
    rules: [
      { id: 'rls.enabled', description: 'RLS is enabled on the table.', severity: 'critical' },
      { id: 'rls.forced', description: 'RLS is FORCEd for the owner.', severity: 'high' },
    ],
    owner: 'platform.database',
    createdAt: AT,
  });

const findingInput = (overrides: Record<string, unknown> = {}) => ({
  findingId: 'finding-001',
  policyId: 'rls.tenant-isolation',
  ruleId: 'rls.enabled',
  threatId: 'T-06',
  category: 'tenant_isolation' as const,
  severity: 'critical' as const,
  status: 'open' as const,
  component: 'content-runs',
  evidence: { table_name: 'content_runs' },
  recommendation: {
    action: 'Enable row-level security on the table.',
    severity: 'critical' as const,
    reference: 'row-level-security.md',
  },
  detectedAt: AT,
  ...overrides,
});

const command = (overrides: Record<string, unknown> = {}) => ({
  assessmentId: 'assessment-001',
  startedAt: AT,
  completedAt: DONE,
  rulesEvaluated: 4,
  scope: { policyIds: null, components: null },
  findings: [findingInput()],
  now: NOW,
  ...overrides,
});

// ── A whole cycle ───────────────────────────────────────────────────────────

describe('one assessment cycle, end to end', () => {
  it('declares a policy, records an assessment and reports on it', async () => {
    const s = stores();
    const policyService = createSecurityPolicyService({ policies: s.policies });
    const assessmentService = createSecurityAssessmentService(s);

    await policyService.declarePolicy(rlsPolicy());
    const assessment = await assessmentService.recordAssessment(command());

    expect(assessment.findings).toHaveLength(1);
    expect(s.findingRows).toHaveLength(1);
    expect(s.assessmentRows).toHaveLength(1);

    const report = buildSecurityReport({
      assessment,
      results: [
        {
          policyId: 'rls.tenant-isolation',
          ruleId: 'rls.enabled',
          component: 'a',
          outcome: 'resolved',
        },
        {
          policyId: 'rls.tenant-isolation',
          ruleId: 'rls.enabled',
          component: 'b',
          outcome: 'open',
        },
      ],
      policies: [rlsPolicy()],
      threatsTotal: THREATS.length,
      generatedAt: NOW,
    });

    expect(report.summary.worstUnresolved).toBe('critical');
    expect(report.compliance.ratio).toBe(0.5);
    expect(report.compliance.threatsCovered).toBe(1);
    expect(report.compliance.threatsTotal).toBe(26);
  });

  it('files nothing new when an unchanged system is rescanned', async () => {
    // The whole point of a fingerprint: a queue must not fill with the same
    // finding once a night.
    const s = stores();
    const policyService = createSecurityPolicyService({ policies: s.policies });
    const assessmentService = createSecurityAssessmentService(s);

    await policyService.declarePolicy(rlsPolicy());
    const first = await assessmentService.recordAssessment(command());
    const second = await assessmentService.recordAssessment(
      command({
        assessmentId: 'assessment-002',
        findings: [findingInput({ findingId: 'finding-002', detectedAt: DONE })],
      }),
    );

    expect(s.findingRows).toHaveLength(1);
    expect(newFindings(second.findings, first.findings)).toHaveLength(0);
  });

  it('reports a genuinely new finding as new', async () => {
    const s = stores();
    await createSecurityPolicyService({ policies: s.policies }).declarePolicy(rlsPolicy());
    const service = createSecurityAssessmentService(s);

    const first = await service.recordAssessment(command());
    const second = await service.recordAssessment(
      command({
        assessmentId: 'assessment-002',
        findings: [findingInput({ findingId: 'finding-002', component: 'drafts' })],
      }),
    );

    expect(newFindings(second.findings, first.findings).map((f) => f.component)).toEqual([
      'drafts',
    ]);
    expect(s.findingRows).toHaveLength(2);
  });

  it('answers which declared threats have no active policy', async () => {
    // The question the whole model exists to ask, and one nobody can answer by
    // reading twenty files of comments.
    const s = stores();
    const service = createSecurityPolicyService({ policies: s.policies });

    expect(await service.uncoveredThreats()).toHaveLength(26);

    await service.declarePolicy(rlsPolicy());
    const uncovered = await service.uncoveredThreats();

    expect(uncovered).toHaveLength(25);
    expect(uncovered).not.toContain('T-06');
  });

  it('does not count a draft policy as coverage', async () => {
    const s = stores();
    const service = createSecurityPolicyService({ policies: s.policies });
    await service.declarePolicy(createSecurityPolicy({ ...rlsPolicy(), status: 'draft' }));

    expect(await service.uncoveredThreats()).toContain('T-06');
  });

  it('transitions a finding without changing anything else about it', async () => {
    const s = stores();
    await createSecurityPolicyService({ policies: s.policies }).declarePolicy(rlsPolicy());
    const service = createSecurityAssessmentService(s);
    await service.recordAssessment(command());

    const moved = await service.transitionFinding({
      findingId: 'finding-001',
      status: 'accepted',
      at: NOW,
    });

    expect(moved.status).toBe('accepted');
    expect(moved.severity).toBe('critical');
    expect(moved.threatId).toBe('T-06');
  });
});

// ── What the services refuse ────────────────────────────────────────────────

describe('the services refuse what a report cannot carry', () => {
  it('refuses a finding against an undeclared policy', async () => {
    const s = stores();
    const service = createSecurityAssessmentService(s);

    await expect(service.recordAssessment(command())).rejects.toBeInstanceOf(SecurityError);
    expect(s.assessmentRows).toHaveLength(0);
  });

  it('refuses a finding against a rule the policy does not declare', async () => {
    // A finding against a rule nobody declared cannot be traced to a control.
    const s = stores();
    await createSecurityPolicyService({ policies: s.policies }).declarePolicy(rlsPolicy());

    await expect(
      createSecurityAssessmentService(s).recordAssessment(
        command({ findings: [findingInput({ ruleId: 'rls.invented' })] }),
      ),
    ).rejects.toMatchObject({ code: 'UnknownRule' });
    expect(s.findingRows).toHaveLength(0);
  });

  it('refuses an assessment that completed in the future', async () => {
    const s = stores();
    await createSecurityPolicyService({ policies: s.policies }).declarePolicy(rlsPolicy());

    await expect(
      createSecurityAssessmentService(s).recordAssessment(
        command({ completedAt: '2027-01-01T00:00:00.000Z' }),
      ),
    ).rejects.toMatchObject({ code: 'FutureAssessment' });
  });

  it('refuses a duplicate finding within one run', async () => {
    const s = stores();
    await createSecurityPolicyService({ policies: s.policies }).declarePolicy(rlsPolicy());

    await expect(
      createSecurityAssessmentService(s).recordAssessment(
        command({
          rulesEvaluated: 4,
          findings: [findingInput(), findingInput({ findingId: 'finding-002' })],
        }),
      ),
    ).rejects.toMatchObject({ code: 'DuplicateFinding' });
    expect(s.findingRows).toHaveLength(0);
  });

  it('writes nothing at all when it refuses', async () => {
    const s = stores();
    await createSecurityPolicyService({ policies: s.policies }).declarePolicy(rlsPolicy());

    await expect(
      createSecurityAssessmentService(s).recordAssessment(
        command({ findings: [findingInput({ threatId: 'T-99' })] }),
      ),
    ).rejects.toBeInstanceOf(SecurityError);

    expect(s.findingRows).toHaveLength(0);
    expect(s.assessmentRows).toHaveLength(0);
  });

  it('refuses a second policy under one id', async () => {
    const s = stores();
    const service = createSecurityPolicyService({ policies: s.policies });
    await service.declarePolicy(rlsPolicy());

    await expect(service.declarePolicy(rlsPolicy())).rejects.toBeInstanceOf(SecurityError);
  });
});

// ── Posture actions reach the real audit log ────────────────────────────────

describe('a posture action is audited through the frozen audit service', () => {
  interface Row {
    readonly values: readonly unknown[];
  }

  function auditTable(): { executor: AuditExecutor; rows: Row[] } {
    const rows: Row[] = [];
    const executor: AuditExecutor = {
      query<T>(sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
        if (sql.includes('SELECT')) {
          const mine = rows.filter((row) => row.values[1] === params[0]);
          const head = mine[mine.length - 1];
          return Promise.resolve(
            (head === undefined ? [] : [{ hash: head.values[15] as string }]) as T[],
          );
        }
        rows.push({ values: params });
        return Promise.resolve([] as T[]);
      },
    };
    return { executor, rows };
  }

  const auditRig = () => {
    const table = auditTable();
    let seq = 0;
    const writer = createPersistentAuditWriter({
      now: () => new Date(NOW),
      newId: () => `audit-${String((seq += 1)).padStart(4, '0')}`,
    });
    return { table, service: createAuditService({ writer }) };
  };

  const postureEvent = (action: (typeof POSTURE_ACTIONS)[keyof typeof POSTURE_ACTIONS]) =>
    toAuditEvent({
      action,
      principal,
      organizationId: ORG,
      tenantId: TENANT,
      correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
      targetKind: 'security_policy',
      targetId: 'rls.tenant-isolation',
      reason: 'Declared during the quarterly review.',
    });

  it('records a policy declaration as a verifiable chain link', async () => {
    const r = auditRig();
    await r.service.record(r.table.executor, postureEvent(POSTURE_ACTIONS.policyDeclared));

    expect(r.table.rows).toHaveLength(1);
    const values = r.table.rows[0]?.values ?? [];
    expect(values[7]).toBe('security.policy.declared');

    const record: AuditRecord = {
      auditId: values[0] as string,
      tenantId: values[1] as string | null,
      organizationId: values[2] as string,
      actorId: values[3] as string,
      actorKind: values[4] as AuditRecord['actorKind'],
      correlationId: values[5] as string,
      timestamp: new Date(values[6] as string),
      action: values[7] as string,
      target: {
        kind: values[8] as string,
        id: values[9] as string,
        tenantId: values[10] as string | null,
      },
      result: values[11] as AuditRecord['result'],
      reason: values[12] as string,
      context: JSON.parse(values[13] as string) as AuditRecord['context'],
      previousHash: values[14] as string,
      hash: values[15] as string,
    };

    expect(verifyChainLink(record)).toBe(true);
  });

  it('files every posture action under administration', async () => {
    // `threat-model.md` T-25 is insider threat, and changing a control is
    // exactly the operator action that entry is about.
    const r = auditRig();
    for (const action of Object.values(POSTURE_ACTIONS)) {
      await r.service.record(r.table.executor, postureEvent(action));
    }

    for (const row of r.table.rows) {
      const context = JSON.parse(row.values[13] as string) as { detail?: Record<string, string> };
      expect(context.detail?.['audit_category']).toBe('administration');
    }
    expect(r.table.rows).toHaveLength(5);
  });

  it('produces actions the frozen audit validator accepts', async () => {
    // Every posture action must satisfy the dot-namespaced shape the audit
    // service enforces, or the record would be refused at the door.
    const r = auditRig();
    for (const action of Object.values(POSTURE_ACTIONS)) {
      await expect(r.service.record(r.table.executor, postureEvent(action))).resolves.toMatch(
        /^audit-/,
      );
    }
  });

  it('takes the actor from the principal, never inventing one', () => {
    const event = postureEvent(POSTURE_ACTIONS.findingAccepted);

    expect(event.actor.id).toBe(principal.subjectId);
    expect(event.actor.kind).toBe('user');
  });

  it('is deep-frozen', () => {
    const event = postureEvent(POSTURE_ACTIONS.policyRetired);

    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.target)).toBe(true);
  });
});

// ── The services enforce nothing ────────────────────────────────────────────

describe('the posture layer changes no control', () => {
  it('offers no way to delete a policy or lower a severity', () => {
    const s = stores();
    const policyService = createSecurityPolicyService({ policies: s.policies });
    const assessmentService = createSecurityAssessmentService(s);

    const surface = [...Object.keys(policyService), ...Object.keys(assessmentService)];
    for (const forbidden of ['deletePolicy', 'setSeverity', 'downgrade', 'suppress', 'bypass']) {
      expect(surface).not.toContain(forbidden);
    }
  });

  it('freezes both services', () => {
    const s = stores();
    expect(Object.isFrozen(createSecurityPolicyService({ policies: s.policies }))).toBe(true);
    expect(Object.isFrozen(createSecurityAssessmentService(s))).toBe(true);
  });

  it('stores a finding exactly as the scan reported it', async () => {
    // No severity is adjusted on the way in: a finding's severity is what the
    // scan saw.
    const s = stores();
    await createSecurityPolicyService({ policies: s.policies }).declarePolicy(rlsPolicy());
    await createSecurityAssessmentService(s).recordAssessment(command());

    const stored = s.findingRows[0];
    expect(stored?.severity).toBe('critical');
    expect(stored?.evidence).toEqual({ table_name: 'content_runs' });
  });

  it('produces a scan result type that carries no remediation hook', () => {
    // A scan reports; something else fixes.
    const result: ScanResult = {
      policyId: 'rls.tenant-isolation',
      ruleId: 'rls.enabled',
      component: 'a',
      outcome: 'open',
    };

    expect(Object.keys(result)).toEqual(['policyId', 'ruleId', 'component', 'outcome']);
  });
});
