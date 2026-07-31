/**
 * The OpenAPI 3.1 document, GENERATED from the contracts.
 *
 * ── Generated, not written ──────────────────────────────────────────────────
 * Every part of this document that also exists in code is READ from the code:
 *
 *   paths           `AI_ROUTES`            — the route table the router uses
 *   error codes     `API_ERROR_MESSAGES`   — the envelope's own vocabulary
 *   request body    `EXECUTION_BODY_FIELDS`— the list the validator accepts
 *   capabilities    `AI_CAPABILITIES`      — from `@contentos/contracts`
 *   stream events   `STREAM_EVENT_KINDS`   — from the streaming framework
 *   rate headers    `rateLimitHeaders`     — the names the enforcer emits
 *   auth headers    the middleware's own constants
 *   versions        the `VersionRegistry`
 *
 * A hand-written specification beside a hand-written implementation is two
 * descriptions of one contract, and the published one is the half nobody runs
 * — so it is the half that drifts, silently, until a customer builds against
 * it. Reading the same constants means a route added to the table appears here
 * without anyone remembering to add it, and a route removed disappears.
 *
 * ── Why the types are declared here rather than installed ───────────────────
 * OpenAPI 3.1 is a JSON document. A type package would add a dependency, a
 * licence review and a lockfile entry to describe a shape this file already
 * knows exactly. What is declared below is the subset this document uses,
 * which is also the subset `validate.ts` checks.
 */

import { AI_CAPABILITIES } from '@contentos/contracts';
import { STREAM_EVENT_KINDS } from '@contentos/ai';

import { API_ERROR_MESSAGES, type ApiErrorCode } from '../ai/http.js';
import { AI_ROUTES, type AiRoute } from '../ai/routes.js';
import { EXECUTION_BODY_FIELDS } from '../ai/validation.js';
import { WWW_AUTHENTICATE } from '../auth/responses.js';
import { IDEMPOTENCY_KEY_HEADER, IDEMPOTENT_REPLAY_HEADER } from '../idempotency/guard.js';
import {
  API_VERSION_HEADER,
  DEPRECATION_HEADER,
  LINK_HEADER,
  SUNSET_HEADER,
} from '../versioning/negotiate.js';
import type { VersionRegistry } from '../versioning/registry.js';

// ── The subset of OpenAPI 3.1 this document uses ─────────────────────────────

export interface OpenApiSchema {
  readonly type?: string | readonly string[];
  readonly format?: string;
  readonly description?: string;
  readonly enum?: readonly string[];
  readonly properties?: Readonly<Record<string, OpenApiSchema>>;
  readonly required?: readonly string[];
  readonly items?: OpenApiSchema;
  readonly additionalProperties?: boolean | OpenApiSchema;
  readonly oneOf?: readonly OpenApiSchema[];
  readonly nullable?: boolean;
  readonly example?: unknown;
  readonly $ref?: string;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required?: boolean;
  readonly description: string;
  readonly schema: OpenApiSchema;
}

export interface OpenApiHeader {
  readonly description: string;
  readonly schema: OpenApiSchema;
}

export interface OpenApiResponse {
  readonly description: string;
  readonly headers?: Readonly<Record<string, OpenApiHeader | { readonly $ref: string }>>;
  readonly content?: Readonly<
    Record<string, { readonly schema: OpenApiSchema; readonly example?: unknown }>
  >;
}

export interface OpenApiOperation {
  readonly operationId: string;
  readonly summary: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly parameters?: readonly (OpenApiParameter | { readonly $ref: string })[];
  readonly requestBody?: {
    readonly required: boolean;
    readonly content: Readonly<Record<string, { readonly schema: OpenApiSchema }>>;
  };
  readonly responses: Readonly<Record<string, OpenApiResponse | { readonly $ref: string }>>;
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
}

export interface OpenApiDocument {
  readonly openapi: string;
  readonly info: {
    readonly title: string;
    readonly version: string;
    readonly description: string;
  };
  readonly servers: readonly { readonly url: string; readonly description: string }[];
  readonly tags: readonly { readonly name: string; readonly description: string }[];
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
  readonly components: {
    readonly schemas: Readonly<Record<string, OpenApiSchema>>;
    readonly parameters: Readonly<Record<string, OpenApiParameter>>;
    readonly headers: Readonly<Record<string, OpenApiHeader>>;
    readonly responses: Readonly<Record<string, OpenApiResponse>>;
    readonly securitySchemes: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  };
  readonly security: readonly Readonly<Record<string, readonly string[]>>[];
}

