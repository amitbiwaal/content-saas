/**
 * The operational-logging and audit layer against the two systems it joins.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. TWO STREAMS, NEVER ONE. `audit.md` §"Three distinct streams": the most
 *    common failure is treating these as one system with different verbosity.
 *    The models live in different packages, share no field that would let them
 *    merge, and neither imports the other.
 *
 * 2. ONE OF EACH. One logger, one audit writer, one hash chain, one redaction
 *    scanner. This increment added the read half and a validating front door,
 *    not a second of anything.
 *
 * 3. THE SECURITY PACKAGE STILL DEPENDS ON NOTHING. It is imported by every
 *    layer, so a dependency here is a dependency everywhere.
 *
 * 4. NO SQL, NO DRIVER, NO CLOCK, NO HTTP in anything added.
 *
 * 5. THE DEVIATIONS, recorded so they cannot be forgotten.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { LOG_RECORD_FIELDS, REDACTED, scanForCredentials } from '@contentos/observability';
import {
  assertValidAuditEvent,
  AUDIT_CATEGORIES,
  AuditValidationError,
  CATEGORY_METADATA_KEY,
  createAuditService,
  freezeAuditRecord,
  hashAuditRecord,
  isAuditActionShape,
  toNewAuditRecord,
  verifyChainLink,
  type AuditEvent,
  type AuditReader,
  type AuditRecord,
  type CredentialScanner,
} from '@contentos/security';
import { describe, expect, it } from 'vitest';

const auditDir = new URL('../../packages/security/src/audit/', import.meta.url);

const codeOf = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, auditDir)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** The modules this increment added. */
const ADDED = ['model.ts', 'reader.ts', 'service.ts'] as const;

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  category: 'authorization',
  action: 'organization.membership.role_changed',
  tenantId: '018f7a1e-0000-7000-8000-0000000000bb',
  organizationId: ORG,
  actor: { id: '018f7a1e-0000-7000-8000-000000000001', kind: 'user' },
  correlationId: '018f7a1e-0000-7000-8000-0000000000dd',
  target: { kind: 'organization_membership', id: 'mem-1', tenantId: null },
  result: 'denied',
  reason: 'Not an owner.',
  ipAddress: null,
  userAgent: null,
  sessionId: null,
  stepUpSatisfied: false,
  ...overrides,
});

// ── 1 · Two streams, never one ──────────────────────────────────────────────

