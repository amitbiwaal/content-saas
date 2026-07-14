"""Fact Checker API (PRD §9.9, FR-9.1..9.3).

Endpoints (mounted under ``/api/projects`` by the integrator):

* ``POST /{project_id}/factcheck`` — run :func:`check_draft` on the project's
  latest draft, persist a ``Claim`` row per graded claim, and return the claims
  plus the ``high_risk_unsupported`` count. That count is the publish-gate input
  (PRD §10): publish stays blocked while it is > 0.
* ``GET  /{project_id}/claims`` — list persisted claims for the latest draft.

Persistence lives here (in the router, with the Session); the service layer is
kept pure and DB-free so it stays unit-testable.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.factcheck.service import check_draft
from app.models import Claim, Draft, Project, Research

router = APIRouter(prefix="/api/projects", tags=["factcheck"])


# --------------------------------------------------------------------------- #
# Response schemas
# --------------------------------------------------------------------------- #
class ClaimOut(BaseModel):
    """A graded claim row (FR-9.2/9.3)."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    text: str
    source: str | None
    confidence: float | None
    risk: str
    label: str | None


class FactCheckResult(BaseModel):
    """Fact-check run output; ``high_risk_unsupported`` feeds the gate (PRD §10)."""

    draft_id: str
    claims: list[ClaimOut] = Field(default_factory=list)
    high_risk_unsupported: int


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _latest_draft(db: Session, project_id: str) -> Draft:
    """Return the project's newest draft (highest version, then most recent)."""
    draft = db.scalars(
        select(Draft)
        .where(Draft.project_id == project_id)
        .order_by(Draft.version.desc(), Draft.created_at.desc())
    ).first()
    if not draft:
        raise HTTPException(status_code=404, detail="no draft to fact-check")
    return draft


def _latest_research(db: Session, project_id: str) -> dict:
    """Return the project's newest research brief as a plain dict (or empty)."""
    research = db.scalars(
        select(Research)
        .where(Research.project_id == project_id)
        .order_by(Research.created_at.desc())
    ).first()
    if not research:
        return {}
    return {
        "serp": research.serp or [],
        "headings": research.headings or [],
        "paa": research.paa or [],
        "entities": research.entities or [],
        "sources": research.sources or [],
        "intent": research.intent,
    }


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.post("/{project_id}/factcheck", response_model=FactCheckResult)
def run_factcheck(
    project_id: str, db: Session = Depends(get_db)
) -> FactCheckResult:
    """Fact-check the latest draft and persist Claim rows (FR-9.1..9.3)."""
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    draft = _latest_draft(db, project_id)
    if not draft:
        raise HTTPException(status_code=404, detail="no draft to fact-check")
    research = _latest_research(db, project_id)

    # Batch mode: no per-claim LLM calls in the request handler (deterministic,
    # avoids blocking the worker on N sequential provider calls).
    result = check_draft({"sections": draft.sections}, research, use_llm_hint=False)

    # Replace any prior fact-check rows for this draft so re-runs are idempotent.
    for old in list(draft.claims):
        db.delete(old)
    db.flush()

    rows: list[Claim] = []
    for c in result["claims"]:
        row = Claim(
            draft_id=draft.id,
            text=c["text"],
            source=c.get("source"),
            confidence=c.get("confidence"),
            risk=c.get("risk", "low"),
            label=c.get("label"),
        )
        db.add(row)
        rows.append(row)

    db.commit()
    for row in rows:
        db.refresh(row)

    return FactCheckResult(
        draft_id=draft.id,
        claims=[ClaimOut.model_validate(r) for r in rows],
        high_risk_unsupported=result["high_risk_unsupported"],
    )


@router.get("/{project_id}/claims", response_model=list[ClaimOut])
def list_claims(project_id: str, db: Session = Depends(get_db)) -> list[Claim]:
    """List persisted claims for the project's latest draft (FR-9.2)."""
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    draft = _latest_draft(db, project_id)
    return list(
        db.scalars(
            select(Claim)
            .where(Claim.draft_id == draft.id)
            .order_by(Claim.created_at.asc())
        )
    )
