# Workspace API

> **Status:** v1.0 — complete. Phase 12. **Contracts only.**
> **The workspace *is* the tenant.** `workspaceId` and `tenantId` are the same value (ADR-017), which makes every endpoint here the boundary at which isolation is enforced.

## Overview

**Purpose.** Define endpoints for workspace lifecycle, membership, role bindings, and effective-permission lookup.

**The identity that shapes everything below.** `tenant_id` is not a reference to a workspace — it *is* the workspace id. Every RLS policy in the platform keys on it, so an authorization mistake at this boundary is a cross-tenant exposure rather than a permissions bug (`16-security/row-level-security.md`).

**Creation and deletion are organization-tier operations.** `workspace:create` and `workspace:delete` belong to the organization role catalogue; everything *inside* a workspace is workspace-tier (`16-security/rbac.md`).

## Common contract

| Property | Value |
|---|---|
| Base path | `/v1/workspaces` (creation is nested under the organization) |
| Tenant scope | **This resource defines it** |
| Authorization | Workspace-tier, except create and delete |
| Rate-limit class | `read` or `write` unless stated |
| Audit | Every mutation and every binding change |

## Workspace resource

```ts
interface Workspace {
  readonly id: string;                    // === tenantId
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;                  // unique within the organization
  readonly status: 'active' | 'archived' | 'deleted';
  readonly projectCount: number;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly purgeEligibleAt: string | null;
}
```

**`id` is stated as equal to `tenantId` in the schema documentation deliberately.** Clients never send `tenantId` — it is derived server-side — but implementers reading this contract need to know the two are one value, not a join.

**`slug` is unique within the organization, not globally.** Two organizations may both have `marketing`.

## Create workspace

| Field | Value |
|---|---|
| **Purpose** | Create a workspace within an organization |
| **Method · Path** | `POST /v1/organizations/{organizationId}/workspaces` |
| **Authorization** | **`workspace:create`** — organization tier |
| **Idempotency** | **`Idempotency-Key` required** |
| **Rate limit** | `write` |
| **Events** | `WorkspaceCreated` |
| **Audit** | Recorded with actor and organization |

```ts
// request
{ name: string; slug: string; }

// 201 — Location: /v1/workspaces/{id}
{ workspace: Workspace; membership: { role: 'workspace_admin' } | null }
```

| Error | Code | Status |
|---|---|---|
| Slug taken in this organization | `WORKSPACE_SLUG_TAKEN` | 409 |
| Plan workspace limit reached | `DOMAIN_QUOTA_EXCEEDED` | 402 |
| Lacks `workspace:create` | `SECURITY_AUTHORIZATION_DENIED` | 403 |
| Organization archived or deleted | `DOMAIN_STATE_INVALID` | 409 |

**`membership` is `null` when the creator is an organization Admin or Owner without a workspace role.** This is the model's most consequential rule made visible in a response: creating a workspace does not grant access to it. The creator sees the workspace exists and cannot read its contents until they grant themselves a role — which is audited and alerted (`16-security/rbac.md`).

**The RLS policy and tenant scope exist from the creating transaction.** There is no window in which a workspace exists without isolation (`07-development-guide/migration-guide.md`).

**`DOMAIN_QUOTA_EXCEEDED` returns `402`, not `403`.** The caller has permission; the plan does not include another workspace. Entitlement and permission are separate checks with separate meanings (`16-security/authorization.md`).

## Read and update

| Field | Value |
|---|---|
| **Purpose** | Retrieve and modify workspace settings |
| **Method · Path** | `GET /v1/workspaces/{id}` · `PATCH /v1/workspaces/{id}` |
| **Authorization** | `workspace:read` · `workspace:update` |
| **Idempotency** | `PATCH` idempotent; **`If-Match` required** |
| **Rate limit** | `read` · `write` |
| **Events** | `WorkspaceUpdated` |
| **Audit** | Changed field names recorded |

```ts
// PATCH — all optional
{ name?: string; defaultLocale?: string; }
```

| Error | Code | Status |
|---|---|---|
| No membership in this workspace | `SECURITY_AUTHORIZATION_DENIED` | **404** |
| Member without permission | `SECURITY_AUTHORIZATION_DENIED` | 403 |
| Archived workspace | `WORKSPACE_ARCHIVED` | 409 |
| Stale / missing `If-Match` | `PRECONDITION_FAILED` / `PRECONDITION_REQUIRED` | 412 / 428 |

**`404` for a workspace the subject cannot reach is the platform's most important instance of this rule.** Because `workspaceId` is the tenant key, a `403` would confirm that a specific tenant exists — letting an attacker enumerate the customer base by probing ids (`16-security/authorization.md`).

**An organization Owner with no workspace role also receives `404` on content.** They can see the workspace in the organization's list; they cannot read inside it.

**`GET` on an archived workspace succeeds; `PATCH` does not.** Archived data stays readable — that is the point of archiving rather than deleting.

## Archive and restore

