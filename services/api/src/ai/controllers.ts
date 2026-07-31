/**
 * The AI controllers.
 *
 * Six endpoints, each a pure function of its dependencies and one request.
 * Every one of them does the same four things and nothing else: validate the
 * transport, map HTTP to a `GatewayRequest`, hand it to the Gateway, and map
 * what comes back to a response. No controller builds an `AIRequest`, resolves
 * a tenant, checks a membership, reads a flag, prices a call or decides which
 * provider runs — all of which already have owners, and all of which would be
 * unreachable from here even if one tried, because the only thing a controller
 * holds is a port.
 *
 * ── The error mapping is the security boundary ──────────────────────────────
 * Two tables below turn an internal code into an HTTP status and an API error
 * code. They are exhaustive `Record` types, so a new rejection code or provider
 * error code fails to compile until someone decides what a client should see.
 * The alternative — a `default:` arm — is how an unmapped internal failure
 * quietly becomes a 500 carrying its own message.
 *
 * Nothing from a rejection's `reason` or a `ProviderError`'s `message` reaches
 * a response body. Those strings are for operators and they contain ids,
 * template names and vendor text; `api-principles.md` forbids all three in an
 * error, and the way to honour that reliably is to have no code path that
 * copies them.
 *
 * ── 404 for another tenant's resource ───────────────────────────────────────
 * A job that exists in a workspace the caller did not name reads as absent.
 * A 403 would confirm the id is real, which is the disclosure the rule exists
 * to prevent.
 */

import { isProviderError, type ProviderErrorCode } from '@contentos/contracts';
import {
  cursorFromToken,
  type AdmissionResult,
  type Gateway,
  type Job,
  type ModelProvider,
  type ProviderHealthStatus,
  type ProviderRegistry,
  type RejectionCode,
  type StreamEvent,
  type WorkflowExecution,
} from '@contentos/ai';

import type { ValidationIssue } from '../pipeline/stages.js';
import {
  errorFor,
  ok,
  requestIdOf,
  type ApiErrorCode,
  type ApiRequest,
  type ApiResponse,
  type ApiResult,
  type ApiStreamResponse,
} from './http.js';
import type { AiDispatcher, JobReader, WorkflowReader } from './ports.js';
import { readResumeToken, toGatewayRequest, toScopedRead } from './validation.js';

export interface AiControllerOptions {
  readonly gateway: Gateway;
  readonly dispatcher: AiDispatcher;
  readonly jobs: JobReader;
  readonly workflows: WorkflowReader;
  readonly providers: ProviderRegistry;
  /** The build. Supplied, never read from disk at request time. */
  readonly version: string;
}

export interface AiControllers {
  execute(request: ApiRequest): Promise<ApiResponse>;
  stream(request: ApiRequest): Promise<ApiResult>;
  job(request: ApiRequest): Promise<ApiResponse>;
  workflow(request: ApiRequest): Promise<ApiResponse>;
  listProviders(request: ApiRequest): Promise<ApiResponse>;
  health(request: ApiRequest): Promise<ApiResponse>;
}

// ── Internal code → what a client sees ───────────────────────────────────────

/**
 * Every admission rejection, mapped.
 *
 * `UnknownProvider` is a 400 and not a 404: the provider is a field in the
 * request, not the resource being addressed, so naming one that does not exist
 * makes the request invalid rather than the target missing.
 *
 * `CapabilityUnavailable` and `PreparationFailed` are 422 — well-formed,
 * understood, and impossible to serve as asked. Retrying either unchanged
 * produces the same answer, which is what distinguishes them from a 503.
 */
const REJECTION_RESPONSE: Readonly<Record<RejectionCode, readonly [number, ApiErrorCode]>> = {
  MalformedRequest: [400, 'invalid_request'],
  RequestTooLarge: [413, 'request_too_large'],
  UnknownOrganization: [404, 'not_found'],
  OrganizationNotAdmitting: [403, 'forbidden'],
  UnknownWorkspace: [404, 'not_found'],
  WorkspaceNotAdmitting: [403, 'forbidden'],
  TenantMismatch: [403, 'forbidden'],
  MembershipRequired: [403, 'forbidden'],
  UnknownProvider: [400, 'invalid_request'],
  CapabilityUnavailable: [422, 'unprocessable'],
  UnknownPrompt: [404, 'not_found'],
  FeatureDisabled: [403, 'forbidden'],
  PreparationFailed: [422, 'unprocessable'],
};

