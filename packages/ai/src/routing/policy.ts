/**
 * The routing table — deterministic policy, in precedence order.
 *
 *   explicit             the request named a provider
 *   workspace-default    this workspace's configured preference
 *   organization-default this organization's configured preference
 *   global-default       the platform's
 *   capability           nothing named one; any provider that can do the work
 *
 * Evaluated top to bottom, first match wins, and no two can match at the same
 * level. That is the whole of "deterministic routing": there is no weighting,
 * no sampling and no tie to break, so the same inputs cannot produce two
 * answers on two instances or on two days.
 *
 * ── Versioned, because a decision must be reproducible ──────────────────────
 * `model-router.md` rule 3: "Routing policy is versioned data, not code", and
 * rule 4: "Every decision records `policyVersion`, making any historical call
 * reproducible." The version is required at construction for that reason — a
 * table without one produces decisions nobody can explain after it changes.
 *
 * ── DIVERGENCE from `model-router.md` rule 6, flagged not buried ────────────
 * That document is explicit: "Tenant overrides express tier preference only; a
 * workspace cannot pin a provider or a vendor model", and gives the reason
 * under §Security — "a tenant cannot influence which vendor sees their data — a
 * genuine data-residency and confidentiality concern."
 *
 * This increment specifies workspace and organization defaults that name a
 * PROVIDER, so that is what is implemented. The divergence is real and is
 * recorded here, in the deliverable, and in a conformance assertion. The shape
 * that would satisfy both is a tier indirection — `ProviderPreference` becoming
 * a tier name that the table maps to providers — which is a change to this file
 * and nothing else.
 */

export interface ProviderPreference {
  readonly providerId: string;
  /**
   * A model pin, overriding what the request asked for.
   *
   * Optional because most policy is "use this provider"; pinning a model as
   * well is how an operator holds a workspace on a known-good snapshot while a
   * new one is evaluated.
   */
  readonly model?: string;
}

export const ROUTING_TABLE_ERROR_CODES = ['MissingVersion', 'InvalidPreference'] as const;

export type RoutingTableErrorCode = (typeof ROUTING_TABLE_ERROR_CODES)[number];

export class RoutingTableError extends Error {
  readonly code: RoutingTableErrorCode;
  constructor(code: RoutingTableErrorCode, message: string) {
    super(message);
    this.name = 'RoutingTableError';
    this.code = code;
  }
}

export interface RoutingTableOptions {
  /** Bumped on every edit. Recorded in every decision. */
  readonly version: string;
  /**
   * Where a request goes when nothing more specific applies.
   *
   * OPTIONAL. Omitting it is how a deployment says "any capable provider will
   * do" — the `capability` policy, which is one of the selection modes this
   * increment requires and which would be unreachable if every table had to
   * name a default.
   */
  readonly global?: ProviderPreference;
  readonly organizations?: Readonly<Record<string, ProviderPreference>>;
  readonly workspaces?: Readonly<Record<string, ProviderPreference>>;
}

export interface RoutingTable {
  readonly version: string;
  /** Null when the deployment routes by capability alone. */
  readonly global: ProviderPreference | null;
  forWorkspace(workspaceId: string): ProviderPreference | null;
  forOrganization(organizationId: string): ProviderPreference | null;
}

function assertPreference(where: string, preference: ProviderPreference): ProviderPreference {
  if (typeof preference.providerId !== 'string' || preference.providerId.trim() === '') {
    throw new RoutingTableError('InvalidPreference', `The ${where} preference needs a providerId.`);
  }
  if (preference.model !== undefined && preference.model.trim() === '') {
    throw new RoutingTableError(
      'InvalidPreference',
      `The ${where} preference pins an empty model; omit it to use the request's.`,
    );
  }
  return Object.freeze({ ...preference });
}

/**
 * Build a table. Frozen at construction — there is no edit path, because a
 * table that changed under a running process would make two identical requests
 * route differently for reasons no trace explains.
 */
export function createRoutingTable(options: RoutingTableOptions): RoutingTable {
  if (typeof options.version !== 'string' || options.version.trim() === '') {
    throw new RoutingTableError(
      'MissingVersion',
      'A routing table needs a version; every decision records it so a historical call stays reproducible.',
    );
  }
  const global = options.global === undefined ? null : assertPreference('global', options.global);
  const organizations = new Map<string, ProviderPreference>();
  const workspaces = new Map<string, ProviderPreference>();

  for (const [id, preference] of Object.entries(options.organizations ?? {})) {
    organizations.set(id, assertPreference(`organization '${id}'`, preference));
  }
  for (const [id, preference] of Object.entries(options.workspaces ?? {})) {
    workspaces.set(id, assertPreference(`workspace '${id}'`, preference));
  }

  return Object.freeze({
    version: options.version.trim(),
    global,
    forWorkspace: (workspaceId: string): ProviderPreference | null =>
      workspaces.get(workspaceId) ?? null,
    forOrganization: (organizationId: string): ProviderPreference | null =>
      organizations.get(organizationId) ?? null,
  });
}
