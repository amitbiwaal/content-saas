# 10 — Operations

How ContentOS AI is released, watched, defended, restored, and scaled. Folder 01 defines what the system *is*; this folder defines how it *runs* in production. A build that satisfies every architectural rule and every gate in `10-testing/` is still not a product until the procedures here exist.

## Boundary with folder 01

`01-system-architecture/11-deployment-topology.md` owns the **deployment topology** — which components exist, how they connect, and the v1 Coolify → Kubernetes evolution path. This folder owns the **operational process** that acts on that topology: the release pipeline, migration and rollback mechanics, SLOs and alerting, incident command, backups and restore drills, and scaling triggers. Neither restates the other; where they touch, this folder links.

| File | Covers |
|---|---|
| `deployment.md` | Environments, CI/CD pipeline, migration strategy, feature flags, rollback, release verification |
| `monitoring.md` | SLOs and error budgets, the telemetry pipeline, metric catalogue, dashboards, alert routing |
| `incident-response.md` | Severity model, roles, response flow, ContentOS-specific playbooks, postmortems |
| `backup-recovery.md` | RPO/RTO per store, backup mechanics, restore drills, tenant-level and GDPR recovery |
| `scaling-strategy.md` | Capacity model, scaling triggers per component, the database ladder, cost per article, multi-region |

## Operating principles

1. **Every deploy is reversible within 10 minutes.** Schema changes use expand/contract so the previous application version always runs against the current schema (`deployment.md`).
2. **Alert on symptoms customers feel, not on causes.** Every page maps to an SLO or to a data-integrity invariant; everything else is a dashboard (`monitoring.md`).
3. **Cross-tenant data exposure is SEV1 by definition** — no debate, no triage delay (`incident-response.md`).
4. **A backup that has not been restored is a hypothesis.** Restore drills are scheduled and their results recorded (`backup-recovery.md`).
5. **Scale by trigger, not by intuition.** Every component has a documented metric and threshold at which it scales, and a documented next architectural step when scaling out stops working (`scaling-strategy.md`).
6. **Cost is an operational metric.** AI spend per article is monitored and alerted like latency, because it is the platform's dominant variable cost (§4.8).

Related: `10-testing/testing-strategy.md` defines the gate report this folder's release pipeline consumes; `10-testing/e2e-testing.md` supplies the post-deploy verification suite; `10-testing/ai-evaluation.md` supplies the quality drift signals that `monitoring.md` alerts on.
