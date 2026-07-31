import { describe, expect, it } from 'vitest';

import {
  createCursor,
  CURSOR_ERROR_CODES,
  CURSOR_VERSION,
  decodeCursor,
  encodeCursor,
  fingerprint,
} from './cursor.js';

const CANONICAL = 'order=newest&organizationId=org-1&workspaceId=&principalId=&workflowId=';
const OTHER = 'order=oldest&organizationId=org-1&workspaceId=&principalId=&workflowId=';
const AT = '2026-07-31T12:00:00.000Z';

/** Mirrors the module's separator. The round-trip tests keep the mirror honest. */
const SEP = '';

const cursorFor = (runId = 'run-1', canonical = CANONICAL): string =>
  encodeCursor(createCursor({ createdAt: AT, runId, canonical }));

describe('making a cursor', () => {
  it('stamps the format version this build issues', () => {
    expect(createCursor({ createdAt: AT, runId: 'run-1', canonical: CANONICAL }).version).toBe(
      CURSOR_VERSION,
    );
  });

  it('names the position it continues from', () => {
    const cursor = createCursor({ createdAt: AT, runId: 'run-1', canonical: CANONICAL });

    expect(cursor.createdAt).toBe(AT);
    expect(cursor.runId).toBe('run-1');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(createCursor({ createdAt: AT, runId: 'r', canonical: CANONICAL }))).toBe(
      true,
    );
  });
});

describe('encoding', () => {
  it('round-trips', () => {
    const decoded = decodeCursor(cursorFor(), CANONICAL);

    expect(decoded.outcome).toBe('decoded');
    if (decoded.outcome !== 'decoded') return;
    expect(decoded.cursor.createdAt).toBe(AT);
    expect(decoded.cursor.runId).toBe('run-1');
  });

  it('is deterministic', () => {
    expect(cursorFor()).toBe(cursorFor());
  });

  it('is URL-safe, so a cursor survives a query string', () => {
    expect(cursorFor()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is opaque enough that nobody is tempted to read it', () => {
    expect(cursorFor()).not.toContain('run-1');
    expect(cursorFor()).not.toContain(AT);
  });

  it('differs for different positions', () => {
    expect(cursorFor('run-1')).not.toBe(cursorFor('run-2'));
  });
});

describe('refusing a cursor', () => {
  it('names two refusals and nothing else', () => {
    expect([...CURSOR_ERROR_CODES]).toEqual(['InvalidCursor', 'IncompatibleCursor']);
  });

  it('refuses something that is not a cursor at all', () => {
    const result = decodeCursor('not-a-cursor', CANONICAL);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidCursor');
  });

  it('refuses one with the wrong number of parts', () => {
    const broken = Buffer.from(['1', AT, 'run-1'].join(SEP), 'utf8').toString('base64url');
    const result = decodeCursor(broken, CANONICAL);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidCursor');
  });

  it('refuses one whose version is not a number', () => {
    const broken = Buffer.from(
      ['x', AT, 'run-1', fingerprint(CANONICAL)].join(SEP),
      'utf8',
    ).toString('base64url');
    const result = decodeCursor(broken, CANONICAL);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidCursor');
  });

  it('refuses one from another cursor format, as its own kind of refusal', () => {
    // Well-formed, and simply describing a sequence this build does not
    // produce — which is not the same as corruption and should not read as it.
    const future = Buffer.from(
      ['2', AT, 'run-1', fingerprint(CANONICAL)].join(SEP),
      'utf8',
    ).toString('base64url');
    const result = decodeCursor(future, CANONICAL);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleCursor');
    expect(result.reason).toMatch(/Start the listing again/);
  });

  it('refuses one whose timestamp is not ISO', () => {
    const broken = Buffer.from(
      ['1', 'yesterday', 'run-1', fingerprint(CANONICAL)].join(SEP),
      'utf8',
    ).toString('base64url');
    const result = decodeCursor(broken, CANONICAL);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidCursor');
  });

  it('refuses one that names no run', () => {
    const broken = Buffer.from(['1', AT, ' ', fingerprint(CANONICAL)].join(SEP), 'utf8').toString(
      'base64url',
    );
    const result = decodeCursor(broken, CANONICAL);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('InvalidCursor');
  });

  it('refuses one issued for a different query', () => {
    // The position it names means nothing in another sequence — the page would
    // be arbitrary, and it would look correct.
    const result = decodeCursor(cursorFor('run-1', CANONICAL), OTHER);

    expect(result.outcome).toBe('refused');
    if (result.outcome !== 'refused') return;
    expect(result.code).toBe('IncompatibleCursor');
    expect(result.reason).toMatch(/different filter or order/);
  });

  it('never throws, whatever it is handed', () => {
    for (const value of ['', '!!!', '=====', 'ᚠᚢᚦ', 'a'.repeat(10_000)]) {
      expect(() => decodeCursor(value, CANONICAL)).not.toThrow();
    }
  });

  it('freezes its refusal', () => {
    expect(Object.isFrozen(decodeCursor('nope', CANONICAL))).toBe(true);
  });
});

describe('the fingerprint', () => {
  it('is deterministic', () => {
    expect(fingerprint(CANONICAL)).toBe(fingerprint(CANONICAL));
  });

  it('is a fixed-width hex string', () => {
    expect(fingerprint(CANONICAL)).toMatch(/^[0-9a-f]{8}$/);
    expect(fingerprint('')).toMatch(/^[0-9a-f]{8}$/);
  });

  it('differs for different queries', () => {
    expect(fingerprint(CANONICAL)).not.toBe(fingerprint(OTHER));
  });
});
