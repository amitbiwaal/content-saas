# ContentOS AI — Deployment & Production Notes

Production hardening applied on top of the M0–M5 build. This documents how to run
the stack for real and the security posture.

## Backend

### Environment (`backend/.env`)
Copy `backend/.env.example`. For production set at minimum:

- `APP_ENV=prod` — enforces the guards below (fails fast on misconfig).
- `DATABASE_URL=postgresql+psycopg://…` — **required in prod** (SQLite is rejected).
- `API_KEY=<strong secret>` — **required in prod**. Every route except
  `/health`, `/ready`, and the API docs then requires the `X-API-Key` header.
- `CORS_ORIGINS` — the frontend origin(s) (the live SSE stream connects here).
- `ALLOWED_HOSTS` — comma-separated Host allow-list (TrustedHost, prod only).
- `LOG_LEVEL`, `PROVIDER_TIMEOUT_S`, `PROVIDER_MAX_RETRIES` — tunables.

Provider keys are optional — a seat with no key falls back to the deterministic
mock adapter, so the whole pipeline still runs.

### Migrations (no more `create_all` in prod)
Schema is managed by Alembic; the app no longer creates tables on boot when
`APP_ENV=prod`.

```bash
cd backend
alembic upgrade head          # apply migrations (run in the release step)
alembic revision --autogenerate -m "describe change"   # after a model change
```

Local dev (SQLite) still auto-creates tables for zero-setup.

### Running
```bash
# Dev
uvicorn app.main:app --reload

# Prod (supervised, multi-worker) — run migrations first, then the server.
alembic upgrade head
gunicorn app.main:app -c gunicorn.conf.py      # WEB_CONCURRENCY tunes workers
```
Run gunicorn under a supervisor (systemd / pm2 / supervisord) so it restarts on
crash and starts on boot. Point `DATABASE_URL` at a managed Postgres.

Managed-platform path (no server admin): deploy the backend on Railway/Render
(set `DATABASE_URL`, `API_KEY`, provider keys; add a Postgres addon) and the
frontend on Vercel (set `BACKEND_ORIGIN`, `API_KEY`).

### Probes
- `GET /health` — liveness (public, no config disclosure).
- `GET /ready` — readiness; returns 503 if the DB is unreachable (LB draining).
- `GET /api/status` — detailed seat/config (behind the API-key gate).

## Frontend
```bash
cd frontend
npm ci && npm run build && npm start     # Node server (streaming works)
```
- Set `BACKEND_ORIGIN` to the backend URL; if the backend `API_KEY` is set, also
  set `API_KEY` on the frontend so the SSE BFF route forwards it server-side.
- Live pipeline streaming is served by the `app/api/.../run/stream` route handler
  (Node runtime, unbuffered) — no `NEXT_PUBLIC_STREAM_ORIGIN` needed in prod.
- Security headers (HSTS/CSP/X-Frame-Options/…) are set in `next.config.mjs`.
  Tighten `connect-src` (drop the localhost entry) and the CSP for your domain.
- Optional: `NEXT_PUBLIC_APP_USER_NAME` / `NEXT_PUBLIC_APP_USER_EMAIL` for the
  account chip (no personal identity is hardcoded).

## CI
`.github/workflows/ci.yml` runs backend byte-compile + pytest and a frontend
type-check + build on push/PR.

## Security posture & residual work
- **Auth is a single shared API key** (opt-in, required in prod). For multi-tenant
  use, add per-user auth (JWT/OAuth) and scope project queries to an owner.
- **Rate limiting** is not built in — add a limiter (e.g. slowapi) or enforce it
  at the gateway for the expensive pipeline routes.
- **WordPress publish** fetches a user-supplied `site_url` server-side (by design);
  it is now behind the API-key gate. Add an egress allow-list if exposing it more
  broadly.
- Provider cost rates for openai/google/xai in `providers/registry.py` are
  **approximate** — confirm exact per-model prices before relying on cost caps.
- Pin exact versions from `backend/requirements.lock` in your deploy image for
  reproducible builds.
