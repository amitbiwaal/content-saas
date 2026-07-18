// Shared live-run layer: the RunState shape every surface renders, plus
// attachRunStream() — one place that opens the SSE EventSource, batches tokens
// (report / debate-turn / draft-section / judge deltas) once per animation
// frame, and reduces every event into RunState. Chat, the journey view and the
// project page all drive off this so the live pairwise debate + streamed Judge
// look identical everywhere (no more per-page EventSource wiring).

import { api } from "./api";
import { creditsChanged, getToken } from "./auth";
import { PIPELINE_STAGES, type StageStatus } from "../components/PipelineStepper";
import type {
  Claim, Decision, DraftSection, Outline, PipelineSummary, Research, Scores, TopFix,
} from "./types";

// A draft section that may still be streaming tokens (live "typing").
export type LiveSection = DraftSection & { streaming?: boolean };

export type SeatBox = {
  role: string; provider: string; status: "waiting" | "streaming" | "done";
  model?: string; confidence?: number | null; recommendations?: string[]; routed_from?: string | null;
  // Accumulated tokens while the seat streams its opening report (round 1).
  draftText?: string;
};

// One utterance in the debate timeline (rounds 2+): a rebuttal or a reply,
// threaded by who it addresses, with a DEFEND/CONCEDE/REVISE/… stance badge.
export type DebateTurnView = {
  round: number;
  role: string;
  provider?: string;
  addressed_to?: string | null;
  stance: string;
  text: string;
  streaming?: boolean;
};

export type RunState = {
  projectId: string;
  startedAt?: string;
  stages: Record<string, StageStatus>;
  research?: Research | null;
  seats: SeatBox[];
  conflicts: number;
  // The threaded back-and-forth (rounds 2+), in arrival order.
  debate: DebateTurnView[];
  // The Judge's live deliberation over the whole debate.
  judge?: { text: string; streaming?: boolean } | null;
  strategy?: string;
  decisions: Decision[];
  outline?: Outline | null;
  draft?: { id?: string; version?: number; word_count?: number; sections: LiveSection[] } | null;
  claims: Claim[];
  scores?: Scores | null;
  gate?: { passed: boolean; reasons: string[] } | null;
  fixes: TopFix[];
  compliance?: { passed: boolean; violations: number } | null;
  // Gated mode: set when the run pauses at a gate for human sign-off.
  // stage = checkpoint key to approve/reject; next = stage to resume on approve;
  // regenerate = stage to re-run on reject-with-feedback.
  awaiting?: { stage: string; next: string; regenerate: string } | null;
  done?: boolean;
  error?: string;
};

export const emptyStages = (): Record<string, StageStatus> =>
  Object.fromEntries(PIPELINE_STAGES.map((s) => [s.key, "pending"]));

export function emptyRun(projectId: string): RunState {
  return {
    projectId,
    startedAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
    stages: emptyStages(),
    seats: [],
    conflicts: 0,
    debate: [],
    judge: null,
    decisions: [],
    claims: [],
    fixes: [],
    awaiting: null,
  };
}

type Update = (fn: (r: RunState) => RunState) => void;

/**
 * Open the live pipeline SSE stream and reduce every event into RunState.
 *
 * @param projectId  project to run
 * @param update     apply a reducer to wherever the caller stores this run's
 *                   state (a chat message, a page useState, …)
 * @param opts.onDone     called once with the final summary
 * @param opts.onError    called with a human message on disconnect/failure
 * @param opts.disconnectMsg  shown if the socket drops before "done"
 * @param opts.fromStage  resume the pipeline at this stage (Phase 2 gates)
 * @returns the EventSource so the caller can close() it (stop/unmount)
 */
