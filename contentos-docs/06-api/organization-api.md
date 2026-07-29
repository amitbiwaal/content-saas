# Organization API

> **Status:** v1.0 — complete. Phase 12. **Contracts only.**
> **The organization is the commercial boundary, not the isolation boundary** (ADR-017). Membership here grants administrative capability over workspaces — never access to their contents.

## Overview

**Purpose.** Define endpoints for organization lifecycle, membership, invitations, and ownership transfer.

**The rule that shapes every response below.** An organization Owner holds `workspace:create` and `workspace:delete` but **not** `article:read`. Administrative authority over a workspace is not access to it, so no endpoint here returns workspace *contents* (`16-security/rbac.md`).

**`organizations` and `organization_memberships` are two of the five RLS exception tables.** They sit above the workspace boundary and are consulted before tenant context exists, so isolation is enforced by application-layer filtering with enumerated access paths — not by a policy (`16-security/row-level-security.md`).

## Common contract

| Property | Value |
|---|---|
| Base path | `/v1/organizations` |
| Authorization | Every endpoint requires an organization-tier permission |
| Tenant scope | **None** — organizations sit above `tenant_id` |
| Rate-limit class | `read` or `write` unless stated |
| Audit | **Every mutation is audited** with actor and target |

## Organization resource

```ts
interface Organization {
  readonly id: string;
  readonly name: string;
  readonly slug: string;                  // immutable after creation
  readonly plan: 'starter' | 'growth' | 'enterprise';
  readonly ssoEnforced: boolean;
  readonly mfaRequired: boolean;
  readonly workspaceCount: number;
  readonly memberCount: number;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}
```

**`slug` is immutable after creation.** It appears in URLs customers bookmark and share; making it mutable would break those links or require permanent redirects for every rename.

**No billing detail is exposed here** beyond `plan`. Invoices, payment methods, and usage belong to the billing surface and require `billing:read` (`04-platform/billing.md`).

## Create organization

| Field | Value |
|---|---|
| **Purpose** | Create an organization; the caller becomes its Owner |
| **Method · Path** | `POST /v1/organizations` |
| **Authorization** | Authenticated — no organization permission required |
| **Idempotency** | **`Idempotency-Key` required** |
| **Rate limit** | `write`, tightened per user |
| **Events** | `OrganizationCreated` |
| **Audit** | Creation recorded with actor |

```ts
// request
{ name: string; slug: string; }

// 201 — Location: /v1/organizations/{id}
{ organization: Organization; membership: { role: 'owner' } }
```

| Error | Code | Status |
|---|---|---|
| Slug taken | `ORGANIZATION_SLUG_TAKEN` | 409 |
| Slug malformed | `VALIDATION_FIELD_INVALID` | 400 |
| Creation limit reached | `DOMAIN_QUOTA_EXCEEDED` | 402 |

**The creator becomes Owner in the same transaction.** An organization with no Owner requires support intervention to recover, so creation and the first membership are atomic — never two calls.

**`Idempotency-Key` is required because a retried create would produce a duplicate organization** with a different slug, and the client would have no way to tell which one it now owns (`api-principles.md`).

## Read and update

| Field | Value |
|---|---|
| **Purpose** | Retrieve and modify organization settings |
| **Method · Path** | `GET /v1/organizations/{id}` · `PATCH /v1/organizations/{id}` |
| **Authorization** | `organization:read` · `organization:update` |
| **Idempotency** | `PATCH` is idempotent; **`If-Match` required** |
| **Rate limit** | `read` · `write` |
| **Events** | `OrganizationUpdated` on change |
| **Audit** | Updates recorded with changed field names |

```ts
// PATCH request — all optional
{ name?: string; mfaRequired?: boolean; }
```

| Error | Code | Status |
|---|---|---|
| Not a member | `SECURITY_AUTHORIZATION_DENIED` | **404** |
| Member without permission | `SECURITY_AUTHORIZATION_DENIED` | 403 |
| Stale `If-Match` | `PRECONDITION_FAILED` | 412 |
| Missing `If-Match` | `PRECONDITION_REQUIRED` | 428 |

**A non-member receives `404`, not `403`.** A `403` confirms the organization exists, which lets an attacker enumerate slugs to map customers (`16-security/authorization.md`).

**`If-Match` is required because two admins editing settings concurrently would otherwise have the second silently overwrite the first** (`api-principles.md`).

**Enabling `mfaRequired` does not retroactively lock out members without MFA.** They are required to enrol at next authentication; immediate enforcement would lock out an entire organization the moment a setting changed.

**`plan` and `ssoEnforced` are not settable here.** Plan changes go through billing; SSO enforcement requires a verified domain (`16-security/authentication.md`).

## Delete organization

