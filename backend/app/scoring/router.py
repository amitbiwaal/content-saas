"""Scoring API: compute the eight scores + publish gate + ranked fixes.

PRD §10 (scoring system) and §9.8 / FR-8.1..8.3:

* ``POST /api/projects/{project_id}/scores`` computes the eight scores from the
  project's latest draft + research + claims, persists a :class:`Score` row,
  and returns the scores, the publish-gate verdict (PRD §10) and the ranked
  highest-impact fixes (FR-8.2).
* ``GET /api/projects/{project_id}/scores`` lists the persisted score history
  for the project's latest draft.

Service functions stay pure (see ``app.scoring.service`` / ``optimizer``); all
DB work happens here in the router with the request-scoped ``Session``.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Claim, Draft, Project, Research, Score
from app.scoring.gate import GATE_TARGETS, Scores, evaluate_gate
from app.scoring.optimizer import top_fixes
from app.scoring.service import compute_scores

router = APIRouter(prefix="/api/projects", tags=["scoring"])


# --------------------------------------------------------------------------- #
# Response models (local to this module — schemas.py is owned elsewhere).
# --------------------------------------------------------------------------- #
class ScoresOut(BaseModel):
    """The eight scores (PRD §10, FR-8.1)."""

    model_config = ConfigDict(from_attributes=True)

    seo: float
    aeo: float
    geo: float
    heo: float
    eeat: float
    fact: float
    spam: float
    originality: float = 0.0
    publish: float


class FixOut(BaseModel):
    """One ranked optimisation suggestion (PRD §9.8, FR-8.2)."""

    axis: str
    fix: str
    est_gain: float


class GateOut(BaseModel):
    """Publish-gate verdict (PRD §10 publishing gate)."""

    passed: bool
    reasons: list[str] = Field(default_factory=list)
    # Secondary-axis shortfalls: shown to the editor, never a hard blocker.
    advisories: list[str] = Field(default_factory=list)


class ScoreResult(BaseModel):
    """Full scoring response: scores + gate + ranked fixes (FR-8.1..8.2)."""

    scores: ScoresOut
    gate: GateOut
    top_fixes: list[FixOut] = Field(default_factory=list)
    targets: dict[str, float] = Field(default_factory=lambda: dict(GATE_TARGETS))


class _SectionIn(BaseModel):
    heading: str = ""
    level: int = 2
    markdown: str = ""


class DraftPreviewIn(BaseModel):
    """Unsaved draft content for live re-scoring (FR-7.3) — not persisted."""

    sections: list[_SectionIn] = Field(default_factory=list)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _latest_draft(db: Session, project_id: str) -> Draft | None:
    """Return the project's most recent draft (highest version, else newest)."""
    return db.scalars(
        select(Draft)
        .where(Draft.project_id == project_id)
        .order_by(Draft.version.desc(), Draft.created_at.desc())
    ).first()


def _latest_research(db: Session, project_id: str) -> Research | None:
    return db.scalars(
        select(Research)
        .where(Research.project_id == project_id)
        .order_by(Research.created_at.desc())
    ).first()


def _research_dict(project: Project, research: Research | None) -> dict:
    """Build the research input dict the scorer consumes (keyword + signals)."""
    data: dict = {"keyword": project.keyword, "topic": project.topic}
    if research is not None:
        data["entities"] = research.entities or []
        data["sources"] = research.sources or []
        data["intent"] = research.intent
        data["headings"] = research.headings or []
    return data


def _draft_dict(draft: Draft) -> dict:
    """Build the draft input dict the scorer consumes."""
    return {"sections": draft.sections or [], "word_count": draft.word_count}


def _claims_dicts(db: Session, draft_id: str) -> list[dict]:
    rows = db.scalars(select(Claim).where(Claim.draft_id == draft_id))
    return [
        {
            "text": c.text,
            "source": c.source,
            "confidence": c.confidence,
            "risk": c.risk,
            "label": c.label,
        }
        for c in rows
    ]


def _high_risk_unsupported(claims: list[dict]) -> int:
    """Count high-risk claims that lack a source and were not accepted (§10)."""
    n = 0
    for c in claims:
        if str(c.get("risk") or "").lower() != "high":
            continue
        if c.get("source"):
            continue
        if str(c.get("label") or "").lower() == "accepted":
            continue
        n += 1
    return n


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.post("/{project_id}/scores", response_model=ScoreResult, status_code=201)
def create_scores(project_id: str, db: Session = Depends(get_db)) -> ScoreResult:
    """Score the project's latest draft, persist it, and return the verdict.

    Computes the eight scores (PRD §10) from the latest draft + research +
    claims, persists a :class:`Score` row against that draft, and returns the
    scores, the publish-gate verdict (with high-risk unsupported claims counted
    from the claim records) and the ranked highest-impact fixes (FR-8.2).
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    draft = _latest_draft(db, project_id)
    if not draft:
        raise HTTPException(status_code=409, detail="project has no draft to score")

    research = _latest_research(db, project_id)
    claims = _claims_dicts(db, draft.id)

    scores: Scores = compute_scores(
        _draft_dict(draft), _research_dict(project, research), claims
    )
    verdict = evaluate_gate(
        scores, high_risk_unsupported_claims=_high_risk_unsupported(claims)
    )
    fixes = top_fixes(scores)

    row = Score(draft_id=draft.id, **scores.as_dict())
    db.add(row)
    db.commit()

    return ScoreResult(
        scores=ScoresOut(**scores.as_dict()),
        gate=GateOut(
            passed=verdict.passed,
            reasons=verdict.reasons,
            advisories=verdict.advisories,
        ),
        top_fixes=[FixOut(**f) for f in fixes],
    )


@router.post("/{project_id}/scores/preview", response_model=ScoreResult)
def preview_scores(
    project_id: str, payload: DraftPreviewIn, db: Session = Depends(get_db)
) -> ScoreResult:
    """Score unsaved draft content live without persisting (FR-7.3).

    Powers the editor's live score panel: the client posts the current (possibly
    edited) section bodies on each debounced keystroke and gets back the eight
    scores, gate verdict and ranked fixes — no :class:`Score` row is written.
    Uses the project's latest research + persisted claims as context.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    research = _latest_research(db, project_id)
    draft = _latest_draft(db, project_id)
    claims = _claims_dicts(db, draft.id) if draft else []

    draft_dict = {"sections": [s.model_dump() for s in payload.sections]}
    scores = compute_scores(draft_dict, _research_dict(project, research), claims)
    verdict = evaluate_gate(
        scores, high_risk_unsupported_claims=_high_risk_unsupported(claims)
    )
    return ScoreResult(
        scores=ScoresOut(**scores.as_dict()),
        gate=GateOut(
            passed=verdict.passed,
            reasons=verdict.reasons,
            advisories=verdict.advisories,
        ),
        top_fixes=[FixOut(**f) for f in top_fixes(scores)],
    )


@router.get("/{project_id}/scores", response_model=list[ScoresOut])
def list_scores(project_id: str, db: Session = Depends(get_db)) -> list[Score]:
    """Return the persisted score history for the project's latest draft."""
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    draft = _latest_draft(db, project_id)
    if not draft:
        return []

    return list(
        db.scalars(
            select(Score)
            .where(Score.draft_id == draft.id)
            .order_by(Score.created_at.desc())
        )
    )
