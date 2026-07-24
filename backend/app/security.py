"""User authentication — dependency-free (stdlib + httpx only).

* Password hashing: stdlib PBKDF2-HMAC-SHA256 (no bcrypt/passlib to install).
* Tokens: stdlib HS256 JWT (sign/verify with hmac+hashlib; no PyJWT).
* Google Sign-In: verify a Google ID token via Google's tokeninfo endpoint.
* ``get_current_user`` FastAPI dependency (Bearer token -> User).

This is a *separate* concern from :mod:`app.auth` (the shared service API-key
gate): that proves "this is our frontend"; this proves "which user". In prod both
apply — the BFF injects the service key and forwards the user's ``Authorization``.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time

import httpx
from fastapi import Depends, Header, HTTPException, status
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.models import User

logger = logging.getLogger("contentos.security")

_PBKDF2_ROUNDS = 210_000
_TOKEN_TTL_S = 60 * 60 * 24 * 30  # 30 days
_DEV_SECRET = "dev-insecure-jwt-secret-change-me"  # only used when JWT_SECRET unset


# --------------------------------------------------------------------------- #
# Password hashing (PBKDF2-HMAC-SHA256)
# --------------------------------------------------------------------------- #
def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        algo, rounds, salt_hex, dk_hex = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        dk = hashlib.pbkdf2_hmac(
            "sha256", password.encode(), bytes.fromhex(salt_hex), int(rounds)
        )
        return hmac.compare_digest(dk.hex(), dk_hex)
    except (ValueError, AttributeError):
        return False


# --------------------------------------------------------------------------- #
# JWT (HS256) — stdlib
# --------------------------------------------------------------------------- #
def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _secret() -> str:
    return get_settings().jwt_secret or _DEV_SECRET


def create_token(user_id: str) -> str:
    header = _b64url(json.dumps({"alg": "HS256", "typ": "JWT"}, separators=(",", ":")).encode())
    now = int(time.time())
    payload = _b64url(
        json.dumps({"sub": user_id, "iat": now, "exp": now + _TOKEN_TTL_S}, separators=(",", ":")).encode()
    )
    signing_input = f"{header}.{payload}".encode()
    sig = _b64url(hmac.new(_secret().encode(), signing_input, hashlib.sha256).digest())
    return f"{header}.{payload}.{sig}"


def decode_token(token: str) -> str | None:
    """Return the user id from a valid, unexpired token, else None."""
    try:
        header, payload, sig = token.split(".")
    except ValueError:
        return None
    signing_input = f"{header}.{payload}".encode()
    expected = _b64url(hmac.new(_secret().encode(), signing_input, hashlib.sha256).digest())
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        data = json.loads(_b64url_decode(payload))
    except (ValueError, json.JSONDecodeError):
        return None
    if int(data.get("exp", 0)) < int(time.time()):
        return None
    sub = data.get("sub")
    return sub if isinstance(sub, str) else None


# --------------------------------------------------------------------------- #
# Google Sign-In — verify an ID token via Google's tokeninfo endpoint
# --------------------------------------------------------------------------- #
def verify_google_token(id_token: str) -> dict | None:
    """Verify a Google ID token; return ``{sub, email, name}`` or None.

    Uses Google's ``tokeninfo`` endpoint (Google validates the signature). We then
    check the audience matches our client id and the email is verified.
    """
    if not id_token:
        return None
    try:
        resp = httpx.get(
            "https://oauth2.googleapis.com/tokeninfo",
            params={"id_token": id_token},
            timeout=10,
        )
    except httpx.HTTPError:
        logger.warning("google tokeninfo request failed")
        return None
    if resp.status_code != 200:
        return None
    try:
        claims = resp.json()
    except ValueError:
        return None
    client_id = get_settings().google_client_id
    if client_id and claims.get("aud") != client_id:
        return None
    if str(claims.get("email_verified")).lower() != "true":
        return None
    email = (claims.get("email") or "").strip().lower()
    if not email:
        return None
    return {"sub": claims.get("sub"), "email": email, "name": claims.get("name") or email}


# --------------------------------------------------------------------------- #
# FastAPI dependency
# --------------------------------------------------------------------------- #
def _bearer(authorization: str | None) -> str | None:
    if authorization and authorization[:7].lower() == "bearer ":
        return authorization[7:].strip() or None
    return None


def get_current_user(
    authorization: str | None = Header(default=None),
    db: Session = Depends(get_db),
) -> User:
    """Resolve the authenticated user from the ``Authorization: Bearer <jwt>`` header."""
    token = _bearer(authorization)
    user_id = decode_token(token) if token else None
    if not user_id:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="account not found")
    if not user.is_active:
        # Suspended by an admin — kill the live session too, not just new logins.
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="account suspended")
    return user


def require_project_access(
    project_id: str,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> None:
    """Router-level guard for ``/api/projects/{project_id}/...`` sub-routes.

    404s unless the signed-in user owns the project (or it is a legacy pre-auth
    row with no owner). Declared as a dependency so a whole router gets the
    check in one line; handlers keep loading the project themselves.
    """
    from app.models import Project  # local import to avoid a cycle at startup

    project = db.get(Project, project_id)
    if project is None or (project.owner_id is not None and project.owner_id != user.id):
        raise HTTPException(status_code=404, detail="project not found")


def user_is_admin(user: User) -> bool:
    """Effective admin: the DB flag OR an email on the ADMIN_EMAILS allow-list.

    The env allow-list bootstraps the first admin without a DB write; once in, an
    admin can promote others (which sets ``User.is_admin``).
    """
    return bool(user.is_admin) or user.email.lower() in get_settings().admin_email_set


def require_admin(user: User = Depends(get_current_user)) -> User:
    """Dependency that 403s any non-admin — gate for the /api/admin routes."""
    if not user_is_admin(user):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="admin access required")
    return user
