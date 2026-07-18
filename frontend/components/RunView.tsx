"use client";

import { useState } from "react";
import Link from "next/link";
import PipelineStepper, { PIPELINE_STAGES } from "./PipelineStepper";
import Markdown from "./Markdown";
import DecisionButtons from "./DecisionButtons";
import { api } from "../lib/api";
import { useLang } from "../lib/i18n";
import type { OutlineNode, Scores } from "../lib/types";
import type { DebateTurnView, RunState } from "../lib/run";

// Run/seat/section types live in lib/run (shared with the stream layer); re-export
// so existing importers (chat) keep resolving them from here.
export type { RunState, SeatBox, LiveSection } from "../lib/run";

// Each score axis → plain-English meaning + pass target. `spam` is "lower is
// better", so we invert it for display (see displayScore) and everything else
// reads "higher is better".
const SCORE_META: Record<
  keyof Scores,
  { label: string; help: string; target: number; lowerIsBetter?: boolean }
> = {
  seo: { label: "Google search", help: "Ready for Google search", target: 85 },
  aeo: { label: "AI assistants", help: "Can ChatGPT / Perplexity quote it", target: 85 },
  geo: { label: "AI overviews", help: "Shows up in AI answers", target: 80 },
  heo: { label: "Reader experience", help: "Easy & helpful to read", target: 85 },
  eeat: { label: "Trust & expertise", help: "Signals real expertise", target: 80 },
  fact: { label: "Fact accuracy", help: "Claims are supported", target: 80 },
  spam: { label: "Spam-safe", help: "Low spam signals", target: 25, lowerIsBetter: true },
  originality: { label: "Originality", help: "Not generic or derivative", target: 70 },
  publish: { label: "Publish-ready", help: "Overall readiness", target: 85 },
};
const SCORE_AXES = Object.keys(SCORE_META) as (keyof Scores)[];
// Normalise so higher is always better (spam → "spam-safe").
const displayScore = (a: keyof Scores, v: number) => (SCORE_META[a].lowerIsBetter ? 100 - v : v);
const displayTarget = (a: keyof Scores) =>
  SCORE_META[a].lowerIsBetter ? 100 - SCORE_META[a].target : SCORE_META[a].target;
const scoreOk = (a: keyof Scores, v: number) => displayScore(a, v) >= displayTarget(a);

const PROVIDER_TINT: Record<string, string> = {
  openai: "tint-green", anthropic: "tint-purple", google: "tint-blue", xai: "tint-amber", mock: "tint-gray",
};

// What each expert is "doing" while we wait for its output (live activity text).
const ROLE_ACTIVITY: Record<string, string> = {
  content_strategist: "mapping the topic & section order…",
  human_editor: "checking tone & unsupported claims…",
  search_intelligence: "pulling key facts & answers…",
  trend_analyst: "scanning fresh angles & real complaints…",
};

// Human title for an expert's role (e.g. "Trend Analyst").
const roleTitle = (role: string) =>
  role.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// Debate stance → plain-English badge + CSS class (drives the coloured pill).
const STANCE: Record<string, { label: string; cls: string }> = {
  rebut: { label: "Disagrees", cls: "stance-rebut" },
  defend: { label: "Stands by it", cls: "stance-defend" },
  concede: { label: "Agrees", cls: "stance-concede" },
  revise: { label: "Updates it", cls: "stance-revise" },
  reply: { label: "Replies", cls: "stance-reply" },
};
const stanceOf = (s: string) => STANCE[s] || { label: s, cls: "stance-reply" };

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

// Hostname (sans www.) from a URL, for display + favicon lookup.
const hostOf = (url?: string): string => {
  if (!url) return "";
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

// Favicon for a result — prefer the provider's own (Brave supplies these), else
// fall back to Google's favicon service keyed by domain (works for any site).
const faviconOf = (item: { favicon?: string; domain?: string; url?: string }): string => {
  if (item.favicon) return item.favicon;
  const domain = item.domain || hostOf(item.url);
  return domain ? `https://www.google.com/s2/favicons?domain=${domain}&sz=64` : "";
};

function Favicon({ item }: { item: { favicon?: string; domain?: string; url?: string } }) {
  const src = faviconOf(item);
  return src ? (
    <img
      className="favicon"
      src={src}
      alt=""
      width={16}
      height={16}
      loading="lazy"
      onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = "hidden"; }}
    />
  ) : (
    <span className="favicon favicon-ph" />
  );
}

