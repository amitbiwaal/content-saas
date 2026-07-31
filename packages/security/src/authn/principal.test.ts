import { describe, expect, it } from 'vitest';

import {
  AUTHENTICATION_FAILURES,
  AUTHORIZATION_DENIALS,
  freezeAuthContext,
  freezePrincipal,
  holds,
  subjectOf,
  type AuthContext,
  type Principal,
} from './principal.js';

const principal = (overrides: Partial<Principal> = {}): Principal => ({
  subjectId: 'user-1',
  kind: 'user',
  method: 'password',
  organizationId: 'org-1',
  workspaceId: 'ws-1',
  roles: ['editor'],
  permissions: ['article:execute', 'run:read'],
  authenticatedAt: new Date('2026-07-31T12:00:00.000Z'),
  mfaSatisfied: true,
  sessionId: 'session-1',
  ...overrides,
});

const context = (): AuthContext => ({
  requestId: 'req-1',
  correlationId: 'corr-1',
  principal: principal(),
  organization: { id: 'org-1', status: 'active' },
  workspace: { id: 'ws-1', status: 'active' },
});

describe('an immutable principal', () => {
  it('is frozen, and so is everything inside it', () => {
    const frozen = freezePrincipal(principal());

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.roles)).toBe(true);
    expect(Object.isFrozen(frozen.permissions)).toBe(true);
    expect(Object.isFrozen(frozen.authenticatedAt)).toBe(true);
  });

  it('refuses a write, rather than accepting one that a cast made legal', () => {
    // `readonly` is a compile-time promise a cast erases. A component that
    // tried to widen its own authority must fail, not succeed silently.
    const frozen = freezePrincipal(principal());
    const mutable = frozen as unknown as { subjectId: string; permissions: string[] };

    expect(() => {
      mutable.subjectId = 'someone-else';
    }).toThrow(TypeError);
    expect(() => {
      mutable.permissions.push('organization:delete');
    }).toThrow(TypeError);
    expect(frozen.subjectId).toBe('user-1');
    expect(frozen.permissions).toEqual(['article:execute', 'run:read']);
  });
});

describe('an immutable auth context', () => {
  it('freezes the context and the principal it carries', () => {
    const frozen = freezeAuthContext(context());

    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(frozen.principal)).toBe(true);
    expect(Object.isFrozen(frozen.principal.permissions)).toBe(true);
    expect(Object.isFrozen(frozen.organization)).toBe(true);
    expect(Object.isFrozen(frozen.workspace)).toBe(true);
  });

  it('refuses a downstream component retargeting the workspace', () => {
    const frozen = freezeAuthContext(context());
    const mutable = frozen as unknown as { workspace: { id: string } };

    expect(() => {
      mutable.workspace = { id: 'another-tenant' };
    }).toThrow(TypeError);
    expect(frozen.workspace.id).toBe('ws-1');
  });
});

describe('the subject a principal projects', () => {
  it('carries the proof of identity and nothing about authority', () => {
    const subject = subjectOf(principal());

    expect(subject).toEqual({
      subjectId: 'user-1',
      kind: 'user',
      authenticatedAt: new Date('2026-07-31T12:00:00.000Z'),
      method: 'password',
      mfaSatisfied: true,
      sessionId: 'session-1',
    });
    expect(subject).not.toHaveProperty('roles');
    expect(subject).not.toHaveProperty('permissions');
    expect(subject).not.toHaveProperty('workspaceId');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(subjectOf(principal()))).toBe(true);
  });
});

describe('holding a permission', () => {
  it('reads the resolved set, and only that', () => {
    const resolved = principal();
    expect(holds(resolved, 'article:execute')).toBe(true);
    expect(holds(resolved, 'organization:delete')).toBe(false);
  });

  it('grants nothing from a role that was not resolved into a permission', () => {
    // The set is what `resolvePermissions` produced. A role name alone grants
    // nothing here, which is what stops two places deciding what a role means.
    const roleOnly = principal({ roles: ['org_owner'], permissions: [] });
    expect(holds(roleOnly, 'organization:delete')).toBe(false);
  });
});

describe('the failure vocabularies', () => {
  it('has no duplicates in either', () => {
    expect(new Set(AUTHENTICATION_FAILURES).size).toBe(AUTHENTICATION_FAILURES.length);
    expect(new Set(AUTHORIZATION_DENIALS).size).toBe(AUTHORIZATION_DENIALS.length);
  });

  it('keeps authentication reasons coarse, so none is an enumeration oracle', () => {
    // Six reasons, none of which distinguishes "no such user" from "wrong
    // password" — that is the property, not the count.
    expect([...AUTHENTICATION_FAILURES]).toEqual([
      'missing',
      'malformed',
      'invalid',
      'expired',
      'not-yet-valid',
      'revoked',
    ]);
  });

  it('names no tenant, resource or account in any denial', () => {
    for (const denial of AUTHORIZATION_DENIALS) {
      expect(denial, denial).toMatch(/^[a-z-]+$/);
    }
  });
});
