# ContentOS AI — Deployment & Production Notes

Production hardening applied on top of the M0–M5 build. This documents how to run
the stack for real and the security posture.

## Backend

### Environment (`backend/.env`)
Copy `backend/.env.example`. For production set at minimum:

- `APP_ENV=prod` — enforces the guards below (fails fast on misconfig).
- `DATABASE_URL` — **required in prod** (SQLite is rejected). Paste the host's URL
  as-is; a plain `postgres://` / `postgresql://` is auto-rewritten to
  `postgresql+psycopg://` (psycopg3), so Railway/Render/Neon/Supabase strings just work.
- `API_KEY=<strong secret>` — **required in prod**. Every route except
  `/health`, `/ready`, and the API docs then requires the `X-API-Key` header.
- `CORS_ORIGINS` — the frontend origin(s) (the live SSE stream connects here).
- `ALLOWED_HOSTS` — comma-separated Host allow-list (TrustedHost, prod only).
- `LOG_LEVEL`, `PROVIDER_TIMEOUT_S`, `PROVIDER_MAX_RETRIES` — tunables.

Provider keys are optional — a seat with no key falls back to the deterministic
mock adapter, so the whole pipeline still runs.

### Python runtime
Deploy on **Python 3.12** (pinned via `backend/runtime.txt` and
`backend/.python-version`; CI runs the same). The Postgres driver `psycopg` is
declared for `python_version < "3.14"`, so a 3.14 image would silently ship
without it and crash on first DB access — keep the pin.

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

### Live pipeline runs (durability)
A run executes in a **detached background worker**, not the request — so a client
disconnect (tab close, network blip) no longer aborts it: the run finishes and
persists, and a reconnect re-attaches and replays via `Last-Event-ID`. A `run`
row tracks status; on boot, any run left `running` by a dead process is flipped
to `interrupted` (its per-stage artifacts are already committed).

The live-event buffer is **in-process**, so for seamless reconnect run the web
tier as a **single worker** (`WEB_CONCURRENCY=1`) — recommended at single-operator
scale. With multiple workers a reconnect may land on a worker without the buffer;
the run still completes and persists (the client just reloads the finished
project). A shared event log (Redis/Postgres) removes that caveat — see
`ARCHITECTURE.md` (target design).

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
- Install backend deps from `backend/requirements.txt` (CI validates it on every
  push). For reproducible builds, generate a lockfile **inside the Python 3.12
  deploy image** (`pip install -r requirements.txt && pip freeze > requirements.lock`)
  so it captures `gunicorn` and `psycopg` for the actual target runtime — do not
  commit a lock generated on a different interpreter.
