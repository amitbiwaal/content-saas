import { describe, expect, it } from 'vitest';

import { createRoutingTable, RoutingTableError } from './policy.js';

describe('building a routing table', () => {
  it('records the version every decision will carry', () => {
    const table = createRoutingTable({
      version: 'routing-2026-07',
      global: { providerId: 'openai' },
    });
    expect(table.version).toBe('routing-2026-07');
  });

  it('requires a version, because a decision must stay reproducible', () => {
    // Rule 4: "Every decision records `policyVersion`, making any historical
    // call reproducible." A table without one produces decisions nobody can
    // explain after it changes.
    expect(() => createRoutingTable({ version: '  ', global: { providerId: 'openai' } })).toThrow(
      RoutingTableError,
    );
  });

  it('trims the version rather than treating whitespace as a different one', () => {
    expect(createRoutingTable({ version: ' v1 ' }).version).toBe('v1');
  });

  it('allows no global default at all, which selects by capability', () => {
    expect(createRoutingTable({ version: 'v1' }).global).toBeNull();
  });

  it('refuses a preference with no provider', () => {
    expect(() => createRoutingTable({ version: 'v1', global: { providerId: '' } })).toThrow(
      /needs a providerId/,
    );
    expect(() =>
      createRoutingTable({ version: 'v1', workspaces: { 'ws-1': { providerId: '  ' } } }),
    ).toThrow(/workspace 'ws-1'/);
    expect(() =>
      createRoutingTable({ version: 'v1', organizations: { 'org-1': { providerId: '' } } }),
    ).toThrow(/organization 'org-1'/);
  });

  it('refuses an empty model pin rather than reading it as absent', () => {
    expect(() =>
      createRoutingTable({ version: 'v1', global: { providerId: 'openai', model: '  ' } }),
    ).toThrow(/omit it/);
  });
});

describe('looking a preference up', () => {
  const table = createRoutingTable({
    version: 'v1',
    global: { providerId: 'openai' },
    organizations: { 'org-1': { providerId: 'anthropic' } },
    workspaces: { 'ws-1': { providerId: 'google', model: 'writing.fast' } },
  });

  it('finds a workspace preference', () => {
    expect(table.forWorkspace('ws-1')).toEqual({ providerId: 'google', model: 'writing.fast' });
  });

  it('finds an organization preference', () => {
    expect(table.forOrganization('org-1')).toEqual({ providerId: 'anthropic' });
  });

  it('returns null for an id it has no entry for', () => {
    expect(table.forWorkspace('ws-9')).toBeNull();
    expect(table.forOrganization('org-9')).toBeNull();
  });

  it('is frozen, so a table cannot change under a running process', () => {
    // Two identical requests routing differently for reasons no trace explains
    // is the exact non-determinism `model-router.md` forbids.
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.global)).toBe(true);
    expect(() => {
      (table as unknown as { version: string }).version = 'v2';
    }).toThrow(TypeError);
  });

  it('does not alias the options object it was built from', () => {
    const workspaces = { 'ws-2': { providerId: 'openai' } };
    const built = createRoutingTable({ version: 'v1', workspaces });
    // Editing the source afterwards must not change the table.
    (workspaces as Record<string, { providerId: string }>)['ws-3'] = { providerId: 'evil' };
    expect(built.forWorkspace('ws-3')).toBeNull();
  });
});
