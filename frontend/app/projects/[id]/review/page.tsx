"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import Shell from "../../../../components/Shell";
import RunView from "../../../../components/RunView";
import GateBar from "../../../../components/GateBar";
import LiveStatus from "../../../../components/LiveStatus";
import { api } from "../../../../lib/api";
import { attachRunStream, emptyRun, type RunState } from "../../../../lib/run";
import { useLang } from "../../../../lib/i18n";
import type { Checkpoints, GatedStage } from "../../../../lib/types";

// Per-gate metadata: resume stage on approve, regenerate stage on reject, title.
// Every content step is gated (checkpoint key → behaviour); the "draft" gate
// resumes at "factcheck" and regenerates via the "article" stage.
const GATE_META: Record<string, { next: string; regenerate: string; title: string }> = {
  // "research" covers keywords + competitor research; regenerating restarts at
  // the keywords stage. The draft gate sits after the SEO polish.
  research: { next: "council", regenerate: "keywords", title: "Keyword & competitor research" },
  council: { next: "outline", regenerate: "council", title: "Council debate & strategy" },
  outline: { next: "article", regenerate: "outline", title: "Article outline" },
  draft: { next: "factcheck", regenerate: "article", title: "Article draft (polished)" },
};

// Rebuild a RunState from persisted artifacts so a page reload mid-flow shows
// the debate/strategy/outline already produced (and the gate awaiting sign-off).
async function hydrate(id: string, checkpoints: Checkpoints): Promise<RunState> {
  const r = emptyRun(id);
  const [debate, research, outline, draft, decisions, scores] = await Promise.all([
    api.getDebate(id).catch(() => null),
    api.getResearch(id).catch(() => null),
    api.getOutline(id).catch(() => null),
    api.getDraft(id).catch(() => null),
    api.getDecisions(id).catch(() => []),
    api.getScores(id).catch(() => []),
  ]);

  if (research) {
    r.research = research;
    r.keywords = research.keywords || null;
    r.stages.keywords = "done";
    r.stages.competitors = "done";
  }
  if (debate) {
    r.seats = (debate.reports || []).map((rep) => ({
      role: rep.role, provider: rep.provider, status: "done" as const,
      model: rep.model, confidence: rep.confidence, recommendations: rep.recommendations,
    }));
    r.debate = (debate.turns || [])
      .filter((tn) => tn.round >= 2 && tn.role !== "judge")
      .map((tn) => ({
        round: tn.round, role: tn.role, provider: tn.provider,
        addressed_to: tn.addressed_to, stance: tn.stance, text: tn.text,
      }));
    const verdict = (debate.turns || []).find((tn) => tn.stance === "verdict" || tn.role === "judge");
    if (verdict) r.judge = { text: verdict.text, streaming: false };
    r.conflicts = (debate.conflicts || []).length;
    if (r.seats.length) r.stages.council = "done";
  }
  r.decisions = decisions || [];
  if (outline?.nodes?.length) { r.outline = outline; r.stages.outline = "done"; }
  if (draft?.sections?.length) {
    r.draft = { id: draft.id, version: draft.version, word_count: draft.word_count, sections: draft.sections };
    r.stages.article = "done";
  }
  if (scores && scores[0]) r.scores = scores[0];

  // Which gate (if any) is paused awaiting sign-off?
  for (const g of ["research", "council", "outline", "draft"] as const) {
    if (checkpoints[g]?.status === "pending") {
      const m = GATE_META[g];
      r.awaiting = { stage: g, next: m.next, regenerate: m.regenerate };
      break;
    }
  }
  return r;
}

