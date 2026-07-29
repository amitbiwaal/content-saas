/**
 * Identity types — `16-security/authentication.md`.
 *
 * "A session establishes identity. It never carries authority."
 */

export type AuthMethod =
  | 'password'
  | 'oauth'
  | 'saml'
  | 'oidc'
  | 'api-key'
  | 'service-token'
  | 'recovery-code';

/**
 * NO permissions. NO roles. NO workspace grants. NO tenantId.
 *
 * Permissions are never embedded, and this is a deliberate cost: embedding them
 * would let authorization skip a lookup, but a token minted before a permission
 * change would carry stale authority until it expired. An administrator who
 * revokes access expects it to take effect now.
 *
 * `Subject` carries no `tenantId` because a user belongs to many workspaces —
 * the tenant is determined by the resource being addressed. A tenant baked into
 * the session would make workspace switching a re-authentication and would make
 * the tenant a claim the client influences.
 */
export interface Subject {
  readonly subjectId: string;
  readonly kind: 'user' | 'api-key' | 'service';
  readonly authenticatedAt: Date;
  readonly method: AuthMethod;
  readonly mfaSatisfied: boolean;
  /** null for API keys and services. */
  readonly sessionId: string | null;
}

export type SessionRevocationReason =
  | 'user-logout'
  | 'admin-revoked'
  | 'password-changed'
  | 'mfa-reset'
  | 'suspicious-activity'
  | 'sso-deprovisioned';

export interface Session {
  /** Opaque, 256-bit random. */
  readonly sessionId: string;
  readonly userId: string;
  readonly createdAt: Date;
  readonly lastActiveAt: Date;
  /** Hard ceiling, NEVER extended — bounds a stolen session. */
  readonly absoluteExpiresAt: Date;
  /** Sliding. */
  readonly idleExpiresAt: Date;
  readonly mfaSatisfiedAt: Date | null;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly revokedAt: Date | null;
  readonly revokedReason: SessionRevocationReason | null;
}

/** Session bounds (`authentication.md` §Session). */
export const SESSION_IDLE_SECONDS = 7 * 24 * 60 * 60; // 7 days, sliding
export const SESSION_ABSOLUTE_SECONDS = 30 * 24 * 60 * 60; // 30 days, never extended
export const MFA_REVERIFY_SECONDS = 12 * 60 * 60; // 12 hours for sensitive operations

export interface TokenPair {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresInSeconds: number;
}

export interface MfaFactor {
  readonly kind: 'totp' | 'recovery-code';
  readonly enrolledAt: Date;
}

/**
 * The failure variant carries ONE opaque reason.
 *
 * A richer type — `unknown-user`, `wrong-password`, `account-disabled` — would
 * eventually reach a response or a log and become an enumeration oracle. The
 * type makes the leak unrepresentable rather than relying on every caller to
 * flatten it correctly.
 */
export type AuthResult =
  | { readonly outcome: 'authenticated'; readonly subject: Subject; readonly tokens: TokenPair }
  | {
      readonly outcome: 'mfa-required';
      readonly challengeId: string;
      readonly factors: readonly MfaFactor[];
    }
  | { readonly outcome: 'failed'; readonly reason: 'invalid-credentials' };

export type ReuseDetected = {
  readonly outcome: 'reuse-detected';
  readonly sessionsRevoked: number;
};

export type StepUpResult =
  | { readonly outcome: 'satisfied' }
  | { readonly outcome: 'required'; readonly challengeId: string };

export type Credential =
  | { readonly kind: 'password'; readonly email: string; readonly password: string }
  | { readonly kind: 'api-key'; readonly key: string }
  | { readonly kind: 'service-token'; readonly token: string }
  | { readonly kind: 'recovery-code'; readonly userId: string; readonly code: string };

/** Device tracking — enumerable and revocable; visibility is the control. */
export interface DeviceRecord {
  readonly sessionId: string;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly current: boolean;
}

export interface Authenticator {
  authenticate(credential: Credential): Promise<AuthResult>;
  verifySession(sessionId: string): Promise<Subject | null>;
  refresh(refreshToken: string): Promise<TokenPair | ReuseDetected>;
  revokeSession(sessionId: string, reason: SessionRevocationReason): Promise<void>;
  revokeAllSessions(userId: string, reason: SessionRevocationReason): Promise<number>;
  requireStepUp(sessionId: string, operation: string): Promise<StepUpResult>;
  /** Enumerate a user's devices. Multi-device is normal; visibility is the control. */
  devices(userId: string): Promise<readonly DeviceRecord[]>;
}

// ── Session validity — pure, so it is testable without a provider ────────────

export type SessionState = 'active' | 'idle-expired' | 'absolutely-expired' | 'revoked';

export function sessionState(session: Session, at: Date): SessionState {
  if (session.revokedAt !== null) return 'revoked';
  // The absolute ceiling is checked FIRST: a session past it is expired even if
  // activity kept the idle window open.
  if (at >= session.absoluteExpiresAt) return 'absolutely-expired';
  if (at >= session.idleExpiresAt) return 'idle-expired';
  return 'active';
}

export function isSessionUsable(session: Session, at: Date): boolean {
  return sessionState(session, at) === 'active';
}

/**
 * Slide the idle window, clamped by the absolute ceiling.
 *
 * The clamp is the point: without it, continuous activity would extend a
 * session indefinitely and the 30-day bound on a stolen session would not hold.
 */
export function slideIdleExpiry(session: Session, at: Date): Date {
  const slid = new Date(at.getTime() + SESSION_IDLE_SECONDS * 1000);
  return slid > session.absoluteExpiresAt ? session.absoluteExpiresAt : slid;
}

/** Fresh MFA is required for sensitive operations after 12 hours. */
export function stepUpRequired(session: Session, at: Date): boolean {
  if (session.mfaSatisfiedAt === null) return true;
  return at.getTime() - session.mfaSatisfiedAt.getTime() >= MFA_REVERIFY_SECONDS * 1000;
}
