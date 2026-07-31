/**
 * The map between a live run and its stored record, in both directions.
 *
 * ── Pure, both ways ────────────────────────────────────────────────────────
 * No clock, no repository, no I/O. `now` is supplied, because the record's
 * timestamps are a fact about the write and a test must be able to fix them.
 * Everything here is a function from one value to another, which is what makes
 * the round trip something a test can assert exactly rather than approximately.
 *
 * ── Nothing is dropped on the way down ─────────────────────────────────────
 * Template versions, provider identity, model identity, token usage, cost and
 * every timing survive the trip. What a run cost and which prompt produced it
 * are the two questions a stored artifact exists to answer three weeks later,
 * and an artifact that lost either is a row nobody can act on.
 *
 * ── The principal does NOT survive it, deliberately ────────────────────────
 * A `Principal` carries roles and permissions resolved from live bindings for
 * ONE request. Storing them would create a stale copy of the authorization
 * state, and reading it back would look exactly like an authorization.
 *
 * So the trip down keeps identity — who ran it, and how they proved it — and
 * the trip back up rebuilds a principal that holds NO roles and NO permissions,
 * with `mfaSatisfied: false`. A loaded run says who ran it. It never says what
 * they may do now; answering that means authenticating again.
 */

import type { Usage } from '@contentos/contracts';
import type { Principal } from '@contentos/security';

import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import { deepFreeze, type ContentArtifact, type ContentRun, type ContentRunResult } from './run.js';
import type { SaveRunInput } from './repository.js';
import {
  CONTENT_RUN_SCHEMA_VERSION,
  parsePromptVersion,
  type StoredArtifact,
  type StoredContentRun,
  type StoredFailure,
  type StoredPromptReference,
  type StoredUsage,
} from './stored.js';

export interface ToStoredOptions {
  readonly run: ContentRun;
  /** The record's own timestamp. Supplied; nothing here reads a clock. */
  readonly now: string;
  /** Why it did not complete. Null on a run that did. */
  readonly failure?: StoredFailure | null;
}

/** A prompt anchor as its stored parts. Unparseable anchors are kept whole. */
function promptReferenceOf(promptVersion: string): StoredPromptReference {
  return (
    parsePromptVersion(promptVersion) ?? {
      // Refusing here would lose an artifact over a malformed label; the
      // validator reports it, and the content is still recoverable.
      templateId: promptVersion,
      templateVersion: 0,
      promptVersion,
    }
  );
}

function storedUsageOf(usage: Usage): StoredUsage {
  return {
    promptTokens: usage.tokens.promptTokens,
    completionTokens: usage.tokens.completionTokens,
    totalTokens: usage.tokens.totalTokens,
    tokensEstimated: usage.tokensEstimated,
    currency: usage.cost.currency,
    amount: usage.cost.amount,
    latencyMs: usage.latencyMs,
  };
}

function usageOf(stored: StoredUsage): Usage {
  return {
    tokens: {
      promptTokens: stored.promptTokens,
      completionTokens: stored.completionTokens,
      totalTokens: stored.totalTokens,
    },
    tokensEstimated: stored.tokensEstimated,
    cost: { currency: stored.currency, amount: stored.amount },
    latencyMs: stored.latencyMs,
  };
}

/** The failure a result carries, in the shape a record stores. */
export function storedFailureOf(result: ContentRunResult): StoredFailure | null {
  return result.outcome === 'failed'
    ? Object.freeze({
        code: result.code,
        reason: result.reason,
        providerCode: result.providerCode,
      })
    : null;
}

export function toStoredRun(options: ToStoredOptions): StoredContentRun {
  const { run, now } = options;
  const { metadata } = run;

  return deepFreeze({
    schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    runId: run.runId,
    status: run.state.status,
    execution: {
      executionId: run.state.executionId,
      workflowId: run.workflowId,
      workflowVersion: run.workflowVersion,
      workflowRef: run.workflowRef,
      capability: run.capability,
      organizationId: metadata.organization.organizationId,
      organizationStatus: metadata.organization.status,
      workspaceId: metadata.workspace.workspaceId,
      workspaceStatus: metadata.workspace.status,
      // Identity only. See the file header for what is deliberately absent.
      principalId: metadata.principal.subjectId,
      principalKind: metadata.principal.kind,
      principalMethod: metadata.principal.method,
      correlationId: metadata.correlationId,
      idempotencyKey: metadata.idempotencyKey,
      timings: { ...run.state.timings },
    },
    templateVersions: run.templateVersions.map(promptReferenceOf),
    failure: options.failure ?? null,
    artifactCount: run.state.artifacts.length,
  });
}

