"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import Shell from "../../components/Shell";
import { api } from "../../lib/api";
import { useLang } from "../../lib/i18n";
import type { Health, Project } from "../../lib/types";

export default function DashboardPage() {
  const { t } = useLang();
  const [health, setHealth] = useState<Health | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setError("Backend offline — start uvicorn on :8000"));
    api.listProjects().then(setProjects).catch(() => {});
  }, []);

  const metrics = [
    { label: "Projects", value: String(projects.length) },
    { label: "Published", value: String(projects.filter((p) => p.stage === "published").length) },
    { label: "Ready", value: String(projects.filter((p) => p.stage === "ready").length) },
    { label: "In editor", value: String(projects.filter((p) => p.stage === "editor").length) },
    { label: "Council seats", value: health ? String(Object.keys(health.providers).length) : "—" },
    { label: "Live keys", value: health ? String(Object.values(health.providers).filter((p) => p.key_configured).length) : "—" },
  ];

  return (
    <Shell
      title="Dashboard"
      status={
        <span className={`pill ${health ? "ok" : "warn"}`}>
          {health ? `backend ${health.version} · ${health.env}` : t("backend offline")}
        </span>
      }
    >
      {error && <p className="error">{t(error)}</p>}

      <section className="metrics">
        {metrics.map((m) => (
          <div className="card metric" key={m.label}>
            <div className="metric-value">{m.value}</div>
            <div className="metric-label">{t(m.label)}</div>
          </div>
        ))}
      </section>

      <section className="panel">
        <div className="panel-head">
          <h2>{t("Recent projects")}</h2>
          <Link className="btn" href="/chat">{t("+ New (chat)")}</Link>
        </div>
        {projects.length === 0 ? (
          <p className="muted">{t("No projects yet. Start one from the chat.")}</p>
        ) : (
          <div className="rows">
            {projects.slice(0, 8).map((p) => (
              <Link className="row" key={p.id} href={`/projects/${p.id}`}>
                <div>
                  <div className="row-title">{p.topic}</div>
                  <div className="row-sub">{p.website} · {p.keyword}</div>
                </div>
                <span className={`stage stage-${p.stage}`}>{t(p.stage)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>{t("Council seats")}</h2>
        {!health && !error && <p className="muted">{t("Loading…")}</p>}
        {health && (
          <div className="seats">
            {Object.entries(health.providers).map(([name, info]) => (
              <div className="card seat" key={name}>
                <div className="seat-head">
                  <span className="seat-name">{name}</span>
                  <span className={`tag ${info.policy_tier === "permissive" ? "tag-green" : "tag-blue"}`}>
                    {t(info.policy_tier)}
                  </span>
                </div>
                <div className="seat-model">{info.model}</div>
                <div className={`seat-key ${info.key_configured ? "live" : "mock"}`}>
                  {info.key_configured ? t("live key") : t("mock fallback")}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </Shell>
  );
}
