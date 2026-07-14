"""Article Writer API (PRD §7 / §9.7, FR-7.2/7.5).

Endpoints build a draft from the project's latest approved Outline, persist it as
a versioned :class:`~app.models.Draft` row, and support regenerating a single
section with an old-versus-new diff payload (FR-7.5).

Service functions in :mod:`app.article.service` stay pure; all DB work (latest
lookups, version increment, persistence) lives here on the request ``Session``,
matching the projects router pattern.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.article.service import generate_draft, proofread_sections, regenerate_section
from app.db import get_db
from app.models import Draft, Outline, Project, Research
from app.review import touch_stage

router = APIRouter(prefix="/api/projects", tags=["article"])


# --------------------------------------------------------------------------- #
# Wire schemas
# --------------------------------------------------------------------------- #
class SectionOut(BaseModel):
    """One rendered article section (PRD §7)."""

    heading: str
    level: int
    markdown: str


class DraftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    project_id: str
    outline_id: str | None
    sections: list[SectionOut] = Field(default_factory=list)
    word_count: int
    version: int
    created_at: datetime
    updated_at: datetime


class CreateDraftIn(BaseModel):
    """Optional body for a draft (re)generation in review mode.

    ``feedback`` steers a full-draft regenerate (e.g. "tighten every section,
    less repetition") and is recorded on the review checkpoint.
    """

    feedback: str | None = Field(default=None, max_length=2000)


class RegenerateSectionIn(BaseModel):
    """Request body for FR-7.5 single-section regeneration."""

    section_index: int = Field(ge=0)
    provider: str = "anthropic"
    # Optional editor instruction steering the rewrite of this one section.
    feedback: str | None = Field(default=None, max_length=2000)


class DraftUpdateIn(BaseModel):
    """Editor save — replace the latest draft's sections (FR-7.1 editable draft)."""

    sections: list[SectionOut] = Field(default_factory=list)


class SectionDiffOut(BaseModel):
    """Old-versus-new section payload for the editor diff view (FR-7.5)."""

    section_index: int
    old: SectionOut | None
    new: SectionOut


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _require_project(project_id: str, db: Session) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _latest_outline(project_id: str, db: Session) -> Outline | None:
    return db.scalars(
        select(Outline)
        .where(Outline.project_id == project_id)
        .order_by(Outline.created_at.desc())
    ).first()


def _latest_draft(project_id: str, db: Session) -> Draft | None:
    return db.scalars(
        select(Draft)
        .where(Draft.project_id == project_id)
        .order_by(Draft.version.desc(), Draft.created_at.desc())
    ).first()


def _brief_from_project(project: Project) -> dict:
    return {
        "topic": project.topic,
        "keyword": project.keyword,
        "country": project.country,
        "audience": project.audience,
        "tone": project.tone,
        "goal": project.goal,
    }


def _outline_payload(outline: Outline | None) -> dict:
    if outline is None:
        return {}
    return {"nodes": outline.nodes or [], "elements": outline.elements or []}


def _research_payload(project_id: str, db: Session) -> dict:
    """Latest research for a project, shaped for the writer (sources/entities/PAA).

    Lets the editor's create/regenerate paths ground + cite the same sources the
    pipeline used, so re-generated sections keep their EEAT/Fact/AEO signals.
    """
    row = db.scalars(
        select(Research).where(Research.project_id == project_id)
    ).first()
    if row is None:
        return {}
    return {
        "serp": row.serp or [],
        "headings": row.headings or [],
        "paa": row.paa or [],
        "entities": row.entities or [],
        "sources": row.sources or [],
        "intent": row.intent,
    }


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.post("/{project_id}/draft", response_model=DraftOut, status_code=201)
def create_draft(
    project_id: str,
    body: CreateDraftIn | None = None,
    db: Session = Depends(get_db),
) -> Draft:
    """Generate a draft from the latest outline and persist it (FR-7.2).

    Version increments off the project's highest existing draft version so the
    editor keeps full history (PRD §14 ``draft.version``). In review mode an
    optional ``feedback`` steers the regenerate and the ``draft`` checkpoint is
    marked pending for the final human sign-off.
    """
    project = _require_project(project_id, db)
    outline = _latest_outline(project_id, db)
    if outline is None:
        raise HTTPException(
            status_code=409, detail="no outline yet; build an outline first"
        )

    feedback = body.feedback if body else None
    result = generate_draft(
        _outline_payload(outline),
        _brief_from_project(project),
        research=_research_payload(project_id, db),
        feedback=feedback,
    )

    previous = _latest_draft(project_id, db)
    next_version = (previous.version + 1) if previous else 1

    draft = Draft(
        project_id=project.id,
        outline_id=outline.id,
        sections=result["sections"],
        word_count=result["word_count"],
        version=next_version,
    )
    db.add(draft)
    project.stage = "editor"
    # Review-mode gate: draft awaits the final human sign-off (FR-5.5).
    project.checkpoints = touch_stage(project.checkpoints, "draft", feedback=feedback)
    db.commit()
    db.refresh(draft)
    return draft


@router.get("/{project_id}/draft", response_model=DraftOut)
def get_latest_draft(project_id: str, db: Session = Depends(get_db)) -> Draft:
    """Return the project's latest draft version (FR-7.1)."""
    _require_project(project_id, db)
    draft = _latest_draft(project_id, db)
    if draft is None:
        raise HTTPException(status_code=404, detail="no draft yet")
    return draft


@router.put("/{project_id}/draft", response_model=DraftOut)
def update_draft(
    project_id: str, payload: DraftUpdateIn, db: Session = Depends(get_db)
) -> Draft:
    """Save manual edits to the latest draft in place (FR-7.1 editable draft).

    Replaces the section bodies and recomputes the word count, keeping the same
    draft version (it's an edit, not a regeneration).
    """
    _require_project(project_id, db)
    draft = _latest_draft(project_id, db)
    if draft is None:
        raise HTTPException(status_code=404, detail="no draft yet")

    sections = [s.model_dump() for s in payload.sections]
    draft.sections = sections
    draft.word_count = sum(len((s.get("markdown") or "").split()) for s in sections)
    db.add(draft)
    db.commit()
    db.refresh(draft)
    return draft


class ProofreadIn(BaseModel):
    """Request body for the copy-edit pass (FR-7.1)."""

    provider: str = "anthropic"


@router.post("/{project_id}/draft/proofread", response_model=DraftOut)
def proofread_draft(
    project_id: str,
    body: ProofreadIn | None = None,
    db: Session = Depends(get_db),
) -> Draft:
    """Copy-edit the latest draft in place: grammar, clarity, house voice (FR-7.1).

    Conservative — meaning/facts/structure are preserved; a section is only
    replaced when the edit is sane (see :func:`app.article.service.proofread_sections`).
    Persisted on the same draft version (an edit, not a regeneration).
    """
    _require_project(project_id, db)
    draft = _latest_draft(project_id, db)
    if draft is None:
        raise HTTPException(status_code=404, detail="no draft yet")

    provider = (body.provider if body else None) or "anthropic"
    sections = proofread_sections(list(draft.sections or []), provider=provider)
    draft.sections = sections
    draft.word_count = sum(
        len((s.get("markdown") or "").split()) for s in sections
    )
    db.add(draft)
    db.commit()
    db.refresh(draft)
    return draft


@router.post(
    "/{project_id}/draft/regenerate-section", response_model=SectionDiffOut
)
def regenerate_draft_section(
    project_id: str,
    payload: RegenerateSectionIn,
    db: Session = Depends(get_db),
) -> SectionDiffOut:
    """Regenerate one section and return an old-versus-new diff (FR-7.5).

    The regenerated section is written back into the latest draft in place (same
    version) so the editor reflects the change immediately; the response carries
    both the prior and new section for the diff view.
    """
    project = _require_project(project_id, db)
    draft = _latest_draft(project_id, db)
    if draft is None:
        raise HTTPException(status_code=404, detail="no draft yet")

    outline = db.get(Outline, draft.outline_id) if draft.outline_id else None
    if outline is None:
        outline = _latest_outline(project_id, db)

    sections = list(draft.sections or [])
    if payload.section_index >= len(sections):
        raise HTTPException(
            status_code=404,
            detail=f"section_index {payload.section_index} out of range",
        )
    old_section = sections[payload.section_index]

    try:
        new_section = regenerate_section(
            _outline_payload(outline),
            _brief_from_project(project),
            payload.section_index,
            provider=payload.provider,
            research=_research_payload(project_id, db),
            feedback=payload.feedback,
        )
    except IndexError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    # Persist the regenerated section in place (same draft version).
    sections[payload.section_index] = new_section
    draft.sections = sections
    draft.word_count = sum(
        len((s.get("markdown") or "").split()) for s in sections
    )
    db.add(draft)
    db.commit()

    return SectionDiffOut(
        section_index=payload.section_index,
        old=SectionOut(**old_section) if isinstance(old_section, dict) else None,
        new=SectionOut(**new_section),
    )