export function attachRunStream(
  projectId: string,
  update: Update,
  opts: {
    onDone?: (summary: PipelineSummary) => void;
    onError?: (msg: string) => void;
    onAwait?: (gate: { stage: string; next: string }) => void;
    disconnectMsg?: string;
    fromStage?: string;
    gated?: boolean;
  } = {},
): EventSource {
  const params = new URLSearchParams();
  if (opts.gated) params.set("gated", "1");
  if (opts.fromStage) params.set("from", opts.fromStage);
  // EventSource can't set an Authorization header, so the run stream carries the
  // JWT as a query param; the BFF forwards it and the backend charges/owns the run.
  const tok = getToken();
  if (tok) params.set("token", tok);
  const qs = params.toString();
  const url = `${api.streamUrl(projectId)}${qs ? `?${qs}` : ""}`;
  const es = new EventSource(url);
  let finished = false;
  // Transient drops: let the browser's EventSource auto-reconnect (it resends
  // Last-Event-ID, and the backend resumes the durable run from there instead of
  // restarting). Give up only after this many consecutive failed attempts.
  let reconnects = 0;
  const MAX_RECONNECTS = 8;

  // Token batching: a run streams thousands of deltas; applying each to React
  // state one-by-one causes a re-render storm. Buffer and flush once per frame.
  let seatBuf: Record<string, string> = {};   // role -> report tokens
  let turnBuf: Record<string, string> = {};    // `${round}:${role}` -> turn tokens
  let secBuf: Record<number, string> = {};     // section index -> tokens
  let judgeBuf = "";
  let flushPending = false;

  const flush = () => {
    flushPending = false;
    const seats = seatBuf, turns = turnBuf, secs = secBuf, jb = judgeBuf;
    seatBuf = {}; turnBuf = {}; secBuf = {}; judgeBuf = "";
    const seatKeys = Object.keys(seats), turnKeys = Object.keys(turns), secKeys = Object.keys(secs);
    if (!seatKeys.length && !turnKeys.length && !secKeys.length && !jb) return;
    update((r) => {
      let next = r;
      if (seatKeys.length) {
        next = {
          ...next,
          seats: next.seats.map((s) =>
            seats[s.role] !== undefined ? { ...s, draftText: (s.draftText || "") + seats[s.role] } : s,
          ),
        };
      }
      if (turnKeys.length) {
        next = {
          ...next,
          debate: next.debate.map((tn) => {
            const k = `${tn.round}:${tn.role}`;
            return turns[k] !== undefined && tn.streaming ? { ...tn, text: tn.text + turns[k] } : tn;
          }),
        };
      }
      if (jb) {
        next = { ...next, judge: { text: (next.judge?.text || "") + jb, streaming: true } };
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
  const on = (name: string, fn: (d: any) => void) =>
    es.addEventListener(name, (e) => fn(JSON.parse((e as MessageEvent).data)));

  on("stage", (d) => {
    update((r) => ({ ...r, stages: { ...r.stages, [d.stage]: d.status === "start" ? "running" : "done" } }));
    if (d.status === "done") {
      if (d.stage === "research") api.getResearch(projectId).then((x) => update((r) => ({ ...r, research: x }))).catch(() => {});
      if (d.stage === "outline") api.getOutline(projectId).then((x) => update((r) => ({ ...r, outline: x }))).catch(() => {});
      if (d.stage === "council") update((r) => ({ ...r, strategy: d.info?.strategy_summary || r.strategy }));
    }
  });
  on("roster", (d) => update((r) => ({ ...r, seats: d.seats.map((s: SeatBox) => ({ ...s, status: "waiting" })) })));

  // Round 1 — opening reports, streamed into the Council Arena.
  on("report_start", (d) => update((r) => ({
    ...r,
    seats: r.seats.map((s) => (s.role === d.role ? { ...s, status: "streaming", model: d.model, routed_from: d.routed_from, draftText: "" } : s)),
  })));
  on("report_delta", (d) => { seatBuf[d.role] = (seatBuf[d.role] || "") + d.delta; schedule(); });
  on("seat_error", (d) => {
    delete seatBuf[d.role];
    update((r) => ({ ...r, seats: r.seats.map((s) => (s.role === d.role ? { ...s, status: "done", recommendations: [`⚠ ${d.error}`] } : s)) }));
  });
  on("report", (d) => {
    delete seatBuf[d.role];
    update((r) => ({ ...r, seats: r.seats.map((s) => (s.role === d.role ? { ...s, status: "done", model: d.model, confidence: d.confidence, recommendations: d.recommendations, routed_from: d.routed_from } : s)) }));
  });

  // Rounds 2+ — the real pairwise debate, threaded by addressed_to.
  on("turn_start", (d) => update((r) => ({
    ...r,
    debate: [...r.debate, { round: d.round, role: d.role, provider: d.provider, addressed_to: d.addressed_to, stance: d.stance, text: "", streaming: true }],
  })));
  on("turn_delta", (d) => { const k = `${d.round}:${d.role}`; turnBuf[k] = (turnBuf[k] || "") + d.delta; schedule(); });
  on("turn", (d) => {
    delete turnBuf[`${d.round}:${d.role}`];
    update((r) => ({
      ...r,
      debate: r.debate.map((tn) =>
        tn.round === d.round && tn.role === d.role && tn.streaming
          ? { ...tn, text: d.text, stance: d.stance, addressed_to: d.addressed_to, streaming: false }
          : tn,
      ),
    }));
  });
  on("conflict", () => update((r) => ({ ...r, conflicts: r.conflicts + 1 })));

  // Round 3.5 — the Judge deliberates out loud before the verdict.
  on("judge_start", () => update((r) => ({ ...r, judge: { text: "", streaming: true } })));
  on("judge_delta", (d) => { judgeBuf += d.delta; schedule(); });
  on("judge", (d) => { judgeBuf = ""; update((r) => ({ ...r, judge: { text: d.text, streaming: false } })); });

  on("decision", (d) => update((r) => ({ ...r, decisions: [...r.decisions, { id: "", overridden_by: null, ...d }] })));

  // Article — sections open, "type" token-by-token, then resolve to final.
  on("section_start", (d) => update((r) => {
    const sections = r.draft?.sections ? [...r.draft.sections] : [];
    while (sections.length <= d.index) sections.push({ heading: "…", level: 2, markdown: "", streaming: true });
    sections[d.index] = { heading: d.heading, level: d.level, markdown: "", streaming: true };
    return { ...r, draft: { ...(r.draft || {}), sections } };
  }));
  on("section_delta", (d) => { secBuf[d.index] = (secBuf[d.index] || "") + d.delta; schedule(); });
  on("section_done", (d) => {
    delete secBuf[d.index];
    update((r) => {
      const sections = r.draft?.sections ? [...r.draft.sections] : [];
      while (sections.length <= d.index) sections.push({ heading: "…", level: 2, markdown: "", streaming: false });
      sections[d.index] = { heading: d.heading, level: d.level, markdown: d.markdown, streaming: false };
      const word_count = sections.reduce((n, s) => n + (s.markdown.trim() ? s.markdown.trim().split(/\s+/).length : 0), 0);
      return { ...r, draft: { ...r.draft, sections, word_count } };
    });
  });

  // Gated pause: the run persisted this stage and is awaiting sign-off. The
  // server ends the stream cleanly here, so mark finished so onerror doesn't
  // read the close as a dropped connection.
  es.addEventListener("awaiting_approval", (e) => {
    finished = true;
    flush();
    const d = JSON.parse((e as MessageEvent).data);
    update((r) => ({ ...r, awaiting: { stage: d.stage, next: d.next, regenerate: d.regenerate || d.stage } }));
    es.close();
    opts.onAwait?.(d);
  });

  es.addEventListener("done", (e) => {
    finished = true;
    flush(); // apply any buffered tokens before finalising
    const s = JSON.parse((e as MessageEvent).data) as PipelineSummary;
    update((r) => ({
      ...r,
      scores: s.scores, gate: s.gate, fixes: s.top_fixes, compliance: s.compliance,
      strategy: s.council?.strategy_summary || r.strategy,
      judge: r.judge ? { ...r.judge, streaming: false } : r.judge,
      awaiting: null, done: true,
      stages: Object.fromEntries(PIPELINE_STAGES.map((x) => [x.key, "done"])),
    }));
    es.close();
    opts.onDone?.(s);
    creditsChanged(); // a completed run has charged credits — refresh the balance chip
    // Backfill real decision IDs (for overrides) + fact-check claims.
    api.getDecisions(projectId).then((x) => update((r) => ({ ...r, decisions: x }))).catch(() => {});
    api.getClaims(projectId).then((x) => update((r) => ({ ...r, claims: x }))).catch(() => {});
  });
  es.addEventListener("error", (e) => {
    try {
      const d = JSON.parse((e as MessageEvent).data);
      finished = true; // a server-sent error is terminal — do not auto-reconnect
      update((r) => ({ ...r, error: d.detail }));
      es.close();
    } catch {
      /* transport error, not a payload — handled by es.onerror below */
    }
  });
  es.onopen = () => { reconnects = 0; }; // a fresh / resumed connection succeeded
  es.onerror = () => {
    if (finished) return;
    // While readyState is CONNECTING the browser is auto-reconnecting and will
    // resume the run via Last-Event-ID; allow a bounded number of attempts before
    // surfacing the disconnect. A cleanly-ended stream (done/awaiting) has already
    // set finished + closed, so it never reaches here.
    if (es.readyState !== EventSource.CLOSED && reconnects < MAX_RECONNECTS) {
      reconnects += 1;
      return;
    }
    finished = true;
    es.close();
    update((r) => ({ ...r, error: opts.disconnectMsg || "Live stream disconnected — retry the run." }));
    opts.onError?.(opts.disconnectMsg || "Live stream disconnected.");
  };

  return es;
}
