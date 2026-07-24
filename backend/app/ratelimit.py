"""In-process fixed-window rate limiter (stdlib only, no new deps).

Applied as HTTP middleware to the *expensive* surfaces — the billed pipeline
routes (a run, a council re-run, a per-stage regenerate, image/LLM calls) and the
auth routes (login/signup brute-force). Keyed per user (from the bearer token) or,
when unauthenticated, per client IP.

Effective at single-worker scale (the recommended `WEB_CONCURRENCY=1` for seamless
run reconnect). Behind a multi-worker deploy, enforce at the gateway too — the
counters are per-process. Both buckets are configurable; set either limit to 0 to
disable that bucket.
"""

from __future__ import annotations

import re
import threading
import time

from fastapi import Request
from fastapi.responses import JSONResponse

from app.config import get_settings
from app.security import _bearer, decode_token

# POST endpoints that kick off model work (relative to a project) → "run" bucket.
_RUN_RE = re.compile(
    r"/api/projects/[^/]+/"
    r"(run|research|council|outline|draft|factcheck|scores|chat|image|repurpose|distribute|competitors)"
)
_AUTH_RE = re.compile(r"/api/auth/(login|signup|google)$")


class _FixedWindow:
    """Thread-safe fixed-window counter: N hits per `window` seconds per key."""

    def __init__(self) -> None:
        self._hits: dict[tuple, tuple[int, float]] = {}
        self._lock = threading.Lock()

    def check(self, key: tuple, limit: int, window: float) -> tuple[bool, int]:
        now = time.time()
        with self._lock:
            count, start = self._hits.get(key, (0, now))
            if now - start >= window:  # window elapsed → reset
                count, start = 0, now
            count += 1
            self._hits[key] = (count, start)
            if len(self._hits) > 10_000:  # opportunistic GC of stale keys
                for k, (_, s) in list(self._hits.items()):
                    if now - s >= window:
                        self._hits.pop(k, None)
            allowed = count <= limit
            retry_after = 0 if allowed else max(1, int(window - (now - start)) + 1)
            return allowed, retry_after


_limiter = _FixedWindow()


def _client_id(request: Request) -> str:
    """Identify the caller: the token's user id, else the client IP."""
    token = _bearer(request.headers.get("authorization"))
    uid = decode_token(token) if token else None
    if uid:
        return f"u:{uid}"
    fwd = request.headers.get("x-forwarded-for")
    ip = fwd.split(",")[0].strip() if fwd else (request.client.host if request.client else "?")
    return f"ip:{ip}"


def _limit_for(path: str, method: str) -> tuple[int, str] | tuple[None, None]:
    s = get_settings()
    # The live run stream is a GET (EventSource) but it's the most expensive
    # call in the app — count stream opens in the run bucket too.
    if method == "GET":
        if path.endswith("/run/stream"):
            return s.rate_limit_run_per_min, "run"
        return None, None
    if method != "POST":
        return None, None
    if _AUTH_RE.search(path):
        return s.rate_limit_auth_per_min, "auth"
    if "/from-message" in path or _RUN_RE.search(path):
        return s.rate_limit_run_per_min, "run"
    return None, None


async def rate_limit_middleware(request: Request, call_next):
    limit, bucket = _limit_for(request.url.path, request.method)
    if limit and limit > 0:
        allowed, retry = _limiter.check((bucket, _client_id(request)), limit, 60.0)
        if not allowed:
            return JSONResponse(
                status_code=429,
                content={"detail": f"Too many requests — slow down and retry in {retry}s."},
                headers={"Retry-After": str(retry)},
            )
    return await call_next(request)
