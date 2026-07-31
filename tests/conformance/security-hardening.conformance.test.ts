/**
 * The security-posture layer against the controls it reports on.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. IT OBSERVES AND ENFORCES NOTHING. There is no path from this module to
 *    authentication, authorization, rate limiting, RLS or the audit chain. A
 *    posture tool that could weaken a control would be the vulnerability it
 *    exists to find.
 *
 * 2. THE THREAT MODEL IS THE DOCUMENT'S. Twenty-six threats, four severities,
 *    five categories — transcribed, and asserted against the file itself.
 *
 * 3. IT DISCLOSES NOTHING. No stack trace, no path, no query, no token, no
 *    credential can be represented in a finding, because every field that
 *    could hold one is bounded and shape-checked.
 *
 * 4. NO SQL, NO DRIVER, NO SDK, NO CLOCK, NO HTTP, NO GLOBAL.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { scanForCredentials } from '@contentos/observability';
import {
  assertValidFinding,
  createSecurityFinding,
  createSecurityPolicy,
  MAX_EVIDENCE_VALUE_LENGTH,
  POSTURE_ACTIONS,
  SECURITY_CATEGORIES,
  SECURITY_SEVERITIES,
  SecurityError,
  THREATS,
  toAuditEvent,
  type SecurityAssessmentRepository,
  type SecurityFinding,
  type SecurityFindingRepository,
  type SecurityPolicy,
  type SecurityPolicyRepository,
} from '@contentos/security';
import { describe, expect, it } from 'vitest';

const hardeningDir = new URL('../../packages/security/src/hardening/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, hardeningDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** Every module this increment added. */
const MODULES = [
  'threats.ts',
  'errors.ts',
  'policy.ts',
  'finding.ts',
  'assessment.ts',
  'repository.ts',
  'service.ts',
] as const;

const AT = '2026-03-01T00:00:00.000Z';

const policy = (): SecurityPolicy =>
  createSecurityPolicy({
    policyId: 'rls.tenant-isolation',
    title: 'Every tenant table carries an RLS policy.',
    threatIds: ['T-06'],
    category: 'tenant_isolation',
    enforcement: 'enforced',
    status: 'active',
    rules: [{ id: 'rls.enabled', description: 'RLS is enabled.', severity: 'critical' }],
    owner: 'platform.database',
    createdAt: AT,
  });

const finding = (overrides: Record<string, unknown> = {}): SecurityFinding =>
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
    recommendation: { action: 'Enable RLS.', severity: 'critical', reference: null },
    detectedAt: AT,
    ...overrides,
  });

// ── 1 · It observes and enforces nothing ────────────────────────────────────

describe('the posture layer cannot touch a control', () => {
  it('imports no authentication or authorization module', () => {
    // The controls stay where they are. A posture module that could reach one
    // would be able to weaken the thing it reports on.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\.\.\/authn\/(?!principal)/);
      expect(code).not.toMatch(/\.\.\/authz\//);
      expect(code).not.toMatch(/authorizationService|evaluate\(|resolvePermissions/);
    }
  });

  it('uses `Principal` as a TYPE and never constructs one', () => {
    // A module that could mint a principal would be a way around
    // authentication rather than a way to report on it.
    const service = codeOf('service.ts');
    expect(service).toMatch(/import type \{ Principal \}/);
    expect(service).not.toMatch(/freezePrincipal|createPrincipal|new Principal/);
  });

  it('bypasses no authorization and grants no permission', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/hasPermission|canAccess|allow\(|grant\(|ROLE_PERMISSIONS/);
      expect(code).not.toMatch(/Permission\b|RoleBinding/);
    }
  });

  it('weakens no authentication and touches no crypto', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\.\.\/crypto\//);
      expect(code).not.toMatch(/hashSecret|verifySecret|createHash|hmac|secureToken/i);
    }
  });

  it('bypasses no audit: it projects an event and writes none', () => {
    // `audit.md` requires the record to be written in the ACTION's
    // transaction, which needs a handle this layer deliberately never takes.
    const service = codeOf('service.ts');
    expect(service).toMatch(/toAuditEvent/);
    expect(service).not.toMatch(/AuditWriter|createAuditService|\.record\(tx|Transaction/);
  });

  it('every posture action is a valid audit action, so none can be dropped', () => {
    // If one failed the audit service's shape check, the record would be
    // refused at the door and the action would go unaudited.
    for (const action of Object.values(POSTURE_ACTIONS)) {
      expect(action).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:_[a-z0-9]+)*)+$/);
    }
  });

  it('files posture actions under administration, per T-25', () => {
    const event = toAuditEvent({
      action: POSTURE_ACTIONS.findingAccepted,
      principal: { subjectId: 'u-1' } as never,
      organizationId: 'org-1',
      tenantId: null,
      correlationId: 'c-1',
      targetKind: 'security_finding',
      targetId: 'finding-001',
      reason: 'Accepted with a compensating control.',
    });

    expect(event.category).toBe('administration');
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('offers no remediation anywhere on any surface', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/\b(?:remediate|autofix|repair|patch|enforce\(|block\()\b/i);
    }
  });

  it('the repositories offer no way to edit a finding’s severity', () => {
    // Editing in place is how a Critical quietly becomes a Low before a review.
    const repository = codeOf('repository.ts');
    expect(repository).toMatch(/transitionFinding\(/);
    expect(repository).not.toMatch(/updateFinding|setSeverity|deleteFinding|deletePolicy/);
  });
});

