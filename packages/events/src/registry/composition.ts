/**
 * Registry composition — assembling ONE registry per process.
 *
 * Spec: `13-event-platform/event-registry.md`, and the shared convention in
 * `04-platform/README.md` that composition happens at the process edge.
 *
 * ── Why composition is a function here rather than code in each root ────────
 * `services/api` and `workers/host` both need the identical assembly and the
 * identical validation, and they cannot share code except through a package.
 * Duplicating the validation would mean one root could drift into accepting
 * what the other rejects — and the one that accepts more is the one that
 * publishes an event nothing can consume.
 *
 * So the ENGINE lives here and each root supplies only its contributions and
 * its handlers. No feature package calls this; a feature package that built
 * its own registry would be able to publish a type the process never validated.
 */

import type { EventTypeDeclaration, RegistryContribution } from '@contentos/contracts';

import type { RegisteredHandler } from '../delivery/dispatcher.js';
import { createEventRegistry, type EventRegistry } from './registry.js';
import {
  assertNoIssues,
  validateContributionCoverage,
  validateDeclarations,
  type RegistryIssue,
} from './validation.js';

export interface RegistryCompositionOptions {
  readonly contributions: readonly RegistryContribution[];
  /**
   * Handlers this process will run. A CONSUMER process supplies them; a
   * producer-only process supplies none.
   *
   * When supplied, every declared consumer group must have one and every
   * handler must correspond to a declaration — checked in both directions,
   * because each omission fails silently in a different way.
   */
  readonly handlers?: readonly RegisteredHandler[];
  /**
   * Whether declared consumer groups require a handler in THIS process.
   *
   * False for a producer-only root: `services/api` declares the same event
   * types but runs none of their consumers, and demanding handlers there would
   * make every new consumer group break the API's startup.
   */
  readonly requireHandlers?: boolean;
}

export interface ComposedRegistry {
  readonly registry: EventRegistry;
  readonly declarations: readonly EventTypeDeclaration[];
  /**
   * Resolves an event type's declared scope — wired into the dispatcher.
   *
   * A PROPERTY holding a closure, not a method: it is passed by reference into
   * `DispatchDeps`, and a method would carry a `this` the caller has to keep.
   */
  readonly tenantScopeOf: (
    eventType: string,
    version: number,
  ) => 'workspace' | 'organization' | undefined;
}

/**
 * Handler-aware checks.
 *
 * Both directions matter. A declared group with no handler means events pile
 * up in a stream nobody reads; a handler with no declaration means code that
 * will never be called, which is the more misleading of the two because it
 * looks like working software.
 */
function validateHandlers(
  declarations: readonly EventTypeDeclaration[],
  handlers: readonly RegisteredHandler[],
  requireHandlers: boolean,
): readonly RegistryIssue[] {
  const issues: RegistryIssue[] = [];

  const declaredScope = new Map<string, string>();
  const declaredGroups = new Map<string, { eventType: string; version: number }[]>();
  for (const declaration of declarations) {
    declaredScope.set(
      `${declaration.eventType}@${String(declaration.version)}`,
      declaration.tenantScope,
    );
    for (const consumer of declaration.consumers) {
      for (const version of consumer.versions) {
        const list = declaredGroups.get(consumer.consumerGroup) ?? [];
        list.push({ eventType: declaration.eventType, version });
        declaredGroups.set(consumer.consumerGroup, list);
      }
    }
  }

  const registered = new Set(
    handlers.map((h) => `${h.group}::${h.eventType}@${String(h.version)}`),
  );

  if (requireHandlers) {
    for (const [group, targets] of declaredGroups) {
      for (const target of targets) {
        const k = `${group}::${target.eventType}@${String(target.version)}`;
        if (!registered.has(k)) {
          issues.push({
            code: 'CONSUMER_GROUP_WITHOUT_HANDLER',
            eventType: target.eventType,
            detail: `Consumer group '${group}' declares ${target.eventType}@${String(target.version)} but this process registers no handler for it.`,
          });
        }
      }
    }
  }

  for (const handler of handlers) {
    const k = `${handler.eventType}@${String(handler.version)}`;
    const scope = declaredScope.get(k);
    if (scope === undefined) {
      issues.push({
        code: 'HANDLER_WITHOUT_DECLARATION',
        eventType: handler.eventType,
        detail: `Handler in group '${handler.group}' targets ${k}, which is not declared.`,
      });
      continue;
    }
    // ADR-029, enforced at startup rather than discovered as a silent
    // zero-row read inside a handler.
    if (handler.tenantScope !== scope) {
      issues.push({
        code: 'HANDLER_SCOPE_MISMATCH',
        eventType: handler.eventType,
        detail: `Handler in group '${handler.group}' accepts '${handler.tenantScope}'-scoped events but ${k} is '${scope}'-scoped. Reconstructing tenant context from it would read zero rows silently.`,
      });
    }
  }

  return issues;
}

/**
 * Build the process registry, or throw and refuse to start.
 *
 * Fail-closed is the whole point: a process that starts with an invalid
 * registry is a process that drops events, and dropping them is invisible.
 */
export function composeEventRegistry(options: RegistryCompositionOptions): ComposedRegistry {
  const declarations = options.contributions.flatMap((c) => [...c.declarations]);
  const handlers = options.handlers ?? [];

  assertNoIssues([
    ...validateDeclarations(declarations),
    ...validateContributionCoverage(options.contributions),
    ...validateHandlers(declarations, handlers, options.requireHandlers ?? handlers.length > 0),
  ]);

  const scopes = new Map<string, 'workspace' | 'organization'>();
  for (const declaration of declarations) {
    scopes.set(`${declaration.eventType}@${String(declaration.version)}`, declaration.tenantScope);
  }

  return {
    registry: createEventRegistry(declarations),
    declarations,
    tenantScopeOf: (eventType, version) => scopes.get(`${eventType}@${String(version)}`),
  };
}