/**
 * Every provider failure, mapped.
 *
 * `Authentication` is a 502 and not a 401: it is OUR credential that the vendor
 * refused, and a 401 would tell a customer to re-authenticate against a problem
 * they cannot fix and did not cause.
 *
 * `Validation` is a 500 for the same reason inverted — a malformed request to a
 * vendor is this platform's defect, and blaming the caller for it would send
 * them looking through a body that was correct.
 *
 * `ContentFiltered` is 422 and terminal, per `ai-api.md`: "never retried, by
 * any component, under any circumstance."
 */
const PROVIDER_RESPONSE: Readonly<Record<ProviderErrorCode, readonly [number, ApiErrorCode]>> = {
  Authentication: [502, 'provider_unavailable'],
  RateLimit: [429, 'rate_limited'],
  Unavailable: [503, 'provider_unavailable'],
  Timeout: [504, 'timeout'],
  Validation: [500, 'internal_error'],
  ContentFiltered: [422, 'unprocessable'],
  ContextTooLarge: [413, 'request_too_large'],
  ModelUnavailable: [503, 'provider_unavailable'],
  MalformedResponse: [502, 'provider_unavailable'],
  Internal: [502, 'provider_unavailable'],
};

/** A rejection, as a response. The `reason` is deliberately not read. */
export function rejectionResponse(code: RejectionCode, requestId: string): ApiResponse {
  const [status, apiCode] = REJECTION_RESPONSE[code];
  return errorFor(status, apiCode, requestId);
}

/**
 * A thrown failure, as a response.
 *
 * Anything that is not a `ProviderError` is an unrecognised failure and becomes
 * an opaque 500 — the policy `pipeline/stages.ts` already applies to the
 * middleware, applied here for the same reason: the alternative is returning
 * whatever a stack trace happened to say.
 */
export function failureResponse(failure: unknown, requestId: string): ApiResponse {
  if (!isProviderError(failure)) return errorFor(500, 'internal_error', requestId);

  const [status, apiCode] = PROVIDER_RESPONSE[failure.code];
  // `Retry-After` is the provider's own, in seconds, and only where it gave
  // one. Inventing a number would have clients synchronise on a value nothing
  // measured.
  const retryAfter =
    failure.retryAfterMs === null
      ? {}
      : { 'retry-after': String(Math.max(1, Math.ceil(failure.retryAfterMs / 1000))) };
  return errorFor(status, apiCode, requestId, undefined, retryAfter);
}

const invalid = (issues: readonly ValidationIssue[], requestId: string): ApiResponse =>
  errorFor(400, 'invalid_request', requestId, issues);

// ── Safe projections ─────────────────────────────────────────────────────────

/**
 * A job, minus its payload.
 *
 * The payload holds the variables a caller sent, which are customer content and
 * are marked untrusted everywhere else in the platform. A status endpoint that
 * echoed them would be a second, unaudited read path for the same data.
 */
function jobView(job: Job): unknown {
  return {
    id: job.id,
    status: job.status,
    jobType: job.jobType,
    workspaceId: job.workspaceId,
    correlationId: job.correlationId,
    reason: job.reason,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
  };
}

/**
 * A workflow execution, minus the generated content.
 *
 * Each step's `content` is the model's output. Returning it here would make a
 * status route a results route, and the two have different authorization in
 * `research-api.md`. Everything that describes the run — versions, usage,
 * finish reasons — stays.
 */
function workflowView(execution: WorkflowExecution): unknown {
  return {
    workflowId: execution.workflowId,
    definitionId: execution.definition.id,
    definitionVersion: execution.definition.version,
    status: execution.state.status,
    stepIndex: execution.state.stepIndex,
    stepId: execution.state.stepId,
    jobId: execution.context.jobId,
    correlationId: execution.context.correlationId,
    // `state.failure` is deliberately absent. It is an internally-worded string
    // that can name a template or carry a prompt error, and the rule against
    // returning those does not stop applying because the status line says 200.
    // A failure CATEGORY belongs to the canonical `Run` resource, which is not
    // in this increment; until it exists, `status: 'failed'` is the honest
    // amount to say.
    steps: execution.state.completedSteps.map((step) => ({
      stepId: step.stepId,
      promptVersion: step.promptVersion,
      providerId: step.providerId,
      model: step.model,
      finishReason: step.finishReason,
      usage: step.usage,
    })),
  };
}

