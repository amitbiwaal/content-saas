"""Authentication + account API — JWT login/signup, Google Sign-In, credits.

All routes sit behind the shared service API-key gate (app.auth) like the rest of
the API, but do NOT require a user token (they mint one). ``/api/auth/me`` and
``/api/auth/credits`` require a valid Bearer token.
"""

from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app import credits as credits_mod
from app.config import get_settings
from app.db import get_db
from app.models import SIGNUP_CREDITS, CreditLedger, User, WordPressConfig
from app.security import (
    create_token,
    get_current_user,
    hash_password,
    user_is_admin,
    verify_google_token,
    verify_password,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])
logger = logging.getLogger("contentos.auth")

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


# --------------------------------------------------------------------------- #
# Wire models
# --------------------------------------------------------------------------- #
class SignupIn(BaseModel):
    email: str
    password: str = Field(min_length=8, max_length=200)
    name: str | None = Field(default=None, max_length=255)


class LoginIn(BaseModel):
    email: str
    password: str = Field(min_length=1, max_length=200)


class GoogleIn(BaseModel):
    credential: str = Field(min_length=1, max_length=5000)  # Google ID token (GIS)


class UserOut(BaseModel):
    id: str
    email: str
    name: str | None
    credits: int
    plan: str = "free"
    is_admin: bool = False  # effective admin (flag or ADMIN_EMAILS) — gates the /admin UI
    has_wordpress: bool = False
    auth_configured: bool = True  # whether google sign-in is available client-side


class AuthOut(BaseModel):
    token: str
    user: UserOut


class LedgerEntryOut(BaseModel):
    delta: int
    balance_after: int
    reason: str
    detail: str | None
    project_id: str | None
    created_at: str


class CreditsOut(BaseModel):
    credits: int
    ledger: list[LedgerEntryOut]


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _has_wp(db: Session, user_id: str) -> bool:
    return db.scalar(
        select(WordPressConfig.id).where(WordPressConfig.user_id == user_id)
    ) is not None


def _user_out(db: Session, user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        name=user.name,
        credits=int(user.credits),
        plan=user.plan,
        is_admin=user_is_admin(user),
        has_wordpress=_has_wp(db, user.id),
        auth_configured=bool(get_settings().google_client_id),
    )


def _auth_out(db: Session, user: User) -> AuthOut:
    return AuthOut(token=create_token(user.id), user=_user_out(db, user))


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.post("/signup", response_model=AuthOut, status_code=201)
def signup(payload: SignupIn, db: Session = Depends(get_db)) -> AuthOut:
    email = payload.email.strip().lower()
    if not _EMAIL_RE.match(email):
        raise HTTPException(status_code=422, detail="Enter a valid email address.")
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise HTTPException(status_code=409, detail="An account with this email already exists.")
    user = User(
        email=email,
        name=(payload.name or "").strip() or email.split("@")[0],
        password_hash=hash_password(payload.password),
        credits=0,  # granted below so the ledger records it
    )
    db.add(user)
    db.flush()  # assign user.id before the ledger entry
    credits_mod.grant(db, user, SIGNUP_CREDITS, "signup", detail="Welcome bonus")
    db.commit()
    db.refresh(user)
    logger.info("signup: %s", email)
    return _auth_out(db, user)


# A throwaway hash compared against when the email doesn't exist, so unknown
# and known emails take the same time (no account enumeration via timing).
_DUMMY_HASH = hash_password("timing-equalizer-dummy")


@router.post("/login", response_model=AuthOut)
def login(payload: LoginIn, db: Session = Depends(get_db)) -> AuthOut:
    email = payload.email.strip().lower()
    user = db.scalars(select(User).where(User.email == email)).first()
    ok = verify_password(payload.password, user.password_hash if user else _DUMMY_HASH)
    if user is None or not ok:
        raise HTTPException(status_code=401, detail="Wrong email or password.")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="This account has been suspended.")
    credits_mod.apply_monthly_refill(db, user)  # grant this month's allowance if due
    return _auth_out(db, user)


@router.post("/google", response_model=AuthOut)
def google_signin(payload: GoogleIn, db: Session = Depends(get_db)) -> AuthOut:
    if not get_settings().google_client_id:
        raise HTTPException(status_code=400, detail="Google Sign-In is not configured on this server.")
    info = verify_google_token(payload.credential)
    if info is None:
        raise HTTPException(status_code=401, detail="Google sign-in failed. Try again.")
    email = info["email"]
    user = db.scalars(
        select(User).where((User.google_sub == info["sub"]) | (User.email == email))
    ).first()
    if user is None:
        user = User(email=email, name=info.get("name"), google_sub=info["sub"], credits=0)
        db.add(user)
        db.flush()
        credits_mod.grant(db, user, SIGNUP_CREDITS, "signup", detail="Welcome bonus (Google)")
        logger.info("signup via google: %s", email)
    elif not user.google_sub:
        user.google_sub = info["sub"]  # link Google to an existing email account
    if not user.is_active:
        raise HTTPException(status_code=403, detail="This account has been suspended.")
    db.commit()
    db.refresh(user)
    credits_mod.apply_monthly_refill(db, user)  # grant this month's allowance if due
    return _auth_out(db, user)


@router.get("/me", response_model=UserOut)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> UserOut:
    # Safety net for long-lived sessions that cross a month boundary without a
    # fresh login (no-op on the common path — see apply_monthly_refill).
    credits_mod.apply_monthly_refill(db, user)
    return _user_out(db, user)


@router.get("/credits", response_model=CreditsOut)
def credits(user: User = Depends(get_current_user), db: Session = Depends(get_db)) -> CreditsOut:
    entries = credits_mod.ledger_for(db, user)
    return CreditsOut(
        credits=int(user.credits),
        ledger=[
            LedgerEntryOut(
                delta=e.delta,
                balance_after=e.balance_after,
                reason=e.reason,
                detail=e.detail,
                project_id=e.project_id,
                created_at=e.created_at.isoformat() if e.created_at else "",
            )
            for e in entries
        ],
    )
