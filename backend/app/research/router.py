"""Research Intelligence API (PRD §9.4, FR-4.1..4.5).

Two endpoints under the project:

* ``POST /api/projects/{project_id}/research`` — runs :func:`gather_research`
  on the project's brief and persists a :class:`~app.models.Research` row
  (FR-3.4 trigger on submit, FR-4.5 normalised brief).
* ``GET  /api/projects/{project_id}/research``  — returns the latest Research.

Service logic stays pure (see :mod:`app.research.service`); this layer owns the
DB session and HTTP contract, matching the projects router pattern.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Outline, Project, Research
from app.research.competitors import analyze_competitors
from app.research.service import gather_research
from app.review import touch_stage

router = APIRouter(prefix="/api/projects", tags=["research"])


class RunResearchIn(BaseModel):
    """Optional body for a research (re)run in review mode.

    ``feedback`` is an editor instruction recorded on the review checkpoint for
    audit. Research is deterministic data-gathering, so feedback is logged rather
    than fed to a model (unlike council/outline/draft, where it steers output).
    """

    feedback: str | None = Field(default=None, max_length=2000)


# --------------------------------------------------------------------------- #
# Response schema (kept local: app/schemas.py is owned by the integrator)
# --------------------------------------------------------------------------- #
class ResearchOut(BaseModel):
    """Persisted, normalised research brief (PRD §9.4 / FR-4.5)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    serp: list | None = Field(default=None)
    headings: list | None = Field(default=None)
    paa: list | None = Field(default=None)
    entities: list | None = Field(default=None)
    sources: list | None = Field(default=None)
    intent: str | None = None
    provider: str
    created_at: datetime
    updated_at: datetime


def _project_brief(project: Project) -> dict:
    """Project -> research brief dict (the FR-3.1 capture fields)."""
    return {
        "topic": project.topic,
        "keyword": project.keyword,
        "country": project.country,
        "audience": project.audience,
        "tone": project.tone,
        "goal": project.goal,
    }


@router.post("/{project_id}/research", response_model=ResearchOut, status_code=201)
def run_research(
    project_id: str,
    body: RunResearchIn | None = None,
    db: Session = Depends(get_db),
) -> Research:
    """Gather + persist research for the project's brief (FR-3.4, FR-4.1..4.5).

    In review mode this marks the ``research`` checkpoint pending (recording any
    ``feedback``) and clears downstream approvals, so a regenerate sends the
    editor back through the gates that depended on it.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    data = gather_research(_project_brief(project))

    research = Research(
        project_id=project.id,
        serp=data["serp"],
        headings=data["headings"],
        paa=data["paa"],
        entities=data["entities"],
        sources=data["sources"],
        intent=data["intent"],
        provider=data["provider"],
    )
    db.add(research)

    # Research is the first pipeline stage; advance the project once it lands.
    if project.stage == "research":
        project.stage = "council"
    # Review-mode gate: this stage now awaits human sign-off (FR-5.5 human loop).
    project.checkpoints = touch_stage(
        project.checkpoints, "research", feedback=(body.feedback if body else None)
    )

    db.commit()
    db.refresh(research)
    return research


@router.get("/{project_id}/research", response_model=ResearchOut)
def get_latest_research(project_id: str, db: Session = Depends(get_db)) -> Research:
    """Return the most recent Research row for the project (FR-4.5)."""
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    research = db.scalars(
        select(Research)
        .where(Research.project_id == project_id)
        .order_by(Research.created_at.desc())
    ).first()
    if not research:
        raise HTTPException(status_code=404, detail="no research for project")
    return research


# --------------------------------------------------------------------------- #
# Competitor analysis (review mode) — SERP rivals + outline coverage gaps
# --------------------------------------------------------------------------- #
class CompetitorCard(BaseModel):
    rank: int
    title: str
    domain: str
    url: str
    snippet: str = ""


class CoveredHeading(BaseModel):
    heading: str
    matched_by: str


class CompetitorAnalysisOut(BaseModel):
    """Competitor view + coverage-gap analysis (FR-4.1, review mode)."""

    competitors: list[CompetitorCard] = Field(default_factory=list)
    competitor_headings: list[str] = Field(default_factory=list)
    our_headings: list[str] = Field(default_factory=list)
    covered: list[CoveredHeading] = Field(default_factory=list)
    gaps: list[str] = Field(default_factory=list)
    extra: list[str] = Field(default_factory=list)
    coverage_pct: float = 0.0


@router.get("/{project_id}/competitors", response_model=CompetitorAnalysisOut)
def get_competitors(
    project_id: str, db: Session = Depends(get_db)
) -> CompetitorAnalysisOut:
    """Competitor SERP rivals + coverage-gap analysis vs the project's outline.

    Reads the latest Research (SERP + competitor headings) and latest Outline,
    and returns which competitor subtopics the article already covers, which are
    still gaps, and which of our sections rivals lack. Zero API key — derived
    entirely from data already gathered.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    research = db.scalars(
        select(Research)
        .where(Research.project_id == project_id)
        .order_by(Research.created_at.desc())
    ).first()
    if not research:
        raise HTTPException(
            status_code=409, detail="no research yet; run research first"
        )
    research_payload = {
        "serp": research.serp or [],
        "headings": research.headings or [],
        "paa": research.paa or [],
    }

    outline = db.scalars(
        select(Outline)
        .where(Outline.project_id == project_id)
        .order_by(Outline.created_at.desc())
    ).first()
    outline_payload = {"nodes": outline.nodes or []} if outline else None

    return CompetitorAnalysisOut(**analyze_competitors(research_payload, outline_payload))
