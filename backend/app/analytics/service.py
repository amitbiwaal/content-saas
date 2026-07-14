"""Analytics & cost service (PRD §12 analytics, §13 cost & budgeting).

Cost is **real** — aggregated from the persisted ``usage`` rows the pipeline
writes (registry-rate × tokens, PRD §13). Traffic / top-keywords / content-decay
are **deterministic mock** signals derived from the project (PRD §12 is
read-only and lightweight until a real GSC/Ahrefs analytics feed is wired) — the
same mock-first contract used across the app. The service is pure given a
``Session``; the router only shapes the HTTP response.
"""

from __future__ import annotations

import hashlib

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Project, Usage


def _seed(*parts: str) -> int:
    return int(hashlib.sha256("\x00".join(parts).encode()).hexdigest()[:8], 16)


# --------------------------------------------------------------------------- #
# Cost (real — from usage rows, PRD §13)
# --------------------------------------------------------------------------- #
def _project_cost(db: Session, project_id: str) -> tuple[int, float]:
    """Return (total_tokens, total_cost_cents) for a project from usage rows."""
    row = db.execute(
        select(
            func.coalesce(func.sum(Usage.tokens), 0),
            func.coalesce(func.sum(Usage.cost_cents), 0.0),
        ).where(Usage.project_id == project_id)
    ).one()
    return int(row[0] or 0), float(row[1] or 0.0)


# --------------------------------------------------------------------------- #
# Mock performance signals (PRD §12 — read-only, deterministic until real feed)
# --------------------------------------------------------------------------- #
def _traffic(project: Project) -> dict:
    seed = _seed(project.id, project.keyword or "")
    stage_factor = {"published": 1.0, "ready": 0.4}.get(project.stage, 0.0)
    visits = int(stage_factor * (200 + seed % 1800))
    return {
        "organic_visits_30d": visits,
        "top_keywords": [
            {"keyword": project.keyword or project.topic, "position": 3 + seed % 8, "clicks": int(visits * 0.4)},
            {"keyword": f"{project.keyword} reviews", "position": 6 + seed % 10, "clicks": int(visits * 0.2)},
        ] if visits else [],
        "ai_citations": (seed % 5) if stage_factor else 0,
    }


def _decay_alert(project: Project) -> dict | None:
    """Flag content decay for published pages losing traffic (FR-12.2, mock)."""
    if project.stage != "published":
        return None
    seed = _seed(project.id, "decay")
    if seed % 3 == 0:  # ~1/3 of published pages flagged, deterministically
        return {
            "project_id": project.id,
            "topic": project.topic,
            "drop_pct": 15 + seed % 35,
            "suggestion": "Refresh facts, add recent data, and re-run the council.",
        }
    return None


# --------------------------------------------------------------------------- #
# Public entry points
# --------------------------------------------------------------------------- #
def project_analytics(db: Session, project: Project) -> dict:
    tokens, cost = _project_cost(db, project.id)
    settings = get_settings()
    ceiling = settings.per_article_ceiling_cents
    return {
        "project_id": project.id,
        "tokens": tokens,
        "cost_cents": round(cost, 2),
        "cost_usd": round(cost / 100, 2),
        "over_article_ceiling": cost > ceiling,
        "article_ceiling_cents": ceiling,
        "traffic": _traffic(project),
        "decay": _decay_alert(project),
    }


def portfolio_analytics(db: Session) -> dict:
    """Portfolio-wide cost + budget + traffic + decay (PRD §12/§13)."""
    settings = get_settings()
    projects = list(db.scalars(select(Project)))

    # One grouped aggregate for all projects instead of a SUM per project (N+1).
    cost_rows = db.execute(
        select(
            Usage.project_id,
            func.coalesce(func.sum(Usage.tokens), 0),
            func.coalesce(func.sum(Usage.cost_cents), 0.0),
        ).group_by(Usage.project_id)
    ).all()
    cost_by_project: dict[str, tuple[int, float]] = {
        r[0]: (int(r[1] or 0), float(r[2] or 0.0)) for r in cost_rows
    }

    total_tokens, total_cost = 0, 0.0
    per_project: list[dict] = []
    decay: list[dict] = []
    visits = 0
    citations = 0
    for p in projects:
        tokens, cost = cost_by_project.get(p.id, (0, 0.0))
        total_tokens += tokens
        total_cost += cost
        traffic = _traffic(p)
        visits += traffic["organic_visits_30d"]
        citations += traffic["ai_citations"]
        per_project.append(
            {
                "project_id": p.id,
                "topic": p.topic,
                "stage": p.stage,
                "tokens": tokens,
                "cost_cents": round(cost, 2),
                "organic_visits_30d": traffic["organic_visits_30d"],
            }
        )
        alert = _decay_alert(p)
        if alert:
            decay.append(alert)

    budget = settings.monthly_budget_cents
    per_project.sort(key=lambda x: -x["cost_cents"])
    return {
        "cost": {
            "total_cents": round(total_cost, 2),
            "total_usd": round(total_cost / 100, 2),
            "total_tokens": total_tokens,
            "monthly_budget_cents": budget,
            "budget_used_pct": round(min(100.0, (total_cost / budget * 100) if budget else 0.0), 1),
            "per_article_ceiling_cents": settings.per_article_ceiling_cents,
        },
        "traffic": {"organic_visits_30d": visits, "ai_citations": citations},
        "projects": per_project,
        "decay_alerts": decay,
    }