// ── 2 · The threat model is the document's ──────────────────────────────────

describe('the threat model is transcribed, not designed', () => {
  const spec = read('../../contentos-docs/16-security/threat-model.md');

  it('declares exactly the threats the document numbers', () => {
    const declared = (spec.match(/^\*\*T-\d{2} · /gm) ?? []).length;
    expect(THREATS).toHaveLength(declared);
    expect(THREATS).toHaveLength(26);
  });

  it('gives each one the severity the document gives it', () => {
    for (const threat of THREATS) {
      const line = spec.split('\n').find((l) => l.startsWith(`**${threat.id} · `));
      expect(line).toBeDefined();
      expect(line?.toLowerCase()).toContain(`*${threat.severity}*`);
    }
  });

  it('uses the document’s four severities and no others', () => {
    expect(SECURITY_SEVERITIES).toEqual(['critical', 'high', 'medium', 'low']);
    for (const severity of SECURITY_SEVERITIES) {
      expect(spec).toContain(`**${severity[0]?.toUpperCase() ?? ''}${severity.slice(1)}**`);
    }
  });

  it('uses the document’s five section headings as its categories', () => {
    for (const category of SECURITY_CATEGORIES) {
      const heading = category.split('_').join(' ');
      expect(spec.toLowerCase()).toContain(`## ${heading}`);
    }
    expect(SECURITY_CATEGORIES).toHaveLength(5);
  });

  it('refuses a finding or policy against an undeclared threat', () => {
    expect(() => finding({ threatId: 'T-99' })).toThrow(SecurityError);
    expect(() => createSecurityPolicy({ ...policy(), threatIds: ['T-27'] })).toThrow(SecurityError);
  });
});

// ── 3 · It discloses nothing ────────────────────────────────────────────────

