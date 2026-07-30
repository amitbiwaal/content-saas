/**
 * Canonical contract validation.
 *
 * The shapes are declared in `@contentos/contracts`; the checking lives here.
 * That is the same split the event envelope uses — `ENVELOPE_FIELDS` in
 * contracts, `validateEnvelope` in `packages/events` — and it exists so the
 * contracts package keeps its zero dependencies and stays usable in a browser
 * bundle.
 *
 * ── Why validate at all, when TypeScript already typed it ───────────────────
 * The types hold inside the monorepo. They do not hold for a request rebuilt
 * from a job payload, replayed from an event, or handed over an admin API —
 * and a malformed request that reaches a vendor costs a customer money before
 * anything notices. Validation runs BEFORE a provider is contacted, so a bad
 * request fails free.
 *
 * Every issue is reported rather than the first, so a caller fixing a malformed
 * request sees the whole picture in one cycle.
 */

import {
  AI_REQUEST_FIELDS,
  AI_RESPONSE_FIELDS,
  isAICapability,
  isFinishReason,
  type AIMessage,
  type AIRequest,
  type AIResponse,
  type Usage,
} from '@contentos/contracts';

export interface AIValidationIssue {
  readonly field: string;
  readonly code: string;
  readonly detail: string;
}

export type AIValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly issues: readonly AIValidationIssue[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** dot.case, opaque to this platform: 'planning.outline'. */
const TASK_TYPE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;
/**
 * The ledger's own money format: non-negative, at most six decimal places, no
 * sign, exponent or leading zeroes. Written out rather than imported because
 * `packages/platform` is another feature package — but deliberately IDENTICAL,
 * so a cost can be handed to the ledger without conversion.
 */
const DECIMAL = /^(0|[1-9]\d*)(\.\d{1,6})?$/;
const CURRENCY = /^[A-Z]{3}$/;

/** A response is metered; an hour of drift makes a cost report unreadable. */
const MAX_LATENCY_MS = 24 * 60 * 60 * 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateMessages(
  messages: readonly AIMessage[],
  add: (field: string, code: string, detail: string) => void,
): void {
  if (!Array.isArray(messages)) {
    add('messages', 'NOT_ARRAY', 'messages must be an array.');
    return;
  }
  if (messages.length === 0) {
    add('messages', 'EMPTY', 'A request with no messages has nothing to send.');
    return;
  }
  messages.forEach((message, i) => {
    if (!isRecord(message)) {
      add(`messages[${String(i)}]`, 'NOT_OBJECT', 'Each message must be an object.');
      return;
    }
    const role = message['role'];
    if (role !== 'system' && role !== 'user' && role !== 'assistant') {
      add(
        `messages[${String(i)}].role`,
        'BAD_ROLE',
        `'${String(role)}' is not a platform role. Adapters map to and from system, user and assistant.`,
      );
    }
    const content = message['content'];
    if (typeof content !== 'string' || content.length === 0) {
      add(`messages[${String(i)}].content`, 'EMPTY', 'Message content is required.');
    }
  });
}

export function validateAIRequest(request: AIRequest): AIValidationResult {
  const issues: AIValidationIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push({ field, code, detail });
  };

  for (const field of AI_REQUEST_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(request, field)) {
      add(field, 'MISSING_FIELD', `'${field}' is required on every AIRequest.`);
    }
  }

  if (typeof request.taskType !== 'string' || !TASK_TYPE.test(request.taskType)) {
    add('taskType', 'BAD_FORMAT', "taskType must be dot.case, e.g. 'planning.outline'.");
  }
  if (!isAICapability(request.capability)) {
    add(
      'capability',
      'UNKNOWN_CAPABILITY',
      `'${String(request.capability)}' is not a declared capability.`,
    );
  }
  if (typeof request.model !== 'string' || request.model.trim() === '') {
    add('model', 'EMPTY', 'A request must name the model it wants.');
  }

  validateMessages(request.messages, add);

  const params: unknown = request.params;
  if (!isRecord(params)) {
    add(
      'params',
      'MISSING_FIELD',
      'params is required; defaults belong to the caller, not the vendor.',
    );
  } else {
    const temperature = params['temperature'];
    if (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0) {
      add('params.temperature', 'BAD_VALUE', 'temperature must be a finite number >= 0.');
    }
    const maxOutputTokens = params['maxOutputTokens'];
    if (!Number.isInteger(maxOutputTokens) || (maxOutputTokens as number) < 1) {
      add('params.maxOutputTokens', 'BAD_VALUE', 'maxOutputTokens must be an integer >= 1.');
    }
    const topP = params['topP'];
    if (topP !== undefined && (typeof topP !== 'number' || topP <= 0 || topP > 1)) {
      add('params.topP', 'BAD_VALUE', 'topP, when given, must be in (0, 1].');
    }
    const seed = params['seed'];
    if (seed !== undefined && !Number.isInteger(seed)) {
      add('params.seed', 'BAD_VALUE', 'seed, when given, must be an integer.');
    }
    const stopSequences = params['stopSequences'];
    if (stopSequences !== undefined && !Array.isArray(stopSequences)) {
      add('params.stopSequences', 'NOT_ARRAY', 'stopSequences, when given, must be an array.');
    }
  }

  // A request with no deadline is one that can hold a worker open for as long
  // as a vendor is willing to stall.
  if (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1) {
    add('timeoutMs', 'BAD_VALUE', 'timeoutMs must be an integer >= 1; adapters never extend it.');
  }
  if (typeof request.idempotencyKey !== 'string' || request.idempotencyKey.trim() === '') {
    add(
      'idempotencyKey',
      'EMPTY',
      'idempotencyKey is required on every request, so a retry cannot become a second charge.',
    );
  }
  if (!UUID.test(request.correlationId)) {
    add('correlationId', 'NOT_UUID', 'correlationId must be a UUID.');
  }
  if (!UUID.test(request.tenantId)) {
    add('tenantId', 'NOT_UUID', 'tenantId must be a UUID; it is the workspace (ADR-017).');
  }
  if (!UUID.test(request.organizationId)) {
    add('organizationId', 'NOT_UUID', 'organizationId must be a UUID (ADR-017).');
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

function validateUsage(
  usage: Usage,
  add: (field: string, code: string, detail: string) => void,
): void {
  if (!isRecord(usage)) {
    add('usage', 'MISSING_FIELD', 'usage is required; an unmetered call is an unbilled one.');
    return;
  }

  const tokens: unknown = usage.tokens;
  if (!isRecord(tokens)) {
    add(
      'usage.tokens',
      'MISSING_FIELD',
      'Token counts are always populated, estimated if need be.',
    );
  } else {
    for (const field of ['promptTokens', 'completionTokens', 'totalTokens'] as const) {
      const value = tokens[field];
      if (!Number.isInteger(value) || (value as number) < 0) {
        add(`usage.tokens.${field}`, 'BAD_VALUE', `${field} must be an integer >= 0.`);
      }
    }
    // Two numbers that do not add up mean one of them is wrong, and metering
    // reads the total.
    const prompt = tokens['promptTokens'];
    const completion = tokens['completionTokens'];
    const total = tokens['totalTokens'];
    if (
      typeof prompt === 'number' &&
      typeof completion === 'number' &&
      typeof total === 'number' &&
      Number.isInteger(prompt) &&
      Number.isInteger(completion) &&
      Number.isInteger(total) &&
      prompt + completion !== total
    ) {
      add(
        'usage.tokens.totalTokens',
        'INCONSISTENT',
        `totalTokens (${String(total)}) must equal promptTokens + completionTokens (${String(prompt + completion)}).`,
      );
    }
  }

  if (typeof usage.tokensEstimated !== 'boolean') {
    add(
      'usage.tokensEstimated',
      'BAD_VALUE',
      'tokensEstimated must be stated; an unmarked estimate is silent under-metering.',
    );
  }

  const cost: unknown = usage.cost;
  if (!isRecord(cost)) {
    add('usage.cost', 'MISSING_FIELD', 'cost is required.');
  } else {
    if (typeof cost['currency'] !== 'string' || !CURRENCY.test(cost['currency'])) {
      add('usage.cost.currency', 'BAD_FORMAT', 'currency must be an ISO 4217 code, e.g. USD.');
    }
    if (typeof cost['amount'] !== 'string' || !DECIMAL.test(cost['amount'])) {
      add(
        'usage.cost.amount',
        'BAD_FORMAT',
        'amount must be a non-negative decimal string with at most six places — never a float, which loses money at the sixth decimal.',
      );
    }
  }

  if (
    !Number.isInteger(usage.latencyMs) ||
    usage.latencyMs < 0 ||
    usage.latencyMs > MAX_LATENCY_MS
  ) {
    add('usage.latencyMs', 'BAD_VALUE', 'latencyMs must be an integer between 0 and 24h.');
  }
}

export function validateAIResponse(response: AIResponse): AIValidationResult {
  const issues: AIValidationIssue[] = [];
  const add = (field: string, code: string, detail: string): void => {
    issues.push({ field, code, detail });
  };

  for (const field of AI_RESPONSE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(response, field)) {
      add(field, 'MISSING_FIELD', `'${field}' is required on every AIResponse.`);
    }
  }

  if (typeof response.idempotencyKey !== 'string' || response.idempotencyKey.trim() === '') {
    add('idempotencyKey', 'EMPTY', 'A response must echo the key of the request it answers.');
  }
  if (typeof response.providerId !== 'string' || response.providerId.trim() === '') {
    add('providerId', 'EMPTY', 'providerId is required for metering and diagnostics.');
  }
  if (typeof response.model !== 'string' || response.model.trim() === '') {
    add('model', 'EMPTY', 'A response must name the model that actually ran.');
  }
  if (typeof response.content !== 'string') {
    add('content', 'BAD_VALUE', 'content must be a normalized plain string.');
  }
  if (!isFinishReason(response.finishReason)) {
    add(
      'finishReason',
      'BAD_VALUE',
      `'${String(response.finishReason)}' is outside the fixed set; every vendor reason maps to one of stop, length, content_filter, tool_call.`,
    );
  }

  validateUsage(response.usage, add);

  if (!isRecord(response.providerMetadata)) {
    add(
      'providerMetadata',
      'NOT_OBJECT',
      'providerMetadata must be an object, empty if the vendor said nothing.',
    );
  }

  return issues.length === 0 ? { ok: true } : { ok: false, issues };
}

/**
 * The check that must run before a provider is contacted.
 *
 * A capability the provider never declared cannot succeed, and finding that out
 * from a vendor's error costs a round trip and sometimes a charge.
 */
export function assertCapabilityDeclared(
  providerId: string,
  declared: readonly string[],
  requested: string,
): void {
  if (!declared.includes(requested)) {
    throw new Error(
      `Provider '${providerId}' does not declare '${requested}'; it declares ${declared.join(', ') || '(nothing)'}.`,
    );
  }
}
