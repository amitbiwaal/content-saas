"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import PipelineStepper, {
  PIPELINE_STAGES,
  type StageStatus,
} from "../../../components/PipelineStepper";
import Shell from "../../../components/Shell";
import DecisionButtons from "../../../components/DecisionButtons";
import { useLang } from "../../../lib/i18n";
import { api } from "../../../lib/api";
import { stepOf } from "../../../lib/run";
import type {
  AgentReport,
  Claim,
  Decision,
  Draft,
  PipelineSummary,
  Project,
  Scores,
} from "../../../lib/types";

// Gate targets (PRD §10). Spam is "lower is better".
const TARGETS: Record<keyof Scores, number> = {
  seo: 85, aeo: 85, geo: 80, heo: 85, eeat: 80, fact: 80, spam: 25, originality: 70, publish: 85,
};
const scoreOk = (axis: keyof Scores, v: number) =>
  axis === "spam" ? v < TARGETS[axis] : v >= TARGETS[axis];

const PROVIDER_TINT: Record<string, string> = {
  openai: "tint-green",
  anthropic: "tint-purple",
  google: "tint-blue",
  xai: "tint-amber",
  mock: "tint-gray",
};

const emptyStatus = (): Record<string, StageStatus> =>
  Object.fromEntries(PIPELINE_STAGES.map((s) => [s.key, "pending"]));