| Field | Value |
|---|---|
| **Purpose** | Make a workspace read-only, and reverse it |
| **Method · Path** | `POST /v1/workspaces/{id}/actions/archive` · `.../actions/restore` |
| **Authorization** | `workspace:update` (archive) · `workspace:update` (restore) |
| **Idempotency** | Yes — archiving an archived workspace is `200` |
| **Rate limit** | `write` |
| **Events** | `WorkspaceArchived`, `WorkspaceRestored` |
| **Audit** | Recorded with actor and reason |

```ts
// archive request
{ reason?: string; }
// 200
{ workspace: Workspace }   // status: 'archived'
```

**Archiving is not deletion and is fully reversible.** Content remains readable, media remains served, and search remains available. What stops is writing: no runs, no publishing, no new content.

**Archived workspaces still count toward storage but not toward the plan's active-workspace limit.** A customer with seasonal projects should not pay a seat cost for dormant work, and forcing deletion to stay within a limit destroys data the customer wanted.

**Scheduled work for an archived workspace is cancelled, not paused.** Resuming a run that was mid-pipeline weeks earlier would execute against stale research and a stale outline.

**Restore requires the organization to be active.** A workspace inside a deleted organization cannot be restored independently.

## Delete workspace

| Field | Value |
|---|---|
| **Purpose** | Soft-delete a workspace and everything in it |
| **Method · Path** | `DELETE /v1/workspaces/{id}` |
| **Authorization** | **`workspace:delete`** — organization tier — + **step-up** |
| **Idempotency** | Yes — `204` on an already-deleted workspace |
| **Rate limit** | `write` |
| **Events** | `WorkspaceDeleted` |
| **Audit** | Actor, reason, and affected resource counts |

```ts
{ confirmSlug: string; reason?: string; }
// 204
```

| Error | Code | Status |
|---|---|---|
| Slug mismatch | `VALIDATION_FIELD_INVALID` | 400 |
| Lacks `workspace:delete` | `SECURITY_AUTHORIZATION_DENIED` | 403 |
| Step-up required | `SECURITY_STEP_UP_REQUIRED` | 401 |
| Legal hold active | `COMPLIANCE_LEGAL_HOLD` | 409 |

**Deletion is an organization-tier permission deliberately.** A Workspace Admin runs a workspace; destroying it is a commercial decision belonging to whoever owns the account.

**Soft delete with a 30-day grace period**, surfaced as `purgeEligibleAt`. Within it, restore is available; after it, hard deletion and cryptographic erasure proceed — destroying the tenant DEK renders the workspace's data unreadable everywhere including backups (`16-security/encryption.md`, `12-storage-platform/retention.md`).

**Legal hold blocks deletion**, checked inside the deleting transaction (`16-security/compliance.md`).

**Deleting a workspace revokes every role binding scoped to it** in the same transaction, so no grant survives its subject.

## Membership and roles

| Field | Value |
|---|---|
| **Purpose** | Grant, modify, and revoke workspace access |
| **Method · Path** | `GET /v1/workspaces/{id}/members` · `POST .../members` · `PATCH .../members/{userId}` · `DELETE .../members/{userId}` |
| **Authorization** | `workspace:read` · **`member:manage`** for mutations |
| **Idempotency** | `PATCH` and `DELETE` idempotent; `POST` requires `Idempotency-Key` |
| **Rate limit** | `read` · `write` |
| **Events** | `WorkspaceMemberAdded`, `WorkspaceMemberRoleChanged`, `WorkspaceMemberRemoved` |
| **Audit** | **Grantor, subject, role, scope, and expiry recorded** |

```ts
interface WorkspaceMember {
  readonly userId: string;
  readonly email: string;
  readonly role: 'workspace_admin' | 'editor' | 'contributor' | 'viewer';
  readonly projectScope: readonly string[] | null;   // null = all projects
  readonly grantedBy: string;
  readonly grantedAt: string;
  readonly expiresAt: string | null;
}

// POST members
{ userId: string; role: WorkspaceRole; projectScope?: string[]; expiresAt?: string; }
```

| Error | Code | Status |
|---|---|---|
| Not an organization member | `WORKSPACE_NOT_ORG_MEMBER` | 409 |
| **`projectScope: []`** | `VALIDATION_FIELD_INVALID` | **400** |
| Project not in this workspace | `VALIDATION_FIELD_INVALID` | 400 |
| `expiresAt` in the past | `VALIDATION_FIELD_INVALID` | 400 |
| Removing the last Workspace Admin | `WORKSPACE_LAST_ADMIN` | 409 |

**An empty `projectScope` array is rejected, not treated as "no projects."** The empty array is ambiguous — it reads as either "none" or "unset" — and the two interpretations differ by everything. `null` means all projects; a non-empty array means those. A CHECK constraint enforces this at the database level too (`16-security/rbac.md`).

**A subject must be an organization member before receiving a workspace role.** Workspace access without organization membership would create a subject outside the commercial boundary with no billing relationship.

**`expiresAt` supports contractor access without a cleanup step nobody performs.** Expiry is evaluated at decision time rather than by a sweep, so there is no window in which a lapsed grant still works.

**Roles are additive and resolution is a union** — a subject holding Editor on the workspace and a scoped Contributor binding has the union of both. There are no subtractive grants (`16-security/rbac.md`).

