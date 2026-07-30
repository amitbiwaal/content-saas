/**
 * Membership domain rules — pure.
 *
 * The grant matrices are transcribed from `organizations.md` rule 3 and
 * `workspace.md` rule 6; the expiry rule from `workspace.md` rule 8.
 */
import { describe, expect, it } from 'vitest';

import { assertValidBinding, isBindingActive, resolvePermissions } from '@contentos/security';

import {
  canGrantOrganizationRole,
  canGrantWorkspaceRole,
  INVITATION_TTL_DAYS,
  invitationExpiry,
  isInvitationExpired,
  isMembershipStatus,
  MEMBERSHIP_STATUSES,
  MembershipError,
  ORGANIZATION_OWNER_ROLE,
  ORGANIZATION_ROLE_GRANTS,
  toRoleBinding,
  WORKSPACE_OWNER_ROLE,
  WORKSPACE_ROLE_GRANTS,
  wouldRemoveLastOwner,
  type MembershipProjection,
} from './membership.js';

const NOW = new Date('2026-07-30T12:00:00.000Z');
const USER = '018f7a1e-0000-7000-8000-000000000001';
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000c1';

describe('membership statuses', () => {
  // The CHECK constraints in migrations 0003 and 0004 are the other half.
  it('are exactly the three both membership tables allow', () => {
    expect([...MEMBERSHIP_STATUSES]).toEqual(['invited', 'active', 'revoked']);
  });

  it('recognises its own members and nothing else', () => {
    expect(isMembershipStatus('invited')).toBe(true);
    expect(isMembershipStatus('expired')).toBe(false);
    expect(isMembershipStatus('')).toBe(false);
  });
});

describe('invitation expiry', () => {
  it('expires 14 days after issue', () => {
    expect(INVITATION_TTL_DAYS).toBe(14);
    expect(invitationExpiry(NOW).toISOString()).toBe('2026-08-13T12:00:00.000Z');
  });

  it('is not expired before the deadline', () => {
    const expiresAt = invitationExpiry(NOW);
    expect(isInvitationExpired(expiresAt, NOW)).toBe(false);
    expect(isInvitationExpired(expiresAt, new Date('2026-08-13T11:59:59.999Z'))).toBe(false);
  });

  // Evaluated at use, so there is no window in which a lapsed invitation works.
  it('is expired at the deadline and after it', () => {
    const expiresAt = invitationExpiry(NOW);
    expect(isInvitationExpired(expiresAt, expiresAt)).toBe(true);
    expect(isInvitationExpired(expiresAt, new Date('2026-08-14T00:00:00.000Z'))).toBe(true);
  });

  it('treats a null deadline as never expiring', () => {
    expect(isInvitationExpired(null, NOW)).toBe(false);
  });
});

describe('organization role grants — rule 3', () => {
  it('lets org_owner act on every organization role', () => {
    for (const role of ['org_owner', 'org_admin', 'billing_admin', 'org_member'] as const) {
      expect(canGrantOrganizationRole('org_owner', role), role).toBe(true);
    }
  });

  // "org_admin may manage org_admin and members but NOT org_owner, and NOT
  // billing_admin."
  it('stops org_admin short of org_owner and billing_admin', () => {
    expect(canGrantOrganizationRole('org_admin', 'org_admin')).toBe(true);
    expect(canGrantOrganizationRole('org_admin', 'org_member')).toBe(true);
    expect(canGrantOrganizationRole('org_admin', 'org_owner')).toBe(false);
    expect(canGrantOrganizationRole('org_admin', 'billing_admin')).toBe(false);
  });

  // A pure separation-of-duties role: finance staff need invoices, not authority.
  it('gives billing_admin and org_member no membership authority at all', () => {
    expect(ORGANIZATION_ROLE_GRANTS.billing_admin).toEqual([]);
    expect(ORGANIZATION_ROLE_GRANTS.org_member).toEqual([]);
    for (const role of ['org_owner', 'org_admin', 'billing_admin', 'org_member'] as const) {
      expect(canGrantOrganizationRole('billing_admin', role)).toBe(false);
      expect(canGrantOrganizationRole('org_member', role)).toBe(false);
    }
  });
});

describe('workspace role grants — rule 6', () => {
  it('makes workspace_admin the only role with membership authority', () => {
    for (const role of ['workspace_admin', 'editor', 'contributor', 'viewer'] as const) {
      expect(canGrantWorkspaceRole('workspace_admin', role), role).toBe(true);
    }
  });

  it('gives editor, contributor and viewer authority over nobody', () => {
    for (const actor of ['editor', 'contributor', 'viewer'] as const) {
      expect(WORKSPACE_ROLE_GRANTS[actor]).toEqual([]);
      for (const role of ['workspace_admin', 'editor', 'contributor', 'viewer'] as const) {
        expect(canGrantWorkspaceRole(actor, role)).toBe(false);
      }
    }
  });
});

