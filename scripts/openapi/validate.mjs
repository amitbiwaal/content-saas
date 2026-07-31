/**
 * Emit and validate the OpenAPI document.
 *
 * Runs against the BUILT package rather than the sources, so what is checked is
 * what would actually ship. A specification generated from code that failed to
 * compile is not a specification anyone can rely on.
 *
 * The document is written beside the build so a reviewer, a linter, or an
 * external validator can be pointed at a file rather than at a test. `dist/` is
 * gitignored, so the artefact is produced on demand and never committed —
 * a committed specification is one that drifts from the code the moment
 * somebody forgets to regenerate it.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const built = pathToFileURL(resolve(root, 'services/api/dist/index.js')).href;

const {
  createOpenApiDocument,
  createVersionRegistry,
  serializeOpenApiDocument,
  validateOpenApiDocument,
} = await import(built);

/**
 * The versions this deployment serves.
 *
 * v1 only, and current. When a v2 ships this list grows and the v1 entry gains
 * its deprecation schedule — the registry refuses one without a sunset date and
 * a migration guide, so the schedule cannot be half-announced.
 */
const registry = createVersionRegistry({
  versions: [{ version: 'v1', status: 'current', releasedAt: '2026-01-01T00:00:00.000Z' }],
});

const document = createOpenApiDocument({
  registry,
  serviceVersion: process.env.SERVICE_VERSION ?? '2.0.0',
});

const result = validateOpenApiDocument(document);

if (!result.ok) {
  console.error('OpenAPI validation FAILED:\n');
  for (const issue of result.issues) {
    console.error(`  ${issue.at || '(document)'} — ${issue.problem}`);
  }
  process.exit(1);
}

const output = resolve(root, 'services/api/dist/openapi.json');
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${serializeOpenApiDocument(document)}\n`, 'utf8');

const operations = Object.values(document.paths).reduce(
  (total, item) => total + Object.keys(item).length,
  0,
);

console.log(`OpenAPI ${document.openapi} — valid.`);
console.log(
  `  ${String(Object.keys(document.paths).length)} paths, ${String(operations)} operations`,
);
console.log(`  ${String(Object.keys(document.components.schemas).length)} schemas`);
console.log(
  `  ${String(Object.keys(document.components.responses).length)} shared error responses`,
);
console.log(`  written to ${output}`);