/** OpenAPI 3.1.0 — the version this document declares and `validate.ts` checks. */
export const OPENAPI_VERSION = '3.1.0';

// ── Errors: one schema, one response per status, no duplicates ───────────────

/**
 * The status each canonical code is returned with.
 *
 * A `Record` over `ApiErrorCode`, so a code added to `API_ERROR_MESSAGES`
 * fails to compile until it is documented. That is the mechanism that keeps
 * "every canonical error is documented" true rather than aspirational.
 */
const STATUS_FOR_CODE: Readonly<Record<ApiErrorCode, number>> = {
  invalid_request: 400,
  request_too_large: 413,
  not_found: 404,
  unauthenticated: 401,
  forbidden: 403,
  unprocessable: 422,
  provider_unavailable: 503,
  rate_limited: 429,
  idempotency_conflict: 409,
  idempotency_in_progress: 409,
  service_unavailable: 503,
  timeout: 504,
  method_not_allowed: 405,
  unsupported_version: 400,
  version_retired: 410,
  internal_error: 500,
};

/** Every code that maps to a status, for that status's documented response. */
function codesFor(status: number): readonly ApiErrorCode[] {
  return (Object.keys(API_ERROR_MESSAGES) as ApiErrorCode[]).filter(
    (code) => STATUS_FOR_CODE[code] === status,
  );
}

/** The statuses the increment requires documented, plus the ones we return. */
const DOCUMENTED_STATUSES = [
  400, 401, 403, 404, 405, 409, 410, 413, 422, 429, 500, 502, 503, 504,
] as const;

const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  410: 'Gone',
  413: 'Content Too Large',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

const errorResponseName = (status: number): string => `Error${String(status)}`;

const REF = {
  error: '#/components/schemas/Error',
  fieldError: '#/components/schemas/FieldError',
  streamEvent: '#/components/schemas/StreamEvent',
  streamChunk: '#/components/schemas/StreamChunk',
} as const;

/**
 * The response for one status.
 *
 * Every one references the SAME `Error` schema; the only thing that varies is
 * which codes may appear and which headers ride along. Duplicating the
 * envelope per status is how the envelope stops being canonical.
 */
function errorResponse(status: number): OpenApiResponse {
  const codes = codesFor(status);
  const headers: Record<string, { $ref: string }> = {
    [API_VERSION_HEADER]: { $ref: '#/components/headers/ApiVersion' },
  };
  if (status === 401)
    headers['www-authenticate'] = { $ref: '#/components/headers/WwwAuthenticate' };
  if (status === 405) headers['allow'] = { $ref: '#/components/headers/Allow' };
  if (status === 429 || status === 503) {
    headers['retry-after'] = { $ref: '#/components/headers/RetryAfter' };
  }

  return {
    description:
      codes.length === 0
        ? `${STATUS_TITLES[status] ?? ''}.`
        : `${STATUS_TITLES[status] ?? ''}. Codes: ${codes.join(', ')}.`,
    headers,
    content: {
      'application/json': {
        schema: { $ref: REF.error },
        example: {
          error: {
            code: codes[0] ?? 'internal_error',
            message: API_ERROR_MESSAGES[codes[0] ?? 'internal_error'],
            requestId: '018f3a2b-0000-7000-8000-00000000abcd',
          },
        },
      },
    },
  };
}

// ── Schemas, derived from the contracts they describe ────────────────────────

function executeRequestSchema(): OpenApiSchema {
  const properties: Record<string, OpenApiSchema> = {};
  for (const field of EXECUTION_BODY_FIELDS) {
    properties[field.name] =
      field.name === 'capability'
        ? { type: 'string', enum: [...AI_CAPABILITIES], description: field.description }
        : field.name === 'template'
          ? {
              type: 'object',
              description: field.description,
              properties: {
                id: { type: 'string', description: 'The template identifier.' },
                version: {
                  type: 'integer',
                  description: 'Omitted resolves to the single active version.',
                },
              },
              required: ['id'],
              additionalProperties: false,
            }
          : { type: field.type, description: field.description };
  }

  return {
    type: 'object',
    description:
      'An execution request. Tenancy and identity come from the authenticated context, so organizationId, workspaceId, actorId and correlationId are REJECTED if sent.',
    properties,
    required: EXECUTION_BODY_FIELDS.filter((field) => field.required).map((field) => field.name),
    // `.strict()` is mandatory on every request schema: silently ignoring an
    // unknown key means a caller sending `workspaceId` gets no error.
    additionalProperties: false,
  };
}

