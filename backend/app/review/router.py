"""Review-mode endpoints: human approval gate + status (step-by-step flow).

* ``POST /api/projects/{project_id}/approve`` — the editor signs off on a gated
  stage (research | council | outline | draft), unlocking the next one.
* ``GET  /api/projects/{project_id}/checkpoints`` — the approval ledger plus the
  computed ``next`` stage the human is currently on, so the UI can render the
  step-by-step progress without recomputing gate order client-side.

Per-stage *generation* stays in each domain router; those call
:func:`app.review.service.touch_stage` when they (re)produce an artifact.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app.security import require_project_access
from app.models import Project
from app.review.service import GATED_STAGES, approve_stage, next_stage, touch_stage

# Owner-only: every route is project-scoped model work/artifacts.
router = APIRouter(prefix="/api/projects", tags=["review"], dependencies=[Depends(require_project_access)])
class ApproveIn(BaseModel):
    """Editor sign-off on a gated stage (human-in-the-loop, PRD §9.5 override)."""

    stage: str
    by: str = "editor"
    # Optional approval note; kept in the audit ledger.
    note: str | None = Field(default=None, max_length=2000)


class RejectIn(BaseModel):
    """Editor rejection of a gated stage → regenerate it with feedback.

    Marks the stage pending again (recording the feedback for the regenerate) and
    clears every downstream approval. The client then reopens the gated stream
    with ``from=<stage>`` to rebuild that stage; the pipeline reads this feedback
    and weaves it into the regeneration.
    """

    stage: str
    feedback: str | None = Field(default=None, max_length=2000)


class CheckpointsOut(BaseModel):
    """The approval ledger + the human's current step."""

    checkpoints: dict
    next: str | None
    gated_stages: list[str] = Field(default_factory=lambda: list(GATED_STAGES))


@router.post("/{project_id}/approve", response_model=CheckpointsOut)
def approve(
    project_id: str, payload: ApproveIn, db: Session = Depends(get_db)
) -> CheckpointsOut:
    """Approve a gated stage; returns the updated ledger and next step."""
    if payload.stage not in GATED_STAGES:
        raise HTTPException(
            status_code=422,
            detail=f"stage must be one of {list(GATED_STAGES)}",
        )
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    project.checkpoints = approve_stage(
        project.checkpoints, payload.stage, by=payload.by, note=payload.note
    )
    # Reflect the human sign-off in the coarse project stage too, so lists/badges
    # that read ``project.stage`` show progress without loading the ledger.
    _sync_stage(project)
    db.add(project)
    db.commit()
    db.refresh(project)
    return CheckpointsOut(
        checkpoints=project.checkpoints or {}, next=next_stage(project.checkpoints)
    )


@router.post("/{project_id}/reject", response_model=CheckpointsOut)
def reject(
    project_id: str, payload: RejectIn, db: Session = Depends(get_db)
) -> CheckpointsOut:
    """Reject a gated stage and queue it for regeneration with feedback."""
    if payload.stage not in GATED_STAGES:
        raise HTTPException(
            status_code=422, detail=f"stage must be one of {list(GATED_STAGES)}"
        )
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    project.checkpoints = touch_stage(
        project.checkpoints, payload.stage, feedback=payload.feedback
    )
    _sync_stage(project)
    db.add(project)
    db.commit()
    db.refresh(project)
    return CheckpointsOut(
        checkpoints=project.checkpoints or {}, next=next_stage(project.checkpoints)
    )


@router.get("/{project_id}/checkpoints", response_model=CheckpointsOut)
def get_checkpoints(project_id: str, db: Session = Depends(get_db)) -> CheckpointsOut:
    """Return the project's approval ledger and current step."""
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return CheckpointsOut(
        checkpoints=project.checkpoints or {}, next=next_stage(project.checkpoints)
    )


def _sync_stage(project: Project) -> None:
    """Map the approval ledger onto the coarse ``project.stage`` label."""
    nxt = next_stage(project.checkpoints)
    if nxt is None:  # all four gated stages approved
        project.stage = "editor"
    elif nxt == "research":
        project.stage = "research"
    elif nxt == "council":
        project.stage = "council"
    else:  # outline / draft pending
        project.stage = "editor"
