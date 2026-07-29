/**
 * Event registry.
 *
 * Spec: `13-event-platform/event-registry.md` and `versioning.md`. The
 * `VersionRegistry` described separately in `versioning.md` is merged here —
 * they were one component described in two documents (`event-apis.md` D-8).
 *
 * The registry is SOURCE-CONTROLLED and loaded at startup. It is not a runtime
 * table: an event type that can be added at runtime is one that can be added
 * without review, and the payload rules exist precisely to be reviewed.
 */

import type { DomainEvent } from '@contentos/contracts';

export type Criticality = 'standard' | 'critical';
export type UnknownVersionPolicy = 'transform' | 'dead-letter';

export interface ConsumerDeclaration {
  readonly consumerGroup: string;
  readonly component: string;
  /** The GROUP's set — more than one element only during a migration window. */
  readonly versions: readonly number[];
  readonly criticality: Criticality;
  readonly handlerIdempotencyKey: string;
  readonly onUnknownVersion: UnknownVersionPolicy;
}

export type VersionState = 'active' | 'deprecated' | 'retired';

export interface EventTypeDeclaration {
  readonly eventType: string;
  readonly version: number;
  readonly state: VersionState;
  /** Redis stream this type is appended to. */
  readonly stream: string;
  readonly consumers: readonly ConsumerDeclaration[];
  /** Transform from this version to version + 1. Absent on the newest version. */
  readonly upcast?: (payload: unknown) => unknown;
}

export interface RetirementCheck {
  readonly eligible: boolean;
  readonly blockedBy: readonly string[];
}

export type RegistryValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: RegistryError };

export class RegistryError extends Error {
  /** A terminal classification: never retried (`retry-engine.md`). */
  readonly code: 'UnknownEventType' | 'SchemaViolation';

  constructor(code: 'UnknownEventType' | 'SchemaViolation', message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

export interface EventRegistry {
  validate(event: DomainEvent<unknown>): RegistryValidation;
  isRegistered(eventType: string, version: number): boolean;
  streamFor(eventType: string): string;
  consumersOf(eventType: string): readonly ConsumerDeclaration[];
  transform(event: DomainEvent<unknown>, targetVersion: number): DomainEvent<unknown>;
  supportedVersions(eventType: string): readonly VersionState[];
  retirementEligibility(eventType: string, version: number): RetirementCheck;
}

const key = (eventType: string, version: number): string => `${eventType}@${String(version)}`;

class SourceControlledRegistry implements EventRegistry {
  readonly #byKey = new Map<string, EventTypeDeclaration>();
  readonly #byType = new Map<string, EventTypeDeclaration[]>();

  constructor(declarations: readonly EventTypeDeclaration[]) {
    for (const d of declarations) {
      const k = key(d.eventType, d.version);
      if (this.#byKey.has(k)) {
        // Event types are never reused and every version is immutable.
        throw new Error(`Duplicate registry declaration for ${k}.`);
      }
      this.#byKey.set(k, d);
      const list = this.#byType.get(d.eventType) ?? [];
      list.push(d);
      list.sort((a, b) => a.version - b.version);
      this.#byType.set(d.eventType, list);
    }
  }

  validate(event: DomainEvent<unknown>): RegistryValidation {
    if (!this.isRegistered(event.eventType, event.eventVersion)) {
      return {
        ok: false,
        error: new RegistryError(
          'UnknownEventType',
          `${key(event.eventType, event.eventVersion)} is not registered. Unknown types never reach the outbox.`,
        ),
      };
    }
    const declaration = this.#byKey.get(key(event.eventType, event.eventVersion));
    if (declaration?.state === 'retired') {
      return {
        ok: false,
        error: new RegistryError(
          'UnknownEventType',
          `${key(event.eventType, event.eventVersion)} is retired and may no longer be published.`,
        ),
      };
    }
    return { ok: true };
  }

  isRegistered(eventType: string, version: number): boolean {
    return this.#byKey.has(key(eventType, version));
  }

  streamFor(eventType: string): string {
    const versions = this.#byType.get(eventType);
    const newest = versions?.at(-1);
    if (newest === undefined) {
      throw new RegistryError('UnknownEventType', `${eventType} is not registered.`);
    }
    return newest.stream;
  }

  consumersOf(eventType: string): readonly ConsumerDeclaration[] {
    return this.#byType.get(eventType)?.at(-1)?.consumers ?? [];
  }

  /**
   * Transform in memory, on read. Every event is immutable — historical events
   * are NEVER mutated, so a consumer declaring version N sees the event upcast
   * to N at delivery time and contains no version branching itself.
   */
  transform(event: DomainEvent<unknown>, targetVersion: number): DomainEvent<unknown> {
    if (event.eventVersion === targetVersion) return event;
    if (event.eventVersion > targetVersion) {
      throw new RegistryError(
        'SchemaViolation',
        `Cannot downcast ${key(event.eventType, event.eventVersion)} to version ${String(targetVersion)}; transformation is forward-only.`,
      );
    }

    let payload = event.payload;
    for (let v = event.eventVersion; v < targetVersion; v += 1) {
      const step = this.#byKey.get(key(event.eventType, v));
      if (step?.upcast === undefined) {
        throw new RegistryError(
          'SchemaViolation',
          `No upcast registered from ${key(event.eventType, v)} to version ${String(v + 1)}.`,
        );
      }
      payload = step.upcast(payload);
    }
    return { ...event, eventVersion: targetVersion, payload };
  }

  supportedVersions(eventType: string): readonly VersionState[] {
    return (this.#byType.get(eventType) ?? []).map((d) => d.state);
  }

  /**
   * A version cannot be retired while any consumer group still declares it.
   * That rule is what makes deprecation safe rather than optimistic.
   */
  retirementEligibility(eventType: string, version: number): RetirementCheck {
    const declaration = this.#byKey.get(key(eventType, version));
    if (declaration === undefined) {
      return { eligible: false, blockedBy: ['not registered'] };
    }
    const blockedBy = declaration.consumers
      .filter((c) => c.versions.includes(version))
      .map((c) => c.consumerGroup);
    return { eligible: blockedBy.length === 0, blockedBy };
  }
}

export function createEventRegistry(declarations: readonly EventTypeDeclaration[]): EventRegistry {
  return new SourceControlledRegistry(declarations);
}