function schemas(): Readonly<Record<string, OpenApiSchema>> {
  const tokenUsage: OpenApiSchema = {
    type: 'object',
    description: 'Token counts for one call.',
    properties: {
      promptTokens: { type: 'integer' },
      completionTokens: { type: 'integer' },
      totalTokens: { type: 'integer' },
    },
    required: ['promptTokens', 'completionTokens', 'totalTokens'],
  };

  const usage: OpenApiSchema = {
    type: 'object',
    description: 'What one call consumed and cost.',
    properties: {
      tokens: { $ref: '#/components/schemas/TokenUsage' },
      tokensEstimated: {
        type: 'boolean',
        description: 'True when the provider omitted counts and the adapter computed them.',
      },
      cost: { $ref: '#/components/schemas/CostEstimate' },
      latencyMs: { type: 'integer' },
    },
    required: ['tokens', 'tokensEstimated', 'cost', 'latencyMs'],
  };

  return {
    FieldError: {
      type: 'object',
      description:
        'One rejected field. Carries a path and a code, NEVER the value that was received.',
      properties: {
        path: { type: 'string', description: "The field path, e.g. 'body.capability'." },
        code: { type: 'string', description: 'A stable machine-readable code.' },
      },
      required: ['path', 'code'],
      additionalProperties: false,
    },

    Error: {
      type: 'object',
      description:
        'The canonical error envelope. Clients branch on `code`, never on `message`; messages are derived from the code and are not contract.',
      properties: {
        error: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              enum: Object.keys(API_ERROR_MESSAGES),
              description:
                'Stable across API versions — a code means one thing forever. Response enums are OPEN: tolerate an unknown value rather than failing on it.',
            },
            message: { type: 'string', description: 'Human-readable and derived from the code.' },
            requestId: {
              type: 'string',
              description: 'Equals the X-Request-Id response header. Quote it in support.',
            },
            details: { type: 'array', items: { $ref: REF.fieldError } },
          },
          required: ['code', 'message', 'requestId'],
          additionalProperties: false,
        },
      },
      required: ['error'],
      additionalProperties: false,
    },

    TokenUsage: tokenUsage,
    CostEstimate: {
      type: 'object',
      description:
        'Cost as a decimal STRING, never a float — this value reaches a NUMERIC(20,6) ledger.',
      properties: {
        currency: { type: 'string', example: 'USD' },
        amount: { type: 'string', example: '0.000300' },
      },
      required: ['currency', 'amount'],
    },
    Usage: usage,

    ExecuteRequest: executeRequestSchema(),

    ExecuteResponse: {
      type: 'object',
      description: 'A completed execution.',
      properties: {
        workflowId: { type: 'string' },
        promptVersion: {
          type: 'string',
          description: "Resolves to the exact prompt, permanently — 'planning.outline@7'.",
        },
        capability: { type: 'string', enum: [...AI_CAPABILITIES] },
        correlationId: { type: 'string' },
        idempotencyKey: { type: 'string' },
        providerId: { type: 'string' },
        model: { type: 'string', description: 'The model that actually ran.' },
        content: { type: 'string' },
        finishReason: { type: 'string', enum: ['stop', 'length', 'content_filter', 'tool_call'] },
        usage: { $ref: '#/components/schemas/Usage' },
      },
      required: ['workflowId', 'capability', 'providerId', 'model', 'content', 'usage'],
    },

    StreamCursor: {
      type: 'object',
      description: 'Where a consumer has got to. Hand `resumeToken` back to resume.',
      properties: {
        streamId: { type: 'string' },
        lastSequence: {
          type: ['integer', 'null'],
          description: 'The highest sequence delivered, or null before anything was.',
        },
        completed: { type: 'boolean' },
        resumeToken: { type: 'string' },
      },
      required: ['streamId', 'lastSequence', 'completed', 'resumeToken'],
    },

    StreamChunk: {
      type: 'object',
      description:
        'One chunk. Sequences are 0-based and gapless; duplicates, gaps and out-of-order chunks are refused rather than reordered.',
      properties: {
        sequence: { type: 'integer', description: '0-based and contiguous.' },
        content: { type: 'string' },
        finishReason: {
          type: ['string', 'null'],
          enum: ['stop', 'length', 'content_filter', 'tool_call'],
          description: 'Set on the FINAL chunk and null on every other. It is what ends a stream.',
        },
        usage: {
          description: 'Present on the final chunk only, and null on every other.',
          oneOf: [{ $ref: '#/components/schemas/Usage' }, { type: 'null' }],
        },
        metadata: { type: 'object', description: 'Vendor frame detail. Opaque.' },
      },
      required: ['sequence', 'content', 'finishReason', 'usage', 'metadata'],
    },

    StreamEvent: {
      type: 'object',
      description:
        'One NDJSON line. A stream ends with `completed` or `failed`; a connection that closes without either was interrupted, and the cursor on the last event received is where to resume from.',
      properties: {
        kind: { type: 'string', enum: [...STREAM_EVENT_KINDS] },
        streamId: { type: 'string' },
        chunk: { $ref: REF.streamChunk },
        finishReason: { type: 'string', enum: ['stop', 'length', 'content_filter', 'tool_call'] },
        code: {
          type: 'string',
          description:
            'On `failed` only. The canonical provider error code — never a vendor message.',
        },
        reason: { type: 'string', description: 'On `failed` only. Safe and generic.' },
        cursor: { $ref: '#/components/schemas/StreamCursor' },
      },
      required: ['kind', 'streamId', 'cursor'],
    },

    Job: {
      type: 'object',
      description: 'A job, without its payload — the payload holds customer content.',
      properties: {
        id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['queued', 'running', 'completed', 'failed', 'cancelled'],
        },
        jobType: { type: 'string' },
        workspaceId: { type: 'string' },
        correlationId: { type: 'string' },
        reason: { type: ['string', 'null'] },
        createdAt: { type: 'string', format: 'date-time' },
        updatedAt: { type: 'string', format: 'date-time' },
        startedAt: { type: ['string', 'null'], format: 'date-time' },
        completedAt: { type: ['string', 'null'], format: 'date-time' },
      },
      required: ['id', 'status', 'jobType', 'workspaceId', 'createdAt', 'updatedAt'],
    },

    Workflow: {
      type: 'object',
      description:
        'A workflow run, without generated content — model output belongs to the results route, which has different authorization.',
      properties: {
        workflowId: { type: 'string' },
        definitionId: { type: 'string' },
        definitionVersion: { type: 'integer' },
        status: { type: 'string' },
        stepIndex: { type: 'integer' },
        stepId: { type: ['string', 'null'] },
        jobId: { type: 'string' },
        correlationId: { type: 'string' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              stepId: { type: 'string' },
              promptVersion: { type: 'string' },
              providerId: { type: 'string' },
              model: { type: 'string' },
              finishReason: { type: 'string' },
              usage: { $ref: '#/components/schemas/Usage' },
            },
            required: ['stepId', 'promptVersion', 'providerId', 'model'],
          },
        },
      },
      required: ['workflowId', 'definitionId', 'status', 'steps'],
    },

    ProviderList: {
      type: 'object',
      properties: {
        providers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              providerId: { type: 'string' },
              displayName: { type: 'string' },
              capabilities: {
                type: 'array',
                items: { type: 'string', enum: [...AI_CAPABILITIES] },
              },
              health: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['healthy', 'degraded', 'offline'] },
                  reportedAt: { type: ['string', 'null'], format: 'date-time' },
                },
                required: ['status', 'reportedAt'],
              },
              models: {
                type: 'array',
                items: { type: 'string' },
                description: 'Present only where a provider publishes one.',
              },
            },
            required: ['providerId', 'displayName', 'capabilities', 'health'],
          },
        },
      },
      required: ['providers'],
    },

    Health: {
      type: 'object',
      description:
        'AI-layer readiness. No database diagnostics — the process probes live outside /v1.',
      properties: {
        status: { type: 'string', enum: ['ok', 'degraded'] },
        version: { type: 'string' },
        gateway: {
          type: 'object',
          properties: { ready: { type: 'boolean' } },
          required: ['ready'],
        },
        registry: {
          type: 'object',
          properties: { sealed: { type: 'boolean' }, providers: { type: 'integer' } },
          required: ['sealed', 'providers'],
        },
        providers: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              providerId: { type: 'string' },
              status: { type: 'string', enum: ['healthy', 'degraded', 'offline'] },
            },
            required: ['providerId', 'status'],
          },
        },
      },
      required: ['status', 'version', 'gateway', 'registry', 'providers'],
    },
  };
}

