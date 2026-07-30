/**
 * Registry declaration validation — run at STARTUP, before the process serves
 * anything.
 *
 * Spec: `13-event-platform/event-registry.md`. Every failure here is a
 * programming or deployment error, never a runtime condition, so every one of
 * them **fails the process**. There are no warnings: a warning about an
 * undeclared event type is a warning that events are being dropped, and it
 * would be read once and then scrolled past.
 *
 * The checks are also the reason this module returns a LIST rather than
 * throwing on the first problem. A misconfigured composition usually has
 * several faults, and fixing them one restart at a time is how a five-minute
 * job becomes an afternoon.
 */

import {
  isEventTenantScope,
  type EventTypeDeclaration,
  type RegistryContribution,
} from '@contentos/contracts';

export type RegistryIssueCode =
  | 'DUPLICATE_DECLARATION'
  | 'DUPLICATE_PRODUCER'
  | 'MISSING_TENANT_SCOPE'
  | 'INVALID_VERSION_SEQUENCE'
  | 'UNKNOWN_CONSUMER_EVENT'
  | 'DUPLICATE_CONSUMER_GROUP'
  | 'MALFORMED_DECLARATION'
  | 'UNDECLARED_EMITTED_EVENT'
  | 'CONSUMER_GROUP_WITHOUT_HANDLER'
  | 'HANDLER_WITHOUT_DECLARATION'
  | 'HANDLER_SCOPE_MISMATCH';

export interface RegistryIssue {
  readonly code: RegistryIssueCode;
  readonly eventType: string | null;
  readonly detail: string;
}

/** PascalCase, past tense by convention — the same rule the envelope enforces. */
const EVENT_TYPE = /^[A-Z][A-Za-z0-9]*$/;

const VERSION_STATES = ['active', 'deprecated', 'retired'];

function key(eventType: string, version: number): string {
  return `${eventType}@${String(version)}`;
}

/**
 * Shape checks.
 *
 * `tenantScope` is validated even though the type requires it, because a
 * declaration can arrive from JavaScript, from a JSON fixture, or from a
 * package compiled against an older shape — and "do not infer scope" has to
 * hold at the boundary where types stop.
 */
function checkShape(declaration: EventTypeDeclaration): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const eventType = typeof declaration.eventType === 'string' ? declaration.eventType : null;
  const add = (code: RegistryIssueCode, detail: string): void => {
    issues.push({ code, eventType, detail });
  };

  if (eventType === null || !EVENT_TYPE.test(eventType)) {
    add(
      'MALFORMED_DECLARATION',
      `eventType must be PascalCase, e.g. 'ArticlePublished'; got ${JSON.stringify(declaration.eventType)}.`,
    );
  }
  if (!Number.isInteger(declaration.version) || declaration.version < 1) {
    add(
      'MALFORMED_DECLARATION',
      `version must be an integer >= 1; got ${JSON.stringify(declaration.version)}.`,
    );
  }
  if (!VERSION_STATES.includes(declaration.state)) {
    add(
      'MALFORMED_DECLARATION',
      `state must be one of ${VERSION_STATES.join(', ')}; got ${JSON.stringify(declaration.state)}.`,
    );
  }
  if (typeof declaration.stream !== 'string' || declaration.stream.length === 0) {
    add('MALFORMED_DECLARATION', 'stream is required; it names the Redis stream to append to.');
  }
  if (typeof declaration.producer !== 'string' || declaration.producer.length === 0) {
    add('MALFORMED_DECLARATION', 'producer is required for attribution and collision detection.');
  }
  if (!isEventTenantScope(declaration.tenantScope)) {
    add(
      'MISSING_TENANT_SCOPE',
      `tenantScope must be 'workspace' or 'organization' (ADR-029); got ${JSON.stringify(declaration.tenantScope)}. Scope is never inferred.`,
    );
  }
  return issues;
}

/**
 * Validate a flat declaration set.
 *
 * Covers everything knowable from the declarations alone. Handler-related
 * checks need the composition and live in `composition.ts`.
 */
