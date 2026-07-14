"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import Shell from "../../../../components/Shell";
import Markdown from "../../../../components/Markdown";
import { api } from "../../../../lib/api";
import { useLang } from "../../../../lib/i18n";
import type {
  AgentReport, Checkpoints, CompetitorAnalysis, Decision, Draft, GatedStage,
  Outline, OutlineNode, Project, Research, Scores,
} from "../../../../lib/types";

// The four human-gated stages, in order (mirrors backend GATED_STAGES).
const STAGES: { key: GatedStage; num: number; title: string; run: string }[] = [
  { key: "research", num: 1, title: "Research Intelligence", run: "Run research" },
  { key: "council", num: 2, title: "Council Debate + Judge", run: "Convene council" },
  { key: "outline", num: 3, title: "Outline", run: "Build outline" },
  { key: "draft", num: 4, title: "Draft", run: "Write draft" },
];

const TARGETS: Record<keyof Scores, number> = {
  seo: 85, aeo: 85, geo: 80, heo: 85, eeat: 80, fact: 80, spam: 25, originality: 70, publish: 85,
};
const scoreOk = (a: keyof Scores, v: number) => (a === "spam" ? v < TARGETS[a] : v >= TARGETS[a]);
const PROVIDER_TINT: Record<string, string> = {
  openai: "tint-green", anthropic: "tint-purple", google: "tint-blue", xai: "tint-amber", mock: "tint-gray",
};
const LABEL_CLASS: Record<string, string> = {
  accepted: "lab-green", rejected: "lab-red", needs_evidence: "lab-amber", merge: "lab-blue", manual_review: "lab-purple",
};
const LABELS = Object.keys(LABEL_CLASS);

type StageState = "locked" | "idle" | "pending" | "approved";

function OutlineTree({ nodes }: { nodes: OutlineNode[] }) {
  return (
    <ul className="otree">
      {nodes.map((n, i) => (
        <li key={i} className={`olevel-${(n.level || "H2").toLowerCase()}`}>
          <span className="otag">{n.level}</span> {n.text}
          {n.children?.length ? <OutlineTree nodes={n.children} /> : null}
        </li>
      ))}
    </ul>
  );
}

