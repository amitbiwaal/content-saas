/**
 * The request pipeline — ordered ONCE, here.
 *
 * Spec: `16-security/api-security.md` §"The request pipeline".
 *
 *   "Ordering is a security property, not a style choice."
 *
 * A later endpoint inherits this pipeline rather than re-implementing any part
 * of it (`17-implementation/repository-structure.md`): `services/api` is the
 * only inbound network surface, so the controls are specified once and applied
 * uniformly.
 *
 * Three placements carry weight, and each is load-bearing:
 *
 *  - SIZE LIMITS PRECEDE EVERYTHING, because a 500 MB body must be rejected
 *    before it is buffered, parsed, or authenticated. A pipeline that
 *    authenticates first has already read the payload into memory, and
 *    unauthenticated attackers can exhaust it.
 *
 *  - RATE LIMITING APPEARS TWICE. Pre-auth by IP protects the authentication
 *    endpoints themselves — credential stuffing and enumeration happen without
 *    valid credentials. Post-auth by subject and tenant enforces fair use and
 *    catches a compromised account. Either alone leaves a gap.
 *
 *  - AUTHORIZATION IS LAST, immediately before the handler, because it needs
 *    the RESOLVED RESOURCE to determine the tenant. Placing it earlier would
 *    force it to trust a client-supplied tenant.
 *
 * Validation sits before authorization so malformed input never reaches
 * resource resolution, and after authentication so validation errors are not an
 * unauthenticated probe of the API's internal shape.
 */

/** The canonical stage order. The array IS the specification. */
export const PIPELINE_ORDER = [
  'request-id',
  'logging',
  'metrics',
  'size-limit',
  'rate-limit-pre-auth',
  'authentication',
  'rate-limit-post-auth',
  'csrf',
  'validation',
  'idempotency',
  'tenant-resolution',
  'authorization',
  'handler',
  'output-filter',
  'security-headers',
] as const;

export type StageName = (typeof PIPELINE_ORDER)[number];

/** Stages that must run before any request body is read into memory. */
export const PRE_BODY_STAGES: readonly StageName[] = [
  'request-id',
  'logging',
  'metrics',
  'size-limit',
];

/**
 * Invariants the order must satisfy, expressed as data so they are asserted
 * rather than assumed. Each carries the reason it exists.
 */
export const ORDER_INVARIANTS: readonly {
  readonly before: StageName;
  readonly after: StageName;
  readonly because: string;
}[] = [
  {
    before: 'size-limit',
    after: 'authentication',
    because: 'A 500 MB body must be rejected before it is buffered, parsed, or authenticated.',
  },
  {
    before: 'size-limit',
    after: 'rate-limit-pre-auth',
    because: 'Counting a request costs less than buffering one; reject oversize first.',
  },
  {
    before: 'rate-limit-pre-auth',
    after: 'authentication',
    because:
      'Credential stuffing and enumeration happen without valid credentials, so the auth endpoints need a pre-auth limit.',
  },
  {
    before: 'authentication',
    after: 'rate-limit-post-auth',
    because: 'A per-subject and per-tenant limit needs a subject.',
  },
  {
    before: 'authentication',
    after: 'validation',
    because:
      'Validation errors after authentication are not an unauthenticated probe of the API internal shape.',
  },
  {
    before: 'validation',
    after: 'tenant-resolution',
    because: 'Malformed input must never reach resource resolution.',
  },
  {
    before: 'tenant-resolution',
    after: 'authorization',
    because:
      'Authorization needs the resolved resource to determine the tenant; earlier would force it to trust a client-supplied tenant.',
  },
  {
    before: 'authorization',
    after: 'handler',
    because: 'Nothing reaches a handler unauthorized.',
  },
  {
    before: 'handler',
    after: 'output-filter',
    because: 'Responses are filtered on the way out.',
  },
];

export function stageIndex(stage: StageName): number {
  return PIPELINE_ORDER.indexOf(stage);
}

/**
 * Assert the order satisfies every invariant. Called at boot: a reordered
 * pipeline fails the process at startup rather than in production.
 */
export function assertPipelineOrder(order: readonly StageName[] = PIPELINE_ORDER): void {
  for (const invariant of ORDER_INVARIANTS) {
    const before = order.indexOf(invariant.before);
    const after = order.indexOf(invariant.after);
    if (before === -1 || after === -1) {
      throw new Error(
        `Pipeline is missing a required stage: ${invariant.before} or ${invariant.after}.`,
      );
    }
    if (before >= after) {
      throw new Error(
        `Pipeline order violation: '${invariant.before}' must precede '${invariant.after}'. ${invariant.because}`,
      );
    }
  }

  const seen = new Set<string>();
  for (const stage of order) {
    if (seen.has(stage)) {
      throw new Error(`Pipeline stage '${stage}' appears more than once.`);
    }
    seen.add(stage);
  }
}
