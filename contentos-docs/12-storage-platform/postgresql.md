# PostgreSQL

> **Status:** v1.0 — ownership document. Phase 12 governance completion.
> **The schema is owned by `03-database/`; this document owns the server it runs on.** Six documents defer operational configuration here — pooling, replicas, vacuum, partitioning operations.

## Purpose

Own the operational configuration of PostgreSQL as the system of record, and name the documents that own everything above it.

## Scope

**In scope:** ownership of server-level operational concerns — connection pooling mode, replica routing, vacuum operations, partition maintenance.

**Not in scope:** schema, tables, indexes, constraints, RLS policies, or migrations. All are owned by `03-database/` and `16-security/row-level-security.md`, and none is restated here.

## Ownership

| Concern | Owner |
|---|---|
| **Pooling mode, replica routing, vacuum operations, partition maintenance** | **This document** |
| Tables, columns, constraints | `03-database/tables.md` |
| Indexes and their tuning parameters | `03-database/indexes.md` |
| Migrations and expand/contract | `03-database/migrations.md`, `07-development-guide/migration-guide.md` |
| **RLS policies, roles, and the pooling requirement** | **`16-security/row-level-security.md`** |
| Backups, PITR, restore | `12-storage-platform/backups.md`, `14-operations/backup-recovery.md` |
| Instance sizing and scaling ladder | `14-operations/scaling-strategy.md`, `01-system-architecture/11-deployment-topology.md` |

**PostgreSQL is the system of record for all durable business state** (ADR-005). Every other store in the platform is transport, cache, or derived.

## Responsibilities

Four operational concerns are already constrained by decisions made elsewhere. This document owns them and records the constraints that bind them.

**Connection pooling mode is constrained by RLS.** `16-security/row-level-security.md` requires **transaction pooling** and prohibits statement pooling — under statement pooling, `SET LOCAL app.tenant_id` and the query it protects can land on different backend connections, and RLS provides no guarantee at all. Session pooling is safe but wastes connections. This is a security constraint expressed as an operational setting.

**Replica routing is constrained by the outbox.** `13-event-platform/transactional-outbox.md` requires the relay to **read the primary, never a replica** — a lagging replica can return rows whose predecessors have not replicated, inverting per-aggregate order. Read-heavy analytical paths and replay range scans may use replicas; the relay may not.

**Connection pool size bounds worker concurrency.** `13-event-platform/workers.md` derives its global in-flight limit from the pool size rather than choosing it freely, because worker fleets exhaust connection pools long before they exhaust CPU.

**Vacuum and partition operations are specified per table.** `03-database/indexes.md` §12 sets aggressive autovacuum for high-churn tables — `processed_events` in particular — and §9 defines monthly partitioning. This document owns executing and monitoring them, not choosing them.

## Existing references

Six references across four folders:

| Document | Defers |
|---|---|
| `03-database/README.md` | Operational configuration, replicas, vacuum, connection pooling |
| `03-database/indexes.md` | Server configuration, replicas, vacuum operations |
| `03-database/tables.md` | Vacuum, pooling, replica routing |
| `02-domain-design/analytics.md` | Time-series partitioning and retention |
| `05-content-platform/analytics-engine.md` | Time-series partitioning and retention |
| `01-system-architecture/13-adr-log.md` | ADR-005 Affects |

**Two references defer time-series partitioning**, which is specified in `03-database/indexes.md` §9; this document owns its operation.

## Related documents

- `03-database/` — **schema, indexes, constraints, migrations; the authority above this layer**
- `16-security/row-level-security.md` — **RLS policies, roles, and the transaction-pooling requirement**
- `13-event-platform/transactional-outbox.md` — the primary-only read requirement
- `13-event-platform/workers.md` — concurrency derived from pool size
- `12-storage-platform/backups.md` — WAL streaming, base backups, verification
- `12-storage-platform/disaster-recovery.md` — PITR, recovery sequencing, gates
- `14-operations/scaling-strategy.md` — the scaling ladder
- `01-system-architecture/11-deployment-topology.md` — where the primary and replicas run
- `07-development-guide/local-development.md` — PostgreSQL 17 with pgvector, matching production major

## Operational considerations

**The database is the platform's primary scaling constraint**, accepted deliberately at ADR-005 and addressed by the documented ladder rather than by early polyglot persistence.

**Major version parity with production is required locally.** Minor differences are tolerable; a major difference changes planner behaviour, and RLS conformance on one major proves nothing about another.

**A restored copy has no RLS applied**, which is why restore access is break-glass, individually approved, and audited (`16-security/row-level-security.md`). This is an operational property of PostgreSQL restore, not a policy this document sets.

**Index builds on large tables run concurrently and outside deploys** (`07-development-guide/migration-guide.md`). A non-concurrent build takes an `ACCESS EXCLUSIVE` lock, which is a write outage.

**pgvector runs inside this instance** at v1 (ADR-006), so vector index memory and query load share the primary's resources. The scaling trigger and migration target are `12-storage-platform/qdrant.md`.

## Explicitly out of scope

| Out of scope | Where it belongs |
|---|---|
| Any table, column, constraint, or index definition | `03-database/` |
| RLS policy shape and the exception set | `16-security/row-level-security.md` |
| Migration process and ordering | `07-development-guide/migration-guide.md` |
| Backup schedule, retention, verification | `12-storage-platform/backups.md` |
| Recovery sequencing and gates | `12-storage-platform/disaster-recovery.md` |
| Instance sizing, replica count, scaling triggers | `14-operations/scaling-strategy.md` |
| Vector index configuration | `11-knowledge-platform/vector-search.md` |
| **Query design and access patterns** | The owning domain component |