| Field | Value |
|---|---|
| **Purpose** | Soft-delete an organization and all its workspaces |
| **Method · Path** | `DELETE /v1/organizations/{id}` |
| **Authorization** | `organization:delete` (**Owner only**) + **step-up** |
| **Idempotency** | Yes — deleting a deleted organization is `204` |
| **Rate limit** | `write` |
| **Events** | `OrganizationDeleted` |
| **Audit** | Recorded with actor, reason, and affected workspace ids |

```ts
// request — explicit confirmation
{ confirmSlug: string; reason?: string; }
// 204
```

| Error | Code | Status |
|---|---|---|
| `confirmSlug` mismatch | `VALIDATION_FIELD_INVALID` | 400 |
| Not the Owner | `SECURITY_AUTHORIZATION_DENIED` | 403 |
| Step-up needed | `SECURITY_STEP_UP_REQUIRED` | 401 |
| Active legal hold | `COMPLIANCE_LEGAL_HOLD` | 409 |

**Requiring the slug in the body is a deliberate friction.** This call cascades to every workspace, every article, and every stored object; a mistyped id with no confirmation would be unrecoverable in the moment.

**Deletion is soft, with a 30-day grace period.** Within it an Owner may restore; after it, hard deletion and cryptographic erasure proceed (`16-security/compliance.md`, `12-storage-platform/retention.md`).

**A legal hold blocks deletion outright**, checked inside the transaction rather than as a pre-flight — a hold placed between check and delete would otherwise be missed.

## Members

| Field | Value |
|---|---|
| **Purpose** | List membership and change roles |
| **Method · Path** | `GET /v1/organizations/{id}/members` · `PATCH .../members/{userId}` · `DELETE .../members/{userId}` |
| **Authorization** | `member:read` · `member:manage` |
| **Idempotency** | `PATCH` and `DELETE` are idempotent |
| **Rate limit** | `read` · `write` |
| **Events** | `OrganizationMemberRoleChanged`, `OrganizationMemberRemoved` |
| **Audit** | **Every binding change recorded with grantor** |

```ts
interface Member {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly role: 'owner' | 'admin' | 'billing_admin' | 'member';
  readonly mfaEnrolled: boolean;
  readonly joinedAt: string;
  readonly lastActiveAt: string | null;
}
```

| Error | Code | Status |
|---|---|---|
| **Removing or demoting the last Owner** | `ORGANIZATION_LAST_OWNER` | **409** |
| Unknown member | `NOT_FOUND` | 404 |
| Insufficient permission | `SECURITY_AUTHORIZATION_DENIED` | 403 |

**The last-Owner rule is enforced transactionally, not by constraint.** A database constraint cannot express "at least one row must remain," so the count check runs inside the transaction that removes or demotes (`16-security/rbac.md`).

**Removing an organization member does not delete their user account.** Identity is global and spans organizations; removal ends one membership (ADR-017).

**Removal revokes their workspace role bindings within that organization** in the same transaction. Leaving orphaned workspace grants behind is how removed employees retain access.

**`lastActiveAt` supports access reviews** — the compliance evidence that dormant accounts are identified (`16-security/compliance.md`).

## Invitations

| Field | Value |
|---|---|
| **Purpose** | Invite a person to join, and accept an invitation |
| **Method · Path** | `POST /v1/organizations/{id}/invitations` · `GET .../invitations` · `DELETE .../invitations/{invitationId}` · `POST /v1/invitations/{token}/accept` |
| **Authorization** | `member:manage`; acceptance requires authentication only |
| **Idempotency** | Create requires `Idempotency-Key`; revoke is idempotent |
| **Rate limit** | `write`, tightened per organization |
| **Events** | `OrganizationInvitationSent`, `OrganizationMemberAdded` |
| **Audit** | Issue, revoke, and acceptance recorded |

```ts
// POST invitations
{ email: string; role: 'admin' | 'billing_admin' | 'member'; }
// 201
{ invitation: { id, email, role, expiresAt, status: 'pending' } }

// POST /v1/invitations/{token}/accept
// 200
{ organization: Organization; membership: { role } }
```

| Error | Code | Status |
|---|---|---|
| Already a member | `ORGANIZATION_ALREADY_MEMBER` | 409 |
| Invitation expired | `INVITATION_EXPIRED` | 410 |
| Invalid or used token | `INVITATION_INVALID` | 404 |
| Email mismatch on accept | `INVITATION_EMAIL_MISMATCH` | 403 |
| Role above inviter's authority | `SECURITY_AUTHORIZATION_DENIED` | 403 |

**`owner` cannot be granted by invitation.** Ownership is transferred explicitly, to an existing member, through the endpoint below — which is auditable in a way that an emailed link is not.

**An invitation cannot grant a role the inviter does not hold.** Without this, an Admin could invite someone as Owner and escalate through them.

**The token is single-use, 7 days, and bound to the invited email address.** Acceptance under a different authenticated identity is `403`, so a forwarded invitation link cannot be redeemed by someone else.