export function toStoredArtifacts(options: ToStoredOptions): readonly StoredArtifact[] {
  const { run, now } = options;

  return deepFreeze(
    run.state.artifacts.map((artifact, index) => ({
      schemaVersion: CONTENT_RUN_SCHEMA_VERSION,
      createdAt: now,
      updatedAt: now,
      runId: run.runId,
      stepId: artifact.stepId,
      // Stored, so a store that returns rows unordered cannot silently reorder
      // a run's output.
      sequence: index,
      prompt: promptReferenceOf(artifact.promptVersion),
      providerId: artifact.providerId,
      model: artifact.model,
      capability: artifact.capability,
      content: artifact.content,
      finishReason: artifact.finishReason,
      usage: storedUsageOf(artifact.usage),
      attempts: artifact.attempts,
      metadata: { ...artifact.metadata },
    })),
  );
}

/** Both halves of one save, from one result. What the orchestrator stores. */
export function toStoredRecords(result: ContentRunResult, now: string): SaveRunInput {
  const failure = storedFailureOf(result);
  return Object.freeze({
    run: toStoredRun({ run: result.run, now, failure }),
    artifacts: toStoredArtifacts({ run: result.run, now }),
  });
}

// ── Back up ─────────────────────────────────────────────────────────────────

export interface ToContentRunOptions {
  readonly run: StoredContentRun;
  /** In `sequence` order. Reordered here if the store did not. */
  readonly artifacts: readonly StoredArtifact[];
}

function artifactOf(stored: StoredArtifact): ContentArtifact {
  return {
    stepId: stored.stepId,
    promptVersion: stored.prompt.promptVersion,
    providerId: stored.providerId,
    model: stored.model,
    capability: stored.capability,
    content: stored.content,
    finishReason: stored.finishReason,
    usage: usageOf(stored.usage),
    tokens: usageOf(stored.usage).tokens,
    attempts: stored.attempts,
    metadata: { ...stored.metadata },
  };
}

/**
 * A stored run, back as the immutable `ContentRun` the platform works in.
 *
 * The principal it carries is a RECORD OF WHO RAN IT — no roles, no
 * permissions, `mfaSatisfied: false`. Anything that treats a loaded run as an
 * authorization gets nothing, which is the correct answer.
 */
export function toContentRun(options: ToContentRunOptions): ContentRun {
  const { run } = options;
  const { execution } = run;

  const organization: AdmissionOrganization = {
    organizationId: execution.organizationId,
    status: execution.organizationStatus,
  };
  const workspace: AdmissionWorkspace = {
    workspaceId: execution.workspaceId,
    organizationId: execution.organizationId,
    status: execution.workspaceStatus,
  };

  const principal: Principal = {
    subjectId: execution.principalId,
    kind: execution.principalKind as Principal['kind'],
    method: execution.principalMethod as Principal['method'],
    organizationId: execution.organizationId,
    workspaceId: execution.workspaceId,
    // Fail closed. A rehydrated principal grants nothing.
    roles: [],
    permissions: [],
    authenticatedAt: new Date(execution.timings.createdAt),
    mfaSatisfied: false,
    sessionId: null,
  };

  const artifacts = [...options.artifacts]
    .sort((left, right) => left.sequence - right.sequence)
    .map(artifactOf);

  return deepFreeze({
    runId: run.runId,
    workflowId: execution.workflowId,
    workflowVersion: execution.workflowVersion,
    workflowRef: execution.workflowRef,
    templateVersions: run.templateVersions.map((reference) => reference.promptVersion),
    capability: execution.capability,
    metadata: {
      principal,
      organization,
      workspace,
      correlationId: execution.correlationId,
      idempotencyKey: execution.idempotencyKey,
    },
    state: {
      status: run.status,
      artifacts,
      executionId: execution.executionId,
      timings: { ...execution.timings },
    },
  });
}
