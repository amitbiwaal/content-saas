/**
 * Rate limit policies, and the keys they count against.
 *
 * ── This file sets no numbers ───────────────────────────────────────────────
 * `04-platform/rate-limiting.md` owns the values and does not set them either:
 * "No approved document sets a numeric limit, and this document does not invent
 * one. The matrix is a commercial decision." It also says how they arrive —
 * "Values are loaded from configuration, never hardcoded."
 *
 * So there is no default policy set here, and `createPolicySet` throws on an
 * empty one. A limiter configured with nothing would allow everything while
 * looking installed, which is the failure mode that only shows up in an
 * incident review.
 *
 * ── Why five scopes and not one ─────────────────────────────────────────────
 * Each catches something the others cannot. A per-user limit does not stop one
 * workspace's ten users exhausting a shared quota; a per-workspace limit does
 * not stop one compromised key inside it; a per-IP limit catches a client
 * hammering from one host under many identities. They are evaluated together
 * and the MOST CONSTRAINING wins, because a request that exceeds any one of
 * them has exceeded a limit.
 *
 * ── Keys are constructed, never accepted ────────────────────────────────────
 * `16-security/tenant-isolation.md`: `cos:{tenantId}:{namespace}:{key}`, with a
 * reserved `cos:global:` for genuinely non-tenant data, and "the key is
 * constructed, never accepted — a client-supplied path segment permits
 * traversal into another tenant's prefix". Every segment below comes from the
 * resolved principal or a validated value, and separators are stripped from
 * anything that did not.
 */

import type { Principal } from '@contentos/security';

import type { RateLimitConfig } from '../pipeline/stages.js';

/**
 * What a limit counts.
 *
 * `ip` is kept alongside the identity scopes deliberately: an authenticated
 * caller hammering from one host is a compromised credential, which no
 * per-identity limit catches until the identity itself is noticed. The
 * UNAUTHENTICATED per-IP limit is a different control and already exists —
 * `rateLimitPreAuth` in `pipeline/stages.ts`, which protects the auth endpoints
 * before any of this can run.
 */
export const RATE_LIMIT_SCOPES = ['api-key', 'user', 'workspace', 'organization', 'ip'] as const;

export type RateLimitScope = (typeof RATE_LIMIT_SCOPES)[number];

export function isRateLimitScope(value: unknown): value is RateLimitScope {
  return typeof value === 'string' && (RATE_LIMIT_SCOPES as readonly string[]).includes(value);
}

/**
 * The rate-limit classes `06-api/api-principles.md` declares. A policy names
 * the class it applies to, or omits it to apply to every request.
 */
export const RATE_LIMIT_CLASSES = ['read', 'write', 'expensive', 'auth'] as const;

export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

export interface RateLimitPolicy extends RateLimitConfig {
  /** Names the policy in a header and a log. Not used to make a decision. */
  readonly name: string;
  readonly scope: RateLimitScope;
  /** Omitted applies to every class. */
  readonly appliesTo?: RateLimitClass;
}

export class RateLimitConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitConfigError';
  }
}

/**
 * Validate a configured set.
 *
 * Every check here describes a policy that would silently not work: a zero
 * limit blocks everything, a zero window divides by nothing, two policies with
 * one name are indistinguishable in the header that reports which one bound.
 */
export function createPolicySet(policies: readonly RateLimitPolicy[]): readonly RateLimitPolicy[] {
  if (policies.length === 0) {
    throw new RateLimitConfigError(
      'At least one rate limit policy is required. An empty set allows everything while looking configured.',
    );
  }

  const names = new Set<string>();
  for (const policy of policies) {
    if (policy.name.trim() === '') {
      throw new RateLimitConfigError('Every policy needs a name; it is what a 429 reports.');
    }
    if (names.has(policy.name)) {
      throw new RateLimitConfigError(`Duplicate policy name '${policy.name}'.`);
    }
    names.add(policy.name);

    if (!isRateLimitScope(policy.scope)) {
      throw new RateLimitConfigError(
        `Policy '${policy.name}' has scope '${String(policy.scope)}', which is not one of ${RATE_LIMIT_SCOPES.join(', ')}.`,
      );
    }
    if (!Number.isInteger(policy.limit) || policy.limit < 1) {
      throw new RateLimitConfigError(
        `Policy '${policy.name}' must permit at least one request; a limit of ${String(policy.limit)} blocks everything.`,
      );
    }
    if (!Number.isInteger(policy.windowSeconds) || policy.windowSeconds < 1) {
      throw new RateLimitConfigError(
        `Policy '${policy.name}' needs a window of at least one second.`,
      );
    }
  }

  return Object.freeze(policies.map((policy) => Object.freeze({ ...policy })));
}

/** What a key is built from. Every field is resolved, never claimed. */
export interface RateLimitSubject {
  readonly principal: Principal;
  /** The API key id, where a key was presented. Null for a bearer token. */
  readonly apiKeyId: string | null;
  /** The peer address, as the transport reports it. */
  readonly ipAddress: string;
}

/**
 * Strip anything that could break out of a key segment.
 *
 * A colon in a segment would let a crafted value forge a prefix boundary and
 * count against — or read — another tenant's bucket. Ids come from the
 * directory and should never contain one; this is the belt to that braces.
 */
function segment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '');
}

export const RATE_LIMIT_NAMESPACE = 'ratelimit';

/**
 * The Redis key for one policy applied to one subject.
 *
 * ── Only `workspace` is tenant-prefixed, and that is the point ──────────────
 * `16-security/tenant-isolation.md` requires `cos:{tenantId}:...` for keys
 * carrying TENANT data, and reserves `cos:global:` for "data owned by no
 * tenant". A limiter bucket is owned by whatever it counts, and four of these
 * five things are not owned by a workspace:
 *
 *   api-key       one key, wherever it is used
 *   user          one person, across every workspace they belong to
 *   organization  one customer, across every workspace it owns
 *   ip            one address, across every tenant behind it
 *
 * Prefixing any of those with a workspace would hand out one bucket PER
 * WORKSPACE, so a caller belonging to ten workspaces would get ten times the
 * quota and could reset a spent one by switching. That is the same evasion in
 * four places, and the fix is to key each bucket on the thing it names.
 *
 * `workspace` genuinely is tenant data, so it keeps the tenant prefix and a
 * whole tenant's limiter state stays scannable and deletable with one pattern.
 */
export function rateLimitKey(policy: RateLimitPolicy, subject: RateLimitSubject): string {
  const { principal } = subject;
  const suffix = `${RATE_LIMIT_NAMESPACE}:${segment(policy.name)}`;

  switch (policy.scope) {
    case 'api-key':
      // A bearer token has no key id, so it is counted under its subject —
      // otherwise every token in the platform would share one bucket.
      return `cos:global:${suffix}:api-key:${segment(subject.apiKeyId ?? principal.subjectId)}`;
    case 'user':
      return `cos:global:${suffix}:user:${segment(principal.subjectId)}`;
    case 'workspace':
      return `cos:${segment(principal.workspaceId)}:${suffix}:workspace`;
    case 'organization':
      return `cos:global:${suffix}:organization:${segment(principal.organizationId)}`;
    case 'ip':
      return `cos:global:${suffix}:ip:${segment(subject.ipAddress)}`;
  }
}

/** The policies that apply to a request of this class. */
export function policiesFor(
  policies: readonly RateLimitPolicy[],
  requestClass: RateLimitClass,
): readonly RateLimitPolicy[] {
  return policies.filter(
    (policy) => policy.appliesTo === undefined || policy.appliesTo === requestClass,
  );
}