// ── Reusable parameters, headers and security ────────────────────────────────

function parameters(): Readonly<Record<string, OpenApiParameter>> {
  return {
    IdempotencyKey: {
      name: 'Idempotency-Key',
      in: 'header',
      required: true,
      description:
        'Identifies the ATTEMPT, not the work. A retry with the same key and the same body returns the ORIGINAL response, status included. The window is 24 hours, scoped per tenant and per endpoint.',
      schema: { type: 'string' },
    },
    RequestId: {
      name: 'X-Request-Id',
      in: 'header',
      required: false,
      description: 'Echoed in every error body as `requestId`. Generated if absent.',
      schema: { type: 'string' },
    },
    CorrelationId: {
      name: 'X-Correlation-Id',
      in: 'header',
      required: false,
      description:
        'Groups everything caused by one client operation. MUST be a UUID — the Gateway validates it as one.',
      schema: { type: 'string', format: 'uuid' },
    },
    WorkspaceId: {
      name: 'X-Workspace-Id',
      in: 'header',
      required: false,
      description:
        'The workspace to act in. Checked against membership; an API key bound to one workspace does not need it.',
      schema: { type: 'string', format: 'uuid' },
    },
    ResumeToken: {
      name: 'resumeToken',
      in: 'query',
      required: false,
      description:
        'An opaque token from a previous stream cursor. A token this platform did not mint is REJECTED rather than treated as absent.',
      schema: { type: 'string' },
    },
    LastEventId: {
      name: 'Last-Event-ID',
      in: 'header',
      required: false,
      description: 'The same resume position, for a client that reconnects rather than re-queries.',
      schema: { type: 'string' },
    },
    ResourceId: {
      name: 'id',
      in: 'path',
      required: true,
      description: 'The resource identifier. Permanent across API versions.',
      schema: { type: 'string' },
    },
  };
}

