import { describe, expect, it } from 'vitest';

import {
  assertValidAssessment,
  buildSecurityReport,
  calculateCompliance,
  createSecurityAssessment,
  disappearedFindings,
  newFindings,
  summarize,
  type ScanResult,
  type SecurityAssessment,
} from './assessment.js';
import {
  assertIdentifier,
  assertInstant,
  MAX_IDENTIFIER_LENGTH,
  SecurityError,
  type SecurityErrorCode,
} from './errors.js';
import {
  assertValidEvidence,
  assertValidRecommendation,
  createSecurityFinding,
  FINDING_STATUSES,
  fingerprintOf,
  isFindingStatus,
  isUnresolved,
  MAX_EVIDENCE_KEYS,
  MAX_EVIDENCE_VALUE_LENGTH,
  type SecurityFinding,
} from './finding.js';
import {
  createSecurityPolicy,
  ENFORCEMENT_MODES,
  inherentSeverity,
  isEnforcementMode,
  isPolicyStatus,
  MAX_TEXT_LENGTH,
  POLICY_STATUSES,
  ruleOf,
  type SecurityPolicy,
} from './policy.js';
import {
  isKnownThreat,
  isSecurityCategory,
  isSecuritySeverity,
  isThreatIdShape,
  SECURITY_CATEGORIES,
  SECURITY_SEVERITIES,
  SEVERITY_DEFINITIONS,
  severityRank,
  threatOf,
  THREATS,
  threatsIn,
  worstOf,
} from './threats.js';

const AT = '2026-03-01T00:00:00.000Z';
const NOW = '2026-03-01T12:00:00.000Z';

const codeOf = (call: () => unknown): SecurityErrorCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof SecurityError) return error.code;
    throw error;
  }
};

const policy = (overrides: Partial<SecurityPolicy> = {}): SecurityPolicy =>
  createSecurityPolicy({
    policyId: 'rls.tenant-isolation',
    title: 'Every tenant table carries an RLS policy.',
    threatIds: ['T-06'],
    category: 'tenant_isolation',
    enforcement: 'enforced',
    status: 'active',
    rules: [
      { id: 'rls.enabled', description: 'RLS is enabled on the table.', severity: 'critical' },
    ],
    owner: 'platform.database',
    createdAt: AT,
    ...overrides,
  });

const finding = (
  overrides: Partial<Parameters<typeof createSecurityFinding>[0]> = {},
): SecurityFinding =>
  createSecurityFinding({
    findingId: 'finding-001',
    policyId: 'rls.tenant-isolation',
    ruleId: 'rls.enabled',
    threatId: 'T-06',
    category: 'tenant_isolation',
    severity: 'critical',
    status: 'open',
    component: 'content-runs',
    evidence: { table_name: 'content_runs' },
    recommendation: {
      action: 'Enable row-level security on the table.',
      severity: 'critical',
      reference: 'row-level-security.md',
    },
    detectedAt: AT,
    ...overrides,
  });

// ── The threat model ────────────────────────────────────────────────────────