**Invitation listings expose email, role, and status — never the token.** Anyone able to read a token could accept the invitation.

**Revoking a pending invitation invalidates the token immediately.** A revocation that only marked a row would leave a live link.

## Ownership transfer

| Field | Value |
|---|---|
| **Purpose** | Transfer Owner from the caller to another member |
| **Method · Path** | `POST /v1/organizations/{id}/actions/transfer-ownership` |
| **Authorization** | `organization:delete` (**Owner only**) + **step-up** |
| **Idempotency** | `Idempotency-Key` required |
| **Rate limit** | `write` |
| **Events** | `OrganizationOwnershipTransferred` |
| **Audit** | **Recorded with both parties; alerted** |

```ts
{ toUserId: string; confirmSlug: string; }
// 200
{ organization: Organization; previousOwner: { userId, role: 'admin' }; newOwner: { userId, role: 'owner' } }
```

| Error | Code | Status |
|---|---|---|
| Target is not a member | `ORGANIZATION_NOT_MEMBER` | 409 |
| Target has no verified email | `ORGANIZATION_TRANSFER_INELIGIBLE` | 409 |
| Slug mismatch | `VALIDATION_FIELD_INVALID` | 400 |

**The transfer is atomic: the target becomes Owner and the caller becomes Admin in one transaction.** A two-step flow has a window with two Owners or none, and the none case requires support recovery.

**The caller is demoted to Admin rather than removed.** Removing the outgoing Owner would let a compromised account transfer ownership and simultaneously erase the only person who could contest it.

**Transfer is an audited, alerted event.** It is rare and high-consequence, and a transfer nobody expected is the shape of an account takeover (`16-security/security-observability.md`).

**Ownership transfer is a distinct action rather than a `PATCH` to a role**, because the atomic demotion and the eligibility rules are not expressible as a field update (`api-principles.md`).

## Business rules

1. **Organization membership grants no content access.**
2. **`slug` is immutable after creation.**
3. **Creation makes the caller Owner in the same transaction.**
4. **Create and transfer require `Idempotency-Key`.**
5. **Non-members receive `404`, not `403`.**
6. **`If-Match` is required on `PATCH`.**
7. **Deletion requires Owner, step-up, and slug confirmation.**
8. **Deletion is soft with a 30-day grace period.**
9. **Legal hold blocks deletion, checked in-transaction.**
10. **The last Owner cannot be removed or demoted.**
11. **Removing a member revokes their workspace bindings in the same transaction.**
12. **`owner` cannot be granted by invitation.**
13. **An invitation cannot exceed the inviter's authority.**
14. **Invitation tokens are single-use, 7 days, email-bound.**
15. **Ownership transfer is atomic and demotes the caller to Admin.**
16. **Every membership change is audited with the grantor.**

## Events emitted

| Event | Trigger |
|---|---|
| `OrganizationCreated` | Creation |
| `OrganizationUpdated` | Settings change |
| `OrganizationDeleted` | Soft deletion |
| `OrganizationMemberAdded` | Invitation accepted |
| `OrganizationMemberRoleChanged` | Role change |
| `OrganizationMemberRemoved` | Removal |
| `OrganizationInvitationSent` | Invitation issued |
| `OrganizationOwnershipTransferred` | Transfer |

**Every event carries `organizationId` and identifiers only — never member emails or names** (`13-event-platform/event-registry.md`). Events fan out to webhook subscribers with weaker controls than the source table.

**All are published through the transactional outbox** in the same transaction as the state change, so a `201` and its event cannot diverge.

## Audit implications

| Action | Recorded |
|---|---|
| Create, update, delete | Actor, changed fields, reason |
| Role change | **Grantor, subject, from-role, to-role** |
| Member removal | Actor, subject, revoked workspace bindings |
| Invitation issue, revoke, accept | Actor, email, role |
| **Ownership transfer** | **Both parties — alerted** |

**Role changes record the grantor**, which is the access-review evidence auditors ask for (`16-security/audit.md`, `16-security/compliance.md`).

## Cross references

- `16-security/rbac.md` — **organization roles, the last-Owner rule, why org roles grant no content access**
- `16-security/authorization.md` — permission evaluation, 404-versus-403
- `16-security/authentication.md` — step-up, verified domains
- `16-security/row-level-security.md` — why these tables are RLS exceptions
- `16-security/audit.md` — membership change records
- `16-security/compliance.md` — legal hold, deletion, access reviews
- `api-principles.md` — actions, `If-Match`, idempotency, status codes
- `workspace-api.md` — the workspaces this organization contains
- `authentication-api.md` — invitation acceptance requires authentication
- `04-platform/billing.md` — plan changes and invoices
- `13-event-platform/event-registry.md` — payload content rules
- `02-domain-design/organizations.md` — the domain model
- `01-system-architecture/13-adr-log.md` — ADR-017
