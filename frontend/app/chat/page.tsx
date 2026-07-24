"use client";

import { useEffect, useRef, useState } from "react";
import RunView, { type RunState } from "../../components/RunView";
import Shell from "../../components/Shell";
import GateBar from "../../components/GateBar";
import LiveStatus from "../../components/LiveStatus";
import { api } from "../../lib/api";
import { attachRunStream, emptyRun } from "../../lib/run";
import { useLang } from "../../lib/i18n";
import { safeHref } from "../../lib/safe";
import type { GatedStage } from "../../lib/types";

const FORMATS = [
  "Review", "Buying guide", "Listicle", "How-to", "Comparison", "Versus",
  "Ultimate guide", "Tutorial", "Explainer", "Case study", "Roundup",
  "Alternatives", "FAQ", "Checklist", "Opinion", "Interview", "Data study",
  "News", "Glossary", "Pillar page",
];
const TONES = [
  "we-not-I", "friendly", "professional", "casual", "authoritative",
  "conversational", "expert", "technical", "persuasive", "witty",
  "empathetic", "bold", "inspirational", "journalistic", "storytelling",
  "data-driven", "contrarian", "premium", "enthusiastic", "formal",
];
// Target article length (words). "" = Auto (let the models decide the depth).
const LENGTHS: { label: string; value: string }[] = [
  { label: "Auto", value: "" },
  { label: "~800", value: "800" },
  { label: "~1200", value: "1200" },
  { label: "~1500", value: "1500" },
  { label: "~2000", value: "2000" },
  { label: "~2500", value: "2500" },
  { label: "~3500", value: "3500" },
];

