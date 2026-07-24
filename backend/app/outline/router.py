"""Outline API (PRD §6 / §9.6, FR-6.1..6.3).

``POST /api/projects/{project_id}/outline`` reads the project's latest council
decisions and research, builds the H1/H2/H3 outline + element & schema hints via
:func:`app.outline.service.build_outline`, persists an :class:`Outline` row, and
returns it. ``GET`` returns the most recent outline.

The service is kept pure; this router owns all DB I/O (the M0 convention).
Response models are declared here (not in ``app/schemas.py``) to respect module
file boundaries.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.security import require_project_access
from app.models import Decision, Outline, Project, Research
from app.outline.service import build_outline
from app.review import touch_stage

# Owner-only: every route is project-scoped model work/artifacts.
router = APIRouter(prefix="/api/projects", tags=["outline"], dependencies=[Depends(require_project_access)])
class OutlineIn(BaseModel):
    """Optional body for an outline (re)build in review mode.

    ``feedback`` steers a regenerate (e.g. "merge the two FAQ sections") and is
    recorded on the review checkpoint.
    """

    feedback: str | None = Field(default=None, max_length=2000)


# --------------------------------------------------------------------------- #
# Response model (local to the module per file boundaries)
# --------------------------------------------------------------------------- #
class OutlineOut(BaseModel):
    """Persisted outline (PRD §14 ``outline`` entity)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    nodes: list = Field(default_factory=list)
    elements: list = Field(default_factory=list)
    schema_hooks: list = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


# --------------------------------------------------------------------------- #
# Routes
# --------------------------------------------------------------------------- #
@router.post("/{project_id}/outline", response_model=OutlineOut, status_code=201)
def create_outline(
    project_id: str,
    body: OutlineIn | None = None,
    db: Session = Depends(get_db),
) -> Outline:
    """Build + persist the outline from the project's strategy (FR-6.1..6.3).

    Reads the latest council decisions and most recent research for the project,
    derives the strategy summary from accepted points, and builds the outline via
    the Judge/strategy provider (with a deterministic fallback). In review mode an
    optional ``feedback`` steers a regenerate and the ``outline`` checkpoint is
    marked pending for human sign-off.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    decisions = list(
        db.scalars(
            select(Decision)
            .where(Decision.project_id == project_id)
            .order_by(Decision.created_at.asc())
        )
    )
    decision_dicts = [
        {
            "source": d.source,
            "point": d.point,
            "label": d.label,
            "reason": d.reason,
        }
        for d in decisions
    ]

    research_row = db.scalars(
        select(Research)
        .where(Research.project_id == project_id)
        .order_by(Research.created_at.desc())
    ).first()
    research = _research_payload(project, research_row)

    strategy_summary = _strategy_summary(project, decision_dicts)
    judge_provider = (project.council_config or {}).get("judge", "anthropic")

    built = build_outline(
        strategy_summary,
        decision_dicts,
        research,
        judge_provider=judge_provider,
        feedback=(body.feedback if body else None),
    )

    outline = Outline(
        project_id=project_id,
        nodes=built["nodes"],
        elements=built["elements"],
        schema_hooks=built["schema_hooks"],
    )
    db.add(outline)
    # Review-mode gate: outline awaits human sign-off; clears the draft approval.
    project.checkpoints = touch_stage(
        project.checkpoints, "outline", feedback=(body.feedback if body else None)
    )
    db.commit()
    db.refresh(outline)
    return outline


@router.get("/{project_id}/outline", response_model=OutlineOut)
def get_outline(project_id: str, db: Session = Depends(get_db)) -> Outline:
    """Return the most recently built outline for the project."""
    if not db.get(Project, project_id):
        raise HTTPException(status_code=404, detail="project not found")

    outline = db.scalars(
        select(Outline)
        .where(Outline.project_id == project_id)
        .order_by(Outline.created_at.desc())
    ).first()
    if not outline:
        raise HTTPException(status_code=404, detail="no outline for project")
    return outline


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _research_payload(project: Project, research: Research | None) -> dict:
    """Assemble the research dict the service consumes, with brief fallbacks."""
    payload: dict = {
        "keyword": project.keyword,
        "topic": project.topic,
        "intent": None,
        "headings": [],
        "paa": [],
        "entities": [],
    }
    if research is not None:
        payload["intent"] = research.intent
        payload["headings"] = research.headings or []
        payload["paa"] = research.paa or []
        payload["entities"] = research.entities or []
    return payload


def _strategy_summary(project: Project, decisions: list[dict]) -> str:
    """Build a strategy summary from accepted points, falling back to the brief."""
    accepted = [
        d["point"]
        for d in decisions
        if d.get("label") in ("accepted", "merge") and d.get("point")
    ]
    if accepted:
        return "Approved strategy: " + "; ".join(accepted[:6])
    return (
        f"Cover '{project.topic}' for the keyword '{project.keyword}' "
        f"with on-intent, sourced sections."
    )
