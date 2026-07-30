/**
 * The admission pipeline.
 *
 * Spec: `08-ai-platform/ai-gateway.md` §Inputs — "Validation at admission, in
 * order… A failure at any step returns a typed error BEFORE any provider is
 * contacted, so a malformed request never costs a customer anything."
 *
 * ── It orchestrates; it owns nothing ────────────────────────────────────────
 * Every decision here is delegated. Whether a workspace admits work is the
 * directory's answer; whether a provider exists is the registry's; whether a
 * template resolves is the catalogue's; whether the resulting request is valid
 * is the provider abstraction's own validator. The pipeline's job is the
 * SEQUENCE and the refusal — nothing more, which is what keeps a component
 * touched by every request from accumulating logic.
 *
 * ── The order is not arbitrary ──────────────────────────────────────────────
 * Cheap and local checks run before expensive and remote ones, and tenancy
 * runs before anything that reads tenant-scoped data. A malformed request is
 * refused before a database is touched; an unknown workspace before a template
 * is rendered; everything before a provider is contacted — which never happens
 * here at all.
 *
 * ── It never executes ───────────────────────────────────────────────────────
 * The last stage prepares a workflow and stops at the point where a dispatcher
 * would send. `execute` is not called, imported, or reachable from this file.
 */

import { validateAIRequest } from '../providers/validation.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { PromptCatalogue } from '../prompts/resolver.js';
import { isPromptError } from '../prompts/template.js';
import {
  awaitExecution,
  buildRequest,
  createWorkflowExecution,
  loadStep,
  pendingRequest,
  preparePrompt,
  start as startWorkflow,
} from '../workflow/engine.js';
import type { WorkflowDefinition } from '../workflow/definition.js';
import {
  ADMISSION_STAGES,
  MAX_VARIABLES_BYTES,
  type AdmissionResult,
  type AdmissionStage,
  type GatewayContext,
  type GatewayDecision,
  type GatewayRequest,
  type GatewayResponse,
  type RejectionCode,
} from './contracts.js';
import {
  ADMITTING_ORGANIZATION_STATUS,
  ADMITTING_WORKSPACE_STATUS,
  type AdmissionDirectory,
  type AdmissionFlags,
} from './ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DOT_CASE = /^[a-z][a-z0-9]*(\.[a-z0-9]+)+$/;

export interface GatewayOptions {
  readonly directory: AdmissionDirectory;
  readonly flags: AdmissionFlags;
  readonly providers: ProviderRegistry;
  readonly prompts: PromptCatalogue;
  /**
   * The workflow id for a request.
   *
   * Injected rather than generated: generation is not pure, and this id is
   * half of every idempotency key the run produces. Defaults to the request's
   * own key, which makes two admissions of one request produce one workflow.
   */
  readonly workflowIdFor?: (request: GatewayRequest) => string;
}

export interface Gateway {
  admit(request: GatewayRequest): Promise<GatewayResponse>;
}

const reject = (code: RejectionCode, stage: AdmissionStage, reason: string): GatewayResponse =>
  Object.freeze({
    admitted: false as const,
    decision: Object.freeze({ outcome: 'reject' as const, code, stage, reason }),
  });

/** Byte length of the variables as they would be sent. */
function variablesBytes(variables: Readonly<Record<string, unknown>>): number {
  try {
    return Buffer.byteLength(JSON.stringify(variables), 'utf8');
  } catch {
    // A cyclic or unserializable payload cannot cross a wire either.
    return Number.POSITIVE_INFINITY;
  }
}

