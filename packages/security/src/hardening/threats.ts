/**
 * The threat model, as data — `16-security/threat-model.md`.
 *
 * ── Transcribed, not designed ──────────────────────────────────────────────
 * Twenty-six threats, four severities and five categories, taken from that
 * document verbatim. Nothing here is invented: a twenty-seventh threat or a
 * fifth severity is a decision that document has to make first, because the
 * severity table drives the response time and the review cadence.
 *
 * ── Why the model needs to exist in code at all ────────────────────────────
 * Every mitigation in the platform cites a threat by number — RLS cites T-06,
 * the SafeUrlFetcher cites T-13, the credential backstop cites T-19. Those
 * citations are comments, so nothing can answer "which threats have no
 * recorded control" or "is this finding one we already knew about". A finding
 * that names a threat nobody declared is a finding nobody can triage.
 *
 * ── It observes. It enforces nothing ───────────────────────────────────────
 * Nothing here authenticates, authorizes, rate limits or blocks. The controls
 * are where they always were — `authz/evaluator.ts`, `ratelimit/`, RLS, the
 * redaction backstop. This is the vocabulary for REPORTING on them, and a
 * module that could weaken one would be the vulnerability it exists to find.
 */

/**
 * The four severities of `threat-model.md` §"Severity model".
 *
 * Ordered worst-first, which is the order a triage queue is read in and the
 * order `worstOf` below depends on.
 */
export const SECURITY_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

export type SecuritySeverity = (typeof SECURITY_SEVERITIES)[number];

export function isSecuritySeverity(value: unknown): value is SecuritySeverity {
  return typeof value === 'string' && (SECURITY_SEVERITIES as readonly string[]).includes(value);
}

/**
 * What each severity MEANS, from the document's own table.
 *
 * Carried because a severity with no definition becomes whatever the person
 * filing the finding felt at the time, and the response time attached to it
 * stops meaning anything.
 */
export const SEVERITY_DEFINITIONS: Readonly<Record<SecuritySeverity, string>> = Object.freeze({
  critical: 'Cross-tenant data exposure, audit compromise, or platform-wide credential loss',
  high: 'Single-tenant data exposure, privilege escalation, or service-wide outage',
  medium: 'Degraded service, limited disclosure, or abuse requiring valid credentials',
  low: 'Nuisance, cost impact, or requiring implausible preconditions',
});

/** How bad, as a number. Lower is worse — index into `SECURITY_SEVERITIES`. */
export function severityRank(severity: SecuritySeverity): number {
  return SECURITY_SEVERITIES.indexOf(severity);
}

/** The worst of a set, or null when the set is empty. */
export function worstOf(severities: readonly SecuritySeverity[]): SecuritySeverity | null {
  let worst: SecuritySeverity | null = null;
  for (const severity of severities) {
    if (worst === null || severityRank(severity) < severityRank(worst)) worst = severity;
  }
  return worst;
}

/**
 * The five sections of `threat-model.md`, as slugs.
 *
 * The document groups its threats under these headings and nothing else; a
 * category outside them would be a threat the document has not placed.
 */
export const SECURITY_CATEGORIES = [
  'identity_and_access',
  'tenant_isolation',
  'application_surface',
  'platform_and_infrastructure',
  'abuse_and_availability',
] as const;

export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];

export function isSecurityCategory(value: unknown): value is SecurityCategory {
  return typeof value === 'string' && (SECURITY_CATEGORIES as readonly string[]).includes(value);
}

/** `T-01` … `T-26`. The document's own identifiers, and the only valid ones. */
export type ThreatId = string;

export interface Threat {
  readonly id: ThreatId;
  readonly title: string;
  readonly severity: SecuritySeverity;
  readonly category: SecurityCategory;
}

/**
 * Every threat the document declares, in its order.
 *
 * The severity here is the threat's INHERENT severity — what it would mean if
 * unmitigated. A finding against it carries its own severity, which may be
 * lower because a control is partially in place; `threat-model.md` classifies
 * rate-limit bypass Medium rather than High for exactly that reason, because
 * credit accounting caps spend regardless of request count.
 */
