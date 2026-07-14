"use client";

import Link from "next/link";
import PipelineStepper, { PIPELINE_STAGES, type StageStatus } from "./PipelineStepper";
import Markdown from "./Markdown";
import { api } from "../lib/api";
import { useLang } from "../lib/i18n";
import type {
  Claim, Decision, DraftSection, Outline, OutlineNode, Research, Scores, TopFix,
} from "../lib/types";

// A draft section that may still be streaming tokens (live "typing").
export type LiveSection = DraftSection & { streaming?: boolean };

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

// What each seat is "doing" while we wait for its output (live activity text).
const ROLE_ACTIVITY: Record<string, string> = {
  content_strategist: "mapping search intent & section order…",
  human_editor: "checking tone & unsupported claims…",
  search_intelligence: "extracting entities & answer blocks…",
  trend_analyst: "scanning fresh angles & real complaints…",
};

export type SeatBox = {
  role: string; provider: string; status: "waiting" | "streaming" | "done";
  model?: string; confidence?: number | null; recommendations?: string[]; routed_from?: string | null;
  // Accumulated tokens while the seat is streaming (before it resolves to recs).
  draftText?: string;
  // Round-2 debate: the seat's live rebuttal of the others (+ whether streaming).
  critiqueText?: string;
  debating?: boolean;
};

export type RunState = {
  projectId: string;
  startedAt?: string;
  stages: Record<string, StageStatus>;
  research?: Research | null;
  seats: SeatBox[];
  conflicts: number;
  strategy?: string;
  decisions: Decision[];
  outline?: Outline | null;
  draft?: { id?: string; version?: number; word_count?: number; sections: LiveSection[] } | null;
  claims: Claim[];
  scores?: Scores | null;
  gate?: { passed: boolean; reasons: string[] } | null;
  fixes: TopFix[];
  compliance?: { passed: boolean; violations: number } | null;
  error?: string;
};

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

