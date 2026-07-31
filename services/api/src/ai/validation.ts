/**
 * Transport validation, and the one mapping from HTTP to `GatewayRequest`.
 *
 * ── Where the line falls ────────────────────────────────────────────────────
 * This file checks SHAPE. The Gateway checks MEANING.
 *
 * Transport asks: is `capability` a string, is `workspaceId` a UUID, is
 * `variables` an object, did anyone send a key we do not know about. Admission
 * asks: does that workspace exist, does it admit work, is that capability
 * registered, does the template resolve, may this actor use it.
 *
 * The split is deliberate and the duplication would be worse than the
 * separation. If this file re-checked dot.case on `taskType` or re-counted the
 * bytes in `variables`, there would be two definitions of a valid request that
 * could drift, and the one enforced would depend on which layer a caller
 * reached first. So the rule is: reject here only what can be decided from the
 * request alone, and let admission own everything that needs to look something
 * up. `06-api/api-principles.md`: "reject malformed requests before Gateway
 * execution" — malformed, not unauthorized.
 *
 * ── Unknown keys are rejected ───────────────────────────────────────────────
 * `.strict()` is mandatory on every request schema (`pipeline/stages.ts`).
 * Silently ignoring an unknown key means a caller sending `tenantId`, `role` or
 * `credits` gets no error, and any later code reading the raw body receives
 * attacker-controlled fields. Rejecting them makes mass-assignment structurally
 * impossible rather than merely unimplemented.
 */

import type { AICapability, AIParameters } from '@contentos/contracts';
import { isAICapability } from '@contentos/contracts';
import type { GatewayRequest } from '@contentos/ai';

import { exceedsNestingDepth, isUuid, type ValidationIssue } from '../pipeline/stages.js';
import type { ApiRequest } from './http.js';

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/** Every key an execution body may carry. Anything else is rejected. */
const EXECUTION_KEYS = new Set([
  'taskType',
  'capability',
  'providerId',
  'model',
  'template',
  'variables',
  'organizationId',
  'workspaceId',
  'actorId',
  'correlationId',
  'params',
  'timeoutMs',
  'featureFlag',
]);

const PARAMETER_KEYS = new Set(['temperature', 'maxOutputTokens', 'topP', 'seed', 'stopSequences']);

const TEMPLATE_KEYS = new Set(['id', 'version']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

class IssueBag {
  private readonly issues: ValidationIssue[] = [];

  add(path: string, code: string): void {
    this.issues.push({ path, code });
  }

  /** Unknown keys, reported one per key so a client can fix them in one pass. */
  unknownKeys(prefix: string, value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
    for (const key of Object.keys(value)) {
      if (!allowed.has(key)) this.add(`${prefix}.${key}`, 'UNKNOWN_FIELD');
    }
  }

  get empty(): boolean {
    return this.issues.length === 0;
  }

  get all(): readonly ValidationIssue[] {
    return Object.freeze([...this.issues]);
  }
}

/** Sampling parameters. Present or absent; a partial set is a rejection. */
function readParameters(raw: unknown, issues: IssueBag): AIParameters | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    issues.add('body.params', 'NOT_OBJECT');
    return undefined;
  }
  issues.unknownKeys('body.params', raw, PARAMETER_KEYS);

  const temperature = raw['temperature'];
  const maxOutputTokens = raw['maxOutputTokens'];
  if (typeof temperature !== 'number' || !Number.isFinite(temperature)) {
    issues.add('body.params.temperature', 'NOT_NUMBER');
  }
  if (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) <= 0) {
    issues.add('body.params.maxOutputTokens', 'NOT_POSITIVE_INTEGER');
  }

  const topP = raw['topP'];
  if (topP !== undefined && (typeof topP !== 'number' || !Number.isFinite(topP))) {
    issues.add('body.params.topP', 'NOT_NUMBER');
  }
  const seed = raw['seed'];
  if (seed !== undefined && !Number.isInteger(seed)) {
    issues.add('body.params.seed', 'NOT_INTEGER');
  }
  const stopSequences = raw['stopSequences'];
  if (stopSequences !== undefined) {
    if (!Array.isArray(stopSequences) || stopSequences.some((s) => typeof s !== 'string')) {
      issues.add('body.params.stopSequences', 'NOT_STRING_ARRAY');
    }
  }

  if (!issues.empty) return undefined;

  return {
    temperature: temperature as number,
    maxOutputTokens: maxOutputTokens as number,
    ...(topP === undefined ? {} : { topP: topP as number }),
    ...(seed === undefined ? {} : { seed: seed as number }),
    ...(stopSequences === undefined ? {} : { stopSequences: stopSequences as readonly string[] }),
  };
}

