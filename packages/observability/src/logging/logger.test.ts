import { describe, expect, it } from 'vitest';

import { LOG_RECORD_FIELDS, UNBOUND_CORRELATION_ID } from './log-record.js';
import { createLogger, type LogSink } from './logger.js';
import { SecretValue } from './redaction.js';

function capture(): { sink: LogSink; lines: string[]; records: () => Record<string, unknown>[] } {
  const lines: string[] = [];
  return {
    sink: { write: (line) => lines.push(line) },
    lines,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

const BASE = {
  service: 'api',
  version: '1.0.0',
  clock: (): Date => new Date('2026-07-29T10:00:00.000Z'),
  minLevel: 'debug' as const,
};

describe('structured logger — serialization', () => {
  it('emits JSON with every always-present field', () => {
    const c = capture();
    createLogger({ ...BASE, sink: c.sink }).info({ event: 'run.started', correlationId: 'corr-1' });

    const [record] = c.records();
    expect(record).toMatchObject({
      timestamp: '2026-07-29T10:00:00.000Z',
      level: 'info',
      event: 'run.started',
      service: 'api',
      version: '1.0.0',
      correlationId: 'corr-1',
    });
  });

  it('writes one line per record', () => {
    const c = capture();
    const log = createLogger({ ...BASE, sink: c.sink });
    log.info({ event: 'a', correlationId: 'c' });
    log.info({ event: 'b', correlationId: 'c' });
    expect(c.lines).toHaveLength(2);
    expect(c.lines.every((l) => !l.includes('\n'))).toBe(true);
  });

  // Allowlist projection — layer 2 of redaction.
  it('drops any field not on the allowlist', () => {
    const c = capture();
    const log = createLogger({ ...BASE, sink: c.sink });
    log.info({
      event: 'upload.failed',
      correlationId: 'c',
      // @ts-expect-error — not a LogRecord field; must not reach the output
      password: 'hunter2',
      authorization: 'Bearer abc',
    });

    const [record] = c.records();
    expect(record).not.toHaveProperty('password');
    expect(record).not.toHaveProperty('authorization');
    expect(
      Object.keys(record ?? {}).every((k) => (LOG_RECORD_FIELDS as readonly string[]).includes(k)),
    ).toBe(true);
  });

  it('omits undefined optional fields rather than emitting nulls', () => {
    const c = capture();
    createLogger({ ...BASE, sink: c.sink }).info({ event: 'e', correlationId: 'c' });
    const [record] = c.records();
    expect(record).not.toHaveProperty('tenantId');
    expect(record).not.toHaveProperty('durationMs');
  });

  // Layer 1 — SecretValue.toJSON()
  it('redacts a SecretValue that reaches an allowlisted field', () => {
    const c = capture();
    createLogger({ ...BASE, sink: c.sink }).info({
      event: 'e',
      correlationId: 'c',
      detail: new SecretValue('super-secret') as unknown as string,
    });
    expect(c.lines[0]).toContain('[REDACTED]');
    expect(c.lines[0]).not.toContain('super-secret');
  });

  // Layer 3 — the backstop, and its firing is itself the alert.
  it('catches a credential-shaped value and reports the hit', () => {
    const c = capture();
    let hits = 0;
    createLogger({ ...BASE, sink: c.sink, onRedactionHit: (n) => (hits += n) }).info({
      event: 'e',
      correlationId: 'c',
      detail: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    });
    expect(hits).toBeGreaterThan(0);
    expect(c.lines[0]).not.toContain('abcdefghijklmnopqrstuvwxyz012345');
  });
});

describe('structured logger — levels', () => {
  it('offers exactly error, warn, info, debug — fatal does not exist', () => {
    const log = createLogger({ ...BASE, sink: capture().sink });
    expect(typeof log.error).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect((log as unknown as Record<string, unknown>)['fatal']).toBeUndefined();
  });

  it('suppresses debug below the configured level', () => {
    const c = capture();
    createLogger({ ...BASE, sink: c.sink, minLevel: 'info' }).debug({
      event: 'e',
      correlationId: 'c',
    });
    expect(c.lines).toHaveLength(0);
  });

  // Rule 10 — error and warn are never sampled.
  it('never suppresses error or warn, whatever the level config', () => {
    const c = capture();
    const log = createLogger({ ...BASE, sink: c.sink, minLevel: 'error' });
    log.warn({ event: 'degraded', correlationId: 'c' });
    log.error({ event: 'failed', correlationId: 'c', code: 'E_X' });
    expect(c.lines).toHaveLength(2);
  });
});

describe('structured logger — child loggers and correlation', () => {
  it('attaches bindings to every record in scope', () => {
    const c = capture();
    const child = createLogger({ ...BASE, sink: c.sink }).child({
      correlationId: 'corr-9',
      tenantId: 'ws-1',
      organizationId: 'org-1',
    });
    child.info({ event: 'a' });
    child.info({ event: 'b' });

    for (const record of c.records()) {
      expect(record['correlationId']).toBe('corr-9');
      expect(record['tenantId']).toBe('ws-1');
      expect(record['organizationId']).toBe('org-1');
    }
  });

  it('lets a call-site field override a binding', () => {
    const c = capture();
    createLogger({ ...BASE, sink: c.sink })
      .child({ correlationId: 'bound', tenantId: 'ws-1' })
      .info({ event: 'e', tenantId: 'ws-2' });
    expect(c.records()[0]?.['tenantId']).toBe('ws-2');
  });

  it('nests child loggers, merging bindings', () => {
    const c = capture();
    createLogger({ ...BASE, sink: c.sink })
      .child({ correlationId: 'c1' })
      .child({ tenantId: 'ws-1' })
      .info({ event: 'e' });
    expect(c.records()[0]).toMatchObject({ correlationId: 'c1', tenantId: 'ws-1' });
  });

  it('does not leak a child binding back to its parent', () => {
    const c = capture();
    const parent = createLogger({ ...BASE, sink: c.sink }).child({ correlationId: 'c1' });
    parent.child({ tenantId: 'ws-1' }).info({ event: 'child' });
    parent.info({ event: 'parent' });
    expect(c.records()[1]).not.toHaveProperty('tenantId');
  });

  // correlationId is mandatory on every record (rule 3).
  it('emits the unbound sentinel rather than dropping an uncorrelated record', () => {
    const c = capture();
    createLogger({ ...BASE, sink: c.sink }).info({ event: 'orphan' });
    expect(c.records()[0]?.['correlationId']).toBe(UNBOUND_CORRELATION_ID);
  });
});

describe('structured logger — delivery never blocks the application', () => {
  it('swallows a throwing sink and reports the failure', () => {
    let failures = 0;
    const log = createLogger({
      ...BASE,
      sink: {
        write: () => {
          throw new Error('collector down');
        },
      },
      onDeliveryFailure: () => (failures += 1),
    });
    expect(() => {
      log.info({ event: 'e', correlationId: 'c' });
    }).not.toThrow();
    expect(failures).toBe(1);
  });

  it('survives a value that cannot be serialized', () => {
    let failures = 0;
    const c = capture();
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const log = createLogger({ ...BASE, sink: c.sink, onDeliveryFailure: () => (failures += 1) });
    expect(() => {
      log.info({ event: 'e', correlationId: 'c', detail: circular as unknown as string });
    }).not.toThrow();
    expect(failures).toBe(1);
  });
});