describe('last-owner protection', () => {
  it('names the owner-equivalent role at each tier', () => {
    expect(ORGANIZATION_OWNER_ROLE).toBe('org_owner');
    expect(WORKSPACE_OWNER_ROLE).toBe('workspace_admin');
  });

  it('refuses to demote or revoke the only active owner', () => {
    expect(wouldRemoveLastOwner('org_owner', 'org_admin', 'active', 1, 'org_owner')).toBe(true);
    expect(wouldRemoveLastOwner('org_owner', null, 'active', 1, 'org_owner')).toBe(true);
  });

  it('permits it while another active owner remains', () => {
    expect(wouldRemoveLastOwner('org_owner', 'org_admin', 'active', 2, 'org_owner')).toBe(false);
    expect(wouldRemoveLastOwner('org_owner', null, 'active', 2, 'org_owner')).toBe(false);
  });

  it('permits a change that leaves the membership an owner', () => {
    expect(wouldRemoveLastOwner('org_owner', 'org_owner', 'active', 1, 'org_owner')).toBe(false);
  });

  it('does not protect a non-owner', () => {
    expect(wouldRemoveLastOwner('org_admin', null, 'active', 0, 'org_owner')).toBe(false);
    expect(wouldRemoveLastOwner('org_member', 'org_admin', 'active', 1, 'org_owner')).toBe(false);
  });

  // Only an ACTIVE owner is holding the position open.
  it('does not protect an invited or revoked owner', () => {
    expect(wouldRemoveLastOwner('org_owner', null, 'invited', 1, 'org_owner')).toBe(false);
    expect(wouldRemoveLastOwner('org_owner', null, 'revoked', 1, 'org_owner')).toBe(false);
  });

  it('applies identically at the workspace tier', () => {
    expect(wouldRemoveLastOwner('workspace_admin', 'editor', 'active', 1, 'workspace_admin')).toBe(
      true,
    );
    expect(wouldRemoveLastOwner('workspace_admin', 'editor', 'active', 3, 'workspace_admin')).toBe(
      false,
    );
  });
});

describe('role bindings — the seam into authorization', () => {
  function projection(over: Partial<MembershipProjection> = {}): MembershipProjection {
    return {
      userId: USER,
      role: 'org_admin',
      status: 'active',
      organizationId: ORG,
      workspaceId: null,
      grantedBy: '018f7a1e-0000-7000-8000-000000000002',
      grantedAt: NOW,
      expiresAt: null,
      ...over,
    };
  }

  it('projects an active organization membership into an organization-tier binding', () => {
    const binding = toRoleBinding(projection());
    expect(binding).toMatchObject({
      subjectId: USER,
      subjectKind: 'user',
      role: 'org_admin',
      tier: 'organization',
      organizationId: ORG,
      workspaceId: null,
      projectScope: null,
      status: 'active',
    });
  });

  it('projects an active workspace membership into a workspace-tier binding', () => {
    const binding = toRoleBinding(projection({ role: 'editor', workspaceId: WS }));
    expect(binding).toMatchObject({ tier: 'workspace', workspaceId: WS, role: 'editor' });
  });

  // The evaluator's own validator is the arbiter of a well-formed binding.
  it('produces bindings the authorization evaluator accepts', () => {
    for (const p of [projection(), projection({ role: 'viewer', workspaceId: WS })]) {
      const binding = toRoleBinding(p);
      expect(binding).not.toBeNull();
      expect(() => {
        assertValidBinding(binding!);
      }).not.toThrow();
      expect(isBindingActive(binding!, NOW)).toBe(true);
    }
  });

  // An invitation is an offer, not an entitlement.
  it('projects nothing for an invited or revoked membership', () => {
    expect(toRoleBinding(projection({ status: 'invited' }))).toBeNull();
    expect(toRoleBinding(projection({ status: 'revoked' }))).toBeNull();
  });

  it('grants the role catalogue permissions once resolved', () => {
    const binding = toRoleBinding(projection({ role: 'editor', workspaceId: WS }));
    const permissions = resolvePermissions([binding!], WS, ORG, null, NOW);
    expect(permissions.has('article:update')).toBe(true);
    // Organization roles grant no content access — the model's most
    // consequential rule, verified from the membership side.
    const orgOnly = resolvePermissions([toRoleBinding(projection())!], WS, ORG, null, NOW);
    expect(orgOnly.has('article:read')).toBe(false);
    expect(orgOnly.has('workspace:create')).toBe(true);
  });
});

describe('membership errors', () => {
  it('carry a typed code so callers branch on the failure', () => {
    const error = new MembershipError('DuplicateInvitation', 'already pending');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MembershipError');
    expect(error.code).toBe('DuplicateInvitation');
  });
});