/**
 * Supported models, where a provider publishes them.
 *
 * `ModelProvider` does not declare a `models` field — the port is frozen and
 * declares capabilities, not a catalogue. The increment asks for models "if
 * available", so an adapter that happens to publish them is read, and one that
 * does not omits the field rather than reporting an empty list. An empty array
 * would read as "this provider supports no models".
 */
function modelsOf(provider: ModelProvider): readonly string[] | undefined {
  const declared: unknown = (provider as unknown as Record<string, unknown>)['models'];
  if (!Array.isArray(declared)) return undefined;
  const models = declared.filter((model): model is string => typeof model === 'string');
  return models.length === 0 ? undefined : Object.freeze(models);
}

/**
 * A provider's health, or `offline` if asking threw.
 *
 * A discovery endpoint that failed because one adapter's health call raised
 * would take out the view of every other provider — and an adapter that cannot
 * answer is, from a caller's position, exactly offline.
 */
async function healthOf(
  provider: ModelProvider,
): Promise<{ status: ProviderHealthStatus; reportedAt: string | null }> {
  try {
    const health = await provider.health();
    return { status: health.status, reportedAt: health.reportedAt };
  } catch {
    return { status: 'offline', reportedAt: null };
  }
}

// ── The controllers ──────────────────────────────────────────────────────────

