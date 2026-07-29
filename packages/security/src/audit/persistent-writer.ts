/**
 * Persistent audit writer — `audit_log` now exists (migration 0015).
 *
 * This replaces the buffering writer, which was correct only while the table
 * did not exist. Buffering was always a stopgap: the buffer is bounded, so a
 * long pre-0015 window dropped its oldest records — precisely the ones an
 * investigator reaches for first.
 *
 * `record` requires a `Transaction` handle. Auditing outside the action's
 * transaction is unrepresentable, so the atomicity guarantee cannot be bypassed
 * by a caller who forgot: **a failed audit write fails the action.** That is the
 * opposite of logging, and deliberately so (`16-security/audit.md`).
 */

import {
  hashAuditRecord,
  type AuditRecord,
  type AuditWriter,
  type NewAuditRecord,
  type Transaction,
} from './writer.js';
import { secureId } from '../crypto/primitives.js';

const INSERT_SQL = `
  INSERT INTO audit_log (
    id, tenant_id, organization_id, actor_id, actor_kind, correlation_id,
    created_at, action, target_kind, target_id, target_tenant_id,
    result, reason, context, previous_hash, hash
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`;

/**
 * The chain head, read from the database rather than held in memory.
 *
 * An in-memory head is wrong across process restarts and across replicas: two
 * writers would each believe they follow the same record and produce a fork
 * that verification would report as tampering. Reading the previous hash inside
 * the same transaction serialises the chain on the row lock.
 */
const HEAD_SQL = `
  SELECT hash FROM audit_log
   WHERE tenant_id IS NOT DISTINCT FROM $1
   ORDER BY created_at DESC, id DESC
   LIMIT 1`;

/** A chain has to start somewhere, and it starts at a known value. */
export const GENESIS_HASH = '0'.repeat(64);

export interface PersistentAuditWriterOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
  /** Counts records written, for the audit-volume signal. */
  readonly onRecorded?: (action: string, result: string) => void;
}

export interface AuditExecutor extends Transaction {
  query<T>(sql: string, params?: readonly unknown[]): Promise<readonly T[]>;
}

function isExecutor(tx: Transaction): tx is AuditExecutor {
  return typeof (tx as { query?: unknown }).query === 'function';
}

export function createPersistentAuditWriter(
  options: PersistentAuditWriterOptions = {},
): AuditWriter {
  const now = options.now ?? ((): Date => new Date());
  const newId = options.newId ?? secureId;

  return {
    async record(tx: Transaction, entry: NewAuditRecord): Promise<string> {
      if (!isExecutor(tx)) {
        throw new TypeError(
          'Audit records require a live transaction handle. A failed audit write must fail the action it describes.',
        );
      }

      const head = await tx.query<{ hash: string }>(HEAD_SQL, [entry.tenantId]);
      const previousHash = head[0]?.hash ?? GENESIS_HASH;

      const base: Omit<AuditRecord, 'hash'> = {
        ...entry,
        auditId: newId(),
        timestamp: now(),
        previousHash,
      };
      const record: AuditRecord = { ...base, hash: hashAuditRecord(base) };

      await tx.query(INSERT_SQL, [
        record.auditId,
        record.tenantId,
        record.organizationId,
        record.actorId,
        record.actorKind,
        record.correlationId,
        record.timestamp.toISOString(),
        record.action,
        record.target.kind,
        record.target.id,
        record.target.tenantId,
        record.result,
        record.reason,
        JSON.stringify(record.context),
        record.previousHash,
        record.hash,
      ]);

      options.onRecorded?.(record.action, record.result);
      return record.auditId;
    },
  };
}
