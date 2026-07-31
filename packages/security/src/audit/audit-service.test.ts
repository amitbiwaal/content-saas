import { describe, expect, it } from 'vitest';

import {
  assertValidAuditEvent,
  assertValidMetadata,
  assertValidTimestamp,
  AUDIT_CATEGORIES,
  AuditValidationError,
  CATEGORY_METADATA_KEY,
  categoryOf,
  isAuditActionShape,
  isAuditCategory,
  MAX_METADATA_KEYS,
  MAX_METADATA_VALUE_LENGTH,
  toNewAuditRecord,
  type AuditEvent,
  type AuditValidationCode,
} from './model.js';
import { createAuditService, freezeAuditRecord, type CredentialScanner } from './service.js';
import {
  GENESIS_HASH,
  hashAuditRecord,
  type AuditRecord,
  type AuditWriter,
  type NewAuditRecord,
  type Transaction,
} from './writer.js';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const TENANT = '018f7a1e-0000-7000-8000-0000000000bb';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const tx: Transaction = { query: () => Promise.resolve([]) };

const event = (overrides: Partial<AuditEvent> = {}): AuditEvent => ({
  category: 'authorization',
  action: 'organization.membership.role_changed',
  tenantId: TENANT,
  organizationId: ORG,
  actor: { id: ACTOR, kind: 'user' },
  correlationId: CORRELATION,
  target: { kind: 'organization_membership', id: 'mem-1', tenantId: TENANT },
  result: 'success',
  reason: 'Promoted by the owner.',
  ipAddress: '198.51.100.4',
  userAgent: 'Mozilla/5.0',
  sessionId: 'sess-1',
  stepUpSatisfied: true,
  ...overrides,
});

/** A writer that records what it was handed. Nothing else is faked. */
function recordingWriter(): { writer: AuditWriter; written: NewAuditRecord[] } {
  const written: NewAuditRecord[] = [];
  return {
    written,
    writer: {
      record(_tx, entry) {
        written.push(entry);
        return Promise.resolve('audit-1');
      },
    },
  };
}

const codeOf = (call: () => unknown): AuditValidationCode | null => {
  try {
    call();
    return null;
  } catch (error) {
    if (error instanceof AuditValidationError) return error.code;
    throw error;
  }
};

// ── The vocabulary ──────────────────────────────────────────────────────────

describe('audit categories', () => {
  it('are the thirteen audit.md names', () => {
    expect(AUDIT_CATEGORIES).toEqual([
      'authentication',
      'authorization',
      'permission_changes',
      'role_assignments',
      'workspace_lifecycle',
      'secret_access',
      'replay_execution',
      'dlq_intervention',
      'provider_configuration',
      'billing',
      'exports',
      'deletion',
      'administration',
    ]);
  });

  it('reject anything else', () => {
    expect(isAuditCategory('security')).toBe(false);
    expect(isAuditCategory('Authentication')).toBe(false);
    expect(isAuditCategory(null)).toBe(false);
  });
});

describe('the action shape', () => {
  it('accepts every action the codebase already declares', () => {
    for (const action of [
      'organization.membership.role_changed',
      'workspace.membership.invitation_revoked',
      'credits.adjusted',
      'ai.job.cancelled',
      'notification.delivery_failed',
      'organization.closure_requested',
    ]) {
      expect(isAuditActionShape(action)).toBe(true);
    }
  });

  it('refuses all three of the spec’s examples of drift', () => {
    // "user.role.changed", "role_change" and "Changed role" all appear within a
    // year and no audit query finds all three.
    expect(isAuditActionShape('user.role.changed')).toBe(true);
    expect(isAuditActionShape('role_change')).toBe(false);
    expect(isAuditActionShape('Changed role')).toBe(false);
  });

  it('refuses a single segment', () => {
    // A bare `create` says nothing about what was created.
    expect(isAuditActionShape('create')).toBe(false);
    expect(isAuditActionShape('delete')).toBe(false);
  });

  it('refuses uppercase, spaces and punctuation', () => {
    expect(isAuditActionShape('Organization.Created')).toBe(false);
    expect(isAuditActionShape('organization created')).toBe(false);
    expect(isAuditActionShape('organization-created')).toBe(false);
    expect(isAuditActionShape('organization..created')).toBe(false);
    expect(isAuditActionShape('')).toBe(false);
    expect(isAuditActionShape(null)).toBe(false);
  });
});

