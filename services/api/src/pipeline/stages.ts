/**
 * Pipeline stages — platform middleware only.
 *
 * No business endpoints, no feature APIs, no provider SDKs, no business logic.
 *
 * Framework-agnostic by construction: each stage is a pure function over a
 * minimal request shape. ADR-003 selects NestJS, and the NestJS binding is a
 * thin adapter over these — which is what keeps the controls testable without
 * booting an HTTP server.
 */

import type { StageName } from './order.js';

// ── The minimal request/response shapes the stages operate on ────────────────

export interface PipelineRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly ip: string;
  readonly contentLength: number;
  readonly body: unknown;
  readonly cookies: Readonly<Record<string, string | undefined>>;
}

export interface StageOutcome {
  readonly ok: boolean;
  readonly stage: StageName;
  readonly status?: number;
  readonly code?: string;
  /** Client-safe. NEVER a stack trace, SQL error, or provider internal. */
  readonly message?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export const proceed = (stage: StageName): StageOutcome => ({ ok: true, stage });

const reject = (
  stage: StageName,
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): StageOutcome => ({ ok: false, stage, status, code, message, ...(headers ? { headers } : {}) });

// ── Size limits (`api-security.md` §"Request size limits") ───────────────────

export const SIZE_LIMITS = {
  jsonBodyBytes: 1024 * 1024, // 1 MB
  multipartBytes: 25 * 1024 * 1024, // 25 MB
  urlBytes: 2 * 1024, // 2 KB
  headerTotalBytes: 16 * 1024, // 16 KB
  arrayElements: 1000,
  /** JSON parsers are recursive: a deeply nested document exhausts the stack
   *  before any application code runs — a DoS from one small request. */
  nestingDepth: 10,
} as const;

export function checkSizeLimits(req: PipelineRequest): StageOutcome {
  const stage: StageName = 'size-limit';

  if (Buffer.byteLength(req.path, 'utf8') > SIZE_LIMITS.urlBytes) {
    return reject(stage, 414, 'URI_TOO_LONG', 'Request URI is too long.');
  }

  let headerBytes = 0;
  for (const [key, value] of Object.entries(req.headers)) {
    headerBytes += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value ?? '', 'utf8');
  }
  if (headerBytes > SIZE_LIMITS.headerTotalBytes) {
    return reject(stage, 431, 'HEADERS_TOO_LARGE', 'Request headers are too large.');
  }

  const isMultipart = (req.headers['content-type'] ?? '').startsWith('multipart/');
  const limit = isMultipart ? SIZE_LIMITS.multipartBytes : SIZE_LIMITS.jsonBodyBytes;
  if (req.contentLength > limit) {
    return reject(stage, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
  }

  return proceed(stage);
}

/** Depth check, applied by the parser rather than after a document is built. */
export function exceedsNestingDepth(value: unknown, max = SIZE_LIMITS.nestingDepth): boolean {
  function depth(node: unknown, current: number): number {
    if (current > max) return current;
    if (Array.isArray(node)) {
      let deepest = current;
      for (const item of node) deepest = Math.max(deepest, depth(item, current + 1));
      return deepest;
    }
    if (node !== null && typeof node === 'object') {
      let deepest = current;
      for (const item of Object.values(node)) deepest = Math.max(deepest, depth(item, current + 1));
      return deepest;
    }
    return current;
  }
  return depth(value, 0) > max;
}

// ── Rate limiting — two stages (`api-security.md`) ───────────────────────────

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetSeconds: number;
}

export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
}

