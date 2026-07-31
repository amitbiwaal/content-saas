/**
 * The HTTP shapes and the canonical error envelope.
 *
 * ── No framework, by convention ─────────────────────────────────────────────
 * `services/api` has no Express or Fastify: a handler is a pure function from a
 * request shape to a response shape, exactly as `health/endpoints.ts` and every
 * stage in `pipeline/stages.ts` already are. ADR-003 selects NestJS and the
 * NestJS binding is a thin adapter over these, which is what keeps every
 * endpoint testable without booting a server.
 *
 * ── The error envelope is frozen ────────────────────────────────────────────
 * `06-api/api-principles.md`, restating `16-security/api-security.md`:
 *
 *   { error: { code, message, requestId, details? } }
 *
 * Three rules from that document are enforced here rather than trusted:
 *   - `message` is DERIVED FROM the code, never passed through from whatever
 *     failed. "Clients branch on `code`, never on `message`."
 *   - `details` carries field paths and codes, NEVER received values.
 *   - never a stack trace, a SQL fragment, a PROVIDER MESSAGE, an internal
 *     hostname, a secret, or whether a resource exists in another tenant.
 *
 * The third is why `errorFor` has no message parameter. A rejected admission
 * carries a `reason`, a failed provider call carries a vendor string, and a
 * thrown error carries a stack; a function that accepted any of them would make
 * leaking one a typo rather than a decision. There is no such parameter, so
 * there is no such typo.
 *
 * `details` reuses the pipeline's `ValidationIssue` — `{ path, code }` — rather
 * than declaring a second identical type. One field-error shape across the
 * middleware and the controllers is what lets a client parse `details` without
 * knowing which layer refused it.
 */

import type { AuthContext } from '@contentos/security';

import type { ValidationIssue } from '../pipeline/stages.js';

/** What a transport adapter hands a controller. Framework-agnostic. */
export interface ApiRequest {
  readonly method: string;
  readonly path: string;
  /** Path parameters, already extracted by the router. */
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** Lower-cased keys — a controller must not care how the runtime cased them. */
  readonly headers: Readonly<Record<string, string>>;
  /** Already parsed. Whether it parsed at all is the adapter's problem. */
  readonly body: unknown;
}

/**
 * A request that has been authenticated and authorized.
 *
 * The `auth` field is the ONLY thing a controller reads for identity. Nothing
 * downstream of the middleware touches `headers` for a credential, a request
 * id, or a tenant — and because a controller's parameter is this type rather
 * than `ApiRequest`, a handler that has not been through the middleware cannot
 * be routed to at all. The constraint is carried by the type instead of by a
 * convention someone has to remember.
 */
export interface AuthenticatedRequest extends ApiRequest {
  readonly auth: AuthContext;
}

export interface ApiResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/**
 * A streaming response.
 *
 * `lines` is an async iterable of already-serialized NDJSON lines. The adapter
 * writes them and flushes; it makes no framing decision, holds no buffering
 * policy and never learns what a chunk is. That division is what keeps the
 * wire format testable as a value rather than observable only through a socket.
 */
export interface ApiStreamResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly lines: AsyncIterable<string>;
}

export type ApiResult = ApiResponse | ApiStreamResponse;

export function isStreamResponse(result: ApiResult): result is ApiStreamResponse {
  return 'lines' in result;
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly requestId: string;
    readonly details?: readonly ValidationIssue[];
  };
}

/**
 * The code vocabulary, and the safe message each one derives.
 *
 * A table rather than call-site strings: adding a code without writing its
 * message is then a compile error, instead of a response carrying whatever
 * sentence happened to be in scope.
 */
export const API_ERROR_MESSAGES = {
  invalid_request: 'The request was not valid.',
  request_too_large: 'The request exceeded the maximum permitted size.',
  not_found: 'The requested resource does not exist.',
  // One message for every way authentication can fail — missing, malformed,
  // bad signature, expired, revoked. A caller learns that the credential did
  // not work, and nothing about which check refused it, because the finer
  // answer is an oracle for guessing credentials.
  unauthenticated: 'Authentication is required.',
  forbidden: 'The request is not permitted.',
  unprocessable: 'The request was understood but could not be processed.',
  provider_unavailable: 'The upstream model provider is unavailable.',
  rate_limited: 'Too many requests.',
  timeout: 'The request timed out.',
  method_not_allowed: 'That method is not supported for this path.',
  internal_error: 'An unexpected error occurred.',
} as const;

export type ApiErrorCode = keyof typeof API_ERROR_MESSAGES;

const JSON_HEADERS: Readonly<Record<string, string>> = { 'content-type': 'application/json' };

export function ok(body: unknown, headers: Readonly<Record<string, string>> = {}): ApiResponse {
  return Object.freeze({
    status: 200,
    headers: Object.freeze({ ...JSON_HEADERS, ...headers }),
    body,
  });
}

/**
 * An error response, with the message derived from the code.
 *
 * See the file header for why there is no message parameter.
 */
export function errorFor(
  status: number,
  code: ApiErrorCode,
  requestId: string,
  details?: readonly ValidationIssue[],
  headers: Readonly<Record<string, string>> = {},
): ApiResponse {
  const body: ErrorBody = {
    error: {
      code,
      message: API_ERROR_MESSAGES[code],
      requestId,
      ...(details === undefined || details.length === 0
        ? {}
        : { details: Object.freeze(details.map((issue) => Object.freeze({ ...issue }))) }),
    },
  };
  Object.freeze(body.error);
  return Object.freeze({
    status,
    headers: Object.freeze({ ...JSON_HEADERS, ...headers }),
    body: Object.freeze(body),
  });
}
