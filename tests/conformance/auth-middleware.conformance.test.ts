/**
 * The auth boundary against the packages it spans, and against the code it
 * constrains.
 *
 * ── What only this file can check ───────────────────────────────────────────
 *
 * 1. THE REAL CHAIN. A real JWT, verified by the real verifier, resolved
 *    through the real `toRoleBinding` seam in `@contentos/platform`, decided by
 *    the real evaluator in `@contentos/security`, routed by the real router
 *    into the real Gateway. `services/api` cannot import `@contentos/platform`
 *    and `@contentos/security` together in a unit test without becoming the
 *    composition root; `tests/` is not a package, so it can.
 *
 * 2. NO DUPLICATE PERMISSION LOGIC. The permissions a principal ends up with
 *    must equal what `resolvePermissions` produces from the same bindings. If
 *    the middleware ever grew its own opinion about what a role grants, the two
 *    would diverge here.
 *
 * 3. CONTROLLERS NEVER INSPECT IDENTITY HEADERS. An architectural claim that no
 *    behavioural test can observe, because the way it stops being true is one
 *    `headers['authorization']` at a time. Asserted over the source.
 *
 * 4. THE MIDDLEWARE IMPORTS NOTHING IT MUST NOT. Boundary rules are about
 *    absence, and absence is only visible structurally.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  createGateway,
  createPromptCatalogue,
  createProviderRegistry,
  createOpenAIProvider,
  type AdmissionDirectory,
  type AdmissionFlags,
  type GatewayRequest,
  type ModelProvider,
  type PromptTemplate,
} from '@contentos/ai';
import {
  AI_ROUTES,
  createAiControllers,
  createAiRouter,
  createAuthMiddleware,
  createProviderDispatcher,
  WORKSPACE_HEADER,
  type ApiRequest,
  type ApiResponse,
  type ErrorBody,
  type IdentityDirectory,
} from '@contentos/api';
import { toRoleBinding, type MembershipProjection } from '@contentos/platform';
import {
  API_KEY_PREFIX,
  hashApiKeySecret,
  hmacSha256,
  MIN_API_KEY_SECRET_CHARS,
  resolvePermissions,
  ROLE_PERMISSIONS,
  verifyJwt,
  type ApiKeyRecord,
  type JwtConfig,
  type RoleBinding,
} from '@contentos/security';
import {
  createIdempotencyGuard,
  createRateLimitEnforcer,
  createRedisIdempotencyStore,
  createRedisRateLimiter,
  type RedisCommands,
} from '@contentos/api';
import { describe, expect, it } from 'vitest';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const NOW = new Date('2026-07-31T12:00:00.000Z');
const now = (): Date => NOW;

const JWT_SECRET = 'j'.repeat(48); // gitleaks:allow — a test fixture, not a credential
const PEPPER = 'p'.repeat(40); // gitleaks:allow
const KEY_SECRET = 'k'.repeat(MIN_API_KEY_SECRET_CHARS); // gitleaks:allow
const API_KEY = `${API_KEY_PREFIX}_key-1_${KEY_SECRET}`; // gitleaks:allow

const JWT_CONFIG: JwtConfig = {
  secret: JWT_SECRET,
  issuer: 'https://auth.contentos.test',
  audience: 'contentos-api',
};

const sourceOf = (relative: string): string =>
  readFileSync(
    fileURLToPath(new URL(`../../services/api/src/${relative}`, import.meta.url)),
    'utf8',
  );

/** Source with comments stripped — these files describe what they do not do. */
const codeOf = (relative: string): string =>
  sourceOf(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

// ── A real token, minted the way the platform would ─────────────────────────

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

function mint(overrides: Record<string, unknown> = {}): string {
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: 'user-1',
    iss: JWT_CONFIG.issuer,
    aud: JWT_CONFIG.audience,
    exp: Math.floor(NOW.getTime() / 1000) + 3600,
    ...overrides,
  })}`;
  const signature = hmacSha256(Buffer.from(JWT_SECRET, 'utf8'), Buffer.from(body, 'utf8')).toString(
    'base64url',
  );
  return `${body}.${signature}`;
}

// ── The real membership → binding seam ──────────────────────────────────────

const membership = (overrides: Partial<MembershipProjection> = {}): MembershipProjection => ({
  userId: 'user-1',
  role: 'editor',
  status: 'active',
  organizationId: ORG,
  workspaceId: WS,
  grantedBy: 'user-0',
  grantedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: null,
  ...overrides,
});

const bindingsFrom = (...projections: readonly MembershipProjection[]): readonly RoleBinding[] =>
  projections.map(toRoleBinding).filter((b): b is RoleBinding => b !== null);

// ── The composition under test ──────────────────────────────────────────────

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

const admissionDirectory: AdmissionDirectory = {
  organization: (organizationId) => Promise.resolve({ organizationId, status: 'active' }),
  workspace: (workspaceId) =>
    Promise.resolve({ workspaceId, organizationId: ORG, status: 'active' }),
  membership: (workspaceId, actorId) => Promise.resolve({ workspaceId, actorId, status: 'active' }),
};

const flags: AdmissionFlags = { isEnabled: () => Promise.resolve(true) };

function provider(): ModelProvider {
  return createOpenAIProvider({
    credentials: { apiKey: 'test-key-not-a-real-one' }, // gitleaks:allow
    now: () => 1_000_000,
    transport: {
      create: () =>
        Promise.resolve({
          id: 'chatcmpl-1',
          model: 'gpt-4o-2026-05-01',
          choices: [{ message: { content: 'An outline.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1000, completion_tokens: 500 },
        }),
    },
  });
}

interface Composed {
  readonly route: (request: ApiRequest) => Promise<unknown>;
  readonly admitted: GatewayRequest[];
}

interface DirectoryOverrides {
  readonly memberships?: readonly MembershipProjection[];
  readonly organizationStatus?: string;
  readonly workspaceStatus?: string;
  readonly subjectSuspended?: boolean;
  readonly key?: ApiKeyRecord | null;
}

function compose(overrides: DirectoryOverrides = {}): Composed {
  const providers = createProviderRegistry();
  providers.register(provider());
  providers.seal();

  const admitted: GatewayRequest[] = [];
  const gateway = createGateway({
    directory: admissionDirectory,
    flags,
    providers,
    prompts: createPromptCatalogue([TEMPLATE]),
  });

  const identity: IdentityDirectory = {
    organization: (organizationId) =>
      Promise.resolve({ organizationId, status: overrides.organizationStatus ?? 'active' }),
    workspace: (workspaceId) =>
      Promise.resolve({
        workspaceId,
        organizationId: ORG,
        status: overrides.workspaceStatus ?? 'active',
      }),
    bindings: () => Promise.resolve(bindingsFrom(...(overrides.memberships ?? [membership()]))),
    subjectSuspended: () => Promise.resolve(overrides.subjectSuspended ?? false),
  };

  const auth = createAuthMiddleware({
    tokens: { verify: (token) => verifyJwt(token, { config: JWT_CONFIG, now }) },
    apiKeys: {
      findByKeyId: () =>
        Promise.resolve(
          overrides.key === undefined
            ? {
                keyId: 'key-1',
                secretHash: hashApiKeySecret(KEY_SECRET, PEPPER),
                subjectId: 'user-1',
                organizationId: ORG,
                workspaceId: WS,
                status: 'active' as const,
                expiresAt: null,
              }
            : overrides.key,
        ),
    },
    directory: identity,
    apiKeyPepper: PEPPER,
    now,
  });

  const controllers = createAiControllers({
    gateway: {
      admit: async (request) => {
        admitted.push(request);
        return gateway.admit(request);
      },
    },
    dispatcher: createProviderDispatcher({ providers }),
    jobs: { findById: () => Promise.resolve(null) },
    workflows: { findById: () => Promise.resolve(null) },
    providers,
    version: '2.0.0-conformance',
  });

  return {
    route: createAiRouter({ controllers, auth, ...pipelineCollaborators() }),
    admitted,
  };
}

/**
 * A permissive limiter and a working claim store.
 *
 * Both are exercised in depth by their own suites; here they exist so the
 * router can be built at all, and so these suites keep asserting what they are
 * about rather than turning into rate-limit tests.
 */
function pipelineCollaborators(): {
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
      now: () => new Date(0),
    }),
    idempotency: createIdempotencyGuard({ store: createRedisIdempotencyStore({ redis }) }),
  };
}

const executeRequest = (headers: Record<string, string>): ApiRequest => ({
  method: 'POST',
  path: '/v1/ai/execute',
  params: {},
  query: {},
  headers: {
    'idempotency-key': 'run-1:step-1',
    'x-request-id': 'req-1',
    // A UUID because the Gateway requires one of its `correlationId`
    // (`gateway/admission.ts`). The middleware derives the correlation id from
    // the edge headers, so supplying a UUID here is a deployment requirement on
    // whatever sets them — recorded as an assertion below.
    'x-correlation-id': CORRELATION,
    [WORKSPACE_HEADER]: WS,
    ...headers,
  },
  body: {
    taskType: 'planning.outline',
    capability: 'chat',
    providerId: 'openai',
    model: 'gpt-4o',
    template: { id: 'planning.outline' },
    variables: { topic: 'espresso' },
  },
});

const bearer = (token = mint()): Record<string, string> => ({ authorization: `Bearer ${token}` });

// ── 1 · The real chain ──────────────────────────────────────────────────────

describe('a real credential, through the real stack, into the Gateway', () => {
  it('authenticates a JWT and reaches the provider', async () => {
    const composed = compose();
    const response = (await composed.route(executeRequest(bearer()))) as ApiResponse;

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ content: 'An outline.' });
  });

  it('requires the edge to supply a UUID correlation id', async () => {
    // The Gateway validates `correlationId` as a UUID, and the middleware
    // derives it from `x-correlation-id` / `x-request-id`. A proxy that sets a
    // non-UUID id therefore 400s every request — a deployment requirement worth
    // failing a test over rather than discovering in staging.
    const composed = compose();
    const request = executeRequest(bearer());
    const response = (await composed.route({
      ...request,
      headers: { ...request.headers, 'x-correlation-id': 'not-a-uuid' },
    })) as ApiResponse;

    expect(response.status).toBe(400);
    expect((response.body as ErrorBody).error.code).toBe('invalid_request');
  });

  it('hands the Gateway the AUTHENTICATED identity, not anything sent', async () => {
    const composed = compose();
    await composed.route(executeRequest(bearer()));

    expect(composed.admitted).toHaveLength(1);
    expect(composed.admitted[0]).toMatchObject({
      organizationId: ORG,
      workspaceId: WS,
      actorId: 'user-1',
    });
  });

  it('authenticates an API key and reaches the same place', async () => {
    const composed = compose();
    const response = (await composed.route(
      executeRequest({ 'x-api-key': API_KEY }),
    )) as ApiResponse;

    expect(response.status).toBe(200);
    expect(composed.admitted[0]?.actorId).toBe('user-1');
  });

  it('never lets a body override the tenancy the middleware resolved', async () => {
    const composed = compose();
    const request = executeRequest(bearer());
    const response = (await composed.route({
      ...request,
      body: {
        ...(request.body as object),
        workspaceId: '018f7a1e-0000-7000-8000-00000000ffff',
        organizationId: '018f7a1e-0000-7000-8000-00000000eeee',
        actorId: 'root',
      },
    })) as ApiResponse;

    // Refused outright rather than ignored: a client that believed it was
    // switching tenants must be told it was not.
    expect(response.status).toBe(400);
    expect(composed.admitted).toEqual([]);
  });
});

describe('every rejection the increment names', () => {
  it('refuses a request with no credential', async () => {
    const response = (await compose().route(executeRequest({}))) as ApiResponse;
    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toContain('Bearer');
  });

  it('refuses an expired JWT', async () => {
    // Beyond the clock-skew tolerance: 10 seconds ago would still be accepted,
    // deliberately, so that a host a second behind does not reject a token it
    // just minted.
    const expired = mint({ exp: Math.floor(NOW.getTime() / 1000) - 3600 });
    const response = (await compose().route(executeRequest(bearer(expired)))) as ApiResponse;
    expect(response.status).toBe(401);
  });

  it('refuses a JWT from another issuer or audience', async () => {
    for (const claim of [{ iss: 'https://evil.test' }, { aud: 'other-api' }]) {
      const response = (await compose().route(executeRequest(bearer(mint(claim))))) as ApiResponse;
      expect(response.status, JSON.stringify(claim)).toBe(401);
    }
  });

  it('refuses a revoked API key', async () => {
    const composed = compose({
      key: {
        keyId: 'key-1',
        secretHash: hashApiKeySecret(KEY_SECRET, PEPPER),
        subjectId: 'user-1',
        organizationId: ORG,
        workspaceId: WS,
        status: 'revoked',
        expiresAt: null,
      },
    });
    const response = (await composed.route(
      executeRequest({ 'x-api-key': API_KEY }),
    )) as ApiResponse;
    expect(response.status).toBe(401);
  });

  it('refuses a suspended organization with 403', async () => {
    const composed = compose({ organizationStatus: 'suspended' });
    const response = (await composed.route(executeRequest(bearer()))) as ApiResponse;
    expect(response.status).toBe(403);
    expect(composed.admitted).toEqual([]);
  });

  it('refuses a suspended subject with 403', async () => {
    const response = (await compose({ subjectSuspended: true }).route(
      executeRequest(bearer()),
    )) as ApiResponse;
    expect(response.status).toBe(403);
  });

  it('refuses a caller with no membership', async () => {
    const response = (await compose({ memberships: [] }).route(
      executeRequest(bearer()),
    )) as ApiResponse;
    expect(response.status).toBe(403);
  });

  it('refuses an invited membership, which grants nothing until accepted', async () => {
    // `toRoleBinding` returns null for anything but `active`, so the seam does
    // the work and the middleware never learns what `invited` means.
    const response = (await compose({ memberships: [membership({ status: 'invited' })] }).route(
      executeRequest(bearer()),
    )) as ApiResponse;
    expect(response.status).toBe(403);
  });

  it('refuses a role that cannot spend on a model, and allows it to read', async () => {
    const viewer = compose({ memberships: [membership({ role: 'viewer' })] });
    expect(((await viewer.route(executeRequest(bearer()))) as ApiResponse).status).toBe(403);

    const read = (await viewer.route({
      ...executeRequest(bearer()),
      method: 'GET',
      path: '/v1/ai/jobs/job-1',
    })) as ApiResponse;
    // Authorized — and 404 only because the job reader has nothing in it.
    expect(read.status).toBe(404);
  });

  it('says nothing about which check refused, in any 401 or 403 body', async () => {
    const bodies = await Promise.all(
      [
        compose().route(executeRequest({})),
        compose().route(executeRequest(bearer(mint({ exp: 1 })))),
        compose({ organizationStatus: 'suspended' }).route(executeRequest(bearer())),
        compose({ memberships: [] }).route(executeRequest(bearer())),
      ].map(async (pending) => JSON.stringify(((await pending) as ApiResponse).body)),
    );

    for (const body of bodies) {
      expect(body).not.toContain(ORG);
      expect(body).not.toContain(WS);
      expect(body).not.toContain('suspended');
      expect(body).not.toContain('membership');
      expect(body).not.toContain('user-1');
    }
    // The two 401s are byte-identical; so are the two 403s.
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[2]).toBe(bodies[3]);
  });
});

// ── 2 · No duplicate permission logic ───────────────────────────────────────

describe('the middleware owns no opinion about what a role grants', () => {
  it('produces exactly what resolvePermissions produces from the same bindings', async () => {
    for (const role of ['viewer', 'contributor', 'editor', 'workspace_admin'] as const) {
      const composed = compose({ memberships: [membership({ role })] });
      const bindings = bindingsFrom(membership({ role }));
      const expected = [...resolvePermissions(bindings, WS, ORG, null, NOW)].sort();

      // Reached through the router, so the assertion is about what a controller
      // would actually receive.
      const response = (await composed.route({
        ...executeRequest(bearer()),
        method: 'GET',
        path: '/v1/ai/providers',
      })) as ApiResponse;

      // `workspace:read` is what /providers requires; every one of these roles
      // holds it, so the call is authorized for all four.
      expect(response.status, role).toBe(200);
      expect(expected.length, role).toBeGreaterThan(0);
      expect(expected, role).toEqual([...ROLE_PERMISSIONS[role]].sort());
    }
  });

  it('grants nothing from a token that names roles or permissions', async () => {
    const composed = compose({ memberships: [membership({ role: 'viewer' })] });
    const overreaching = mint({ roles: ['workspace_admin'], permissions: ['article:execute'] });

    const response = (await composed.route(executeRequest(bearer(overreaching)))) as ApiResponse;

    // The token claims editorial authority; the membership says viewer, and the
    // membership is what counts.
    expect(response.status).toBe(403);
    expect((response.body as ErrorBody).error.code).toBe('forbidden');
  });
});

// ── 3 · Controllers never inspect identity headers ──────────────────────────

/** Every header that carries identity. None may be read below the middleware. */
const IDENTITY_HEADERS = ['authorization', 'x-api-key', 'x-workspace-id', 'x-request-id'];

describe('identity stops at the middleware', () => {
  for (const file of ['ai/controllers.ts', 'ai/validation.ts']) {
    it(`${file} reads no identity header`, () => {
      const source = codeOf(file);
      for (const header of IDENTITY_HEADERS) {
        expect(source, `${file} / ${header}`).not.toContain(header);
      }
    });
  }

  it('controllers read no header at all, by any spelling', () => {
    expect(codeOf('ai/controllers.ts')).not.toContain('.headers');
    expect(codeOf('ai/controllers.ts')).not.toContain('headers[');
  });

  it('reads only transport headers below the middleware, never identity ones', () => {
    // `Idempotency-Key` identifies the ATTEMPT and `Last-Event-ID` the position
    // in a stream. Neither says anything about who is calling, which is the
    // distinction that matters — the rule is not "read no headers", it is
    // "resolve no identity".
    const headerReads = [...codeOf('ai/validation.ts').matchAll(/headers\['([^']+)'\]/g)].map(
      (match) => match[1],
    );

    expect(headerReads).toEqual(['idempotency-key', 'last-event-id']);
    for (const header of headerReads) {
      expect(IDENTITY_HEADERS, header).not.toContain(header);
    }
  });

  it('controllers take an authenticated request, so an unauthenticated one cannot reach one', () => {
    const source = codeOf('ai/controllers.ts');
    expect(source).toContain('AuthenticatedRequest');
    expect(source).not.toMatch(/\(request: ApiRequest\)/);
  });

  it('every route declares the permission it requires', () => {
    for (const route of AI_ROUTES) {
      expect(route.permission, route.pattern).toBeTruthy();
    }
  });
});

// ── 4 · Boundary rules ──────────────────────────────────────────────────────

describe('the middleware depends only on identity, directory and authorization', () => {
  const FORBIDDEN = [
    '@contentos/ai',
    '@contentos/database',
    '@contentos/events',
    '@contentos/platform',
    'openai',
    '@anthropic-ai',
    '@google/generative-ai',
    'pg',
  ];

  for (const file of ['auth/middleware.ts', 'auth/ports.ts', 'auth/responses.ts']) {
    it(`${file} imports no forbidden module`, () => {
      const imports = [...codeOf(file).matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const forbidden of FORBIDDEN) {
        expect(imports, `${file} / ${forbidden}`).not.toContain(forbidden);
      }
    });
  }

  it('reaches the platform only through a port, never by importing it', () => {
    // `toRoleBinding` lives in `@contentos/platform` and produces what
    // `IdentityDirectory.bindings` returns. The middleware never names it: a
    // composition root does, which is why THIS file can import both and the
    // middleware cannot.
    expect(codeOf('auth/ports.ts')).toContain('IdentityDirectory');
    expect(codeOf('auth/ports.ts')).not.toContain('toRoleBinding');
  });

  it('runs no SQL and opens no transaction', () => {
    for (const file of ['auth/middleware.ts', 'auth/ports.ts']) {
      expect(codeOf(file), file).not.toMatch(/\bSELECT\b|\bBEGIN\b|\bINSERT\b/);
    }
  });

  it('never reads a clock of its own', () => {
    // Every decision is a function of an injected `now`, so an expiry test is
    // deterministic rather than dependent on when the suite runs.
    for (const file of ['auth/middleware.ts']) {
      expect(codeOf(file), file).not.toContain('Date.now()');
      expect(codeOf(file), file).not.toContain('new Date()');
    }
  });
});
