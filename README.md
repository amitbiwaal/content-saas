# ContentOS AI

A multi-model AI content engine. OpenAI, Claude, Gemini and Grok debate a brief, a **Judge** agent resolves every recommendation, and content is graded on eight scores (SEO / AEO / GEO / HEO / EEAT / Fact / Spam / Publish) and held behind a publish gate before it exports.

See [ContentOS-AI-PRD.md](ContentOS-AI-PRD.md) for the product spec and [BUILD-PLAN.md](BUILD-PLAN.md) for the phased build.

## Status

**M0 — Foundation.** Repo, data model, swappable provider adapter, council/judge skeleton, publish gate, FastAPI app, and a React dashboard shell. The full pipeline runs against mock providers (zero API spend); real adapters swap in per seat as keys arrive.

## Layout

```
backend/    FastAPI + SQLAlchemy + provider adapter + council/judge + scoring
frontend/   Next.js (App Router) + TypeScript dashboard
```

## Backend — run locally

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows  (source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
copy .env.example .env          # cp on macOS/Linux
uvicorn app.main:app --reload
```

- API docs: http://127.0.0.1:8000/docs
- Health:   http://127.0.0.1:8000/health

SQLite tables auto-create on first boot (no migrations needed for dev). Set `DATABASE_URL` to a Postgres URL for production.

## Frontend — run locally

Next.js (App Router). The Python/FastAPI backend stays the core; Next.js is the
UI + a thin BFF that proxies `/api` and `/health` to the backend (see
`frontend/next.config.mjs`; override the target with `BACKEND_ORIGIN`).

```bash
cd frontend
npm install
npm run dev
```

Dashboard: http://127.0.0.1:3000 (proxies `/api` and `/health` to the backend).

## Configuration

All settings are environment-driven (`backend/.env`). No model name is hardcoded — each council seat maps to a provider/model via `app/providers/registry.py`. Provide only the keys you have; seats without a key fall back to the deterministic mock adapter.

| Var | Purpose |
| --- | --- |
| `DATABASE_URL` | SQLite (default) or Postgres connection string |
| `ANTHROPIC_API_KEY` | Claude seat (defaults to `claude-opus-4-8`, adaptive thinking) |
| `OPENAI_API_KEY` / `GOOGLE_API_KEY` / `XAI_API_KEY` | other council seats |
| `*_MODEL` overrides | swap the model for any seat without code changes |
