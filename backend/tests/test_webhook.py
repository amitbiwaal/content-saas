"""Generic (custom-site) publish target — connect flow + publish envelope.

The endpoint call is stubbed (``httpx.post``) so no real site is hit; ``guard_ssrf``
is stubbed for the happy path and left live for the SSRF case. Mirrors
test_wordpress.py.
"""

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth import require_auth
from app.db import Base, get_db
from app.export.service import webhook_publish
from app.main import app
from app.models import User

PROJECT = {"website": "x.com", "topic": "T", "keyword": "kw"}
DRAFT = {"sections": [{"heading": "H", "level": 2, "markdown": "Body **text**."}], "word_count": 5}
CFG = {"endpoint_url": "https://mysite.com/publish", "auth_token": "secret", "default_status": "publish"}


@pytest.fixture()
def client(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'wh.db'}", connect_args={"check_same_thread": False}
    )
    S = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    with S() as s:
        s.add(User(id="test-user-id", email="test@contentos.ai", name="Test"))
        s.commit()

    def _get_db():
        db = S()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[require_auth] = lambda: None
    with TestClient(app) as c:
        yield c, monkeypatch
    app.dependency_overrides.clear()
    engine.dispose()


def _resp(status, body=None):
    class R:
        status_code = status

        def json(self):
            if body is None:
                raise ValueError("no json")
            return body

        def raise_for_status(self):
            if status >= 400:
                raise httpx.HTTPStatusError(
                    "err", request=httpx.Request("POST", "http://x"), response=self
                )

    return lambda *a, **k: R()


# --- connect flow ---------------------------------------------------------- #
def test_connect_then_verify(client):
    c, mp = client
    mp.setattr("app.routers.webhook.guard_ssrf", lambda url: None)
    assert c.get("/api/webhook").json()["connected"] is False

    r = c.put("/api/webhook", json=CFG)
    assert r.status_code == 200, r.text
    b = r.json()
    assert b["connected"] is True and b["verified"] is False and b["has_token"] is True
    assert b["endpoint_url"] == "https://mysite.com/publish"

    mp.setattr(httpx, "post", _resp(200))
    assert c.post("/api/webhook/test", json={}).json()["verified"] is True


def test_token_is_never_returned(client):
    c, mp = client
    mp.setattr("app.routers.webhook.guard_ssrf", lambda url: None)
    r = c.put("/api/webhook", json=CFG).json()
    assert "auth_token" not in r
    assert "secret" not in str(r)  # only the has_token boolean leaves the server


def test_wrong_token_reports_clearly(client):
    c, mp = client
    mp.setattr("app.routers.webhook.guard_ssrf", lambda url: None)
    c.put("/api/webhook", json=CFG)
    mp.setattr(httpx, "post", _resp(401))
    assert c.post("/api/webhook/test", json={}).status_code == 400


def test_ssrf_blocks_private_endpoint(client):
    c, _mp = client  # guard NOT stubbed
    r = c.put("/api/webhook", json={**CFG, "endpoint_url": "http://127.0.0.1/x"})
    assert r.status_code == 422


def test_test_before_connect_is_404(client):
    c, _mp = client
    assert c.post("/api/webhook/test", json={}).status_code == 404


def test_disconnect(client):
    c, mp = client
    mp.setattr("app.routers.webhook.guard_ssrf", lambda url: None)
    c.put("/api/webhook", json=CFG)
    assert c.delete("/api/webhook").status_code == 200
    assert c.get("/api/webhook").json()["connected"] is False


# --- publish envelope ------------------------------------------------------ #
def test_publish_dry_run_without_endpoint():
    out = webhook_publish(DRAFT, PROJECT, {"endpoint_url": ""})
    assert out["status"] == "would_publish"
    env = out["payload"]
    assert env["title"] and env["html"] and env["markdown"] and env["slug"]
    assert env["source"] == "contentos"


def test_publish_posts_and_surfaces_link(monkeypatch):
    monkeypatch.setattr("app.net.guard_ssrf", lambda url: None)
    monkeypatch.setattr(httpx, "post", _resp(201, {"url": "https://mysite.com/p/1", "id": 42}))
    out = webhook_publish(
        DRAFT, PROJECT, {"endpoint_url": "https://mysite.com/publish", "auth_token": "s"}
    )
    assert out["status"] == "published"
    assert out["link"] == "https://mysite.com/p/1" and out["id"] == 42


def test_publish_surfaces_endpoint_error(monkeypatch):
    monkeypatch.setattr("app.net.guard_ssrf", lambda url: None)
    monkeypatch.setattr(httpx, "post", _resp(500))
    out = webhook_publish(DRAFT, PROJECT, {"endpoint_url": "https://mysite.com/publish"})
    assert out["status"] == "error"
