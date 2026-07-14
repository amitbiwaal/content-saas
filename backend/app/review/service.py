"""Review-mode approval ledger (pure logic, no DB).

A project's ``checkpoints`` column is an approval ledger keyed by gated stage::

    {
      "research": {"status": "approved", "at": "...", "by": "editor", "feedback": null},
      "council":  {"status": "pending",  "at": "...", "by": null,     "feedback": "broaden scope"},
      ...
    }

``status`` is ``"pending"`` (generated, awaiting human review) or ``"approved"``
(human signed off). A stage absent from the ledger has not been reached yet.

These helpers are **pure**: they take the current ledger dict and return a new
one (never mutate in place, so SQLAlchemy's change detection fires when the
router assigns the result back to ``project.checkpoints``). The router owns all
DB I/O, matching the service/router split used across the app.
"""

from __future__ import annotations

from datetime import datetime, timezone

# The four content stages held behind a human gate, in pipeline order (PRD §7).
# Fact-check / scoring / gate / compliance run automatically after Draft is
# approved, so they are intentionally NOT gated.
GATED_STAGES: tuple[str, ...] = ("research", "council", "outline", "draft")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def touch_stage(
    checkpoints: dict | None, stage: str, *, feedback: str | None = None
) -> dict:
    """Return a new ledger with ``stage`` marked pending review.

    Called whenever a stage's artifact is generated or regenerated. Marks the
    stage ``pending`` (records the regeneration ``feedback`` for audit) and
    **clears every downstream approval**, because a change here makes the outputs
    built on top of it stale — the human must re-approve them.
    """
    ledger = dict(checkpoints or {})
    if stage not in GATED_STAGES:
        return ledger

    ledger[stage] = {
        "status": "pending",
        "at": _now_iso(),
        "by": None,
        "feedback": feedback,
    }
    for downstream in GATED_STAGES[GATED_STAGES.index(stage) + 1:]:
        ledger.pop(downstream, None)
    return ledger


def approve_stage(
    checkpoints: dict | None, stage: str, *, by: str = "editor", note: str | None = None
) -> dict:
    """Return a new ledger with ``stage`` marked approved by ``by``.

    ``note`` is an optional approval comment; when omitted, any feedback recorded
    at generation time is preserved so the audit trail is not lost.
    """
    ledger = dict(checkpoints or {})
    if stage not in GATED_STAGES:
        return ledger

    existing = ledger.get(stage) or {}
    ledger[stage] = {
        "status": "approved",
        "at": _now_iso(),
        "by": by,
        "feedback": note if note is not None else existing.get("feedback"),
    }
    return ledger


def stage_status(checkpoints: dict | None, stage: str) -> str:
    """Return ``"approved"`` | ``"pending"`` | ``"not_started"`` for ``stage``."""
    entry = (checkpoints or {}).get(stage) or {}
    status = entry.get("status")
    return status if status in ("approved", "pending") else "not_started"


def next_stage(checkpoints: dict | None) -> str | None:
    """The first gated stage not yet approved — the human's current step.

    Returns ``None`` when all four gated stages are approved (draft signed off,
    ready for the automatic finalize stages).
    """
    for stage in GATED_STAGES:
        if stage_status(checkpoints, stage) != "approved":
            return stage
    return None
