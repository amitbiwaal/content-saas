# ContentOS AI — Build Plan

Executable plan that turns [ContentOS-AI-PRD.md](ContentOS-AI-PRD.md) into a phased build. This is the working roadmap; the PRD remains the source of requirements.

## Context

`c:\Content` is greenfield — only the PRD existed. ContentOS AI is a multi-model content engine: one brief runs through OpenAI / Claude / Gemini / Grok in a role-based **council**, they debate, a **Judge** resolves every recommendation, the draft is graded on eight scores, fact-checked, and held behind a publish gate before export to WordPress. The differentiator is structured disagreement + a hard publish gate, plus permissive-provider routing for restricted niches that mainstream tools refuse.

This plan follows the PRD's documented stack (React + FastAPI + Celery + Postgres, swappable provider adapter) and sequences the work so a runnable vertical slice exists early, then hardens outward.

### Confirmed/assumed decisions (redirect if wrong)
- **Stack:** Python 3.11+ / FastAPI / SQLAlchemy 2.0 / Pydantic v2 backend; Celery + Redis for background/bulk; Postgres in prod, **SQLite for local dev** (zero-setup). **Next.js (App Router) + TypeScript** frontend, with Next route handlers as a thin BFF (auth/session + proxy) in front of FastAPI — the Python service stays the AI/orchestration core.
- **AI seats:** provider adapter maps each agent role → a model via config, never hardcoded (PRD §12). The Claude seat defaults to `claude-opus-4-8` with adaptive thinking; OpenAI/Gemini/Grok seats are config-driven with placeholder model IDs until keys are supplied.
- **Research provider:** **Ahrefs** is the lead candidate for Research Intelligence (PRD open question #1) — an Ahrefs MCP/API connection is available in this environment. Pluggable behind a `ResearchProvider` interface so SerpAPI/DataForSEO can be swapped in.
- **First iteration uses mock provider responses** so the full pipeline runs end-to-end without burning API spend or requiring every key; real adapters swap in per-seat.

## Architecture (target)

```
frontend/ (Next.js App Router + TS; thin BFF proxy to FastAPI)
backend/
  app/
    config.py          # env-driven settings
    db.py              # SQLAlchemy engine/session (SQLite dev → Postgres prod)
    models.py          # ORM for all §14 entities
    schemas.py         # Pydantic API models
    providers/         # swappable AI adapter layer (PRD §12)
      registry.py      #   model id, context window, cost/token, policy tier
      base.py          #   LLMAdapter interface + mock adapter
      anthropic_adapter.py   # Claude seat (real; refusal-aware → failover)
    research/          # ResearchProvider interface (Ahrefs / SERP / mock)
    council/           # role-based debate + Judge (PRD §8)
      roles.py
      orchestrator.py  # Round 1 reports → Round 2 debate → Round 3 judge
    scoring/           # 8-score scoring service + publish gate (PRD §10)
    compliance/        # house-rules pass/fail engine (PRD §11)
    factcheck/         # claim extraction + source/risk grading (PRD §9)
    routers/           # FastAPI route modules per module
    main.py            # app wiring
```

## Milestones

Mapped to PRD §19 release phases. Each milestone is independently demoable.

### M0 — Foundation (this commit)
Repo, config, data model for all §14 entities, provider adapter interface + registry + mock adapter + real Anthropic adapter, council orchestrator skeleton, FastAPI app with health + projects stub, frontend shell. **Goal:** server boots, `/health` responds, dashboard renders.

### M1 — Vertical slice: brief → debate → judge (PRD §8, §9.3–9.5)
- `POST /projects` captures the brief (FR-3.1) and triggers research (mock first).
- `ResearchProvider.gather()` normalises research into one brief (FR-4.5).
- Council runs Round 1 (parallel reports) → Round 2 (debate, ≥1 surfaced conflict) → Round 3 (Judge → strict JSON). Persist `agent_run`, `debate`, `decision` (FR-5.1–5.4).
- Debate Room UI renders agent cards + Judge decisions with reasons.
- **Demo:** submit the FeetFinder example (PRD Appendix A), watch the council debate and the Judge rule.

### M2 — Outline → draft → scores → gate (PRD §6, §7, §10)
- Outline builder converts approved strategy → H1/H2/H3 + element placements (FR-6.1–6.2).
- Article writer generates section-by-section; 3-panel editor (FR-7.1–7.2).
- Scoring service computes SEO/AEO/GEO/HEO/EEAT/Fact/Spam/Publish; live updates (FR-8.1, FR-7.3).
- Publish gate enforces Publish ≥85, Fact >80, no high-risk unsupported claim (PRD §10).

### M3 — Fact checker + compliance + export (PRD §9, §11, §10 export)
- Claim extraction → source/confidence/risk/label; block gate on high-risk unsupported (FR-9.1–9.3).
- House-rules engine as hard pass/fail before export (em-dash ban, source negative/stat claims, FAQ-parse-only, typography lock) (PRD §11).
- JSON-LD generation + export to WordPress / Google Docs / Markdown / HTML / DOCX (FR-10.1–10.3).

### M4 — Resilience + routing + cost (PRD §12, §13, §11 routing)
- Provider failover with backoff; restricted-niche policy routing to permissive tier (FR-13.4–13.5). The Anthropic adapter's `refusal` stop-reason and provider errors trigger failover.
- Per-run token/cost tracking → per-article + monthly; budget caps + downgrade (PRD §13).
- Celery + Redis for parallel Round 1 and background jobs.

### M5 — Scale (PRD §19 Phase 3)
Bulk batch mode, internal-link engine + content memory at scale, analytics + decay, originality score, eval/golden-set harness.

## Key reuse / conventions
- **One adapter interface** (`providers/base.py::LLMAdapter`) — every seat goes through it; the registry (`providers/registry.py`) holds model id, context window, cost/token, and content-policy tier so routing and cost logic are data-driven (PRD §12).
- **Refusal == routing signal.** The Anthropic adapter checks `stop_reason == "refusal"` and raises `ProviderRefusal`; the council/router catches it and fails over to the next policy-eligible provider (PRD §11 restricted routing, §12 failover).
- **Mock-first.** `MockAdapter` and `MockResearchProvider` let the whole pipeline run in tests and demos with deterministic output and zero spend.
- **Strict-JSON Judge.** Round 3 output is schema-validated before the outline builder consumes it (PRD §8.2).

## Verification
- **M0:** `cd backend && uvicorn app.main:app --reload` → `GET /health` returns ok; `cd frontend && npm run dev` renders the dashboard shell.
- **M1+:** `pytest backend/tests` for the council/judge/gate logic with the mock adapter; run the FeetFinder brief through `POST /projects` and inspect persisted `debate`/`decision` rows; exercise the Debate Room in the UI.
- **Scoring/gate:** unit tests assert the gate blocks Publish<85 / Fact≤80 / any high-risk unsupported claim.

## Open questions (carried from PRD §21)
1. Confirm **Ahrefs** as the Research Intelligence provider (vs SerpAPI/DataForSEO).
2. Judge: fixed model or rotate OpenAI↔Claude by topic sensitivity?
3. Per-article cost ceiling that triggers a model downgrade?
4. Originality/AI-detection service acceptable for restricted niches?
5. Which provider keys are available now (drives which seats run real vs mock)?