## Self-grant

**An organization Owner or Admin granting themselves a workspace role uses the same `POST .../members` endpoint** — there is no separate path.

| Property | Behaviour |
|---|---|
| Permitted | **Yes** — an account owner can always reach their organization's data |
| Recorded | `grantedBy === userId` marks it a self-grant |
| Audited | Yes, as a first-class event |
| **Alerted** | **Yes** — `self_grants_total` is monitored |

**The control is not prevention; it is the receipt.** Preventing self-grant would be theatre, since an Owner could grant a colleague who grants them back. Making it visible, attributed, and alerting is what turns ambient access into an observable act (`16-security/rbac.md`, `16-security/security-observability.md`).

## Effective permissions

| Field | Value |
|---|---|
| **Purpose** | Return the caller's effective permissions **for UI rendering** |
| **Method · Path** | `GET /v1/workspaces/{id}/permissions` |
| **Authorization** | `workspace:read` |
| **Idempotency** | Read-only |
| **Rate limit** | `read` |
| **Events** | None |
| **Audit** | Not recorded |

```ts
// 200
{
  permissions: readonly string[];        // 'article:read', 'article:create', …
  role: WorkspaceRole;
  projectScope: readonly string[] | null;
  expiresAt: string | null;
}
```

**This endpoint is never an enforcement path, and that is a contract statement, not an implementation note.** A client hiding a button is a usability feature; the server evaluates every request independently. A client that treated this response as authoritative and skipped a call would be relying on a cache the server does not honour (`16-security/authorization.md`).

**It returns the caller's own permissions only.** Querying another subject's permissions requires `member:read` and returns the binding, not a computed set — computed sets change with role catalogue changes and would be stale the moment they were cached.

**Not audited, deliberately.** It is a read of the caller's own state with no state change, and auditing it would add volume that buries the records that matter.

## Business rules

1. **`workspaceId` is `tenantId`.**
2. **Create and delete are organization-tier permissions.**
3. **Creating a workspace does not grant access to it.**
4. **RLS applies from the creating transaction.**
5. **Unreachable workspaces return `404`, never `403`.**
6. **`If-Match` is required on `PATCH`.**
7. **Archive is reversible and read-only; `GET` still succeeds.**
8. **Scheduled work is cancelled on archive, not paused.**
9. **Delete requires org-tier permission, step-up, and slug confirmation.**
10. **Soft delete with a 30-day grace, then cryptographic erasure.**
11. **Legal hold blocks deletion, checked in-transaction.**
12. **Deleting a workspace revokes its bindings in the same transaction.**
13. **`projectScope: []` is rejected**; `null` means all projects.
14. **Workspace roles require existing organization membership.**
15. **Bindings may expire; expiry is evaluated at decision time.**
16. **Self-grant is permitted, attributed, audited, and alerted.**
17. **The permissions endpoint is never an enforcement path.**
18. **The last Workspace Admin cannot be removed.**

## Events emitted

| Event | Trigger |
|---|---|
| `WorkspaceCreated` | Creation |
| `WorkspaceUpdated` | Settings change |
| `WorkspaceArchived` · `WorkspaceRestored` | Lifecycle transitions |
| `WorkspaceDeleted` | Soft deletion |
| `WorkspaceMemberAdded` · `RoleChanged` · `Removed` | Binding changes |

**Every event carries `tenantId` and `organizationId` as mandatory envelope fields** (`13-event-platform/event-apis.md`), and payloads carry identifiers only — never member emails or workspace content.

**`WorkspaceDeleted` is consumed across the platform** to cancel scheduled work, invalidate caches, and schedule storage purge — which is why it must be published through the outbox in the deleting transaction rather than emitted afterwards (`13-event-platform/transactional-outbox.md`).

## Audit implications

| Action | Recorded |
|---|---|
| Create, update, archive, restore | Actor, changed fields, reason |
| Delete | Actor, reason, affected resource counts |
| Binding add, change, remove | **Grantor, subject, role, project scope, expiry** |
| **Self-grant** | **Flagged and alerted** |

**Binding records are the access-review evidence** for SOC 2 and ISO 27001 — who granted what, to whom, when, and whether it has expired (`16-security/compliance.md`).

## Cross references

- `16-security/rbac.md` — **workspace roles, project scope, the self-grant rule**
- `16-security/row-level-security.md` — `tenant_id` as the RLS key
- `16-security/tenant-isolation.md` — why `404` matters at this boundary
- `16-security/authorization.md` — permission versus entitlement; the non-enforcement rule
- `16-security/compliance.md` — legal hold, erasure, access reviews
- `16-security/encryption.md` — cryptographic erasure on purge
- `16-security/audit.md` — binding change records
- `api-principles.md` — actions, `If-Match`, idempotency, status codes
- `organization-api.md` — the containing organization and its membership
- `12-storage-platform/retention.md` — grace period and purge
- `13-event-platform/transactional-outbox.md` — event emission in-transaction
- `02-domain-design/organizations.md` — the domain model
- `01-system-architecture/13-adr-log.md` — **ADR-017**
