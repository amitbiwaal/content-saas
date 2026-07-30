/**
 * Execution PREPARATION.
 *
 * Builds the canonical execution request from a compiled prompt, an
 * `AIRequest` and a provider capability — and stops there. Nothing in this
 * file calls a provider, and nothing in it may: dispatch belongs to the AI
 * Gateway (`ai-gateway.md`), which is not in this increment.
 *
 * ── No duplicate request model ──────────────────────────────────────────────
 * What a provider is eventually handed is the SAME `AIRequest` the provider
 * abstraction already froze. `PromptExecutionRequest` does not replace it; it
 * carries it, alongside the provenance that makes the call reproducible. A
 * second request shape would mean two places to add a field and one of them
 * getting forgotten.
 *
 * ── Model hints are carried, not applied ────────────────────────────────────
 * The template's hints are an INPUT to routing, never a command
 * (`model-router.md`). `AIRequest.params` is required and the caller has
 * already stated it, so silently overwriting it here would mean a template
 * edit changing a caller's sampling without the caller knowing. The hints ride
 * along for the Router to weigh when the Router exists.
 */

import { validateAIRequest, type AIValidationIssue } from '../providers/validation.js';
import type { AICapability, AIRequest, AIResponse } from '@contentos/contracts';

import type { CompiledPrompt } from './compile.js';
import { PromptError, type PromptModelHints } from './template.js';

/**
 * A request that is ready to execute, and has not been executed.
 *
 * Everything needed to dispatch, plus everything needed to explain the
 * dispatch afterwards.
 */
export interface PromptExecutionRequest {
  /** The canonical request. This, verbatim, is what a provider receives. */
  readonly request: AIRequest;
  /** `'planning.outline@7'` — resolves to the exact template, permanently. */
  readonly promptVersion: string;
  readonly templateId: string;
  readonly templateVersion: number;
  /** Checked against the request; the provider must declare it. */
  readonly capability: AICapability;
  /** The template's hints, for the Router. Not applied to `request.params`. */
  readonly hints: PromptModelHints;
  readonly promptChars: number;
}

/**
 * A request and the response that answered it.
 *
 * Produced by pairing, never by executing: this increment has nothing that
 * calls a provider, and the pairing is what a later increment will do with
 * whatever comes back.
 */
export interface PromptExecutionResult {
  readonly request: PromptExecutionRequest;
  readonly response: AIResponse;
}

function detail(issues: readonly AIValidationIssue[]): string {
  return issues.map((i) => `${i.field}: ${i.detail}`).join('; ');
}

export interface PrepareExecutionOptions {
  readonly compiled: CompiledPrompt;
  /**
   * The caller's request: identity, tenancy, model, deadline and sampling.
   * Its `messages` are REPLACED by the compiled prompt — a caller-supplied
   * message list would be a prompt that exists outside the registry.
   */
  readonly request: AIRequest;
  readonly capability: AICapability;
}

/**
 * Build the canonical execution request. Does NOT execute.
 *
 * Validation runs here rather than at dispatch, for the reason the spec gives
 * about rendering: a failure before a provider is contacted costs nothing,
 * and the same failure after it costs a customer money and returns
 * plausible-looking garbage.
 */
export function prepareExecution(options: PrepareExecutionOptions): PromptExecutionRequest {
  const { compiled, request, capability } = options;

  // Two statements of the same fact that disagree. Which one is true decides
  // whether the right provider is chosen, so neither may be assumed.
  if (request.capability !== capability) {
    throw new PromptError(
      'CapabilityMismatch',
      `The request asks for '${request.capability}' and execution was prepared for '${capability}'. A provider would be selected for one and asked for the other.`,
    );
  }

  if (compiled.messages.length === 0) {
    throw new PromptError(
      'MalformedExecutionRequest',
      `${compiled.promptVersion} compiled to no messages; there is nothing to send.`,
    );
  }

  // The compiled prompt is the only source of messages.
  const prepared: AIRequest = { ...request, messages: compiled.messages, capability };

  const result = validateAIRequest(prepared);
  if (!result.ok) {
    throw new PromptError(
      'MalformedExecutionRequest',
      `${compiled.promptVersion} did not produce a valid AIRequest — ${detail(result.issues)}.`,
    );
  }

  return Object.freeze<PromptExecutionRequest>({
    request: Object.freeze(prepared),
    promptVersion: compiled.promptVersion,
    templateId: compiled.templateId,
    templateVersion: compiled.templateVersion,
    capability,
    hints: compiled.hints,
    promptChars: compiled.promptChars,
  });
}

/**
 * Pair a prepared request with the response that answered it.
 *
 * The keys must match. A response carrying a different `idempotencyKey`
 * answered a different call, and recording it here would attribute one
 * request's cost and output to another.
 */
export function completeExecution(
  request: PromptExecutionRequest,
  response: AIResponse,
): PromptExecutionResult {
  if (response.idempotencyKey !== request.request.idempotencyKey) {
    throw new PromptError(
      'MalformedExecutionRequest',
      `The response answers '${response.idempotencyKey}' but the request is '${request.request.idempotencyKey}'; pairing them would attribute one call's cost and output to another.`,
    );
  }
  return Object.freeze<PromptExecutionResult>({ request, response });
}