export default function ProjectDetailPage() {
  const { t } = useLang();
  const params = useParams<{ id: string }>();
  const id = params.id;

  const [project, setProject] = useState<Project | null>(null);
  const [summary, setSummary] = useState<PipelineSummary | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);

  // Live streaming state
  const [streaming, setStreaming] = useState(false);
  const [stageStatus, setStageStatus] = useState<Record<string, StageStatus>>(emptyStatus());
  const [liveReports, setLiveReports] = useState<AgentReport[]>([]);
  const [liveDecisions, setLiveDecisions] = useState<Decision[]>([]);
  const [conflicts, setConflicts] = useState(0);
  const [strategy, setStrategy] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [rerunning, setRerunning] = useState(false);
  const [wpOpen, setWpOpen] = useState(false);
  const [wp, setWp] = useState({ site_url: "", username: "", app_password: "", schedule: "", meta_description: "" });
  const [wpBusy, setWpBusy] = useState(false);
  const [wpResult, setWpResult] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const loadArtifacts = useCallback(async () => {
    api.getDecisions(id).then(setLiveDecisions).catch(() => {});
    api.getDebate(id).then((d) => { setLiveReports(d.reports || []); setConflicts((d.conflicts || []).length); }).catch(() => {});
    api.getDraft(id).then(setDraft).catch(() => setDraft(null));
    api.getClaims(id).then(setClaims).catch(() => {});
  }, [id]);

  useEffect(() => {
    api.getProject(id).then(setProject).catch((e) => setError(String(e)));
    loadArtifacts();
    return () => esRef.current?.close();
  }, [id, loadArtifacts]);

  function runStream() {
    esRef.current?.close();
    setError(null);
    setStreaming(true);
    setSummary(null);
    setStageStatus(emptyStatus());
    setLiveReports([]);
    setLiveDecisions([]);
    setConflicts(0);
    setStrategy("");

    const es = new EventSource(api.streamUrl(id));
    esRef.current = es;
    let finished = false;

    es.addEventListener("stage", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      // Map backend stage keys onto the stepper's step keys (the four
      // verification stages collapse into "checks" — see lib/run.ts).
      setStageStatus((prev) => ({ ...prev, [stepOf(d.stage)]: d.status === "start" ? "running" : "done" }));
      if (d.stage === "council" && d.status === "done" && d.info?.strategy_summary) {
        setStrategy(d.info.strategy_summary);
      }
    });
    es.addEventListener("report", (e) => {
      const d = JSON.parse((e as MessageEvent).data) as AgentReport;
      setLiveReports((prev) => [...prev, d]);
    });
    es.addEventListener("conflict", () => setConflicts((c) => c + 1));
    es.addEventListener("decision", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setLiveDecisions((prev) => [...prev, { id: "", overridden_by: null, ...d }]);
    });
    es.addEventListener("done", (e) => {
      finished = true;
      const s = JSON.parse((e as MessageEvent).data) as PipelineSummary;
      setSummary(s);
      setStrategy(s.council.strategy_summary);
      setStageStatus(Object.fromEntries(PIPELINE_STAGES.map((st) => [st.key, "done"])));
      es.close();
      setStreaming(false);
      api.getProject(id).then(setProject).catch(() => {});
      loadArtifacts(); // reload persisted (id'd) decisions so override works
    });
    es.addEventListener("error", (e) => {
      try { setError(JSON.parse((e as MessageEvent).data).detail); } catch { /* close */ }
    });
    es.onerror = () => {
      if (!finished) {
        setError(t("Live stream disconnected — retry the run."));
        es.close();
        setStreaming(false);
      }
    };
  }

  async function overrideDecision(decisionId: string, label: string) {
    if (!decisionId) return;
    try {
      const updated = await api.updateDecision(id, decisionId, { label });
      setLiveDecisions((prev) => prev.map((d) => (d.id === decisionId ? { ...d, ...updated } : d)));
    } catch (e) {
      setError(String(e));
    }
  }

  async function publishWp() {
    setWpBusy(true);
    setWpResult(null);
    try {
      const res = await api.publishWordpress(id, {
        creds: { site_url: wp.site_url, username: wp.username, app_password: wp.app_password },
        schedule: wp.schedule || null,
        seo: { focus_keyword: project?.keyword, meta_description: wp.meta_description },
        status: wp.schedule ? "future" : "publish",
      });
      setWpResult(JSON.stringify(res, null, 2));
    } catch (e) {
      setWpResult(String(e));
    } finally {
      setWpBusy(false);
    }
  }

  async function rerunCouncil() {
    setRerunning(true);
    setError(null);
    try {
      await api.rerunCouncil(id);
      await loadArtifacts();
      api.getProject(id).then(setProject).catch(() => {});
    } catch (e) {
      setError(String(e));
    } finally {
      setRerunning(false);
    }
  }

  if (error && !project) return <Shell title={t("Project")}><p className="error">{error}</p></Shell>;
  if (!project) return <Shell title={t("Project")}><p className="muted">{t("Loading…")}</p></Shell>;

  const showStepper = streaming || summary;

  return (
    <Shell
      title={project.topic}
      status={<span className={`stage stage-${project.stage}`}>{project.stage}</span>}
    >
      <p className="muted sub">{project.website} · {project.keyword} · {project.country}</p>

      <div className="actions">
        <a className="btn btn-primary" href={`/projects/${id}/journey?run=1`}>{t("🗺 Open Journey (live)")}</a>
        <a className="btn" href={`/projects/${id}/review`}>{t("🔍 Review mode (step-by-step)")}</a>
        <button className="btn" onClick={runStream} disabled={streaming}>
          {streaming ? t("Running…") : t("▶ Run here")}
        </button>
        {draft && !streaming && (
          <>
            <a className="btn btn-primary" href={`/projects/${id}/editor`}>{t("✎ Open editor")}</a>
            <a className="btn" href={api.exportUrl(id, "markdown")} target="_blank" rel="noreferrer">{t("Export MD")}</a>
            <a className="btn" href={api.exportUrl(id, "html")} target="_blank" rel="noreferrer">{t("Export HTML")}</a>
            <a className="btn" href={api.exportUrl(id, "jsonld")} target="_blank" rel="noreferrer">{t("JSON-LD")}</a>
          </>
        )}
      </div>
      {error && <p className="error">{error}</p>}

      {/* WordPress publish (PRD §15) — gate-enforced server-side */}
      {draft && !streaming && (
        <section className="panel wp-panel">
          <div className="panel-head">
            <h2>{t("Publish to WordPress")}</h2>
            <button className="btn btn-sm" onClick={() => setWpOpen((o) => !o)}>{wpOpen ? t("Hide") : t("Configure")}</button>
          </div>
          {wpOpen && (
            <>
              <p className="muted small">{t("Posts Gutenberg blocks + RankMath/Yoast SEO. Leave blank to dry-run. The publish gate must pass (server-enforced).")}</p>
              <div className="wp-form">
                <label>{t("Site URL")}<input value={wp.site_url} onChange={(e) => setWp({ ...wp, site_url: e.target.value })} placeholder="https://blog.example.com" /></label>
                <label>{t("Username")}<input value={wp.username} onChange={(e) => setWp({ ...wp, username: e.target.value })} placeholder={t("editor")} /></label>
                <label>{t("App password")}<input type="password" value={wp.app_password} onChange={(e) => setWp({ ...wp, app_password: e.target.value })} placeholder="xxxx xxxx xxxx" /></label>
                <label>{t("Schedule (optional)")}<input type="datetime-local" value={wp.schedule} onChange={(e) => setWp({ ...wp, schedule: e.target.value })} /></label>
                <label>{t("Meta description")}<input value={wp.meta_description} onChange={(e) => setWp({ ...wp, meta_description: e.target.value })} placeholder={t("SEO meta description")} /></label>
              </div>
              <button className="btn btn-primary" onClick={publishWp} disabled={wpBusy}>
                {wpBusy ? t("Publishing…") : wp.schedule ? t("Schedule post") : (wp.site_url ? t("Publish now") : t("Dry run"))}
              </button>
              {wpResult && <pre className="wp-result">{wpResult}</pre>}
            </>
          )}
        </section>
      )}

      {/* Live pipeline stepper */}
      {showStepper && (
        <section className="panel fade-in">
          <PipelineStepper status={stageStatus} />
        </section>
      )}

      {/* Scores + gate (after done) */}
      {summary && (
        <section className="panel fade-in">
          <div className="panel-head">
            <h2>{t("Scores & publish gate")}</h2>
            <span className={`pill ${summary.gate.passed ? "ok" : "warn"}`}>
              {summary.gate.passed ? t("READY — gate passed") : t("BLOCKED by gate")}
            </span>
          </div>
          <div className="scoregrid">
            {(Object.keys(TARGETS) as (keyof Scores)[]).map((axis) => {
              const v = summary.scores[axis];
              const ok = scoreOk(axis, v);
              return (
                <div className={`scorecell ${ok ? "good" : "bad"}`} key={axis}>
                  <div className="score-num">{v}</div>
                  <div className="score-bar"><span style={{ width: `${Math.min(v, 100)}%` }} /></div>
                  <div className="score-axis">{axis.toUpperCase()}</div>
                </div>
              );
            })}
          </div>
          {!summary.gate.passed && (
            <ul className="reasons">{summary.gate.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          )}
          <div className="subgrid">
            <div className="card mini">
              <h3>{t("House rules")}</h3>
              <span className={`pill ${summary.compliance.passed ? "ok" : "warn"}`}>
                {summary.compliance.passed ? t("passed") : `${summary.compliance.violations} violation(s)`}
              </span>
            </div>
            <div className="card mini">
              <h3>{t("Fact check")}</h3>
              <div className="muted">{summary.factcheck.claims} claims · {summary.factcheck.high_risk_unsupported} high-risk</div>
            </div>
            <div className="card mini">
              <h3>{t("Draft")}</h3>
              <div className="muted">{summary.draft.sections} sections · {summary.draft.word_count} words · v{summary.draft.version}</div>
            </div>
          </div>
          {summary.top_fixes.length > 0 && (
            <>
              <h3 className="mt">{t("Highest-impact fixes")}</h3>
              <ul className="fixes">
                {summary.top_fixes.map((f, i) => (
                  <li key={i}><b>{f.axis.toUpperCase()} (+{f.est_gain})</b> — {f.fix}</li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {/* Debate Room — chat-style thread */}
      {(liveReports.length > 0 || liveDecisions.length > 0) && (
        <section className="panel fade-in">
          <div className="panel-head">
            <h2>{t("AI Debate Room")}</h2>
            <div className="actions" style={{ margin: 0 }}>
              {conflicts > 0 && <span className="pill conflict-pill">⚔ {conflicts} conflict{conflicts > 1 ? "s" : ""}</span>}
              {!streaming && (
                <button className="btn btn-sm" onClick={rerunCouncil} disabled={rerunning}>
                  {rerunning ? t("Re-running…") : t("↻ Re-run council")}
                </button>
              )}
            </div>
          </div>
          {strategy && <p className="muted">{t("Judge strategy:")} {strategy}</p>}
          <div className="thread">
            {liveReports.map((r, i) => (
              <div className={`agent-card ${PROVIDER_TINT[r.provider] || "tint-gray"} fade-in`} key={i}>
                <div className="agent-head">
                  <span className="agent-avatar">{r.provider.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <div className="agent-role">{r.role.replace(/_/g, " ")}</div>
                    <div className="agent-meta">
                      {r.provider} · {r.model}
                      {r.routed_from && <span className="routed"> · failed over from {r.routed_from}</span>}
                    </div>
                  </div>
                </div>
                <ul className="recs">{r.recommendations.slice(0, 4).map((rec, j) => <li key={j}>{rec}</li>)}</ul>
              </div>
            ))}
          </div>

          {liveDecisions.length > 0 && (
            <>
              <h3 className="mt">{t("⚖ Judge decisions")}</h3>
              <div className="rows">
                {liveDecisions.map((d, i) => (
                  <div className="row decision fade-in" key={d.id || i}>
                    <div>
                      <div className="row-title">{d.point}</div>
                      <div className="row-sub">{d.source}{d.reason ? ` — ${d.reason}` : ""}</div>
                    </div>
                    <div className="decision-override" title={d.id ? undefined : t("Re-run to enable override")}>
                      {d.overridden_by && <span className="overridden">{t("overridden")}</span>}
                      <DecisionButtons
                        value={d.label}
                        disabled={!d.id}
                        onSelect={(label) => overrideDecision(d.id, label)}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      )}

      {/* Draft */}
      {draft?.sections?.length ? (
        <section className="panel fade-in">
          <h2>{t("Draft")}</h2>
          <div className="draft">
            {draft.sections.map((s, i) => (
              <div key={i}>
                <div className={`h h${s.level}`}>{s.heading}</div>
                <p className="body">{s.markdown}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {/* Claims */}
      {claims.length > 0 && (
        <section className="panel fade-in">
          <h2>{t("Fact-check claims")}</h2>
          <div className="rows">
            {claims.map((c, i) => (
              <div className="row" key={c.id || i}>
                <div>
                  <div className="row-title">{c.text}</div>
                  <div className="row-sub">{c.source ? `source: ${c.source}` : t("no source")}</div>
                </div>
                <span className={`lab risk-${c.risk}`}>{c.risk}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </Shell>
  );
}
