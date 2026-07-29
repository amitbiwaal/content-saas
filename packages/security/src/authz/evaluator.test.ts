import { describe, expect, it } from 'vitest';

import type { Subject } from '../authn/subject.js';
import type { ResourceRef } from '../tenant/context.js';
import {
  assertValidBinding,
  AuthorizationError,
  authorizationService,
  evaluate,
  isBindingActive,
  resolvePermissions,
  type RoleBinding,
} from './evaluator.js';
import { isValidPermission, ROLE_PERMISSIONS, roleCatalogue } from './permissions.js';

const AT = new Date('2026-07-29T10:00:00Z');
const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000bb';
const OTHER_WS = '018f7a1e-0000-7000-8000-0000000000cc';

const subject: Subject = {
  subjectId: 'user-1',
  kind: 'user',
  authenticatedAt: AT,
  method: 'password',
  mfaSatisfied: true,
  sessionId: 's1',
};

const resource: ResourceRef = {
  kind: 'article',
  id: 'a1',
  tenantId: WS,
  organizationId: ORG,
  ownerId: null,
};

const binding = (over: Partial<RoleBinding> = {}): RoleBinding => ({
  subjectId: 'user-1',
  subjectKind: 'user',
  role: 'editor',
  tier: 'workspace',
  organizationId: ORG,
  workspaceId: WS,
  projectScope: null,
  grantedBy: 'admin',
  grantedAt: AT,
  expiresAt: null,
  ...over,
});

describe('permission vocabulary', () => {
  it('rejects a typo', () => {
    expect(isValidPermission('article:update')).toBe(true);
    expect(isValidPermission('article:updat')).toBe(false);
  });

  it('exposes roles per tier', () => {
    expect(roleCatalogue.rolesAt('organization')).toContain('org_owner');
    expect(roleCatalogue.rolesAt('workspace')).toContain('contributor');
  });
});

// The model's most consequential rule.
describe('organization roles grant NO content access', () => {
  it('gives org_owner workspace administration', () => {
    expect(ROLE_PERMISSIONS.org_owner).toContain('workspace:create');
    expect(ROLE_PERMISSIONS.org_owner).toContain('workspace:delete');
  });

  it('gives org_owner NO article:read', () => {
    expect(ROLE_PERMISSIONS.org_owner).not.toContain('article:read');
  });

  it('gives no organization-tier role any content permission', () => {
    for (const role of ['org_owner', 'org_admin', 'billing_admin', 'org_member'] as const) {
      expect(ROLE_PERMISSIONS[role]).not.toContain('article:read');
      expect(ROLE_PERMISSIONS[role]).not.toContain('knowledge:read');
    }
  });

  it('denies an org_owner reading an article', () => {
    const decision = evaluate({
      subject,
      action: 'article:read',
      resource,
      at: AT,
      bindings: [binding({ role: 'org_owner', tier: 'organization', workspaceId: null })],
    });
    expect(decision.effect).toBe('deny');
  });
});

describe('role boundaries', () => {
  it('Contributor cannot publish or export', () => {
    expect(ROLE_PERMISSIONS.contributor).not.toContain('publish:execute');
    expect(ROLE_PERMISSIONS.contributor).not.toContain('article:export');
    expect(ROLE_PERMISSIONS.contributor).not.toContain('analytics:export');
  });

  it('Contributor cannot delete', () => {
    expect(ROLE_PERMISSIONS.contributor).not.toContain('article:delete');
  });

  it('Viewer holds only read permissions', () => {
    for (const permission of ROLE_PERMISSIONS.viewer) {
      expect(permission.endsWith(':read')).toBe(true);
    }
  });

  it('Editor lacks the admin-only permissions', () => {
    expect(ROLE_PERMISSIONS.editor).not.toContain('apikey:manage');
    expect(ROLE_PERMISSIONS.editor).not.toContain('integration:manage');
    expect(ROLE_PERMISSIONS.editor).not.toContain('workspace:update');
  });

  it('Billing Admin is deliberately narrow', () => {
    expect(ROLE_PERMISSIONS.billing_admin).toEqual([
      'organization:read',
      'billing:read',
      'billing:manage',
    ]);
  });
});

