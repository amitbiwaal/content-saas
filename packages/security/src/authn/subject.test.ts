import { describe, expect, it } from 'vitest';

import {
  isSessionUsable,
  MFA_REVERIFY_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  SESSION_IDLE_SECONDS,
  sessionState,
  slideIdleExpiry,
  stepUpRequired,
  type Session,
} from './subject.js';

const CREATED = new Date('2026-07-01T00:00:00Z');

const session = (over: Partial<Session> = {}): Session => ({
  sessionId: 's1',
  userId: 'u1',
  createdAt: CREATED,
  lastActiveAt: CREATED,
  absoluteExpiresAt: new Date(CREATED.getTime() + SESSION_ABSOLUTE_SECONDS * 1000),
  idleExpiresAt: new Date(CREATED.getTime() + SESSION_IDLE_SECONDS * 1000),
  mfaSatisfiedAt: null,
  ipAddress: '203.0.113.1',
  userAgent: 'test',
  revokedAt: null,
  revokedReason: null,
  ...over,
});

describe('session bounds', () => {
  it('uses a 7-day sliding idle window and a 30-day ceiling', () => {
    expect(SESSION_IDLE_SECONDS).toBe(7 * 24 * 60 * 60);
    expect(SESSION_ABSOLUTE_SECONDS).toBe(30 * 24 * 60 * 60);
    expect(MFA_REVERIFY_SECONDS).toBe(12 * 60 * 60);
  });
});

describe('sessionState', () => {
  it('is active within both windows', () => {
    expect(sessionState(session(), new Date(CREATED.getTime() + 1000))).toBe('active');
    expect(isSessionUsable(session(), new Date(CREATED.getTime() + 1000))).toBe(true);
  });

  it('is idle-expired past the idle window', () => {
    const at = new Date(CREATED.getTime() + (SESSION_IDLE_SECONDS + 1) * 1000);
    expect(sessionState(session(), at)).toBe('idle-expired');
    expect(isSessionUsable(session(), at)).toBe(false);
  });

  it('is absolutely-expired past the ceiling', () => {
    const at = new Date(CREATED.getTime() + (SESSION_ABSOLUTE_SECONDS + 1) * 1000);
    expect(sessionState(session(), at)).toBe('absolutely-expired');
  });

  // The ceiling is checked first: activity must not mask it.
  it('reports absolute expiry even when the idle window was kept open', () => {
    const past = new Date(CREATED.getTime() + (SESSION_ABSOLUTE_SECONDS + 100) * 1000);
    const s = session({ idleExpiresAt: new Date(past.getTime() + 999_999) });
    expect(sessionState(s, past)).toBe('absolutely-expired');
  });

  it('is revoked whenever revokedAt is set, regardless of windows', () => {
    const s = session({ revokedAt: CREATED, revokedReason: 'user-logout' });
    expect(sessionState(s, new Date(CREATED.getTime() + 1000))).toBe('revoked');
    expect(isSessionUsable(s, new Date(CREATED.getTime() + 1000))).toBe(false);
  });

  it('treats the exact boundary as expired', () => {
    const at = new Date(CREATED.getTime() + SESSION_IDLE_SECONDS * 1000);
    expect(sessionState(session(), at)).toBe('idle-expired');
  });
});

describe('slideIdleExpiry', () => {
  it('slides the idle window forward on activity', () => {
    const at = new Date(CREATED.getTime() + 60_000);
    expect(slideIdleExpiry(session(), at).getTime()).toBe(
      at.getTime() + SESSION_IDLE_SECONDS * 1000,
    );
  });

  // Without the clamp, continuous activity would extend a session for ever and
  // the 30-day bound on a stolen session would not hold.
  it('CLAMPS at the absolute ceiling and never past it', () => {
    const s = session();
    const late = new Date(s.absoluteExpiresAt.getTime() - 1000);
    expect(slideIdleExpiry(s, late).getTime()).toBe(s.absoluteExpiresAt.getTime());
  });

  it('never returns a value beyond the ceiling', () => {
    const s = session();
    for (const offsetDays of [1, 10, 25, 29]) {
      const at = new Date(CREATED.getTime() + offsetDays * 24 * 60 * 60 * 1000);
      expect(slideIdleExpiry(s, at).getTime()).toBeLessThanOrEqual(s.absoluteExpiresAt.getTime());
    }
  });
});

describe('stepUpRequired', () => {
  it('requires step-up when MFA was never satisfied', () => {
    expect(stepUpRequired(session(), CREATED)).toBe(true);
  });

  it('does not require step-up within 12 hours', () => {
    const s = session({ mfaSatisfiedAt: CREATED });
    expect(stepUpRequired(s, new Date(CREATED.getTime() + 11 * 60 * 60 * 1000))).toBe(false);
  });

  it('requires step-up after 12 hours', () => {
    const s = session({ mfaSatisfiedAt: CREATED });
    expect(stepUpRequired(s, new Date(CREATED.getTime() + 13 * 60 * 60 * 1000))).toBe(true);
  });

  it('treats the exact 12-hour boundary as requiring step-up', () => {
    const s = session({ mfaSatisfiedAt: CREATED });
    expect(stepUpRequired(s, new Date(CREATED.getTime() + MFA_REVERIFY_SECONDS * 1000))).toBe(true);
  });
});
