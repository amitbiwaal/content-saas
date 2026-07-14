"""Opt-in API-key authentication (PRD §12 hardening).

Auth is *opt-in*: with no ``API_KEY`` configured the API is fully open (the
zero-setup local-dev default). Set ``API_KEY`` and every route except the
liveness/readiness probes and the API docs requires that key in the
``X-API-Key`` header. Production must set it (enforced by config's prod guard).

This is a single shared-secret gate — the minimal control that closes the
"open API" hole for a single-tenant deployment. Multi-tenant per-user auth
(JWT/OAuth + owner-scoped queries) is a larger change tracked separately.
"""

from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, Request, status

from app.config import get_settings

# Reachable without a key: liveness/readiness + interactive API docs.
_OPEN_PATHS = frozenset(
    {"/health", "/ready", "/", "/docs", "/redoc", "/openapi.json"}
)


def require_auth(
    request: Request, x_api_key: str | None = Header(default=None)
) -> None:
    """App-wide dependency enforcing the shared API key when one is configured."""
    settings = get_settings()
    if not settings.api_key:
        return  # opt-in: no key configured => open (dev default)
    if request.url.path in _OPEN_PATHS:
        return
    if not x_api_key or not hmac.compare_digest(x_api_key, settings.api_key):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid or missing API key",
            headers={"WWW-Authenticate": "ApiKey"},
        )