describe('evaluation', () => {
  it('allows a permitted action', () => {
    expect(
      evaluate({ subject, action: 'article:update', resource, bindings: [binding()], at: AT })
        .effect,
    ).toBe('allow');
  });

  it('denies no-membership when nothing matches the organization', () => {
    expect(
      evaluate({ subject, action: 'article:read', resource, at: AT, bindings: [] }),
    ).toMatchObject({
      effect: 'deny',
      reason: 'no-membership',
    });
  });

  it('denies insufficient-role when the role lacks the permission', () => {
    expect(
      evaluate({
        subject,
        action: 'publish:execute',
        resource,
        at: AT,
        bindings: [binding({ role: 'contributor' })],
      }),
    ).toMatchObject({ effect: 'deny', reason: 'insufficient-role' });
  });

  it('denies subject-suspended before anything else', () => {
    expect(
      evaluate({
        subject,
        action: 'article:read',
        resource,
        at: AT,
        bindings: [binding()],
        subjectSuspended: true,
      }),
    ).toMatchObject({ effect: 'deny', reason: 'subject-suspended' });
  });

  it('denies entitlement when the plan excludes it', () => {
    expect(
      evaluate({
        subject,
        action: 'article:read',
        resource,
        at: AT,
        bindings: [binding()],
        entitled: false,
      }),
    ).toMatchObject({ effect: 'deny', reason: 'entitlement' });
  });

  it('denies step-up-required for a sensitive operation without fresh MFA', () => {
    expect(
      evaluate({
        subject: { ...subject, mfaSatisfied: false },
        action: 'article:update',
        resource,
        at: AT,
        bindings: [binding()],
        requiresStepUp: true,
      }),
    ).toMatchObject({ effect: 'deny', reason: 'step-up-required' });
  });

  // A challenge is never issued for an operation that would fail anyway.
  it('prefers insufficient-role over step-up-required when the permission is absent', () => {
    expect(
      evaluate({
        subject: { ...subject, mfaSatisfied: false },
        action: 'publish:execute',
        resource,
        at: AT,
        bindings: [binding({ role: 'contributor' })],
        requiresStepUp: true,
      }),
    ).toMatchObject({ reason: 'insufficient-role' });
  });

  it('denies with no-policy as the default', () => {
    expect(
      evaluate({
        subject,
        action: 'article:read',
        at: AT,
        resource: { ...resource, tenantId: OTHER_WS },
        bindings: [binding()],
      }),
    ).toMatchObject({ effect: 'deny', reason: 'no-policy' });
  });
});

describe('project scope', () => {
  it('allows inside the granted scope', () => {
    expect(
      evaluate({
        subject,
        action: 'article:update',
        resource,
        at: AT,
        projectId: 'p1',
        bindings: [binding({ projectScope: ['p1'] })],
      }).effect,
    ).toBe('allow');
  });

  it('denies resource-scope outside it', () => {
    expect(
      evaluate({
        subject,
        action: 'article:update',
        resource,
        at: AT,
        projectId: 'p2',
        bindings: [binding({ projectScope: ['p1'] })],
      }),
    ).toMatchObject({ effect: 'deny', reason: 'resource-scope' });
  });

  it('treats null scope as all projects', () => {
    expect(
      evaluate({
        subject,
        action: 'article:update',
        resource,
        at: AT,
        projectId: 'anything',
        bindings: [binding({ projectScope: null })],
      }).effect,
    ).toBe('allow');
  });

  it('rejects an empty projectScope at write time', () => {
    expect(() => {
      assertValidBinding(binding({ projectScope: [] }));
    }).toThrow(/invalid/);
  });

  it('rejects a tier and workspaceId mismatch', () => {
    expect(() => {
      assertValidBinding(binding({ tier: 'organization', workspaceId: WS }));
    }).toThrow();
    expect(() => {
      assertValidBinding(binding({ tier: 'workspace', workspaceId: null }));
    }).toThrow();
  });

  it('rejects a role that does not belong to its tier', () => {
    expect(() => {
      assertValidBinding(binding({ role: 'org_owner', tier: 'workspace' }));
    }).toThrow(/tier/);
  });
});

