import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Workspace packages resolve to their SOURCE barrel during tests.
 *
 * Two reasons. Tests must not depend on build order — a stale `dist` would let
 * a suite pass against code that no longer exists. And `tests/` is not a
 * workspace package, so it has no node_modules link to resolve through.
 *
 * Each alias points at `src/index.ts`, the public barrel, so the
 * public-surface discipline still holds: a deep import fails here exactly as it
 * would in production.
 */
const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

// Coverage thresholds are owned by `10-testing/testing-strategy.md` §9 and
// applied here to the packages under their FROZEN names
// (`repository-structure.md` §"Naming reconciliation carried forward"):
//   packages/db      → packages/database
//   packages/engines → packages/content
// ≥ 85% lines in the engine and contracts packages, ≥ 70% elsewhere,
// no threshold on apps/web.

export default defineConfig({
  resolve: {
    alias: {
      '@contentos/contracts': pkg('contracts'),
      '@contentos/observability': pkg('observability'),
      '@contentos/database': pkg('database'),
      '@contentos/events': pkg('events'),
      '@contentos/security': pkg('security'),
    },
  },
  test: {
    // `tests/` is included so the conformance suites are COLLECTED. Without it
    // the RLS suite was silently never run — and a skipped isolation test that
    // nobody notices is worse than a missing one.
    include: ['{apps,services,workers,packages}/**/*.test.ts', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'backend/**', 'frontend/**', 'archive/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['{services,workers,packages}/**/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**', 'apps/web/**'],
      thresholds: {
        lines: 70,
        'packages/contracts/**': { lines: 85 },
        'packages/content/**': { lines: 85 },
      },
    },
  },
});