/** Stage 1 — everything checkable without asking anything else. */
function validateShape(request: GatewayRequest): GatewayResponse | null {
  const issues: string[] = [];
  const raw = request as unknown as Record<string, unknown>;

  if (typeof raw['taskType'] !== 'string' || !DOT_CASE.test(raw['taskType'])) {
    issues.push("taskType must be dot.case, e.g. 'planning.outline'");
  }
  if (typeof raw['capability'] !== 'string' || raw['capability'] === '') {
    issues.push('capability is required');
  }
  const providerId = raw['providerId'];
  if (typeof providerId !== 'string' || providerId.trim() === '') {
    issues.push('providerId is required');
  }
  const model = raw['model'];
  if (typeof model !== 'string' || model.trim() === '') {
    issues.push('model is required');
  }
  const templateRef = raw['templateRef'];
  if (
    typeof templateRef !== 'object' ||
    templateRef === null ||
    typeof (templateRef as { id?: unknown }).id !== 'string'
  ) {
    issues.push('templateRef must name a template');
  }
  if (typeof raw['variables'] !== 'object' || raw['variables'] === null) {
    issues.push('variables must be an object, empty if the template takes none');
  }
  for (const field of ['organizationId', 'workspaceId', 'correlationId'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || !UUID.test(value)) {
      issues.push(`${field} must be a UUID`);
    }
  }
  // Present-but-null, never absent: the optional-versus-null ambiguity is what
  // makes an unauthenticated request look like a platform-initiated one.
  if (raw['actorId'] !== null && typeof raw['actorId'] !== 'string') {
    issues.push('actorId must be a string or null, never absent');
  }
  const idempotencyKey = raw['idempotencyKey'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.trim() === '') {
    issues.push('idempotencyKey is required, so a retry cannot become a second charge');
  }

  if (issues.length > 0) {
    return reject('MalformedRequest', 'validate', issues.join('; '));
  }

  const bytes = variablesBytes(request.variables);
  if (bytes > MAX_VARIABLES_BYTES) {
    return reject(
      'RequestTooLarge',
      'validate',
      `The variables are ${bytes === Number.POSITIVE_INFINITY ? 'not serializable' : `${String(bytes)} bytes`}, over the ${String(MAX_VARIABLES_BYTES)}-byte bound.`,
    );
  }

  return null;
}

/**
 * Build the Gateway.
 *
 * Deterministic: the same request against the same directory, registry and
 * catalogue produces the same decision, because nothing here reads a clock or a
 * random source and the workflow id is derived rather than generated.
 */
