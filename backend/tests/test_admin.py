"""Admin panel API — access gating + user administration.

Seeds a temp DB with one admin and two members, then drives the admin routes as
each. ``require_admin`` resolves through ``get_current_user`` (overridden here),
so switching the caller is enough to exercise the 403 gate and the happy path.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app import credits as credits_mod
from app.auth import require_auth
from app.db import Base, get_db
from app.main import app
from app.models import Project, User
from app.security import get_current_user


@pytest.fixture()
def env(tmp_path, monkeypatch):
    monkeypatch.setattr("app.providers.factory._build_real", lambda *a, **k: None)

    db_file = tmp_path / "admin_test.db"
    engine = create_engine(
        f"sqlite:///{db_file}", connect_args={"check_same_thread": False}
    )
    TestingSession = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    Base.metadata.create_all(engine)

    # One admin (via the DB flag), two members; alice owns a project + a ledger row.
    with TestingSession() as s:
        admin = User(email="boss@test.ai", name="Boss", credits=100, is_admin=True)
        alice = User(email="alice@test.ai", name="Alice", credits=0)
        bob = User(email="bob@test.ai", name="Bob", credits=0)
        s.add_all([admin, alice, bob])
        s.flush()
        # grant() moves alice 0 -> 500 and leaves one ledger row for the detail test.
        credits_mod.grant(s, alice, 500, "signup", detail="Welcome bonus")
        s.add(
            Project(
                owner_id=alice.id,
                website="example.com",
                topic="Alice's guide",
                keyword="alice guide",
                stage="ready",
            )
        )
        s.commit()
        ids = {"admin": admin.id, "alice": alice.id, "bob": bob.id}

    def _get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    def as_user(uid: str) -> None:
        """Make the given seeded user the authenticated caller."""
        def _dep():
            with TestingSession() as s:
                return s.get(User, uid)
        app.dependency_overrides[get_current_user] = _dep

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[require_auth] = lambda: None

    with TestClient(app) as c:
        yield c, ids, as_user
    app.dependency_overrides.clear()
    engine.dispose()


def test_non_admin_is_forbidden(env):
    client, ids, as_user = env
    as_user(ids["alice"])  # a member
    assert client.get("/api/admin/stats").status_code == 403
    assert client.get("/api/admin/users").status_code == 403
    assert (
        client.post(f"/api/admin/users/{ids['bob']}/admin", json={"is_admin": True}).status_code
        == 403
    )


def test_stats_counts(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    r = client.get("/api/admin/stats")
    assert r.status_code == 200, r.text
    s = r.json()
    assert s["users_total"] == 3
    assert s["users_admins"] == 1  # only the flagged admin
    assert s["credits_outstanding"] == 600  # 100 + 500 + 0


def test_list_and_search_users(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    all_users = client.get("/api/admin/users").json()
    assert all_users["total"] == 3
    assert {u["email"] for u in all_users["users"]} == {
        "boss@test.ai",
        "alice@test.ai",
        "bob@test.ai",
    }
    # case-insensitive match on name or email
    hit = client.get("/api/admin/users", params={"q": "ALICE"}).json()
    assert hit["total"] == 1
    assert hit["users"][0]["email"] == "alice@test.ai"


def test_adjust_credits_grants_and_clamps(env):
    client, ids, as_user = env
    as_user(ids["admin"])

    r = client.post(
        f"/api/admin/users/{ids['alice']}/credits", json={"delta": 250, "reason": "top-up"}
    )
    assert r.status_code == 200, r.text
    assert r.json()["credits"] == 750

    # An over-draw correction never drives the balance negative.
    r = client.post(f"/api/admin/users/{ids['alice']}/credits", json={"delta": -10000})
    assert r.status_code == 200
    assert r.json()["credits"] == 0

    # Zero is rejected.
    assert (
        client.post(f"/api/admin/users/{ids['alice']}/credits", json={"delta": 0}).status_code
        == 422
    )


def test_promote_and_demote(env):
    client, ids, as_user = env
    as_user(ids["admin"])

    r = client.post(f"/api/admin/users/{ids['bob']}/admin", json={"is_admin": True})
    assert r.status_code == 200, r.text
    assert r.json()["is_admin"] is True and r.json()["effective_admin"] is True

    r = client.post(f"/api/admin/users/{ids['bob']}/admin", json={"is_admin": False})
    assert r.status_code == 200
    assert r.json()["is_admin"] is False and r.json()["effective_admin"] is False


def test_cannot_demote_self(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    r = client.post(f"/api/admin/users/{ids['admin']}/admin", json={"is_admin": False})
    assert r.status_code == 400


def test_credits_on_missing_user_404(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    r = client.post("/api/admin/users/does-not-exist/credits", json={"delta": 100})
    assert r.status_code == 404


def test_user_detail_has_projects_and_ledger(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    r = client.get(f"/api/admin/users/{ids['alice']}")
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["user"]["email"] == "alice@test.ai"
    assert d["user"]["projects"] == 1
    assert len(d["projects"]) == 1 and d["projects"][0]["topic"] == "Alice's guide"
    assert len(d["ledger"]) == 1 and d["ledger"][0]["delta"] == 500


def test_recent_projects_lists_owner(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    r = client.get("/api/admin/projects")
    assert r.status_code == 200, r.text
    rows = r.json()
    assert len(rows) == 1
    assert rows[0]["owner_email"] == "alice@test.ai"
    assert rows[0]["topic"] == "Alice's guide"


def test_sort_by_credits_ascending(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    r = client.get("/api/admin/users", params={"sort": "credits", "order": "asc"})
    creds = [u["credits"] for u in r.json()["users"]]
    assert creds == sorted(creds)  # bob(0) first, alice(500) last of the three


def test_suspend_blocks_login_and_reactivate(env):
    client, ids, as_user = env
    # A real account with a password (signup is open and writes to the test DB).
    su = client.post(
        "/api/auth/signup",
        json={"email": "carol@test.ai", "password": "supersecret", "name": "Carol"},
    )
    assert su.status_code == 201, su.text
    carol_id = su.json()["user"]["id"]

    as_user(ids["admin"])
    r = client.post(f"/api/admin/users/{carol_id}/suspend", json={"active": False})
    assert r.status_code == 200 and r.json()["is_active"] is False

    # Suspended => login is blocked at the real endpoint.
    lg = client.post(
        "/api/auth/login", json={"email": "carol@test.ai", "password": "supersecret"}
    )
    assert lg.status_code == 403

    # Reactivate => login works again.
    r = client.post(f"/api/admin/users/{carol_id}/suspend", json={"active": True})
    assert r.status_code == 200 and r.json()["is_active"] is True
    lg = client.post(
        "/api/auth/login", json={"email": "carol@test.ai", "password": "supersecret"}
    )
    assert lg.status_code == 200


def test_cannot_suspend_self(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    r = client.post(f"/api/admin/users/{ids['admin']}/suspend", json={"active": False})
    assert r.status_code == 400


def test_delete_user_removes_projects(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    r = client.delete(f"/api/admin/users/{ids['alice']}")
    assert r.status_code == 200, r.text
    assert r.json()["projects_removed"] == 1
    # gone
    assert client.get(f"/api/admin/users/{ids['alice']}").status_code == 404
    assert client.get("/api/admin/projects").json() == []
    assert client.get("/api/admin/stats").json()["users_total"] == 2


def test_cannot_delete_self(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    assert client.delete(f"/api/admin/users/{ids['admin']}").status_code == 400


def test_set_plan_upgrades_and_tops_up(env):
    client, ids, as_user = env
    as_user(ids["admin"])
    # bob starts free with 0 credits
    r = client.post(f"/api/admin/users/{ids['bob']}/plan", json={"plan": "pro"})
    assert r.status_code == 200, r.text
    assert r.json()["plan"] == "pro"
    assert r.json()["credits"] == 5000  # topped up to the pro allowance
    # unknown plan rejected
    assert client.post(f"/api/admin/users/{ids['bob']}/plan", json={"plan": "gold"}).status_code == 422
