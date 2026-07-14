// Thin client-side API wrapper. All paths are relative; next.config.mjs proxies
// /api and /health to the FastAPI backend in dev.

import type {
  Analytics,
  CheckpointsOut,
  Claim,
  CompetitorAnalysis,
  DebateData,
  Decision,
  Draft,
  DraftSection,
  GatedStage,
  Health,
  Integrations,
  Outline,
  PipelineSummary,
  Project,
  ProjectCreate,
  Research,
  ScoreResult,
  Scores,
  SectionDiff,
} from "./types";

// SSE (EventSource) must bypass the Next dev rewrite proxy, which buffers
// streaming responses for the browser (curl streams, EventSource does not).
// In dev, set NEXT_PUBLIC_STREAM_ORIGIN to the backend origin so EventSource
// connects directly (backend CORS must allow the frontend origin). Left unset
// in prod, the stream URL stays relative and same-origin.
const STREAM_ORIGIN = process.env.NEXT_PUBLIC_STREAM_ORIGIN ?? "";

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = (body && (body.detail ?? JSON.stringify(body))) || detail;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(`${res.status}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // Detailed seat/config status (env + per-provider models/keys). Served behind
  // the API-key gate; /health itself is now a minimal public liveness probe.
  health: () => http<Health>("/api/status"),
  listProjects: () => http<Project[]>("/api/projects"),
  getProject: (id: string) => http<Project>(`/api/projects/${id}`),
  createProject: (body: ProjectCreate) =>
    http<Project>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  // Guided chat: seed a project from a free-text message.
  createFromMessage: (message: string) =>
    http<Project>("/api/projects/from-message", {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  // Follow-up chat about a produced project, grounded in its draft/decisions.
  chat: (id: string, message: string) =>
    http<{ reply: string }>(`/api/projects/${id}/chat`, {
      method: "POST",
      body: JSON.stringify({ message }),
    }),
  runPipeline: (id: string) =>
    http<PipelineSummary>(`/api/projects/${id}/run`, { method: "POST" }),
  // SSE stream URL for the live pipeline run (consumed via EventSource).
  streamUrl: (id: string) => `${STREAM_ORIGIN}/api/projects/${id}/run/stream`,
  getDebate: (id: string) => http<DebateData>(`/api/projects/${id}/debate`),
  getDecisions: (id: string) => http<Decision[]>(`/api/projects/${id}/decisions`),
  getResearch: (id: string) => http<Research>(`/api/projects/${id}/research`),
  getOutline: (id: string) => http<Outline>(`/api/projects/${id}/outline`),
  getScores: (id: string) => http<Scores[]>(`/api/projects/${id}/scores`),
  // FR-5.5: human override of a Judge decision + clean council re-run.
  updateDecision: (id: string, decisionId: string, body: { label: string; reason?: string }) =>
    http<Decision>(`/api/projects/${id}/decisions/${decisionId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  // Council re-run — optional editor feedback steers the seats (review mode).
  rerunCouncil: (id: string, feedback?: string | null) =>
    http<Decision[]>(`/api/projects/${id}/council`, {
      method: "POST",
      body: JSON.stringify({ feedback: feedback ?? null }),
    }),
  getDraft: (id: string) => http<Draft>(`/api/projects/${id}/draft`),
  getClaims: (id: string) => http<Claim[]>(`/api/projects/${id}/claims`),

  // --- Review mode (step-by-step): per-stage run + human gate ------------- #
  // Each stage runs on its own and marks a checkpoint pending for sign-off.
  runResearch: (id: string, feedback?: string | null) =>
    http<Research>(`/api/projects/${id}/research`, {
      method: "POST",
      body: JSON.stringify({ feedback: feedback ?? null }),
    }),
  runOutline: (id: string, feedback?: string | null) =>
    http<Outline>(`/api/projects/${id}/outline`, {
      method: "POST",
      body: JSON.stringify({ feedback: feedback ?? null }),
    }),
  runDraft: (id: string, feedback?: string | null) =>
    http<Draft>(`/api/projects/${id}/draft`, {
      method: "POST",
      body: JSON.stringify({ feedback: feedback ?? null }),
    }),
  runFactcheck: (id: string) =>
    http<{ draft_id: string; claims: Claim[]; high_risk_unsupported: number }>(
      `/api/projects/${id}/factcheck`,
      { method: "POST" },
    ),
  runScores: (id: string) =>
    http<ScoreResult>(`/api/projects/${id}/scores`, { method: "POST" }),
  // Human sign-off on a gated stage; returns the updated ledger + next step.
  approveStage: (id: string, stage: GatedStage, note?: string | null) =>
    http<CheckpointsOut>(`/api/projects/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ stage, note: note ?? null }),
    }),
  getCheckpoints: (id: string) =>
    http<CheckpointsOut>(`/api/projects/${id}/checkpoints`),
  // Competitor SERP rivals + outline coverage-gap analysis.
  getCompetitors: (id: string) =>
    http<CompetitorAnalysis>(`/api/projects/${id}/competitors`),
  // Editor (PRD §7): save edits, live re-score, regenerate one section.
  updateDraft: (id: string, sections: DraftSection[]) =>
    http<Draft>(`/api/projects/${id}/draft`, {
      method: "PUT",
      body: JSON.stringify({ sections }),
    }),
  previewScores: (id: string, sections: DraftSection[]) =>
    http<ScoreResult>(`/api/projects/${id}/scores/preview`, {
      method: "POST",
      body: JSON.stringify({ sections }),
    }),
  regenerateSection: (id: string, section_index: number, feedback?: string | null) =>
    http<SectionDiff>(`/api/projects/${id}/draft/regenerate-section`, {
      method: "POST",
      body: JSON.stringify({ section_index, feedback: feedback ?? null }),
    }),
  // Copy-edit the whole draft in place (grammar/clarity/house voice).
  proofread: (id: string) =>
    http<Draft>(`/api/projects/${id}/draft/proofread`, {
      method: "POST",
      body: JSON.stringify({}),
    }),
  // Featured image (16:9): generate/regenerate + a proxy-served URL.
  generateImage: (id: string, body: { prompt?: string; style?: string; alt?: string }) =>
    http<{ url: string; ext: string; prompt: string; alt: string; generated: boolean }>(
      `/api/projects/${id}/image`,
      { method: "POST", body: JSON.stringify(body) },
    ),
  imageUrl: (id: string) => `/api/projects/${id}/image`,
  // Distribution: repurpose the article for a channel, then publish (dry-run/live).
  repurpose: (id: string, channel: "linkedin" | "reddit") =>
    http<{ channel: string; content: { text?: string; title?: string; body?: string } }>(
      `/api/projects/${id}/repurpose/${channel}`,
      { method: "POST", body: JSON.stringify({}) },
    ),
  distribute: (id: string, channel: "linkedin" | "reddit", body: Record<string, unknown>) =>
    http<Record<string, string>>(`/api/projects/${id}/distribute/${channel}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  exportGoogleDoc: (id: string) =>
    http<Record<string, string>>(`/api/projects/${id}/export/google-doc`, { method: "POST" }),
  exportUrl: (id: string, format: "markdown" | "html" | "jsonld" | "docx" | "gutenberg") =>
    `/api/projects/${id}/export?format=${format}`,
  getIntegrations: () => http<Integrations>("/api/integrations"),
  getAnalytics: () => http<Analytics>("/api/analytics"),
  publishWordpress: (id: string, body: object) =>
    http<Record<string, unknown>>(`/api/projects/${id}/export/wordpress`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