describe('the threat model is the document’s', () => {
  it('declares all twenty-six threats', () => {
    expect(THREATS).toHaveLength(26);
    expect(THREATS[0]?.id).toBe('T-01');
    expect(THREATS[25]?.id).toBe('T-26');
  });

  it('numbers them without a gap', () => {
    THREATS.forEach((threat, index) => {
      expect(threat.id).toBe(`T-${String(index + 1).padStart(2, '0')}`);
    });
  });

  it('gives every threat a declared severity and category', () => {
    for (const threat of THREATS) {
      expect(isSecuritySeverity(threat.severity)).toBe(true);
      expect(isSecurityCategory(threat.category)).toBe(true);
      // A title, not a length: `XSS` is a legitimate three-character one.
      expect(threat.title.trim()).toBe(threat.title);
      expect(threat.title).not.toBe('');
    }
  });

  it('carries the document’s severities, worst first', () => {
    expect(SECURITY_SEVERITIES).toEqual(['critical', 'high', 'medium', 'low']);
    expect(severityRank('critical')).toBeLessThan(severityRank('low'));
  });

  it('defines what each severity means', () => {
    // A severity with no definition becomes whatever the person filing felt.
    expect(SEVERITY_DEFINITIONS.critical).toContain('Cross-tenant data exposure');
    for (const severity of SECURITY_SEVERITIES) {
      expect(SEVERITY_DEFINITIONS[severity].length).toBeGreaterThan(20);
    }
  });

  it('carries the document’s five categories', () => {
    expect(SECURITY_CATEGORIES).toEqual([
      'identity_and_access',
      'tenant_isolation',
      'application_surface',
      'platform_and_infrastructure',
      'abuse_and_availability',
    ]);
  });

  it('places every threat in exactly one category', () => {
    let counted = 0;
    for (const category of SECURITY_CATEGORIES) counted += threatsIn(category).length;
    expect(counted).toBe(THREATS.length);
  });

  it('classifies the ones the document is explicit about', () => {
    expect(threatOf('T-06')?.severity).toBe('critical'); // cross-tenant leakage
    expect(threatOf('T-13')?.severity).toBe('critical'); // SSRF
    expect(threatOf('T-19')?.severity).toBe('critical'); // secrets leakage
    // Rate-limit bypass is Medium, not High: credit accounting caps spend
    // regardless of request count.
    expect(threatOf('T-24')?.severity).toBe('medium');
  });

  it('rejects a threat nobody declared', () => {
    expect(isKnownThreat('T-99')).toBe(false);
    expect(isKnownThreat('T-27')).toBe(false);
    expect(threatOf('T-99')).toBeNull();
  });

  it('rejects an identifier that is not the document’s format', () => {
    expect(isThreatIdShape('T-1')).toBe(false);
    expect(isThreatIdShape('t-01')).toBe(false);
    expect(isThreatIdShape('THREAT-01')).toBe(false);
    expect(isThreatIdShape('T-01')).toBe(true);
  });

  it('is frozen through', () => {
    expect(Object.isFrozen(THREATS)).toBe(true);
    expect(Object.isFrozen(THREATS[0])).toBe(true);
    expect(() => {
      (THREATS[0] as { severity: string }).severity = 'low';
    }).toThrow();
  });

  it('finds the worst of a set', () => {
    expect(worstOf(['low', 'critical', 'medium'])).toBe('critical');
    expect(worstOf(['low', 'medium'])).toBe('medium');
    expect(worstOf([])).toBeNull();
  });
});

// ── Shared assertions ───────────────────────────────────────────────────────

describe('identifier and instant validation', () => {
  it('accepts a dotted or hyphenated lowercase identifier', () => {
    expect(assertIdentifier('rls.tenant-isolation', 'x')).toBe('rls.tenant-isolation');
    expect(assertIdentifier('content_runs', 'x')).toBe('content_runs');
  });

  it('refuses free text, paths and uppercase', () => {
    // Identifiers appear in reports and in metric labels, so free text here
    // becomes disclosure there.
    for (const bad of ['Tenant Isolation', '/etc/passwd', 'C:\\secrets', 'RLS', 'a b']) {
      expect(codeOf(() => assertIdentifier(bad, 'x'))).toBe('MalformedIdentifier');
    }
  });

  it('refuses an identifier past the length limit', () => {
    expect(codeOf(() => assertIdentifier('a'.repeat(MAX_IDENTIFIER_LENGTH + 1), 'x'))).toBe(
      'MalformedIdentifier',
    );
  });

  it('refuses an empty identifier as missing, not malformed', () => {
    expect(codeOf(() => assertIdentifier('', 'x'))).toBe('MissingField');
  });

  it('accepts a UTC instant and refuses a local one', () => {
    expect(assertInstant(AT, 'at')).toBe(AT);
    expect(codeOf(() => assertInstant('2026-03-01T00:00:00', 'at'))).toBe('InvalidTimestamp');
    expect(codeOf(() => assertInstant('2026-03-01', 'at'))).toBe('InvalidTimestamp');
    expect(codeOf(() => assertInstant('2026-13-45T00:00:00.000Z', 'at'))).toBe('InvalidTimestamp');
    expect(codeOf(() => assertInstant(null, 'at'))).toBe('InvalidTimestamp');
  });
});

// ── Policies ────────────────────────────────────────────────────────────────

