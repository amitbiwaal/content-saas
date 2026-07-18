"""WordPress connect flow — save config, test connection, SSRF guard, disconnect.

The WP REST call in ``/test`` is stubbed (``httpx.get``) so no real site is hit;
``guard_ssrf`` is stubbed for the happy-path host and left live for the SSRF case.
"""

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth import require_auth
from app.db import Base, get_db
from app.main import app
from app.models import User


@pytest.fixture()
def client(tmp_path, monkeypatch):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'wp.db'}", connect_args={"check_same_thread": False}
    )
    S = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)
    # conftest authenticates every request as this stub user; seed it so the
    # WordPressConfig.user_id foreign key has a row to point at.
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


def _fake_get(status):
    class _Resp:
        status_code = status

    return lambda *a, **k: _Resp()


CREDS = {"site_url": "https://myblog.com", "username": "admin", "app_password": "xxxx xxxx"}


def test_connect_then_verify(client):
    c, mp = client
    mp.setattr("app.routers.wordpress.guard_ssrf", lambda url: None)

    assert c.get("/api/wordpress").json()["connected"] is False

    r = c.put("/api/wordpress", json=CREDS)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["connected"] is True
    assert body["verified"] is False               # not tested yet
    assert body["site_url"] == "https://myblog.com"

    # WP REST answers 200 for good creds → verified
    mp.setattr(httpx, "get", _fake_get(200))
    r = c.post("/api/wordpress/test", json={})
    assert r.status_code == 200, r.text
    assert r.json()["verified"] is True


def test_wrong_credentials_report_clearly(client):
    c, mp = client
    mp.setattr("app.routers.wordpress.guard_ssrf", lambda url: None)
    c.put("/api/wordpress", json={**CREDS, "app_password": "wrong"})
    mp.setattr(httpx, "get", _fake_get(401))
    r = c.post("/api/wordpress/test", json={})
    assert r.status_code == 400
    assert "password" in r.json()["detail"].lower()


def test_url_is_normalized(client):
    c, mp = client
    mp.setattr("app.routers.wordpress.guard_ssrf", lambda url: None)
    # no scheme + trailing slash → https:// and no trailing slash
    r = c.put("/api/wordpress", json={**CREDS, "site_url": "myblog.com/"})
    assert r.json()["site_url"] == "https://myblog.com"


def test_ssrf_blocks_private_host_on_save(client):
    c, _mp = client  # guard NOT stubbed here
    r = c.put("/api/wordpress", json={**CREDS, "site_url": "http://10.0.0.1"})
    assert r.status_code == 422


def test_test_before_connect_is_404(client):
    c, mp = client
    mp.setattr("app.routers.wordpress.guard_ssrf", lambda url: None)
    assert c.post("/api/wordpress/test", json={}).status_code == 404


def test_disconnect(client):
    c, mp = client
    mp.setattr("app.routers.wordpress.guard_ssrf", lambda url: None)
    c.put("/api/wordpress", json=CREDS)
    assert c.delete("/api/wordpress").status_code == 200
    assert c.get("/api/wordpress").json()["connected"] is False