type ChatMsg =
  | { id: string; role: "user"; kind: "text"; text: string }
  | { id: string; role: "assistant"; kind: "text"; text: string }
  | { id: string; role: "assistant"; kind: "run"; run: RunState };

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState("");
  const [words, setWords] = useState(""); // target word count ("" = auto)
  const [showAllFormats, setShowAllFormats] = useState(false);
  // Run mode: "auto" runs straight through; "gated" pauses at each step for your
  // approval (same engine as the /review page, surfaced right here in chat).
  const [mode, setMode] = useState<"auto" | "gated">("auto");
  const [feedback, setFeedback] = useState("");
  // Empty by default — the user DESCRIBES their article in plain language (the
  // pipeline derives the keyword itself). "Try a sample" fills an example on
  // demand, so nothing runs by accident.
  const [d, setD] = useState({
    topic: "", website: "", country: "US",
    audience: "", tone: "", goal: "", link: "",
  });
  function fillSample() {
    setD({
      topic:
        "Best standing desks for a home office in 2026 — for remote workers comparing options under $600. Practical, honest, with real pros and cons.",
      website: "",
      country: "US",
      audience: "remote workers setting up a home office",
      tone: "friendly",
      goal: "rank on Google + AI answers",
      link: "",
    });
    setFormat("Buying guide");
    setWords("1500");
  }
  const { t: tr } = useLang();
  const idc = useRef(0);
  const activeRun = useRef<string | null>(null);
  const lastProject = useRef<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const end = useRef<HTMLDivElement | null>(null);

  const nid = () => String(++idc.current);
  // Auto-scroll to the newest content, but only when the user is already near the
  // bottom — so live token streaming doesn't yank the page while they're reading.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const nearBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 260;
    if (nearBottom) end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);
  useEffect(() => () => esRef.current?.close(), []);

  const push = (m: ChatMsg) => setMessages((p) => [...p, m]);
  const text = (role: "assistant", t: string) => push({ id: nid(), role, kind: "text", text: t });

  function updateRun(rid: string, fn: (r: RunState) => RunState) {
    setMessages((p) => p.map((m) => (m.id === rid && m.kind === "run" ? { ...m, run: fn(m.run) } : m)));
  }

  // Attach the SSE stream to an existing run message (rid). All SSE wiring —
  // token batching, the live debate, the streamed Judge, draft sections, and the
  // gated "awaiting approval" pause — lives in attachRunStream so every surface
  // renders identically. `fromStage` resumes a gated run after an approve/reject.
  function attachToMessage(rid: string, projectId: string, gated: boolean, fromStage?: string) {
    esRef.current?.close();
    setBusy(true);
    lastProject.current = projectId;
    activeRun.current = rid;
    esRef.current = attachRunStream(projectId, (fn) => updateRun(rid, fn), {
      gated,
      fromStage,
      onAwait: () => setBusy(false),   // paused at a gate — hand control to the user
      onDone: () => setBusy(false),
      onError: () => setBusy(false),
      disconnectMsg: tr("Live stream disconnected — retry the run."),
    });
  }

  function streamRun(projectId: string, gated = false) {
    const rid = nid();
    push({ id: rid, role: "assistant", kind: "run", run: emptyRun(projectId) });
    attachToMessage(rid, projectId, gated);
  }

  // "Approve each step": resume the same run message from the next stage.
  async function approveGate(rid: string, pid: string, g: { stage: string; next: string; regenerate: string }) {
    setBusy(true);
    try {
      await api.approveStage(pid, g.stage as GatedStage);
      updateRun(rid, (r) => ({ ...r, awaiting: null, error: undefined }));
      attachToMessage(rid, pid, true, g.next);
    } catch (e) {
      updateRun(rid, (r) => ({ ...r, error: String(e) }));
      setBusy(false);
    }
  }

  async function rejectGate(rid: string, pid: string, g: { stage: string; next: string; regenerate: string }) {
    setBusy(true);
    try {
      await api.rejectStage(pid, g.stage as GatedStage, feedback.trim() || null);
      setFeedback("");
      updateRun(rid, (r) => ({ ...r, awaiting: null, error: undefined }));
      attachToMessage(rid, pid, true, g.regenerate);
    } catch (e) {
      updateRun(rid, (r) => ({ ...r, error: String(e) }));
      setBusy(false);
    }
  }

  async function startBrief(message: string) {
    setBusy(true);
    try {
      const project = await api.createFromMessage(message);
      streamRun(project.id, mode === "gated");
    } catch (e) { text("assistant", `Error: ${String(e)}`); setBusy(false); }
  }

  // Once a run exists, free-text becomes a conversation about that content
  // (grounded in its draft/decisions) instead of starting a new brief.
  async function chatFollowup(message: string) {
    const pid = lastProject.current;
    if (!pid) { startBrief(message); return; }
    setBusy(true);
    try {
      const { reply } = await api.chat(pid, message);
      text("assistant", reply);
    } catch (e) {
      text("assistant", `Error: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function handleCommand(raw: string) {
    const pid = lastProject.current;
    const [cmd, ...rest] = raw.trim().slice(1).split(/\s+/);
    if (!pid) { text("assistant", tr("Start a content brief first, then commands act on it.")); return; }
    if (cmd === "rerun" || cmd === "run") { streamRun(pid, mode === "gated"); return; }
    if (cmd === "editor") { text("assistant", `Open the editor → [editor](/projects/${pid}/editor)`); return; }
    if (cmd === "export") { text("assistant", `Export: [MD](${api.exportUrl(pid, "markdown")}) · [HTML](${api.exportUrl(pid, "html")}) · [JSON-LD](${api.exportUrl(pid, "jsonld")})`); return; }
    if (cmd === "regenerate") {
      const n = Math.max(0, parseInt(rest[0] || "1", 10) - 1);
      try { const diff = await api.regenerateSection(pid, n); text("assistant", `↻ Regenerated section ${n + 1} — "${diff.new.heading}":\n\n${diff.new.markdown}`); }
      catch (e) { text("assistant", `Error: ${String(e)}`); }
      return;
    }
    text("assistant", tr("Commands: /rerun · /regenerate N · /export · /editor"));
  }

  async function override(decisionId: string, label: string) {
    const pid = lastProject.current;
    if (!pid || !decisionId) return;
    try {
      const u = await api.updateDecision(pid, decisionId, { label });
      setMessages((ms) => ms.map((m) => (m.kind === "run" ? { ...m, run: { ...m.run, decisions: m.run.decisions.map((d) => (d.id === decisionId ? { ...d, ...u } : d)) } } : m)));
    } catch { /* */ }
  }

  function stop() { esRef.current?.close(); setBusy(false); }

  function clearBrief() {
    setD({ topic: "", website: "", country: "US", audience: "", tone: "", goal: "", link: "" });
    setFormat("");
    setWords("");
  }

  function send() {
    if (busy) return;
    if (messages.length === 0 && d.topic.trim()) { submitDetails(); return; }
    const value = input.trim();
    if (!value) return;
    push({ id: nid(), role: "user", kind: "text", text: value });
    setInput("");
    if (value.startsWith("/")) handleCommand(value);
    else if (lastProject.current) chatFollowup(value);
    else startBrief(value);
  }

  async function submitDetails() {
    const free = input.trim();
    const brief = {
      website: d.website.trim() || "unassigned",
      topic: d.topic.trim(),
      // Deliberately blank: the pipeline's keyword-research stage derives the
      // primary keyword from the description (and shows its reasoning).
      keyword: "",
      country: d.country.trim() || "US",
      audience: d.audience.trim() || null,
      tone: d.tone.trim() || null,
      article_type: format || null,
      word_count: words ? parseInt(words, 10) : null,
      goal: [d.link.trim() ? `Reference: ${d.link.trim()}` : "", d.goal.trim(), free].filter(Boolean).join(" · ") || null,
    };
    const shortTopic = brief.topic.length > 120 ? `${brief.topic.slice(0, 117)}…` : brief.topic;
    const summary =
      `📋 ${shortTopic}` +
      (brief.article_type ? `  ·  ${brief.article_type}` : "") +
      (brief.word_count ? `  ·  ~${brief.word_count} words` : "") +
      (brief.tone ? `  ·  tone: ${brief.tone}` : "") +
      (brief.audience ? `  ·  for ${brief.audience}` : "");
    push({ id: nid(), role: "user", kind: "text", text: summary });
    setInput("");
    setBusy(true);
    try {
      const p = await api.createProject(brief);
      streamRun(p.id, mode === "gated");
    } catch (e) {
      text("assistant", `Error: ${String(e)}`);
      setBusy(false);
    }
  }

  const hasProject = messages.some((m) => m.kind === "run");
  // The run currently streaming/paused — drives the animated header status.
  const activeMsg = messages.find((m) => m.kind === "run" && m.id === activeRun.current);
  const activeRunState = activeMsg && activeMsg.kind === "run" ? activeMsg.run : null;

  return (
    <Shell title="Chat" status={<LiveStatus run={activeRunState} busy={busy} />}>
      <div className={`chat ${messages.length === 0 ? "chat-start" : ""}`}>
        <div className="thread">
          {messages.length === 0 && (
            <div className="welcome">
              <h2>{tr("Describe the article you want")}</h2>
              <p className="muted">{tr("Just describe it — we find the keywords, study the pages that rank, debate the best angle, then write and polish a draft. Nothing is published.")}</p>
            </div>
          )}

          {messages.map((m) =>
            m.kind === "run" ? (
              <RunView
                key={m.id}
                run={m.run}
                onOverride={override}
                busy={busy && activeRun.current === m.id}
                onRerun={() => streamRun(m.run.projectId, mode === "gated")}
                gate={m.run.awaiting ? (
                  <GateBar
                    stage={m.run.awaiting.stage}
                    busy={busy}
                    feedback={feedback}
                    setFeedback={setFeedback}
                    onApprove={() => approveGate(m.id, m.run.projectId, m.run.awaiting!)}
                    onReject={() => rejectGate(m.id, m.run.projectId, m.run.awaiting!)}
                  />
                ) : undefined}
              />
            ) : (
              <div key={m.id} className={`bubble ${m.role}`}>
                {m.role === "assistant" ? <Markdownish text={m.text} /> : m.text}
              </div>
            ),
          )}
          <div ref={end} />
        </div>

        {messages.length === 0 && (
          <div className="brief-form">
            {/* The ONE field you must fill: describe the article in your words.
                Keyword research happens in the pipeline — no keyword box. */}
            <label className="bf-field bf-topic"><span className="bf-lbl">{tr("Describe your article")} <em>*</em></span>
              <textarea
                value={d.topic}
                onChange={(e) => setD({ ...d, topic: e.target.value })}
                placeholder={tr("e.g. Best standing desks for a home office in 2026 — for remote workers on a budget. Honest comparisons, real pros and cons.")}
                rows={3}
                maxLength={500}
              />
              <span className="bf-hint">{tr("Topic + who it's for + the angle. We'll find the keywords for you.")}</span>
            </label>

            <div className="bf-detrow">
              <span className="bf-detlabel">{tr("Details")} <span className="bf-detopt">{tr("(optional)")}</span></span>
              <button className="bf-sample" onClick={fillSample} type="button">{tr("Try a sample")}</button>
            </div>

            <div className="bf-details">
                <div className="bf-chiprow">
                  <span className="bf-chiplabel">{tr("Format")}</span>
                  {(showAllFormats ? FORMATS : FORMATS.slice(0, 8)).map((f) => <button key={f} className={`bf-chip ${format === f ? "on" : ""}`} onClick={() => setFormat(format === f ? "" : f)}>{tr(f)}</button>)}
                  {!showAllFormats && <button className="bf-chip bf-chip-more" onClick={() => setShowAllFormats(true)} type="button">{tr("More")}…</button>}
                </div>

                <div className="bf-chiprow">
                  <span className="bf-chiplabel">{tr("Length")}</span>
                  {LENGTHS.map((l) => (
                    <button
                      key={l.label}
                      type="button"
                      className={`bf-chip ${words === l.value ? "on" : ""}`}
                      onClick={() => setWords(l.value)}
                    >
                      {l.value ? `${l.label} ${tr("words")}` : tr("Auto")}
                    </button>
                  ))}
                </div>

                {/* Rarely-needed fields live behind one collapsed row */}
                <details className="bf-adv">
                  <summary>{tr("More options")} · {tr("audience, tone, country, website")}</summary>
                  <div className="bf-grid">
                    <label className="bf-field">{tr("Audience")}
                      <input value={d.audience} onChange={(e) => setD({ ...d, audience: e.target.value })} placeholder={tr("who is this for?")} />
                    </label>
                    <label className="bf-field">{tr("Tone")}
                      <span className="bf-select"><input list="dl-tone" value={d.tone} onChange={(e) => setD({ ...d, tone: e.target.value })} placeholder={tr("e.g. friendly")} /></span>
                    </label>
                    <label className="bf-field">{tr("Country")}
                      <span className="bf-select"><input list="dl-country" value={d.country} onChange={(e) => setD({ ...d, country: e.target.value })} /></span>
                    </label>
                    <label className="bf-field">{tr("Your website")}
                      <input value={d.website} onChange={(e) => setD({ ...d, website: e.target.value })} placeholder="yoursite.com" />
                    </label>
                    <label className="bf-field">{tr("Goal")}
                      <span className="bf-select"><input list="dl-goal" value={d.goal} onChange={(e) => setD({ ...d, goal: e.target.value })} placeholder={tr("rank on Google + AI answers")} /></span>
                    </label>
                    <label className="bf-field">{tr("Reference link")}
                      <input type="url" value={d.link} onChange={(e) => setD({ ...d, link: e.target.value })} placeholder="https://competitor.com/post" />
                    </label>
                  </div>
                </details>
              </div>

            <div className="bf-mode" role="group" aria-label={tr("Run mode")}>
              <button type="button" className={`bf-modebtn ${mode === "auto" ? "on" : ""}`} onClick={() => setMode("auto")}>
                <span className="bf-modetop">⚡ {tr("Watch it run")}</span>
                <span className="bf-modehint">{tr("runs start to finish")}</span>
              </button>
              <button type="button" className={`bf-modebtn ${mode === "gated" ? "on" : ""}`} onClick={() => setMode("gated")}>
                <span className="bf-modetop">✋ {tr("Approve each step")}</span>
                <span className="bf-modehint">{tr("pause & approve each stage")}</span>
              </button>
            </div>

            <div className="bf-footer">
              {(d.topic || format) && <button className="bf-clear" onClick={() => { clearBrief(); setShowAllFormats(false); }}>{tr("Clear")}</button>}
              <button className="btn btn-primary cta-convene" onClick={() => send()} disabled={busy || !d.topic.trim()}>
                <svg className="cta-borderfx" viewBox="0 0 232 46" preserveAspectRatio="none" aria-hidden="true">
                  <defs>
                    <linearGradient id="ctaStroke" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="232" y2="0">
                      <stop offset="0" stopColor="#10b981" />
                      <stop offset="0.3" stopColor="#6ee7b7" />
                      <stop offset="0.5" stopColor="#ffffff" />
                      <stop offset="0.7" stopColor="#22d3ee" />
                      <stop offset="1" stopColor="#10b981" />
                      <animateTransform attributeName="gradientTransform" type="rotate" from="0 116 23" to="360 116 23" dur="3s" repeatCount="indefinite" />
                    </linearGradient>
                  </defs>
                  <rect x="2" y="2" width="228" height="42" rx="10" ry="10" fill="none" stroke="url(#ctaStroke)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
                </svg>
                <svg className="cta-bolt" viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
                  <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
                </svg>
                {mode === "gated" ? tr("Start — I'll approve each step") : tr("Write my article")}
              </button>
            </div>
            <p className="bf-cta-note">{tr("~3 min · keywords → competitors → debate → outline → write → polish → checks · nothing is published")}</p>

            <datalist id="dl-country"><option value="US" /><option value="UK" /><option value="IN" /><option value="CA" /><option value="AU" /><option value="Global" /></datalist>
            <datalist id="dl-tone">{TONES.map((t) => <option key={t} value={t} />)}</datalist>
            <datalist id="dl-goal"><option value="rank on Google and appear in AI answers" /><option value="drive signups" /><option value="educate readers" /><option value="compare options for buyers" /></datalist>
          </div>
        )}

        {messages.length > 0 && (
          <div className="composer">
            <textarea
              value={input}
              rows={Math.min(5, input.split("\n").length)}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
              placeholder={hasProject ? tr("Ask a follow-up about this article…") : tr("Type a message…")}
            />
            {busy ? (
              <button className="btn btn-stop" onClick={stop} title={tr("Stop")}>■</button>
            ) : (
              <button className="btn btn-primary" onClick={() => send()} disabled={!input.trim()}>▶</button>
            )}
          </div>
        )}
      </div>
    </Shell>
  );
}

function Markdownish({ text }: { text: string }) {
  const parts = text.split(/(\[[^\]]+\]\([^)]+\))/g);
  return (
    <span style={{ whiteSpace: "pre-wrap" }}>
      {parts.map((p, i) => {
        const m = p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        const href = m ? safeHref(m[2]) : null;
        return m && href
          ? <a key={i} href={href} target="_blank" rel="noreferrer noopener">{m[1]}</a>
          : <span key={i}>{m ? m[1] : p}</span>;
      })}
    </span>
  );
}
