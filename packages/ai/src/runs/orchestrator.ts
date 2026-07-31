/**
 * The content run orchestrator.
 *
 *   resolve workflow → resolve templates → compile → create run
 *     → drive the frozen runtime → collect artifacts → return a result
 *
 * ── It coordinates. It implements none of it ───────────────────────────────
 * Every stage above belongs to something that already exists and is frozen:
 *
 *   resolution    `resolveWorkflow` (S4.2), and `resolveTemplate` (S4.1) via
 *                 the compiler, which is where template refs are pinned
 *   compilation   `toRuntimeDefinition` (S4.2), checked against the runtime's
 *                 own `validateWorkflowDefinition` (S2.4)
 *   execution     the S2.4 state machine — loadStep, preparePrompt,
 *                 buildRequest, awaitExecution, recordExecution
 *   provider      the Router (S3.5) chooses; an injected port dispatches
 *   retry         `decideRetry` (S2.6) decides; this waits and re-dispatches
 *   metering      `recordResponseUsage` (S2.5) prices
 *
 * What is new here is the SEQUENCE and the artifact, which is the whole of an
 * orchestrator's job. Anything else it did would be a second copy of something
 * that already has an owner.
 *
 * ── It never invokes a provider ────────────────────────────────────────────
 * There is no `providers.get(...).execute(...)` anywhere in this file and no
 * path to one. Dispatch goes through `RunExecutor.dispatch`, whose method is
 * deliberately NOT named `execute`, so that "nothing here calls `.execute(`" is
 * a claim a source scan can check and that means what it says.
 *
 * ── It never bypasses the runtime ──────────────────────────────────────────
 * Every request it dispatches came out of `buildRequest`, and every response
 * goes back through `recordExecution`. The runtime advances its own cursor and
 * decides when a run is done; this supplies the one thing a pure state machine
 * cannot — the call itself.
 *
 * ── No clock, no random source ─────────────────────────────────────────────
 * `now`, `newRunId` and `delay` are injected. A run's timings, its id and its
 * backoff are all things a test must be able to fix, and an orchestrator that
 * read a clock could not be asserted on.
 */

import {
  isProviderError,
  type AICapability,
  type AIRequest,
  type AIResponse,
} from '@contentos/contracts';

import type { WorkflowRegistry } from '../blueprints/registry.js';
import {
  RuntimeCompilationError,
  resolveWorkflow,
  toRuntimeDefinition,
} from '../blueprints/resolve.js';
import { createPromptCatalogue } from '../prompts/resolver.js';
import type { PromptTemplate } from '../prompts/template.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { beginRetryState, decideRetry, recordFailure, type RetryState } from '../retry/engine.js';
import type { RetryPolicy } from '../retry/policy.js';
import type { ExecutionPlan } from '../routing/plan.js';
import type { Router } from '../routing/router.js';
import type { TemplateLibrary } from '../templates/library.js';
import type { VersionSelector } from '../templates/resolve.js';
import type { PricingRegistry } from '../usage/pricing.js';
import { recordResponseUsage } from '../usage/recorder.js';
import { validateWorkflowDefinition, type WorkflowDefinition } from '../workflow/definition.js';
import { toStoredRecords } from './mapping.js';
import type { ContentRunRepository } from './repository.js';
import {
  awaitExecution,
  buildRequest,
  createWorkflowExecution,
  loadStep,
  preparePrompt,
  recordExecution,
  start as startWorkflow,
  type WorkflowExecution,
} from '../workflow/engine.js';
import {
  deepFreeze,
  withState,
  type ContentArtifact,
  type ContentRun,
  type ContentRunResult,
  type RunFailureCode,
  type RunMetadata,
} from './run.js';
import { assertTransitionAllowed, type RunTransition } from './state.js';

/**
 * The one thing a pure state machine cannot do.
 *
 * A port, supplied by a composition root. Its implementation is what talks to a
 * provider; this module never learns that one exists. Named `dispatch` rather
 * than `execute` so the structural claim in the header is checkable.
 */
export interface RunExecutor {
  dispatch(input: {
    /** Built by the runtime, verbatim. Nothing here edits it. */
    readonly request: AIRequest;
    /** Which provider and vendor model the Router chose for this step. */
    readonly plan: ExecutionPlan;
  }): Promise<AIResponse>;
}

