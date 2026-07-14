"""Human-in-the-loop review mode (step-by-step content approval).

The auto pipeline (``app.pipeline``) runs every stage back-to-back. Review mode
instead runs one stage at a time and holds each behind a human gate: the editor
inspects Research, Council/Judge, Outline and Draft, then either **approves**
(unlocking the next stage) or **regenerates** with optional feedback.

This package owns the approval-ledger logic (:mod:`app.review.service`) and the
approve/status endpoints (:mod:`app.review.router`). The per-stage generation
still lives in each domain's own router (research/council/outline/article); those
endpoints call :func:`app.review.service.touch_stage` so a (re)generated stage is
marked pending and any now-stale downstream approvals are cleared.
"""

from __future__ import annotations

from app.review.service import (
    GATED_STAGES,
    approve_stage,
    next_stage,
    stage_status,
    touch_stage,
)

__all__ = [
    "GATED_STAGES",
    "approve_stage",
    "next_stage",
    "stage_status",
    "touch_stage",
]