function headers(): Readonly<Record<string, OpenApiHeader>> {
  return {
    ApiVersion: {
      description: 'The API version that answered. Present on every response.',
      schema: { type: 'string', example: 'v1' },
    },
    Deprecation: {
      description: 'HTTP-date. Present on every response of a deprecated version.',
      schema: { type: 'string' },
    },
    Sunset: {
      description: 'HTTP-date. When this version stops serving and begins returning 410.',
      schema: { type: 'string' },
    },
    Link: {
      description: 'The migration guide, as `<url>; rel="deprecation"`.',
      schema: { type: 'string' },
    },
    RateLimitLimit: {
      description: 'The binding policy’s ceiling. Returned on EVERY response, not only 429.',
      schema: { type: 'integer' },
    },
    RateLimitRemaining: {
      description: 'Requests left in the current window.',
      schema: { type: 'integer' },
    },
    RateLimitReset: {
      description: 'Unix timestamp in seconds at which a slot frees.',
      schema: { type: 'integer' },
    },
    RetryAfter: { description: 'Seconds to wait before retrying.', schema: { type: 'integer' } },
    Allow: { description: 'Methods this path accepts.', schema: { type: 'string' } },
    WwwAuthenticate: {
      description: `The challenge. Always \`${WWW_AUTHENTICATE}\`.`,
      schema: { type: 'string' },
    },
    IdempotencyKey: {
      description: 'Echoed back on any response that participated in idempotency.',
      schema: { type: 'string' },
    },
    IdempotentReplay: {
      description: '`true` when this response was REPLAYED rather than executed.',
      schema: { type: 'string', enum: ['true'] },
    },
  };
}