// ── Validation ──────────────────────────────────────────────────────────────

describe('assertValidAuditEvent', () => {
  it('accepts a well-formed event', () => {
    expect(codeOf(() => assertValidAuditEvent(event()))).toBeNull();
  });

  it('refuses an unknown category', () => {
    expect(codeOf(() => assertValidAuditEvent(event({ category: 'security' as 'billing' })))).toBe(
      'InvalidCategory',
    );
  });

  it('refuses a free-text action', () => {
    expect(codeOf(() => assertValidAuditEvent(event({ action: 'Changed role' })))).toBe(
      'InvalidAction',
    );
  });

  it('refuses an unknown result', () => {
    expect(codeOf(() => assertValidAuditEvent(event({ result: 'ok' as 'success' })))).toBe(
      'InvalidResult',
    );
  });

  it('refuses an unknown actor kind', () => {
    expect(
      codeOf(() =>
        assertValidAuditEvent(event({ actor: { id: ACTOR, kind: 'robot' as 'service' } })),
      ),
    ).toBe('InvalidActorKind');
  });

  it('refuses an empty reason, even on success', () => {
    // A successful privileged action needs a recorded justification as much as
    // a denial does.
    expect(codeOf(() => assertValidAuditEvent(event({ reason: '' })))).toBe('MissingIdentifier');
    expect(codeOf(() => assertValidAuditEvent(event({ reason: '   ' })))).toBe('MissingIdentifier');
  });

  it('refuses a missing organization, correlation, actor or target', () => {
    expect(codeOf(() => assertValidAuditEvent(event({ organizationId: '' })))).toBe(
      'MissingIdentifier',
    );
    expect(codeOf(() => assertValidAuditEvent(event({ correlationId: '' })))).toBe(
      'MissingIdentifier',
    );
    expect(codeOf(() => assertValidAuditEvent(event({ actor: { id: '', kind: 'user' } })))).toBe(
      'MissingIdentifier',
    );
    expect(
      codeOf(() => assertValidAuditEvent(event({ target: { kind: '', id: 'x', tenantId: null } }))),
    ).toBe('MissingIdentifier');
  });

  it('permits a null tenant, for pre-tenant actions', () => {
    // Authentication and membership resolution happen before tenant context.
    expect(codeOf(() => assertValidAuditEvent(event({ tenantId: null })))).toBeNull();
  });

  it('refuses a non-boolean step-up flag', () => {
    // It is inside the hash preimage; a coerced value would change the chain.
    expect(
      codeOf(() => assertValidAuditEvent(event({ stepUpSatisfied: 'yes' as unknown as boolean }))),
    ).toBe('MalformedMetadata');
  });

  it('checks identity before the enumerations', () => {
    // A submission with no organization is refused before anybody looks at
    // whether its category is spelled right.
    expect(
      codeOf(() =>
        assertValidAuditEvent(event({ organizationId: '', category: 'nope' as 'billing' })),
      ),
    ).toBe('MissingIdentifier');
  });
});