export function validateDeclarations(
  declarations: readonly EventTypeDeclaration[],
): readonly RegistryIssue[] {
  const issues: RegistryIssue[] = [];

  for (const declaration of declarations) {
    issues.push(...checkShape(declaration));
  }

  // ── Duplicate (eventType, version) ────────────────────────────────────────
  // Event types are never reused and every version is immutable.
  const seen = new Set<string>();
  for (const declaration of declarations) {
    const k = key(declaration.eventType, declaration.version);
    if (seen.has(k)) {
      issues.push({
        code: 'DUPLICATE_DECLARATION',
        eventType: declaration.eventType,
        detail: `${k} is declared more than once. Every version of a type is declared exactly once.`,
      });
    }
    seen.add(k);
  }

  // ── One producer per event type ───────────────────────────────────────────
  // Two packages claiming a type is otherwise resolved by load order, which is
  // to say not resolved at all.
  const producers = new Map<string, string>();
  for (const declaration of declarations) {
    const existing = producers.get(declaration.eventType);
    if (existing !== undefined && existing !== declaration.producer) {
      issues.push({
        code: 'DUPLICATE_PRODUCER',
        eventType: declaration.eventType,
        detail: `'${declaration.eventType}' is claimed by both '${existing}' and '${declaration.producer}'. An event type has exactly one producer.`,
      });
    } else if (existing === undefined) {
      producers.set(declaration.eventType, declaration.producer);
    }
  }

  // ── Version sequence ──────────────────────────────────────────────────────
  // Versions start at 1 and are contiguous. A gap means a version was retired
  // by deletion rather than by state, and `transform` would find no upcast
  // across the hole.
  const byType = new Map<string, number[]>();
  for (const declaration of declarations) {
    const list = byType.get(declaration.eventType) ?? [];
    list.push(declaration.version);
    byType.set(declaration.eventType, list);
  }
  for (const [eventType, versions] of byType) {
    const sorted = [...new Set(versions)].sort((a, b) => a - b);
    const expected = sorted.map((_, i) => i + 1);
    if (sorted.join(',') !== expected.join(',')) {
      issues.push({
        code: 'INVALID_VERSION_SEQUENCE',
        eventType,
        detail: `'${eventType}' declares versions [${sorted.join(', ')}]; versions must start at 1 and be contiguous.`,
      });
    }
  }

  // ── Consumers reference declared versions ─────────────────────────────────
  for (const declaration of declarations) {
    for (const consumer of declaration.consumers) {
      for (const version of consumer.versions) {
        if (!seen.has(key(declaration.eventType, version))) {
          issues.push({
            code: 'UNKNOWN_CONSUMER_EVENT',
            eventType: declaration.eventType,
            detail: `Consumer group '${consumer.consumerGroup}' declares version ${String(version)} of '${declaration.eventType}', which is not declared.`,
          });
        }
      }
    }
  }

  // ── A consumer group means one thing platform-wide ────────────────────────
  // Two groups sharing a name share an offset in Redis, so each would see a
  // fraction of the stream and both would believe they saw all of it.
  const groupComponents = new Map<string, string>();
  for (const declaration of declarations) {
    for (const consumer of declaration.consumers) {
      const existing = groupComponents.get(consumer.consumerGroup);
      if (existing !== undefined && existing !== consumer.component) {
        issues.push({
          code: 'DUPLICATE_CONSUMER_GROUP',
          eventType: declaration.eventType,
          detail: `Consumer group '${consumer.consumerGroup}' is claimed by both '${existing}' and '${consumer.component}'. A group name is platform-wide.`,
        });
      } else if (existing === undefined) {
        groupComponents.set(consumer.consumerGroup, consumer.component);
      }
    }
  }

  return issues;
}

/**
 * Every type a package can emit must be declared.
 *
 * This is the check that catches the gap this increment exists to close: a
 * builder shipped without a declaration publishes nothing, and the failure
 * surfaces as a rejected transaction in production rather than a failed start.
 */
export function validateContributionCoverage(
  contributions: readonly RegistryContribution[],
): readonly RegistryIssue[] {
  const declared = new Set<string>();
  for (const contribution of contributions) {
    for (const declaration of contribution.declarations) {
      declared.add(declaration.eventType);
    }
  }

  const issues: RegistryIssue[] = [];
  for (const contribution of contributions) {
    for (const eventType of contribution.emits) {
      if (!declared.has(eventType)) {
        issues.push({
          code: 'UNDECLARED_EMITTED_EVENT',
          eventType,
          detail: `'${contribution.source}' can emit '${eventType}' but nothing declares it. It could never be published.`,
        });
      }
    }
  }
  return issues;
}

export class RegistryValidationError extends Error {
  readonly issues: readonly RegistryIssue[];

  constructor(issues: readonly RegistryIssue[]) {
    super(
      `Event registry is invalid; the process must not start:\n${issues
        .map((i) => `  [${i.code}] ${i.detail}`)
        .join('\n')}`,
    );
    this.name = 'RegistryValidationError';
    this.issues = issues;
  }
}

export function assertNoIssues(issues: readonly RegistryIssue[]): void {
  if (issues.length > 0) throw new RegistryValidationError(issues);
}
