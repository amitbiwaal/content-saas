/**
 * Maintenance windows, maintenance mode and runbooks.
 *
 * ── A window is DECLARED, never entered ───────────────────────────────────
 * Nothing here puts the platform into maintenance. It records that a window
 * was agreed, validates that the window is a real interval in the future, and
 * answers whether a given instant falls inside one. Whatever flips the flag is
 * a deployment concern with credentials, and a module that could flip it could
 * take the platform down.
 *
 * ── A runbook is followed by a human ──────────────────────────────────────
 * Its steps are prose, bounded, and deliberately not commands: a runbook that
 * held executable steps would be a script, and a script in a data structure is
 * one nobody reviews. `14-operations/incident-response.md` owns what happens
 * during an incident; this owns that the document exists and is not empty.
 *
 * ── No clock ──────────────────────────────────────────────────────────────
 * Every instant is supplied. A window that read the clock could not be asserted
 * on, and two readers would disagree about whether maintenance was active.
 */

import {
  assertIdentifier,
  assertInstant,
  assertText,
  deepFreeze,
  DeploymentError,
} from './errors.js';
import { isDeploymentEnvironment, type DeploymentEnvironment } from './release.js';

/**
 * What a maintenance window permits while it is open.
 *
 * `read_only` is the interesting one: `backup-recovery.md` §6.2 freezes writes
 * before a restore, and that is a maintenance state in which the platform is
 * still answering questions. A single on/off flag could not express it.
 */
export const MAINTENANCE_MODES = Object.freeze(['off', 'read_only', 'full'] as const);

export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];

export function isMaintenanceMode(value: unknown): value is MaintenanceMode {
  return typeof value === 'string' && (MAINTENANCE_MODES as readonly string[]).includes(value);
}

/** Does this mode stop customer writes? Both non-`off` modes do. */
export function blocksWrites(mode: MaintenanceMode): boolean {
  return mode !== 'off';
}

/** Does it stop reads too? Only `full`. */
export function blocksReads(mode: MaintenanceMode): boolean {
  return mode === 'full';
}

export type MaintenanceWindowId = string;

export interface MaintenanceWindow {
  readonly windowId: MaintenanceWindowId;
  readonly environment: DeploymentEnvironment;
  readonly mode: MaintenanceMode;
  /** Half-open: `[startsAt, endsAt)`, so adjacent windows never overlap. */
  readonly startsAt: string;
  readonly endsAt: string;
  /** Why. Shown on a status page, so bounded and free of internal detail. */
  readonly reason: string;
  /** Who agreed it. An identifier, never a name. */
  readonly declaredBy: string;
  readonly declaredAt: string;
}

/** The longest a window may be declared for. */
export const MAX_WINDOW_HOURS = 8;

export function assertValidMaintenanceWindow(
  window: MaintenanceWindow,
  now: string,
): MaintenanceWindow {
  assertIdentifier(window.windowId, 'windowId');
  assertIdentifier(window.declaredBy, 'declaredBy');
  assertInstant(window.startsAt, 'startsAt', 'InvalidMaintenanceWindow');
  assertInstant(window.endsAt, 'endsAt', 'InvalidMaintenanceWindow');
  assertInstant(window.declaredAt, 'declaredAt', 'InvalidMaintenanceWindow');
  assertInstant(now, 'now', 'InvalidMaintenanceWindow');
  assertText(window.reason, 'reason', 'a window customers see carries why it is happening.');

  if (!isDeploymentEnvironment(window.environment)) {
    throw new DeploymentError(
      'InvalidEnvironment',
      'environment',
      `'${String(window.environment)}' is not an environment.`,
    );
  }
  if (!isMaintenanceMode(window.mode)) {
    throw new DeploymentError(
      'InvalidMaintenanceWindow',
      'mode',
      `'${String(window.mode)}' is not a maintenance mode. Available: ${MAINTENANCE_MODES.join(', ')}.`,
    );
  }
  if (window.mode === 'off') {
    throw new DeploymentError(
      'InvalidMaintenanceWindow',
      'mode',
      'A window in mode `off` is not a window. `off` is the absence of one; declaring it would put a maintenance banner on a platform that is up.',
    );
  }

  const starts = Date.parse(window.startsAt);
  const ends = Date.parse(window.endsAt);

  if (ends <= starts) {
    throw new DeploymentError(
      'InvalidMaintenanceWindow',
      'endsAt',
      'A maintenance window must end after it begins. An empty window is one nothing can happen in.',
    );
  }
  if (ends - starts > MAX_WINDOW_HOURS * 3_600_000) {
    throw new DeploymentError(
      'InvalidMaintenanceWindow',
      'endsAt',
      `A window longer than ${String(MAX_WINDOW_HOURS)} hours is an outage with a nicer name. Declare a shorter one and extend it if the work needs longer.`,
    );
  }
  if (ends <= Date.parse(now)) {
    throw new DeploymentError(
      'InvalidMaintenanceWindow',
      'endsAt',
      'A maintenance window that has already ended cannot be declared. Recording one after the fact would put a banner up for a period customers have already lived through.',
    );
  }

  return window;
}

export function createMaintenanceWindow(window: MaintenanceWindow, now: string): MaintenanceWindow {
  assertValidMaintenanceWindow(window, now);
  return deepFreeze({ ...window });
}

