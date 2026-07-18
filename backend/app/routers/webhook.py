"""Per-user generic publish endpoint (non-WordPress / custom / headless sites).

Mirrors the WordPress connection: one ``endpoint_url`` + optional bearer token per
user; ``/test`` sends a ping and expects a 2xx. The finished article is POSTed by
:mod:`app.export.service.webhook_publish` as a stable JSON envelope. SSRF-guarded
like WordPress; the token is stored server-side and never returned to the browser.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import User, WebhookConfig
from app.net import guard_ssrf
from app.security import get_current_user

router = APIRouter(prefix="/api/webhook", tags=["webhook"])
logger = logging.getLogger("contentos.webhook")


class WebhookIn(BaseModel):
    endpoint_url: str = Field(min_length=4, max_length=1024)
    # Optional bearer token; leave blank on edit to keep the stored one.
    auth_token: str | None = Field(default=None, max_length=2048)
    default_status: str = "draft"


class WebhookOut(BaseModel):
    connected: bool
    endpoint_url: str = ""
    has_token: bool = False
    default_status: str = "draft"
    verified: bool = False


def _normalize_url(raw: str) -> str:
    url = raw.strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def _config_for(db: Session, user: User) -> WebhookConfig | None:
    return db.scalars(
        select(WebhookConfig).where(WebhookConfig.user_id == user.id)
    ).first()


def _out(cfg: WebhookConfig | None) -> WebhookOut:
    if cfg is None:
        return WebhookOut(connected=False)
    return WebhookOut(
        connected=True,
        endpoint_url=cfg.endpoint_url,
        has_token=bool(cfg.auth_token),
        default_status=cfg.default_status,
        verified=cfg.verified,
    )


@router.get("", response_model=WebhookOut)
def get_config(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> WebhookOut:
    return _out(_config_for(db, user))


@router.put("", response_model=WebhookOut)
def save_config(
    payload: WebhookIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WebhookOut:
    url = _normalize_url(payload.endpoint_url)
    guard_ssrf(url)
    status = payload.default_status if payload.default_status in ("draft", "publish") else "draft"
    cfg = _config_for(db, user)
    if cfg is None:
        cfg = WebhookConfig(user_id=user.id)
        db.add(cfg)
    cfg.endpoint_url = url
    # Only overwrite the token when a new one is provided (blank on edit keeps it).
    if payload.auth_token is not None and payload.auth_token.strip():
        cfg.auth_token = payload.auth_token.strip()
    cfg.default_status = status
    cfg.verified = False  # re-verify after any change
    db.commit()
    db.refresh(cfg)
    return _out(cfg)


@router.post("/test", response_model=WebhookOut)
def test_config(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> WebhookOut:
    cfg = _config_for(db, user)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Add your endpoint first.")
    guard_ssrf(cfg.endpoint_url)
    headers = {"Content-Type": "application/json", "User-Agent": "ContentOS/1.0"}
    if cfg.auth_token:
        headers["Authorization"] = f"Bearer {cfg.auth_token}"
    try:
        resp = httpx.post(
            cfg.endpoint_url,
            json={"source": "contentos", "type": "ping"},
            headers=headers,
            timeout=15,
            follow_redirects=False,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach that endpoint. Check the URL.")
    if 200 <= resp.status_code < 300:
        cfg.verified = True
        db.commit()
        db.refresh(cfg)
        return _out(cfg)
    cfg.verified = False
    db.commit()
    if resp.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="The endpoint rejected the token (401/403).")
    raise HTTPException(
        status_code=400,
        detail=f"Endpoint returned {resp.status_code}. It should accept a POST and answer 2xx.",
    )


@router.delete("")
def delete_config(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    cfg = _config_for(db, user)
    if cfg is not None:
        db.delete(cfg)
        db.commit()
    return {"ok": True}