export function createGateway(options: GatewayOptions): Gateway {
  const workflowIdFor = options.workflowIdFor ?? ((request) => request.idempotencyKey);

  return {
    async admit(request: GatewayRequest): Promise<GatewayResponse> {
      // 1 · Validate — before a database is touched.
      const malformed = validateShape(request);
      if (malformed !== null) return malformed;

      // 2 · Resolve organization.
      const organization = await options.directory.organization(request.organizationId);
      if (organization === null) {
        return reject(
          'UnknownOrganization',
          'resolve-organization',
          `No organization '${request.organizationId}'.`,
        );
      }
      if (organization.status !== ADMITTING_ORGANIZATION_STATUS) {
        // `past_due` lands here too, deliberately: AI spend is the dominant
        // variable cost, and serving an unpaid account is a write-off rather
        // than an error.
        return reject(
          'OrganizationNotAdmitting',
          'resolve-organization',
          `Organization '${request.organizationId}' is '${organization.status}' and does not admit new AI work.`,
        );
      }

      // 3 · Resolve tenant. The workspace IS the tenant (ADR-017), so this is
      // where the context a handler would receive is established.
      const tenant: GatewayContext['tenant'] = {
        tenantId: request.workspaceId,
        organizationId: request.organizationId,
        source: 'request',
      };

      // 4 · Resolve workspace.
      const workspace = await options.directory.workspace(request.workspaceId);
      if (workspace === null) {
        return reject(
          'UnknownWorkspace',
          'resolve-workspace',
          `No workspace '${request.workspaceId}'.`,
        );
      }
      // A workspace belonging to another organization is the request naming a
      // tenancy it does not own — the one check that stops an id swap reading
      // another customer's settings and spending their budget.
      if (workspace.organizationId !== request.organizationId) {
        return reject(
          'TenantMismatch',
          'resolve-workspace',
          `Workspace '${request.workspaceId}' belongs to another organization.`,
        );
      }
      if (workspace.status !== ADMITTING_WORKSPACE_STATUS) {
        return reject(
          'WorkspaceNotAdmitting',
          'resolve-workspace',
          `Workspace '${request.workspaceId}' is '${workspace.status}' and does not admit new AI work.`,
        );
      }

      // 5 · Validate capability — is anything registered that can do this?
      if (options.providers.providersWith(request.capability).length === 0) {
        return reject(
          'CapabilityUnavailable',
          'validate-capability',
          `No registered provider declares '${request.capability}'.`,
        );
      }

      // 6 · Validate provider — and that THIS one declares the capability.
      if (!options.providers.has(request.providerId)) {
        return reject(
          'UnknownProvider',
          'validate-provider',
          `No provider '${request.providerId}' is registered.`,
        );
      }
      const provider = options.providers.get(request.providerId);
      if (!provider.capabilities.includes(request.capability)) {
        return reject(
          'CapabilityUnavailable',
          'validate-provider',
          `Provider '${request.providerId}' does not declare '${request.capability}'; it declares ${provider.capabilities.join(', ')}.`,
        );
      }

      // 7 · Validate prompt — resolvable BEFORE anything is authorized or
      // rendered, because an unknown template is a caller defect and the
      // cheapest possible thing to find out.
      if (!options.prompts.has(request.templateRef)) {
        return reject(
          'UnknownPrompt',
          'validate-prompt',
          `No prompt template '${request.templateRef.id}'${request.templateRef.version === undefined ? ' with an active version' : ` at version ${String(request.templateRef.version)}`}.`,
        );
      }

      // 8 · Authorize.
      if (request.actorId !== null) {
        const membership = await options.directory.membership(request.workspaceId, request.actorId);
        if (membership === null || membership.status !== 'active') {
          return reject(
            'MembershipRequired',
            'authorize',
            `Actor '${request.actorId}' has no active membership of workspace '${request.workspaceId}'.`,
          );
        }
      }
      if (request.featureFlag !== undefined) {
        const enabled = await options.flags.isEnabled(
          { organizationId: request.organizationId, workspaceId: request.workspaceId },
          request.featureFlag,
        );
        if (!enabled) {
          return reject(
            'FeatureDisabled',
            'authorize',
            `Feature '${request.featureFlag}' is not enabled for this workspace.`,
          );
        }
      }

      // 9 · Prepare workflow — the existing runtime, driven to the point where
      // a dispatcher would send. Nothing here dispatches.
      const definition: WorkflowDefinition = {
        id: request.taskType,
        version: 1,
        description: `Gateway admission for ${request.taskType}.`,
        steps: [
          {
            id: 'execute',
            templateRef: request.templateRef,
            capability: request.capability,
            model: request.model,
            timeoutMs: request.timeoutMs ?? 60_000,
            ...(request.params === undefined ? {} : { params: request.params }),
          },
        ],
      };

      const workflowId = workflowIdFor(request);

      try {
        const execution = awaitExecution(
          buildRequest(
            preparePrompt(
              loadStep(
                startWorkflow(
                  createWorkflowExecution({
                    workflowId,
                    definition,
                    context: {
                      tenant,
                      // Admission has no job yet; the id it would carry is the
                      // workflow's, and inventing one would be a job nothing
                      // created.
                      jobId: workflowId,
                      correlationId: request.correlationId,
                      metadata: { taskType: request.taskType },
                    },
                    variables: request.variables,
                  }),
                ),
              ),
              options.prompts,
            ),
          ),
        );

        const prepared = pendingRequest(execution);
        if (prepared === null) {
          return reject(
            'PreparationFailed',
            'prepare-workflow',
            'The workflow prepared no request; there is nothing to admit.',
          );
        }

        // The provider abstraction's own validator has the final word. A
        // request that would be refused at dispatch is refused here instead,
        // where it costs nothing.
        const valid = validateAIRequest(prepared);
        if (!valid.ok) {
          return reject(
            'PreparationFailed',
            'prepare-workflow',
            valid.issues.map((issue) => `${issue.field}: ${issue.detail}`).join('; '),
          );
        }

        const step = execution.state.prepared;
        const context: GatewayContext = Object.freeze({
          tenant,
          organizationId: request.organizationId,
          workspaceId: request.workspaceId,
          actorId: request.actorId,
          correlationId: request.correlationId,
          idempotencyKey: request.idempotencyKey,
        });

        const result: AdmissionResult = Object.freeze({
          context,
          request: prepared,
          promptVersion: step?.promptVersion ?? '',
          providerId: request.providerId,
          capability: request.capability,
          workflowId,
        });

        // 10 · Return admission.
        return Object.freeze({
          admitted: true as const,
          decision: Object.freeze({ outcome: 'admit' as const }) satisfies GatewayDecision,
          result,
        });
      } catch (error: unknown) {
        // A prompt that resolves but cannot RENDER — a missing variable, a
        // value over its bound — is a caller defect, and the pipeline's own
        // refusal is more useful than an exception escaping the Gateway.
        if (isPromptError(error)) {
          return reject('PreparationFailed', 'prepare-workflow', error.message);
        }
        throw error;
      }
    },
  };
}

/** The stages, in the order they run. Exported so the order is assertable. */
export const PIPELINE_ORDER: readonly AdmissionStage[] = ADMISSION_STAGES;