/** Is this instant inside the window? Half-open: `startsAt <= at < endsAt`. */
export function isWindowActive(window: MaintenanceWindow, at: string): boolean {
  const instant = Date.parse(assertInstant(at, 'at', 'InvalidMaintenanceWindow'));
  return instant >= Date.parse(window.startsAt) && instant < Date.parse(window.endsAt);
}

/**
 * The mode in force at an instant, across every declared window.
 *
 * The strictest wins: two overlapping windows, one read-only and one full, mean
 * the platform is fully down. Taking the looser would let a read through during
 * a restore.
 */
export function modeAt(
  windows: readonly MaintenanceWindow[],
  environment: DeploymentEnvironment,
  at: string,
): MaintenanceMode {
  let mode: MaintenanceMode = 'off';
  for (const window of windows) {
    if (window.environment !== environment) continue;
    if (!isWindowActive(window, at)) continue;
    if (window.mode === 'full') return 'full';
    mode = 'read_only';
  }
  return mode;
}

// ── Runbooks ────────────────────────────────────────────────────────────────

export type RunbookId = string;

/** One step. Prose for a person, never a command for a shell. */
export interface RunbookStep {
  readonly order: number;
  readonly action: string;
  /** How to tell it worked. A step nobody can verify is one nobody can skip safely. */
  readonly verification: string;
}

export interface OperationalRunbook {
  readonly runbookId: RunbookId;
  readonly title: string;
  /** What it is for — a deploy, a rollback, a restore, an incident. */
  readonly scenario: string;
  readonly steps: readonly RunbookStep[];
  /** Who maintains it. An identifier, never a person's name. */
  readonly owner: string;
  /**
   * When it was last rehearsed. Null means never, which is the answer that
   * matters: an unrehearsed runbook is a document, not a capability.
   */
  readonly lastRehearsedAt: string | null;
  readonly updatedAt: string;
}

export const MAX_RUNBOOK_STEPS = 50;

export function assertValidRunbook(runbook: OperationalRunbook, now: string): OperationalRunbook {
  assertIdentifier(runbook.runbookId, 'runbookId');
  assertIdentifier(runbook.owner, 'owner');
  assertIdentifier(runbook.scenario, 'scenario');
  assertText(runbook.title, 'title', 'a runbook nobody can find by name is one nobody follows.');
  assertInstant(runbook.updatedAt, 'updatedAt', 'MalformedRunbook');
  assertInstant(now, 'now', 'MalformedRunbook');

  if (runbook.steps.length === 0) {
    throw new DeploymentError(
      'MalformedRunbook',
      'steps',
      'A runbook with no steps is a title. During an incident that is worse than nothing, because it looks like preparation.',
    );
  }
  if (runbook.steps.length > MAX_RUNBOOK_STEPS) {
    throw new DeploymentError(
      'MalformedRunbook',
      'steps',
      `A runbook of more than ${String(MAX_RUNBOOK_STEPS)} steps is one nobody finishes under pressure. Split it.`,
    );
  }

  const seen = new Set<number>();
  for (const step of runbook.steps) {
    if (!Number.isSafeInteger(step.order) || step.order < 1) {
      throw new DeploymentError(
        'MalformedRunbook',
        'steps',
        'A step order is a whole number from one. Steps are followed in order under pressure.',
      );
    }
    if (seen.has(step.order)) {
      throw new DeploymentError(
        'MalformedRunbook',
        'steps',
        `Two steps are numbered ${String(step.order)}; nobody following it would know which came first.`,
      );
    }
    seen.add(step.order);

    assertText(step.action, 'steps.action', 'a step says what to do.');
    assertText(
      step.verification,
      'steps.verification',
      'a step nobody can verify is one nobody can safely skip or repeat.',
    );
  }

  // Contiguous from one: a gap means a step was deleted and nobody renumbered,
  // so whoever follows it wonders what they missed.
  for (let order = 1; order <= runbook.steps.length; order += 1) {
    if (!seen.has(order)) {
      throw new DeploymentError(
        'MalformedRunbook',
        'steps',
        `Step ${String(order)} is missing. A gap means a step was removed and nobody renumbered, and whoever follows it under pressure will wonder what they skipped.`,
      );
    }
  }

  if (runbook.lastRehearsedAt !== null) {
    assertInstant(runbook.lastRehearsedAt, 'lastRehearsedAt', 'MalformedRunbook');
    if (Date.parse(runbook.lastRehearsedAt) > Date.parse(now)) {
      throw new DeploymentError(
        'MalformedRunbook',
        'lastRehearsedAt',
        'A runbook cannot have been rehearsed in the future.',
      );
    }
  }

  return runbook;
}

export function createRunbook(runbook: OperationalRunbook, now: string): OperationalRunbook {
  assertValidRunbook(runbook, now);
  return deepFreeze({
    ...runbook,
    steps: [...runbook.steps].sort((a, b) => a.order - b.order).map((step) => ({ ...step })),
  });
}

/**
 * Has this runbook been rehearsed recently enough?
 *
 * `backup-recovery.md` rehearses quarterly and `deployment.md` §10 rehearses
 * rollback quarterly alongside it. An unrehearsed runbook is a document.
 */
export function isRehearsed(runbook: OperationalRunbook, now: string, withinDays = 90): boolean {
  if (runbook.lastRehearsedAt === null) return false;
  const elapsed = Date.parse(now) - Date.parse(runbook.lastRehearsedAt);
  return elapsed <= withinDays * 86_400_000;
}
