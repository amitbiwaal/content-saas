/**
 * The audit read port — `16-security/audit.md` §Interfaces.
 *
 * ── This is the half that was missing ──────────────────────────────────────
 * `AuditWriter` writes. Nothing reads. The specification names an `AuditReader`
 * with four methods and the code has none of them, so an investigation, a
 * compliance export and a chain verification each either grow their own SQL —
 * three places the record's shape and the tenant filter are written down — or
 * they get a port.
 *
 * Transcribed from that document rather than designed here, including the
 * method names.
 *
 * ── There is no update and no delete ───────────────────────────────────────
 * "The interface offers no path to mutation, so a caller cannot reach for one."
 * Nor is there a write: `AuditWriter` is the only way in, and a repository that
 * could do both would eventually be used to do both.
 *
 * ── Reading the audit log is itself an audited action ──────────────────────
 * `audit.md`: "Without this, an operator could review every tenant's activity
 * leaving no trace — defeating the trail's purpose at exactly the point it
 * matters." That audit record is the CALLER's to write, through `AuditService`,
 * because a reader that audited itself would need a transaction handle and a
 * writer, and would then be a write path.
 *
 * ── No database, no clock, no SQL ─────────────────────────────────────────
 * No driver, no query text, no transaction handle. Every bound is supplied.
 */

import type { AuditCategory } from './model.js';
import type { AuditRecord, AuditResult } from './writer.js';

/** Where a page continues from. Keyset, never an offset — the table is huge. */
export interface AuditPosition {
  /** ISO-8601 UTC. Matches the `(tenant_id, timestamp DESC)` index. */
  readonly timestamp: string;
  readonly auditId: string;
}

/**
 * What an audit query narrows by.
 *
 * Explicit nulls rather than optionals, as everywhere else here: an implementer
 * sees every dimension it must handle. A filter quietly ignored in this table
 * shows one tenant's activity to another.
 *
 * Every dimension corresponds to an index `audit.md` §"Database impact"
 * declares — tenant and time, correlation, actor, action. A filter with no
 * index would be a sequential scan over seven years of records.
 */
export interface AuditQuery {
  /** Required. Chaining is per tenant and so is reading. */
  readonly tenantId: string | null;
  readonly organizationId: string;
  readonly actorId: string | null;
  readonly action: string | null;
  readonly category: AuditCategory | null;
  readonly result: AuditResult | null;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  /** Inclusive. ISO-8601 UTC. */
  readonly from: string | null;
  /** Exclusive, so adjacent windows never count one record twice. */
  readonly to: string | null;
  readonly after: AuditPosition | null;
  readonly limit: number;
}

/**
 * One page of records.
 *
 * Newest first: an investigation starts at "what just happened", unlike a
 * ledger or a billing period, which are read forwards.
 */
export interface AuditPage {
  readonly records: readonly AuditRecord[];
  /** Null when this is the last page. Never a count — a total over seven years
   * of partitions is a scan nobody asked for. */
  readonly next: AuditPosition | null;
}

/**
 * What verifying a chain segment found.
 *
 * A discriminated union rather than a boolean and some optional fields: a
 * caller cannot read `brokenAt` off a valid result, and cannot forget to look
 * at it on an invalid one.
 */
export type ChainVerification =
  | {
      readonly valid: true;
      readonly recordCount: number;
      /** The last hash in the segment. What the next link must point at. */
      readonly headHash: string;
    }
  | {
      readonly valid: false;
      /** The audit id where the chain stops verifying. */
      readonly brokenAt: string;
      readonly expectedHash: string;
      readonly actualHash: string;
    };

/**
 * A handle to an export that is being produced.
 *
 * Not the bytes: an export of seven years of one tenant's audit trail is not
 * something to hold in memory, and `audit.md` audits exports with record counts
 * because "exported 3" and "exported 40,000" are the same action and entirely
 * different events.
 */
export interface AuditExportHandle {
  readonly exportId: string;
  readonly recordCount: number;
  /** Who asked. Recorded, because reading the audit log is an audited action. */
  readonly requestedBy: string;
  readonly requestedAt: string;
}

export interface AuditReader {
  /** A page of records for one tenant. Keyset, newest first. */
  query(request: AuditQuery): Promise<AuditPage>;

  /**
   * Every audited action caused by one request.
   *
   * The investigation primitive: it reconstructs an incident in one query
   * rather than by joining logs, across services, tenants and asynchronous
   * work. Returns them in the order they happened.
   */
  timeline(organizationId: string, correlationId: string): Promise<readonly AuditRecord[]>;

  /**
   * Verify the tamper-evidence chain over a window.
   *
   * Per tenant, because the chain is per tenant: a global chain would serialise
   * every audit write across the platform.
   */
  verifyChain(tenantId: string | null, from: string, to: string): Promise<ChainVerification>;

  /**
   * Begin an export.
   *
   * `actor` is required rather than optional: an export with no recorded
   * requester is the one an investigation most needs to attribute.
   */
  export(request: AuditQuery, actor: string): Promise<AuditExportHandle>;
}
