/**
 * Draft → run request.
 *
 *   draft → resolved workflow → resolved templates → ContentRunRequest
 *
 * ── It compiles. It does not execute ───────────────────────────────────────
 * The output is the value the FROZEN orchestrator's `start` takes, and nothing
 * here calls it. There is no provider, no runtime, no dispatch and no
 * `createOrchestrator` anywhere in this module: a caller receives a request and
 * decides for itself when to run it, which is what keeps execution in exactly
 * one place.
 *
 * ── The request IS `StartRunOptions` ───────────────────────────────────────
 * An alias, not a copy. A second request shape would be one more thing to keep
 * in step with the orchestrator, and the first time they drifted a draft would
 * compile into something that could not run.
 *
 * ── It resolves, and lets the orchestrator resolve again ───────────────────
 * The orchestrator resolves the workflow and compiles the runtime definition
 * itself. Doing that here too would be the duplicate orchestration this
 * increment forbids, so this resolves only to answer three questions a request
 * cannot carry: does the pinned workflow still exist, do its templates still
 * resolve to what the draft pinned, and are the inputs ones the prompt compiler
 * will accept.
 *
 * ── Values ARE checked here, by the frozen compiler ────────────────────────
 * `validateDraft` deliberately checks only presence, because a half-typed
 * number is normal mid-edit. Compilation is the last moment before money is
 * spent, so it runs the real `compilePrompt` over every prompt step. Names a
 * previous step binds are supplied as empty strings — which is exactly what the
 * runtime will have at that point for an optional slot — so the check tests the
 * caller's inputs and nothing else.
 *
 * ── Tenancy is checked, never inferred ─────────────────────────────────────
 * A draft belongs to a workspace. Compiling one on behalf of a caller in
 * another workspace is refused: the run would carry the caller's tenancy and
 * the draft's content, and the record of who ran what would be wrong.
 */

import type { Principal } from '@contentos/security';

import type { WorkflowRegistry } from '../blueprints/registry.js';
import type { AdmissionOrganization, AdmissionWorkspace } from '../gateway/ports.js';
import { compilePrompt } from '../prompts/compile.js';
import { isPromptError, type PromptTemplate } from '../prompts/template.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { StartRunOptions } from '../runs/orchestrator.js';
import type { StoredRecordIssue } from '../runs/stored.js';
import type { TemplateLibrary } from '../templates/library.js';
import { binds } from '../blueprints/steps.js';
import { draftStatus, latestRevision, type ContentDraft } from './draft.js';
import { validateDraft } from './validation.js';

/**
 * What a compiled draft becomes.
 *
 * The orchestrator's own input type. See the file header for why it is an
 * alias rather than a shape of its own.
 */
export type ContentRunRequest = StartRunOptions;

export const DRAFT_COMPILATION_CODES = [
  'DraftInvalid',
  'NotReady',
  'TenancyMismatch',
  'InputsInvalid',
] as const;

export type DraftCompilationCode = (typeof DRAFT_COMPILATION_CODES)[number];

export function isDraftCompilationCode(value: unknown): value is DraftCompilationCode {
  return (
    typeof value === 'string' && (DRAFT_COMPILATION_CODES as readonly string[]).includes(value)
  );
}

export type DraftCompilation =
  | {
      readonly outcome: 'compiled';
      readonly request: ContentRunRequest;
      /** The templates the run's catalogue will need, already resolved. */
      readonly templates: readonly PromptTemplate[];
    }
  | {
      readonly outcome: 'refused';
      readonly code: DraftCompilationCode;
      /** For operators. Never returned to a caller — see `ai/http.ts`. */
      readonly reason: string;
      readonly issues: readonly StoredRecordIssue[];
    };

export interface CompileDraftOptions {
  readonly draft: ContentDraft;
  readonly workflows: WorkflowRegistry;
  readonly templates: TemplateLibrary;
  readonly providers?: ProviderRegistry;
  /**
   * Who is submitting it, resolved for THIS request.
   *
   * Not read from the draft: a draft stores identity, never authority, and a
   * principal reconstructed from a record would grant nothing anyway.
   */
  readonly principal: Principal;
  readonly organization: AdmissionOrganization;
  readonly workspace: AdmissionWorkspace;
  readonly correlationId: string;
  /** Half of every step's key. Supplied, because generation is not pure. */
  readonly idempotencyKey: string;
  /** The model the caller asks for. A draft names none; the Router decides. */
  readonly model: string;
  readonly timeoutMs: number;
  readonly runTimeoutMs?: number;
  readonly jobId?: string;
}

