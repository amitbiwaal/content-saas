"""Full-pipeline orchestrator (PRD §7), streaming-first.

:func:`stream_full_pipeline` runs a project's brief through the whole engine and
**yields progress events** as each stage completes, persisting every artifact:

    Research → Council (R1/R2/R3 + Judge) → Outline → Article →
    Fact-check → Scores → Publish gate → Compliance → Cost

The SSE endpoint streams these events to the UI (PRD §16 — responses streamed).
:func:`run_full_pipeline` consumes the same generator and returns the final
summary, so the batch ``POST /run`` and the streaming ``GET /run/stream`` share
one code path. Everything runs end-to-end with ZERO API keys (mock seats).

**Human-in-the-loop (gated mode).** With ``gated=True`` the run PAUSES after the
council and after the outline: it persists the stage, marks the checkpoint
``pending`` (awaiting sign-off), emits an ``awaiting_approval`` event and returns
— cleanly ending the stream rather than holding a worker/DB session open while a
human is away. The client approves (``POST /approve``) or rejects with feedback
(``POST /reject``), then reopens ``GET /run/stream?gated=1&from=<stage>``; the
run reloads the already-produced artifacts and resumes from that stage.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.article.service import stream_draft
from app.compliance.house_rules import check as house_rules_check
from app.council import run_council_events
from app.council.roles import DEFAULT_SEATS
from app.factcheck.service import check_draft
from app.models import (
    AgentRun,
    Claim,
    Debate,
    DebateTurn,
    Decision,
    Draft,
    Outline,
    Project,
    Research,
    Score,
    Usage,
)
from app.outline.service import build_outline
from app.providers.registry import estimate_cost_cents
from app.research.service import gather_research
from app.review import touch_stage
from app.scoring import compute_scores, evaluate_gate, top_fixes

# Ordered stage keys the UI stepper renders (PRD §7 pipeline).
STAGES = (
    "research",
    "council",
    "outline",
    "article",
    "factcheck",
    "scoring",
    "gate",
    "compliance",
)

# Human-in-the-loop gates: in gated mode the run pauses after EVERY content step
# for sign-off. Keyed by the pipeline stage that just finished; each entry maps to
# its review-ledger ``checkpoint`` key, the ``next`` stage to resume at on
# approval, and the ``regenerate`` stage to re-run on reject-with-feedback. (The
# "article" stage's checkpoint is "draft" — the two names differ historically.)
_GATES = {
    "research": {"checkpoint": "research", "next": "council", "regenerate": "research"},
    "council": {"checkpoint": "council", "next": "outline", "regenerate": "council"},
    "outline": {"checkpoint": "outline", "next": "article", "regenerate": "outline"},
    "article": {"checkpoint": "draft", "next": "factcheck", "regenerate": "article"},
}


def _ev(event: str, data: dict) -> dict:
    return {"event": event, "data": data}


def _brief(project: Project) -> dict:
    return {
        "topic": project.topic,
        "keyword": project.keyword,
        "country": project.country,
        "audience": project.audience,
        "tone": project.tone,
        "goal": project.goal,
        "article_type": project.article_type,
        "word_count": project.word_count,
    }


def _seat_overrides(project: Project) -> dict[str, str]:
    """Valid role→provider entries from council_config (ignore non-seat keys)."""
    cfg = project.council_config or {}
    return {k: v for k, v in cfg.items() if k in DEFAULT_SEATS and isinstance(v, str)}


def _stage_feedback(project: Project, stage: str) -> str | None:
    """Reject-with-feedback note recorded on a checkpoint, if any."""
    return ((project.checkpoints or {}).get(stage) or {}).get("feedback")


# --------------------------------------------------------------------------- #
# Loaders — reconstruct a prior stage's artifact when a gated run resumes
# --------------------------------------------------------------------------- #
def _research_norm(row: Research) -> dict:
    return {
        "serp": row.serp or [],
        "headings": row.headings or [],
        "paa": row.paa or [],
        "entities": row.entities or [],
        "sources": row.sources or [],
        "intent": row.intent,
        "provider": row.provider,
    }


def _load_research(db: Session, project: Project, brief: dict) -> dict:
    row = db.scalars(
        select(Research)
        .where(Research.project_id == project.id)
        .order_by(Research.created_at.desc())
    ).first()
    return _research_norm(row) if row else gather_research(brief)


def _load_council(db: Session, project: Project) -> dict:
    """Reload the approved council outcome (strategy + decisions + counts)."""
    debate = db.scalars(
        select(Debate)
        .where(Debate.project_id == project.id)
        .order_by(Debate.created_at.desc())
    ).first()
    decisions = list(
        db.scalars(
            select(Decision)
            .where(Decision.project_id == project.id)
            .order_by(Decision.created_at)
        )
    )
    reports = db.scalar(
        select(func.count()).select_from(AgentRun).where(
            AgentRun.project_id == project.id, AgentRun.round == 1
        )
    ) or 0
    tokens = db.scalar(
        select(func.coalesce(func.sum(AgentRun.tokens), 0)).where(
            AgentRun.project_id == project.id
        )
    ) or 0
    return {
        "strategy": (debate.strategy if debate else "") or "",
        "decisions": [
            {"source": d.source, "point": d.point, "label": d.label, "reason": d.reason}
            for d in decisions
        ],
        "conflicts": len(debate.conflicts) if debate and debate.conflicts else 0,
        "reports": int(reports),
        "tokens": int(tokens),
    }


def _load_outline(db: Session, project: Project) -> tuple[dict, Outline | None]:
    row = db.scalars(
        select(Outline)
        .where(Outline.project_id == project.id)
        .order_by(Outline.created_at.desc())
    ).first()
    if not row:
        return {"nodes": [], "elements": [], "schema_hooks": []}, None
    return {"nodes": row.nodes, "elements": row.elements, "schema_hooks": row.schema_hooks}, row


def _load_draft(db: Session, project: Project) -> tuple[dict, Draft | None]:
    row = db.scalars(
        select(Draft)
        .where(Draft.project_id == project.id)
        .order_by(Draft.version.desc(), Draft.created_at.desc())
    ).first()
    if not row:
        return {"sections": [], "word_count": 0}, None
    return {"sections": row.sections or [], "word_count": row.word_count or 0}, row


def stream_full_pipeline(
    db: Session,
    project: Project,
    cancel: threading.Event | None = None,
    *,
    start_stage: str | None = None,
    gated: bool = False,
) -> Iterator[dict]:
    """Run the pipeline, yielding ``{"event", "data"}`` progress events.

    Event types: ``stage`` (``{stage, status, info?}``), ``report`` /
    ``report_delta`` (a council seat's Round-1 output), ``turn`` / ``turn_delta``
    (a live debate turn), ``conflict`` (a real pairwise clash), ``judge`` /
    ``judge_delta`` (the Judge's live deliberation), ``decision`` (a ruling),
    ``section_*`` (the article typing), ``awaiting_approval`` (gated pause) and
    ``done`` (the final summary). Persists each artifact in its own short
    transaction so a mid-run failure or disconnect keeps prior work.

    ``cancel`` stops the run before the next expensive stage (no further spend).
    ``start_stage`` resumes at a stage (prior stages are reloaded from the DB).
    ``gated`` pauses after the council and the outline for human sign-off.
    """
    brief = _brief(project)
    start_idx = STAGES.index(start_stage) if start_stage in STAGES else 0
    total_cost = 0.0

    def _stop() -> bool:
        if cancel is not None and cancel.is_set():
            db.rollback()
            return True
        return False

    # --- 1. Research Intelligence (PRD §9.4, FR-4.5) --------------------- #
    if start_idx <= STAGES.index("research"):
        yield _ev("stage", {"stage": "research", "status": "start"})
        research_norm = gather_research(brief)
        db.add(
            Research(
                project_id=project.id,
                serp=research_norm.get("serp"),
                headings=research_norm.get("headings"),
                paa=research_norm.get("paa"),
                entities=research_norm.get("entities"),
                sources=research_norm.get("sources"),
                intent=research_norm.get("intent"),
                provider=research_norm.get("provider", "mock"),
            )
        )
        db.commit()
        yield _ev(
            "stage",
            {
                "stage": "research",
                "status": "done",
                "info": {
                    "provider": research_norm.get("provider"),
                    "intent": research_norm.get("intent"),
                    "serp_results": len(research_norm.get("serp") or []),
                    "paa": len(research_norm.get("paa") or []),
                    "sources": len(research_norm.get("sources") or []),
                },
            },
        )
        if gated:
            g = _GATES["research"]
            project.checkpoints = touch_stage(project.checkpoints, g["checkpoint"])
            db.commit()
            yield _ev(
                "awaiting_approval",
                {"stage": g["checkpoint"], "next": g["next"], "regenerate": g["regenerate"], "project_id": project.id},
            )
            return
    else:
        research_norm = _load_research(db, project, brief)

    # --- 2. Council debate + Judge (PRD §8), streamed per seat ----------- #
    if start_idx <= STAGES.index("council"):
        if _stop():
            return
        # Fresh council: drop any prior council artifacts (e.g. a rejected run
        # being regenerated) so the Debate Room reflects one clean council.
        db.execute(delete(AgentRun).where(AgentRun.project_id == project.id))
        db.execute(delete(DebateTurn).where(DebateTurn.project_id == project.id))
        db.execute(delete(Debate).where(Debate.project_id == project.id))
        db.execute(delete(Decision).where(Decision.project_id == project.id))

        yield _ev("stage", {"stage": "council", "status": "start"})
        council_brief = {**brief, "research": research_norm}
        feedback = _stage_feedback(project, "council")
        if feedback:
            council_brief["feedback"] = feedback
        council = None
        # Persist the debate as a threaded, replayable transcript (DebateTurn
        # rows): a global sequence for stable ordering + the running max round so
        # the Judge's verdict turn sorts last.
        turn_seq = 0
        max_round = 1

        def _save_turn(**kw) -> None:
            nonlocal turn_seq
            db.add(DebateTurn(project_id=project.id, seq=turn_seq, **kw))
            turn_seq += 1

        for cevent in run_council_events(council_brief, _seat_overrides(project)):
            kind = cevent["type"]
            if kind == "roster":
                yield _ev("roster", {"seats": cevent["seats"]})
            elif kind == "report_start":
                yield _ev(
                    "report_start",
                    {
                        "role": cevent["role"],
                        "provider": cevent["provider"],
                        "model": cevent["model"],
                        "routed_from": cevent["routed_from"],
                    },
                )
            elif kind == "report_delta":
                yield _ev(
                    "report_delta", {"role": cevent["role"], "delta": cevent["delta"]}
                )
            elif kind == "seat_error":
                yield _ev("seat_error", {"role": cevent["role"], "error": cevent["error"]})
            elif kind == "turn_start":
                yield _ev(
                    "turn_start",
                    {
                        "round": cevent["round"],
                        "role": cevent["role"],
                        "provider": cevent["provider"],
                        "addressed_to": cevent["addressed_to"],
                        "stance": cevent["stance"],
                    },
                )
            elif kind == "turn_delta":
                yield _ev(
                    "turn_delta",
                    {"round": cevent["round"], "role": cevent["role"], "delta": cevent["delta"]},
                )
            elif kind == "turn":
                max_round = max(max_round, cevent["round"])
                _save_turn(
                    round=cevent["round"],
                    seat_role=cevent["role"],
                    provider=cevent.get("provider", ""),
                    addressed_to=cevent.get("addressed_to"),
                    stance=cevent.get("stance", "reply"),
                    text=cevent.get("text", ""),
                )
                yield _ev(
                    "turn",
                    {
                        "round": cevent["round"],
                        "role": cevent["role"],
                        "addressed_to": cevent.get("addressed_to"),
                        "stance": cevent.get("stance", "reply"),
                        "text": cevent.get("text", ""),
                    },
                )
            elif kind == "judge_start":
                yield _ev("judge_start", {})
            elif kind == "judge_delta":
                yield _ev("judge_delta", {"delta": cevent["delta"]})
            elif kind == "judge":
                _save_turn(
                    round=max_round + 1,
                    seat_role="judge",
                    stance="verdict",
                    text=cevent.get("text", ""),
                )
                yield _ev("judge", {"text": cevent.get("text", "")})
            elif kind == "report":
                r = cevent["report"]
                run_cost = estimate_cost_cents(r.provider, total_tokens=r.tokens)
                total_cost += run_cost
                db.add(
                    AgentRun(
                        project_id=project.id,
                        role=r.role,
                        provider=r.provider,
                        model=r.model,
                        round=1,
                        output={"recommendations": r.recommendations},
                        confidence=r.confidence,
                        tokens=r.tokens,
                        cost_cents=run_cost,
                    )
                )
                _save_turn(
                    round=1,
                    seat_role=r.role,
                    provider=r.provider,
                    model=r.model,
                    stance="open",
                    text="\n".join(f"• {rec}" for rec in r.recommendations),
                    confidence=r.confidence,
                )
                yield _ev(
                    "report",
                    {
                        "role": r.role,
                        "provider": r.provider,
                        "model": r.model,
                        "confidence": r.confidence,
                        "recommendations": r.recommendations,
                        "routed_from": r.routed_from,
                    },
                )
            elif kind == "conflict":
                yield _ev("conflict", cevent["data"])
            elif kind == "decision":
                d = cevent["decision"]
                db.add(
                    Decision(
                        project_id=project.id,
                        source=d.get("source"),
                        point=d.get("point", ""),
                        label=d.get("label", "manual_review"),
                        reason=d.get("reason"),
                    )
                )
                yield _ev("decision", d)
            elif kind == "done":
                council = cevent["result"]
                db.add(
                    Debate(
                        project_id=project.id,
                        messages=council.debate_messages,
                        conflicts=council.conflicts,
                        strategy=council.strategy_summary,
                    )
                )
        db.commit()
        strategy_summary = council.strategy_summary
        council_decisions = council.decisions
        council_tokens = council.total_tokens
        council_info = {
            "reports": len(council.reports),
            "conflicts": len(council.conflicts),
            "decisions": len(council.decisions),
            "strategy_summary": strategy_summary,
        }
        yield _ev("stage", {"stage": "council", "status": "done", "info": council_info})

        if gated:
            # Pause for human sign-off on the strategy before spending on drafting.
            g = _GATES["council"]
            project.checkpoints = touch_stage(project.checkpoints, g["checkpoint"])
            db.commit()
            yield _ev(
                "awaiting_approval",
                {"stage": g["checkpoint"], "next": g["next"], "regenerate": g["regenerate"], "project_id": project.id},
            )
            return
    else:
        loaded = _load_council(db, project)
        strategy_summary = loaded["strategy"]
        council_decisions = loaded["decisions"]
        council_tokens = loaded["tokens"]
        council_info = {
            "reports": loaded["reports"],
            "conflicts": loaded["conflicts"],
            "decisions": len(loaded["decisions"]),
            "strategy_summary": strategy_summary,
        }

    # --- 3. Outline Builder (PRD §6) ------------------------------------- #
    if start_idx <= STAGES.index("outline"):
        if _stop():
            return
        yield _ev("stage", {"stage": "outline", "status": "start"})
        outline_payload = build_outline(
            strategy_summary,
            council_decisions,
            # Carry the brief's keyword/topic so the outline titles the article
            # after the subject (not the strategy summary) — research_norm itself
            # doesn't include them.
            {**research_norm, "keyword": project.keyword, "topic": project.topic},
            feedback=_stage_feedback(project, "outline"),
            article_type=project.article_type,
            target_words=project.word_count,
        )
        outline_row = Outline(
            project_id=project.id,
            nodes=outline_payload.get("nodes"),
            elements=outline_payload.get("elements"),
            schema_hooks=outline_payload.get("schema_hooks"),
        )
        db.add(outline_row)
        db.commit()
        yield _ev(
            "stage",
            {
                "stage": "outline",
                "status": "done",
                "info": {
                    "nodes": len(outline_payload.get("nodes") or []),
                    "elements": len(outline_payload.get("elements") or []),
                },
            },
        )

        if gated:
            # Pause for human sign-off on the structure before writing the draft.
            g = _GATES["outline"]
            project.checkpoints = touch_stage(project.checkpoints, g["checkpoint"])
            db.commit()
            yield _ev(
                "awaiting_approval",
                {"stage": g["checkpoint"], "next": g["next"], "regenerate": g["regenerate"], "project_id": project.id},
            )
            return
    else:
        outline_payload, outline_row = _load_outline(db, project)

    # --- 4. Article Writer (PRD §7) -------------------------------------- #
    # Stream the draft section-by-section, token-by-token, so the UI shows the
    # article being written live instead of waiting for one blocking call.
    if start_idx <= STAGES.index("article"):
        if _stop():
            return
        yield _ev("stage", {"stage": "article", "status": "start"})
        draft_payload: dict = {"sections": [], "word_count": 0}
        for aev in stream_draft(outline_payload, brief, research=research_norm):
            akind = aev["kind"]
            if akind == "section_start":
                yield _ev(
                    "section_start",
                    {"index": aev["index"], "heading": aev["heading"], "level": aev["level"]},
                )
            elif akind == "section_delta":
                yield _ev(
                    "section_delta", {"index": aev["index"], "delta": aev["delta"]}
                )
            elif akind == "section_done":
                yield _ev(
                    "section_done",
                    {
                        "index": aev["index"],
                        "heading": aev["heading"],
                        "level": aev["level"],
                        "markdown": aev["markdown"],
                    },
                )
            elif akind == "done":
                draft_payload = aev["draft"]
        next_version = (
            db.scalar(
                select(func.coalesce(func.max(Draft.version), 0)).where(
                    Draft.project_id == project.id
                )
            )
            or 0
        ) + 1
        draft_row = Draft(
            project_id=project.id,
            outline_id=outline_row.id if outline_row else None,
            sections=draft_payload.get("sections"),
            word_count=draft_payload.get("word_count", 0),
            version=next_version,
        )
        db.add(draft_row)
        db.commit()
        yield _ev(
            "stage",
            {
                "stage": "article",
                "status": "done",
                "info": {
                    "sections": len(draft_payload.get("sections") or []),
                    "word_count": draft_payload.get("word_count", 0),
                    "version": draft_row.version,
                },
            },
        )

        if gated:
            # Pause for human sign-off on the finished draft before scoring/publish.
            g = _GATES["article"]
            project.checkpoints = touch_stage(project.checkpoints, g["checkpoint"])
            db.commit()
            yield _ev(
                "awaiting_approval",
                {"stage": g["checkpoint"], "next": g["next"], "regenerate": g["regenerate"], "project_id": project.id},
            )
            return
    else:
        draft_payload, draft_row = _load_draft(db, project)

    # --- 5. Fact Checker (PRD §9) ---------------------------------------- #
    yield _ev("stage", {"stage": "factcheck", "status": "start"})
    fact = check_draft(draft_payload, research_norm, use_llm_hint=False)
    for c in fact["claims"]:
        db.add(
            Claim(
                draft_id=draft_row.id,
                text=c.get("text", ""),
                source=c.get("source"),
                confidence=c.get("confidence"),
                risk=c.get("risk", "low"),
                label=c.get("label"),
            )
        )
    yield _ev(
        "stage",
        {
            "stage": "factcheck",
            "status": "done",
            "info": {
                "claims": len(fact["claims"]),
                "high_risk_unsupported": fact["high_risk_unsupported"],
            },
        },
    )

    # --- 6. Scoring (PRD §10) -------------------------------------------- #
    yield _ev("stage", {"stage": "scoring", "status": "start"})
    research_for_score = {**research_norm, "keyword": project.keyword}
    scores = compute_scores(draft_payload, research_for_score, fact["claims"])
    db.add(
        Score(
            draft_id=draft_row.id,
            seo=scores.seo,
            aeo=scores.aeo,
            geo=scores.geo,
            heo=scores.heo,
            eeat=scores.eeat,
            fact=scores.fact,
            spam=scores.spam,
            originality=scores.originality,
            publish=scores.publish,
        )
    )
    fixes = top_fixes(scores)
    yield _ev(
        "stage", {"stage": "scoring", "status": "done", "info": {"scores": scores.as_dict()}}
    )

    # --- 7. Publish gate (PRD §10) --------------------------------------- #
    yield _ev("stage", {"stage": "gate", "status": "start"})
    gate = evaluate_gate(
        scores, high_risk_unsupported_claims=fact["high_risk_unsupported"]
    )
    yield _ev(
        "stage",
        {
            "stage": "gate",
            "status": "done",
            "info": {
                "passed": gate.passed,
                "reasons": gate.reasons,
                "advisories": gate.advisories,
            },
        },
    )

    # --- 8. Compliance / house rules (PRD §11) --------------------------- #
    yield _ev("stage", {"stage": "compliance", "status": "start"})
    compliance_rules = (project.council_config or {}).get("compliance_rules")
    compliance = house_rules_check(draft_payload, compliance_rules)
    yield _ev(
        "stage",
        {
            "stage": "compliance",
            "status": "done",
            "info": {
                "passed": compliance.get("passed", False),
                "violations": len(compliance.get("violations") or []),
            },
        },
    )

    # --- Cost + stage + final summary ------------------------------------ #
    db.add(
        Usage(
            project_id=project.id,
            run_id=draft_row.id,
            tokens=council_tokens,
            cost_cents=round(total_cost, 4),
        )
    )
    ready = gate.passed and compliance.get("passed", False)
    project.stage = "ready" if ready else "editor"
    db.commit()

    yield _ev(
        "done",
        {
            "project_id": project.id,
            "stage": project.stage,
            "ready": ready,
            "research": {
                "provider": research_norm.get("provider"),
                "intent": research_norm.get("intent"),
                "serp_results": len(research_norm.get("serp") or []),
                "paa": len(research_norm.get("paa") or []),
                "sources": len(research_norm.get("sources") or []),
            },
            "council": council_info,
            "outline_id": outline_row.id if outline_row else None,
            "draft": {
                "id": draft_row.id,
                "version": draft_row.version,
                "sections": len(draft_payload.get("sections") or []),
                "word_count": draft_payload.get("word_count", 0),
            },
            "factcheck": {
                "claims": len(fact["claims"]),
                "high_risk_unsupported": fact["high_risk_unsupported"],
            },
            "scores": scores.as_dict(),
            "gate": {
                "passed": gate.passed,
                "reasons": gate.reasons,
                "advisories": gate.advisories,
            },
            "top_fixes": fixes,
            "compliance": {
                "passed": compliance.get("passed", False),
                "violations": len(compliance.get("violations") or []),
            },
            "tokens": council_tokens,
        },
    )


def run_full_pipeline(db: Session, project: Project) -> dict:
    """Run the entire pipeline and return the final summary (batch path).

    Always ungated/from-scratch: consumes :func:`stream_full_pipeline` and returns
    its terminal ``done`` payload, so the persisted artifacts and summary are
    identical to the streaming endpoint.
    """
    summary: dict | None = None
    for event in stream_full_pipeline(db, project):
        if event["event"] == "done":
            summary = event["data"]
    assert summary is not None  # the generator always yields a terminal "done"
    return summary
