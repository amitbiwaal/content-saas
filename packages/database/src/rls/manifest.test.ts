/**
 * The RLS exception manifest.
 *
 * Two kinds of assertion here, and both matter:
 *
 *   The identity class is compared against a SECOND, independent statement of
 *   the five table names. A test whose expectation is derived from the thing it
 *   tests asserts nothing, and "changing this class must fail verification"
 *   only holds if the expected value is written down separately.
 *
 *   The generated JSON artifact is compared against the module. The shell gate
 *   reads the artifact, so a drift between the two is a gate verifying a
 *   manifest nobody edited.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ALL_EXCEPTION_TABLES,
  EXCEPTION_JUSTIFICATIONS,
  IDENTITY_EXCEPTION_TABLES,
  isExceptionTable,
  REFERENCE_DATA_EXCEPTION_TABLES,
} from './exceptions.js';
import {
  assertionsOfSurface,
  exceptionEntry,
  exceptionsOfClass,
  exceptionTables,
  RLS_ASSERTIONS,
  RLS_EXCEPTION_MANIFEST,
  rlsManifestDocument,
} from './manifest.js';

/**
 * The five, written out independently of the manifest.
 *
 * `16-security/row-level-security.md` §"The exception set — exactly five
 * tables". Editing the manifest without editing this fails, which is the point.
 */
const CANONICAL_IDENTITY_TABLES = [
  'users',
  'organizations',
  'organization_memberships',
  'verified_domains',
  'sso_configurations',
];

describe('the identity class is closed at exactly five', () => {
  it('contains precisely the five canonical tables, by name', () => {
    expect([...IDENTITY_EXCEPTION_TABLES].sort()).toEqual([...CANONICAL_IDENTITY_TABLES].sort());
  });

  it('has five members — no additions', () => {
    expect(IDENTITY_EXCEPTION_TABLES).toHaveLength(5);
    expect(exceptionsOfClass('identity')).toHaveLength(5);
  });

  it('classifies every one of them as identity', () => {
    for (const table of CANONICAL_IDENTITY_TABLES) {
      expect(exceptionEntry(table)?.class, table).toBe('identity');
    }
  });

  // A sixth requires an ADR; the gate is what makes that more than a comment.
  it('admits no table outside the canonical five', () => {
    for (const entry of exceptionsOfClass('identity')) {
      expect(CANONICAL_IDENTITY_TABLES, entry.table).toContain(entry.table);
    }
  });
});

describe('the reference-data class — ADR-025', () => {
  // Accepted but unpopulated: this increment builds verification, not tables.
  it('is currently empty', () => {
    expect(REFERENCE_DATA_EXCEPTION_TABLES).toEqual([]);
    expect(exceptionsOfClass('reference-data')).toEqual([]);
  });

  it('leaves the whole manifest equal to the identity class for now', () => {
    expect([...ALL_EXCEPTION_TABLES].sort()).toEqual([...CANONICAL_IDENTITY_TABLES].sort());
  });
});

describe('every exception is justified', () => {
  it('carries a non-empty written reason', () => {
    for (const entry of RLS_EXCEPTION_MANIFEST) {
      expect(entry.justification.trim(), entry.table).not.toBe('');
    }
  });

  it('exposes the same reasons through the derived lookup', () => {
    for (const entry of RLS_EXCEPTION_MANIFEST) {
      expect(EXCEPTION_JUSTIFICATIONS[entry.table]).toBe(entry.justification);
    }
    expect(Object.keys(EXCEPTION_JUSTIFICATIONS)).toHaveLength(RLS_EXCEPTION_MANIFEST.length);
  });
});

describe('derived views agree with the manifest', () => {
  // The whole reason exceptions.ts was rewritten: two lists of the same thing
  // is how a table gets added to one and not the other.
  it('derives every list from the one source', () => {
    expect(exceptionTables()).toEqual(RLS_EXCEPTION_MANIFEST.map((e) => e.table));
    expect(ALL_EXCEPTION_TABLES).toEqual(exceptionTables());
    expect([...IDENTITY_EXCEPTION_TABLES, ...REFERENCE_DATA_EXCEPTION_TABLES].sort()).toEqual(
      [...ALL_EXCEPTION_TABLES].sort(),
    );
  });

  it('recognises a manifest table and nothing else', () => {
    for (const table of ALL_EXCEPTION_TABLES) expect(isExceptionTable(table)).toBe(true);
    expect(isExceptionTable('workspaces')).toBe(false);
    expect(isExceptionTable('flags')).toBe(false);
  });

  it('returns undefined for a table nobody excepted', () => {
    expect(exceptionEntry('workspaces')).toBeUndefined();
  });
});

describe('the assertion catalogue', () => {
  it('names every assertion uniquely', () => {
    const names = RLS_ASSERTIONS.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('describes every assertion', () => {
    for (const spec of RLS_ASSERTIONS) {
      expect(spec.description.trim(), spec.name).not.toBe('');
      expect(['catalog', 'behavioural'], spec.name).toContain(spec.surface);
    }
  });

  it('declares the checks ADR-025 requires of reference data', () => {
    const names = RLS_ASSERTIONS.map((a) => a.name);
    expect(names).toContain('reference-data-no-tenant-id');
    expect(names).toContain('reference-data-readable');
    expect(names).toContain('reference-data-read-only');
    expect(names).toContain('exception-justified');
    expect(names).toContain('identity-class-exact');
  });

  // Only a live connection as the application role can observe isolation
  // rather than configuration.
  it('separates catalogue assertions from behavioural ones', () => {
    expect(assertionsOfSurface('behavioural').map((a) => a.name)).toEqual([
      'no-context-zero-rows',
      'cross-tenant-read-blocked',
      'own-tenant-read-permitted',
      'cross-tenant-write-rejected',
    ]);
    expect(assertionsOfSurface('catalog').length).toBeGreaterThan(10);
  });
});

describe('the generated artifact the shell gate reads', () => {
  const artifact = JSON.parse(
    readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        '..',
        'scripts',
        'db',
        'rls-manifest.generated.json',
      ),
      'utf8',
    ),
  ) as ReturnType<typeof rlsManifestDocument>;

  // The shell gate reads the artifact, so drift means it verifies a manifest
  // nobody edited. Regenerate with: node scripts/db/generate-rls-manifest.mjs
  it('matches the module exactly', () => {
    expect(artifact).toEqual(rlsManifestDocument());
  });

  it('carries every exception with its class and justification', () => {
    expect(artifact.exceptions).toEqual(RLS_EXCEPTION_MANIFEST);
  });

  // A short catalogue would give a gate that checks less than it reports.
  it('carries every assertion the gate must implement', () => {
    expect(artifact.assertions).toEqual(RLS_ASSERTIONS);
    expect(artifact.assertions.length).toBe(RLS_ASSERTIONS.length);
  });
});