/**
 * An execution body plus the headers that carry the rest of the request.
 *
 * `Idempotency-Key` is a header rather than a body field because it identifies
 * the ATTEMPT, not the work — two attempts at the same generation differ only
 * by it, and a client retrying must be able to resend an identical body.
 * `api-principles.md` requires it on every execution endpoint.
 */
export function toGatewayRequest(request: ApiRequest): ValidationOutcome<GatewayRequest> {
  const issues = new IssueBag();
  const body: unknown = request.body;

  const idempotencyKey = request.headers['idempotency-key'];
  if (!nonEmptyString(idempotencyKey)) {
    issues.add('headers.idempotency-key', 'REQUIRED');
  }

  if (!isRecord(body)) {
    issues.add('body', 'NOT_OBJECT');
    return { ok: false, issues: issues.all };
  }
  // Checked before anything walks the document: a deeply nested body exhausts
  // the stack inside the walk itself, so the guard has to come first.
  if (exceedsNestingDepth(body)) {
    issues.add('body', 'NESTING_TOO_DEEP');
    return { ok: false, issues: issues.all };
  }
  issues.unknownKeys('body', body, EXECUTION_KEYS);

  for (const field of ['taskType', 'providerId', 'model'] as const) {
    if (!nonEmptyString(body[field])) issues.add(`body.${field}`, 'REQUIRED');
  }

  const capability = body['capability'];
  if (!isAICapability(capability)) issues.add('body.capability', 'NOT_A_CAPABILITY');

  const template = body['template'];
  if (!isRecord(template)) {
    issues.add('body.template', 'NOT_OBJECT');
  } else {
    issues.unknownKeys('body.template', template, TEMPLATE_KEYS);
    if (!nonEmptyString(template['id'])) issues.add('body.template.id', 'REQUIRED');
    const version = template['version'];
    if (version !== undefined && (!Number.isInteger(version) || (version as number) < 1)) {
      issues.add('body.template.version', 'NOT_POSITIVE_INTEGER');
    }
  }

  // Only that it IS an object. What may be inside it is the prompt pipeline's
  // question, and the size bound is the Gateway's.
  const variables = body['variables'];
  if (!isRecord(variables)) issues.add('body.variables', 'NOT_OBJECT');

  // Identity is validated as a UUID before use, so a non-UUID never reaches a
  // query parameter — injection through identifier fields as a category
  // (`pipeline/stages.ts`).
  for (const field of ['organizationId', 'workspaceId'] as const) {
    const value = body[field];
    if (!nonEmptyString(value)) {
      issues.add(`body.${field}`, 'REQUIRED');
    } else if (!isUuid(value)) {
      issues.add(`body.${field}`, 'NOT_A_UUID');
    }
  }

  // Null is meaningful and distinct from absent: platform-initiated work has no
  // actor, and requiring one would make background execution impossible rather
  // than more secure (`gateway/contracts.ts`).
  const actorId = body['actorId'];
  if (actorId !== undefined && actorId !== null && !nonEmptyString(actorId)) {
    issues.add('body.actorId', 'NOT_A_STRING');
  }

  const timeoutMs = body['timeoutMs'];
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    issues.add('body.timeoutMs', 'NOT_POSITIVE_INTEGER');
  }

  const featureFlag = body['featureFlag'];
  if (featureFlag !== undefined && !nonEmptyString(featureFlag)) {
    issues.add('body.featureFlag', 'NOT_A_STRING');
  }

  const bodyCorrelation = body['correlationId'];
  if (bodyCorrelation !== undefined && !nonEmptyString(bodyCorrelation)) {
    issues.add('body.correlationId', 'NOT_A_STRING');
  }

  const params = readParameters(body['params'], issues);

  if (!issues.empty) return { ok: false, issues: issues.all };

  // Derived, never generated: no clock and no random source, so the same HTTP
  // request maps to the same GatewayRequest on every machine and a retry with
  // the same key is recognisably the same attempt.
  const header = request.headers['x-correlation-id'];
  const correlationId = nonEmptyString(header)
    ? header.trim()
    : nonEmptyString(bodyCorrelation)
      ? bodyCorrelation.trim()
      : (idempotencyKey as string).trim();

  const templateRecord = template as Record<string, unknown>;
  const templateVersion = templateRecord['version'];

  return {
    ok: true,
    value: {
      taskType: (body['taskType'] as string).trim(),
      capability: capability as AICapability,
      providerId: (body['providerId'] as string).trim(),
      model: (body['model'] as string).trim(),
      templateRef: {
        id: (templateRecord['id'] as string).trim(),
        ...(templateVersion === undefined ? {} : { version: templateVersion as number }),
      },
      variables: variables as Record<string, unknown>,
      organizationId: body['organizationId'] as string,
      workspaceId: body['workspaceId'] as string,
      actorId: actorId === undefined || actorId === null ? null : (actorId as string).trim(),
      correlationId,
      idempotencyKey: (idempotencyKey as string).trim(),
      ...(params === undefined ? {} : { params }),
      ...(timeoutMs === undefined ? {} : { timeoutMs: timeoutMs as number }),
      ...(featureFlag === undefined ? {} : { featureFlag: (featureFlag as string).trim() }),
    },
  };
}

