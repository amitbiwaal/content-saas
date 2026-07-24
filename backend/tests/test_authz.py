"""Authorization hardening: ownership + charging on every expensive surface.

Covers the audit fixes:
* the SSE run stream requires a signed-in OWNER for every open (fresh, resume
  via ``from=``, reconnect) — previously ``?from=<stage>`` started a full,
  unauthenticated, uncharged pipeline run on any project;
* project sub-routes (research/review/chat/council/debate/decisions) are
  owner-only for authed users;
* a council re-run is billed;
* the atomic credit charge can't double-spend and 402s cleanly.
"""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth import require_auth
from app.db import Base, get_db
from app.main import app
from app.models import Project, User
from app.security import create_token, get_current_user


@pytest.fixture()
def env(tmp_path, monkeypatch):
    """Temp DB + two real users (owner, other) + one owned project."""
    monkeypatch.setattr("app.providers.factory._build_real", lambda *a, **k: None)
    monkeypatch.setattr("app.config.Settings.research_provider", "mock", raising=False)

    engine = create_engine(
        f"sqlite:///{tmp_path / 'authz.db'}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(engine)
    TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    session = TestingSession()
    owner = User(email="owner@x.com", name="Owner", credits=1000)
    other = User(email="other@x.com", name="Other", credits=1000)
    session.add_all([owner, other])
    session.flush()
    project = Project(
        owner_id=owner.id, website="x.com", topic="Standing desks", keyword="desks"
    )
    session.add(project)
    session.commit()

    def _get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[require_auth] = lambda: None
    # The autouse conftest stub must not mask ownership checks here: resolve the
    # "current user" via the real token machinery per request instead.
    app.dependency_overrides.pop(get_current_user, None)

    with TestClient(app) as client:
        yield {
            "client": client,
            "session": session,
            "owner": owner,
            "other": other,
            "project": project,
            "owner_tok": create_token(owner.id),
            "other_tok": create_token(other.id),
        }
    app.dependency_overrides.pop(get_db, None)
    app.dependency_overrides.pop(require_auth, None)
    session.close()
    engine.dispose()


def _auth(tok: str) -> dict:
    return {"Authorization": f"Bearer {tok}"}


# --------------------------------------------------------------------------- #
# The run stream: every open needs a signed-in owner
# --------------------------------------------------------------------------- #
def test_stream_requires_token_even_with_from(env):
    c, pid = env["client"], env["project"].id
    r = c.get(f"/api/projects/{pid}/run/stream?from=keywords")
    assert r.status_code == 200  # SSE transport always 200; payload is the error
    assert "event: error" in r.text and "sign in" in r.text.lower()


def test_stream_rejects_non_owner(env):
    c, pid = env["client"], env["project"].id
    r = c.get(f"/api/projects/{pid}/run/stream?token={env['other_tok']}&from=keywords")
    assert "event: error" in r.text and "not found" in r.text.lower()


def test_stream_reconnect_requires_owner(env):
    c, pid = env["client"], env["project"].id
    r = c.get(f"/api/projects/{pid}/run/stream?after=5")
    assert "event: error" in r.text  # unauthenticated attach is refused


# --------------------------------------------------------------------------- #
# Project sub-routes are owner-only
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "method,path",
    [
        ("get", "/research"),
        ("post", "/research"),
        ("get", "/checkpoints"),
        ("post", "/approve"),
        ("get", "/decisions"),
        ("get", "/debate"),
        ("post", "/chat"),
        ("post", "/council"),
    ],
)
def test_sub_routes_hidden_from_non_owner(env, method, path):
    c, pid = env["client"], env["project"].id
    body = {}
    if path == "/approve":
        body = {"stage": "research"}
    if path == "/chat":
        body = {"message": "hi"}
    r = getattr(c, method)(
        f"/api/projects/{pid}{path}",
        headers=_auth(env["other_tok"]),
        **({"json": body} if method == "post" else {}),
    )
    assert r.status_code == 404, f"{method} {path} -> {r.status_code}"


def test_sub_routes_need_a_token_at_all(env):
    c, pid = env["client"], env["project"].id
    assert c.get(f"/api/projects/{pid}/research").status_code == 401
    assert c.post(f"/api/projects/{pid}/approve", json={"stage": "research"}).status_code == 401


def test_owner_can_use_sub_routes(env):
    c, pid = env["client"], env["project"].id
    # No research yet → owner gets the domain 404 (not an authz 404) — the
    # point is the request is allowed through the guard.
    r = c.get(f"/api/projects/{pid}/research", headers=_auth(env["owner_tok"]))
    assert r.status_code == 404 and "no research" in r.text
    r = c.get(f"/api/projects/{pid}/checkpoints", headers=_auth(env["owner_tok"]))
    assert r.status_code == 200


# --------------------------------------------------------------------------- #
# Council re-run is billed; the charge is atomic
# --------------------------------------------------------------------------- #
def test_council_rerun_charges_owner(env):
    c, pid = env["client"], env["project"].id
    before = env["owner"].credits
    r = c.post(f"/api/projects/{pid}/council", headers=_auth(env["owner_tok"]))
    assert r.status_code == 200, r.text
    env["session"].expire_all()
    after = env["session"].get(User, env["owner"].id).credits
    assert after == before - 10  # BASE_RUN_CREDITS


def test_charge_402_when_broke(env):
    from app.credits import charge
    from fastapi import HTTPException

    session = env["session"]
    broke = User(email="broke@x.com", credits=3)
    session.add(broke)
    session.commit()
    with pytest.raises(HTTPException) as exc:
        charge(session, broke, 10, "run")
    assert exc.value.status_code == 402
    session.expire_all()
    assert session.get(User, broke.id).credits == 3  # untouched


def test_stream_rate_limited_bucket():
    from app.ratelimit import _limit_for

    limit, bucket = _limit_for("/api/projects/abc/run/stream", "GET")
    assert bucket == "run" and limit and limit > 0