export default function ReviewPage() {
  const { t } = useLang();
  const { id } = useParams<{ id: string }>();

  const [run, setRun] = useState<RunState | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [topic, setTopic] = useState("");
  const esRef = useRef<EventSource | null>(null);

  const update = useCallback((fn: (r: RunState) => RunState) => {
    setRun((prev) => (prev ? fn(prev) : prev));
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const project = await api.getProject(id);
        if (!alive) return;
        setTopic(`${project.topic} · ${project.website} · ${project.keyword}`);
        const cp = await api.getCheckpoints(id).catch(() => ({ checkpoints: {}, next: null }));
        const r = await hydrate(id, (cp.checkpoints || {}) as Checkpoints);
        if (alive) setRun(r);
      } catch (e) {
        if (alive) setRun({ ...emptyRun(id), error: String(e) });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; esRef.current?.close(); };
  }, [id]);

  const startStream = useCallback((fromStage?: string) => {
    esRef.current?.close();
    update((r) => ({ ...r, awaiting: null, error: undefined }));
    esRef.current = attachRunStream(id, update, {
      gated: true,
      fromStage,
      onAwait: () => setRunning(false),
      onDone: () => setRunning(false),
      onError: () => setRunning(false),
      disconnectMsg: t("Live stream disconnected — reopen the page to resume."),
    });
    setRunning(true);
  }, [id, update, t]);

  function start() {
    setRun(emptyRun(id));
    startStream();
  }

  async function approve() {
    const g = run?.awaiting;
    if (!g) return;
    setBusy(true);
    try {
      await api.approveStage(id, g.stage as GatedStage);
      startStream(g.next); // resume from the next stage
    } catch (e) {
      update((r) => ({ ...r, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    const g = run?.awaiting;
    if (!g) return;
    setBusy(true);
    try {
      await api.rejectStage(id, g.stage as GatedStage, feedback.trim() || null);
      setFeedback("");
      startStream(g.regenerate); // re-run the stage that produces this artifact
    } catch (e) {
      update((r) => ({ ...r, error: String(e) }));
    } finally {
      setBusy(false);
    }
  }

  async function overrideDecision(decisionId: string, label: string) {
    if (!decisionId) return;
    try {
      const u = await api.updateDecision(id, decisionId, { label });
      update((r) => ({ ...r, decisions: r.decisions.map((d) => (d.id === decisionId ? { ...d, ...u } : d)) }));
    } catch { /* keep the current label on failure */ }
  }

  if (loading) return <Shell title="Review"><p className="muted">{t("Loading…")}</p></Shell>;

  const started = !!run && (run.seats.length > 0 || !!run.awaiting || !!run.done || running);

  return (
    <Shell
      title="Review — human in the loop"
      status={
        <div className="actions" style={{ margin: 0 }}>
          <LiveStatus run={run} busy={running} />
          <Link className="btn" href="/chat">{t("⚡ Auto-run instead")}</Link>
        </div>
      }
    >
      <p className="muted sub">{topic}</p>
      <p className="muted" style={{ marginTop: -4 }}>
        {t("The four models run and debate live, then the run pauses at each gate. Approve to continue, or reject with feedback to regenerate that step.")}
      </p>
      {run?.error && <p className="error">{run.error}</p>}

      {!started ? (
        <button className="btn btn-primary cta-convene" onClick={start} style={{ marginTop: 6 }}>
          {t("⚖ Convene the council — you approve each step")}
        </button>
      ) : (
        <>
          {run!.done && !run!.awaiting && (
            <div className="gatebar gatebar-done fade-in">
              <span className="gatebar-icon">✓</span>
              <div className="gatebar-title">{t("All steps approved — the article is written and scored below.")}</div>
            </div>
          )}
          {running && !run!.awaiting && (
            <p className="muted small" style={{ marginTop: 8 }}>{t("Running live — it will pause at the next step for your approval…")}</p>
          )}
          <ReviewSteps run={run!} t={t} />
          {/* The approval box renders INLINE inside RunView, right after the
              stage that paused — so you approve exactly what you just reviewed. */}
          <RunView
            run={run!}
            onOverride={overrideDecision}
            hideStepper
            busy={running}
            gate={
              run!.awaiting ? (
                <GateBar
                  stage={run!.awaiting.stage}
                  busy={busy}
                  feedback={feedback}
                  setFeedback={setFeedback}
                  onApprove={approve}
                  onReject={reject}
                />
              ) : undefined
            }
          />
        </>
      )}
    </Shell>
  );
}

// Progressive step tracker: reveals only the steps reached so far — the next
// one appears after the current is approved (one step at a time).
const STEP_KEYS = ["research", "council", "outline", "draft"] as const;
const STEP_LABEL: Record<string, string> = {
  research: "Research", council: "Council", outline: "Outline", draft: "Draft",
};

function ReviewSteps({ run, t }: { run: RunState; t: (s: string) => string }) {
  const hasData: Record<string, boolean> = {
    research: !!run.research || run.stages.competitors === "done",
    council: run.seats.length > 0,
    outline: !!run.outline,
    draft: !!(run.draft?.sections?.length),
  };
  let lastData = -1;
  STEP_KEYS.forEach((k, i) => { if (hasData[k]) lastData = i; });
  const awaitingIdx = run.awaiting ? STEP_KEYS.indexOf(run.awaiting.stage as (typeof STEP_KEYS)[number]) : -1;
  const currentIdx = run.done ? STEP_KEYS.length - 1 : awaitingIdx >= 0 ? awaitingIdx : Math.max(0, lastData);
  const reveal = STEP_KEYS.slice(0, currentIdx + 1);

  return (
    <div className="revsteps fade-in">
      <div className="revsteps-count">
        {run.done ? t("All steps complete") : `${t("Step")} ${currentIdx + 1} ${t("of")} ${STEP_KEYS.length}`}
      </div>
      <div className="revsteps-row">
        {reveal.map((k, i) => {
          const state = run.done
            ? "done"
            : i < currentIdx
              ? "done"
              : run.awaiting
                ? "awaiting"
                : "current";
          return (
            <div key={k} className={`revstep revstep-${state}`}>
              <span className="revstep-dot">
                {state === "done" ? "✓" : state === "awaiting" ? "⏸" : i + 1}
              </span>
              <span className="revstep-label">{t(STEP_LABEL[k])}</span>
            </div>
          );
        })}
        {!run.done && currentIdx < STEP_KEYS.length - 1 && (
          <span className="revstep revstep-next">{t("next reveals after you approve")}</span>
        )}
      </div>
    </div>
  );
}

