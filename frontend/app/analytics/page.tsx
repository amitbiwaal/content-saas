"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { api } from "../../lib/api";
import { useLang } from "../../lib/i18n";
import type { Analytics } from "../../lib/types";

export default function AnalyticsPage() {
  const { t } = useLang();
  const [a, setA] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getAnalytics().then(setA).catch((e) => setError(String(e)));
  }, []);

  if (error) return <Shell title={t("Analytics")}><p className="error">{error}</p></Shell>;
  if (!a) return <Shell title={t("Analytics")}><p className="muted">{t("Loading…")}</p></Shell>;

  const c = a.cost;
  return (
    <Shell title={t("Analytics")}>
      <section className="metrics">
        <div className="card metric"><div className="metric-value">${c.total_usd.toFixed(2)}</div><div className="metric-label">{t("Total AI cost")}</div></div>
        <div className="card metric"><div className="metric-value">{c.total_tokens.toLocaleString("en-US")}</div><div className="metric-label">{t("Tokens used")}</div></div>
        <div className="card metric"><div className="metric-value">{a.traffic.organic_visits_30d.toLocaleString("en-US")}</div><div className="metric-label">{t("Organic visits (30d)")}</div></div>
        <div className="card metric"><div className="metric-value">{a.traffic.ai_citations}</div><div className="metric-label">{t("AI citations")}</div></div>
        <div className="card metric"><div className="metric-value">{a.decay_alerts.length}</div><div className="metric-label">{t("Decay alerts")}</div></div>
      </section>

      <section className="panel">
        <h2>{t("Monthly budget (PRD §13)")}</h2>
        <p className="muted small">${(c.total_cents / 100).toFixed(2)} of ${(c.monthly_budget_cents / 100).toFixed(0)} budget · per-article ceiling ${(c.per_article_ceiling_cents / 100).toFixed(0)}</p>
        <div className="budget-bar">
          <span className={c.budget_used_pct >= 90 ? "over" : ""} style={{ width: `${Math.min(100, c.budget_used_pct)}%` }} />
        </div>
        <div className="muted small">{c.budget_used_pct}% used{c.total_cents === 0 ? t(" — mock seats are free; cost accrues once real provider keys are set") : ""}</div>
      </section>

      <section className="panel">
        <h2>{t("Cost & traffic by project")}</h2>
        {a.projects.length === 0 ? <p className="muted">{t("No projects yet.")}</p> : (
          <div className="rows">
            {a.projects.map((p) => (
              <Link className="row" key={p.project_id} href={`/projects/${p.project_id}`}>
                <div>
                  <div className="row-title">{p.topic}</div>
                  <div className="row-sub">{p.tokens.toLocaleString("en-US")} tokens · {p.organic_visits_30d.toLocaleString("en-US")} visits/30d</div>
                </div>
                <span className="lab lab-blue">${(p.cost_cents / 100).toFixed(2)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {a.decay_alerts.length > 0 && (
        <section className="panel">
          <h2>{t("Content-decay alerts (FR-12.2)")}</h2>
          <div className="rows">
            {a.decay_alerts.map((d) => (
              <Link className="row" key={d.project_id} href={`/projects/${d.project_id}`}>
                <div>
                  <div className="row-title">{d.topic}</div>
                  <div className="row-sub">{d.suggestion}</div>
                </div>
                <span className="lab lab-red">−{d.drop_pct}%</span>
              </Link>
            ))}
          </div>
        </section>
      )}
    </Shell>
  );
}