describe('security policies', () => {
  it('build when well-formed, and freeze through', () => {
    const built = policy();

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.rules)).toBe(true);
    expect(Object.isFrozen(built.rules[0])).toBe(true);
    expect(Object.isFrozen(built.threatIds)).toBe(true);
  });

  it('copy the arrays they were given', () => {
    const threatIds = ['T-06'];
    const built = createSecurityPolicy({ ...policy(), threatIds });
    threatIds.push('T-07');

    expect(built.threatIds).toEqual(['T-06']);
  });

  it('refuse a policy naming no threat', () => {
    expect(codeOf(() => createSecurityPolicy({ ...policy(), threatIds: [] }))).toBe(
      'InvalidPolicy',
    );
  });

  it('refuse a threat nobody declared', () => {
    // A report counting it as coverage would say the platform is protected
    // against something imaginary.
    expect(codeOf(() => createSecurityPolicy({ ...policy(), threatIds: ['T-99'] }))).toBe(
      'UnknownThreat',
    );
  });

  it('refuse a malformed threat identifier before an unknown one', () => {
    expect(codeOf(() => createSecurityPolicy({ ...policy(), threatIds: ['nope'] }))).toBe(
      'MalformedIdentifier',
    );
  });

  it('refuse a threat listed twice', () => {
    expect(codeOf(() => createSecurityPolicy({ ...policy(), threatIds: ['T-06', 'T-06'] }))).toBe(
      'InvalidPolicy',
    );
  });

  it('refuse a policy with no rule', () => {
    // It could never pass or fail, so it would sit in every report saying
    // nothing.
    expect(codeOf(() => createSecurityPolicy({ ...policy(), rules: [] }))).toBe('InvalidPolicy');
  });

  it('refuse a duplicate rule id', () => {
    const rule = { id: 'rls.enabled', description: 'x', severity: 'high' as const };
    expect(codeOf(() => createSecurityPolicy({ ...policy(), rules: [rule, rule] }))).toBe(
      'InvalidPolicy',
    );
  });

  it('refuse an unknown enforcement mode, status or category', () => {
    expect(
      codeOf(() => createSecurityPolicy({ ...policy(), enforcement: 'magic' as 'enforced' })),
    ).toBe('InvalidPolicy');
    expect(codeOf(() => createSecurityPolicy({ ...policy(), status: 'deleted' as 'active' }))).toBe(
      'InvalidPolicy',
    );
    expect(
      codeOf(() => createSecurityPolicy({ ...policy(), category: 'other' as 'tenant_isolation' })),
    ).toBe('InvalidCategory');
  });

  it('refuse an invalid rule severity', () => {
    expect(
      codeOf(() =>
        createSecurityPolicy({
          ...policy(),
          rules: [{ id: 'r', description: 'x', severity: 'urgent' as 'high' }],
        }),
      ),
    ).toBe('InvalidSeverity');
  });

  it('refuse a title long enough to hold a stack trace', () => {
    expect(
      codeOf(() => createSecurityPolicy({ ...policy(), title: 'x'.repeat(MAX_TEXT_LENGTH + 1) })),
    ).toBe('InvalidPolicy');
  });

  it('name their enumerations', () => {
    expect(ENFORCEMENT_MODES).toEqual(['enforced', 'detective', 'manual']);
    expect(POLICY_STATUSES).toEqual(['active', 'draft', 'retired']);
    expect(isEnforcementMode('enforced')).toBe(true);
    expect(isEnforcementMode('blocking')).toBe(false);
    expect(isPolicyStatus('retired')).toBe(true);
    expect(isPolicyStatus('deleted')).toBe(false);
  });

  it('answer whether they declare a rule', () => {
    expect(ruleOf(policy(), 'rls.enabled')?.severity).toBe('critical');
    expect(ruleOf(policy(), 'nope')).toBeNull();
  });

  it('report the inherent severity of the worst threat they cover', () => {
    // A control over a Critical threat is reviewed before one over a Low,
    // whatever its own rules say.
    expect(inherentSeverity(policy())).toBe('critical');
    expect(inherentSeverity(createSecurityPolicy({ ...policy(), threatIds: ['T-12'] }))).toBe(
      'medium',
    );
  });
});

// ── Findings ────────────────────────────────────────────────────────────────

