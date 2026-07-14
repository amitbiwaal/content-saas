"""Content Memory + Internal Links API (PRD §9.11, FR-11.1..11.3).

Endpoints under ``/api/projects``:

* ``POST /api/projects/{project_id}/internal-links`` — suggest internal links
  for the project's latest draft against the per-website knowledge graph,
  persist them as :class:`~app.models.InternalLink` rows, return them (FR-11.2).
* ``GET  /api/projects/{project_id}/internal-links`` — the persisted links for
  the latest draft.
* ``GET  /api/projects/memory/coverage?website=...`` — topic-coverage map for a
  website built from its :class:`~app.models.Memory` nodes (FR-11.1/11.4).

Service logic stays pure (see :mod:`app.memory_engine.service`); this layer owns
the DB session + HTTP contract, matching the projects/research router pattern.
``app/schemas.py`` is owned by the integrator, so response models are declared
locally here.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.memory_engine.service import suggest_internal_links, topic_coverage
from app.models import Draft, InternalLink, Memory, Project

router = APIRouter(prefix="/api/projects", tags=["memory"])


# --------------------------------------------------------------------------- #
# Wire schemas (kept local: app/schemas.py is owned by the integrator)
# --------------------------------------------------------------------------- #
class InternalLinkOut(BaseModel):
    """A persisted internal-link suggestion (PRD §11.2 -> ``InternalLink``)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    draft_id: str
    target_url: str
    anchor: str
    created_at: datetime
    updated_at: datetime


class ClusterCoverageOut(BaseModel):
    """Topical authority coverage for one cluster (FR-11.4)."""

    cluster: str
    topics: list[str] = Field(default_factory=list)
    topic_count: int
    average_coverage: float


class MemoryCoverageOut(BaseModel):
    """Per-website topic-coverage map (PRD §11.1, FR-11.1/11.4)."""

    website: str
    topic_count: int
    average_coverage: float
    clusters: list[ClusterCoverageOut] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _require_project(project_id: str, db: Session) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _latest_draft(project_id: str, db: Session) -> Draft | None:
    return db.scalars(
        select(Draft)
        .where(Draft.project_id == project_id)
        .order_by(Draft.version.desc(), Draft.created_at.desc())
    ).first()


def _memory_nodes(website: str, db: Session) -> list[Memory]:
    return list(
        db.scalars(
            select(Memory)
            .where(Memory.website == website)
            .order_by(Memory.created_at.asc())
        )
    )


def _draft_payload(draft: Draft, project: Project) -> dict:
    """Draft + brief fields the linker matches on (entities/headings/topic)."""
    return {
        "topic": project.topic,
        "keyword": project.keyword,
        "sections": draft.sections or [],
    }


def _node_to_dict(node: Memory) -> dict:
    return {
        "website": node.website,
        "topic_node": node.topic_node,
        # Memory has no URL column; derive a stable anchor target from the node.
        "target_url": f"/{node.topic_node.strip().lower().replace(' ', '-')}",
        "cluster": node.cluster,
        "coverage": node.coverage,
    }


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.post(
    "/{project_id}/internal-links",
    response_model=list[InternalLinkOut],
    status_code=201,
)
def create_internal_links(
    project_id: str, db: Session = Depends(get_db)
) -> list[InternalLink]:
    """Suggest + persist internal links for the latest draft (FR-11.2).

    Matches the draft's entities/headings/topic against the project website's
    ``Memory`` topic nodes (PRD §11.1) and stores one ``InternalLink`` row per
    suggestion. Re-running replaces the latest draft's existing suggestions so
    the editor always sees a current set rather than duplicates.
    """
    project = _require_project(project_id, db)
    draft = _latest_draft(project_id, db)
    if draft is None:
        raise HTTPException(status_code=404, detail="no draft yet")

    nodes = [_node_to_dict(n) for n in _memory_nodes(project.website, db)]
    suggestions = suggest_internal_links(
        project.website, _draft_payload(draft, project), nodes
    )

    # Replace any prior suggestions for this draft so re-runs stay idempotent.
    existing_links = list(draft.internal_links)
    for link in existing_links:
        db.delete(link)

    created: list[InternalLink] = []
    for s in suggestions:
        link = InternalLink(
            draft_id=draft.id, target_url=s["target_url"], anchor=s["anchor"]
        )
        db.add(link)
        created.append(link)

    db.commit()
    for link in created:
        db.refresh(link)
    return created


@router.get("/{project_id}/internal-links", response_model=list[InternalLinkOut])
def list_internal_links(
    project_id: str, db: Session = Depends(get_db)
) -> list[InternalLink]:
    """Return persisted internal links for the project's latest draft (FR-11.2)."""
    _require_project(project_id, db)
    draft = _latest_draft(project_id, db)
    if draft is None:
        raise HTTPException(status_code=404, detail="no draft yet")
    return list(
        db.scalars(
            select(InternalLink)
            .where(InternalLink.draft_id == draft.id)
            .order_by(InternalLink.created_at.asc())
        )
    )


@router.get("/memory/coverage", response_model=MemoryCoverageOut)
def get_memory_coverage(
    website: str = Query(..., description="Website whose knowledge graph to summarise"),
    db: Session = Depends(get_db),
) -> MemoryCoverageOut:
    """Topic-coverage map for a website's knowledge graph (FR-11.1/11.4).

    Served at ``/api/projects/memory/coverage`` — a two-segment path so it is
    never captured by the dynamic ``/{project_id}`` route (a single ``/memory``
    would 404 as project_id="memory").
    """
    nodes = [_node_to_dict(n) for n in _memory_nodes(website, db)]
    coverage = topic_coverage(website, nodes)
    return MemoryCoverageOut(**coverage)
