// Shared API types mirroring the FastAPI responses.

export type ProviderInfo = {
  model: string;
  policy_tier: string;
  key_configured: boolean;
};

export type Health = {
  status: string;
  version: string;
  env: string;
  providers: Record<string, ProviderInfo>;
};

export type Project = {
  id: string;
  website: string;
  topic: string;
  keyword: string;
  country: string;
  audience: string | null;
  tone: string | null;
  goal: string | null;
  stage: string;
  council_config: Record<string, unknown> | null;
  // Review-mode approval ledger (null in auto mode).
  checkpoints: Checkpoints | null;
  created_at: string;
  updated_at: string;
};

// --- Review mode (step-by-step human approval) ----------------------------- #
export type GatedStage = "research" | "council" | "outline" | "draft";
export type StageCheckpoint = {
  status: "pending" | "approved";
  at?: string;
  by?: string | null;
  feedback?: string | null;
};
export type Checkpoints = Partial<Record<GatedStage, StageCheckpoint>>;
export type CheckpointsOut = {
  checkpoints: Checkpoints;
  next: GatedStage | null;
  gated_stages: GatedStage[];
};

export type CompetitorCard = {
  rank: number;
  title: string;
  domain: string;
  url: string;
  snippet: string;
};
export type CompetitorAnalysis = {
  competitors: CompetitorCard[];
  competitor_headings: string[];
  our_headings: string[];
  covered: { heading: string; matched_by: string }[];
  gaps: string[];
  extra: string[];
  coverage_pct: number;
};

export type ProjectCreate = {
  website: string;
  topic: string;
  keyword: string;
  country?: string;
  audience?: string | null;
  tone?: string | null;
  goal?: string | null;
};

export type Scores = {
  seo: number;
  aeo: number;
  geo: number;
  heo: number;
  eeat: number;
  fact: number;
  spam: number;
  originality: number;
  publish: number;
};

export type Analytics = {
  cost: {
    total_cents: number;
    total_usd: number;
    total_tokens: number;
    monthly_budget_cents: number;
    budget_used_pct: number;
    per_article_ceiling_cents: number;
  };
  traffic: { organic_visits_30d: number; ai_citations: number };
  projects: {
    project_id: string;
    topic: string;
    stage: string;
    tokens: number;
    cost_cents: number;
    organic_visits_30d: number;
  }[];
  decay_alerts: { project_id: string; topic: string; drop_pct: number; suggestion: string }[];
};

export type Decision = {
  id: string;
  source: string | null;
  point: string;
  label: string;
  reason: string | null;
  overridden_by: string | null;
};

export type AgentReport = {
  role: string;
  provider: string;
  model: string;
  confidence: number | null;
  recommendations: string[];
  // Set when a provider refusal/error failed the seat over to another provider.
  routed_from?: string | null;
};

export type DebateData = {
  messages: Array<Record<string, unknown>>;
  conflicts: Array<Record<string, unknown>>;
  reports: AgentReport[];
};

export type TopFix = { axis: string; fix: string; est_gain: number };

export type PipelineSummary = {
  project_id: string;
  stage: string;
  ready: boolean;
  research: {
    provider: string;
    intent: string;
    serp_results: number;
    paa: number;
    sources: number;
  };
  council: {
    reports: number;
    conflicts: number;
    decisions: number;
    strategy_summary: string;
  };
  outline_id: string;
  draft: { id: string; version: number; sections: number; word_count: number };
  factcheck: { claims: number; high_risk_unsupported: number };
  scores: Scores;
  gate: { passed: boolean; reasons: string[] };
  top_fixes: TopFix[];
  compliance: { passed: boolean; violations: number };
  tokens: number;
};

export type DraftSection = { heading: string; level: number; markdown: string };
export type Draft = {
  id?: string;
  version?: number;
  word_count?: number;
  sections: DraftSection[];
};

export type Claim = {
  id?: string;
  text: string;
  source: string | null;
  confidence: number | null;
  risk: string;
  label: string | null;
};

export type ScoreResult = {
  scores: Scores;
  gate: { passed: boolean; reasons: string[] };
  top_fixes: TopFix[];
  targets?: Record<string, number>;
};

export type SectionDiff = {
  section_index: number;
  old: DraftSection | null;
  new: DraftSection;
};

export type SerpItem = { rank?: number; title: string; url?: string; domain?: string; snippet?: string };
export type EntityItem = { name: string; type?: string; salience?: number };
export type SourceItem = { title: string; url?: string; trust?: string };
export type Research = {
  id?: string;
  serp: SerpItem[];
  headings: string[];
  paa: string[];
  entities: EntityItem[];
  sources: SourceItem[];
  intent: string;
  provider: string;
};

export type Integrations = {
  wordpress: { configured: boolean; site_url: string | null };
  google_docs: { configured: boolean };
  ahrefs: { configured: boolean; active: boolean };
  docx: { available: boolean };
  exports: string[];
  ai_providers: Record<string, boolean>;
};

export type OutlineNode = { level: string; text: string; children: OutlineNode[] };
export type OutlineElement = { type: string; section: string; note: string };
export type Outline = {
  nodes: OutlineNode[];
  elements: OutlineElement[];
  schema_hooks?: { type: string; target?: string }[];
};
