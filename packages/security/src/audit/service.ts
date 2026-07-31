/**
 * The audit service — validate, redact, freeze, persist.
 *
 *   event → validate → redact → project → the FROZEN AuditWriter
 *
 * ── It is not a second writer ──────────────────────────────────────────────
 * There is no INSERT here, no chain arithmetic and no hash. `createAuditService`
 * takes an `AuditWriter` and calls it; the persistent writer stays the only
 * thing that touches `audit_log`, and the per-tenant chain stays where it is.
 * What this adds is the three steps that happened nowhere:
 *
 *   - VALIDATE. `audit.md` says `action` is enumerated and never free text, and
 *     nothing enforced it. It says `reason` is mandatory; the type allowed `''`.
 *   - REDACT. `reason` is free text in a queryable column of an append-only
 *     table with a seven-year retention. A token written there is a token
 *     nobody can ever remove — there is no UPDATE and no DELETE, by design.
 *   - FREEZE. Records came back mutable, so a caller could edit the object it
 *     had just filed.
 *
 * ── A failed audit write fails the action ──────────────────────────────────
 * Every refusal throws. `audit.md`: "If the record cannot be written, the
 * transaction rolls back and the operation returns an error. An unauditable
 * action does not proceed — the one place where the platform prefers
 * unavailability to incompleteness." Returning a refusal value here would let a
 * caller ignore it, which is the failure mode that rule exists to prevent.
 *
 * That is the opposite of the operational logger, deliberately: a log line that
 * cannot be written is dropped and the request continues.
 *
 * ── The scanner is injected ────────────────────────────────────────────────
 * `packages/security` depends on nothing, and that is worth keeping: it is
 * imported by every layer, so a dependency here is a dependency everywhere.
 * `CredentialScanner` is the shape `scanForCredentials` from
 * `@contentos/observability` already has, and a composition root binds them.
 */

import type { AuditCategory, AuditEvent, AuditMetadata } from './model.js';
import { assertValidAuditEvent, categoryOf, deepFreeze, toNewAuditRecord } from './model.js';
import type { AuditRecord, AuditWriter, Transaction } from './writer.js';

/**
 * The credential backstop, as a port.
 *
 * Structurally `scanForCredentials`: it returns the sanitised text and how many
 * credential-shaped values it replaced. The count matters — it is paged on at
 * any non-zero value, because a credential reaching this layer means one was
 * already logged somewhere upstream.
 */
export interface CredentialScanner {
  (value: string): { readonly value: string; readonly hits: number };
}

export interface AuditServiceOptions {
  readonly writer: AuditWriter;
  /**
   * Omitted, nothing is scanned and `onCredentialDetected` never fires.
   *
   * Deliberately optional rather than defaulted to a no-op that pretends: a
   * caller that composes no scanner should be able to see that it has none.
   */
  readonly scanner?: CredentialScanner;
  /**
   * Called when the backstop caught something on its way into the audit log.
   *
   * This firing is itself the alert. The value never reaches the table, but it
   * reached this far, and whatever produced it is logging it elsewhere too.
   */
  readonly onCredentialDetected?: (field: string, hits: number) => void;
}

export interface AuditService {
  /**
   * Record one audited action.
   *
   * Requires the action's own transaction handle — auditing outside it is
   * unrepresentable, so the atomicity guarantee cannot be bypassed by a caller
   * who forgot.
   *
   * Returns the audit id. Throws `AuditValidationError` on anything the record
   * cannot carry safely, and whatever the writer throws otherwise.
   */
  record(tx: Transaction, event: AuditEvent): Promise<string>;
}

export function createAuditService(options: AuditServiceOptions): AuditService {
  const { writer, scanner, onCredentialDetected } = options;

  /** Scan one field, reporting a hit rather than swallowing it. */
  function sanitize(value: string, field: string): string {
    if (scanner === undefined) return value;
    const result = scanner(value);
    if (result.hits > 0) onCredentialDetected?.(field, result.hits);
    return result.value;
  }

  function sanitizeMetadata(metadata: AuditMetadata): AuditMetadata {
    if (scanner === undefined) return metadata;

    const out: Record<string, string> = {};
    for (const key of Object.keys(metadata)) {
      const value = metadata[key];
      // `assertValidAuditEvent` has already refused a non-string, so this is
      // narrowing rather than a second check.
      out[key] = value === undefined ? '' : sanitize(value, `metadata.${key}`);
    }
    return out;
  }

  return Object.freeze({
    async record(tx: Transaction, event: AuditEvent): Promise<string> {
      // 1 · Refuse anything the record cannot carry. Before any I/O: a
      //     malformed submission must not cost a round trip, and must not
      //     half-write.
      assertValidAuditEvent(event);

      // 2 · Redact. `reason` and every metadata value are free-ish text headed
      //     for a column that can never be updated.
      const sanitized: AuditEvent = {
        ...event,
        reason: sanitize(event.reason, 'reason'),
        ...(event.metadata === undefined ? {} : { metadata: sanitizeMetadata(event.metadata) }),
      };

      // 3 · Project onto the frozen record and hand it to the frozen writer.
      //     The chain, the id and the timestamp are all its.
      return writer.record(tx, toNewAuditRecord(sanitized));
    },
  });
}

/**
 * A record, deep-frozen, with its category read back out.
 *
 * What a reader returns. The record is the same one the table holds — nothing
 * is recomputed and no hash is re-derived, because a projection that rebuilt
 * the hash would report a tampered record as valid.
 */
export interface ImmutableAuditRecord {
  readonly record: AuditRecord;
  /** Null on a record written before categories existed. */
  readonly category: AuditCategory | null;
}

export function freezeAuditRecord(record: AuditRecord): ImmutableAuditRecord {
  return deepFreeze({ record, category: categoryOf(record.context) });
}
