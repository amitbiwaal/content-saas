#!/usr/bin/env node
/**
 * Cross-platform script dispatcher.
 *
 * The repository ships each developer script twice — `.sh` for POSIX and `.ps1`
 * for Windows — because the team runs both. This picks the right one so
 * `package.json` holds ONE command per task rather than a platform fork in
 * every script entry.
 *
 * Usage: node scripts/dev/run.mjs <task>
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

/** task → path relative to the repository root, without extension. */
const TASKS = {
  bootstrap: 'scripts/dev/bootstrap',
  start: 'scripts/dev/start',
  stop: 'scripts/dev/stop',
  migrate: 'scripts/db/migrate',
  reset: 'scripts/db/reset',
  seed: 'scripts/db/seed',
  'verify-rls': 'scripts/db/verify-rls',
  'verify-ledger': 'scripts/db/verify-ledger',
};

const task = process.argv[2];
const base = TASKS[task];

if (base === undefined) {
  console.error(`Unknown task '${task ?? ''}'. Known: ${Object.keys(TASKS).join(', ')}`);
  process.exit(2);
}

const isWindows = process.platform === 'win32';
const candidates = isWindows
  ? [
      {
        file: `${base}.ps1`,
        cmd: 'pwsh',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
      },
      {
        file: `${base}.ps1`,
        cmd: 'powershell',
        args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'],
      },
      { file: `${base}.sh`, cmd: 'bash', args: [] },
    ]
  : [{ file: `${base}.sh`, cmd: 'bash', args: [] }];

for (const candidate of candidates) {
  const script = join(root, candidate.file);
  if (!existsSync(script)) continue;

  // `which`-style probe: a missing shell should fall through to the next
  // candidate rather than failing the task.
  const probe = spawnSync(candidate.cmd, ['--version'], { stdio: 'ignore', shell: false });
  if (probe.error !== undefined) continue;

  const result = spawnSync(candidate.cmd, [...candidate.args, script], {
    cwd: root,
    stdio: 'inherit',
    shell: false,
  });
  process.exit(result.status ?? 1);
}

console.error(
  `No runnable script found for '${task}'. Expected ${base}.ps1 (Windows) or ${base}.sh with a shell available.`,
);
process.exit(1);
