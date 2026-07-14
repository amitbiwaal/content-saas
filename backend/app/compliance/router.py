"""House-rules / compliance API (PRD §11).

Endpoint (mounted under ``/api/projects`` by the integrator):

* ``POST /{project_id}/compliance`` — run the deterministic house-rules
  :func:`~app.compliance.house_rules.check` on the project's latest draft and
  return the pass/fail report. This is the HARD GATE before export (PRD §11):
  a non-passing report must block any live export.

Per-website rules (PRD §11, FR-13.3) are configurable: the project's
``council_config`` may carry a ``compliance_rules`` block that overrides the
defaults, and a request body may also pass ad-hoc ``rules`` for a one-off run.

The service layer stays pure and DB-free; the only DB work here is loading the
latest draft via the request-scoped Session (matches the projects/factcheck
router pattern).
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.compliance.house_rules import check
from app.db import get_db
from app.models import Draft, Project

router = APIRouter(prefix="/api/projects", tags=["compliance"])


# --------------------------------------------------------------------------- #
# Schemas
# --------------------------------------------------------------------------- #
class ComplianceRequest(BaseModel):
    """Optional ad-hoc per-website rule overrides for a single run (PRD §11)."""

    model_config = ConfigDict(extra="forbid")

    rules: dict[str, Any] | None = None


class Violation(BaseModel):
    """One failed (or informational) house rule (PRD §11)."""

    rule: str
    detail: str
    locations: list[str] = Field(default_factory=list)


class ComplianceReport(BaseModel):
    """House-rules pass/fail report; the hard export gate (PRD §11)."""

    draft_id: str
    passed: bool
    violations: list[Violation] = Field(default_factory=list)


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
        raise HTTPException(status_code=404, detail="no draft to check")
    return draft


def _project_rules(project: Project) -> dict[str, Any] | None:
    """Pull per-website compliance overrides from ``council_config`` (FR-13.3)."""
    config = project.council_config or {}
    rules = config.get("compliance_rules") if isinstance(config, dict) else None
    return rules if isinstance(rules, dict) else None


# --------------------------------------------------------------------------- #
# Endpoint
# --------------------------------------------------------------------------- #
@router.post("/{project_id}/compliance", response_model=ComplianceReport)
def run_compliance(
    project_id: str,
    payload: ComplianceRequest | None = None,
    db: Session = Depends(get_db),
) -> ComplianceReport:
    """Run house rules on the latest draft and return the pass/fail report.

    Hard gate before export (PRD §11): callers must refuse to export when
    ``passed`` is False. Per-website rules come from the project's
    ``council_config.compliance_rules`` and may be further overridden by the
    request body's ``rules`` for a one-off run.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    draft = _latest_draft(db, project_id)

    rules = _project_rules(project)
    if payload and payload.rules:
        rules = {**(rules or {}), **payload.rules}

    result = check({"sections": draft.sections}, rules)

    return ComplianceReport(
        draft_id=draft.id,
        passed=result["passed"],
        violations=[Violation(**v) for v in result["violations"]],
    )