// One collapsible stage. Finished stages fold to a one-line summary; the active
// stage (and the final result) stay open. Clicking the header toggles it.
function Section({
  icon, title, summary, badge, open, active, onToggle, children,
}: {
  icon: string;
  title: string;
  summary?: string;
  badge?: React.ReactNode;
  open: boolean;
  active?: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={`rv-sec ${open ? "open" : "collapsed"} ${active ? "active" : ""}`}>
      <button className="rv-sec-head" onClick={onToggle} aria-expanded={open}>
        <span className="rv-sec-ic">{icon}</span>
        <span className="rv-sec-title">{title}</span>
        {badge}
        {!open && summary ? <span className="rv-sec-sum">{summary}</span> : <span className="rv-sec-spacer" />}
        <span className="rv-sec-chev" aria-hidden="true">{open ? "▾" : "▸"}</span>
      </button>
      {open && <div className="rv-sec-body">{children}</div>}
    </div>
  );
}

// Plain-English "what's happening now" per stage — for the working indicator so
// silent stages (outline/fact-check/scoring) and the gap after an approve don't
// feel like nothing is happening.
const WORKING_LABELS: Record<string, string> = {
  research: "Researching the web",
  council: "The AI experts are debating",
  outline: "Building the outline",
  article: "Writing the draft",
  factcheck: "Checking the facts",
  scoring: "Scoring the article",
  gate: "Running the publish check",
  compliance: "Checking content policy",
};

