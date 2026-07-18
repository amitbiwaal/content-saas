"""Per-user WordPress connection (PRD §15).

Each account stores its own site URL + username + application password (never
returned to the browser). ``/test`` verifies the credentials against the WP REST
API. The publish endpoint (app.export) reads this config for the current user.
"""

from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.net import guard_ssrf

from app.db import get_db
from app.models import User, WordPressConfig
from app.security import get_current_user

router = APIRouter(prefix="/api/wordpress", tags=["wordpress"])
logger = logging.getLogger("contentos.wordpress")


class WordPressIn(BaseModel):
    site_url: str = Field(min_length=4, max_length=512)
    username: str = Field(min_length=1, max_length=255)
    app_password: str = Field(min_length=1, max_length=255)
    default_status: str = Field(default="draft")


class WordPressOut(BaseModel):
    connected: bool
    site_url: str = ""
    username: str = ""
    default_status: str = "draft"
    verified: bool = False


def _normalize_url(raw: str) -> str:
    url = raw.strip().rstrip("/")
    if not url.startswith(("http://", "https://")):
        url = "https://" + url
    return url


def _config_for(db: Session, user: User) -> WordPressConfig | None:
    return db.scalars(
        select(WordPressConfig).where(WordPressConfig.user_id == user.id)
    ).first()


def _out(cfg: WordPressConfig | None) -> WordPressOut:
    if cfg is None:
        return WordPressOut(connected=False)
    return WordPressOut(
        connected=True,
        site_url=cfg.site_url,
        username=cfg.username,
        default_status=cfg.default_status,
        verified=cfg.verified,
    )


@router.get("", response_model=WordPressOut)
def get_config(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> WordPressOut:
    return _out(_config_for(db, user))


@router.put("", response_model=WordPressOut)
def save_config(
    payload: WordPressIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> WordPressOut:
    url = _normalize_url(payload.site_url)
    guard_ssrf(url)
    status = payload.default_status if payload.default_status in ("draft", "publish") else "draft"
    cfg = _config_for(db, user)
    if cfg is None:
        cfg = WordPressConfig(user_id=user.id)
        db.add(cfg)
    cfg.site_url = url
    cfg.username = payload.username.strip()
    cfg.app_password = payload.app_password.strip()
    cfg.default_status = status
    cfg.verified = False  # re-verify after any change
    db.commit()
    db.refresh(cfg)
    return _out(cfg)


@router.post("/test", response_model=WordPressOut)
def test_config(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> WordPressOut:
    cfg = _config_for(db, user)
    if cfg is None:
        raise HTTPException(status_code=404, detail="Connect WordPress first.")
    guard_ssrf(cfg.site_url)
    try:
        resp = httpx.get(
            f"{cfg.site_url}/wp-json/wp/v2/users/me",
            params={"context": "edit"},
            auth=(cfg.username, cfg.app_password),
            timeout=15,
            follow_redirects=False,
        )
    except httpx.HTTPError:
        raise HTTPException(status_code=502, detail="Could not reach the site. Check the URL.")
    if resp.status_code == 200:
        cfg.verified = True
        db.commit()
        db.refresh(cfg)
        return _out(cfg)
    cfg.verified = False
    db.commit()
    if resp.status_code in (401, 403):
        raise HTTPException(status_code=400, detail="Wrong username or application password.")
    raise HTTPException(status_code=400, detail=f"WordPress returned {resp.status_code}. Check the site and REST API.")


@router.delete("")
def delete_config(
    db: Session = Depends(get_db), user: User = Depends(get_current_user)
) -> dict:
    cfg = _config_for(db, user)
    if cfg is not None:
        db.delete(cfg)
        db.commit()
    return {"ok": True}