describe('security findings', () => {
  it('build when well-formed, and freeze through', () => {
    const built = finding();

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.evidence)).toBe(true);
    expect(Object.isFrozen(built.recommendation)).toBe(true);
  });

  it('derive the fingerprint from policy, rule and component', () => {
    // Stable across scans of an unchanged system — which is what makes a
    // finding deduplicable. The detection instant is deliberately not in it.
    expect(finding().fingerprint).toBe('rls.tenant-isolation:rls.enabled:content-runs');
    expect(finding({ detectedAt: '2027-01-01T00:00:00.000Z' }).fingerprint).toBe(
      finding().fingerprint,
    );
  });

  it('refuse a fingerprint that says otherwise', () => {
    // One that lied would deduplicate against the wrong finding, and the same
    // problem would be filed every night.
    expect(codeOf(() => finding({ fingerprint: 'something:else:entirely' }))).toBe(
      'MalformedIdentifier',
    );
  });

  it('compute the same fingerprint as the helper', () => {
    expect(fingerprintOf({ policyId: 'a.b', ruleId: 'c.d', component: 'e' })).toBe('a.b:c.d:e');
  });

  it('refuse a threat nobody declared', () => {
    expect(codeOf(() => finding({ threatId: 'T-99' }))).toBe('UnknownThreat');
  });

  it('refuse an invalid severity, category or status', () => {
    expect(codeOf(() => finding({ severity: 'urgent' as 'high' }))).toBe('InvalidSeverity');
    expect(codeOf(() => finding({ category: 'other' as 'tenant_isolation' }))).toBe(
      'InvalidCategory',
    );
    expect(codeOf(() => finding({ status: 'closed' as 'open' }))).toBe('InvalidPolicy');
  });

  it('refuse a malformed identifier or timestamp', () => {
    expect(codeOf(() => finding({ findingId: 'Finding 1' }))).toBe('MalformedIdentifier');
    expect(codeOf(() => finding({ component: '/var/lib/data' }))).toBe('MalformedIdentifier');
    expect(codeOf(() => finding({ detectedAt: '2026-03-01' }))).toBe('InvalidTimestamp');
  });

  it('name every finding status', () => {
    expect(FINDING_STATUSES).toEqual(['open', 'accepted', 'resolved', 'not_applicable']);
    expect(isFindingStatus('open')).toBe(true);
    expect(isFindingStatus('closed')).toBe(false);
  });

  it('count only open findings as unresolved', () => {
    expect(isUnresolved(finding({ status: 'open' }))).toBe(true);
    expect(isUnresolved(finding({ status: 'accepted' }))).toBe(false);
    expect(isUnresolved(finding({ status: 'resolved' }))).toBe(false);
  });
});

describe('evidence is bounded so it cannot become a disclosure', () => {
  it('accepts enumerated string detail', () => {
    expect(codeOf(() => assertValidEvidence({ table_name: 'content_runs' }))).toBeNull();
  });

  it('refuses more keys than the limit', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i <= MAX_EVIDENCE_KEYS; i += 1) wide[`key_${String(i)}`] = 'x';
    expect(codeOf(() => assertValidEvidence(wide))).toBe('InvalidPolicy');
  });

  it('refuses a value wide enough for a stack trace', () => {
    // A field that wide eventually holds one, and then holds a secret.
    expect(
      codeOf(() => assertValidEvidence({ detail: 'x'.repeat(MAX_EVIDENCE_VALUE_LENGTH + 1) })),
    ).toBe('InvalidPolicy');
  });

  it('refuses a non-string value and a bad key', () => {
    expect(codeOf(() => assertValidEvidence({ n: 1 as unknown as string }))).toBe('InvalidPolicy');
    expect(codeOf(() => assertValidEvidence({ 'Table Name': 'x' }))).toBe('InvalidPolicy');
  });
});

describe('recommendations', () => {
  it('accept an action with a document reference', () => {
    expect(
      codeOf(() =>
        assertValidRecommendation({
          action: 'Enable RLS.',
          severity: 'critical',
          reference: 'row-level-security.md',
        }),
      ),
    ).toBeNull();
  });

  it('refuse one with no action', () => {
    // A recommendation with no action is a finding with extra words.
    expect(
      codeOf(() => assertValidRecommendation({ action: '', severity: 'high', reference: null })),
    ).toBe('MissingField');
  });

  it('refuse a path or a URL as a reference', () => {
    // Paths are implementation detail, and a report is read outside the team.
    for (const reference of ['/src/db/rls.ts', 'C:\\repo\\rls.ts', 'https://internal/wiki']) {
      expect(
        codeOf(() => assertValidRecommendation({ action: 'Fix.', severity: 'high', reference })),
      ).toBe('InvalidRecommendation');
    }
  });

  it('refuse an invalid severity', () => {
    expect(
      codeOf(() =>
        assertValidRecommendation({
          action: 'Fix.',
          severity: 'urgent' as 'high',
          reference: null,
        }),
      ),
    ).toBe('InvalidSeverity');
  });
});

// ── Assessments ─────────────────────────────────────────────────────────────

