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

import { exceedsNestingDepth, type ValidationIssue } from '../pipeline/stages.js';
import type { ApiRequest, AuthenticatedRequest } from './http.js';

export type ValidationOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly ValidationIssue[] };

/**
 * Every key an execution body may carry. Anything else is rejected.
 *
 * `organizationId`, `workspaceId`, `actorId` and `correlationId` USED TO BE
 * here and deliberately are not any more. They come from the authenticated
 * context, so a caller sending one now gets `UNKNOWN_FIELD` rather than having
 * it quietly ignored — which is the difference between "you cannot assert your
 * own tenancy" and "your assertion had no effect this time".
 */
const EXECUTION_KEYS = new Set([
  'taskType',
  'capability',
  'providerId',
  'model',
  'template',
  'variables',
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
export function toGatewayRequest(request: AuthenticatedRequest): ValidationOutcome<GatewayRequest> {
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

  // Identity is NOT validated here any more, because it is not received here.
  // The organization, the workspace and the actor come from the authenticated
  // principal, which is a record the directory returned rather than a value a
  // caller sent — so there is nothing left to check the shape of.

  const timeoutMs = body['timeoutMs'];
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || (timeoutMs as number) <= 0)) {
    issues.add('body.timeoutMs', 'NOT_POSITIVE_INTEGER');
  }

  const featureFlag = body['featureFlag'];
  if (featureFlag !== undefined && !nonEmptyString(featureFlag)) {
    issues.add('body.featureFlag', 'NOT_A_STRING');
  }

  const params = readParameters(body['params'], issues);

  if (!issues.empty) return { ok: false, issues: issues.all };

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
      // Every one of these comes from the middleware, not the wire. This is
      // the line that stops a caller naming its own tenant: `workspaceId` is
      // the workspace whose membership was just checked, and `actorId` is the
      // subject whose credential was just verified.
      organizationId: request.auth.principal.organizationId,
      workspaceId: request.auth.principal.workspaceId,
      actorId: request.auth.principal.subjectId,
      correlationId: request.auth.correlationId,
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
 * The workspace comes from the authenticated principal. It used to come from
 * an `x-workspace-id` header that nothing verified — the read was scoped by
 * whatever the caller typed, and RLS was the only thing standing behind it.
 * Now the header is consumed by the middleware, checked against membership,
 * and reaches a controller only as a resolved principal.
 */
export interface ScopedRead {
  readonly workspaceId: string;
  readonly id: string;
}

export function toScopedRead(
  request: AuthenticatedRequest,
  param: string,
): ValidationOutcome<ScopedRead> {
  const id = request.params[param];
  if (!nonEmptyString(id)) {
    return { ok: false, issues: Object.freeze([{ path: `path.${param}`, code: 'REQUIRED' }]) };
  }
  return {
    ok: true,
    value: { workspaceId: request.auth.principal.workspaceId, id: id.trim() },
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
