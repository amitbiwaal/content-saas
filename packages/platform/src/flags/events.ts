/**
 * `FeatureFlagChanged` — `04-platform/feature-flags.md` §Events.
 *
 * The document names `FlagChanged`, `FlagKilled`, `FlagCreated` and
 * `FlagRetired`. Only the first is declared here, under the increment's name:
 * the other three describe an admin surface that does not exist, and declaring
 * an event type nothing can emit is what T3.1's composition check forbids.
 *
 * ── Same aggregate as SettingsChanged, on purpose ───────────────────────────
 * A flag override and a setting live in the same `settings` JSONB and advance
 * the same `version` column. Two events about one row on two aggregates would
 * be ordered independently, and a consumer could apply a flag change and a
 * settings change in an order that never happened. Sharing `SettingsTree` and
 * the organization id keeps them ordered against each other.
 *
 * The organization is the aggregate even for a workspace-level change, for the
 * reason `SettingsChanged` records: an organization-layer change alters the
 * answer for every workspace beneath it, so the two are not independent.
 *
 * ── Flag NAMES, never state beyond the change ───────────────────────────────
 * "`GET /v1/flags/evaluate` returns only client-visible flags. Server-only
 *  flags — kill switches, internal rollouts — are never exposed, because the
 *  flag set is a roadmap and a probe map for anyone reading it."
 *
 * An event reaches more consumers than the table does, so the payload carries
 * which flags moved and the version, and no evaluated values. A consumer that
 * needs the answer evaluates it under its own scope.
 */

import type { DomainEvent } from '@contentos/contracts';

import { SETTINGS_AGGREGATE } from '../settings/resolution-events.js';

/** Attribution on DLQ entries and contract ownership. */
export const FEATURE_FLAG_PRODUCER = 'platform.feature-flags';

export const FEATURE_FLAG_CHANGED = 'FeatureFlagChanged';

export const FEATURE_FLAG_EVENT_TYPES = [FEATURE_FLAG_CHANGED] as const;

export type FeatureFlagEventType = (typeof FEATURE_FLAG_EVENT_TYPES)[number];

export interface FeatureFlagChangedPayload {
  /** Which layer moved. */
  readonly scopeType: 'workspace' | 'organization';
  /** The workspace or organization whose layer moved. Attribution, not scope. */
  readonly scopeId: string;
  readonly organizationId: string;
  /** Names only. There is nowhere to put an evaluated value. */
  readonly changedFlags: readonly string[];
  /** The composite settings-layer version after the change. */
  readonly version: string;
}

export interface FeatureFlagEventContext {
  readonly eventId: string;
  readonly correlationId: string;
  /** Null for a root event — an operator action rather than a reaction. */
  readonly causationId: string | null;
  readonly occurredAt: string;
}

export function featureFlagChanged(
  ctx: FeatureFlagEventContext,
  payload: FeatureFlagChangedPayload,
): DomainEvent<FeatureFlagChangedPayload> {
  return {
    eventId: ctx.eventId,
    eventType: FEATURE_FLAG_CHANGED,
    eventVersion: 1,
    // Shared with SettingsChanged — see the note above.
    aggregateType: SETTINGS_AGGREGATE,
    aggregateId: payload.organizationId,
    tenantId: payload.organizationId,
    organizationId: payload.organizationId,
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    producer: FEATURE_FLAG_PRODUCER,
    occurredAt: ctx.occurredAt,
    payload,
  };
}
