"""Credit accounting (PRD §13) — a real per-user balance + an append-only ledger.

Credits are the metering unit shown in the UI. Internally **1 credit ≈ 1 US cent**
of budgeted spend, so the free grant of 500 credits ≈ $5 of runs.

A run is charged an *estimate* up front (so an empty balance blocks the run before
any provider spend), computed from the target length + provider tier. Every
movement is recorded in :class:`~app.models.CreditLedger` with the running balance
for a cheap statement view.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import CreditLedger, Project, User

# Every run costs at least this (covers research + council + scoring overhead).
BASE_RUN_CREDITS = 10
# Extra credits scale with target article length (~10 credits per 1500 words —
# longer drafts mean more tokens across seats + the writer).
CREDITS_PER_WORD = 1 / 150
# When no target length is set, assume a typical article.
DEFAULT_WORDS = 1500

# Monthly credit allowance per plan. Keep in step with frontend/lib/pricing.ts
# (that file drives the marketing display; this drives the actual grants).
PLAN_CREDITS: dict[str, int] = {"free": 500, "pro": 5000, "business": 25000}


def monthly_allowance(plan: str | None) -> int:
    return PLAN_CREDITS.get(plan or "free", PLAN_CREDITS["free"])


def _now_naive() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def estimate_run_credits(project: Project) -> int:
    """Estimated credit cost of running the pipeline for this project."""
    words = project.word_count or DEFAULT_WORDS
    return BASE_RUN_CREDITS + round(words * CREDITS_PER_WORD)


def _record(
    db: Session, user: User, delta: int, reason: str, *,
    project_id: str | None = None, detail: str | None = None,
) -> CreditLedger:
    user.credits = int(user.credits) + delta
    if user.credits < 0:  # never let a race drive the balance negative
        user.credits = 0
    entry = CreditLedger(
        user_id=user.id, delta=delta, balance_after=user.credits,
        reason=reason, project_id=project_id, detail=detail,
    )
    db.add(entry)
    return entry


def grant(db: Session, user: User, credits: int, reason: str, *, detail: str | None = None) -> CreditLedger:
    """Add credits (signup bonus, top-up, refund). Positive delta."""
    return _record(db, user, abs(credits), reason, detail=detail)


def charge(
    db: Session, user: User, credits: int, reason: str, *,
    project_id: str | None = None, detail: str | None = None,
) -> CreditLedger:
    """Deduct credits; raise 402 if the balance can't cover it. Negative delta."""
    if int(user.credits) < credits:
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=(
                f"Not enough credits: this run needs {credits} but you have "
                f"{int(user.credits)}. Top up to continue."
            ),
        )
    return _record(db, user, -abs(credits), reason, project_id=project_id, detail=detail)


def adjust(
    db: Session, user: User, delta: int, reason: str, *, detail: str | None = None
) -> CreditLedger:
    """Admin credit adjustment — a signed delta straight to the ledger.

    Unlike :func:`charge`, this never raises on an overdraw; ``_record`` clamps the
    balance at zero. Use for manual top-ups (positive) or corrections (negative).
    """
    return _record(db, user, delta, reason, detail=detail)


def apply_monthly_refill(db: Session, user: User) -> int:
    """Grant this calendar month's plan allowance if not already granted.

    Idempotent per month (guarded by ``user.credits_refilled_at``): tops the balance
    **up to** the plan allowance so a refill never reduces a higher balance (e.g. an
    admin top-up) and unused credits don't stack past the allowance. Returns the
    credits added (0 if none / already refilled). The caller commits.
    """
    now = _now_naive()
    last = user.credits_refilled_at
    if last is not None and last.year == now.year and last.month == now.month:
        return 0  # already refilled this month — common path, no DB write

    # Fresh month: self-commit here (this fires from read-ish endpoints like
    # /me and login, at most once a month per user) so callers don't have to.
    user.credits_refilled_at = now
    delta = max(0, monthly_allowance(user.plan) - int(user.credits))
    if delta > 0:
        _record(db, user, delta, "monthly", detail=f"{user.plan} monthly refill")
    db.add(user)
    db.commit()
    db.refresh(user)
    return delta


def set_plan(db: Session, user: User, plan: str) -> int:
    """Move a user to ``plan`` and top their balance up to the new allowance now.

    Used by an admin (and, later, a payment webhook). Never reduces the balance;
    resets the monthly clock so the next refill is a full month away. Returns the
    credits added.
    """
    if plan not in PLAN_CREDITS:
        raise HTTPException(status_code=422, detail=f"plan must be one of {list(PLAN_CREDITS)}")
    user.plan = plan
    user.credits_refilled_at = _now_naive()
    delta = max(0, monthly_allowance(plan) - int(user.credits))
    if delta > 0:
        _record(db, user, delta, "plan", detail=f"upgraded to {plan}")
    db.add(user)
    return delta


def ledger_for(db: Session, user: User, limit: int = 50) -> list[CreditLedger]:
    return list(
        db.scalars(
            select(CreditLedger)
            .where(CreditLedger.user_id == user.id)
            .order_by(CreditLedger.created_at.desc())
            .limit(limit)
        )
    )