export default function RunView({
  run,
  onOverride,
}: {
  run: RunState;
  onOverride?: (decisionId: string, label: string) => void;
}) {
  const { t } = useLang();
  const r = run.research;
  return (
    <div className="runview fade-in">
      <div className="runview-head">
        <span className="run-time">{t("⚙ Pipeline run")}{run.startedAt ? ` · ${run.startedAt}` : ""}</span>
      </div>
      <PipelineStepper status={run.stages} />
      {run.error && <p className="error">{run.error}</p>}

      {/* Research */}
      {(r || run.stages.research === "running") && (
        <div className="jsection inline">
          <h3>{t("🔍 Research")} {r && <span className="tag tag-blue">{r.intent}</span>}</h3>
          {!r ? <p className="muted">{t("Gathering SERP, PAA, entities & sources…")}</p> : (
            <div className="rgrid">
              <div className="rblock">
                <div className="rsub">{t("Top SERP")} ({r.serp.length})</div>
                {r.serp.slice(0, 5).map((s, i) => (
                  <div className="serp-item" key={i}>
                    <span className="serp-rank">{s.rank ?? i + 1}</span>
                    <div>
                      <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                      <div className="serp-meta">{s.domain}</div>
                    </div>
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
                  <ul className="rlist">{r.sources.map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>{s.trust ? <span className="tag tag-green"> {s.trust}</span> : null}</li>)}</ul>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Council Arena — every model live, side by side */}
      {run.seats.length > 0 && (
        <div className="jsection inline">
          <h3>{t("🧠 Council Arena — all models working live")} {run.conflicts > 0 && <span className="pill conflict-pill">⚔ {run.conflicts} {t("conflict")}{run.conflicts > 1 ? "s" : ""}</span>}</h3>
          <div className="arena">
            {run.seats.map((s) => (
              <div className={`arena-box ${PROVIDER_TINT[s.provider] || "tint-gray"} ${s.status}`} key={s.role}>
                <div className="arena-box-head">
                  <span className="agent-avatar">{s.provider.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <div className="agent-role">{s.role.replace(/_/g, " ")}</div>
                    <div className="agent-meta">{s.provider}{s.model ? ` · ${s.model}` : ""}{s.confidence != null ? ` · conf ${s.confidence}` : ""}{s.routed_from ? <span className="routed"> · {t("failover from")} {s.routed_from}</span> : ""}</div>
                  </div>
                </div>
                {s.status === "waiting" ? (
                  <div className="arena-thinking"><span className="spin spin-dark" /> {t(ROLE_ACTIVITY[s.role] || "researching & analysing…")}</div>
                ) : s.status === "streaming" ? (
                  <div className="arena-stream">{s.draftText || ""}<span className="stream-cursor" /></div>
                ) : (
                  <ul className="recs">{(s.recommendations || []).map((rec, i) => <li key={i}>{rec}</li>)}</ul>
                )}
                {s.critiqueText !== undefined && (
                  <div className="arena-rebuttal">
                    <span className="rebuttal-tag">{t("💬 Rebuttal")}</span>
                    <div className="rebuttal-text">{s.critiqueText}{s.debating && <span className="stream-cursor" />}</div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Judge */}
      {run.decisions.length > 0 && (
        <div className="jsection inline">
          <h3>{t("⚖ Judge decisions")}</h3>
          {run.strategy && <p className="muted">{t("Strategy:")} {run.strategy}</p>}
          <div className="rows">
            {run.decisions.map((d, i) => (
              <div className="row decision" key={d.id || i}>
                <div>
                  <div className="row-title">{d.point}</div>
                  <div className="row-sub">{d.source}{d.reason ? ` — ${d.reason}` : ""}</div>
                </div>
                <div className="decision-override">
                  {d.overridden_by && <span className="overridden">{t("overridden")}</span>}
                  <select className={`lab-select ${LABEL_CLASS[d.label] || "lab-blue"}`} value={d.label} disabled={!d.id || !onOverride} onChange={(e) => onOverride?.(d.id, e.target.value)}>
                    {LABELS.map((l) => <option key={l} value={l}>{t(l.replace(/_/g, " "))}</option>)}
                  </select>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Outline */}
      {run.outline?.nodes?.length ? (
        <div className="jsection inline">
          <h3>{t("🗂 Outline")}</h3>
          <OutlineTree nodes={run.outline.nodes} />
        </div>
      ) : null}

      {/* Draft — sections stream in and "type" live */}
      {run.draft?.sections?.length ? (() => {
        const secs = run.draft.sections;
        const writing = secs.filter((s) => s.streaming).length;
        return (
          <div className="jsection inline">
            <h3>
              {t("✍️ Draft")}{" "}
              {writing > 0 ? (
                <span className="pill warn">{t("writing")} {secs.length - writing}/{secs.length}…</span>
              ) : (
                <span className="muted" style={{ fontWeight: 400 }}>({secs.length} {t("sections")} · {run.draft.word_count || secs.reduce((n, s) => n + (s.markdown.trim() ? s.markdown.trim().split(/\s+/).length : 0), 0)} {t("words")})</span>
              )}
            </h3>
            <div className="draft">
              {secs.map((s, i) => (
                <div key={i} className={s.streaming ? "draft-section writing" : "draft-section"}>
                  <div className={`h h${s.level}`}>{s.heading}</div>
                  {s.streaming ? (
                    <p className="body">{s.markdown}<span className="stream-cursor" /></p>
                  ) : (
                    <div className="body"><Markdown text={s.markdown} /></div>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })() : null}

      {/* Fact-check */}
      {run.claims.length > 0 && (
        <div className="jsection inline">
          <h3>{t("✅ Fact-check")} ({run.claims.length})</h3>
          <div className="rows">
            {run.claims.map((c, i) => (
              <div className="row" key={c.id || i}>
                <div>
                  <div className="row-title">{c.text}</div>
                  <div className="row-sub">{c.source ? `source: ${c.source}` : t("no source")}</div>
                </div>
                <span className={`lab risk-${c.risk}`}>{c.risk}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scores + gate */}
      {run.scores && (
        <div className="jsection inline">
          <h3>{t("📊 Scores & publish gate")} {run.gate && <span className={`pill ${run.gate.passed ? "ok" : "warn"}`}>{run.gate.passed ? t("READY") : t("BLOCKED")}</span>}</h3>
          <div className="scoregrid">
            {(Object.keys(TARGETS) as (keyof Scores)[]).map((a) => {
              const v = run.scores![a]; const ok = scoreOk(a, v);
              return (
                <div className={`scorecell ${ok ? "good" : "bad"}`} key={a}>
                  <div className="score-num">{v}</div>
                  <div className="score-bar"><span style={{ width: `${Math.min(v, 100)}%` }} /></div>
                  <div className="score-axis">{a.toUpperCase()}</div>
                </div>
              );
            })}
          </div>
          {run.gate && !run.gate.passed && <ul className="reasons">{run.gate.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>}
          {run.compliance && <p className="muted">{t("House rules:")} {run.compliance.passed ? t("passed ✓") : `${run.compliance.violations} violation(s)`}</p>}
          {run.fixes.length > 0 && <ul className="fixes">{run.fixes.slice(0, 3).map((f, i) => <li key={i}><b>{f.axis.toUpperCase()} (+{f.est_gain})</b> — {f.fix}</li>)}</ul>}
          {run.draft && (
            <div className="run-chips">
              <Link className="chip" href={`/projects/${run.projectId}/editor`}>{t("✎ Open editor")}</Link>
              <a className="chip" href={api.exportUrl(run.projectId, "markdown")} target="_blank" rel="noreferrer">⬇ MD</a>
              <a className="chip" href={api.exportUrl(run.projectId, "html")} target="_blank" rel="noreferrer">⬇ HTML</a>
              <a className="chip" href={api.exportUrl(run.projectId, "docx")} target="_blank" rel="noreferrer">⬇ DOCX</a>
              <a className="chip" href={api.exportUrl(run.projectId, "jsonld")} target="_blank" rel="noreferrer">⬇ JSON-LD</a>
              <span className="chip-hint">{t("type /rerun · /regenerate N · /export")}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
