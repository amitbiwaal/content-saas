/**
 * Membership events against the REAL event platform.
 *
 * The claim this suite exists to check is the one that made me deviate from the
 * domain docs' payload tables: they specify `inviteeEmail`, and the FROZEN
 * envelope validator rejects an email-shaped payload value outright. That is
 * asserted here against the real validator rather than taken on trust — if the
 * platform ever permitted it, this test fails and the deviation should be
 * revisited.
 */

import { describe, expect, it } from 'vitest';

import type { DomainEvent } from '@contentos/contracts';
import {
  createEventRegistry,
  validateEnvelope,
  type EventTypeDeclaration,
} from '@contentos/events';
import {
  membershipAccepted,
  membershipInvited,
  membershipRevoked,
  membershipRoleChanged,
  ORGANIZATION_MEMBERSHIP_EVENT_TYPES,
  orgMembershipAccepted,
  orgMembershipInvited,
  orgMembershipRevoked,
  orgMembershipRoleChanged,
  WORKSPACE_MEMBERSHIP_EVENT_TYPES,
} from '@contentos/platform';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000c1';
const MEMBERSHIP = '018f7a1e-0000-7000-8000-0000000000b1';
const USER = '018f7a1e-0000-7000-8000-000000000003';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';
const EXPIRY = '2026-08-13T12:00:00.000Z';

const ctx = {
  eventId: EVENT_ID,
  correlationId: CORRELATION,
  causationId: null,
  occurredAt: '2026-07-30T12:00:00.000Z',
};

const ORGANIZATION_EVENTS: readonly DomainEvent<unknown>[] = [
  orgMembershipInvited(MEMBERSHIP, ctx, {
    organizationId: ORG,
    userId: USER,
    role: 'org_member',
    invitedBy: ACTOR,
    expiresAt: EXPIRY,
  }),
  orgMembershipAccepted(MEMBERSHIP, ctx, {
    organizationId: ORG,
    userId: USER,
    role: 'org_member',
  }),
  orgMembershipRoleChanged(MEMBERSHIP, ctx, {
    organizationId: ORG,
    userId: USER,
    previousRole: 'org_member',
    role: 'org_admin',
    changedBy: ACTOR,
  }),
  orgMembershipRevoked(MEMBERSHIP, ctx, {
    organizationId: ORG,
    userId: USER,
    revokedBy: ACTOR,
  }),
];

const WORKSPACE_EVENTS: readonly DomainEvent<unknown>[] = [
  membershipInvited(MEMBERSHIP, ORG, ctx, {
    workspaceId: WS,
    userId: USER,
    role: 'editor',
    invitedBy: ACTOR,
    expiresAt: EXPIRY,
  }),
  membershipAccepted(MEMBERSHIP, ORG, ctx, { workspaceId: WS, userId: USER, role: 'editor' }),
  membershipRoleChanged(MEMBERSHIP, ORG, ctx, {
    workspaceId: WS,
    userId: USER,
    previousRole: 'viewer',
    role: 'editor',
    changedBy: ACTOR,
  }),
  membershipRevoked(MEMBERSHIP, ORG, ctx, { workspaceId: WS, userId: USER, revokedBy: ACTOR }),
];

describe('membership envelopes satisfy the frozen envelope contract', () => {
  it('validates every organization membership event', () => {
    for (const event of ORGANIZATION_EVENTS) {
      const result = validateEnvelope(event);
      expect(result.ok, `${event.eventType}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('validates every workspace membership event', () => {
    for (const event of WORKSPACE_EVENTS) {
      const result = validateEnvelope(event);
      expect(result.ok, `${event.eventType}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  // THE deviation, checked against the platform rather than asserted.
  it('confirms the platform would reject the documented inviteeEmail payload', () => {
    const withEmail = {
      ...ORGANIZATION_EVENTS[0],
      payload: {
        organizationId: ORG,
        inviteeEmail: 'new.member@example.com',
        role: 'org_member',
        invitedBy: ACTOR,
        expiresAt: EXPIRY,
      },
    } as DomainEvent<unknown>;

    const result = validateEnvelope(withEmail);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((i) => i.code)).toContain('EMAIL_VALUE');
    }
  });

  it('carries the organization as tenant for organization-tier events', () => {
    for (const event of ORGANIZATION_EVENTS) {
      expect(event.tenantId).toBe(ORG);
      expect(event.organizationId).toBe(ORG);
      expect(event.aggregateType).toBe('OrganizationMembership');
    }
  });

  // ADR-017: the workspace IS the tenant.
  it('carries the workspace as tenant for workspace-tier events', () => {
    for (const event of WORKSPACE_EVENTS) {
      expect(event.tenantId).toBe(WS);
      expect(event.organizationId).toBe(ORG);
      expect(event.aggregateType).toBe('WorkspaceMembership');
    }
  });

  // The membership is the aggregate, so one person's sequence stays ordered.
  it('partitions on the membership at both tiers', () => {
    for (const event of [...ORGANIZATION_EVENTS, ...WORKSPACE_EVENTS]) {
      expect(event.aggregateId).toBe(MEMBERSHIP);
      expect(event.producer).toBe('platform.memberships');
    }
  });
});

describe('the registry can declare every membership event type', () => {
  const DECLARATIONS: readonly EventTypeDeclaration[] = [
    ...ORGANIZATION_MEMBERSHIP_EVENT_TYPES.map((eventType) => ({
      eventType,
      version: 1,
      state: 'active' as const,
      producer: 'platform.memberships',
      tenantScope: 'organization' as const,
      stream: 'organization',
      consumers: [],
    })),
    ...WORKSPACE_MEMBERSHIP_EVENT_TYPES.map((eventType) => ({
      eventType,
      version: 1,
      state: 'active' as const,
      producer: 'platform.memberships',
      tenantScope: 'workspace' as const,
      stream: 'workspace',
      consumers: [],
    })),
  ];

  it('registers all eight types', () => {
    const registry = createEventRegistry([...DECLARATIONS]);
    for (const event of [...ORGANIZATION_EVENTS, ...WORKSPACE_EVENTS]) {
      expect(registry.isRegistered(event.eventType, 1), event.eventType).toBe(true);
      expect(registry.validate(event).ok, event.eventType).toBe(true);
    }
  });

  it('refuses an unregistered membership type', () => {
    const registry = createEventRegistry([]);
    const first = ORGANIZATION_EVENTS[0];
    expect(first).toBeDefined();
    const result = registry.validate(first!);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UnknownEventType');
  });
});
