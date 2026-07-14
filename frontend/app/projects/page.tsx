"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import Shell from "../../components/Shell";
import { api } from "../../lib/api";
import type { Project } from "../../lib/types";
import { useLang } from "../../lib/i18n";

const STAGES = ["all", "research", "council", "editor", "ready", "published"];

export default function ProjectsPage() {
  const { t } = useLang();
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("all");

  useEffect(() => {
    api.listProjects().then(setProjects).catch((e) => setError(String(e)));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return projects.filter((p) => {
      const matchesQ = !q || `${p.topic} ${p.website} ${p.keyword}`.toLowerCase().includes(q);
      const matchesStage = stage === "all" || p.stage === stage;
      return matchesQ && matchesStage;
    });
  }, [projects, query, stage]);

  return (
    <Shell title={t("Projects")} status={<Link className="btn" href="/chat">{t("+ New (chat)")}</Link>}>
      <div className="toolbar">
        <input
          className="search"
          placeholder={t("Search topic, website, keyword…")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="filter-chips">
          {STAGES.map((s) => (
            <button
              key={s}
              className={`fchip ${stage === s ? "active" : ""}`}
              onClick={() => setStage(s)}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="error">{error}</p>}
      {filtered.length === 0 ? (
        <p className="muted">{t("No matching projects.")}</p>
      ) : (
        <div className="rows">
          {filtered.map((p) => (
            <Link className="row" key={p.id} href={`/projects/${p.id}`}>
              <div>
                <div className="row-title">{p.topic}</div>
                <div className="row-sub">{p.website} · {p.keyword} · {p.country}</div>
              </div>
              <span className={`stage stage-${p.stage}`}>{p.stage}</span>
            </Link>
          ))}
        </div>
      )}
    </Shell>
  );
}
