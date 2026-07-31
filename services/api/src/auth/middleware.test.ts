import {
  API_KEY_PREFIX,
  hashApiKeySecret,
  MIN_API_KEY_SECRET_CHARS,
  type ApiKeyRecord,
  type AuthenticationResult,
  type AuthorizationResult,
  type RoleBinding,
} from '@contentos/security';
import { describe, expect, it } from 'vitest';

import type { ApiRequest } from '../ai/http.js';
import {
  createAuthMiddleware,
  presentedCredential,
  requestIdsOf,
  WORKSPACE_HEADER,
  type AuthMiddlewareOptions,
} from './middleware.js';
import type { ApiKeyDirectory, IdentityDirectory } from './ports.js';

const ORG = 'org-1';
const WS = 'ws-1';
const NOW = new Date('2026-07-31T12:00:00.000Z');
const now = (): Date => NOW;

const PEPPER = 'p'.repeat(40); // gitleaks:allow — a test fixture, not a credential
const SECRET = 's'.repeat(MIN_API_KEY_SECRET_CHARS); // gitleaks:allow
const API_KEY = `${API_KEY_PREFIX}_key-1_${SECRET}`; // gitleaks:allow

const TOKEN_SUBJECT: AuthenticationResult = {
  outcome: 'authenticated',
  subject: {
    subjectId: 'user-1',
    kind: 'user',
    authenticatedAt: NOW,
    method: 'password',
    mfaSatisfied: true,
    sessionId: 'session-1',
  },
  organizationId: null,
  workspaceId: null,
};

const binding = (overrides: Partial<RoleBinding> = {}): RoleBinding => ({
  subjectId: 'user-1',
  subjectKind: 'user',
  role: 'editor',
  tier: 'workspace',
  organizationId: ORG,
  workspaceId: WS,
  projectScope: null,
  grantedBy: 'user-0',
  grantedAt: new Date('2026-01-01T00:00:00.000Z'),
  expiresAt: null,
  status: 'active',
  ...overrides,
});