describe('expiry is evaluated at decision time', () => {
  it('honours an unexpired binding', () => {
    expect(isBindingActive(binding({ expiresAt: new Date(AT.getTime() + 1000) }), AT)).toBe(true);
  });

  it('rejects an expired binding with no sweep window', () => {
    expect(isBindingActive(binding({ expiresAt: new Date(AT.getTime() - 1) }), AT)).toBe(false);
  });

  it('rejects a revoked binding', () => {
    expect(isBindingActive(binding({ status: 'revoked' }), AT)).toBe(false);
  });

  it('denies once a binding has lapsed', () => {
    expect(
      evaluate({
        subject,
        action: 'article:update',
        resource,
        at: AT,
        bindings: [binding({ expiresAt: new Date(AT.getTime() - 1) })],
      }),
    ).toMatchObject({ effect: 'deny', reason: 'no-membership' });
  });
});

describe('resolvePermissions', () => {
  it('returns a Set — an additive union with no precedence', () => {
    const set = resolvePermissions(
      [binding({ role: 'viewer' }), binding({ role: 'editor' })],
      WS,
      ORG,
      null,
      AT,
    );
    expect(set).toBeInstanceOf(Set);
    expect(set.has('publish:execute')).toBe(true);
  });

  it('ignores bindings for another workspace', () => {
    expect(resolvePermissions([binding({ workspaceId: OTHER_WS })], WS, ORG, null, AT).size).toBe(
      0,
    );
  });
});

describe('service surface', () => {
  it('require throws on denial', () => {
    expect(() => {
      authorizationService.require({
        subject,
        action: 'article:read',
        resource,
        at: AT,
        bindings: [],
      });
    }).toThrow(AuthorizationError);
  });

  it('require does not throw on allow', () => {
    expect(() => {
      authorizationService.require({
        subject,
        action: 'article:read',
        resource,
        at: AT,
        bindings: [binding()],
      });
    }).not.toThrow();
  });

  it('carries a uniform message but a specific reason', () => {
    try {
      authorizationService.require({
        subject,
        action: 'article:read',
        resource,
        at: AT,
        bindings: [],
      });
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as Error).message).toBe('Forbidden');
      expect((error as AuthorizationError).reason).toBe('no-membership');
    }
  });

  it('filter evaluates set-wise', () => {
    const other: ResourceRef = { ...resource, id: 'a2', tenantId: OTHER_WS };
    const allowed = authorizationService.filter(
      { subject, action: 'article:read', at: AT, bindings: [binding()] },
      [resource, other],
    );
    expect(allowed.map((r) => r.id)).toEqual(['a1']);
  });
});

describe('determinism', () => {
  it('produces identical decisions for identical inputs', () => {
    const input = {
      subject,
      action: 'article:update' as const,
      resource,
      at: AT,
      bindings: [binding()],
    };
    expect(evaluate(input)).toEqual(evaluate(input));
  });

  it('is independent of binding order', () => {
    const a = evaluate({
      subject,
      action: 'publish:execute',
      resource,
      at: AT,
      bindings: [binding({ role: 'viewer' }), binding({ role: 'editor' })],
    });
    const b = evaluate({
      subject,
      action: 'publish:execute',
      resource,
      at: AT,
      bindings: [binding({ role: 'editor' }), binding({ role: 'viewer' })],
    });
    expect(a).toEqual(b);
  });
});