export function createAiControllers(options: AiControllerOptions): AiControllers {
  const { gateway, dispatcher, jobs, workflows, providers, version } = options;

  /**
   * Transport validation, then admission. The shared opening of both execution
   * endpoints, and the only place either of them talks to the Gateway.
   */
  async function admit(
    request: ApiRequest,
    requestId: string,
  ): Promise<{ admitted: AdmissionResult } | { refused: ApiResponse }> {
    const mapped = toGatewayRequest(request);
    if (!mapped.ok) return { refused: invalid(mapped.issues, requestId) };

    const response = await gateway.admit(mapped.value);
    if (!response.admitted) {
      const { decision } = response;
      /* c8 ignore next */
      if (decision.outcome !== 'reject')
        return { refused: errorFor(500, 'internal_error', requestId) };
      return { refused: rejectionResponse(decision.code, requestId) };
    }
    return { admitted: response.result };
  }

  return {
    async execute(request: ApiRequest): Promise<ApiResponse> {
      const requestId = requestIdOf(request);
      const outcome = await admit(request, requestId);
      if ('refused' in outcome) return outcome.refused;

      const { admitted } = outcome;
      try {
        const response = await dispatcher.execute(admitted);
        return ok({
          workflowId: admitted.workflowId,
          promptVersion: admitted.promptVersion,
          capability: admitted.capability,
          correlationId: admitted.context.correlationId,
          idempotencyKey: admitted.context.idempotencyKey,
          // Echoed, not disclosed: the caller named this provider and model in
          // the request. `ai-api.md` withholds provider identity from the
          // customer intent API, where the platform chooses — see the note in
          // the deliverable.
          providerId: response.providerId,
          model: response.model,
          content: response.content,
          finishReason: response.finishReason,
          usage: response.usage,
        });
      } catch (failure) {
        return failureResponse(failure, requestId);
      }
    },

    /**
     * The streaming endpoint.
     *
     * Errors split at the moment the first byte is written. Before it — bad
     * transport, a refused admission, a provider that will not stream — the
     * response is an ordinary JSON error with a real status. After it, the
     * status line is long gone, so a failure becomes an in-band `failed` event
     * on the same stream. A transport that tried to change the status at that
     * point would be writing a header into a body.
     */
    async stream(request: ApiRequest): Promise<ApiResult> {
      const requestId = requestIdOf(request);

      const resumeToken = readResumeToken(request);
      /* c8 ignore next */
      if (!resumeToken.ok) return invalid(resumeToken.issues, requestId);
      const resume = resumeToken.value === null ? null : cursorFromToken(resumeToken.value);
      if (resumeToken.value !== null && resume === null) {
        return invalid([{ path: 'query.resumeToken', code: 'UNRECOGNISED' }], requestId);
      }

      const outcome = await admit(request, requestId);
      if ('refused' in outcome) return outcome.refused;
      const { admitted } = outcome;

      // Opened before the response is returned, so a provider that refuses
      // outright is still an HTTP error rather than a stream containing one
      // event. The first event is pulled here; the rest are pulled by the
      // adapter as it writes.
      const events = dispatcher.stream(admitted, resume)[Symbol.asyncIterator]();
      let first: IteratorResult<StreamEvent>;
      try {
        first = await events.next();
      } catch (failure) {
        return failureResponse(failure, requestId);
      }

      const streamed: ApiStreamResponse = {
        status: 200,
        headers: Object.freeze({
          'content-type': 'application/x-ndjson',
          // Streamed bodies must not be buffered by an intermediary; a proxy
          // holding them until completion turns a stream into a slow response.
          'cache-control': 'no-store',
          'x-accel-buffering': 'no',
        }),
        lines: {
          async *[Symbol.asyncIterator](): AsyncIterator<string> {
            if (first.done === true) return;
            yield `${JSON.stringify(first.value)}\n`;
            try {
              for (;;) {
                const next = await events.next();
                if (next.done === true) return;
                yield `${JSON.stringify(next.value)}\n`;
              }
            } catch (failure) {
              // In-band, because the status line was sent with the first event.
              // The code is the canonical taxonomy's; the vendor's message is
              // not carried, exactly as in a JSON error body.
              const event: StreamEvent = {
                kind: 'failed',
                streamId: admitted.request.idempotencyKey,
                code: isProviderError(failure) ? failure.code : 'Internal',
                reason: 'The stream failed.',
                cursor: {
                  streamId: admitted.request.idempotencyKey,
                  lastSequence: null,
                  completed: false,
                  resumeToken: '',
                },
              };
              yield `${JSON.stringify(event)}\n`;
            }
          },
        },
      };
      return Object.freeze(streamed);
    },

    async job(request: ApiRequest): Promise<ApiResponse> {
      const requestId = requestIdOf(request);
      const scoped = toScopedRead(request, 'id');
      if (!scoped.ok) return invalid(scoped.issues, requestId);

      const found = await jobs.findById(scoped.value.workspaceId, scoped.value.id);
      if (found === null) return errorFor(404, 'not_found', requestId);
      return ok(jobView(found));
    },

    async workflow(request: ApiRequest): Promise<ApiResponse> {
      const requestId = requestIdOf(request);
      const scoped = toScopedRead(request, 'id');
      if (!scoped.ok) return invalid(scoped.issues, requestId);

      const found = await workflows.findById(scoped.value.workspaceId, scoped.value.id);
      if (found === null) return errorFor(404, 'not_found', requestId);
      return ok(workflowView(found));
    },

    async listProviders(_request: ApiRequest): Promise<ApiResponse> {
      const listed = await Promise.all(
        providers.list().map(async (provider) => {
          const models = modelsOf(provider);
          return {
            providerId: provider.providerId,
            displayName: provider.displayName,
            capabilities: provider.capabilities,
            health: await healthOf(provider),
            ...(models === undefined ? {} : { models }),
          };
        }),
      );
      return ok({ providers: listed });
    },

    /**
     * Readiness for AI work specifically.
     *
     * No database diagnostics: `health/endpoints.ts` already owns the process
     * probes that Kubernetes reads, and duplicating a dependency check here
     * would give an operator two answers about one thing. What this reports is
     * what only the AI layer knows — whether the registry is sealed, and what
     * the providers say about themselves.
     */
    async health(_request: ApiRequest): Promise<ApiResponse> {
      const listed = await Promise.all(
        providers.list().map(async (provider) => ({
          providerId: provider.providerId,
          status: (await healthOf(provider)).status,
        })),
      );

      const usable = listed.filter((entry) => entry.status !== 'offline').length;
      // Sealed AND at least one provider that could take a call. A sealed
      // registry of offline providers admits requests it cannot serve, and
      // reporting that as ready is how a deploy goes green while failing.
      const ready = providers.sealed && usable > 0;

      return ok(
        {
          status: ready ? 'ok' : 'degraded',
          version,
          gateway: { ready },
          registry: { sealed: providers.sealed, providers: listed.length },
          providers: listed,
        },
        // 200 either way: this endpoint answers a question, and a non-200 would
        // make a monitoring probe unable to distinguish "degraded" from
        // "the endpoint is down".
        {},
      );
    },
  };
}
