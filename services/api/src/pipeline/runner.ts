/**
 * The pipeline runner.
 *
 * Executes the stages in `PIPELINE_ORDER` and STOPS at the first rejection —
 * so a request rejected for size is never authenticated, and a request rejected
 * for authentication is never validated. Short-circuiting is what makes the
 * ordering a control rather than a description.
 *
 * The runner records which stages actually ran, which is what lets the ordering
 * be asserted by test rather than by reading the source.
 */

import { assertPipelineOrder, type StageName } from './order.js';
import { proceed, type PipelineRequest, type StageOutcome } from './stages.js';

export interface RequestIdentity {
  readonly subjectId: string;
  readonly cookieAuthenticated: boolean;
}

export interface ResolvedResource {
  readonly kind: string;
  readonly id: string;
  readonly tenantId: string;
  readonly organizationId: string;
  readonly ownerId: string | null;
}

/**
 * What each stage may do. Every hook is optional: a route with no body needs no
 * validation stage, and omitting one does not reorder the rest.
 */
export interface PipelineHooks {
  readonly requestId: (req: PipelineRequest) => string;
  readonly logging?: (req: PipelineRequest, correlationId: string) => void;
  readonly metrics?: (req: PipelineRequest) => void;
  readonly sizeLimit: (req: PipelineRequest) => StageOutcome;
  readonly rateLimitPreAuth: (req: PipelineRequest) => Promise<StageOutcome>;
  readonly authenticate: (
    req: PipelineRequest,
  ) => Promise<{ outcome: StageOutcome; identity?: RequestIdentity }>;
  readonly rateLimitPostAuth: (identity: RequestIdentity) => Promise<StageOutcome>;
  readonly csrf: (req: PipelineRequest, identity: RequestIdentity) => StageOutcome;
  readonly validate?: (req: PipelineRequest) => StageOutcome;
  readonly idempotency?: (req: PipelineRequest) => Promise<StageOutcome>;
  readonly resolveTenant: (
    req: PipelineRequest,
    identity: RequestIdentity,
  ) => Promise<{ outcome: StageOutcome; resource?: ResolvedResource }>;
  readonly authorize: (
    identity: RequestIdentity,
    resource: ResolvedResource,
  ) => Promise<StageOutcome>;
  readonly handler: (identity: RequestIdentity, resource: ResolvedResource) => Promise<unknown>;
  readonly outputFilter?: (payload: unknown) => unknown;
}

export interface PipelineResult {
  readonly ok: boolean;
  readonly correlationId: string;
  readonly executed: readonly StageName[];
  readonly rejectedAt?: StageName;
  readonly outcome?: StageOutcome;
  readonly payload?: unknown;
  readonly headers: Readonly<Record<string, string>>;
}

export async function runPipeline(
  req: PipelineRequest,
  hooks: PipelineHooks,
  securityHeaders: Readonly<Record<string, string>>,
): Promise<PipelineResult> {
  // Fails the process at boot if the order was edited into an unsafe shape.
  assertPipelineOrder();

  const executed: StageName[] = [];
  const record = (stage: StageName): void => {
    executed.push(stage);
  };

  const correlationId = hooks.requestId(req);
  record('request-id');

  hooks.logging?.(req, correlationId);
  record('logging');

  hooks.metrics?.(req);
  record('metrics');

  const stop = (stage: StageName, outcome: StageOutcome): PipelineResult => ({
    ok: false,
    correlationId,
    executed,
    rejectedAt: stage,
    outcome,
    headers: { ...securityHeaders, ...(outcome.headers ?? {}) },
  });

  const size = hooks.sizeLimit(req);
  record('size-limit');
  if (!size.ok) return stop('size-limit', size);

  const preAuth = await hooks.rateLimitPreAuth(req);
  record('rate-limit-pre-auth');
  if (!preAuth.ok) return stop('rate-limit-pre-auth', preAuth);

  const auth = await hooks.authenticate(req);
  record('authentication');
  if (!auth.outcome.ok || auth.identity === undefined) {
    return stop('authentication', auth.outcome);
  }
  const identity = auth.identity;

  const postAuth = await hooks.rateLimitPostAuth(identity);
  record('rate-limit-post-auth');
  if (!postAuth.ok) return stop('rate-limit-post-auth', postAuth);

  const csrf = hooks.csrf(req, identity);
  record('csrf');
  if (!csrf.ok) return stop('csrf', csrf);

  const validation = hooks.validate?.(req) ?? proceed('validation');
  record('validation');
  if (!validation.ok) return stop('validation', validation);

  const idempotency = (await hooks.idempotency?.(req)) ?? proceed('idempotency');
  record('idempotency');
  if (!idempotency.ok) return stop('idempotency', idempotency);

  const tenant = await hooks.resolveTenant(req, identity);
  record('tenant-resolution');
  if (!tenant.outcome.ok || tenant.resource === undefined) {
    return stop('tenant-resolution', tenant.outcome);
  }
  const resource = tenant.resource;

  const authz = await hooks.authorize(identity, resource);
  record('authorization');
  if (!authz.ok) return stop('authorization', authz);

  const raw = await hooks.handler(identity, resource);
  record('handler');

  const payload = hooks.outputFilter?.(raw) ?? raw;
  record('output-filter');
  record('security-headers');

  return { ok: true, correlationId, executed, payload, headers: { ...securityHeaders } };
}