describe('assertValidMetadata', () => {
  it('accepts enumerated string detail', () => {
    expect(codeOf(() => assertValidMetadata({ previous_status: 'active' }))).toBeNull();
  });

  it('refuses a non-string value', () => {
    // A value that arrives as 1 and "1" on different days cannot be filtered on
    // either.
    expect(codeOf(() => assertValidMetadata({ count: 3 as unknown as string }))).toBe(
      'MalformedMetadata',
    );
  });

  it('refuses a nested object', () => {
    expect(codeOf(() => assertValidMetadata({ nested: {} as unknown as string }))).toBe(
      'MalformedMetadata',
    );
  });

  it('refuses a key nobody can predict', () => {
    for (const key of ['Previous Status', 'previous.status', 'PREVIOUS', '1st']) {
      expect(codeOf(() => assertValidMetadata({ [key]: 'x' }))).toBe('MalformedMetadata');
    }
  });

  it('refuses more keys than the limit', () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i <= MAX_METADATA_KEYS; i += 1) wide[`key_${String(i)}`] = 'x';

    expect(codeOf(() => assertValidMetadata(wide))).toBe('MalformedMetadata');
  });

  it('refuses a value longer than the limit', () => {
    expect(
      codeOf(() => assertValidMetadata({ detail: 'x'.repeat(MAX_METADATA_VALUE_LENGTH + 1) })),
    ).toBe('MalformedMetadata');
  });

  it('accepts one exactly at the limit', () => {
    expect(
      codeOf(() => assertValidMetadata({ detail: 'x'.repeat(MAX_METADATA_VALUE_LENGTH) })),
    ).toBeNull();
  });

  it('names the offending key', () => {
    let field = '';
    try {
      assertValidMetadata({ bad_key: 3 as unknown as string });
    } catch (error) {
      field = (error as AuditValidationError).field;
    }
    expect(field).toBe('metadata.bad_key');
  });
});

describe('assertValidTimestamp', () => {
  it('accepts a UTC ISO instant', () => {
    expect(assertValidTimestamp('2026-03-01T00:00:00.000Z', 'from')).toBe(
      '2026-03-01T00:00:00.000Z',
    );
    expect(assertValidTimestamp('2026-03-01T00:00:00Z', 'from')).toBe('2026-03-01T00:00:00Z');
  });

  it('refuses a local-time string', () => {
    // It names a different moment depending on where it is read, and a record
    // in the wrong retention window is deleted early or kept illegally.
    expect(codeOf(() => assertValidTimestamp('2026-03-01T00:00:00', 'from'))).toBe(
      'InvalidTimestamp',
    );
  });

  it('refuses a date with no time, a non-date and a non-string', () => {
    expect(codeOf(() => assertValidTimestamp('2026-03-01', 'from'))).toBe('InvalidTimestamp');
    expect(codeOf(() => assertValidTimestamp('2026-13-45T00:00:00.000Z', 'from'))).toBe(
      'InvalidTimestamp',
    );
    expect(codeOf(() => assertValidTimestamp(Date.now(), 'from'))).toBe('InvalidTimestamp');
    expect(codeOf(() => assertValidTimestamp(null, 'from'))).toBe('InvalidTimestamp');
  });
});

// ── The projection ──────────────────────────────────────────────────────────

