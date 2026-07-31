/**
 * The published contract against the code it claims to describe.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE DOCUMENT DESCRIBES THE RUNNING ROUTER. Every documented operation is
 *    reachable, every reachable operation is documented, and the statuses the
 *    document promises are the statuses the router actually returns. A unit
 *    test of the generator cannot see the router; a unit test of the router
 *    cannot see the document.
 *
 * 2. VERSION NEGOTIATION IN THE PIPELINE. Rejecting an unknown version and
 *    retiring a sunset one are properties of the whole request path, including
 *    that they happen BEFORE authentication.
 *
 * 3. THE DIVERGENCE from `06-api/api-reference.md`, which is the canonical
 *    endpoint registry — recorded, because this increment is the one that
 *    publishes the contract.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  AI_ROUTES,
  API_ERROR_MESSAGES,
  createAiControllers,
  createAiRouter,
  createIdempotencyGuard,
  createOpenApiDocument,
  createProviderDispatcher,
  createRateLimitEnforcer,
  createRedisIdempotencyStore,
  createRedisRateLimiter,
  createVersionRegistry,
  EXECUTION_BODY_FIELDS,
  serializeOpenApiDocument,
  toOpenApiPath,
  validateOpenApiDocument,
  type ApiRequest,
  type ApiResponse,
  type ApiVersion,
  type AuthMiddleware,
  type ErrorBody,
  type RedisCommands,
} from '@contentos/api';
import {
  createGateway,
  createPromptCatalogue,
  createProviderRegistry,
  type AdmissionDirectory,
  type AdmissionFlags,
  type ModelProvider,
  type PromptTemplate,
} from '@contentos/ai';
import type { AuthContext, AuthenticationResult } from '@contentos/security';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-31T12:00:00.000Z');

const V1: ApiVersion = { version: 'v1', status: 'current', releasedAt: '2026-01-01T00:00:00.000Z' };
const V1_DEPRECATED: ApiVersion = {
  version: 'v1',
  status: 'deprecated',
  releasedAt: '2024-01-01T00:00:00.000Z',
  deprecatedAt: '2026-03-01T00:00:00.000Z',
  sunsetAt: '2026-09-01T00:00:00.000Z',
  migrationGuide: 'https://docs.contentos.ai/api/v2/migration',
};
const V2: ApiVersion = { version: 'v2', status: 'current', releasedAt: '2026-03-01T00:00:00.000Z' };

// ── A router, wired the way production would ────────────────────────────────

const CONTEXT: AuthContext = Object.freeze({
  requestId: 'req-1',
  correlationId: CORRELATION,
  principal: Object.freeze({
    subjectId: 'user-1',
    kind: 'user' as const,
    method: 'password' as const,
    organizationId: ORG,
    workspaceId: WS,
    roles: Object.freeze(['editor' as const]),
    permissions: Object.freeze(['article:execute' as const, 'run:read' as const]),
    authenticatedAt: NOW,
    mfaSatisfied: true,
    sessionId: null,
  }),
  organization: Object.freeze({ id: ORG, status: 'active' }),
  workspace: Object.freeze({ id: WS, status: 'active' }),
});

const AUTHENTICATED: AuthenticationResult = {
  outcome: 'authenticated',
  subject: {
    subjectId: 'user-1',
    kind: 'user',
    authenticatedAt: NOW,
    method: 'password',
    mfaSatisfied: true,
    sessionId: null,
  },
  organizationId: null,
  workspaceId: null,
};

interface AuthCalls {
  readonly middleware: AuthMiddleware;
  readonly authentications: number[];
}

function countingAuth(): AuthCalls {
  const authentications: number[] = [];
  return {
    authentications,
    middleware: {
      authenticate: () => {
        authentications.push(1);
        return Promise.resolve(AUTHENTICATED);
      },
      authorize: () => Promise.resolve({ outcome: 'authorized', context: CONTEXT }),
    },
  };
}

function collaborators(): {
  rateLimit: ReturnType<typeof createRateLimitEnforcer>;
  idempotency: ReturnType<typeof createIdempotencyGuard>;
} {
  const strings = new Map<string, string>();
  const redis: RedisCommands = {
    // eslint-disable-next-line @typescript-eslint/require-await
    async eval(script, keys, args): Promise<unknown> {
      const key = keys[0] as string;
      if (script.includes('ZREMRANGEBYSCORE')) return [1, Number(args[0]) - 1, Number(args[1])];
      if (script.includes('record.fingerprint ~= ARGV[2]')) {
        strings.set(key, String(args[0]));
        return 1;
      }
      if (script.includes("redis.call('DEL', KEYS[1])")) {
        strings.delete(key);
        return 1;
      }
      const existing = strings.get(key);
      if (existing !== undefined) return [0, existing];
      strings.set(key, String(args[0]));
      return [1, ''];
    },
  };

  return {
    rateLimit: createRateLimitEnforcer({
      limiter: createRedisRateLimiter({ redis }),
      policies: [{ name: 'generous', scope: 'user', limit: 1_000_000, windowSeconds: 60 }],
      now: () => NOW,
    }),
    idempotency: createIdempotencyGuard({ store: createRedisIdempotencyStore({ redis }) }),
  };
}

const TEMPLATE: PromptTemplate = {
  id: 'planning.outline',
  version: 7,
  taskType: 'planning.outline',
  status: 'active',
  parts: { system: 'You write outlines.', user: 'Write an outline about {{topic}}.' },
  variables: [{ name: 'topic', type: 'string', required: true, description: 'The subject.' }],
  modelHints: { maxOutputTokens: 1024, temperature: 0.2, determinismRequired: false },
  evalSetRef: 'evals/planning.outline',
  owner: 'content-platform',
  changelog: 'Initial version.',
};

const directory: AdmissionDirectory = {
  organization: (organizationId) => Promise.resolve({ organizationId, status: 'active' }),
  workspace: (workspaceId) =>
    Promise.resolve({ workspaceId, organizationId: ORG, status: 'active' }),
  membership: (workspaceId, actorId) => Promise.resolve({ workspaceId, actorId, status: 'active' }),
};

const flags: AdmissionFlags = { isEnabled: () => Promise.resolve(true) };

function provider(): ModelProvider {
  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    capabilities: ['chat'],
    health: () =>
      Promise.resolve({ status: 'healthy' as const, reportedAt: NOW.toISOString(), detail: null }),
    execute: () =>
      Promise.resolve({
        idempotencyKey: 'run-1:step-1',
        providerId: 'openai',
        model: 'gpt-4o',
        content: 'An outline.',
        finishReason: 'stop' as const,
        usage: {
          tokens: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          tokensEstimated: false,
          cost: { currency: 'USD', amount: '0.000015' },
          latencyMs: 12,
        },
        providerMetadata: {},
      }),
  };
}

function routerWith(versions: readonly ApiVersion[], auth: AuthMiddleware) {
  const providers = createProviderRegistry();
  providers.register(provider());
  providers.seal();

  return createAiRouter({
    controllers: createAiControllers({
      gateway: createGateway({
        directory,
        flags,
        providers,
        prompts: createPromptCatalogue([TEMPLATE]),
      }),
      dispatcher: createProviderDispatcher({ providers }),
      jobs: { findById: () => Promise.resolve(null) },
      workflows: { findById: () => Promise.resolve(null) },
      providers,
      version: '2.0.0-conformance',
    }),
    auth,
    versions: createVersionRegistry({ versions }),
    ...collaborators(),
  });
}

const request = (path: string): ApiRequest => ({
  method: 'GET',
  path,
  params: {},
  query: {},
  headers: {
    'x-request-id': 'req-1',
    'x-correlation-id': CORRELATION,
    authorization: 'Bearer token',
    'x-workspace-id': WS,
  },
  body: null,
});

// ── 1 · Version negotiation in the pipeline ─────────────────────────────────

describe('version negotiation, end to end', () => {
  it('serves a current version and names it on the response', async () => {
    const response = (await routerWith(
      [V1],
      countingAuth().middleware,
    )(request('/v1/ai/providers'))) as ApiResponse;

    expect(response.status).toBe(200);
    expect(response.headers['api-version']).toBe('v1');
  });

  it('rejects an unknown version with 400 rather than defaulting', async () => {
    // "Defaulting to the newest lets an attacker probe for a version with
    // weaker checks."
    const response = (await routerWith(
      [V1],
      countingAuth().middleware,
    )(request('/v99/ai/providers'))) as ApiResponse;

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.code).toBe('unsupported_version');
    // The current version is named, which is the actionable part.
    expect(response.headers['api-version']).toBe('v1');
  });

  it('retires a sunset version with 410, never a fallback', async () => {
    // Serving it as the current version would apply the current version's
    // authorization semantics to a client expecting another.
    const response = (await routerWith(
      [{ ...V1_DEPRECATED, status: 'sunset' }, V2],
      countingAuth().middleware,
    )(request('/v1/ai/providers'))) as ApiResponse;

    expect(response.status).toBe(410);
    expect((response.body as ErrorBody).error.code).toBe('version_retired');
    expect(response.headers['link']).toContain('rel="deprecation"');
  });

  it('refuses a bad version BEFORE authenticating', async () => {
    // The supported set is published in the OpenAPI document, so refusing an
    // unsupported version discloses nothing already public — and a client
    // pinned to a retired version gets the 410 that tells it to migrate rather
    // than a 401 that sends it looking at its credentials.
    const auth = countingAuth();
    await routerWith([V1], auth.middleware)(request('/v99/ai/providers'));
    expect(auth.authentications).toEqual([]);

    await routerWith([V1], auth.middleware)(request('/v1/ai/providers'));
    expect(auth.authentications).toHaveLength(1);
  });

  it('announces a deprecation on every response, success and error alike', async () => {
    // "The header is the only channel that reaches a client integrated two
    // years ago." A client whose calls are failing is exactly the one about to
    // investigate.
    const route = routerWith([V1_DEPRECATED, V2], countingAuth().middleware);

    const ok = (await route(request('/v1/ai/providers'))) as ApiResponse;
    const missing = (await route(request('/v1/ai/nope'))) as ApiResponse;

    for (const response of [ok, missing]) {
      expect(response.headers['deprecation']).toBe('Sun, 01 Mar 2026 00:00:00 GMT');
      expect(response.headers['sunset']).toBe('Tue, 01 Sep 2026 00:00:00 GMT');
      expect(response.headers['link']).toContain('https://docs.contentos.ai/api/v2/migration');
    }
    expect(ok.status).toBe(200);
    expect(missing.status).toBe(404);
  });

  it('runs two versions in parallel, as the process requires', async () => {
    // "Both versions run in parallel from the moment the new one ships."
    const route = routerWith([V1_DEPRECATED, { ...V2, version: 'v2' }], countingAuth().middleware);
    const old = (await route(request('/v1/ai/providers'))) as ApiResponse;

    expect(old.status).toBe(200);
    expect(old.headers['api-version']).toBe('v1');
  });

  it('changes no endpoint behaviour — only headers are added', async () => {
    const plain = (await routerWith(
      [V1],
      countingAuth().middleware,
    )(request('/v1/ai/providers'))) as ApiResponse;
    const deprecated = (await routerWith(
      [V1_DEPRECATED, V2],
      countingAuth().middleware,
    )(request('/v1/ai/providers'))) as ApiResponse;

    expect(deprecated.status).toBe(plain.status);
    expect(deprecated.body).toEqual(plain.body);
  });
});

// ── 2 · The document describes the running router ───────────────────────────

const registry = createVersionRegistry({ versions: [V1] });
const document = createOpenApiDocument({ registry, serviceVersion: '2.0.0-conformance' });

describe('the published contract describes the running API', () => {
  it('validates', () => {
    expect(validateOpenApiDocument(document)).toEqual({ ok: true });
  });

  it('documents every reachable endpoint, exactly once', () => {
    const documented = Object.entries(document.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    );
    const reachable = AI_ROUTES.map((route) => `${route.method} ${toOpenApiPath(route.pattern)}`);

    expect([...documented].sort()).toEqual([...reachable].sort());
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('promises the statuses the router actually returns', async () => {
    const route = routerWith([V1], countingAuth().middleware);
    const documented = document.paths['/v1/ai/providers']?.['get']?.responses ?? {};

    const found = (await route(request('/v1/ai/providers'))) as ApiResponse;
    const missing = (await route(request('/v1/ai/nope'))) as ApiResponse;

    expect(Object.keys(documented)).toContain(String(found.status));
    expect(Object.keys(documented)).toContain(String(missing.status));
  });

  it('documents every code the envelope can carry', () => {
    // The status table in the generator is a Record over ApiErrorCode, so a new
    // code fails to compile until documented. This asserts the result.
    const enumerated =
      document.components.schemas['Error']?.properties?.['error']?.properties?.['code']?.enum ?? [];
    expect([...enumerated].sort()).toEqual(Object.keys(API_ERROR_MESSAGES).sort());
  });

  it('documents a request body matching what the validator accepts', () => {
    const properties = document.components.schemas['ExecuteRequest']?.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(
      EXECUTION_BODY_FIELDS.map((field) => field.name).sort(),
    );
  });

  it('documents the tenancy fields as REJECTED rather than omitting them silently', () => {
    const schema = document.components.schemas['ExecuteRequest'];
    expect(schema?.description).toContain('REJECTED');
    expect(schema?.additionalProperties).toBe(false);
  });

  it('serializes to stable bytes, so a contract diff is reviewable', () => {
    const again = createOpenApiDocument({ registry, serviceVersion: '2.0.0-conformance' });
    expect(serializeOpenApiDocument(document)).toBe(serializeOpenApiDocument(again));
  });

  it('names no Redis key, policy name, fingerprint or internal path anywhere', () => {
    const json = serializeOpenApiDocument(document);
    expect(json).not.toContain('cos:');
    expect(json).not.toContain('ZREMRANGEBYSCORE');
    expect(json).not.toContain('fingerprint');
    expect(json).not.toContain('services/api');
  });
});

// ── 3 · Divergence from the canonical endpoint registry ─────────────────────

describe('divergence from `06-api/api-reference.md`, on the record', () => {
  const registryDoc = readFileSync(
    fileURLToPath(new URL('../../contentos-docs/06-api/api-reference.md', import.meta.url)),
    'utf8',
  );

  it('RECORDS: the canonical registry lists none of these six paths', () => {
    // `api-reference.md` rule 1: "This document is canonical; where it
    // disagrees with another API document, this one wins." Rule 8: "An endpoint
    // absent from this registry does not exist." The registry lists
    // `/v1/workspaces/{workspaceId}/ai/generate|review|council|usage`; these six
    // are the platform-facing surface S3.2 was asked for, and this increment is
    // the one that PUBLISHES them. Reconciling the two is a decision, not a
    // detail, so it is recorded rather than made here.
    for (const route of AI_ROUTES) {
      expect(registryDoc, route.pattern).not.toContain(route.pattern);
    }
    expect(registryDoc).toContain('/v1/workspaces/{workspaceId}/ai/generate');
  });

  it('honours the conventions the registry does state', () => {
    // Rule 3: "Every customer endpoint carries /v1." Rule 4: "Probes are
    // unversioned" — the liveness and readiness probes live outside /v1 and are
    // deliberately absent from this document.
    for (const route of AI_ROUTES) {
      expect(route.pattern.startsWith('/v1/'), route.pattern).toBe(true);
    }
    expect(Object.keys(document.paths).every((path) => path.startsWith('/v1/'))).toBe(true);
    expect(Object.keys(document.paths)).not.toContain('/health/live');
  });

  it('uses no PUT, which rule 6 forbids', () => {
    for (const item of Object.values(document.paths)) {
      expect(Object.keys(item)).not.toContain('put');
    }
  });
});
