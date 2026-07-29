/**
 * Layer direction enforcement.
 *
 * Configured from `07-development-guide/project-structure.md` §"Import
 * direction". Imports flow downward only; every reverse arrow is a build
 * failure (rule 2).
 *
 *   apps/  →  services/ · workers/  →  feature  →  core  →  contracts
 *
 * All rules are `error`. A boundary rule enforced by a warning erodes at
 * exactly the rate people are busy (`repository-structure.md` rule 7).
 */

const FEATURE = 'packages/(content|knowledge|ai|platform|storage|events)';
const CORE = 'packages/(security|database|domain|integrations|observability)';

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Cycles make layering unverifiable and break incremental builds.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'contracts-has-zero-deps',
      severity: 'error',
      comment:
        'packages/contracts may import NOTHING. project-structure.md rule 3 — one dependency ' +
        'on database would pull Drizzle into the browser bundle.',
      from: { path: '^packages/contracts/' },
      to: {
        pathNot: ['^packages/contracts/', 'node_modules'],
      },
    },
    {
      name: 'core-never-imports-feature',
      severity: 'error',
      comment:
        'A security control depending on a domain engine inverts the layering that makes it ' +
        'universally applicable (rule 5).',
      from: { path: `^${CORE}/` },
      to: { path: `^${FEATURE}/` },
    },
    {
      name: 'feature-never-imports-apps-or-services',
      severity: 'error',
      from: { path: `^${FEATURE}/` },
      to: { path: '^(apps|services|workers)/' },
    },
    {
      name: 'services-never-import-apps',
      severity: 'error',
      from: { path: '^(services|workers)/' },
      to: { path: '^apps/' },
    },
    {
      name: 'apps-never-import-each-other',
      severity: 'error',
      from: { path: '^apps/([^/]+)/' },
      to: { path: '^apps/', pathNot: '^apps/$1/' },
    },
    {
      name: 'feature-packages-communicate-via-contracts',
      severity: 'error',
      comment:
        'Feature packages do not import each other internals — the code expression of "no ' +
        'engine may call another engine database" (rule 4).',
      from: { path: `^${FEATURE}/` },
      to: {
        path: `^${FEATURE}/`,
        pathNot: [
          '^packages/(content|knowledge|ai|platform|storage|events)/src/index\\.ts$',
          // same-package imports are fine; handled by the more specific rules above
        ],
      },
    },
    {
      name: 'no-deep-package-imports',
      severity: 'error',
      comment: 'index.ts is the only barrel (rule 6).',
      from: {},
      to: { path: '^packages/[^/]+/src/(?!index\\.ts$).*', pathNot: '^packages/[^/]+/src/' },
    },
    {
      name: 'not-to-unresolvable',
      severity: 'error',
      from: {},
      to: { couldNotResolve: true },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(\\.test\\.ts$|/dist/|^backend/|^frontend/|^archive/)' },
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types'],
    },
  },
};
