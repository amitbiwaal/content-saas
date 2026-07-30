/**
 * Provider credentials and endpoints.
 *
 * Spec: `08-ai-platform/provider-adapters.md` §Security —
 * "Credentials never leave the adapter layer. They are fetched from the secret
 * manager at the boundary, never logged, never returned, never visible to the
 * Gateway or Router." And: "Provider endpoints are fixed CONFIGURATION, not
 * caller-supplied — there is no path by which a request can direct traffic to
 * an arbitrary host."
 *
 * That second rule is why a base URL is read here, from the environment, and
 * never from an `AIRequest`. A caller cannot reach this surface.
 *
 * ── Nothing is hardcoded, and nothing is defaulted to a real key ────────────
 * A missing key is an error at construction, not a request that fails later
 * against a vendor with an empty Authorization header — which is a 401 that
 * reads like a revoked credential and costs an incident to diagnose.
 */

export interface ProviderCredentials {
  /** Never logged, never returned, never put in an error message. */
  readonly apiKey: string;
  /** Fixed configuration. Overrides the vendor's default endpoint. */
  readonly baseUrl?: string;
  /** Per-request ceiling. A caller may lower it, never raise it. */
  readonly timeoutMs?: number;
}

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderConfigError';
  }
}

/** The environment this reads. Named so a deployment can be checked against it. */
export interface CredentialEnvNames {
  readonly apiKey: readonly string[];
  readonly baseUrl: string;
  readonly timeoutMs: string;
}

export function credentialEnvNames(prefix: string): CredentialEnvNames {
  return {
    apiKey: [`${prefix}_API_KEY`],
    baseUrl: `${prefix}_BASE_URL`,
    timeoutMs: `${prefix}_TIMEOUT_MS`,
  };
}

/**
 * Read credentials from the environment.
 *
 * `env` is passed in rather than read from `process.env` directly, so a test
 * never depends on the machine it runs on and a composition root can supply a
 * resolved secret bundle instead.
 */
export function credentialsFromEnv(
  names: CredentialEnvNames,
  env: Readonly<Record<string, string | undefined>>,
): ProviderCredentials {
  let apiKey: string | undefined;
  for (const name of names.apiKey) {
    const value = env[name];
    if (typeof value === 'string' && value.trim() !== '') {
      apiKey = value.trim();
      break;
    }
  }

  if (apiKey === undefined) {
    // The name, never the value.
    throw new ProviderConfigError(
      `No credential found. Set ${names.apiKey.join(' or ')}. An adapter built without one would send an empty Authorization header and fail as a 401, which reads like a revoked key rather than a missing one.`,
    );
  }

  const baseUrl = env[names.baseUrl];
  const rawTimeout = env[names.timeoutMs];
  const timeoutMs = rawTimeout === undefined ? undefined : Number(rawTimeout);
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1)) {
    throw new ProviderConfigError(
      `${names.timeoutMs} must be a positive integer of milliseconds, got '${String(rawTimeout)}'.`,
    );
  }

  return Object.freeze({
    apiKey,
    ...(baseUrl === undefined || baseUrl.trim() === '' ? {} : { baseUrl: baseUrl.trim() }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/**
 * The cost an adapter reports.
 *
 * Always zero, and deliberately: `provider-adapters.md` §Non-responsibilities
 * assigns cost accounting to `cost-management.md` — "adapters report usage,
 * they do not price it". The canonical `Usage` requires a cost field, so one is
 * supplied; the METER computes the real amount from the token counts and the
 * versioned price table, and never reads this.
 *
 * It is not a claim that the call was free.
 */
export const UNPRICED_COST = Object.freeze({ currency: 'USD', amount: '0.000000' });

/**
 * Adapters never retry on their own schedule.
 *
 * `provider-adapters.md` domain rule 3, and the reason every SDK client below
 * is constructed with retries disabled: the platform's retry strategy (S2.6)
 * owns whether and when, and an SDK retrying underneath it would multiply the
 * attempts, the spend and the rate-limit pressure invisibly.
 */
export const SDK_MAX_RETRIES = 0;