/**
 * A caller's ability to stop a run in flight.
 *
 * A predicate rather than an `AbortSignal`, because the orchestrator only ever
 * asks between steps: it has no way to interrupt a dispatch already under way,
 * and a signal type would suggest that it did.
 */
export interface RunCancellation {
  cancelled(): boolean;
}

export interface OrchestratorOptions {
  readonly workflows: WorkflowRegistry;
  readonly templates: TemplateLibrary;
  readonly providers: ProviderRegistry;
  readonly router: Router;
  readonly executor: RunExecutor;
  readonly pricing: PricingRegistry;
  /** Injected. A run's timings must be a value a test can fix. */
  readonly now: () => Date;
  /** Injected. Generation is not pure, and a run id must be reproducible. */
  readonly newRunId: () => string;
  /**
   * Injected. The retry engine decides HOW LONG to wait; waiting is this
   * module's job, and a real timer would make every retry test slow.
   */
  readonly delay: (ms: number) => Promise<void>;
  readonly retryPolicy?: RetryPolicy;
  /**
   * Where a settled run is recorded, through the persistence PORT only.
   *
   * Optional, so a caller that wants a run and not a record — a preview, a
   * test — is not obliged to supply a store. When it is present, exactly one
   * `saveRun` happens per run, at the end, whatever the outcome.
   *
   * The orchestrator knows nothing about how it is stored. There is no driver,
   * no SQL and no schema decision anywhere in this package (S4.4).
   */
  readonly runs?: ContentRunRepository;
}

export interface StartRunOptions {
  readonly workflowId: string;
  readonly selector: VersionSelector;
  /** UNTRUSTED. Rendered into the slots the templates declare, and nowhere else. */
  readonly variables: Readonly<Record<string, unknown>>;
  readonly metadata: RunMetadata;
  /**
   * The model the caller asks for — an alias or a canonical name.
   *
   * A blueprint names none, so one has to arrive here. The Router resolves it
   * per step; this is the request, not the answer.
   */
  readonly model: string;
  /** Per step. The runtime puts it on each request. */
  readonly timeoutMs: number;
  /** The whole run's budget, where the caller sets one. */
  readonly runTimeoutMs?: number;
  /** The capability the caller needs. Checked against the workflow's. */
  readonly capability?: AICapability;
  /** The job this run is the execution of, where one drove it. */
  readonly jobId?: string;
  /** Every template the blueprint may reach, for the runtime's catalogue. */
  readonly promptTemplates: readonly PromptTemplate[];
  readonly signal?: RunCancellation;
}

export interface Orchestrator {
  start(options: StartRunOptions): Promise<ContentRunResult>;
}

interface Dispatched {
  readonly response: AIResponse;
  readonly attempts: number;
}

interface DispatchFailed {
  readonly failure: unknown;
  readonly attempts: number;
}

/** The compiler's codes, mapped onto the run taxonomy. Codes, never messages. */
function compilationFailureCode(error: RuntimeCompilationError): RunFailureCode {
  return error.code === 'UnresolvedTemplate' ? 'TemplateUnresolved' : 'CompilationFailed';
}

