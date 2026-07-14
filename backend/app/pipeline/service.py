"""Full-pipeline orchestrator (PRD §7), streaming-first.

:func:`stream_full_pipeline` runs a project's brief through the whole engine and
**yields progress events** as each stage completes, persisting every artifact:

    Research → Council (R1/R2/R3 + Judge) → Outline → Article →
    Fact-check → Scores → Publish gate → Compliance → Cost

The SSE endpoint streams these events to the UI (PRD §16 — responses streamed).
:func:`run_full_pipeline` consumes the same generator and returns the final
summary, so the batch ``POST /run`` and the streaming ``GET /run/stream`` share
one code path. Everything runs end-to-end with ZERO API keys (mock seats).
"""

from __future__ import annotations

import threading
from collections.abc import Iterator

from sqlalchemy import func, select
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
    }


def _seat_overrides(project: Project) -> dict[str, str]:
    """Valid role→provider entries from council_config (ignore non-seat keys)."""
    cfg = project.council_config or {}
    return {k: v for k, v in cfg.items() if k in DEFAULT_SEATS and isinstance(v, str)}


def stream_full_pipeline(
    db: Session, project: Project, cancel: threading.Event | None = None
) -> Iterator[dict]:
    """Run the whole pipeline, yielding ``{"event", "data"}`` progress events.

    Event types: ``stage`` (``{stage, status, info?}``), ``report`` (a council
    seat's Round-1 output), ``conflict`` (a surfaced Round-2 conflict),
    ``decision`` (a Judge ruling), and ``done`` (the final summary). Persists
    each artifact in its own short transaction (so a mid-run failure or client
    disconnect keeps prior work and never holds a write lock across LLM calls).

    ``cancel`` is an optional :class:`threading.Event`; when set (e.g. the SSE
    client disconnected) the pipeline stops before the next expensive stage so
    no further provider spend is incurred.
    """
    brief = _brief(project)

    def _stop() -> bool:
        if cancel is not None and cancel.is_set():
            db.rollback()
            return True
        return False

    # --- 1. Research Intelligence (PRD §9.4, FR-4.5) --------------------- #
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

    # --- 2. Council debate + Judge (PRD §8), streamed per seat ----------- #
    if _stop():
        return
    yield _ev("stage", {"stage": "council", "status": "start"})
    council_brief = {**brief, "research": research_norm}
    council = None
    total_cost = 0.0
    for cevent in run_council_events(council_brief, _seat_overrides(project)):
        kind = cevent["type"]
        if kind == "roster":
            yield _ev("roster", {"seats": cevent["seats"]})
        elif kind == "report_start":
            # A seat picked its provider and began — forward so the UI opens a
            # live "typing" box before the first token arrives.
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
            # A single token/chunk from a seat, streamed live (PRD §16).
            yield _ev(
                "report_delta", {"role": cevent["role"], "delta": cevent["delta"]}
            )
        elif kind == "seat_error":
            yield _ev("seat_error", {"role": cevent["role"], "error": cevent["error"]})
        elif kind == "critique_start":
            # Round 2 — a seat began its live rebuttal of the others.
            yield _ev("critique_start", {"role": cevent["role"]})
        elif kind == "critique_delta":
            yield _ev("critique_delta", {"role": cevent["role"], "delta": cevent["delta"]})
        elif kind == "critique":
            yield _ev("critique", {"role": cevent["role"], "text": cevent["text"]})
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
                )
            )
    db.commit()
    yield _ev(
        "stage",
        {
            "stage": "council",
            "status": "done",
            "info": {
                "reports": len(council.reports),
                "conflicts": len(council.conflicts),
                "decisions": len(council.decisions),
                "strategy_summary": council.strategy_summary,
            },
        },
    )

    # --- 3. Outline Builder (PRD §6) ------------------------------------- #
    yield _ev("stage", {"stage": "outline", "status": "start"})
    outline_payload = build_outline(
        council.strategy_summary, council.decisions, research_norm
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

    # --- 4. Article Writer (PRD §7) -------------------------------------- #
    # Stream the draft section-by-section, token-by-token, so the UI shows the
    # article being written live instead of waiting for one blocking call.
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
        outline_id=outline_row.id,
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
            tokens=council.total_tokens,
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
            "council": {
                "reports": len(council.reports),
                "conflicts": len(council.conflicts),
                "decisions": len(council.decisions),
                "strategy_summary": council.strategy_summary,
            },
            "outline_id": outline_row.id,
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
            "tokens": council.total_tokens,
        },
    )


def run_full_pipeline(db: Session, project: Project) -> dict:
    """Run the entire pipeline and return the final summary (batch path).

    Consumes :func:`stream_full_pipeline` and returns its terminal ``done``
    payload, so the persisted artifacts and summary are identical to the
    streaming endpoint.
    """
    summary: dict | None = None
    for event in stream_full_pipeline(db, project):
        if event["event"] == "done":
            summary = event["data"]
    assert summary is not None  # the generator always yields a terminal "done"
    return summary