export interface RateLimitConfig {
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Pre-auth, keyed by IP. Protects the authentication endpoints themselves —
 * credential stuffing and enumeration happen without valid credentials.
 */
export async function rateLimitPreAuth(
  req: PipelineRequest,
  limiter: RateLimiter,
  config: RateLimitConfig,
): Promise<StageOutcome> {
  const decision = await limiter.consume(`ip:${req.ip}`, config.limit, config.windowSeconds);
  return decision.allowed
    ? proceed('rate-limit-pre-auth')
    : reject('rate-limit-pre-auth', 429, 'RATE_LIMITED', 'Too many requests.', {
        'Retry-After': String(decision.resetSeconds),
      });
}

/**
 * Post-auth, keyed by subject AND tenant. Enforces fair use and catches a
 * compromised account. Either limit alone leaves a gap.
 */
export async function rateLimitPostAuth(
  subjectId: string,
  tenantId: string | null,
  limiter: RateLimiter,
  config: RateLimitConfig,
): Promise<StageOutcome> {
  const key =
    tenantId === null ? `subject:${subjectId}` : `subject:${subjectId}:tenant:${tenantId}`;
  const decision = await limiter.consume(key, config.limit, config.windowSeconds);
  return decision.allowed
    ? proceed('rate-limit-post-auth')
    : reject('rate-limit-post-auth', 429, 'RATE_LIMITED', 'Too many requests.', {
        'Retry-After': String(decision.resetSeconds),
      });
}

// ── CSRF (`api-security.md`) ─────────────────────────────────────────────────

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_COOKIE = 'contentos_csrf';
export const CSRF_HEADER = 'x-csrf-token';

/**
 * CSRF applies to COOKIE-AUTHENTICATED MUTATIONS only.
 *
 * A bearer-token request cannot be forged cross-site: the browser does not
 * attach an Authorization header automatically. Applying CSRF to those would be
 * ceremony without protection, and would train people to disable it.
 *
 * Comparison is constant-time via the injected comparator, so token validation
 * does not leak through timing.
 */
export function checkCsrf(
  req: PipelineRequest,
  cookieAuthenticated: boolean,
  constantTimeEquals: (a: string, b: string) => boolean,
): StageOutcome {
  const stage: StageName = 'csrf';
  if (SAFE_METHODS.has(req.method.toUpperCase())) return proceed(stage);
  if (!cookieAuthenticated) return proceed(stage);

  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.headers[CSRF_HEADER];
  if (cookie === undefined || cookie === '' || header === undefined || header === '') {
    return reject(stage, 403, 'CSRF_TOKEN_MISSING', 'CSRF token missing.');
  }
  if (!constantTimeEquals(cookie, header)) {
    return reject(stage, 403, 'CSRF_TOKEN_INVALID', 'CSRF token invalid.');
  }
  return proceed(stage);
}

// ── Validation (`api-security.md` §"Input validation") ───────────────────────

export interface ValidationIssue {
  /** Field path, e.g. 'body.title'. Safe to return. */
  readonly path: string;
  readonly code: string;
}

export interface SchemaValidator<T> {
  /** MUST reject unknown keys — `.strict()` is mandatory on every request schema. */
  validate(
    input: unknown,
  ): { ok: true; value: T } | { ok: false; issues: readonly ValidationIssue[] };
}

/**
 * Schema validation, then semantic validation. Both mandatory.
 *
 * Unknown keys are REJECTED. Silently ignoring them means a client sending
 * `tenantId`, `role`, or `credits` gets no error — and any code that later
 * reads the raw body receives attacker-controlled fields. Rejecting them makes
 * mass-assignment structurally impossible.
 */
export function validateRequest<T>(
  input: unknown,
  schema: SchemaValidator<T>,
): { outcome: StageOutcome; value?: T } {
  if (exceedsNestingDepth(input)) {
    return {
      outcome: reject(
        'validation',
        400,
        'NESTING_TOO_DEEP',
        'Request structure is too deeply nested.',
      ),
    };
  }

  const result = schema.validate(input);
  if (!result.ok) {
    return {
      outcome: {
        ok: false,
        stage: 'validation',
        status: 400,
        code: 'VALIDATION_FAILED',
        // Field paths are safe; the validator's internal message is not returned.
        message: result.issues.map((i) => `${i.path}: ${i.code}`).join('; '),
      },
    };
  }
  return { outcome: proceed('validation'), value: result.value };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Identifiers are validated as UUIDs BEFORE use, so a non-UUID path parameter
 * never becomes a query parameter — removing injection through identifier
 * fields as a category.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

// ── Security headers and output filtering ────────────────────────────────────

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
  'Cache-Control': 'no-store',
};

/**
 * The error response policy.
 *
 * Never expose a stack trace, a SQL error, a provider internal, or a secret. An
 * unrecognised failure becomes an opaque 500 with a correlation id — which is
 * what makes the incident traceable without telling the caller anything.
 */
export interface ErrorResponse {
  readonly status: number;
  readonly body: {
    readonly error: { readonly code: string; readonly message: string };
    readonly correlationId: string;
  };
}

const SAFE_CODES = new Set([
  'URI_TOO_LONG',
  'HEADERS_TOO_LARGE',
  'PAYLOAD_TOO_LARGE',
  'NESTING_TOO_DEEP',
  'RATE_LIMITED',
  'UNAUTHENTICATED',
  'CSRF_TOKEN_MISSING',
  'CSRF_TOKEN_INVALID',
  'VALIDATION_FAILED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
]);

export function toErrorResponse(outcome: StageOutcome, correlationId: string): ErrorResponse {
  const code = outcome.code ?? 'INTERNAL_ERROR';
  if (!SAFE_CODES.has(code)) {
    return {
      status: 500,
      body: {
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.' },
        correlationId,
      },
    };
  }
  return {
    status: outcome.status ?? 500,
    body: { error: { code, message: outcome.message ?? 'Request rejected.' }, correlationId },
  };
}