const apiKeyRecord = (overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({
  keyId: 'key-1',
  secretHash: hashApiKeySecret(SECRET, PEPPER),
  subjectId: 'user-1',
  organizationId: ORG,
  workspaceId: WS,
  status: 'active',
  expiresAt: null,
  ...overrides,
});

interface Harness {
  readonly organizationStatus?: string;
  readonly workspaceStatus?: string;
  readonly workspaceOrganizationId?: string;
  readonly bindings?: readonly RoleBinding[];
  readonly subjectSuspended?: boolean;
  readonly unknownWorkspace?: boolean;
  readonly unknownOrganization?: boolean;
  readonly key?: ApiKeyRecord | null;
  readonly token?: AuthenticationResult;
}

function middleware(harness: Harness = {}): ReturnType<typeof createAuthMiddleware> {
  const directory: IdentityDirectory = {
    organization: (organizationId) =>
      Promise.resolve(
        harness.unknownOrganization === true
          ? null
          : { organizationId, status: harness.organizationStatus ?? 'active' },
      ),
    workspace: (workspaceId) =>
      Promise.resolve(
        harness.unknownWorkspace === true
          ? null
          : {
              workspaceId,
              organizationId: harness.workspaceOrganizationId ?? ORG,
              status: harness.workspaceStatus ?? 'active',
            },
      ),
    bindings: () => Promise.resolve(harness.bindings ?? [binding()]),
    subjectSuspended: () => Promise.resolve(harness.subjectSuspended ?? false),
  };

  const apiKeys: ApiKeyDirectory = {
    findByKeyId: () => Promise.resolve(harness.key === undefined ? apiKeyRecord() : harness.key),
  };

  const options: AuthMiddlewareOptions = {
    tokens: { verify: () => harness.token ?? TOKEN_SUBJECT },
    apiKeys,
    directory,
    apiKeyPepper: PEPPER,
    now,
  };
  return createAuthMiddleware(options);
}

const request = (headers: Record<string, string> = {}): ApiRequest => ({
  method: 'POST',
  path: '/v1/ai/execute',
  params: {},
  query: {},
  headers: { authorization: 'Bearer token', [WORKSPACE_HEADER]: WS, ...headers },
  body: null,
});

async function authorize(
  harness: Harness = {},
  headers: Record<string, string> = {},
  permission: Parameters<
    ReturnType<typeof createAuthMiddleware>['authorize']
  >[2] = 'article:execute',
): Promise<AuthorizationResult> {
  const middlewareUnderTest = middleware(harness);
  const authenticated = await middlewareUnderTest.authenticate(request(headers));
  if (authenticated.outcome !== 'authenticated') throw new Error('expected authentication');
  return middlewareUnderTest.authorize(authenticated, request(headers), permission);
}

// ── Credential extraction ────────────────────────────────────────────────────

describe('which credential was presented', () => {
  it('reads a bearer token', () => {
    expect(presentedCredential(request({ authorization: 'Bearer abc.def.ghi' }))).toEqual({
      kind: 'bearer',
      value: 'abc.def.ghi',
    });
  });

  it('is case-insensitive about the scheme, as RFC 7235 requires', () => {
    expect(presentedCredential(request({ authorization: 'bearer abc' }))).toMatchObject({
      kind: 'bearer',
    });
    expect(presentedCredential(request({ authorization: 'BEARER abc' }))).toMatchObject({
      kind: 'bearer',
    });
  });

  it('reads an API key from either the scheme or its own header', () => {
    expect(presentedCredential(request({ authorization: `ApiKey ${API_KEY}` }))).toEqual({
      kind: 'api-key',
      value: API_KEY,
    });
    expect(presentedCredential({ ...request(), headers: { 'x-api-key': API_KEY } })).toEqual({
      kind: 'api-key',
      value: API_KEY,
    });
  });

  it('reports no credential when neither header carries one', () => {
    expect(presentedCredential({ ...request(), headers: {} })).toEqual({ kind: 'none' });
    expect(presentedCredential({ ...request(), headers: { authorization: '   ' } })).toEqual({
      kind: 'none',
    });
  });

  it('refuses two credentials at once rather than picking one', () => {
    // Silently preferring one means the credential actually checked is not the
    // one the caller thinks was checked.
    expect(
      presentedCredential({
        ...request(),
        headers: { authorization: 'Bearer abc', 'x-api-key': API_KEY },
      }),
    ).toEqual({ kind: 'ambiguous' });
  });

  it('refuses a scheme it does not implement', () => {
    for (const authorization of ['Basic dXNlcjpwYXNz', 'Negotiate abc', 'Bearer', 'abc']) {
      expect(
        presentedCredential({ ...request(), headers: { authorization } }),
        authorization,
      ).toEqual({ kind: 'unsupported' });
    }
  });
});

// ── Authentication ───────────────────────────────────────────────────────────

describe('authentication', () => {
  it('reports a missing credential as missing', async () => {
    await expect(middleware().authenticate({ ...request(), headers: {} })).resolves.toEqual({
      outcome: 'failed',
      reason: 'missing',
    });
  });

  it('reports an ambiguous or unsupported credential as malformed', async () => {
    const both = { authorization: 'Bearer a', 'x-api-key': API_KEY };
    await expect(middleware().authenticate({ ...request(), headers: both })).resolves.toEqual({
      outcome: 'failed',
      reason: 'malformed',
    });
    await expect(
      middleware().authenticate({ ...request(), headers: { authorization: 'Basic abc' } }),
    ).resolves.toEqual({ outcome: 'failed', reason: 'malformed' });
  });

  it('delegates a bearer token to the verifier', async () => {
    await expect(middleware().authenticate(request())).resolves.toEqual(TOKEN_SUBJECT);
  });

  it('passes a verifier failure through unchanged', async () => {
    await expect(
      middleware({ token: { outcome: 'failed', reason: 'expired' } }).authenticate(request()),
    ).resolves.toEqual({ outcome: 'failed', reason: 'expired' });
  });

  it('authenticates a valid API key', async () => {
    const result = await middleware().authenticate({
      ...request(),
      headers: { 'x-api-key': API_KEY },
    });
    expect(result).toMatchObject({
      outcome: 'authenticated',
      subject: { subjectId: 'user-1', kind: 'api-key', method: 'api-key' },
      organizationId: ORG,
      workspaceId: WS,
    });
  });

  it('refuses a key of the wrong shape before any lookup', async () => {
    await expect(
      middleware().authenticate({ ...request(), headers: { 'x-api-key': 'nonsense' } }),
    ).resolves.toEqual({ outcome: 'failed', reason: 'malformed' });
  });

  it('answers for an unknown key id exactly as for a wrong secret', async () => {
    // Otherwise a caller can enumerate valid ids without ever holding one.
    const unknown = await middleware({ key: null }).authenticate({
      ...request(),
      headers: { 'x-api-key': API_KEY },
    });
    const wrongSecret = await middleware().authenticate({
      ...request(),
      headers: { 'x-api-key': `${API_KEY_PREFIX}_key-1_${'x'.repeat(MIN_API_KEY_SECRET_CHARS)}` },
    });
    expect(unknown).toEqual({ outcome: 'failed', reason: 'invalid' });
    expect(unknown).toEqual(wrongSecret);
  });

  it('reports a revoked key as revoked', async () => {
    await expect(
      middleware({ key: apiKeyRecord({ status: 'revoked' }) }).authenticate({
        ...request(),
        headers: { 'x-api-key': API_KEY },
      }),
    ).resolves.toEqual({ outcome: 'failed', reason: 'revoked' });
  });

  it('reports an expired key as expired', async () => {
    await expect(
      middleware({ key: apiKeyRecord({ expiresAt: new Date(NOW.getTime() - 1) }) }).authenticate({
        ...request(),
        headers: { 'x-api-key': API_KEY },
      }),
    ).resolves.toEqual({ outcome: 'failed', reason: 'expired' });
  });
});

// ── Authorization ────────────────────────────────────────────────────────────

describe('authorization', () => {
  it('authorizes a member holding the permission', async () => {
    const result = await authorize();
    expect(result.outcome).toBe('authorized');
  });

  it('resolves the organization from the workspace, never from the caller', async () => {
    const result = await authorize(
      { workspaceOrganizationId: 'org-from-directory' },
      {},
      'run:read',
    );
    // No membership in that organization, so it denies — the point being that
    // the organization came from the directory and not from anything sent.
    expect(result).toEqual({ outcome: 'denied', reason: 'membership-required' });
  });

  it('denies an unknown workspace without saying it is unknown', async () => {
    expect(await authorize({ unknownWorkspace: true })).toEqual({
      outcome: 'denied',
      reason: 'workspace-unknown',
    });
  });

  it('denies when no workspace was named at all', async () => {
    const middlewareUnderTest = middleware();
    const authenticated = await middlewareUnderTest.authenticate(request());
    if (authenticated.outcome !== 'authenticated') throw new Error('expected authentication');

    const result = await middlewareUnderTest.authorize(
      authenticated,
      { ...request(), headers: { authorization: 'Bearer token' } },
      'article:execute',
    );
    expect(result).toEqual({ outcome: 'denied', reason: 'workspace-unknown' });
  });

  it('denies a suspended organization', async () => {
    expect(await authorize({ organizationStatus: 'suspended' })).toEqual({
      outcome: 'denied',
      reason: 'organization-suspended',
    });
  });

  it('does NOT deny a past_due organization — that is the Gateway business', async () => {
    // The access boundary and the admission boundary are different questions.
    // An unpaid account keeps reading its own work; it stops buying model calls,
    // and the Gateway is what refuses that.
    expect((await authorize({ organizationStatus: 'past_due' })).outcome).toBe('authorized');
    expect((await authorize({ organizationStatus: 'pending_closure' })).outcome).toBe('authorized');
  });

  it('denies a workspace that is not active', async () => {
    for (const status of ['suspended', 'archived', 'pending_deletion']) {
      expect(await authorize({ workspaceStatus: status }), status).toEqual({
        outcome: 'denied',
        reason: 'workspace-inaccessible',
      });
    }
  });

  it('denies a suspended subject', async () => {
    expect(await authorize({ subjectSuspended: true })).toEqual({
      outcome: 'denied',
      reason: 'subject-suspended',
    });
  });

  it('denies a subject with no membership in the organization', async () => {
    expect(await authorize({ bindings: [] })).toEqual({
      outcome: 'denied',
      reason: 'membership-required',
    });
  });

  it('denies a role that does not carry the permission', async () => {
    // `viewer` may read a run and may not spend on a model.
    expect(await authorize({ bindings: [binding({ role: 'viewer' })] })).toEqual({
      outcome: 'denied',
      reason: 'insufficient-permission',
    });
    expect(
      (await authorize({ bindings: [binding({ role: 'viewer' })] }, {}, 'run:read')).outcome,
    ).toBe('authorized');
  });

  it('denies an expired binding, evaluated at use', async () => {
    expect(
      await authorize({
        bindings: [binding({ expiresAt: new Date(NOW.getTime() - 1) })],
      }),
    ).toEqual({ outcome: 'denied', reason: 'membership-required' });
  });

  it('denies a binding in another workspace of the same organization', async () => {
    expect(await authorize({ bindings: [binding({ workspaceId: 'ws-other' })] })).toEqual({
      outcome: 'denied',
      reason: 'insufficient-permission',
    });
  });
});

describe('the scope a credential carries', () => {
  it('restricts an API key to its bound workspace', async () => {
    const middlewareUnderTest = middleware({ key: apiKeyRecord({ workspaceId: 'ws-other' }) });
    const headers = { 'x-api-key': API_KEY, [WORKSPACE_HEADER]: WS };
    const authenticated = await middlewareUnderTest.authenticate({ ...request(), headers });
    if (authenticated.outcome !== 'authenticated') throw new Error('expected authentication');

    const result = await middlewareUnderTest.authorize(
      authenticated,
      { ...request(), headers },
      'run:read',
    );
    expect(result).toEqual({ outcome: 'denied', reason: 'credential-scope' });
  });

  it('uses the bound workspace when the caller names none', async () => {
    const middlewareUnderTest = middleware();
    const headers = { 'x-api-key': API_KEY };
    const authenticated = await middlewareUnderTest.authenticate({ ...request(), headers });
    if (authenticated.outcome !== 'authenticated') throw new Error('expected authentication');

    const result = await middlewareUnderTest.authorize(
      authenticated,
      { ...request(), headers },
      'run:read',
    );
    expect(result.outcome).toBe('authorized');
    expect(result.outcome === 'authorized' && result.context.principal.workspaceId).toBe(WS);
  });

  it('restricts an API key to its bound organization', async () => {
    const middlewareUnderTest = middleware({
      key: apiKeyRecord({ organizationId: 'org-other', workspaceId: null }),
    });
    const headers = { 'x-api-key': API_KEY, [WORKSPACE_HEADER]: WS };
    const authenticated = await middlewareUnderTest.authenticate({ ...request(), headers });
    if (authenticated.outcome !== 'authenticated') throw new Error('expected authentication');

    await expect(
      middlewareUnderTest.authorize(authenticated, { ...request(), headers }, 'run:read'),
    ).resolves.toEqual({ outcome: 'denied', reason: 'credential-scope' });
  });
});

// ── The context produced ─────────────────────────────────────────────────────

describe('the authenticated context', () => {
  it('carries the resolved tenancy, roles and permissions', async () => {
    const result = await authorize();
    expect(result.outcome).toBe('authorized');
    if (result.outcome !== 'authorized') return;

    expect(result.context).toMatchObject({
      requestId: 'unknown',
      correlationId: 'unknown',
      organization: { id: ORG, status: 'active' },
      workspace: { id: WS, status: 'active' },
      principal: {
        subjectId: 'user-1',
        kind: 'user',
        method: 'password',
        organizationId: ORG,
        workspaceId: WS,
        roles: ['editor'],
        mfaSatisfied: true,
        sessionId: 'session-1',
      },
    });
    expect(result.context.principal.permissions).toContain('article:execute');
  });

  it('resolves permissions from bindings, never from a token claim', async () => {
    // The set must be what the ROLE grants. A token cannot widen it, because
    // nothing reads a token for it.
    const result = await authorize({ bindings: [binding({ role: 'viewer' })] }, {}, 'run:read');
    if (result.outcome !== 'authorized') throw new Error('expected authorization');

    expect(result.context.principal.permissions).toContain('run:read');
    expect(result.context.principal.permissions).not.toContain('article:execute');
    expect(result.context.principal.permissions).not.toContain('organization:delete');
  });

  it('excludes a binding from another workspace when resolving permissions', async () => {
    const result = await authorize(
      { bindings: [binding(), binding({ role: 'workspace_admin', workspaceId: 'ws-other' })] },
      {},
      'run:read',
    );
    if (result.outcome !== 'authorized') throw new Error('expected authorization');
    expect(result.context.principal.roles).toEqual(['editor']);
  });

  it('is deeply frozen', async () => {
    const result = await authorize();
    if (result.outcome !== 'authorized') throw new Error('expected authorization');

    expect(Object.isFrozen(result.context)).toBe(true);
    expect(Object.isFrozen(result.context.principal)).toBe(true);
    expect(Object.isFrozen(result.context.principal.permissions)).toBe(true);
    expect(() => {
      (result.context.principal as unknown as { workspaceId: string }).workspaceId = 'elsewhere';
    }).toThrow(TypeError);
  });

  it('takes the request and correlation ids from the edge headers', async () => {
    const result = await authorize(
      {},
      {
        'x-request-id': 'req-9',
        'x-correlation-id': 'corr-9',
      },
    );
    if (result.outcome !== 'authorized') throw new Error('expected authorization');
    expect(result.context).toMatchObject({ requestId: 'req-9', correlationId: 'corr-9' });
  });
});

describe('the request and correlation ids', () => {
  it('uses the request id for both when only one was supplied', () => {
    expect(requestIdsOf(request({ 'x-request-id': 'req-9' }))).toEqual({
      requestId: 'req-9',
      correlationId: 'req-9',
    });
  });

  it('uses the correlation id for both when only that was supplied', () => {
    expect(requestIdsOf(request({ 'x-correlation-id': 'corr-9' }))).toEqual({
      requestId: 'corr-9',
      correlationId: 'corr-9',
    });
  });

  it('keeps them distinct when both were supplied', () => {
    expect(
      requestIdsOf(request({ 'x-request-id': 'req-9', 'x-correlation-id': 'corr-9' })),
    ).toEqual({ requestId: 'req-9', correlationId: 'corr-9' });
  });

  it('reports unknown rather than inventing one', () => {
    // Generating an id here would be non-deterministic and would match nothing
    // in the logs, which is worse than admitting there is none.
    expect(requestIdsOf(request())).toEqual({ requestId: 'unknown', correlationId: 'unknown' });
    expect(requestIdsOf(request({ 'x-request-id': '   ' }))).toEqual({
      requestId: 'unknown',
      correlationId: 'unknown',
    });
  });

  it('reads headers only, so an unparseable body still has an id', () => {
    const broken: ApiRequest = { ...request({ 'x-request-id': 'req-9' }), body: undefined };
    expect(requestIdsOf(broken).requestId).toBe('req-9');
  });
});
