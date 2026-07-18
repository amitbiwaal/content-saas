"""Projects API + a council run endpoint.

M0 exposes project CRUD (FR-3.1) and a ``/council`` action that runs the
three-round council on the project's brief and persists agent runs, the debate
transcript, and Judge decisions — proving the data model and adapter layer wire
together end-to-end against the mock providers.
"""

from __future__ import annotations

import json
import logging
import re

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.council import run_council
from app.council.roles import DEFAULT_SEATS
from app.db import get_db
from app.models import (
    AgentRun,
    Debate,
    DebateTurn,
    Decision,
    Draft,
    Project,
    Research,
    User,
)
from app.providers import ProviderError, get_adapter
from app.review import touch_stage
from app.schemas import DecisionOut, ProjectCreate, ProjectOut
from app.security import get_current_user

# Every project route requires a logged-in user (all are fetch/XHR calls that
# carry the Bearer token; the SSE stream + <img>/<a> download routes live in other
# routers and handle auth separately). Handlers that need the user object declare
# ``Depends(get_current_user)`` too — FastAPI dedupes it within a request.
router = APIRouter(
    prefix="/api/projects",
    tags=["projects"],
    dependencies=[Depends(get_current_user)],
)
logger = logging.getLogger("contentos.projects")


def owned_project(project_id: str, db: Session, user: User) -> Project:
    """Fetch a project and 404 unless the current user owns it (or it is
    pre-auth/unowned, so legacy rows stay reachable)."""
    project = db.get(Project, project_id)
    if project is None or (project.owner_id is not None and project.owner_id != user.id):
        raise HTTPException(status_code=404, detail="project not found")
    return project

# Valid Judge decision labels (PRD §8.3) — used to validate human overrides.
_DECISION_LABELS = {
    "accepted",
    "rejected",
    "needs_evidence",
    "merge",
    "manual_review",
}


class DecisionUpdate(BaseModel):
    """Human override of a Judge decision (FR-5.5)."""

    label: str
    reason: str | None = None
    overridden_by: str | None = "editor"


class RunCouncilIn(BaseModel):
    """Optional body for a council (re)run in review mode.

    ``feedback`` is an editor instruction the seats must address on the re-run
    (e.g. "the debate ignored pricing — weigh it"); it is woven into every seat's
    prompt and recorded on the review checkpoint.
    """

    feedback: str | None = Field(default=None, max_length=2000)


class MessageIn(BaseModel):
    """A free-text chat message that seeds a content project."""

    message: str = Field(max_length=4000)


class ChatIn(BaseModel):
    """A follow-up chat message about an already-produced project."""

    message: str = Field(max_length=4000)


_STOPWORDS = {
    "a", "an", "the", "for", "to", "of", "in", "on", "and", "or", "with",
    "write", "create", "make", "me", "about", "review", "article", "post",
    "blog", "targeting", "that", "ranks", "rank",
}


def _keyword_from(text: str) -> str:
    """Pick a short keyword phrase from free text (heuristic fallback)."""
    words = [w for w in re.findall(r"[A-Za-z0-9]+", text.lower()) if w not in _STOPWORDS]
    return " ".join(words[:4]) or text.strip()[:60]


def extract_brief(message: str) -> dict:
    """Turn a free-text chat message into a content brief (guided-chat seed).

    Tries the LLM seat first (json_mode) and falls back to a deterministic
    heuristic, so it works with zero API keys (MockAdapter → fallback). When
    real keys are configured this yields a much richer brief.
    """
    system = (
        "Extract a content brief from the user's message. Return STRICT JSON: "
        '{"topic": str, "keyword": str, "website": str, "audience": str, '
        '"tone": str, "goal": str}. Use an empty string for anything not stated.'
    )
    try:
        resp = get_adapter("anthropic").complete(
            system=system, prompt=message, json_mode=True
        )
        data = json.loads(resp.text)
        if isinstance(data, dict) and (data.get("topic") or "").strip():
            return {
                "topic": str(data.get("topic")).strip(),
                "keyword": str(data.get("keyword") or "").strip()
                or _keyword_from(str(data.get("topic"))),
                "website": str(data.get("website") or "").strip() or "unassigned",
                "audience": str(data.get("audience") or "").strip() or None,
                "tone": str(data.get("tone") or "").strip() or None,
                "goal": str(data.get("goal") or "").strip() or None,
            }
    except (ProviderError, json.JSONDecodeError, TypeError, AttributeError):
        pass

    topic = message.strip()
    return {
        "topic": topic[:200] or "Untitled brief",
        "keyword": _keyword_from(topic),
        "website": "unassigned",
        "audience": None,
        "tone": None,
        "goal": None,
    }


