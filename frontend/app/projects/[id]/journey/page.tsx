"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Shell from "../../../../components/Shell";
import { api } from "../../../../lib/api";
import type {
  AgentReport, Claim, Decision, Draft, Outline, OutlineNode,
  PipelineSummary, Project, Research, Scores, TopFix,
} from "../../../../lib/types";

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

type StStatus = "pending" | "running" | "done";
type SeatBox = { role: string; provider: string; status: "waiting" | "done"; model?: string; confidence?: number | null; recommendations?: string[]; routed_from?: string | null };

const STAGE_KEYS = ["research", "council", "outline", "article", "factcheck", "scoring", "gate", "compliance"];
const TIMELINE = [
  { key: "brief", label: "Brief", sec: "sec-brief", stage: "" },
  { key: "research", label: "Research", sec: "sec-research", stage: "research" },
  { key: "council", label: "Council", sec: "sec-council", stage: "council" },
  { key: "judge", label: "Judge", sec: "sec-judge", stage: "council" },
  { key: "outline", label: "Outline", sec: "sec-outline", stage: "outline" },
  { key: "draft", label: "Draft", sec: "sec-draft", stage: "article" },
  { key: "factcheck", label: "Fact-check", sec: "sec-factcheck", stage: "factcheck" },
  { key: "scores", label: "Scores & Gate", sec: "sec-scores", stage: "scoring" },
];

const emptyStages = (): Record<string, StStatus> => Object.fromEntries(STAGE_KEYS.map((k) => [k, "pending"]));

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