const refuse = (
  code: DraftCompilationCode,
  reason: string,
  issues: readonly StoredRecordIssue[] = [],
): DraftCompilation => Object.freeze({ outcome: 'refused' as const, code, reason, issues });

export function compileDraft(options: CompileDraftOptions): DraftCompilation {
  const { draft, workspace } = options;

  // ── Tenancy, before anything else ────────────────────────────────────────
  if (draft.metadata.workspaceId !== workspace.workspaceId) {
    return refuse(
      'TenancyMismatch',
      `${draft.draftId} belongs to workspace '${draft.metadata.workspaceId}'; this request acts in '${workspace.workspaceId}'.`,
    );
  }
  if (draft.metadata.organizationId !== options.organization.organizationId) {
    return refuse(
      'TenancyMismatch',
      `${draft.draftId} belongs to organization '${draft.metadata.organizationId}'; this request acts in '${options.organization.organizationId}'.`,
    );
  }

  // ── Only a READY draft compiles ──────────────────────────────────────────
  const status = draftStatus(draft);
  if (status !== 'ready') {
    return refuse(
      'NotReady',
      `A '${status}' draft does not compile; only a validated one does. Move it to 'ready' first.`,
    );
  }

  // ── Re-validated now, against the registry as it stands ──────────────────
  // A draft became READY at a moment. A workflow retired or a template promoted
  // since would make that claim stale, and the run would be the thing that
  // discovered it.
  const validation = validateDraft({
    draft,
    workflows: options.workflows,
    templates: options.templates,
    ...(options.providers === undefined ? {} : { providers: options.providers }),
  });

  if (!validation.ok) {
    return refuse('DraftInvalid', 'The draft no longer validates.', validation.issues);
  }

  const { resolved } = validation;
  const { inputs } = latestRevision(draft);

  // ── The real prompt compiler, over every step ────────────────────────────
  const bound = new Set<string>();
  for (const step of resolved.version.steps) {
    const name = binds(step);
    if (name !== null) bound.add(name);
  }

  for (const template of validation.templates) {
    // ONLY what this template declares. The runtime hands each step the scope
    // it has at that point, and a name the template never declared is a
    // caller bug it refuses — so supplying every workflow variable to every
    // step would fail on a template that simply does not use one.
    const variables: Record<string, unknown> = {};
    for (const declaration of template.variables) {
      if (Object.prototype.hasOwnProperty.call(inputs, declaration.name)) {
        variables[declaration.name] = inputs[declaration.name];
      } else if (bound.has(declaration.name)) {
        // A previous step will fill this in. An empty string is exactly what
        // the runtime has for an unfilled slot, so the check tests the
        // caller's inputs and nothing else.
        variables[declaration.name] = '';
      }
    }

    try {
      compilePrompt({
        template,
        input: {
          templateRef: { id: template.id, version: template.version },
          variables,
          tenantId: workspace.workspaceId,
          correlationId: options.correlationId,
        },
      });
    } catch (failure) {
      if (!isPromptError(failure)) throw failure;
      return refuse('InputsInvalid', failure.message, [
        { field: 'inputs', code: failure.code, detail: failure.message },
      ]);
    }
  }

  // ── The request ──────────────────────────────────────────────────────────
  const request: ContentRunRequest = {
    workflowId: draft.workflowId,
    // Explicit, always. The draft pinned a version, and the run uses that one.
    selector: { kind: 'explicit', version: draft.workflowVersion },
    variables: { ...inputs },
    metadata: {
      principal: options.principal,
      organization: options.organization,
      workspace,
      correlationId: options.correlationId,
      idempotencyKey: options.idempotencyKey,
    },
    model: options.model,
    timeoutMs: options.timeoutMs,
    capability: draft.capability,
    promptTemplates: validation.templates,
    ...(options.runTimeoutMs === undefined ? {} : { runTimeoutMs: options.runTimeoutMs }),
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
  };

  return Object.freeze({
    outcome: 'compiled' as const,
    request: Object.freeze(request),
    templates: validation.templates,
  });
}