describe('toNewAuditRecord', () => {
  it('maps every field onto the frozen record’s field of the same meaning', () => {
    const record = toNewAuditRecord(event());

    expect(record.tenantId).toBe(TENANT);
    expect(record.organizationId).toBe(ORG);
    expect(record.correlationId).toBe(CORRELATION);
    expect(record.action).toBe('organization.membership.role_changed');
    expect(record.result).toBe('success');
    expect(record.reason).toBe('Promoted by the owner.');
    expect(record.target).toEqual({
      kind: 'organization_membership',
      id: 'mem-1',
      tenantId: TENANT,
    });
  });

  it('splits the actor back into the two columns the table has', () => {
    const record = toNewAuditRecord(event());

    expect(record.actorId).toBe(ACTOR);
    expect(record.actorKind).toBe('user');
  });

  it('carries the context fields through', () => {
    const record = toNewAuditRecord(event());

    expect(record.context.ipAddress).toBe('198.51.100.4');
    expect(record.context.userAgent).toBe('Mozilla/5.0');
    expect(record.context.sessionId).toBe('sess-1');
    expect(record.context.stepUpSatisfied).toBe(true);
  });

  it('files the category in the detail, under a reserved key', () => {
    const record = toNewAuditRecord(event());

    expect(record.context.detail?.[CATEGORY_METADATA_KEY]).toBe('authorization');
    expect(categoryOf(record.context)).toBe('authorization');
  });

  it('keeps the caller’s metadata beside it', () => {
    const record = toNewAuditRecord(event({ metadata: { previous_status: 'active' } }));

    expect(record.context.detail?.['previous_status']).toBe('active');
    expect(record.context.detail?.[CATEGORY_METADATA_KEY]).toBe('authorization');
  });

  it('cannot be overridden by a caller’s metadata', () => {
    // The reserved key wins: a caller claiming a different category would file
    // the record where nobody looking for it would find it.
    const record = toNewAuditRecord(event({ metadata: { [CATEGORY_METADATA_KEY]: 'billing' } }));

    expect(categoryOf(record.context)).toBe('authorization');
  });

  it('never changes the hash preimage', () => {
    // `detail` is outside it — `hashAuditRecord` covers `stepUpSatisfied` only —
    // so adding a category cannot invalidate an existing chain.
    const base = {
      auditId: 'a-1',
      timestamp: new Date('2026-03-01T00:00:00.000Z'),
      previousHash: GENESIS_HASH,
      ...toNewAuditRecord(event()),
    };
    const withDetail = {
      ...base,
      context: { ...base.context, detail: { anything: 'else' } },
    };

    expect(hashAuditRecord(withDetail)).toBe(hashAuditRecord(base));
  });

  it('reads a null category off a record written before categories existed', () => {
    expect(
      categoryOf({ ipAddress: null, userAgent: null, sessionId: null, stepUpSatisfied: false }),
    ).toBeNull();
  });
});

// ── The service ─────────────────────────────────────────────────────────────

describe('createAuditService', () => {
  it('validates before it writes', async () => {
    const w = recordingWriter();
    const service = createAuditService({ writer: w.writer });

    await expect(service.record(tx, event({ action: 'nope' }))).rejects.toBeInstanceOf(
      AuditValidationError,
    );
    expect(w.written).toHaveLength(0);
  });

  it('delegates the write to the frozen writer', async () => {
    const w = recordingWriter();
    const service = createAuditService({ writer: w.writer });

    expect(await service.record(tx, event())).toBe('audit-1');
    expect(w.written).toHaveLength(1);
  });

  it('writes no SQL and computes no hash of its own', async () => {
    // The chain, the id and the timestamp are all the writer's.
    const w = recordingWriter();
    await createAuditService({ writer: w.writer }).record(tx, event());

    const entry = w.written[0];
    expect(entry).toBeDefined();
    expect(Object.keys(entry ?? {})).not.toContain('hash');
    expect(Object.keys(entry ?? {})).not.toContain('previousHash');
    expect(Object.keys(entry ?? {})).not.toContain('auditId');
    expect(Object.keys(entry ?? {})).not.toContain('timestamp');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(createAuditService({ writer: recordingWriter().writer }))).toBe(true);
  });
});