describe('assessments', () => {
  const assessment = (overrides: Partial<SecurityAssessment> = {}): SecurityAssessment => ({
    assessmentId: 'assessment-001',
    scope: { policyIds: null, components: null },
    startedAt: AT,
    completedAt: '2026-03-01T00:05:00.000Z',
    rulesEvaluated: 10,
    findings: [finding()],
    ...overrides,
  });

  it('build when well-formed and freeze through', () => {
    const built = createSecurityAssessment(assessment(), NOW);

    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.findings)).toBe(true);
    expect(Object.isFrozen(built.scope)).toBe(true);
  });

  it('refuse one that completed in the future', () => {
    // A clock skew or a fabrication; either makes a report claim the platform
    // was verified at a time it was not.
    expect(
      codeOf(() =>
        assertValidAssessment(assessment({ completedAt: '2027-01-01T00:00:00.000Z' }), NOW),
      ),
    ).toBe('FutureAssessment');
  });

  it('accept one that completed exactly now', () => {
    expect(codeOf(() => assertValidAssessment(assessment({ completedAt: NOW }), NOW))).toBeNull();
  });

  it('refuse one that finished before it started', () => {
    expect(
      codeOf(() =>
        assertValidAssessment(
          assessment({ startedAt: '2026-03-01T01:00:00.000Z', completedAt: AT }),
          NOW,
        ),
      ),
    ).toBe('InconsistentAssessment');
  });

  it('refuse more findings than evaluations', () => {
    // A finding comes from an evaluation, so it cannot have produced more than
    // it ran.
    expect(codeOf(() => assertValidAssessment(assessment({ rulesEvaluated: 0 }), NOW))).toBe(
      'InconsistentAssessment',
    );
  });

  it('refuse a negative or fractional rule count', () => {
    expect(codeOf(() => assertValidAssessment(assessment({ rulesEvaluated: -1 }), NOW))).toBe(
      'InconsistentAssessment',
    );
    expect(codeOf(() => assertValidAssessment(assessment({ rulesEvaluated: 1.5 }), NOW))).toBe(
      'InconsistentAssessment',
    );
  });

  it('refuse the same finding twice in one run', () => {
    // A queue that accepted it would show one problem as two, and closing one
    // would leave the other open forever.
    expect(
      codeOf(() =>
        assertValidAssessment(
          assessment({ findings: [finding(), finding({ findingId: 'finding-002' })] }),
          NOW,
        ),
      ),
    ).toBe('DuplicateFinding');
  });

  it('accept two findings with different fingerprints', () => {
    expect(
      codeOf(() =>
        assertValidAssessment(
          assessment({
            findings: [finding(), finding({ findingId: 'finding-002', component: 'drafts' })],
          }),
          NOW,
        ),
      ),
    ).toBeNull();
  });

  it('refuse an invalid now', () => {
    expect(codeOf(() => assertValidAssessment(assessment(), 'whenever'))).toBe('InvalidTimestamp');
  });
});

// ── Summary, compliance and the report ──────────────────────────────────────

describe('summarize', () => {
  it('counts by severity and by category', () => {
    // Both, because they answer different questions: how urgent, and where.
    const summary = summarize([
      finding(),
      finding({ findingId: 'f2', component: 'drafts', severity: 'high' }),
      finding({
        findingId: 'f3',
        component: 'gateway',
        severity: 'medium',
        category: 'application_surface',
        threatId: 'T-12',
      }),
    ]);

    expect(summary.total).toBe(3);
    expect(summary.bySeverity.critical).toBe(1);
    expect(summary.bySeverity.high).toBe(1);
    expect(summary.bySeverity.low).toBe(0);
    expect(summary.byCategory.tenant_isolation).toBe(2);
    expect(summary.byCategory.application_surface).toBe(1);
  });

  it('reports the worst unresolved, ignoring the ones already handled', () => {
    const summary = summarize([
      finding({ severity: 'critical', status: 'accepted' }),
      finding({ findingId: 'f2', component: 'drafts', severity: 'medium', status: 'open' }),
    ]);

    expect(summary.unresolved).toBe(1);
    expect(summary.worstUnresolved).toBe('medium');
  });

  it('reports null when nothing is outstanding', () => {
    expect(summarize([finding({ status: 'resolved' })]).worstUnresolved).toBeNull();
    expect(summarize([]).worstUnresolved).toBeNull();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(summarize([]))).toBe(true);
  });
});