describe('a finding cannot carry a disclosure', () => {
  it('refuses an evidence value wide enough for a stack trace', () => {
    // A field that wide eventually holds one, and then holds a secret.
    expect(() =>
      finding({ evidence: { detail: 'x'.repeat(MAX_EVIDENCE_VALUE_LENGTH + 1) } }),
    ).toThrow(SecurityError);
  });

  it('refuses a filesystem path as a component', () => {
    for (const path of ['/var/lib/postgresql', 'C:\\repo\\src', './src/db.ts']) {
      expect(() => finding({ component: path })).toThrow(SecurityError);
    }
  });

  it('refuses a path or URL as a recommendation reference', () => {
    for (const reference of ['/src/rls.ts', 'https://internal.example/wiki']) {
      expect(() =>
        finding({ recommendation: { action: 'Fix.', severity: 'high', reference } }),
      ).toThrow(SecurityError);
    }
  });

  it('has no field a stack trace would fit in', () => {
    const built = finding();
    const keys = Object.keys(built);

    for (const forbidden of ['stack', 'trace', 'query', 'sql', 'headers', 'body', 'raw']) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it('a well-formed finding survives the credential backstop unchanged', () => {
    // Nothing a valid finding can carry looks like a credential — which is the
    // point: the shape rules are what stop one getting in.
    const built = finding();
    expect(scanForCredentials(JSON.stringify(built)).hits).toBe(0);
  });

  it('no error message this module raises carries a stack or a path', () => {
    const messages: string[] = [];
    for (const build of [
      () => finding({ threatId: 'T-99' }),
      () => finding({ severity: 'urgent' }),
      () => finding({ component: '/etc/passwd' }),
      () => createSecurityPolicy({ ...policy(), threatIds: [] }),
    ]) {
      try {
        build();
      } catch (error) {
        messages.push((error as Error).message);
      }
    }

    expect(messages).toHaveLength(4);
    for (const message of messages) {
      expect(message).not.toMatch(/\/[a-z]+\/[a-z]+|[A-Z]:\\|at Object\.|node_modules/);
      expect(scanForCredentials(message).hits).toBe(0);
    }
  });
});

// ── 4 · Nothing added reaches anything ──────────────────────────────────────

describe('the added modules depend on nothing they may not', () => {
  it('write no SQL and import no driver or ORM', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|UPDATE .+ SET |CREATE TABLE/i);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|knex|drizzle|prisma)/);
    }
  });

  it('touch no filesystem and make no HTTP call', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/node:fs|readFileSync|writeFileSync|node:path/);
      expect(code).not.toMatch(/fetch\(|axios|https?:\/\/[a-z]/);
    }
  });

  it('import no SDK, no OpenTelemetry, no Stripe and no AI runtime', () => {
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@opentelemetry|stripe|openai|@anthropic|ioredis|aws-sdk/i);
      expect(code).not.toMatch(/@contentos\/(ai|platform|content|events|database|storage)/);
    }
  });

  it('read no clock, set no timer and hold no global', () => {
    // Every instant arrives with the request; a validator with its own clock
    // could not be asserted on.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/Date\.now\(|new Date\(\)|setTimeout|setInterval|globalThis/);
      expect(code).not.toMatch(/process\.env|Math\.random\(|randomUUID/);
    }
  });

  it('hold no singleton state', () => {
    // A module-level mutable would make two assessments in one process
    // interfere. The only module-level values are frozen vocabularies.
    for (const file of MODULES) {
      const code = codeOf(file);
      expect(code).not.toMatch(/^(?:let|var) /m);
    }
  });

  it('keep the security package dependency-free', () => {
    const manifest = JSON.parse(read('../../packages/security/package.json')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('ship repository interfaces only', () => {
    const repository = codeOf('repository.ts');
    expect(repository).toMatch(/interface SecurityPolicyRepository/);
    expect(repository).toMatch(/interface SecurityFindingRepository/);
    expect(repository).toMatch(/interface SecurityAssessmentRepository/);
    expect(repository).not.toMatch(/^export (?:async )?function/m);
    expect(repository).not.toMatch(/^export const/m);
    expect(repository).not.toMatch(/^export class/m);
  });

  it('are reachable as types from the barrel', () => {
    const policies: SecurityPolicyRepository | null = null;
    const findings: SecurityFindingRepository | null = null;
    const assessments: SecurityAssessmentRepository | null = null;

    expect([policies, findings, assessments]).toEqual([null, null, null]);
  });
});

describe('every exported value is immutable', () => {
  it('freezes the vocabularies', () => {
    expect(Object.isFrozen(THREATS)).toBe(true);
    expect(Object.isFrozen(THREATS[0])).toBe(true);
  });

  it('freezes a policy through', () => {
    const built = policy();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.rules)).toBe(true);
    expect(Object.isFrozen(built.rules[0])).toBe(true);
    expect(Object.isFrozen(built.threatIds)).toBe(true);
  });

  it('freezes a finding through', () => {
    const built = finding();
    expect(Object.isFrozen(built)).toBe(true);
    expect(Object.isFrozen(built.evidence)).toBe(true);
    expect(Object.isFrozen(built.recommendation)).toBe(true);
  });

  it('refuses an edit to a filed finding', () => {
    const built = finding();
    expect(() => {
      (built as { severity: string }).severity = 'low';
    }).toThrow();
  });

  it('every builder validates before it freezes', () => {
    // A frozen invalid record would be permanently wrong.
    expect(() => assertValidFinding({ ...finding(), severity: 'urgent' as 'high' })).toThrow(
      SecurityError,
    );
  });
});

