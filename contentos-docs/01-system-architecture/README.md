# 01 — System Architecture

The source of truth for the entire system. Every other folder derives from this one; where a downstream document conflicts with this folder, this folder wins until amended through the ADR process.

Read in order on first contact. `04-context-map.md` and `05-glossary.md` bind vocabulary and boundaries for every later document — read them before writing any code or any documentation.

| File | Covers |
|---|---|
| `01-executive-summary.md` | What the system is and is not; the four durable commitments; the decision index |
| `02-product-vision.md` | OS metaphor, the 13-stage lifecycle, personas, the single-workflow promise, goals and non-goals |
| `03-high-level-architecture.md` | The nine layers, their responsibilities, dependency rules, trade-offs, and where new code belongs |
| `04-context-map.md` | The eleven bounded contexts, their relationships, and translation points |
| `05-glossary.md` | The ubiquitous language; naming conventions; banned terms |
| `06-c4-context.md` | C4 L1: actors, external systems, the trust boundary |
| `07-c4-container.md` | C4 L2: the eleven containers; request plane vs execution plane |
| `08-c4-component.md` | C4 L3: gateway, AI Platform, the common engine anatomy, Knowledge Service |
| `09-request-flow.md` | The synchronous path: authN → tenancy → authZ → idempotency → credits → 202 → SSE |
| `10-event-flow.md` | The asynchronous plane: outbox, bus, delivery semantics, DLQ |
| `11-deployment-topology.md` | Where containers run: zones, instance shapes, failure domains, S1→S4 evolution |
| `12-architecture-decisions.md` | ADR process: significance test, template, lifecycle, authority, agent obligations |
| `13-adr-log.md` | ADR-001 … ADR-028 — the canonical register |
| `14-scoring-contract.md` | The Unified Scoring Contract (ADR-021): canonical `Score`, twelve categories, explainability, gate interface, versioning |
| `ADR-020-transactional-outbox.md` | Expanded record: transactional outbox with a swappable event bus |
| `ADR-027-durable-dead-letter-queue.md` | Expanded record: durable dead letter queue |
| `ADR-028-replay-coordination.md` | Expanded record: replay coordination |

**The log is authoritative for status.** The three expanded records above hold fuller context, trade-off, and cross-platform-impact detail than the log's house format allows; where status differs, `13-adr-log.md` wins.

## Scope boundaries

This folder owns architecture. It deliberately does not own:

| Concern | Owner |
|---|---|
| Release process, monitoring, incidents, backup, scaling thresholds | `14-operations/` |
| Security controls, RBAC, threat model, compliance | `16-security/` |
| Frontend architecture and design system | `15-application-ui/` |
| Entities, invariants, lifecycles | `02-domain-design/` |
| Physical schema | `03-database/` |

`11-deployment-topology.md` owns *where things run*; `14-operations/deployment.md` owns *how releases get there*. The two must not restate each other.
