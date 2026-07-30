#!/usr/bin/env node
/**
 * Emit the RLS manifest as JSON for the shell gate.
 *
 * The authoritative manifest is `packages/database/src/rls/manifest.ts`. The
 * live verifier is plain Node and cannot import TypeScript, so it reads this
 * artifact instead.
 *
 * THE ARTIFACT IS GENERATED, NEVER EDITED. A unit test parses it and compares
 * it against the TypeScript module, so the two cannot drift: change the source
 * without regenerating and the suite goes red.
 *
 * Extraction is a parse of the source rather than an import, because importing
 * would require a TypeScript loader in a script that has to run before anything
 * is built. The parse is deliberately strict — anything it cannot read with
 * certainty is an error, never a silent omission.
 *
 * Usage: node scripts/db/generate-rls-manifest.mjs [--check]
 *   --check  exit non-zero if the committed artifact is out of date
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = join(root, 'packages', 'database', 'src', 'rls', 'manifest.ts');
export const ARTIFACT = join(root, 'scripts', 'db', 'rls-manifest.generated.json');

/**
 * A single- or double-quoted TypeScript string literal.
 *
 * Both, because a description containing an apostrophe is written with double
 * quotes and a single-quote-only pattern skips it SILENTLY — producing an
 * artifact that is short by one assertion and a gate that checks one thing
 * fewer than it reports. The drift test is what ultimately guarantees this is
 * complete; the pattern being permissive is what stops it failing routinely.
 */
const STR = String.raw`(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")`;

/** Whichever alternative matched, with escapes resolved. */
function text(a, b) {
  const raw = a ?? b ?? '';
  return raw.replace(/\\(['"\\])/g, '$1');
}

function parseObjects(source, fields) {
  const pattern = fields.map((f) => String.raw`${f}:\s*${STR}`).join(String.raw`,\s*`);
  const re = new RegExp(String.raw`\{\s*${pattern},?\s*\}`, 'g');
  return [...source.matchAll(re)].map((m) => {
    const values = [];
    for (let i = 1; i < m.length; i += 2) values.push(text(m[i], m[i + 1]));
    return values;
  });
}

/** Every `{ table, class, justification }` literal, in source order. */
function parseExceptions(source) {
  return parseObjects(source, ['table', 'class', 'justification']).map(
    ([table, cls, justification]) => ({ table, class: cls, justification }),
  );
}

/** Every `{ name, surface, description }` literal, in source order. */
function parseAssertions(source) {
  return parseObjects(source, ['name', 'surface', 'description']).map(
    ([name, surface, description]) => ({ name, surface, description }),
  );
}

export function buildManifest() {
  const source = readFileSync(SOURCE, 'utf8');
  const assertions = parseAssertions(source);
  const exceptions = parseExceptions(source);

  // An empty assertion list would produce a gate that checks nothing and
  // reports success, which is the one outcome worse than a failing gate.
  if (assertions.length === 0) {
    throw new Error(`No assertions parsed from ${SOURCE}. Refusing to emit an empty catalogue.`);
  }
  for (const entry of exceptions) {
    if (entry.justification.trim() === '') {
      throw new Error(`Exception '${entry.table}' has no justification.`);
    }
  }
  return { exceptions, assertions };
}

function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

const manifest = buildManifest();
const rendered = serialize(manifest);

if (process.argv.includes('--check')) {
  let committed = '';
  try {
    committed = readFileSync(ARTIFACT, 'utf8');
  } catch {
    console.error(`Missing ${ARTIFACT}. Run: node scripts/db/generate-rls-manifest.mjs`);
    process.exit(1);
  }
  if (committed !== rendered) {
    console.error(`${ARTIFACT} is out of date. Run: node scripts/db/generate-rls-manifest.mjs`);
    process.exit(1);
  }
  console.log(
    `rls manifest artifact is current (${String(manifest.exceptions.length)} exceptions, ${String(manifest.assertions.length)} assertions)`,
  );
} else {
  writeFileSync(ARTIFACT, rendered, 'utf8');
  console.log(
    `wrote ${ARTIFACT} (${String(manifest.exceptions.length)} exceptions, ${String(manifest.assertions.length)} assertions)`,
  );
}