export function createOrchestrator(options: OrchestratorOptions): Orchestrator {
  const { workflows, templates, providers, router, executor, pricing, now, newRunId, delay } =
    options;

  /** A run at its earliest state. Every later one is derived from it. */
  function createRun(
    workflowId: string,
    workflowVersion: number,
    workflowRef: string,
    capability: AICapability,
    metadata: RunMetadata,
  ): ContentRun {
    return deepFreeze({
      runId: newRunId(),
      workflowId,
      workflowVersion,
      workflowRef,
      templateVersions: [],
      capability,
      metadata,
      state: {
        status: 'created' as const,
        artifacts: [],
        executionId: null,
        timings: {
          createdAt: now().toISOString(),
          compiledAt: null,
          startedAt: null,
          finishedAt: null,
        },
      },
    });
  }

  /**
   * End a run, by the transition that actually applies.
   *
   * A cancelled run is CANCELLED and a failed one is FAILED, and both produce
   * an `outcome: 'failed'` result — the status says how it ended, the outcome
   * says only that it did not complete.
   */
  function settle(
    run: ContentRun,
    transition: Extract<RunTransition, 'fail' | 'cancel'>,
    code: RunFailureCode,
    reason: string,
    providerCode: string | null = null,
  ): ContentRunResult {
    return Object.freeze({
      outcome: 'failed' as const,
      run: withState(run, {
        status: assertTransitionAllowed(run.state.status, transition),
        timings: { ...run.state.timings, finishedAt: now().toISOString() },
      }),
      code,
      reason,
      providerCode,
    });
  }

  /**
   * Dispatch one step, consulting the retry engine on failure.
   *
   * The engine decides whether and for how long; this waits and calls again.
   * That division is `retry-strategy.md`'s, and it is why the engine ships no
   * dispatcher of its own.
   */
  async function dispatchStep(
    request: AIRequest,
    plan: ExecutionPlan,
    remainingMs: number | null,
  ): Promise<Dispatched | DispatchFailed> {
    let retryState: RetryState = beginRetryState(request.idempotencyKey);
    let attempts = 0;

    for (;;) {
      attempts += 1;
      try {
        const response = await executor.dispatch({ request, plan });
        return { response, attempts };
      } catch (failure) {
        // A failure the taxonomy does not describe is not one the retry engine
        // can reason about, and guessing would retry a bug.
        if (!isProviderError(failure)) return { failure, attempts };

        retryState = recordFailure(retryState, failure);
        const decision = decideRetry(retryState, {
          ...(options.retryPolicy === undefined ? {} : { policy: options.retryPolicy }),
          // The run's remaining budget, so a retry cannot outlive the deadline
          // the caller set.
          ...(remainingMs === null ? {} : { remainingMs }),
        });
        if (decision.action === 'fail') return { failure, attempts };
        await delay(decision.delayMs);
      }
    }
  }

  /**
   * The pipeline.
   *
   * Produces a result and stops. Persistence is deliberately outside it, so
   * "the repository is invoked exactly once per run" is true by construction
   * rather than by every return path having to remember it.
   */
  async function execute(input: StartRunOptions): Promise<ContentRunResult> {
    const startedMs = now().getTime();
    const remaining = (): number | null =>
      input.runTimeoutMs === undefined
        ? null
        : Math.max(0, input.runTimeoutMs - (now().getTime() - startedMs));

    // ── 1 · Resolve the workflow ─────────────────────────────────────────
    const resolution = resolveWorkflow({
      registry: workflows,
      id: input.workflowId,
      selector: input.selector,
      ...(input.capability === undefined ? {} : { capability: input.capability }),
    });

    if (resolution.outcome === 'refused') {
      // No run exists yet, so one is created solely to carry the refusal: a
      // caller that asked for work deserves a record of why it did not
      // happen, and an incompatible capability is an outcome, not a throw.
      const stub = createRun(
        input.workflowId,
        0,
        input.workflowId,
        input.capability ?? 'text',
        input.metadata,
      );
      return settle(stub, 'fail', 'WorkflowUnresolved', resolution.reason);
    }

    const { resolved } = resolution;
    const { version } = resolved;

    let run = createRun(
      resolved.workflow.id,
      version.version,
      resolved.workflowVersion,
      version.capability.capability,
      input.metadata,
    );

    // A streamed run assembles its artifact from chunks, which needs the
    // streaming framework's assembler and an executor that streams. Refused
    // rather than quietly served as a buffered call: a caller that asked to
    // stream and got one response at the end has had its latency budget spent
    // without being told.
    if (version.capability.executionMode === 'streaming') {
      return settle(
        run,
        'fail',
        'StreamingUnsupported',
        `${resolved.workflowVersion} declares streaming; this orchestrator collects a complete artifact set and cannot yet assemble one from a stream.`,
      );
    }

    // ── 2 · Compile ──────────────────────────────────────────────────────
    // Templates are resolved HERE, inside the compiler, against the library —
    // a second resolution pass would be a second opinion that could disagree.
    run = withState(run, { status: assertTransitionAllowed(run.state.status, 'compile') });

    let definition: WorkflowDefinition;
    try {
      definition = toRuntimeDefinition({
        resolved,
        library: templates,
        timeoutMs: input.timeoutMs,
        model: input.model,
        providers,
      });
    } catch (failure) {
      if (failure instanceof RuntimeCompilationError) {
        return settle(run, 'fail', compilationFailureCode(failure), failure.message);
      }
      throw failure;
    }

    // The runtime's OWN validator, ahead of `createWorkflowExecution`, which
    // applies it too and throws. Asking first is what makes a definition this
    // orchestrator produced and the engine refuses a COMPILATION failure
    // rather than a runtime one — which is the distinction a caller acts on.
    const valid = validateWorkflowDefinition(definition);
    if (!valid.ok) {
      return settle(
        run,
        'fail',
        'CompilationFailed',
        `The compiled definition is not runnable: ${valid.issues
          .map((issue) => `${issue.field} ${issue.code}`)
          .join(', ')}.`,
      );
    }

    run = deepFreeze({
      ...run,
      // Pinned at compile time: a promotion mid-flight cannot change what
      // this run is doing.
      templateVersions: Object.freeze(
        definition.steps.map(
          (step) => `${step.templateRef.id}@${String(step.templateRef.version ?? 0)}`,
        ),
      ),
      state: {
        ...run.state,
        status: assertTransitionAllowed(run.state.status, 'ready'),
        // The runtime keys every step's idempotency key on this. Using the
        // request's key rather than the run id makes two orchestrations of
        // one request address the same work, which is the whole point of
        // having been given a key.
        executionId: input.metadata.idempotencyKey,
        timings: { ...run.state.timings, compiledAt: now().toISOString() },
      },
    });

    // ── 3 · Create the execution and drive it ────────────────────────────
    run = withState(run, {
      status: assertTransitionAllowed(run.state.status, 'start'),
      timings: { ...run.state.timings, startedAt: now().toISOString() },
    });

    const catalogue = createPromptCatalogue([...input.promptTemplates]);
    const artifacts: ContentArtifact[] = [];
    /** The run as it stands, carrying everything produced so far. */
    const sofar = (): ContentRun => withState(run, { artifacts: Object.freeze([...artifacts]) });

    let execution: WorkflowExecution;
    try {
      execution = startWorkflow(
        createWorkflowExecution({
          workflowId: input.metadata.idempotencyKey,
          definition,
          context: {
            tenant: {
              // ADR-017: the workspace IS the tenant.
              tenantId: input.metadata.workspace.workspaceId,
              organizationId: input.metadata.organization.organizationId,
              source: 'request',
            },
            jobId: input.jobId ?? run.runId,
            correlationId: input.metadata.correlationId,
            metadata: {},
          },
          variables: input.variables,
        }),
      );
    } catch (failure) {
      return settle(
        run,
        'fail',
        'RuntimeFailed',
        failure instanceof Error ? failure.message : String(failure),
      );
    }

    while (execution.state.status !== 'completed' && execution.state.status !== 'failed') {
      if (input.signal?.cancelled() === true) {
        // Between steps, which is the only place it can be honoured — and the
        // artifacts already produced travel with the cancellation.
        return settle(sofar(), 'cancel', 'Cancelled', 'The caller cancelled this run.');
      }

      const left = remaining();
      if (left !== null && left <= 0) {
        return settle(
          sofar(),
          'fail',
          'Timeout',
          `The run exceeded its ${String(input.runTimeoutMs)}ms budget after ${String(artifacts.length)} step(s).`,
        );
      }

      let stepId: string;
      try {
        execution = loadStep(execution);
        stepId = execution.state.stepId ?? '';
        execution = preparePrompt(execution, catalogue);
        execution = buildRequest(execution);
        execution = awaitExecution(execution);
      } catch (failure) {
        return settle(
          sofar(),
          'fail',
          'RuntimeFailed',
          failure instanceof Error ? failure.message : String(failure),
        );
      }

      const prepared = execution.state.prepared;
      if (prepared === null) {
        return settle(
          sofar(),
          'fail',
          'RuntimeFailed',
          'The runtime reached execution with no prepared request.',
        );
      }

      // ── The Router chooses. This file never does ──────────────────────
      const routed = await router.route({
        request: prepared.request,
        principal: input.metadata.principal,
        organization: input.metadata.organization,
        workspace: input.metadata.workspace,
        executionMode: 'buffered',
      });
      if (routed.outcome === 'refused') {
        return settle(sofar(), 'fail', 'ExecutionFailed', routed.reason);
      }

      const dispatched = await dispatchStep(prepared.request, routed.plan, remaining());
      if ('failure' in dispatched) {
        const { failure } = dispatched;
        return settle(
          sofar(),
          'fail',
          'ExecutionFailed',
          failure instanceof Error ? failure.message : String(failure),
          isProviderError(failure) ? failure.code : null,
        );
      }

      const { response } = dispatched;

      // Metered through the frozen recorder, which owns the arithmetic and
      // the decimal format the ledger requires.
      //
      // A metering failure does NOT fail the run: the call already happened
      // and was already paid for, and discarding the artifact would lose the
      // thing the customer bought over a bookkeeping fault. It is recorded on
      // the artifact instead, where it stays visible.
      let charge = '0.000000';
      let meteringError: string | null = null;
      try {
        const metered = recordResponseUsage(
          response,
          {
            tenantId: input.metadata.workspace.workspaceId,
            organizationId: input.metadata.organization.organizationId,
            correlationId: input.metadata.correlationId,
            attempt: dispatched.attempts,
            taskType: prepared.request.taskType,
            promptVersion: prepared.promptVersion,
            runId: run.runId,
            stepId,
          },
          pricing,
        );
        charge = metered.chargeableAmount;
      } catch (failure) {
        meteringError = failure instanceof Error ? failure.message : String(failure);
      }

      artifacts.push(
        deepFreeze({
          stepId,
          promptVersion: prepared.promptVersion,
          // What ACTUALLY ran, taken from the response — a plan may name one
          // thing and an adapter report another, and the artifact records
          // what happened.
          providerId: response.providerId,
          model: response.model,
          capability: prepared.capability,
          content: response.content,
          finishReason: response.finishReason,
          usage: response.usage,
          tokens: response.usage.tokens,
          attempts: dispatched.attempts,
          metadata: {
            plannedProviderId: routed.plan.providerId,
            plannedModel: routed.plan.model,
            canonicalModel: routed.plan.canonicalModel,
            routingPolicy: routed.plan.policy,
            policyVersion: routed.plan.policyVersion,
            chargeableAmount: charge,
            meteringError,
          },
        }),
      );

      try {
        execution = recordExecution(execution, response);
      } catch (failure) {
        return settle(
          sofar(),
          'fail',
          'RuntimeFailed',
          failure instanceof Error ? failure.message : String(failure),
        );
      }
    }

    // ── 4 · Collect ──────────────────────────────────────────────────────
    const finished = withState(run, {
      artifacts: Object.freeze([...artifacts]),
      timings: { ...run.state.timings, finishedAt: now().toISOString() },
    });

    if (execution.state.status === 'failed') {
      return Object.freeze({
        outcome: 'failed' as const,
        run: withState(finished, {
          status: assertTransitionAllowed(finished.state.status, 'fail'),
        }),
        code: 'RuntimeFailed' as const,
        reason: execution.state.failure ?? 'The workflow failed.',
        providerCode: null,
      });
    }

    return Object.freeze({
      outcome: 'completed' as const,
      run: withState(finished, {
        status: assertTransitionAllowed(finished.state.status, 'complete'),
      }),
    });
  }

  /**
   * Record a settled run, through the port and nowhere else.
   *
   * EVERY settled run, whatever its outcome. A failed run's artifacts were
   * produced and paid for, and a cancelled one's are the work already done;
   * storing only successes would make the runs an operator most needs to look
   * at the only ones with no record. `StoredContentRun.status` exists so a
   * stored run can say it failed.
   *
   * A save that throws does not lose the result — the artifacts are on it and
   * are usable — but it does change what the caller is told. Persistence is the
   * source of truth, so a run missing from it is a run nobody will find again,
   * and reporting success would promise a durable record that does not exist.
   */
  async function persist(result: ContentRunResult): Promise<ContentRunResult> {
    const repository = options.runs;
    if (repository === undefined) return result;

    try {
      await repository.saveRun(toStoredRecords(result, now().toISOString()));
      return result;
    } catch (failure) {
      const detail = failure instanceof Error ? failure.message : String(failure);
      // A run that had already failed keeps ITS code. The first cause is what
      // an operator acts on; the storage fault is appended, not substituted.
      return result.outcome === 'failed'
        ? Object.freeze({ ...result, reason: `${result.reason} It was also not stored: ${detail}` })
        : Object.freeze({
            outcome: 'failed' as const,
            run: result.run,
            code: 'PersistenceFailed' as const,
            reason: detail,
            providerCode: null,
          });
    }
  }

  return {
    start: (input: StartRunOptions): Promise<ContentRunResult> => execute(input).then(persist),
  };
}
