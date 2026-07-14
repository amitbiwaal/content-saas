"""Review-mode flow through the HTTP layer (step-by-step human gates).

Drives the whole gated sequence against a temp DB with mock adapters forced (so
no real provider keys from .env are ever hit): create → research → competitors →
approve → council(+feedback) → outline → draft → approve, then proves a
regenerate upstream re-opens the downstream gates.
"""

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.auth import require_auth
from app.db import Base, get_db
from app.main import app


@pytest.fixture()
def client(tmp_path, monkeypatch):
    # Force the deterministic MockAdapter for every seat, even if .env has real
    # OpenAI/xAI keys — the council/outline/draft must not make live API calls.
    monkeypatch.setattr("app.providers.factory._build_real", lambda *a, **k: None)

    db_file = tmp_path / "review_test.db"
    engine = create_engine(
        f"sqlite:///{db_file}", connect_args={"check_same_thread": False}
    )
    TestingSession = sessionmaker(
        bind=engine, autoflush=False, expire_on_commit=False
    )
    Base.metadata.create_all(engine)

    def _get_db():
        db = TestingSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = _get_db
    app.dependency_overrides[require_auth] = lambda: None
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()
    engine.dispose()


def _new_project(client) -> str:
    r = client.post(
        "/api/projects",
        json={
            "website": "spicyranked.com",
            "topic": "FeetFinder Review 2026",
            "keyword": "feetfinder reviews",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    # A fresh project starts in auto mode: no approvals recorded yet.
    assert not body.get("checkpoints")
    return body["id"]


def test_full_review_flow_gates_each_stage(client):
    pid = _new_project(client)

    # --- Research: generating marks the gate pending ------------------------ #
    r = client.post(f"/api/projects/{pid}/research", json={})
    assert r.status_code == 201, r.text
    cp = client.get(f"/api/projects/{pid}/checkpoints").json()
    assert cp["checkpoints"]["research"]["status"] == "pending"
    assert cp["next"] == "research"

    # --- Competitor analysis is available off the research ------------------ #
    comp = client.get(f"/api/projects/{pid}/competitors")
    assert comp.status_code == 200, comp.text
    assert "gaps" in comp.json() and comp.json()["competitors"]

    # --- Approve research unlocks council ----------------------------------- #
    r = client.post(f"/api/projects/{pid}/approve", json={"stage": "research"})
    assert r.status_code == 200
    assert r.json()["next"] == "council"

    # --- Council with editor feedback --------------------------------------- #
    r = client.post(
        f"/api/projects/{pid}/council",
        json={"feedback": "weigh pricing and payout trust"},
    )
    assert r.status_code == 200, r.text
    assert len(r.json()) >= 1  # at least one Judge decision
    cp = client.get(f"/api/projects/{pid}/checkpoints").json()
    assert cp["checkpoints"]["council"]["status"] == "pending"
    assert cp["checkpoints"]["council"]["feedback"] == "weigh pricing and payout trust"
    client.post(f"/api/projects/{pid}/approve", json={"stage": "council"})

    # --- Outline ------------------------------------------------------------ #
    r = client.post(f"/api/projects/{pid}/outline", json={})
    assert r.status_code == 201, r.text
    assert r.json()["nodes"]
    # Competitors now reflect our outline coverage.
    comp2 = client.get(f"/api/projects/{pid}/competitors").json()
    assert comp2["our_headings"]
    client.post(f"/api/projects/{pid}/approve", json={"stage": "outline"})

    # --- Draft -------------------------------------------------------------- #
    r = client.post(f"/api/projects/{pid}/draft", json={})
    assert r.status_code == 201, r.text
    assert r.json()["sections"]

    # --- Approving the draft completes the gated sequence ------------------- #
    r = client.post(f"/api/projects/{pid}/approve", json={"stage": "draft"})
    assert r.status_code == 200
    assert r.json()["next"] is None


def test_regenerate_upstream_reopens_downstream_gates(client):
    pid = _new_project(client)
    # Fast-forward: approve research + council.
    client.post(f"/api/projects/{pid}/research", json={})
    client.post(f"/api/projects/{pid}/approve", json={"stage": "research"})
    client.post(f"/api/projects/{pid}/council", json={})
    client.post(f"/api/projects/{pid}/approve", json={"stage": "council"})
    assert client.get(f"/api/projects/{pid}/checkpoints").json()["next"] == "outline"

    # Regenerate research: council approval is now stale and cleared.
    client.post(f"/api/projects/{pid}/research", json={"feedback": "new angle"})
    cp = client.get(f"/api/projects/{pid}/checkpoints").json()
    assert cp["next"] == "research"
    assert cp["checkpoints"].get("council", {}).get("status") != "approved"


def test_approve_rejects_unknown_stage(client):
    pid = _new_project(client)
    r = client.post(f"/api/projects/{pid}/approve", json={"stage": "scoring"})
    assert r.status_code == 422


def test_competitors_requires_research_first(client):
    pid = _new_project(client)
    r = client.get(f"/api/projects/{pid}/competitors")
    assert r.status_code == 409  # no research yet