export const THREATS: readonly Threat[] = Object.freeze(
  (
    [
      { id: 'T-01', title: 'Identity spoofing', severity: 'high', category: 'identity_and_access' },
      {
        id: 'T-02',
        title: 'Authentication bypass',
        severity: 'critical',
        category: 'identity_and_access',
      },
      { id: 'T-03', title: 'Credential theft', severity: 'high', category: 'identity_and_access' },
      {
        id: 'T-04',
        title: 'Privilege escalation',
        severity: 'critical',
        category: 'identity_and_access',
      },
      {
        id: 'T-05',
        title: 'Authorization bypass (IDOR)',
        severity: 'critical',
        category: 'identity_and_access',
      },
      {
        id: 'T-06',
        title: 'Cross-tenant data leakage',
        severity: 'critical',
        category: 'tenant_isolation',
      },
      {
        id: 'T-07',
        title: 'Vector search leakage',
        severity: 'high',
        category: 'tenant_isolation',
      },
      { id: 'T-08', title: 'Cache poisoning', severity: 'high', category: 'tenant_isolation' },
      { id: 'T-09', title: 'Storage compromise', severity: 'high', category: 'tenant_isolation' },
      { id: 'T-10', title: 'SQL injection', severity: 'critical', category: 'application_surface' },
      { id: 'T-11', title: 'XSS', severity: 'high', category: 'application_surface' },
      { id: 'T-12', title: 'CSRF', severity: 'medium', category: 'application_surface' },
      { id: 'T-13', title: 'SSRF', severity: 'critical', category: 'application_surface' },
      { id: 'T-14', title: 'Prompt injection', severity: 'high', category: 'application_surface' },
      { id: 'T-15', title: 'Model abuse', severity: 'medium', category: 'application_surface' },
      {
        id: 'T-16',
        title: 'Event poisoning',
        severity: 'high',
        category: 'platform_and_infrastructure',
      },
      {
        id: 'T-17',
        title: 'Replay attacks',
        severity: 'high',
        category: 'platform_and_infrastructure',
      },
      {
        id: 'T-18',
        title: 'Replay abuse (platform)',
        severity: 'high',
        category: 'platform_and_infrastructure',
      },
      {
        id: 'T-19',
        title: 'Secrets leakage',
        severity: 'critical',
        category: 'platform_and_infrastructure',
      },
      {
        id: 'T-20',
        title: 'Key compromise',
        severity: 'critical',
        category: 'platform_and_infrastructure',
      },
      {
        id: 'T-21',
        title: 'Supply-chain compromise',
        severity: 'critical',
        category: 'platform_and_infrastructure',
      },
      {
        id: 'T-22',
        title: 'Dependency compromise',
        severity: 'high',
        category: 'platform_and_infrastructure',
      },
      {
        id: 'T-23',
        title: 'Denial of service',
        severity: 'medium',
        category: 'abuse_and_availability',
      },
      {
        id: 'T-24',
        title: 'Rate-limit bypass',
        severity: 'medium',
        category: 'abuse_and_availability',
      },
      { id: 'T-25', title: 'Insider threat', severity: 'high', category: 'abuse_and_availability' },
      {
        id: 'T-26',
        title: 'Business logic abuse',
        severity: 'medium',
        category: 'abuse_and_availability',
      },
    ] satisfies readonly Threat[]
  ).map((threat) => Object.freeze(threat)),
);

const BY_ID: ReadonlyMap<ThreatId, Threat> = new Map(THREATS.map((t) => [t.id, t]));

/** `T-` followed by two digits. The document's format, and nothing else. */
const THREAT_ID_SHAPE = /^T-\d{2}$/;

export function isThreatIdShape(value: unknown): boolean {
  return typeof value === 'string' && THREAT_ID_SHAPE.test(value);
}

/**
 * Is this a threat the document actually declares?
 *
 * A plain boolean, deliberately NOT a type predicate: `ThreatId` is an alias
 * for `string`, so narrowing to it buys nothing and narrows the negative branch
 * to `never` — which then makes the refusal message unwritable.
 */
export function isKnownThreat(value: unknown): boolean {
  return typeof value === 'string' && BY_ID.has(value);
}

/** The threat, or null. Null is not an error here — the caller decides. */
export function threatOf(id: ThreatId): Threat | null {
  return BY_ID.get(id) ?? null;
}

/** Every threat in one category. For a report that walks the model. */
export function threatsIn(category: SecurityCategory): readonly Threat[] {
  return Object.freeze(THREATS.filter((threat) => threat.category === category));
}