/** Headers every successful response carries. Referenced, never restated. */
const SUCCESS_HEADERS: Readonly<Record<string, { readonly $ref: string }>> = Object.freeze({
  [API_VERSION_HEADER]: { $ref: '#/components/headers/ApiVersion' },
  'x-ratelimit-limit': { $ref: '#/components/headers/RateLimitLimit' },
  'x-ratelimit-remaining': { $ref: '#/components/headers/RateLimitRemaining' },
  'x-ratelimit-reset': { $ref: '#/components/headers/RateLimitReset' },
});

const IDEMPOTENT_HEADERS: Readonly<Record<string, { readonly $ref: string }>> = Object.freeze({
  ...SUCCESS_HEADERS,
  [IDEMPOTENCY_KEY_HEADER]: { $ref: '#/components/headers/IdempotencyKey' },
  [IDEMPOTENT_REPLAY_HEADER]: { $ref: '#/components/headers/IdempotentReplay' },
});

function securitySchemes(): Readonly<Record<string, Readonly<Record<string, unknown>>>> {
  return {
    bearerAuth: {
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
      description:
        'A first-party access token. HS256; the issuer and audience are checked, and a token with no `exp` is refused rather than treated as unlimited. Roles and permissions in a payload are IGNORED — authority is resolved per request from live memberships.',
    },
    apiKeyAuth: {
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
      description:
        'A key of the form `cos_<keyId>_<secret>`. Also accepted as `Authorization: ApiKey <key>`. Presenting BOTH an Authorization header and X-API-Key is refused rather than resolved by precedence.',
    },
  };
}

// ── Operations, generated from the route table ───────────────────────────────

const SUMMARIES: Readonly<Record<AiRoute['handler'], { summary: string; description: string }>> = {
  execute: {
    summary: 'Execute an AI request',
    description:
      'Renders a registered prompt template and executes it, returning the completed result. Clients submit a template reference and variables, never prompt text.',
  },
  stream: {
    summary: 'Execute an AI request, streaming',
    description:
      'The same work as /v1/ai/execute, delivered as NDJSON. HTTP streaming only; there is no WebSocket transport.',
  },
  job: { summary: 'Read a job', description: 'Status of one job in the caller’s workspace.' },
  workflow: {
    summary: 'Read a workflow run',
    description: 'Status and per-step metadata for one run. Generated content is not included.',
  },
  listProviders: {
    summary: 'List providers',
    description: 'Registered providers, their declared capabilities and their reported health.',
  },
  health: {
    summary: 'AI service health',
    description:
      'Service status, provider registry state, gateway readiness and build version. No database diagnostics.',
  },
};

/** `/v1/ai/jobs/:id` → `/v1/ai/jobs/{id}`, which is OpenAPI's path form. */
export function toOpenApiPath(pattern: string): string {
  return pattern.replace(/:([A-Za-z][A-Za-z0-9]*)/g, '{$1}');
}

