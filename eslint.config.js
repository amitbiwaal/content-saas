// Banned imports, configured VERBATIM from
// `07-development-guide/project-structure.md` §"Banned imports".
//
// These are the boundaries where a violation is an architectural breach, not a
// style issue. All are errors — never warnings (repository-structure.md rule 7).
//
// The SafeUrlFetcher and provider-SDK restrictions are configured in Sprint 0
// even though no such code exists yet: adding the rule after the first `fetch`
// lands means auditing every call site.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/** Each entry: the banned specifier, and the ONLY place it may appear. */
const BANNED_IMPORTS = [
  {
    group: ['@aws-sdk/*', '@aws-sdk/client-s3', 'aws-sdk'],
    permittedIn: 'packages/storage/src/drivers/',
    message:
      'S3/R2 SDKs are permitted only in packages/storage/src/drivers/** — 12-storage-platform/storage-abstraction.md',
  },
  {
    group: ['openai', '@anthropic-ai/*', '@google/generative-ai', 'openrouter*', 'cohere-ai'],
    permittedIn: 'packages/ai/src/providers/',
    message:
      'Model provider SDKs are permitted only in packages/ai/src/providers/** — only the AI Gateway calls models (ADR-019)',
  },
  {
    group: ['dataforseo*', 'firecrawl*', 'exa-js', '@exa/*'],
    permittedIn: 'packages/integrations/',
    message:
      'Research provider clients are permitted only in packages/integrations/** — Provider Layer boundary',
  },
  {
    group: ['stripe', '@stripe/*'],
    permittedIn: 'packages/platform/src/billing/',
    message:
      'The Stripe SDK is permitted only in packages/platform/src/billing/** — billing owns payment',
  },
  {
    group: ['drizzle-orm', 'drizzle-orm/*', 'drizzle-kit'],
    permittedIn: 'packages/database/',
    message: 'drizzle-orm is permitted only in packages/database/** — one schema owner (ADR-022)',
  },
  {
    group: ['ioredis', 'redis'],
    permittedIn: 'packages/platform/src/cache/|packages/events/',
    message:
      'Raw Redis is permitted only in packages/platform/src/cache/** and packages/events/** — an unprefixed key is cross-tenant shared state that never touches RLS',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      'backend/**',
      'frontend/**',
      'archive/**',
      'contentos-docs/**',
      'apps/web/**', // Next.js owns its own lint configuration
      'scripts/**', // plain .mjs tooling, not part of a TS project
      '*.config.js',
      '.dependency-cruiser.cjs',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      // A single project covering every linted file, INCLUDING tests — the
      // per-package tsconfigs exclude `*.test.ts` because tests are not shipped.
      parserOptions: {
        project: ['./tsconfig.eslint.json'],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Custom rules mandated by repository-structure.md §"Boundary enforcement".
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',

      // A leading underscore marks a parameter that exists for INTERFACE
      // CONFORMANCE — the signature is fixed by a port, and the implementation
      // does not need the value. Removing it would change the arity; renaming
      // it would hide why it is there.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // No cross-package relative imports — use the package's public surface.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['../../*/src/*', '../../../*'],
              message:
                'No cross-package relative imports. Import the package by name; index.ts is the only barrel (coding-standards.md).',
            },
          ],
        },
      ],
    },
  },

  // Banned provider SDKs — one config block per entry, applied everywhere the
  // import is NOT permitted.
  ...BANNED_IMPORTS.map((entry) => ({
    files: ['**/*.ts', '**/*.tsx'],
    ignores: entry.permittedIn.split('|').map((p) => `${p}**`),
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: entry.group, message: entry.message }] },
      ],
    },
  })),

  // SSRF chokepoint — raw fetch to customer-supplied URLs goes through
  // SafeUrlFetcher only (16-security/api-security.md).
  {
    files: ['**/*.ts'],
    ignores: ['packages/integrations/src/safe-fetch/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'fetch',
          message:
            'Customer-supplied URLs are fetched only through SafeUrlFetcher (packages/integrations/src/safe-fetch/**). A single audited chokepoint is what makes the SSRF controls verifiable — 16-security/api-security.md.',
        },
      ],
    },
  },

  // Tests may use loose typing helpers the strict config forbids.
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