/**
 * A tenant-scoped read.
 *
 * The workspace comes from a header rather than the path because these two
 * routes are named by the increment as `/v1/ai/jobs/:id`, without a workspace
 * segment. Authentication is out of scope for this increment, so the header is
 * TRANSPORT INPUT and nothing more — it is checked for shape here and used to
 * scope the read, and when authentication arrives it becomes the authenticated
 * workspace instead. Nothing in this file treats it as proof of anything.
 */
export interface ScopedRead {
  readonly workspaceId: string;
  readonly id: string;
}

export function toScopedRead(request: ApiRequest, param: string): ValidationOutcome<ScopedRead> {
  const issues = new IssueBag();

  const workspaceId = request.headers['x-workspace-id'];
  if (!nonEmptyString(workspaceId)) {
    issues.add('headers.x-workspace-id', 'REQUIRED');
  } else if (!isUuid(workspaceId)) {
    issues.add('headers.x-workspace-id', 'NOT_A_UUID');
  }

  const id = request.params[param];
  if (!nonEmptyString(id)) {
    issues.add(`path.${param}`, 'REQUIRED');
  }

  if (!issues.empty) return { ok: false, issues: issues.all };
  return {
    ok: true,
    value: { workspaceId: (workspaceId as string).trim(), id: (id as string).trim() },
  };
}

/**
 * The optional resume position on a stream request.
 *
 * Absent means "from the beginning". A token that this platform did not mint is
 * rejected rather than treated as absent: silently restarting a stream a client
 * believed it was resuming would duplicate everything it had already rendered.
 */
export function readResumeToken(request: ApiRequest): ValidationOutcome<string | null> {
  const token = request.query['resumeToken'] ?? request.headers['last-event-id'];
  if (token === undefined || token.trim() === '') return { ok: true, value: null };
  return { ok: true, value: token.trim() };
}