function operationFor(route: AiRoute): OpenApiOperation {
  const isExecution = route.method === 'POST';
  const isStream = route.handler === 'stream';
  const hasPathParam = route.pattern.includes(':');
  const summary = SUMMARIES[route.handler];

  const params: (OpenApiParameter | { $ref: string })[] = [
    { $ref: '#/components/parameters/RequestId' },
    { $ref: '#/components/parameters/CorrelationId' },
    { $ref: '#/components/parameters/WorkspaceId' },
  ];
  if (hasPathParam) params.unshift({ $ref: '#/components/parameters/ResourceId' });
  if (isExecution) params.push({ $ref: '#/components/parameters/IdempotencyKey' });
  if (isStream) {
    params.push(
      { $ref: '#/components/parameters/ResumeToken' },
      { $ref: '#/components/parameters/LastEventId' },
    );
  }

  const success: OpenApiResponse = isStream
    ? {
        description:
          'A stream of newline-delimited JSON. Each line is one StreamEvent. The stream ends with a `completed` or `failed` event; a connection that closes without either was interrupted, and the cursor on the last event received is where to resume from.',
        headers: SUCCESS_HEADERS,
        content: {
          'application/x-ndjson': { schema: { $ref: REF.streamEvent } },
        },
      }
    : {
        description: 'Success.',
        headers: isExecution ? IDEMPOTENT_HEADERS : SUCCESS_HEADERS,
        content: {
          'application/json': {
            schema: {
              $ref: `#/components/schemas/${
                route.handler === 'execute'
                  ? 'ExecuteResponse'
                  : route.handler === 'job'
                    ? 'Job'
                    : route.handler === 'workflow'
                      ? 'Workflow'
                      : route.handler === 'listProviders'
                        ? 'ProviderList'
                        : 'Health'
              }`,
            },
          },
        },
      };

  // Which failures this operation can actually produce. Every one references
  // the shared response component; none restates the envelope.
  const statuses = new Set<number>([400, 401, 403, 405, 410, 429, 500, 503]);
  if (hasPathParam || route.handler !== 'health') statuses.add(404);
  if (isExecution) {
    statuses.add(409);
    statuses.add(413);
    statuses.add(422);
    statuses.add(502);
    statuses.add(504);
  }

  const responses: Record<string, OpenApiResponse | { $ref: string }> = { '200': success };
  for (const status of [...statuses].sort((left, right) => left - right)) {
    responses[String(status)] = { $ref: `#/components/responses/${errorResponseName(status)}` };
  }

  return {
    operationId: route.handler,
    summary: summary.summary,
    description: `${summary.description}\n\nRequires \`${route.permission}\`. Rate-limit class \`${route.rateLimitClass}\`.`,
    tags: ['AI'],
    parameters: Object.freeze(params),
    ...(isExecution
      ? {
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ExecuteRequest' } },
            },
          },
        }
      : {}),
    responses: Object.freeze(responses),
    // Either credential. Two entries mean OR; one entry with two keys would
    // mean AND, and requiring both is not what the middleware does.
    security: Object.freeze([{ bearerAuth: [] }, { apiKeyAuth: [] }]),
  };
}

export interface OpenApiOptions {
  readonly registry: VersionRegistry;
  /** The build. Supplied, never read from disk. */
  readonly serviceVersion: string;
  readonly serverUrl?: string;
  /** Defaults to the frozen route table; injectable for tests. */
  readonly routes?: readonly AiRoute[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

/**
 * The document.
 *
 * Deterministic: no clock, no random source, and paths emitted in the route
 * table's own order. Two builds of the same tree produce byte-identical JSON,
 * which is what makes a specification diff reviewable.
 */
export function createOpenApiDocument(options: OpenApiOptions): OpenApiDocument {
  const routes = options.routes ?? AI_ROUTES;

  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  for (const route of routes) {
    const path = toOpenApiPath(route.pattern);
    const existing = paths[path] ?? {};
    existing[route.method.toLowerCase()] = operationFor(route);
    paths[path] = existing;
  }

  const responses: Record<string, OpenApiResponse> = {};
  for (const status of DOCUMENTED_STATUSES) {
    responses[errorResponseName(status)] = errorResponse(status);
  }

  const serving = options.registry.serving();
  const deprecated = serving.filter((entry) => entry.status === 'deprecated');

  return deepFreeze({
    openapi: OPENAPI_VERSION,
    info: {
      title: 'ContentOS AI API',
      version: options.serviceVersion,
      description: [
        'The governed entry point to model intelligence.',
        '',
        `Current version: \`${options.registry.current.version}\`. Serving: ${serving
          .map((entry) => `\`${entry.version}\` (${entry.status})`)
          .join(', ')}.`,
        deprecated.length === 0
          ? ''
          : `Deprecated versions carry \`${DEPRECATION_HEADER}\`, \`${SUNSET_HEADER}\` and \`${LINK_HEADER}\` on every response, including error responses.`,
        '',
        'An unknown version is REJECTED, never defaulted; a retired one returns 410 rather than falling back to the current version, because falling back would apply this version’s authorization semantics to a client expecting another.',
        '',
        'Error codes are stable across versions. Response enums are OPEN — tolerate an unknown value rather than failing on it.',
      ]
        .filter((line) => line !== '')
        .join('\n'),
    },
    servers: [
      {
        url: options.serverUrl ?? 'https://api.contentos.ai',
        description: 'Production',
      },
    ],
    tags: [{ name: 'AI', description: 'Model execution, jobs, workflows and discovery.' }],
    paths,
    components: {
      schemas: schemas(),
      parameters: parameters(),
      headers: headers(),
      responses,
      securitySchemes: securitySchemes(),
    },
    security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
  });
}
