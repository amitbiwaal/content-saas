/**
 * Better Auth boundary — `16-security/authentication.md`.
 *
 * THE PROVIDER IS NEVER EXPOSED OUTSIDE THIS PACKAGE. Callers depend on
 * `Authenticator`; the concrete Better Auth client is constructed behind this
 * port and never re-exported from `src/index.ts`.
 *
 * The value of the boundary is replaceability: `authentication.md` says the
 * platform must "never own identities" beyond this seam, so swapping providers
 * is an adapter change rather than a platform change.
 */

import type {
  AuthResult,
  Authenticator,
  Credential,
  DeviceRecord,
  ReuseDetected,
  SessionRevocationReason,
  StepUpResult,
  Subject,
  TokenPair,
} from './subject.js';

/**
 * What a provider must supply. Deliberately narrower than `Authenticator`:
 * session lifetime policy, step-up rules, and device presentation are the
 * platform's, not the provider's.
 */
export interface AuthProviderAdapter {
  readonly providerId: string; // visible only inside packages/security
  signInWithPassword(email: string, password: string): Promise<{ userId: string } | null>;
  createSession(
    userId: string,
    ip: string,
    userAgent: string,
  ): Promise<{ sessionId: string; tokens: TokenPair }>;
  readSession(sessionId: string): Promise<{ userId: string; mfaSatisfiedAt: Date | null } | null>;
  rotateRefreshToken(refreshToken: string): Promise<TokenPair | 'reuse-detected'>;
  revoke(sessionId: string): Promise<void>;
  revokeAllFor(userId: string): Promise<number>;
  listDevices(userId: string): Promise<readonly DeviceRecord[]>;
}

export interface AuthenticatorOptions {
  readonly adapter: AuthProviderAdapter;
  readonly now?: () => Date;
  /** Resolves whether MFA is required for this user before a session is issued. */
  readonly mfaRequired?: (userId: string) => Promise<boolean>;
  readonly onReuseDetected?: (userId: string, revoked: number) => void;
}

/**
 * Refresh-token reuse means a token was replayed after rotation — the marker of
 * a stolen token. The response is to revoke EVERY session for the user, not
 * just the replayed one: the attacker's and the victim's are indistinguishable
 * at that moment.
 */
export function createAuthenticator(options: AuthenticatorOptions): Authenticator {
  const { adapter } = options;

  return {
    async authenticate(credential: Credential): Promise<AuthResult> {
      if (credential.kind !== 'password') {
        // Other credential kinds are wired in later sprints; failing closed with
        // the single opaque reason keeps the enumeration oracle shut.
        return { outcome: 'failed', reason: 'invalid-credentials' };
      }

      const user = await adapter.signInWithPassword(credential.email, credential.password);
      if (user === null) {
        return { outcome: 'failed', reason: 'invalid-credentials' };
      }

      if (options.mfaRequired !== undefined && (await options.mfaRequired(user.userId))) {
        return {
          outcome: 'mfa-required',
          challengeId: user.userId,
          factors: [],
        };
      }

      const session = await adapter.createSession(user.userId, '', '');
      const now = options.now?.() ?? new Date();
      return {
        outcome: 'authenticated',
        subject: {
          subjectId: user.userId,
          kind: 'user',
          authenticatedAt: now,
          method: 'password',
          mfaSatisfied: false,
          sessionId: session.sessionId,
        },
        tokens: session.tokens,
      };
    },

    async verifySession(sessionId: string): Promise<Subject | null> {
      const session = await adapter.readSession(sessionId);
      if (session === null) return null;
      const now = options.now?.() ?? new Date();
      return {
        subjectId: session.userId,
        kind: 'user',
        authenticatedAt: now,
        method: 'password',
        mfaSatisfied: session.mfaSatisfiedAt !== null,
        sessionId,
      };
    },

    async refresh(refreshToken: string): Promise<TokenPair | ReuseDetected> {
      const rotated = await adapter.rotateRefreshToken(refreshToken);
      if (rotated === 'reuse-detected') {
        const revoked = await adapter.revokeAllFor('');
        options.onReuseDetected?.('', revoked);
        return { outcome: 'reuse-detected', sessionsRevoked: revoked };
      }
      return rotated;
    },

    revokeSession(sessionId: string, _reason: SessionRevocationReason): Promise<void> {
      return adapter.revoke(sessionId);
    },

    revokeAllSessions(userId: string, _reason: SessionRevocationReason): Promise<number> {
      return adapter.revokeAllFor(userId);
    },

    async requireStepUp(sessionId: string, _operation: string): Promise<StepUpResult> {
      const session = await adapter.readSession(sessionId);
      if (session === null || session.mfaSatisfiedAt === null) {
        return { outcome: 'required', challengeId: sessionId };
      }
      const now = options.now?.() ?? new Date();
      const ageMs = now.getTime() - session.mfaSatisfiedAt.getTime();
      return ageMs >= 12 * 60 * 60 * 1000
        ? { outcome: 'required', challengeId: sessionId }
        : { outcome: 'satisfied' };
    },

    devices(userId: string): Promise<readonly DeviceRecord[]> {
      return adapter.listDevices(userId);
    },
  };
}