export default function JourneyPage() {
  const { id } = useParams<{ id: string }>();

  const [project, setProject] = useState<Project | null>(null);
  const [stages, setStages] = useState<Record<string, StStatus>>(emptyStages());
  const [research, setResearch] = useState<Research | null>(null);
  const [seats, setSeats] = useState<SeatBox[]>([]);
  const [conflicts, setConflicts] = useState(0);
  const [strategy, setStrategy] = useState("");
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [scores, setScores] = useState<Scores | null>(null);
  const [gate, setGate] = useState<{ passed: boolean; reasons: string[] } | null>(null);
  const [fixes, setFixes] = useState<TopFix[]>([]);
  const [compliance, setCompliance] = useState<{ passed: boolean; violations: number } | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const runStream = useCallback(() => {
    esRef.current?.close();
    setError(null);
    setRunning(true);
    setStages(emptyStages());
    setResearch(null); setSeats([]); setConflicts(0); setStrategy("");
    setDecisions([]); setOutline(null); setDraft(null); setClaims([]);
    setScores(null); setGate(null); setFixes([]); setCompliance(null);

    const es = new EventSource(api.streamUrl(id));
    esRef.current = es;
    let finished = false;

    es.addEventListener("stage", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setStages((p) => ({ ...p, [d.stage]: d.status === "start" ? "running" : "done" }));
      if (d.status === "done") {
        if (d.stage === "research") api.getResearch(id).then(setResearch).catch(() => {});
        if (d.stage === "outline") api.getOutline(id).then(setOutline).catch(() => {});
        if (d.stage === "article") api.getDraft(id).then(setDraft).catch(() => {});
        if (d.stage === "council") setStrategy(d.info?.strategy_summary || "");
      }
    });
    es.addEventListener("roster", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setSeats(d.seats.map((s: SeatBox) => ({ ...s, status: "waiting" })));
    });
    es.addEventListener("report", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setSeats((p) => p.map((s) => (s.role === d.role ? { ...s, status: "done", model: d.model, confidence: d.confidence, recommendations: d.recommendations, routed_from: d.routed_from } : s)));
    });
    es.addEventListener("conflict", () => setConflicts((c) => c + 1));
    es.addEventListener("decision", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      setDecisions((p) => [...p, { id: "", overridden_by: null, ...d }]);
    });
    es.addEventListener("done", (e) => {
      finished = true;
      const s = JSON.parse((e as MessageEvent).data) as PipelineSummary;
      setScores(s.scores); setGate(s.gate); setFixes(s.top_fixes); setCompliance(s.compliance);
      setStrategy(s.council.strategy_summary);
      setStages(Object.fromEntries(STAGE_KEYS.map((k) => [k, "done"])));
      es.close(); setRunning(false);
      api.getProject(id).then(setProject).catch(() => {});
      api.getDecisions(id).then(setDecisions).catch(() => {});
      api.getClaims(id).then(setClaims).catch(() => {});
    });
    es.addEventListener("error", (e) => {
      try { setError(JSON.parse((e as MessageEvent).data).detail); } catch { /* */ }
    });
    es.onerror = () => {
      if (!finished) {
        setError("Live stream disconnected — retry the run.");
        es.close();
        setRunning(false);
      }
    };
  }, [id]);

  const loadExisting = useCallback(() => {
    api.getResearch(id).then(setResearch).catch(() => {});
    api.getOutline(id).then(setOutline).catch(() => {});
    api.getDraft(id).then(setDraft).catch(() => {});
    api.getClaims(id).then(setClaims).catch(() => {});
    api.getDecisions(id).then(setDecisions).catch(() => {});
    api.getDebate(id).then((d) => {
      setSeats((d.reports || []).map((r: AgentReport) => ({ role: r.role, provider: r.provider, status: "done", model: r.model, confidence: r.confidence, recommendations: r.recommendations })));
      setConflicts((d.conflicts || []).length);
    }).catch(() => {});
    api.getScores(id).then((rows) => { if (rows[0]) setScores(rows[0]); }).catch(() => {});
    if (research || draft) setStages(Object.fromEntries(STAGE_KEYS.map((k) => [k, "done"])));
  }, [id, research, draft]);

  useEffect(() => {
    api.getProject(id).then(setProject).catch((e) => setError(String(e)));
    const autorun = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("run") === "1";
    if (autorun) runStream();
    else loadExisting();
    return () => esRef.current?.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  function stop() { esRef.current?.close(); setRunning(false); }

  async function override(decisionId: string, label: string) {
    if (!decisionId) return;
    try {
      const u = await api.updateDecision(id, decisionId, { label });
      setDecisions((p) => p.map((d) => (d.id === decisionId ? { ...d, ...u } : d)));
    } catch (e) { setError(String(e)); }
  }

  const tlStatus = (t: typeof TIMELINE[number]): StStatus =>
    t.key === "brief" ? "done" : (stages[t.stage] ?? "pending");

  if (error && !project) return <Shell title="Journey"><p className="error">{error}</p></Shell>;
  if (!project) return <Shell title="Journey"><p className="muted">Loading…</p></Shell>;

  return (
    <Shell
      title="Journey"
      status={
        <div className="actions" style={{ margin: 0 }}>
          <span className={`stage stage-${project.stage}`}>{project.stage}</span>
          {running
            ? <button className="btn btn-stop" onClick={stop}>■ Stop</button>
            : <button className="btn btn-primary" onClick={runStream}>▶ Run</button>}
          <Link className="btn" href={`/projects/${id}/review`}>🔍 Review</Link>
          {draft && <Link className="btn" href={`/projects/${id}/editor`}>✎ Editor</Link>}
        </div>
      }
    >
      <p className="muted sub">{project.topic} · {project.website} · {project.keyword}</p>
      {error && <p className="error">{error}</p>}

      <div className="journey">
        {/* Left: vertical timeline */}
        <aside className="jtimeline">
          {TIMELINE.map((t) => {
            const st = tlStatus(t);
            return (
              <button key={t.key} className={`jstep jstep-${st}`} onClick={() => document.getElementById(t.sec)?.scrollIntoView({ behavior: "smooth", block: "start" })}>
                <span className="jdot">{st === "done" ? "✓" : st === "running" ? <span className="spin spin-dark" /> : ""}</span>
                <span>{t.label}</span>
              </button>
            );
          })}
        </aside>

        {/* Right: stage sections */}
        <div className="jmain">
          <section id="sec-brief" className="jsection">
            <h2>① Brief</h2>
            <div className="kv">
              <div><span>Topic</span>{project.topic}</div>
              <div><span>Keyword</span>{project.keyword}</div>
              <div><span>Country</span>{project.country}</div>
              <div><span>Audience</span>{project.audience || "—"}</div>
              <div><span>Tone</span>{project.tone || "—"}</div>
              <div><span>Goal</span>{project.goal || "—"}</div>
            </div>
          </section>

          <section id="sec-research" className="jsection">
            <h2>② Research Intelligence {research && <span className="tag tag-blue">{research.intent}</span>}</h2>
            {!research ? <p className="muted">{stages.research === "running" ? "Gathering…" : "—"}</p> : (
              <div className="rgrid">
                <div className="rblock">
                  <h3>Top SERP ({research.serp.length})</h3>
                  {research.serp.map((s, i) => (
                    <div className="serp-item" key={i}>
                      <span className="serp-rank">{s.rank ?? i + 1}</span>
                      <div>
                        <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                        <div className="serp-meta">{s.domain}</div>
                        {s.snippet && <div className="serp-snip">{s.snippet}</div>}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="rcol">
                  <div className="rblock">
                    <h3>People Also Ask ({research.paa.length})</h3>
                    <ul className="rlist">{research.paa.map((q, i) => <li key={i}>{q}</li>)}</ul>
                  </div>
                  <div className="rblock">
                    <h3>Entities ({research.entities.length})</h3>
                    <div className="chips">{research.entities.map((e, i) => <span className="chip-e" key={i}>{e.name}{e.salience != null ? <em> {Math.round(e.salience * 100)}%</em> : null}</span>)}</div>
                  </div>
                  <div className="rblock">
                    <h3>Trusted sources ({research.sources.length})</h3>
                    <ul className="rlist">{research.sources.map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> {s.trust && <span className="tag tag-green">{s.trust}</span>}</li>)}</ul>
                  </div>
                </div>
              </div>
            )}
          </section>

          <section id="sec-council" className="jsection">
            <h2>③ Council Arena {conflicts > 0 && <span className="pill conflict-pill">⚔ {conflicts} conflict{conflicts > 1 ? "s" : ""}</span>}</h2>
            {seats.length === 0 ? <p className="muted">{stages.council === "running" ? "Convening…" : "—"}</p> : (
              <div className="arena">
                {seats.map((s) => (
                  <div className={`arena-box ${PROVIDER_TINT[s.provider] || "tint-gray"} ${s.status}`} key={s.role}>
                    <div className="arena-box-head">
                      <span className="agent-avatar">{s.provider.slice(0, 2).toUpperCase()}</span>
                      <div>
                        <div className="agent-role">{s.role.replace(/_/g, " ")}</div>
                        <div className="agent-meta">{s.provider}{s.model ? ` · ${s.model}` : ""}{s.confidence != null ? ` · conf ${s.confidence}` : ""}{s.routed_from ? <span className="routed"> · failover from {s.routed_from}</span> : ""}</div>
                      </div>
                    </div>
                    {s.status === "waiting" ? <div className="arena-thinking"><span className="spin spin-dark" /> researching &amp; analysing…</div> : (
                      <ul className="recs">{(s.recommendations || []).map((r, i) => <li key={i}>{r}</li>)}</ul>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          <section id="sec-judge" className="jsection">
            <h2>④ Judge decisions</h2>
            {strategy && <p className="muted">Strategy: {strategy}</p>}
            {decisions.length === 0 ? <p className="muted">—</p> : (
              <div className="rows">
                {decisions.map((d, i) => (
                  <div className="row decision" key={d.id || i}>
                    <div>
                      <div className="row-title">{d.point}</div>
                      <div className="row-sub">{d.source}{d.reason ? ` — ${d.reason}` : ""}</div>
                    </div>
                    <div className="decision-override">
                      {d.overridden_by && <span className="overridden">overridden</span>}
                      <select className={`lab-select ${LABEL_CLASS[d.label] || "lab-blue"}`} value={d.label} disabled={!d.id} onChange={(e) => override(d.id, e.target.value)}>
                        {LABELS.map((l) => <option key={l} value={l}>{l.replace(/_/g, " ")}</option>)}
                      </select>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section id="sec-outline" className="jsection">
            <h2>⑤ Outline</h2>
            {!outline ? <p className="muted">—</p> : (
              <>
                <OutlineTree nodes={outline.nodes || []} />
                <div className="chips" style={{ marginTop: 10 }}>
                  {(outline.elements || []).map((el, i) => <span className="chip-e" key={i}>{el.type} → {el.section}</span>)}
                </div>
              </>
            )}
          </section>

          <section id="sec-draft" className="jsection">
            <h2>⑥ Draft {draft && <span className="muted" style={{ fontWeight: 400 }}>({draft.sections?.length || 0} sections · {draft.word_count || 0} words)</span>}</h2>
            {!draft?.sections?.length ? <p className="muted">{stages.article === "running" ? "Writing…" : "—"}</p> : (
              <div className="draft">
                {draft.sections.map((s, i) => (
                  <div key={i}>
                    <div className={`h h${s.level}`}>{s.heading}</div>
                    <p className="body">{s.markdown}</p>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section id="sec-factcheck" className="jsection">
            <h2>⑦ Fact-check</h2>
            {claims.length === 0 ? <p className="muted">—</p> : (
              <div className="rows">
                {claims.map((c, i) => (
                  <div className="row" key={c.id || i}>
                    <div>
                      <div className="row-title">{c.text}</div>
                      <div className="row-sub">{c.source ? `source: ${c.source}` : "no source"}</div>
                    </div>
                    <span className={`lab risk-${c.risk}`}>{c.risk}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section id="sec-scores" className="jsection">
            <h2>⑧ Scores &amp; publish gate {gate && <span className={`pill ${gate.passed ? "ok" : "warn"}`}>{gate.passed ? "READY" : "BLOCKED"}</span>}</h2>
            {!scores ? <p className="muted">{stages.scoring === "running" ? "Scoring…" : "Run the pipeline to compute scores."}</p> : (
              <>
                <div className="scoregrid">
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
                {gate && !gate.passed && <ul className="reasons">{gate.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>}
                {compliance && <p className="muted">House rules: {compliance.passed ? "passed ✓" : `${compliance.violations} violation(s)`}</p>}
                {fixes.length > 0 && (
                  <>
                    <h3 className="mt">Highest-impact fixes</h3>
                    <ul className="fixes">{fixes.map((f, i) => <li key={i}><b>{f.axis.toUpperCase()} (+{f.est_gain})</b> — {f.fix}</li>)}</ul>
                  </>
                )}
                {draft && (
                  <div className="run-chips">
                    <Link className="chip" href={`/projects/${id}/editor`}>✎ Open editor</Link>
                    <a className="chip" href={api.exportUrl(id, "markdown")} target="_blank" rel="noreferrer">⬇ Export MD</a>
                    <a className="chip" href={api.exportUrl(id, "html")} target="_blank" rel="noreferrer">⬇ HTML</a>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      </div>
    </Shell>
  );
}