export default function ReviewPage() {
  const { t } = useLang();
  const { id } = useParams<{ id: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [checkpoints, setCheckpoints] = useState<Checkpoints>({});
  const [next, setNext] = useState<GatedStage | null>("research");
  const [research, setResearch] = useState<Research | null>(null);
  const [competitors, setCompetitors] = useState<CompetitorAnalysis | null>(null);
  const [reports, setReports] = useState<AgentReport[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [conflicts, setConflicts] = useState(0);
  const [strategy, setStrategy] = useState("");
  const [outline, setOutline] = useState<Outline | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [scores, setScores] = useState<Scores | null>(null);
  const [gate, setGate] = useState<{ passed: boolean; reasons: string[] } | null>(null);
  const [claims, setClaims] = useState<number | null>(null);

  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadCheckpoints = useCallback(async () => {
    const cp = await api.getCheckpoints(id);
    setCheckpoints(cp.checkpoints || {});
    setNext(cp.next);
  }, [id]);

  const reloadAll = useCallback(async () => {
    await reloadCheckpoints().catch(() => {});
    api.getResearch(id).then(setResearch).catch(() => {});
    api.getCompetitors(id).then(setCompetitors).catch(() => setCompetitors(null));
    api.getOutline(id).then(setOutline).catch(() => setOutline(null));
    api.getDraft(id).then(setDraft).catch(() => setDraft(null));
    api.getDecisions(id).then(setDecisions).catch(() => {});
    api.getDebate(id).then((d) => {
      setReports(d.reports || []);
      setConflicts((d.conflicts || []).length);
    }).catch(() => {});
    api.getScores(id).then((rows) => { if (rows[0]) setScores(rows[0]); }).catch(() => {});
  }, [id, reloadCheckpoints]);

  useEffect(() => {
    api.getProject(id).then(setProject).catch((e) => setError(String(e)));
    reloadAll();
  }, [id, reloadAll]);

  // Derive each stage's gate state from the approval ledger.
  function stateOf(stage: GatedStage): StageState {
    const entry = checkpoints[stage];
    if (entry?.status === "approved") return "approved";
    if (entry?.status === "pending") return "pending";
    const idx = STAGES.findIndex((s) => s.key === stage);
    const priorApproved = STAGES.slice(0, idx).every(
      (s) => checkpoints[s.key]?.status === "approved"
    );
    return priorApproved ? "idle" : "locked";
  }

  async function runStage(stage: GatedStage) {
    setBusy(stage);
    setError(null);
    const fb = (feedback[stage] || "").trim() || null;
    try {
      if (stage === "research") await api.runResearch(id, fb);
      else if (stage === "council") await api.rerunCouncil(id, fb);
      else if (stage === "outline") await api.runOutline(id, fb);
      else if (stage === "draft") await api.runDraft(id, fb);
      setFeedback((f) => ({ ...f, [stage]: "" }));
      await reloadAll();
      api.getProject(id).then(setProject).catch(() => {});
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  }

  async function approve(stage: GatedStage) {
    setBusy(`${stage}:approve`);
    setError(null);
    try {
      const cp = await api.approveStage(id, stage);
      setCheckpoints(cp.checkpoints || {});
      setNext(cp.next);
      api.getProject(id).then(setProject).catch(() => {});
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  }

  async function overrideDecision(decisionId: string, label: string) {
    if (!decisionId) return;
    try {
      const u = await api.updateDecision(id, decisionId, { label });
      setDecisions((p) => p.map((d) => (d.id === decisionId ? { ...d, ...u } : d)));
    } catch (e) { setError(String(e)); }
  }

  async function finalize() {
    setBusy("finalize");
    setError(null);
    try {
      const fc = await api.runFactcheck(id);
      setClaims(fc.claims.length);
      const sr = await api.runScores(id);
      setScores(sr.scores);
      setGate(sr.gate);
      api.getProject(id).then(setProject).catch(() => {});
    } catch (e) { setError(String(e)); } finally { setBusy(null); }
  }

  const allApproved = next === null && STAGES.every((s) => checkpoints[s.key]?.status === "approved");

  if (error && !project) return <Shell title="Review"><p className="error">{error}</p></Shell>;
  if (!project) return <Shell title="Review"><p className="muted">{t("Loading…")}</p></Shell>;

  return (
    <Shell
      title="Review mode"
      status={
        <div className="actions" style={{ margin: 0 }}>
          <span className={`stage stage-${project.stage}`}>{project.stage}</span>
          <Link className="btn" href={`/projects/${id}/journey?run=1`}>{t("⚡ Auto-run instead")}</Link>
        </div>
      }
    >
      <p className="muted sub">{project.topic} · {project.website} · {project.keyword}</p>
      <p className="muted" style={{ marginTop: -4 }}>
        {t("Step-by-step: verify each stage, then Approve to unlock the next — or Regenerate with feedback.")}
      </p>
      {error && <p className="error">{error}</p>}

      {/* Progress rail */}
      <div className="rv-rail">
        {STAGES.map((s) => {
          const st = stateOf(s.key);
          return (
            <div key={s.key} className={`rv-railstep rv-${st}`}>
              <span className="rv-raildot">{st === "approved" ? "✓" : s.num}</span>
              <span>{t(s.title.split(" ")[0])}</span>
            </div>
          );
        })}
        <div className={`rv-railstep ${allApproved ? "rv-idle" : "rv-locked"}`}>
          <span className="rv-raildot">✓</span><span>{t("Finalize")}</span>
        </div>
      </div>

      {/* Competitor panel — "what are competitors doing" + our coverage gaps */}
      {research && competitors && (
        <CompetitorPanel c={competitors} t={t} />
      )}

      {/* Gated stage cards */}
      {STAGES.map((s) => {
        const st = stateOf(s.key);
        const isCurrent = next === s.key;
        return (
          <section
            key={s.key}
            className={`panel rv-stage rv-stage-${st} ${isCurrent ? "rv-current" : ""} fade-in`}
          >
            <div className="panel-head">
              <h2>
                <span className="rv-num">{st === "approved" ? "✓" : s.num}</span> {t(s.title)}
              </h2>
              <span className={`pill rv-badge rv-badge-${st}`}>
                {st === "approved" ? t("approved") : st === "pending" ? t("needs review") : st === "locked" ? t("locked") : t("ready")}
              </span>
            </div>

            {st === "locked" ? (
              <p className="muted">{t("Approve the previous stage to unlock this.")}</p>
            ) : (
              <>
                {/* Stage body */}
                {s.key === "research" && <ResearchBody research={research} t={t} />}
                {s.key === "council" && (
                  <CouncilBody
                    reports={reports} decisions={decisions} conflicts={conflicts}
                    strategy={strategy} onOverride={overrideDecision} t={t}
                  />
                )}
                {s.key === "outline" && <OutlineBody outline={outline} t={t} />}
                {s.key === "draft" && <DraftBody draft={draft} t={t} />}

                {/* Controls: feedback + run/regenerate + approve */}
                <div className="rv-controls">
                  <textarea
                    className="rv-feedback"
                    placeholder={t("Optional feedback to steer a regenerate (e.g. \"add a pricing comparison\", \"tone down claims\")…")}
                    value={feedback[s.key] || ""}
                    onChange={(e) => setFeedback((f) => ({ ...f, [s.key]: e.target.value }))}
                  />
                  <div className="rv-btns">
                    <button
                      className="btn"
                      onClick={() => runStage(s.key)}
                      disabled={busy === s.key}
                    >
                      {busy === s.key
                        ? t("Working…")
                        : st === "idle"
                          ? t(s.run)
                          : t("↻ Regenerate")}
                    </button>
                    {(st === "pending" || st === "approved") && (
                      <button
                        className={`btn ${st === "pending" ? "btn-primary" : ""}`}
                        onClick={() => approve(s.key)}
                        disabled={busy === `${s.key}:approve` || st === "approved"}
                      >
                        {st === "approved" ? t("✓ Approved") : busy === `${s.key}:approve` ? t("…") : t("✓ Approve & continue")}
                      </button>
                    )}
                  </div>
                </div>
                {checkpoints[s.key]?.feedback && (
                  <p className="muted small rv-lastfb">{t("Last feedback:")} “{checkpoints[s.key]?.feedback}”</p>
                )}
              </>
            )}
          </section>
        );
      })}

      {/* Finalize — auto stages after draft sign-off */}
      <section className={`panel rv-stage ${allApproved ? "rv-current" : "rv-stage-locked"} fade-in`}>
        <div className="panel-head">
          <h2><span className="rv-num">✓</span> {t("Finalize — fact-check, scores & publish gate")}</h2>
          {gate && <span className={`pill ${gate.passed ? "ok" : "warn"}`}>{gate.passed ? t("READY") : t("BLOCKED")}</span>}
        </div>
        {!allApproved ? (
          <p className="muted">{t("Approve all four stages above to run the final checks.")}</p>
        ) : (
          <>
            <button className="btn btn-primary" onClick={finalize} disabled={busy === "finalize"}>
              {busy === "finalize" ? t("Scoring…") : t("Run fact-check + scoring + gate")}
            </button>
            {scores && (
              <div className="scoregrid" style={{ marginTop: 14 }}>
                {(Object.keys(TARGETS) as (keyof Scores)[]).map((a) => {
                  const v = scores[a]; const ok = scoreOk(a, v);
                  return (
                    <div className={`scorecell ${ok ? "good" : "bad"}`} key={a}>
                      <div className="score-num">{v}</div>
                      <div className="score-bar"><span style={{ width: `${Math.min(v, 100)}%` }} /></div>
                      <div className="score-axis">{a.toUpperCase()}</div>
                    </div>
                  );
                })}
              </div>
            )}
            {claims != null && <p className="muted" style={{ marginTop: 8 }}>{t("Fact-check:")} {claims} {t("claims graded")}</p>}
            {gate && !gate.passed && <ul className="reasons">{gate.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
            {gate && gate.passed && draft && (
              <div className="run-chips" style={{ marginTop: 12 }}>
                <Link className="chip" href={`/projects/${id}/editor`}>{t("✎ Open editor")}</Link>
                <a className="chip" href={api.exportUrl(id, "markdown")} target="_blank" rel="noreferrer">⬇ MD</a>
                <a className="chip" href={api.exportUrl(id, "html")} target="_blank" rel="noreferrer">⬇ HTML</a>
              </div>
            )}
          </>
        )}
      </section>
    </Shell>
  );
}

// --------------------------------------------------------------------------- #
// Competitor panel — SERP rivals + outline coverage gaps
// --------------------------------------------------------------------------- #
function CompetitorPanel({ c, t }: { c: CompetitorAnalysis; t: (s: string) => string }) {
  return (
    <section className="panel rv-comp fade-in">
      <div className="panel-head">
        <h2>{t("🔭 Competitors — what they cover")}</h2>
        {c.competitor_headings.length > 0 && (
          <span className={`pill ${c.coverage_pct >= 60 ? "ok" : "warn"}`}>
            {t("coverage")} {c.coverage_pct}%
          </span>
        )}
      </div>
      {c.competitors.length > 0 && (
        <div className="rv-serp">
          {c.competitors.slice(0, 5).map((s, i) => (
            <div className="serp-item" key={i}>
              <span className="serp-rank">{s.rank}</span>
              <div>
                <a href={s.url} target="_blank" rel="noreferrer">{s.title || s.domain}</a>
                <div className="serp-meta">{s.domain}</div>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="rv-gapgrid">
        <div>
          <div className="rsub">{t("⚠ Gaps — rivals cover, we don't")} ({c.gaps.length})</div>
          {c.gaps.length ? (
            <div className="chips">{c.gaps.map((g, i) => <span className="chip-gap" key={i}>{g}</span>)}</div>
          ) : <p className="muted small">{t("No gaps — outline covers every competitor subtopic.")}</p>}
        </div>
        <div>
          <div className="rsub">{t("✓ Covered")} ({c.covered.length})</div>
          {c.covered.length ? (
            <div className="chips">{c.covered.map((g, i) => <span className="chip-cov" key={i} title={`${t("matched by")}: ${g.matched_by}`}>{g.heading}</span>)}</div>
          ) : <p className="muted small">{t("Build the outline to see coverage.")}</p>}
        </div>
        {c.extra.length > 0 && (
          <div>
            <div className="rsub">{t("★ Our edge — we cover, rivals don't")} ({c.extra.length})</div>
            <div className="chips">{c.extra.map((g, i) => <span className="chip-edge" key={i}>{g}</span>)}</div>
          </div>
        )}
      </div>
    </section>
  );
}

// --------------------------------------------------------------------------- #
// Stage bodies
// --------------------------------------------------------------------------- #
function ResearchBody({ research: r, t }: { research: Research | null; t: (s: string) => string }) {
  if (!r) return <p className="muted">{t("Not gathered yet — run research to fetch SERP, PAA, entities & sources.")}</p>;
  return (
    <div className="rgrid">
      <div className="rblock">
        <div className="rsub">{t("Intent")}</div>
        <span className="tag tag-blue">{r.intent}</span>
        <div className="rsub" style={{ marginTop: 10 }}>{t("Top SERP")} ({r.serp.length})</div>
        {r.serp.slice(0, 4).map((s, i) => (
          <div className="serp-item" key={i}>
            <span className="serp-rank">{s.rank ?? i + 1}</span>
            <div><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a><div className="serp-meta">{s.domain}</div></div>
          </div>
        ))}
      </div>
      <div className="rcol">
        <div className="rblock">
          <div className="rsub">{t("People Also Ask")} ({r.paa.length})</div>
          <ul className="rlist">{r.paa.slice(0, 5).map((q, i) => <li key={i}>{q}</li>)}</ul>
        </div>
        <div className="rblock">
          <div className="rsub">{t("Entities")}</div>
          <div className="chips">{r.entities.slice(0, 8).map((e, i) => <span className="chip-e" key={i}>{e.name}</span>)}</div>
        </div>
        <div className="rblock">
          <div className="rsub">{t("Sources")} ({r.sources.length})</div>
          <ul className="rlist">{r.sources.map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a></li>)}</ul>
        </div>
      </div>
    </div>
  );
}

function CouncilBody({
  reports, decisions, conflicts, strategy, onOverride, t,
}: {
  reports: AgentReport[]; decisions: Decision[]; conflicts: number; strategy: string;
  onOverride: (id: string, label: string) => void; t: (s: string) => string;
}) {
  if (!reports.length && !decisions.length)
    return <p className="muted">{t("Council has not run yet — convene to get four models debating.")}</p>;
  return (
    <>
      {conflicts > 0 && <span className="pill conflict-pill">⚔ {conflicts} {t("conflict")}{conflicts > 1 ? "s" : ""}</span>}
      <div className="arena" style={{ marginTop: 10 }}>
        {reports.map((r, i) => (
          <div className={`arena-box ${PROVIDER_TINT[r.provider] || "tint-gray"} done`} key={i}>
            <div className="arena-box-head">
              <span className="agent-avatar">{r.provider.slice(0, 2).toUpperCase()}</span>
              <div>
                <div className="agent-role">{r.role.replace(/_/g, " ")}</div>
                <div className="agent-meta">{r.provider}{r.model ? ` · ${r.model}` : ""}{r.confidence != null ? ` · conf ${r.confidence}` : ""}</div>
              </div>
            </div>
            <ul className="recs">{r.recommendations.slice(0, 4).map((rec, j) => <li key={j}>{rec}</li>)}</ul>
          </div>
        ))}
      </div>
      {decisions.length > 0 && (
        <>
          <h3 className="mt">{t("⚖ Judge decisions")}</h3>
          {strategy && <p className="muted">{t("Strategy:")} {strategy}</p>}
          <div className="rows">
            {decisions.map((d, i) => (
              <div className="row decision" key={d.id || i}>
                <div>
                  <div className="row-title">{d.point}</div>
                  <div className="row-sub">{d.source}{d.reason ? ` — ${d.reason}` : ""}</div>
                </div>
                <div className="decision-override">
                  {d.overridden_by && <span className="overridden">{t("overridden")}</span>}
                  <select
                    className={`lab-select ${LABEL_CLASS[d.label] || "lab-blue"}`}
                    value={d.label} disabled={!d.id}
                    onChange={(e) => onOverride(d.id, e.target.value)}
                  >
                    {LABELS.map((l) => <option key={l} value={l}>{t(l.replace(/_/g, " "))}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}

function OutlineBody({ outline, t }: { outline: Outline | null; t: (s: string) => string }) {
  if (!outline?.nodes?.length) return <p className="muted">{t("No outline yet — build it from the approved council strategy.")}</p>;
  return (
    <>
      <OutlineTree nodes={outline.nodes} />
      {(outline.elements || []).length > 0 && (
        <div className="chips" style={{ marginTop: 10 }}>
          {(outline.elements || []).map((el, i) => <span className="chip-e" key={i}>{el.type} → {el.section}</span>)}
        </div>
      )}
    </>
  );
}

function DraftBody({ draft, t }: { draft: Draft | null; t: (s: string) => string }) {
  if (!draft?.sections?.length) return <p className="muted">{t("No draft yet — write it section-by-section from the approved outline.")}</p>;
  return (
    <>
      <p className="muted small">{draft.sections.length} {t("sections")} · {draft.word_count || 0} {t("words")}</p>
      <div className="draft">
        {draft.sections.map((s, i) => (
          <div key={i}>
            <div className={`h h${s.level}`}>{s.heading}</div>
            <div className="body"><Markdown text={s.markdown} /></div>
          </div>
        ))}
      </div>
    </>
  );
}
