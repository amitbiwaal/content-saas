/**
 * Permission vocabulary and the role catalogue — `16-security/rbac.md`.
 *
 * `Permission` is a TEMPLATE LITERAL TYPE, so an invalid permission string is a
 * compile error. A typo like `article:updat` fails the build rather than
 * silently denying at runtime — a denial that would look like a legitimate
 * access-control decision in production.
 *
 * Permission names are versioned with the codebase, never runtime-editable.
 */

export const RESOURCE_KINDS = [
  'organization',
  'member',
  'billing',
  'sso',
  'workspace',
  'project',
  'article',
  'keyword',
  'research',
  'knowledge',
  'run',
  'publish',
  'analytics',
  'audit',
  'apikey',
  'integration',
  'replay',
  'dlq',
  'platform',
  'service',
] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

/**
 * The seven canonical actions (`rbac.md` §Actions), plus the four that appear
 * only in specific permissions: `cancel` (run), `relay`/`worker` (service), and
 * `audit`/`support` (platform).
 */
export const ACTION_NAMES = [
  'read',
  'create',
  'update',
  'delete',
  'manage',
  'execute',
  'export',
  'cancel',
  'relay',
  'worker',
  'audit',
  'support',
] as const;
export type ActionName = (typeof ACTION_NAMES)[number];

export type Permission = `${ResourceKind}:${ActionName}`;

/** Every permission that exists. A string outside this set is not a permission. */
export const PERMISSIONS = [
  'organization:read',
  'organization:update',
  'organization:delete',
  'member:read',
  'member:manage',
  'billing:read',
  'billing:manage',
  'sso:manage',
  'workspace:create',
  'workspace:read',
  'workspace:update',
  'workspace:delete',
  'project:create',
  'project:read',
  'project:update',
  'project:delete',
  'article:create',
  'article:read',
  'article:update',
  'article:delete',
  'article:execute',
  'article:export',
  'keyword:create',
  'keyword:read',
  'keyword:update',
  'keyword:delete',
  'research:read',
  'research:execute',
  'knowledge:read',
  'knowledge:update',
  'run:read',
  'run:execute',
  'run:cancel',
  'publish:execute',
  'analytics:read',
  'analytics:export',
  'audit:read',
  'apikey:read',
  'apikey:manage',
  'integration:read',
  'integration:manage',
  'replay:execute',
  'dlq:read',
  'dlq:manage',
  'platform:audit',
  'platform:support',
  'service:relay',
  'service:worker',
] as const satisfies readonly Permission[];

const PERMISSION_SET = new Set<string>(PERMISSIONS);

export function isValidPermission(p: string): p is Permission {
  return PERMISSION_SET.has(p);
}

// ── Roles ────────────────────────────────────────────────────────────────────

export const ORGANIZATION_ROLES = [
  'org_owner',
  'org_admin',
  'billing_admin',
  'org_member',
] as const;
export const WORKSPACE_ROLES = ['workspace_admin', 'editor', 'contributor', 'viewer'] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
export type RoleName = OrganizationRole | WorkspaceRole;
export type RoleTier = 'organization' | 'workspace';

const ORG_ADMIN: readonly Permission[] = [
  'organization:read',
  'organization:update',
  'member:read',
  'member:manage',
  'billing:read',
  'sso:manage',
  'workspace:create',
  'workspace:read',
  'workspace:delete',
];

const VIEWER: readonly Permission[] = [
  'workspace:read',
  'project:read',
  'article:read',
  'keyword:read',
  'research:read',
  'knowledge:read',
  'run:read',
  'analytics:read',
  'integration:read',
  'apikey:read',
];

const CONTRIBUTOR: readonly Permission[] = [
  ...VIEWER,
  'article:create',
  'article:update',
  'keyword:create',
  'keyword:update',
  'run:execute',
  'run:cancel',
  'research:execute',
];

const EDITOR: readonly Permission[] = [
  ...CONTRIBUTOR,
  'article:delete',
  'article:execute',
  'article:export',
  'keyword:delete',
  'knowledge:update',
  'project:create',
  'project:update',
  'project:delete',
  'publish:execute',
  'analytics:export',
];

const WORKSPACE_ADMIN: readonly Permission[] = [
  ...EDITOR,
  'workspace:update',
  'apikey:manage',
  'integration:manage',
  'audit:read',
];

/**
 * The catalogue.
 *
 * ORGANIZATION ROLES GRANT NO CONTENT ACCESS. This is the model's most
 * consequential rule: an organization Owner has `workspace:create` and
 * `workspace:delete` but NO `article:read`. Administrative authority over a
 * workspace is not access to its contents.
 */
export const ROLE_PERMISSIONS: Readonly<Record<RoleName, readonly Permission[]>> = {
  // — organization tier —
  org_owner: [...ORG_ADMIN, 'organization:delete', 'billing:manage'],
  org_admin: ORG_ADMIN,
  // Deliberately narrow: finance contacts need invoices, not drafts.
  billing_admin: ['organization:read', 'billing:read', 'billing:manage'],
  org_member: ['organization:read', 'member:read'],

  // — workspace tier —
  workspace_admin: WORKSPACE_ADMIN,
  editor: EDITOR,
  // Cannot publish or export — the distinction that makes the role safe for
  // freelancers and agency staff.
  contributor: CONTRIBUTOR,
  // Read access in the product is not bulk extraction: no `:export`.
  viewer: VIEWER,
};

export interface RoleCatalogue {
  permissionsOf(role: RoleName): readonly Permission[];
  rolesAt(tier: RoleTier): readonly RoleName[];
  isValidPermission(p: string): p is Permission;
}

export const roleCatalogue: RoleCatalogue = {
  permissionsOf(role) {
    return ROLE_PERMISSIONS[role];
  },
  rolesAt(tier) {
    return tier === 'organization' ? ORGANIZATION_ROLES : WORKSPACE_ROLES;
  },
  isValidPermission,
};

export function tierOf(role: RoleName): RoleTier {
  return (ORGANIZATION_ROLES as readonly string[]).includes(role) ? 'organization' : 'workspace';
}

/** Content permissions an organization-tier role may never hold. */
export const CONTENT_PERMISSIONS: readonly Permission[] = [
  'article:read',
  'article:create',
  'article:update',
  'article:delete',
  'article:export',
  'knowledge:read',
  'run:read',
];
