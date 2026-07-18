// Thin client-side API wrapper. All paths are relative; the Next BFF route
// handler proxies /api to the FastAPI backend and injects the service key.

import { clearToken, getToken, redirectToLogin, type AuthResp, type AuthUser, type CreditsResp } from "./auth";
import type {
  AdminProject,
  AdminSort,
  AdminStats,
  AdminUser,
  AdminUserDetail,
  AdminUsers,
  Analytics,
  CheckpointsOut,
  Claim,
  SortOrder,
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
  const { headers: initHeaders, ...rest } = init || {};
  const token = getToken();
  const res = await fetch(path, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(initHeaders as Record<string, string> | undefined),
    },
    ...rest,
  });
  if (res.status === 401 && typeof window !== "undefined") {
    // Token missing/expired: drop it and bounce to sign-in, remembering where we
    // were so login can send us back (redirectToLogin skips the auth pages / home).
    clearToken();
    redirectToLogin();
  }
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
  // Reject a gated stage → regenerate it with feedback (resume the stream after).
  rejectStage: (id: string, stage: GatedStage, feedback?: string | null) =>
    http<CheckpointsOut>(`/api/projects/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ stage, feedback: feedback ?? null }),
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

  // --- Auth + credits ---------------------------------------------------- #
  auth: {
    signup: (body: { email: string; password: string; name?: string }) =>
      http<AuthResp>("/api/auth/signup", { method: "POST", body: JSON.stringify(body) }),
    login: (body: { email: string; password: string }) =>
      http<AuthResp>("/api/auth/login", { method: "POST", body: JSON.stringify(body) }),
    google: (credential: string) =>
      http<AuthResp>("/api/auth/google", { method: "POST", body: JSON.stringify({ credential }) }),
    me: () => http<AuthUser>("/api/auth/me"),
    credits: () => http<CreditsResp>("/api/auth/credits"),
  },

  // --- Admin panel (admin-only; 403 otherwise) --------------------------- #
  admin: {
    stats: () => http<AdminStats>("/api/admin/stats"),
    users: (opts?: { q?: string; sort?: AdminSort; order?: SortOrder; limit?: number; offset?: number }) => {
      const p = new URLSearchParams();
      if (opts?.q?.trim()) p.set("q", opts.q.trim());
      if (opts?.sort) p.set("sort", opts.sort);
      if (opts?.order) p.set("order", opts.order);
      if (opts?.limit != null) p.set("limit", String(opts.limit));
      if (opts?.offset != null) p.set("offset", String(opts.offset));
      const qs = p.toString();
      return http<AdminUsers>(`/api/admin/users${qs ? `?${qs}` : ""}`);
    },
    getUser: (userId: string) => http<AdminUserDetail>(`/api/admin/users/${userId}`),
    recentProjects: (limit = 15) => http<AdminProject[]>(`/api/admin/projects?limit=${limit}`),
    setCredits: (userId: string, delta: number, reason?: string) =>
      http<AdminUser>(`/api/admin/users/${userId}/credits`, {
        method: "POST",
        body: JSON.stringify({ delta, reason: reason ?? null }),
      }),
    setAdmin: (userId: string, isAdmin: boolean) =>
      http<AdminUser>(`/api/admin/users/${userId}/admin`, {
        method: "POST",
        body: JSON.stringify({ is_admin: isAdmin }),
      }),
    setSuspended: (userId: string, suspend: boolean) =>
      http<AdminUser>(`/api/admin/users/${userId}/suspend`, {
        method: "POST",
        body: JSON.stringify({ active: !suspend }),
      }),
    setPlan: (userId: string, plan: string) =>
      http<AdminUser>(`/api/admin/users/${userId}/plan`, {
        method: "POST",
        body: JSON.stringify({ plan }),
      }),
    deleteUser: (userId: string) =>
      http<{ deleted: boolean; email: string; projects_removed: number }>(
        `/api/admin/users/${userId}`,
        { method: "DELETE" },
      ),
  },

  // --- WordPress connection (per-user) ----------------------------------- #
  getWordpress: () => http<WordpressConfig>("/api/wordpress"),
  saveWordpress: (body: { site_url: string; username: string; app_password: string; default_status?: string }) =>
    http<WordpressConfig>("/api/wordpress", { method: "PUT", body: JSON.stringify(body) }),
  testWordpress: () => http<WordpressConfig>("/api/wordpress/test", { method: "POST", body: "{}" }),
  deleteWordpress: () => http<{ ok: boolean }>("/api/wordpress", { method: "DELETE" }),

  // --- Custom site / webhook connection (per-user, non-WordPress) --------- #
  getWebhook: () => http<WebhookConfig>("/api/webhook"),
  saveWebhook: (body: { endpoint_url: string; auth_token?: string; default_status?: string }) =>
    http<WebhookConfig>("/api/webhook", { method: "PUT", body: JSON.stringify(body) }),
  testWebhook: () => http<WebhookConfig>("/api/webhook/test", { method: "POST", body: "{}" }),
  deleteWebhook: () => http<{ ok: boolean }>("/api/webhook", { method: "DELETE" }),
  publishWebhook: (id: string, body: object) =>
    http<Record<string, unknown>>(`/api/projects/${id}/export/webhook`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export type WordpressConfig = {
  connected: boolean;
  site_url: string;
  username: string;
  default_status: string;
  verified: boolean;
};

export type WebhookConfig = {
  connected: boolean;
  endpoint_url: string;
  has_token: boolean;
  default_status: string;
  verified: boolean;
};
