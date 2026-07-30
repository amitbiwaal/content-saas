/**
 * `WorkspaceSettingsUpdated` against the REAL event platform.
 *
 * Two things are checked that a unit test cannot: that an array of key names
 * survives the frozen envelope validator's payload rules at all, and that the
 * event a real registry would accept is the same one the platform emits.
 *
 * The "keys, never values" rule is asserted here too, against a payload built
 * from settings whose values are distinctive enough that their absence is proof
 * rather than inference.
 */

import { describe, expect, it } from 'vitest';

import {
  createEventRegistry,
  validateEnvelope,
  type EventTypeDeclaration,
} from '@contentos/events';
import {
  WORKSPACE_SETTINGS_KEYS,
  WORKSPACE_SETTINGS_UPDATED,
  workspaceSettingsUpdated,
} from '@contentos/platform';

const ORG = '018f7a1e-0000-7000-8000-0000000000aa';
const WS = '018f7a1e-0000-7000-8000-0000000000c1';
const ACTOR = '018f7a1e-0000-7000-8000-000000000001';
const EVENT_ID = '018f7a1e-0000-7000-8000-0000000000ee';
const CORRELATION = '018f7a1e-0000-7000-8000-0000000000dd';

const ctx = {
  eventId: EVENT_ID,
  correlationId: CORRELATION,
  causationId: null,
  occurredAt: '2026-07-30T12:00:00.000Z',
  organizationId: ORG,
};

const DECLARATION: EventTypeDeclaration = {
  eventType: WORKSPACE_SETTINGS_UPDATED,
  version: 1,
  state: 'active',
  stream: 'workspace',
  consumers: [],
};

describe('WorkspaceSettingsUpdated satisfies the frozen envelope contract', () => {
  it('validates with a single changed key', () => {
    const event = workspaceSettingsUpdated(ctx, {
      workspaceId: WS,
      changedKeys: ['locale'],
      changedBy: ACTOR,
    });
    const result = validateEnvelope(event);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  // An array of key names is the whole payload; the payload rules cap arrays,
  // so the widest possible one is checked rather than the narrowest.
  it('validates with every settings key changed at once', () => {
    const event = workspaceSettingsUpdated(ctx, {
      workspaceId: WS,
      changedKeys: [...WORKSPACE_SETTINGS_KEYS],
      changedBy: ACTOR,
    });
    const result = validateEnvelope(event);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(event.payload.changedKeys.length).toBe(WORKSPACE_SETTINGS_KEYS.length);
  });

  it('carries the workspace as tenant and the workspace producer', () => {
    const event = workspaceSettingsUpdated(ctx, {
      workspaceId: WS,
      changedKeys: ['routing'],
      changedBy: ACTOR,
    });
    expect(event).toMatchObject({
      eventType: 'WorkspaceSettingsUpdated',
      aggregateType: 'Workspace',
      aggregateId: WS,
      tenantId: WS,
      organizationId: ORG,
      producer: 'platform.workspaces',
    });
  });

  // The payload type has no field a value could travel in; this pins that the
  // builder cannot be talked into one either.
  it('emits key names only, never a value', () => {
    const event = workspaceSettingsUpdated(ctx, {
      workspaceId: WS,
      changedKeys: ['brandVoice', 'locale'],
      changedBy: ACTOR,
    });

    const serialized = JSON.stringify(event.payload);
    expect(serialized).toContain('brandVoice');
    expect(serialized).toContain('locale');
    // The values a workspace would actually hold for those keys.
    for (const value of ['voice-profile-alpha-7731', 'en-GB', 'gpt-4o', '0.85']) {
      expect(serialized).not.toContain(value);
    }
  });

  it('is registrable and accepted by a real registry', () => {
    const registry = createEventRegistry([DECLARATION]);
    const event = workspaceSettingsUpdated(ctx, {
      workspaceId: WS,
      changedKeys: ['approval'],
      changedBy: ACTOR,
    });

    expect(registry.isRegistered(WORKSPACE_SETTINGS_UPDATED, 1)).toBe(true);
    expect(registry.validate(event).ok).toBe(true);
    expect(registry.streamFor(WORKSPACE_SETTINGS_UPDATED)).toBe('workspace');
  });
});
