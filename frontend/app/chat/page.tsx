"use client";

import { useEffect, useRef, useState } from "react";
import RunView, { type RunState, type SeatBox } from "../../components/RunView";
import { PIPELINE_STAGES, type StageStatus } from "../../components/PipelineStepper";
import Shell from "../../components/Shell";
import { api } from "../../lib/api";
import { useLang } from "../../lib/i18n";
import { safeHref } from "../../lib/safe";
import type { PipelineSummary } from "../../lib/types";

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

type ChatMsg =
  | { id: string; role: "user"; kind: "text"; text: string }
  | { id: string; role: "assistant"; kind: "text"; text: string }
  | { id: string; role: "assistant"; kind: "run"; run: RunState };

const emptyStages = (): Record<string, StageStatus> =>
  Object.fromEntries(PIPELINE_STAGES.map((s) => [s.key, "pending"]));

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState("Review");
  // Prefilled with a ready-to-run sample brief (keyword aligned to topic for good
  // scores). Click "Make it rank" immediately, or edit / Clear to start fresh.
  const [d, setD] = useState({
    topic: "FeetFinder Review 2026: Is it safe, legit, and worth it for sellers?",
    keyword: "feetfinder review",
    website: "spicyranked.com",
    country: "US",
    audience: "first-time sellers deciding whether to join",
    tone: "we-not-I",
    goal: "rank on Google + AI answers",
    link: "",
  });
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

  function streamRun(projectId: string) {
    esRef.current?.close();
    setBusy(true);
    lastProject.current = projectId;
    const rid = nid();
    activeRun.current = rid;
    push({
      id: rid, role: "assistant", kind: "run",
      run: {
        projectId,
        startedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        stages: emptyStages(), seats: [], conflicts: 0, decisions: [], claims: [], fixes: [],
      },
    });

    const es = new EventSource(api.streamUrl(projectId));
    esRef.current = es;
    let finished = false;

    // Token batching: a long run streams thousands of deltas; applying each to
    // React state one-by-one causes a re-render storm. Buffer deltas and flush
    // once per animation frame instead (seats, rebuttals and draft sections).
    let seatBuf: Record<string, string> = {};
    let critBuf: Record<string, string> = {};
    let secBuf: Record<number, string> = {};
    let flushPending = false;
    const flush = () => {
      flushPending = false;
      const seats = seatBuf, crits = critBuf, secs = secBuf;
      seatBuf = {}; critBuf = {}; secBuf = {};
      const seatKeys = Object.keys(seats), critKeys = Object.keys(crits), secKeys = Object.keys(secs);
      if (!seatKeys.length && !critKeys.length && !secKeys.length) return;
      updateRun(rid, (r) => {
        let next = r;
        if (seatKeys.length || critKeys.length) {
          next = { ...next, seats: next.seats.map((s) => {
            let ns = s;
            if (seats[s.role] !== undefined) ns = { ...ns, draftText: (ns.draftText || "") + seats[s.role] };
            if (crits[s.role] !== undefined) ns = { ...ns, critiqueText: (ns.critiqueText || "") + crits[s.role] };
            return ns;
          }) };
        }
        if (secKeys.length && next.draft?.sections) {
          const sections = [...next.draft.sections];
          for (const key of secKeys) {
            const idx = Number(key), cur = sections[idx];
            if (cur) sections[idx] = { ...cur, markdown: cur.markdown + secs[idx], streaming: true };
          }
          next = { ...next, draft: { ...next.draft, sections } };
        }
        return next;
      });
    };
    const schedule = () => { if (!flushPending) { flushPending = true; requestAnimationFrame(flush); } };

    es.addEventListener("stage", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      updateRun(rid, (r) => ({ ...r, stages: { ...r.stages, [d.stage]: d.status === "start" ? "running" : "done" } }));
      if (d.status === "done") {
        if (d.stage === "research") api.getResearch(projectId).then((x) => updateRun(rid, (r) => ({ ...r, research: x }))).catch(() => {});
        if (d.stage === "outline") api.getOutline(projectId).then((x) => updateRun(rid, (r) => ({ ...r, outline: x }))).catch(() => {});
        // Article draft is now built live from section_* token events — no fetch.
        if (d.stage === "council") updateRun(rid, (r) => ({ ...r, strategy: d.info?.strategy_summary || r.strategy }));
      }
    });
    es.addEventListener("roster", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      updateRun(rid, (r) => ({ ...r, seats: d.seats.map((s: SeatBox) => ({ ...s, status: "waiting" })) }));
    });
    // A seat picked its provider and started — flip its box to live "typing".
    es.addEventListener("report_start", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      updateRun(rid, (r) => ({ ...r, seats: r.seats.map((s) => (s.role === d.role ? { ...s, status: "streaming", model: d.model, routed_from: d.routed_from, draftText: "" } : s)) }));
    });
    // A token/chunk from a seat — buffer it (flushed once per frame).
    es.addEventListener("report_delta", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      seatBuf[d.role] = (seatBuf[d.role] || "") + d.delta;
      schedule();
    });
    es.addEventListener("seat_error", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      delete seatBuf[d.role];
      updateRun(rid, (r) => ({ ...r, seats: r.seats.map((s) => (s.role === d.role ? { ...s, status: "done", recommendations: [`⚠ ${d.error}`] } : s)) }));
    });
    es.addEventListener("report", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      delete seatBuf[d.role];
      updateRun(rid, (r) => ({ ...r, seats: r.seats.map((s) => (s.role === d.role ? { ...s, status: "done", model: d.model, confidence: d.confidence, recommendations: d.recommendations, routed_from: d.routed_from } : s)) }));
    });
    // Round 2 — a seat's live rebuttal of the others.
    es.addEventListener("critique_start", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      updateRun(rid, (r) => ({ ...r, seats: r.seats.map((s) => (s.role === d.role ? { ...s, critiqueText: "", debating: true } : s)) }));
    });
    es.addEventListener("critique_delta", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      critBuf[d.role] = (critBuf[d.role] || "") + d.delta;
      schedule();
    });
    es.addEventListener("critique", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      delete critBuf[d.role];
      updateRun(rid, (r) => ({ ...r, seats: r.seats.map((s) => (s.role === d.role ? { ...s, critiqueText: d.text, debating: false } : s)) }));
    });
    // Article: sections open, then "type" token-by-token, then resolve to final.
    es.addEventListener("section_start", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      updateRun(rid, (r) => {
        const sections = r.draft?.sections ? [...r.draft.sections] : [];
        while (sections.length <= d.index) sections.push({ heading: "…", level: 2, markdown: "", streaming: true });
        sections[d.index] = { heading: d.heading, level: d.level, markdown: "", streaming: true };
        return { ...r, draft: { ...(r.draft || {}), sections } };
      });
    });
    es.addEventListener("section_delta", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      secBuf[d.index] = (secBuf[d.index] || "") + d.delta;
      schedule();
    });
    es.addEventListener("section_done", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      delete secBuf[d.index];
      updateRun(rid, (r) => {
        const sections = r.draft?.sections ? [...r.draft.sections] : [];
        while (sections.length <= d.index) sections.push({ heading: "…", level: 2, markdown: "", streaming: false });
        // Replace live text with the canonical (JSON-cleaned) body.
        sections[d.index] = { heading: d.heading, level: d.level, markdown: d.markdown, streaming: false };
        const word_count = sections.reduce((n, s) => n + (s.markdown.trim() ? s.markdown.trim().split(/\s+/).length : 0), 0);
        return { ...r, draft: { ...r.draft, sections, word_count } };
      });
    });
    es.addEventListener("conflict", () => updateRun(rid, (r) => ({ ...r, conflicts: r.conflicts + 1 })));
    es.addEventListener("decision", (e) => {
      const d = JSON.parse((e as MessageEvent).data);
      updateRun(rid, (r) => ({ ...r, decisions: [...r.decisions, { id: "", overridden_by: null, ...d }] }));
    });
    es.addEventListener("done", (e) => {
      finished = true;
      flush();  // apply any buffered tokens before finalising
      const s = JSON.parse((e as MessageEvent).data) as PipelineSummary;
      updateRun(rid, (r) => ({ ...r, scores: s.scores, gate: s.gate, fixes: s.top_fixes, compliance: s.compliance, strategy: s.council.strategy_summary, stages: Object.fromEntries(PIPELINE_STAGES.map((x) => [x.key, "done"])) }));
      es.close(); setBusy(false);
      api.getDecisions(projectId).then((x) => updateRun(rid, (r) => ({ ...r, decisions: x }))).catch(() => {});
      api.getClaims(projectId).then((x) => updateRun(rid, (r) => ({ ...r, claims: x }))).catch(() => {});
    });
    es.addEventListener("error", (e) => {
      try { const d = JSON.parse((e as MessageEvent).data); updateRun(rid, (r) => ({ ...r, error: d.detail })); } catch { /* */ }
    });
    es.onerror = () => {
      if (!finished) {
        updateRun(rid, (r) => ({ ...r, error: tr("Live stream disconnected — retry the run.") }));
        es.close();
        setBusy(false);
      }
    };
  }

  async function startBrief(message: string) {
    setBusy(true);
    try {
      const project = await api.createFromMessage(message);
      streamRun(project.id);
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
    if (cmd === "rerun" || cmd === "run") { streamRun(pid); return; }
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
    setD({ topic: "", keyword: "", website: "", country: "US", audience: "", tone: "", goal: "", link: "" });
    setFormat("");
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
      keyword: d.keyword.trim() || d.topic.trim(),
      country: d.country.trim() || "US",
      audience: d.audience.trim() || null,
      tone: d.tone.trim() || null,
      goal: [format ? `Format: ${format}` : "", d.link.trim() ? `Reference: ${d.link.trim()}` : "", d.goal.trim(), free].filter(Boolean).join(" · ") || null,
    };
    const summary =
      `📋 ${brief.topic}  ·  kw: ${brief.keyword}` +
      (brief.tone ? `  ·  tone: ${brief.tone}` : "") +
      (brief.audience ? `  ·  for ${brief.audience}` : "");
    push({ id: nid(), role: "user", kind: "text", text: summary });
    setInput("");
    setBusy(true);
    try {
      const p = await api.createProject(brief);
      streamRun(p.id);
    } catch (e) {
      text("assistant", `Error: ${String(e)}`);
      setBusy(false);
    }
  }

  const hasProject = messages.some((m) => m.kind === "run");

  return (
    <Shell title="Chat" status={busy ? <span className="pill warn">{tr("running")}…</span> : undefined}>
      <div className={`chat ${messages.length === 0 ? "chat-start" : ""}`}>
        <div className="thread">
          {messages.length === 0 && (
            <div className="welcome">
              <h2>{tr("What should the council write?")}</h2>
              <p className="muted">{tr("Describe a topic — research, all four models debating live, the Judge, drafting and scoring stream right here.")}</p>
            </div>
          )}

          {messages.map((m) =>
            m.kind === "run" ? (
              <RunView key={m.id} run={m.run} onOverride={override} />
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
            <div className="bf-grid">
              <label className="bf-field bf-topic"><span className="bf-lbl">{tr("Topic")} <em>*</em></span>
                <textarea value={d.topic} onChange={(e) => setD({ ...d, topic: e.target.value })} placeholder={tr("FeetFinder Review 2026 — what should the council write about?")} rows={1} />
              </label>
              <label className="bf-field">{tr("Primary keyword")}
                <input value={d.keyword} onChange={(e) => setD({ ...d, keyword: e.target.value })} placeholder="feetfinder reviews" />
              </label>
              <label className="bf-field">{tr("Website")}
                <input value={d.website} onChange={(e) => setD({ ...d, website: e.target.value })} placeholder="spicyranked.com" />
              </label>
              <label className="bf-field">{tr("Country")}
                <span className="bf-select"><input list="dl-country" value={d.country} onChange={(e) => setD({ ...d, country: e.target.value })} /></span>
              </label>
              <label className="bf-field">{tr("Audience")}
                <input value={d.audience} onChange={(e) => setD({ ...d, audience: e.target.value })} placeholder={tr("buyers evaluating the platform")} />
              </label>
              <label className="bf-field">{tr("Tone")}
                <span className="bf-select"><input list="dl-tone" value={d.tone} onChange={(e) => setD({ ...d, tone: e.target.value })} placeholder="we-not-I" /></span>
              </label>
              <label className="bf-field">{tr("Reference link")}
                <input type="url" value={d.link} onChange={(e) => setD({ ...d, link: e.target.value })} placeholder="https://competitor.com/post" />
              </label>
              <label className="bf-field">{tr("Goal")}
                <span className="bf-select"><input list="dl-goal" value={d.goal} onChange={(e) => setD({ ...d, goal: e.target.value })} placeholder={tr("rank on Google + AI answers")} /></span>
              </label>
            </div>

            <div className="bf-chiprow">
              <span className="bf-chiplabel">{tr("Format")}</span>
              {FORMATS.map((f) => <button key={f} className={`bf-chip ${format === f ? "on" : ""}`} onClick={() => setFormat(format === f ? "" : f)}>{tr(f)}</button>)}
            </div>
            <div className="bf-chiprow">
              <span className="bf-chiplabel">{tr("Tone")}</span>
              {TONES.map((tone) => <button key={tone} className={`bf-chip ${d.tone === tone ? "on" : ""}`} onClick={() => setD({ ...d, tone: d.tone === tone ? "" : tone })}>{tr(tone)}</button>)}
            </div>

            <div className="bf-footer">
              <button className="bf-clear" onClick={clearBrief}>{tr("Clear")}</button>
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
                {tr("Make it rank")}
              </button>
            </div>

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
              placeholder={hasProject ? tr("Ask a follow-up about this content…  (· /rerun /regenerate 2 /export · New chat = fresh brief)") : tr("Type a message…  (Shift+Enter = newline)")}
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