export default function RunView({
  run,
  onOverride,
  onRerun,
  gate,
  busy = false,
  hideStepper = false,
}: {
  run: RunState;
  onOverride?: (decisionId: string, label: string) => void;
  onRerun?: () => void;
  // "Approve each step" flow: the paused-gate approval box. Rendered at the bottom
  // (below everything the paused stage produced) so you approve in context.
  gate?: React.ReactNode;
  // True while the parent is actively running the pipeline — drives the animated
  // "working…" indicator that fills the gaps between/inside non-streaming stages.
  busy?: boolean;
  // The review flow renders its own progressive step tracker, so it hides the
  // full 8-stage rail (and this view's progress header) to avoid duplication.
  hideStepper?: boolean;
}) {
  const { t } = useLang();
  const r = run.research;
  // User's manual expand/collapse overrides (key -> open?). Absent = follow the
  // auto rule (open the active stage + the result).
  const [openOverride, setOpenOverride] = useState<Record<string, boolean>>({});

  const words =
    run.draft?.sections?.reduce((n, s) => n + (s.markdown.trim() ? s.markdown.trim().split(/\s+/).length : 0), 0) || 0;
  const draftWriting = !!run.draft?.sections?.some((s) => s.streaming);

  // Which stages are present (in pipeline order) — drives the accordion + which
  // one is "active" (auto-open).
  const SECTIONS = [
    { key: "research", present: !!r || run.stages.research === "running" },
    { key: "council", present: run.seats.length > 0 },
    { key: "review", present: !!run.judge || run.decisions.length > 0 },
    { key: "outline", present: !!run.outline?.nodes?.length },
    { key: "draft", present: !!run.draft?.sections?.length },
    { key: "factcheck", present: run.claims.length > 0 },
    { key: "scores", present: !!run.scores },
  ].filter((s) => s.present);
  const activeKey = SECTIONS.length ? SECTIONS[SECTIONS.length - 1].key : null;
  // The stage paused for approval (gated flow) — force its section open so you
  // review exactly what you're signing off, and drop the gate right below it.
  const awaitingKey = run.awaiting?.stage;
  const isOpen = (key: string, fallback?: boolean) =>
    awaitingKey === key ? true : openOverride[key] ?? (fallback ?? (key === activeKey || key === "scores"));
  const toggle = (key: string, cur: boolean) => setOpenOverride((o) => ({ ...o, [key]: !cur }));

  // Progress header: step N of total + current stage + done state.
  const doneCount = PIPELINE_STAGES.filter((s) => run.stages[s.key] === "done").length;
  const running = PIPELINE_STAGES.find((s) => run.stages[s.key] === "running");
  const total = PIPELINE_STAGES.length;
  const allDone = !!run.scores || doneCount >= total;
  // Show the animated "working…" indicator while the pipeline runs but isn't
  // paused/finished — fills the silent gaps (outline/fact-check/scoring, and the
  // moment right after you approve a step).
  const working = busy && !run.awaiting && !run.error && !allDone;

  // Verdict for the result card.
  const failing = run.scores ? SCORE_AXES.filter((a) => !scoreOk(a, run.scores![a])) : [];
  const gatePassed = run.gate ? run.gate.passed : run.scores ? failing.length === 0 : false;
  const showResult = !!run.scores || !!run.done;

  const openReview = () => setOpenOverride((o) => ({ ...o, review: true }));

  return (
    <div className="runview fade-in">
      {/* Progress header — always tells you where you are + when it's done.
          Hidden in the gated review flow, which shows its own step tracker. */}
      {!hideStepper && (
        <div className="rv-progress">
          <div className="rv-progress-row">
            <span className={`rv-progress-state ${run.awaiting ? "paused" : allDone ? "done" : "running"}`}>
              {run.awaiting
                ? `⏸ ${t("Paused — waiting for your approval")}`
                : allDone ? `✓ ${t("Done")}` : running
                  ? `${t("Step")} ${Math.min(doneCount + 1, total)} ${t("of")} ${total} · ${t(running.label)}…`
                  : `${t("Starting")}…`}
            </span>
            {run.startedAt && <span className="rv-progress-time">{run.startedAt}</span>}
          </div>
          <PipelineStepper status={run.stages} />
        </div>
      )}

      {run.error && <p className="error">{run.error}</p>}

      {/* Pinned result — reachable without scrolling past the whole article */}
      {showResult && (
        <div className={`rv-result ${gatePassed ? "ok" : "warn"}`}>
          <div className="rv-result-main">
            <span className="rv-result-ic">{gatePassed ? "✅" : "⚠️"}</span>
            <div>
              <div className="rv-result-title">
                {gatePassed ? t("Your article is ready") : t("Almost there")}
              </div>
              <div className="rv-result-sub">
                {run.gate && !run.gate.passed
                  ? `${failing.length} ${t("things to fix")}: ${failing.map((a) => t(SCORE_META[a].label)).join(", ")}`
                  : gatePassed
                    ? t("Passed all publish checks — nothing was published automatically.")
                    : t("Finishing up…")}
              </div>
            </div>
          </div>
          <div className="rv-result-actions">
            <Link className="btn btn-primary" href={`/projects/${run.projectId}/editor`}>{t("Open in editor")}</Link>
            <a className="btn btn-ghost" href={api.exportUrl(run.projectId, "markdown")} target="_blank" rel="noreferrer">{t("Download")}</a>
            {onRerun && <button className="btn btn-ghost" onClick={onRerun}>{t("Regenerate")}</button>}
            {run.decisions.length > 0 && (
              <button className="btn btn-ghost" onClick={openReview}>{t("Review decisions")}</button>
            )}
          </div>
        </div>
      )}

      {/* ---- Research ---- */}
      {(!!r || run.stages.research === "running") && (
        <Section
          icon="🔎"
          title={t("Research")}
          badge={r ? <span className="tag tag-blue">{r.intent}</span> : undefined}
          summary={r ? `${r.serp.length} ${t("sites")} · ${r.paa.length} ${t("questions")}` : undefined}
          open={isOpen("research")}
          active={activeKey === "research"}
          onToggle={() => toggle("research", isOpen("research"))}
        >
          {!r ? <p className="muted">{t("Searching the web for your topic…")}</p> : (
            <div className="rgrid">
              <div className="rblock">
                <div className="rsub">
                  {t("Researched sites")} ({r.serp.length})
                  {r.serp.length > 6 && <span className="deep-badge">{t("deep")}</span>}
                </div>
                <div className="serp-scroll">
                  {r.serp.slice(0, 20).map((s, i) => (
                    <div className="serp-item" key={i}>
                      <span className="serp-rank">{s.rank ?? i + 1}</span>
                      <Favicon item={s} />
                      <div className="serp-body">
                        <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a>
                        <div className="serp-meta">{s.domain || hostOf(s.url)}</div>
                        {s.snippet ? <div className="serp-snip">{s.snippet}</div> : null}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="rcol">
                <div className="rblock">
                  <div className="rsub">{t("Common questions people ask")} ({r.paa.length})</div>
                  <ul className="rlist">{r.paa.slice(0, 5).map((q, i) => <li key={i}>{q}</li>)}</ul>
                </div>
                <div className="rblock">
                  <div className="rsub">{t("Key topics to cover")}</div>
                  <div className="chips">{r.entities.slice(0, 8).map((e, i) => <span className="chip-e" key={i}>{e.name}</span>)}</div>
                </div>
                <div className="rblock">
                  <div className="rsub">{t("Sources")} ({r.sources.length})</div>
                  <div className="src-list">
                    {r.sources.map((s, i) => (
                      <a className="src-card" key={i} href={s.url} target="_blank" rel="noreferrer" title={s.title}>
                        <Favicon item={s} />
                        <span className="src-dom">{s.domain || hostOf(s.url) || s.title}</span>
                        {s.trust ? <span className={`src-trust trust-${s.trust}`}>{s.trust}</span> : null}
                      </a>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}
        </Section>
      )}

      {/* ---- AI experts (council arena + their discussion) ---- */}
      {run.seats.length > 0 && (
        <Section
          icon="🧠"
          title={t("AI experts")}
          summary={`${run.seats.length} ${t("experts")}${run.conflicts > 0 ? ` · ${run.conflicts} ${t("disagreement")}${run.conflicts > 1 ? "s" : ""}` : ""}`}
          open={isOpen("council")}
          active={activeKey === "council"}
          onToggle={() => toggle("council", isOpen("council"))}
        >
          <div className="arena">
            {run.seats.map((s) => (
              <div className={`arena-box ${PROVIDER_TINT[s.provider] || "tint-gray"} ${s.status}`} key={s.role}>
                <div className="arena-box-head">
                  <span className="agent-avatar">{s.provider.slice(0, 2).toUpperCase()}</span>
                  <div>
                    <div className="agent-role">{roleTitle(s.role)}</div>
                    <div className="agent-meta">{s.provider}{s.confidence != null ? ` · ${t("Confidence")} ${s.confidence}%` : ""}</div>
                  </div>
                </div>
                {s.status === "waiting" ? (
                  <div className="arena-thinking"><span className="spin spin-dark" /> {t(ROLE_ACTIVITY[s.role] || "researching & analysing…")}</div>
                ) : s.status === "streaming" ? (
                  <div className="arena-stream">{s.draftText || ""}<span className="stream-cursor" /></div>
                ) : (
                  <ul className="recs">{(s.recommendations || []).map((rec, i) => <li key={i}>{rec}</li>)}</ul>
                )}
              </div>
            ))}
          </div>
          {run.debate.length > 0 && (
            <div className="rv-subblock">
              <div className="rv-subhead">💬 {t("The experts compared notes")}</div>
              <div className="debate-thread">
                {run.debate.map((tn: DebateTurnView, i) => {
                  const st = stanceOf(tn.stance);
                  return (
                    <div className={`debate-turn ${PROVIDER_TINT[tn.provider || ""] || "tint-gray"}`} key={`${tn.round}-${tn.role}-${i}`}>
                      <div className="debate-turn-head">
                        <span className="agent-avatar sm">{(tn.provider || "?").slice(0, 2).toUpperCase()}</span>
                        <span className="debate-who">{roleTitle(tn.role)}</span>
                        {tn.addressed_to && <span className="debate-arrow">→ {roleTitle(tn.addressed_to)}</span>}
                        <span className={`stance-badge ${st.cls}`}>{t(st.label)}</span>
                      </div>
                      <div className="debate-turn-body">{tn.text}{tn.streaming && <span className="stream-cursor" />}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* ---- Lead editor's decisions (the human-in-the-loop moment) ---- */}
      {(!!run.judge || run.decisions.length > 0) && (
        <Section
          icon="⚖"
          title={t("Lead editor's decisions")}
          badge={run.judge?.streaming ? <span className="pill warn">{t("reviewing")}…</span> : undefined}
          summary={run.decisions.length ? `${run.decisions.length} ${t("decisions")}${onOverride ? ` · ${t("you can override")}` : ""}` : undefined}
          open={isOpen("review")}
          active={activeKey === "review"}
          onToggle={() => toggle("review", isOpen("review"))}
        >
          {run.judge?.text ? (
            <div className="judge-deliberation">
              {run.judge.text}{run.judge.streaming && <span className="stream-cursor" />}
            </div>
          ) : null}
          {run.decisions.length > 0 && (
            <p className="rv-hint">{t("These are the calls the AI made. Accept or reject any — optional.")}</p>
          )}
          <div className="rows">
            {run.decisions.map((d, i) => (
              <div className="row decision" key={d.id || i}>
                <div>
                  <div className="row-title">{d.point}</div>
                  <div className="row-sub">{d.source}{d.reason ? ` — ${d.reason}` : ""}</div>
                </div>
                <div className="decision-override">
                  {d.overridden_by && <span className="overridden">{t("you changed this")}</span>}
                  {d.id ? (
                    <DecisionButtons
                      value={d.label}
                      disabled={!onOverride}
                      onSelect={(label) => onOverride?.(d.id, label)}
                    />
                  ) : (
                    <span className="muted small">{t("available after the draft finishes")}</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ---- Outline ---- */}
      {run.outline?.nodes?.length ? (
        <Section
          icon="🗂"
          title={t("Outline")}
          summary={`${run.outline.nodes.length} ${t("sections")}`}
          open={isOpen("outline")}
          active={activeKey === "outline"}
          onToggle={() => toggle("outline", isOpen("outline"))}
        >
          <OutlineTree nodes={run.outline.nodes} />
        </Section>
      ) : null}

      {/* ---- Draft ---- */}
      {run.draft?.sections?.length ? (
        <Section
          icon="✍️"
          title={t("Draft")}
          badge={draftWriting ? <span className="pill warn">{t("writing")}…</span> : undefined}
          summary={`${run.draft.sections.length} ${t("sections")} · ${run.draft.word_count || words} ${t("words")}`}
          open={isOpen("draft")}
          active={activeKey === "draft"}
          onToggle={() => toggle("draft", isOpen("draft"))}
        >
          <div className="draft">
            {run.draft.sections.map((s, i) => (
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
        </Section>
      ) : null}

      {/* ---- Fact-check ---- */}
      {run.claims.length > 0 && (
        <Section
          icon="✅"
          title={t("Fact-check")}
          summary={`${run.claims.length} ${t("claims checked")}`}
          open={isOpen("factcheck")}
          active={activeKey === "factcheck"}
          onToggle={() => toggle("factcheck", isOpen("factcheck"))}
        >
          <div className="rows">
            {run.claims.map((c, i) => (
              <div className="row" key={c.id || i}>
                <div>
                  <div className="row-title">{c.text}</div>
                  <div className="row-sub">{c.source ? `${t("source")}: ${c.source}` : t("no source")}</div>
                </div>
                <span className={`lab risk-${c.risk}`}>{c.risk}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* ---- Publish check (scores) ---- */}
      {run.scores && (
        <Section
          icon="📊"
          title={t("Publish check")}
          badge={<span className={`pill ${gatePassed ? "ok" : "warn"}`}>{gatePassed ? t("Ready to publish") : t("Fix these first")}</span>}
          open={isOpen("scores", true)}
          active={activeKey === "scores"}
          onToggle={() => toggle("scores", isOpen("scores", true))}
        >
          <div className="scoregrid">
            {SCORE_AXES.map((a) => {
              const raw = run.scores![a];
              const dv = displayScore(a, raw);
              const ok = scoreOk(a, raw);
              return (
                <div className={`scorecell ${ok ? "good" : "bad"}`} key={a}>
                  <div className="scorecell-top">
                    <span className="score-num">{dv}</span>
                    <span className={`score-check ${ok ? "good" : "bad"}`}>{ok ? "✓" : "✕"}</span>
                  </div>
                  <div className="score-bar"><span style={{ width: `${Math.min(dv, 100)}%` }} /></div>
                  <div className="score-label">{t(SCORE_META[a].label)}</div>
                  <div className="score-target">{ok ? t("pass") : `${t("needs")} ${displayTarget(a)}`}</div>
                </div>
              );
            })}
          </div>
          {run.gate && !run.gate.passed && run.gate.reasons?.length ? (
            <ul className="reasons">{run.gate.reasons.map((x, i) => <li key={i}>{x}</li>)}</ul>
          ) : null}
          {run.compliance && (
            <p className="muted">{t("Content policy checks:")} {run.compliance.passed ? t("passed ✓") : `${run.compliance.violations} ${t("issue(s)")}`}</p>
          )}
          {run.fixes.length > 0 && (
            <ul className="fixes">{run.fixes.slice(0, 3).map((f, i) => <li key={i}><b>{t(SCORE_META[f.axis as keyof Scores]?.label || f.axis)} (+{f.est_gain})</b> — {f.fix}</li>)}</ul>
          )}
        </Section>
      )}

      {/* Gated pause: the approval box sits at the very bottom — below ALL the
          content the paused stage produced (a stage can span several sections,
          e.g. council = AI experts + Lead editor's decisions). */}
      {run.awaiting && gate}

      {/* Working indicator — keeps "something is happening" visible through the
          non-streaming stages and the post-approve gap. */}
      {working && (
        <div className="rv-working">
          <span className="rv-working-ring" />
          <div className="rv-working-txt">
            <div className="rv-working-title">
              {t(running ? WORKING_LABELS[running.key] || "Working" : "Starting the next step")}
              <span className="rv-working-dots"><i /><i /><i /></span>
            </div>
            <div className="rv-working-sub">{t("The models are working — this can take a moment.")}</div>
          </div>
        </div>
      )}
    </div>
  );
}