describe('the service redacts on the way in', () => {
  /** The observability scanner's shape, standing in for it. */
  const scanner: CredentialScanner = (value) => {
    const out = value.replace(/\bsk_live_[A-Za-z0-9]+/g, '[REDACTED]');
    return { value: out, hits: out === value ? 0 : 1 };
  };

  it('scrubs a credential out of the reason', async () => {
    // `reason` is free text in a queryable column of an append-only table kept
    // for seven years. A token written there can never be removed.
    const w = recordingWriter();
    const service = createAuditService({ writer: w.writer, scanner });

    await service.record(tx, event({ reason: 'Rotated sk_live_abc123def456 today.' })); // gitleaks:allow — fixture: the test asserts this is redacted

    expect(w.written[0]?.reason).toBe('Rotated [REDACTED] today.');
  });

  it('scrubs metadata values too', async () => {
    const w = recordingWriter();
    const service = createAuditService({ writer: w.writer, scanner });

    await service.record(tx, event({ metadata: { rotated_key: 'sk_live_abc123def456' } })); // gitleaks:allow — fixture: the test asserts this is redacted

    expect(w.written[0]?.context.detail?.['rotated_key']).toBe('[REDACTED]');
  });

  it('reports the hit rather than swallowing it', async () => {
    // The firing is itself the alert: the value never reaches the table, but it
    // reached this far, so whatever produced it is logging it elsewhere too.
    const hits: { field: string; count: number }[] = [];
    const w = recordingWriter();
    const service = createAuditService({
      writer: w.writer,
      scanner,
      onCredentialDetected: (field, count) => hits.push({ field, count }),
    });

    await service.record(tx, event({ reason: 'key sk_live_abc123def456' })); // gitleaks:allow — fixture: the test asserts this is redacted

    expect(hits).toEqual([{ field: 'reason', count: 1 }]);
  });

  it('names the metadata key that carried it', async () => {
    const hits: string[] = [];
    const w = recordingWriter();
    await createAuditService({
      writer: w.writer,
      scanner,
      onCredentialDetected: (field) => hits.push(field),
    }).record(tx, event({ metadata: { token: 'sk_live_abc123def456' } })); // gitleaks:allow — fixture: the test asserts this is redacted

    expect(hits).toEqual(['metadata.token']);
  });

  it('reports nothing when there was nothing to find', async () => {
    let fired = false;
    const w = recordingWriter();
    await createAuditService({
      writer: w.writer,
      scanner,
      onCredentialDetected: () => {
        fired = true;
      },
    }).record(tx, event());

    expect(fired).toBe(false);
  });

  it('writes the reason through unchanged when no scanner is composed', async () => {
    // Deliberately not defaulted to a no-op that pretends: a caller with no
    // scanner should be able to see that it has none.
    const w = recordingWriter();
    await createAuditService({ writer: w.writer }).record(
      tx,
      event({ reason: 'sk_live_abc123def456' }), // gitleaks:allow — fixture: the test asserts this is redacted
    );

    expect(w.written[0]?.reason).toBe('sk_live_abc123def456'); // gitleaks:allow — fixture: the test asserts this is redacted
  });
});

// ── Freezing ────────────────────────────────────────────────────────────────

describe('freezeAuditRecord', () => {
  const record: AuditRecord = {
    auditId: 'a-1',
    tenantId: TENANT,
    organizationId: ORG,
    actorId: ACTOR,
    actorKind: 'user',
    correlationId: CORRELATION,
    timestamp: new Date('2026-03-01T00:00:00.000Z'),
    action: 'organization.created',
    target: { kind: 'organization', id: ORG, tenantId: null },
    result: 'success',
    reason: 'Provisioned.',
    context: {
      ipAddress: null,
      userAgent: null,
      sessionId: null,
      stepUpSatisfied: false,
      detail: { [CATEGORY_METADATA_KEY]: 'administration' },
    },
    previousHash: GENESIS_HASH,
    hash: 'a'.repeat(64),
  };

  it('freezes through', () => {
    const frozen = freezeAuditRecord(record);

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.record)).toBe(true);
    expect(Object.isFrozen(frozen.record.target)).toBe(true);
    expect(Object.isFrozen(frozen.record.context)).toBe(true);
  });

  it('refuses an edit to a filed record', () => {
    const frozen = freezeAuditRecord(record);

    expect(() => {
      (frozen.record as { reason: string }).reason = 'something else';
    }).toThrow();
  });

  it('reads the category back out', () => {
    expect(freezeAuditRecord(record).category).toBe('administration');
  });

  it('never recomputes the hash', () => {
    // A projection that rebuilt it would report a tampered record as valid.
    expect(freezeAuditRecord(record).record.hash).toBe('a'.repeat(64));
  });
});