// ── 5 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: this layer reports; every control stays where it was', () => {
    // Authentication, authorization, rate limiting, idempotency, audit and
    // redaction are all canonical and untouched. Nothing here re-implements
    // one, and the structural checks above are how that is kept true.
    expect(read('../../packages/security/src/authz/evaluator.ts')).toContain(
      'export function evaluate',
    );
    expect(read('../../packages/security/src/audit/writer.ts')).toContain(
      'export interface AuditWriter',
    );
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/export function evaluate\b|interface AuditWriter/);
    }
  });

  it('DEVIATION: `SecurityValidation` is functions, not a type', () => {
    // The increment names a `SecurityValidation` model. Validation here is
    // `assertValid*` functions that throw a typed `SecurityError` — the same
    // convention `assertValidAuditEvent` and `assertValidPolicy` already use.
    // A validation RESULT object would be a second error convention in one
    // package, and one a caller can ignore.
    expect(codeOf('policy.ts')).toMatch(/export function assertValidPolicy/);
    expect(codeOf('finding.ts')).toMatch(/export function assertValidFinding/);
    expect(codeOf('assessment.ts')).toMatch(/export function assertValidAssessment/);
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/interface SecurityValidation\b/);
    }
  });

  it('DEVIATION: the scan projection is `ScanResult`, not a service', () => {
    // "Security scan projections" — a scan RUNNER would have to reach the
    // controls to check them, which is the one thing this layer must not do.
    // What it owns is the shape a runner reports in and the fold over it.
    expect(codeOf('assessment.ts')).toMatch(/interface ScanResult/);
    expect(codeOf('assessment.ts')).toMatch(/export function calculateCompliance/);
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/runScan|executeScan|performScan/);
    }
  });

  it('DEVIATION: a finding’s identity is its fingerprint, not its id', () => {
    // `policyId:ruleId:component`, stable across scans. Comparing ids would
    // report every finding as new every night.
    const first = finding({ findingId: 'a-1' });
    const second = finding({ findingId: 'a-2' });

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.findingId).not.toBe(second.findingId);
  });

  it('DEVIATION: `not_applicable` is excluded from compliance, not counted', () => {
    // Counting it as a pass would let a deployment reach 100% by not having the
    // features the rules are about.
    expect(codeOf('assessment.ts')).toMatch(/outcome !== 'not_applicable'/);
  });

  it('DEVIATION: `SecurityError` is a new taxonomy, per the one-per-module rule', () => {
    // `AuthorizationError`, `AuditValidationError`, `HoldError` and
    // `BillingError` each belong to one module. `DenyReason` gaining
    // `InvalidSeverity` would make the authorization taxonomy describe things
    // authorization knows nothing about.
    expect(new SecurityError('InvalidSeverity', 'x', 'y').name).toBe('SecurityError');
    expect(codeOf('errors.ts')).toMatch(/class SecurityError extends Error/);
    for (const file of MODULES.filter((f) => f !== 'errors.ts')) {
      expect(codeOf(file)).not.toMatch(/class \w*Error extends/);
    }
  });

  it('DEVIATION: no seeded policy catalogue', () => {
    // A built-in set of policies would be this increment asserting which
    // controls the platform has, which is what an ASSESSMENT establishes.
    for (const file of MODULES) {
      expect(codeOf(file)).not.toMatch(/BUILT_IN_POLICIES|DEFAULT_POLICIES|POLICY_CATALOGUE/);
    }
  });
});