@router.post("", response_model=ProjectOut, status_code=201)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Project:
    project = Project(
        owner_id=user.id,
        website=payload.website,
        topic=payload.topic,
        keyword=payload.keyword,
        country=payload.country,
        audience=payload.audience,
        tone=payload.tone,
        goal=payload.goal,
        article_type=payload.article_type,
        word_count=payload.word_count,
        council_config=payload.council_config,
        stage="research",
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.post("/from-message", response_model=ProjectOut, status_code=201)
def create_from_message(
    payload: MessageIn,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Project:
    """Create a project from a free-text chat message (guided chat entry point).

    The first chat turn seeds a content brief; the client then streams the
    pipeline via ``GET /{id}/run/stream``.
    """
    brief = extract_brief(payload.message)
    project = Project(
        owner_id=user.id,
        website=brief["website"],
        topic=brief["topic"],
        keyword=brief["keyword"],
        audience=brief["audience"],
        tone=brief["tone"],
        goal=brief["goal"],
        stage="research",
    )
    db.add(project)
    db.commit()
    db.refresh(project)
    return project


@router.get("", response_model=list[ProjectOut])
def list_projects(
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
) -> list[Project]:
    return list(
        db.scalars(
            select(Project)
            .where(Project.owner_id == user.id)
            .order_by(Project.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    )


@router.get("/{project_id}", response_model=ProjectOut)
def get_project(
    project_id: str,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> Project:
    return owned_project(project_id, db, user)


@router.post("/{project_id}/council", response_model=list[DecisionOut])
def run_project_council(
    project_id: str,
    body: RunCouncilIn | None = None,
    db: Session = Depends(get_db),
) -> list[Decision]:
    """Run (or re-run) the council on the project's brief and persist the outcome.

    Re-running clears the project's prior council artifacts first (agent runs,
    debate, decisions) so the Debate Room reflects a single fresh council, not an
    accumulation (FR-5.5). Uses the latest Research as context when available. In
    review mode an optional ``feedback`` instruction steers the re-run and the
    ``council`` checkpoint is marked pending for human sign-off.
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    # Clean re-run: drop prior council artifacts for this project (FR-5.5).
    db.execute(delete(AgentRun).where(AgentRun.project_id == project_id))
    db.execute(delete(Debate).where(Debate.project_id == project_id))
    db.execute(delete(DebateTurn).where(DebateTurn.project_id == project_id))
    db.execute(delete(Decision).where(Decision.project_id == project_id))

    research = db.scalars(
        select(Research)
        .where(Research.project_id == project_id)
        .order_by(Research.created_at.desc())
    ).first()
    research_payload = (
        {
            "serp": research.serp or [],
            "headings": research.headings or [],
            "paa": research.paa or [],
            "entities": research.entities or [],
            "sources": research.sources or [],
            "intent": research.intent,
        }
        if research
        else {}
    )

    seats = {k: v for k, v in (project.council_config or {}).items() if k in DEFAULT_SEATS and isinstance(v, str)}
    feedback = (body.feedback if body else None) or None
    brief = {
        "topic": project.topic,
        "keyword": project.keyword,
        "country": project.country,
        "audience": project.audience,
        "tone": project.tone,
        "goal": project.goal,
        "research": research_payload,
        "feedback": feedback,
    }

    result = run_council(brief, seats=seats)

    for report in result.reports:
        db.add(
            AgentRun(
                project_id=project.id,
                role=report.role,
                provider=report.provider,
                model=report.model,
                round=1,
                output={"recommendations": report.recommendations},
                confidence=report.confidence,
                tokens=report.tokens,
            )
        )

    db.add(
        Debate(
            project_id=project.id,
            messages=result.debate_messages,
            conflicts=result.conflicts,
        )
    )

    # Threaded transcript: opening positions, then every debate turn, then the
    # Judge's deliberation — one DebateTurn row each, in order (matches the
    # streaming pipeline so both paths replay identically).
    seq = 0
    for report in result.reports:
        db.add(
            DebateTurn(
                project_id=project.id,
                seq=seq,
                round=1,
                seat_role=report.role,
                provider=report.provider,
                model=report.model,
                stance="open",
                text="\n".join(f"• {rec}" for rec in report.recommendations),
                confidence=report.confidence,
            )
        )
        seq += 1
    max_round = 1
    for turn in result.turns:
        max_round = max(max_round, turn.get("round", 2))
        db.add(
            DebateTurn(
                project_id=project.id,
                seq=seq,
                round=turn.get("round", 2),
                seat_role=turn["role"],
                provider=turn.get("provider", ""),
                addressed_to=turn.get("addressed_to"),
                stance=turn.get("stance", "reply"),
                text=turn.get("text", ""),
            )
        )
        seq += 1
    if result.deliberation:
        db.add(
            DebateTurn(
                project_id=project.id,
                seq=seq,
                round=max_round + 1,
                seat_role="judge",
                stance="verdict",
                text=result.deliberation,
            )
        )

    decisions: list[Decision] = []
    for d in result.decisions:
        decision = Decision(
            project_id=project.id,
            source=d.get("source"),
            point=d.get("point", ""),
            label=d.get("label", "manual_review"),
            reason=d.get("reason"),
        )
        db.add(decision)
        decisions.append(decision)

    project.stage = "editor"
    # Review-mode gate: council output awaits human sign-off; clears downstream
    # (outline/draft) approvals so a re-run re-opens the gates below it.
    project.checkpoints = touch_stage(project.checkpoints, "council", feedback=feedback)
    db.commit()
    for d in decisions:
        db.refresh(d)
    return decisions


@router.post("/{project_id}/chat")
def chat_followup(
    project_id: str, payload: ChatIn, db: Session = Depends(get_db)
) -> dict:
    """Follow-up chat about a produced project (PRD §7 conversational editing).

    After the pipeline streams its result, the user can keep chatting about the
    content — asking why a choice was made, requesting an edit, or drafting a
    change. The reply is grounded in the project's own artifacts (latest draft,
    research intent, Judge decisions) and routed through the editor seat. Falls
    back to the deterministic mock when no provider key is set, so it always
    responds (PRD §12).
    """
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")

    message = (payload.message or "").strip()
    if not message:
        raise HTTPException(status_code=422, detail="message is required")

    draft = db.scalars(
        select(Draft)
        .where(Draft.project_id == project_id)
        .order_by(Draft.version.desc(), Draft.created_at.desc())
    ).first()
    research = db.scalars(
        select(Research)
        .where(Research.project_id == project_id)
        .order_by(Research.created_at.desc())
    ).first()
    decisions = list(
        db.scalars(
            select(Decision)
            .where(Decision.project_id == project_id)
            .order_by(Decision.created_at)
        )
    )

    context = [
        f"Topic: {project.topic}",
        f"Primary keyword: {project.keyword}",
        f"Audience: {project.audience or 'general'}",
        f"Tone: {project.tone or 'neutral'}",
        f"Goal: {project.goal or 'n/a'}",
    ]
    if research and research.intent:
        context.append(f"Search intent: {research.intent}")
    if decisions:
        context.append(
            "Judge decisions: "
            + "; ".join(f"{d.point} -> {d.label}" for d in decisions[:6])
        )
    if draft and draft.sections:
        body = "\n\n".join(
            f"## {s.get('heading', '')}\n{s.get('markdown', '')}"
            for s in draft.sections
            if isinstance(s, dict)
        )
        context.append("Article draft:\n" + body[:6000])
    else:
        context.append("No article draft has been generated yet.")

    system = (
        "You are the ContentOS editor assistant. A council of AI models just "
        "researched, debated, drafted and scored the article below. Answer the "
        "user's follow-up about THIS content — explain choices, suggest edits, or "
        "draft requested changes. Be concise, specific and practical; if asked to "
        "rewrite something, return the rewritten text directly.\n\n"
        "--- PROJECT CONTEXT ---\n" + "\n".join(context)
    )
    try:
        resp = get_adapter("anthropic").complete(
            system=system, prompt=message, max_tokens=1500
        )
    except ProviderError as exc:
        # Log the detail server-side; return a stable, non-leaky message.
        logger.warning("chat assistant provider error: %s", exc)
        raise HTTPException(
            status_code=502, detail="assistant temporarily unavailable"
        ) from exc

    return {"reply": (resp.text or "").strip() or "(no response)"}


@router.get("/{project_id}/decisions", response_model=list[DecisionOut])
def list_decisions(project_id: str, db: Session = Depends(get_db)) -> list[Decision]:
    """Judge decisions for the project — feeds the Debate Room (PRD §5.3)."""
    if not db.get(Project, project_id):
        raise HTTPException(status_code=404, detail="project not found")
    return list(
        db.scalars(
            select(Decision)
            .where(Decision.project_id == project_id)
            .order_by(Decision.created_at)
        )
    )


@router.get("/{project_id}/debate")
def get_debate(project_id: str, db: Session = Depends(get_db)) -> dict:
    """Latest debate transcript + the agent reports (PRD §5.1/5.2).

    ``turns`` is the threaded, replayable transcript (openings → pairwise
    rebuttals/replies → Judge deliberation), ordered by ``seq`` so a client that
    reloads mid/after a run can re-render the whole debate. ``messages`` /
    ``conflicts`` remain for back-compat.
    """
    if not db.get(Project, project_id):
        raise HTTPException(status_code=404, detail="project not found")
    debate = db.scalars(
        select(Debate)
        .where(Debate.project_id == project_id)
        .order_by(Debate.created_at.desc())
    ).first()
    runs = list(
        db.scalars(
            select(AgentRun)
            .where(AgentRun.project_id == project_id)
            .order_by(AgentRun.created_at)
        )
    )
    turns = list(
        db.scalars(
            select(DebateTurn)
            .where(DebateTurn.project_id == project_id)
            .order_by(DebateTurn.seq)
        )
    )
    return {
        "messages": debate.messages if debate else [],
        "conflicts": debate.conflicts if debate else [],
        "turns": [
            {
                "round": t.round,
                "role": t.seat_role,
                "provider": t.provider,
                "addressed_to": t.addressed_to,
                "stance": t.stance,
                "text": t.text,
                "confidence": t.confidence,
            }
            for t in turns
        ],
        "reports": [
            {
                "role": r.role,
                "provider": r.provider,
                "model": r.model,
                "confidence": r.confidence,
                "recommendations": (r.output or {}).get("recommendations", []),
            }
            for r in runs
        ],
    }


@router.patch("/{project_id}/decisions/{decision_id}", response_model=DecisionOut)
def override_decision(
    project_id: str,
    decision_id: str,
    payload: DecisionUpdate,
    db: Session = Depends(get_db),
) -> Decision:
    """Human override of a Judge decision's label (FR-5.5).

    Records who overrode it so the audit log shows the human in the loop
    (PRD §16 audit of decisions).
    """
    if payload.label not in _DECISION_LABELS:
        raise HTTPException(
            status_code=422,
            detail=f"label must be one of {sorted(_DECISION_LABELS)}",
        )
    decision = db.get(Decision, decision_id)
    if not decision or decision.project_id != project_id:
        raise HTTPException(status_code=404, detail="decision not found")

    decision.label = payload.label
    if payload.reason is not None:
        decision.reason = payload.reason
    decision.overridden_by = payload.overridden_by or "editor"
    db.add(decision)
    db.commit()
    db.refresh(decision)
    return decision