describe('calculateCompliance', () => {
  const result = (outcome: ScanResult['outcome'], component = 'a'): ScanResult => ({
    policyId: 'rls.tenant-isolation',
    ruleId: 'rls.enabled',
    component,
    outcome,
  });

  it('scores passes over what actually applied', () => {
    const compliance = calculateCompliance({
      results: [result('resolved'), result('resolved', 'b'), result('open', 'c')],
      policies: [policy()],
      threatsTotal: 26,
    });

    expect(compliance.evaluated).toBe(3);
    expect(compliance.applicable).toBe(3);
    expect(compliance.passed).toBe(2);
    expect(compliance.ratio).toBeCloseTo(0.6667, 4);
  });

  it('excludes not-applicable from the denominator', () => {
    // Counting them would let a deployment reach 100% by not having the
    // features the rules are about.
    const compliance = calculateCompliance({
      results: [result('resolved'), result('not_applicable', 'b')],
      policies: [policy()],
      threatsTotal: 26,
    });

    expect(compliance.evaluated).toBe(2);
    expect(compliance.applicable).toBe(1);
    expect(compliance.ratio).toBe(1);
  });

  it('reports null rather than a ratio when nothing applied', () => {
    const compliance = calculateCompliance({
      results: [result('not_applicable')],
      policies: [policy()],
      threatsTotal: 26,
    });

    expect(compliance.ratio).toBeNull();
  });

  it('counts threats covered by ACTIVE policies only', () => {
    const covered = calculateCompliance({
      results: [],
      policies: [
        policy(),
        createSecurityPolicy({ ...policy(), policyId: 'p2', status: 'draft', threatIds: ['T-07'] }),
      ],
      threatsTotal: 26,
    });

    expect(covered.threatsCovered).toBe(1);
    expect(covered.threatsTotal).toBe(26);
  });

  it('rounds the ratio to something a human quotes', () => {
    const compliance = calculateCompliance({
      results: [result('resolved'), result('open', 'b'), result('open', 'c')],
      policies: [],
      threatsTotal: 26,
    });

    expect(compliance.ratio).toBe(0.3333);
  });

  it('is frozen', () => {
    expect(
      Object.isFrozen(calculateCompliance({ results: [], policies: [], threatsTotal: 26 })),
    ).toBe(true);
  });
});

describe('finding diffs across scans', () => {
  it('reports only what the previous scan did not have', () => {
    // Compared by fingerprint, not by id: a rescan produces the same
    // fingerprints with new ids.
    const known = [finding()];
    const found = [
      finding({ findingId: 'different-id' }),
      finding({ findingId: 'f2', component: 'drafts' }),
    ];

    expect(newFindings(found, known).map((f) => f.component)).toEqual(['drafts']);
  });

  it('reports an open finding that a later scan no longer produces', () => {
    const known = [finding({ status: 'open' })];
    expect(disappearedFindings(known, []).map((f) => f.findingId)).toEqual(['finding-001']);
  });

  it('does not report one that was already accepted', () => {
    const known = [finding({ status: 'accepted' })];
    expect(disappearedFindings(known, [])).toHaveLength(0);
  });

  it('freezes both results', () => {
    expect(Object.isFrozen(newFindings([], []))).toBe(true);
    expect(Object.isFrozen(disappearedFindings([], []))).toBe(true);
  });
});

describe('buildSecurityReport', () => {
  it('assembles the assessment, its summary and its compliance', () => {
    const assessment = createSecurityAssessment(
      {
        assessmentId: 'assessment-001',
        scope: { policyIds: null, components: null },
        startedAt: AT,
        completedAt: '2026-03-01T00:05:00.000Z',
        rulesEvaluated: 4,
        findings: [finding()],
      },
      NOW,
    );

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
      policies: [policy()],
      threatsTotal: THREATS.length,
      generatedAt: NOW,
    });

    expect(report.summary.total).toBe(1);
    expect(report.compliance.ratio).toBe(0.5);
    expect(report.compliance.threatsTotal).toBe(26);
    expect(report.generatedAt).toBe(NOW);
    expect(Object.isFrozen(report)).toBe(true);
  });

  it('refuses a malformed generation instant', () => {
    const assessment = createSecurityAssessment(
      {
        assessmentId: 'a',
        scope: { policyIds: null, components: null },
        startedAt: AT,
        completedAt: AT,
        rulesEvaluated: 0,
        findings: [],
      },
      NOW,
    );

    expect(
      codeOf(() =>
        buildSecurityReport({
          assessment,
          results: [],
          policies: [],
          threatsTotal: 26,
          generatedAt: 'now',
        }),
      ),
    ).toBe('InvalidTimestamp');
  });
});
