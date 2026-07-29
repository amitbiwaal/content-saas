#!/usr/bin/env node
/**
 * Licence gate — `07-development-guide/dependency-management.md`.
 *
 * Reads `licences.json` (produced by `pnpm licenses list --json`) and fails the
 * build on any strong-copyleft licence in code we distribute, or any dependency
 * whose licence could not be determined.
 *
 * Exit 0 = clean. Exit 1 = blocked. The gate blocks; it never warns.
 */

import { readFile } from 'node:fs/promises';

const DENIED = [/^AGPL/i, /^GPL-[23]/i, /^SSPL/i, /^BUSL/i, /^CC-BY-NC/i, /^Commons-Clause/i];
const UNKNOWN = ['UNKNOWN', 'UNLICENSED', '', null, undefined];

const raw = await readFile(new URL('../../licences.json', import.meta.url), 'utf8');
/** @type {Record<string, Array<{ name: string; versions?: string[] }>>} */
const byLicence = JSON.parse(raw);

const violations = [];
const unknown = [];

for (const [licence, packages] of Object.entries(byLicence)) {
  const names = packages.map((p) => `${p.name}@${(p.versions ?? []).join(',')}`);
  if (UNKNOWN.includes(licence)) {
    unknown.push(...names);
    continue;
  }
  if (DENIED.some((pattern) => pattern.test(licence))) {
    violations.push(...names.map((n) => `${n} — ${licence}`));
  }
}

if (violations.length > 0) {
  console.error('Denied licences found:');
  for (const v of violations) console.error(`  ${v}`);
}
if (unknown.length > 0) {
  console.error('Undeterminable licences (treated as blocking):');
  for (const u of unknown) console.error(`  ${u}`);
}

if (violations.length > 0 || unknown.length > 0) {
  process.exit(1);
}

console.log(`Licence gate clean — ${Object.keys(byLicence).length} distinct licences.`);