describe('operational logs and audit records are different systems', () => {
  it('live in different packages', () => {
    // Operational logs are `@contentos/observability`; audit is
    // `@contentos/security`. Neither package reaches into the other.
    for (const file of ADDED) {
      expect(codeOf(file)).not.toMatch(/@contentos\/observability/);
    }
    expect(read('../../packages/observability/src/index.ts')).not.toContain('@contentos/security');
  });

  it('share no field that would let one be mistaken for the other', () => {
    // An audit record has no severity: it answers "who did what, to what, with
    // what result", not "what happened in the code".
    const record = toNewAuditRecord(event());
    const keys = Object.keys(record);

    for (const logOnly of ['level', 'event', 'service', 'version', 'durationMs']) {
      expect(keys).not.toContain(logOnly);
    }
    // And a log record has no chain, no target and no actor kind.
    for (const auditOnly of ['hash', 'previousHash', 'target', 'actorKind', 'result']) {
      expect(LOG_RECORD_FIELDS as readonly string[]).not.toContain(auditOnly);
    }
  });

  it('the audit model imports nothing from the logger', () => {
    for (const file of ADDED) {
      const code = codeOf(file);
      expect(code).not.toMatch(/LogRecord|LogLevel|Logger\b|createLogger/);
    }
  });

  it('audit throws where logging drops', () => {
    // "A failed audit write fails the action" — the one place the platform
    // prefers unavailability to incompleteness. A log sink that throws is
    // caught and the request continues.
    expect(() => assertValidAuditEvent(event({ action: 'nope' }))).toThrow(AuditValidationError);
    expect(codeOf('service.ts')).not.toMatch(/onDeliveryFailure|catch\s*\(/);
  });

  it('the spec’s three-stream table is still what this follows', () => {
    const spec = read('../../contentos-docs/16-security/audit.md');
    expect(spec).toContain('Three distinct streams');
    expect(spec.toLowerCase()).toContain('the most common failure is treating these as one system');
  });
});

// ── 2 · One of each ─────────────────────────────────────────────────────────

describe('the increment added the missing half, not a second system', () => {
  it('declares no second audit record, target or context', () => {
    // `AuditRecord`, `AuditTarget`, `AuditContext` are in `writer.ts` and stay.
    for (const file of ADDED) {
      const code = codeOf(file);
      expect(code).not.toMatch(/interface AuditRecord\b|interface AuditTarget\b/);
      expect(code).not.toMatch(/interface AuditContext\b|type AuditResult\b|type AuditActorKind\b/);
    }
  });

  it('declares no second writer and no second chain', () => {
    for (const file of ADDED) {
      const code = codeOf(file);
      expect(code).not.toMatch(/INSERT INTO|hashAuditRecord|createHash|GENESIS_HASH/);
      // `ChainVerification.headHash` is a REPORT field the spec names; what
      // must not appear is a head being computed or advanced here.
      expect(code).not.toMatch(/(?:previousHash|headHash|#head\w*)\s*=[^=]/);
    }
  });

  it('the service delegates the write to the frozen writer', () => {
    const service = codeOf('service.ts');
    expect(service).toMatch(/writer\.record\(/);
    expect(service).toMatch(/import type \{[^}]*AuditWriter/);
  });

  it('the reader offers no write, no update and no delete', () => {
    // "The interface offers no path to mutation, so a caller cannot reach for
    // one." Nor a write: `AuditWriter` is the only way in.
    const reader = codeOf('reader.ts');
    expect(reader).toMatch(/interface AuditReader/);
    expect(reader).not.toMatch(/record\(|insert|update|delete|write\(/i);
  });

  it('the reader ships no implementation', () => {
    const reader = codeOf('reader.ts');
    expect(reader).not.toMatch(/^export (?:async )?function/m);
    expect(reader).not.toMatch(/^export const/m);
    expect(reader).not.toMatch(/^export class/m);
  });

  it('its four methods are the ones audit.md names', () => {
    const reader = codeOf('reader.ts');
    for (const method of ['query(', 'timeline(', 'verifyChain(', 'export(']) {
      expect(reader).toContain(method);
    }
    expect(read('../../contentos-docs/16-security/audit.md')).toContain('interface AuditReader');
  });

  it('is reachable as a type from the barrel', () => {
    const reader: AuditReader | null = null;
    expect(reader).toBeNull();
  });

  it('there is one redaction scanner, and it is the existing one', () => {
    // The service takes it as a port rather than reimplementing it.
    expect(codeOf('service.ts')).toMatch(/interface CredentialScanner/);
    for (const file of ADDED) {
      expect(codeOf(file)).not.toMatch(/CREDENTIAL_PATTERNS|\/\\bBearer|RegExp\(/);
    }
  });
});

// ── 3 · Security still depends on nothing ───────────────────────────────────

describe('the security package stays dependency-free', () => {
  it('declares no dependencies at all', () => {
    // It is imported by every layer, so a dependency here is a dependency
    // everywhere. That is why the scanner is injected.
    const manifest = JSON.parse(read('../../packages/security/package.json')) as {
      dependencies?: Record<string, string>;
    };

    expect(manifest.dependencies ?? {}).toEqual({});
  });

  it('and the scanner the service takes is the observability one’s shape', () => {
    // Assigned, not adapted: if this needed a wrapper, the port would be a
    // second redaction system.
    const scanner: CredentialScanner = scanForCredentials;
    expect(scanner('nothing to find').hits).toBe(0);
  });
});

// ── 4 · Nothing added reaches anything ──────────────────────────────────────

describe('the added modules depend on nothing they may not', () => {
  it('write no SQL and import no driver', () => {
    for (const file of ADDED) {
      const code = codeOf(file);
      expect(code).not.toMatch(/SELECT .+ FROM |INSERT INTO|UPDATE .+ SET |CREATE TABLE/i);
      expect(code).not.toMatch(/from '(pg|postgres|mysql2|knex|drizzle|prisma)/);
    }
  });

  it('read no clock and generate no id', () => {
    // The writer stamps the timestamp from the SERVER clock and assigns the id.
    // A second clock here would put two instants on one record.
    for (const file of ADDED) {
      expect(codeOf(file)).not.toMatch(/Date\.now\(|new Date\(|Math\.random\(|randomUUID|secureId/);
    }
  });

  it('make no HTTP call and touch no filesystem', () => {
    for (const file of ADDED) {
      const code = codeOf(file);
      expect(code).not.toMatch(/fetch\(|axios|https?:\/\/[a-z]/);
      expect(code).not.toMatch(/node:fs|readFileSync|writeFileSync/);
    }
  });

  it('import no feature package and no SDK', () => {
    for (const file of ADDED) {
      const code = codeOf(file);
      expect(code).not.toMatch(/@contentos\/(platform|ai|content|events|database|storage)/);
      expect(code).not.toMatch(/stripe|openai|@anthropic|ioredis/i);
    }
  });

  it('hold no global and no timer', () => {
    for (const file of ADDED) {
      const code = codeOf(file);
      expect(code).not.toMatch(/setInterval|setTimeout|globalThis|process\.env/);
    }
  });

  it('run no business logic and take no authorization decision', () => {
    for (const file of ADDED) {
      const code = codeOf(file);
      expect(code).not.toMatch(/hasPermission|authorize\(|canAccess|evaluatePolicy|ROLE_/);
      // `provider_configuration` and `billing` are two of the thirteen
      // CATEGORIES the spec names — the check is for calls into those systems,
      // not for the vocabulary that files a record under one.
      expect(code).not.toMatch(
        /(?:runWorkflow|orchestrat\w*\(|providerClient|chargeCard|appendEntry|ledger\.)/i,
      );
    }
  });
});

// ── 5 · Redaction covers what the increment names ───────────────────────────

describe('the credential backstop catches every named shape', () => {
  const caught = (value: string): boolean => scanForCredentials(value).hits > 0;

  it('catches what it always did', () => {
    expect(caught('Authorization: Bearer abcdefghijklmnopqrst')).toBe(true);
    expect(caught('key sk-abcdefghijklmnopqrstuv')).toBe(true);
    expect(caught('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijkl')).toBe(true);
    expect(caught('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(caught('postgres://user:hunter2@db:5432/app')).toBe(true);
  });

  it('now catches a Stripe secret, which the OpenAI pattern missed', () => {
    // `sk-` is hyphenated and every Stripe secret is underscored. One character
    // apart, and a live key in a log is a full account compromise.
    expect(caught('sk_live_abcdefghijklmnop1234')).toBe(true); // gitleaks:allow — fixture: the test asserts this is redacted
    expect(caught('rk_test_abcdefghijklmnop1234')).toBe(true); // gitleaks:allow — fixture: the test asserts this is redacted
    expect(caught('whsec_abcdefghijklmnop1234')).toBe(true);
  });

  it('now catches a named password or key field', () => {
    for (const value of [
      'password=hunter2secret',
      '"client_secret": "abcdef123456"', // gitleaks:allow — fixture: the test asserts this is redacted
      'api_key: abcdef123456', // gitleaks:allow — fixture: the test asserts this is redacted
      'refresh_token=abcdef123456', // gitleaks:allow — fixture: the test asserts this is redacted
    ]) {
      expect(caught(value)).toBe(true);
    }
  });

  it('keeps the field name and replaces only the value', () => {
    // "Which field carried a secret" is the diagnostic; blanking the whole
    // match would hide it.
    const scanned = scanForCredentials('password=hunter2secret');
    expect(scanned.value).toContain('password');
    expect(scanned.value).toContain(REDACTED);
    expect(scanned.value).not.toContain('hunter2secret');
  });

  it('now catches a cookie header, whole', () => {
    // A session cookie IS the session, so redacting selectively would leave the
    // one that mattered.
    const scanned = scanForCredentials('Cookie: session=abc123; theme=dark');
    expect(scanned.hits).toBeGreaterThan(0);
    expect(scanned.value).not.toContain('abc123');
  });

  it('now catches a card number', () => {
    // `billing.md`: "No card data ever enters this system." This is the
    // backstop for when it does anyway.
    expect(caught('4111111111111111')).toBe(true);
    expect(caught('4111 1111 1111 1111')).toBe(true);
    expect(caught('5500-0000-0000-0004')).toBe(true);
  });

  it('is idempotent — re-scanning does not inflate a counter that is paged on', () => {
    const once = scanForCredentials('password=hunter2secret');
    expect(scanForCredentials(once.value).hits).toBe(0);
  });

  it('leaves an ordinary message alone', () => {
    expect(caught('Workspace ws-1 was suspended by the owner.')).toBe(false);
    expect(caught('Run completed in 4200 ms')).toBe(false);
  });
});

// ── 6 · Deviations ──────────────────────────────────────────────────────────

describe('recorded deviations', () => {
  it('DEVIATION: the read port is `AuditReader`, not `AuditRepository`', () => {
    // `audit.md` §Interfaces names it, and the name is precise: `AuditWriter`
    // is beside it, and calling this one a repository would invite somebody to
    // add a write and create a second write path.
    expect(codeOf('reader.ts')).toMatch(/interface AuditReader/);
    expect(codeOf('reader.ts')).not.toMatch(/interface AuditRepository/);
  });

  it('DEVIATION: `AuditRecord` and friends keep their names', () => {
    // The increment names `AuditRecord`, `AuditContext`, `AuditTarget` — all
    // three already exist in `writer.ts`, in the hash preimage and in a table
    // with a seven-year retention. Renaming them would be a second vocabulary
    // for records that already exist.
    const writer = codeOf('writer.ts');
    for (const existing of ['AuditRecord', 'AuditTarget', 'AuditContext', 'AuditActorKind']) {
      expect(writer).toContain(existing);
    }
  });

  it('DEVIATION: `OperationalLog` is `LogRecord`, and stays there', () => {
    // The operational log model is `@contentos/observability`'s `LogRecord`,
    // canonical since S6.1. A type of that name here would be a second name for
    // one model, and the two streams would start to look like one system.
    for (const file of ADDED) {
      expect(codeOf(file)).not.toMatch(/OperationalLog\b/);
    }
    expect(LOG_RECORD_FIELDS.length).toBeGreaterThan(0);
  });

  it('DEVIATION: `OperationalLogger` is `Logger`, and stays there', () => {
    expect(read('../../packages/observability/src/logging/logger.ts')).toContain(
      'export interface Logger',
    );
    for (const file of ADDED) {
      expect(codeOf(file)).not.toMatch(/interface (?:OperationalLogger|AuditLogger)/);
    }
  });

  it('DEVIATION: `action` is validated by SHAPE, not by an enumeration', () => {
    // The spec says enumerated, and gives the reason: `role_change` and
    // `Changed role` are the same event under names no query finds together.
    // The shape refuses both while accepting every action already declared —
    // an enumeration would reject the next module's until somebody edited it.
    expect(isAuditActionShape('user.role.changed')).toBe(true);
    expect(isAuditActionShape('role_change')).toBe(false);
    expect(isAuditActionShape('Changed role')).toBe(false);
  });

  it('DEVIATION: the category rides in `detail`, outside the hash preimage', () => {
    // No schema change, and it cannot invalidate an existing chain:
    // `hashAuditRecord` covers `stepUpSatisfied` only.
    const base: Omit<AuditRecord, 'hash'> = {
      auditId: 'a-1',
      tenantId: null,
      organizationId: ORG,
      actorId: 'u-1',
      actorKind: 'user',
      correlationId: 'c-1',
      timestamp: new Date('2026-03-01T00:00:00.000Z'),
      action: 'organization.created',
      target: { kind: 'organization', id: ORG, tenantId: null },
      result: 'success',
      reason: 'Provisioned.',
      context: { ipAddress: null, userAgent: null, sessionId: null, stepUpSatisfied: false },
      previousHash: '0'.repeat(64),
    };
    const categorised = {
      ...base,
      context: { ...base.context, detail: { [CATEGORY_METADATA_KEY]: 'administration' } },
    };

    expect(hashAuditRecord(categorised)).toBe(hashAuditRecord(base));
    expect(verifyChainLink({ ...categorised, hash: hashAuditRecord(base) })).toBe(true);
  });

  it('DEVIATION: the thirteen categories are transcribed, not invented', () => {
    const spec = read('../../contentos-docs/16-security/audit.md');
    for (const category of AUDIT_CATEGORIES) {
      // The spec's table uses title case with spaces; ours is the slug.
      const words = category.split('_').join(' ');
      expect(spec.toLowerCase()).toContain(words);
    }
  });

  it('DEVIATION: the scanner is injected rather than imported', () => {
    // `packages/security` depends on nothing and that is worth keeping.
    // Composing no scanner is visible rather than defaulted to a no-op.
    const service = createAuditService({
      writer: { record: () => Promise.resolve('a-1') },
    });
    expect(typeof service.record).toBe('function');
  });

  it('DEVIATION: a frozen record wraps the record rather than replacing it', () => {
    // Nothing is recomputed and no hash is re-derived: a projection that
    // rebuilt the hash would report a tampered record as valid.
    const record: AuditRecord = {
      auditId: 'a-1',
      tenantId: null,
      organizationId: ORG,
      actorId: 'u-1',
      actorKind: 'user',
      correlationId: 'c-1',
      timestamp: new Date('2026-03-01T00:00:00.000Z'),
      action: 'organization.created',
      target: { kind: 'organization', id: ORG, tenantId: null },
      result: 'success',
      reason: 'Provisioned.',
      context: { ipAddress: null, userAgent: null, sessionId: null, stepUpSatisfied: false },
      previousHash: '0'.repeat(64),
      hash: 'deadbeef'.repeat(8),
    };
    const frozen = freezeAuditRecord(record);

    expect(frozen.record.hash).toBe('deadbeef'.repeat(8));
    expect(Object.isFrozen(frozen.record)).toBe(true);
  });
});
