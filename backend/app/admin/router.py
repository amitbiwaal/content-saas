"""Admin endpoints (all behind :func:`app.security.require_admin`).

* ``GET    /api/admin/stats``              — platform totals for the dashboard.
* ``GET    /api/admin/users``              — paginated, searchable, sortable list.
* ``GET    /api/admin/users/{id}``         — one user + their projects + ledger.
* ``GET    /api/admin/projects``           — recent projects across all accounts.
* ``POST   /api/admin/users/{id}/credits`` — manual credit top-up / correction.
* ``POST   /api/admin/users/{id}/admin``   — promote / demote an account.
* ``POST   /api/admin/users/{id}/suspend`` — suspend / reactivate an account.
* ``DELETE /api/admin/users/{id}``         — delete an account and all its work.

Credit movements go through :mod:`app.credits` so the ledger stays the single
source of truth; the service/router split matches the rest of the app.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app import credits as credits_mod
from app.db import get_db
from app.models import CreditLedger, Project, Run, User
from app.security import require_admin, user_is_admin

# require_admin gates the whole router; handlers that need the caller's identity
# re-declare it as a param (FastAPI caches it within the request, so it runs once).
router = APIRouter(
    prefix="/api/admin", tags=["admin"], dependencies=[Depends(require_admin)]
)

# User columns that can be sorted on at the DB level (plus "projects", computed).
_SORTABLE = {
    "joined": User.created_at,
    "credits": User.credits,
    "email": User.email,
    "name": User.name,
}


def _utcnow_naive() -> datetime:
    # created_at is stored tz-naive (UTC); compare against a naive UTC value.
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _iso(dt: datetime | None) -> str:
    return dt.isoformat() if dt else ""


# --------------------------------------------------------------------------- #
# Wire models
# --------------------------------------------------------------------------- #
class StatsOut(BaseModel):
    users_total: int
    users_admins: int
    users_suspended: int
    users_new_7d: int
    projects_total: int
    projects_by_stage: dict[str, int]
    runs_total: int
    runs_by_status: dict[str, int]
    credits_granted: int
    credits_spent: int
    credits_outstanding: int


class AdminUser(BaseModel):
    id: str
    email: str
    name: str | None
    credits: int
    plan: str
    is_admin: bool          # persisted flag
    effective_admin: bool   # flag OR ADMIN_EMAILS allow-list
    is_active: bool
    projects: int
    created_at: str


class UsersOut(BaseModel):
    total: int
    limit: int
    offset: int
    users: list[AdminUser]


class AdminProject(BaseModel):
    id: str
    topic: str
    keyword: str
    stage: str
    created_at: str
    owner_id: str | None = None
    owner_email: str | None = None


class LedgerEntry(BaseModel):
    delta: int
    balance_after: int
    reason: str
    detail: str | None
    project_id: str | None
    created_at: str


class UserDetail(BaseModel):
    user: AdminUser
    projects: list[AdminProject]
    ledger: list[LedgerEntry]


class CreditIn(BaseModel):
    # Signed: positive tops up, negative corrects down (never below zero).
    delta: int = Field(..., ge=-1_000_000, le=1_000_000)
    reason: str | None = Field(default=None, max_length=200)


class AdminIn(BaseModel):
    is_admin: bool


class SuspendIn(BaseModel):
    active: bool  # True = reactivate, False = suspend


class PlanIn(BaseModel):
    plan: str  # free | pro | business (validated in credits.set_plan)


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _project_count(db: Session, user_id: str) -> int:
    return db.scalar(
        select(func.count()).select_from(Project).where(Project.owner_id == user_id)
    ) or 0


def _admin_user(db: Session, u: User, projects: int | None = None) -> AdminUser:
    return AdminUser(
        id=u.id,
        email=u.email,
        name=u.name,
        credits=int(u.credits),
        plan=u.plan,
        is_admin=bool(u.is_admin),
        effective_admin=user_is_admin(u),
        is_active=bool(u.is_active),
        projects=_project_count(db, u.id) if projects is None else projects,
        created_at=_iso(u.created_at),
    )


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
@router.get("/stats", response_model=StatsOut)
def stats(db: Session = Depends(get_db)) -> StatsOut:
    """Platform totals — users, projects, runs and credit flow."""
    users_total = db.scalar(select(func.count()).select_from(User)) or 0
    users_admins = db.scalar(
        select(func.count()).select_from(User).where(User.is_admin.is_(True))
    ) or 0
    users_suspended = db.scalar(
        select(func.count()).select_from(User).where(User.is_active.is_(False))
    ) or 0
    users_new_7d = db.scalar(
        select(func.count())
        .select_from(User)
        .where(User.created_at >= _utcnow_naive() - timedelta(days=7))
    ) or 0

    projects_total = db.scalar(select(func.count()).select_from(Project)) or 0
    by_stage = dict(
        db.execute(select(Project.stage, func.count()).group_by(Project.stage)).all()
    )
    runs_total = db.scalar(select(func.count()).select_from(Run)) or 0
    by_status = dict(
        db.execute(select(Run.status, func.count()).group_by(Run.status)).all()
    )

    granted = db.scalar(
        select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(CreditLedger.delta > 0)
    ) or 0
    spent = db.scalar(
        select(func.coalesce(func.sum(CreditLedger.delta), 0)).where(CreditLedger.delta < 0)
    ) or 0
    outstanding = db.scalar(select(func.coalesce(func.sum(User.credits), 0))) or 0

    return StatsOut(
        users_total=users_total,
        users_admins=users_admins,
        users_suspended=users_suspended,
        users_new_7d=users_new_7d,
        projects_total=projects_total,
        projects_by_stage={str(k): int(v) for k, v in by_stage.items()},
        runs_total=runs_total,
        runs_by_status={str(k): int(v) for k, v in by_status.items()},
        credits_granted=int(granted),
        credits_spent=int(-spent),  # report spend as a positive figure
        credits_outstanding=int(outstanding),
    )


@router.get("/users", response_model=UsersOut)
def list_users(
    q: str | None = None,
    sort: str = "joined",
    order: str = "desc",
    limit: int = 50,
    offset: int = 0,
    db: Session = Depends(get_db),
) -> UsersOut:
    """Searchable, sortable, paginated user list.

    ``sort`` is one of joined | credits | email | name | projects; ``order`` is
    asc | desc. Project counts come from an inline grouped subquery, so sorting by
    project count (and returning the count) needs no extra round-trip.
    """
    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    # Inline per-user project count (left join so zero-project users still appear).
    pc = (
        select(Project.owner_id.label("oid"), func.count().label("cnt"))
        .group_by(Project.owner_id)
        .subquery()
    )
    pcount = func.coalesce(pc.c.cnt, 0)

    stmt = select(User, pcount.label("pcount")).outerjoin(pc, User.id == pc.c.oid)
    count_stmt = select(func.count()).select_from(User)
    if q and q.strip():
        like = f"%{q.strip().lower()}%"
        cond = or_(
            func.lower(User.email).like(like),
            func.lower(func.coalesce(User.name, "")).like(like),
        )
        stmt = stmt.where(cond)
        count_stmt = count_stmt.where(cond)

    col = pcount if sort == "projects" else _SORTABLE.get(sort, User.created_at)
    stmt = stmt.order_by(col.asc() if order == "asc" else col.desc())

    total = db.scalar(count_stmt) or 0
    rows = db.execute(stmt.limit(limit).offset(offset)).all()
    users = [_admin_user(db, u, projects=int(cnt)) for (u, cnt) in rows]
    return UsersOut(total=int(total), limit=limit, offset=offset, users=users)


@router.get("/users/{user_id}", response_model=UserDetail)
def get_user(user_id: str, db: Session = Depends(get_db)) -> UserDetail:
    """One account with its projects and recent credit movements."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    projects = db.scalars(
        select(Project)
        .where(Project.owner_id == user.id)
        .order_by(Project.created_at.desc())
    ).all()
    ledger = db.scalars(
        select(CreditLedger)
        .where(CreditLedger.user_id == user.id)
        .order_by(CreditLedger.created_at.desc())
        .limit(30)
    ).all()

    return UserDetail(
        user=_admin_user(db, user, projects=len(projects)),
        projects=[
            AdminProject(
                id=p.id,
                topic=p.topic,
                keyword=p.keyword,
                stage=p.stage,
                created_at=_iso(p.created_at),
                owner_id=p.owner_id,
            )
            for p in projects
        ],
        ledger=[
            LedgerEntry(
                delta=e.delta,
                balance_after=e.balance_after,
                reason=e.reason,
                detail=e.detail,
                project_id=e.project_id,
                created_at=_iso(e.created_at),
            )
            for e in ledger
        ],
    )


@router.get("/projects", response_model=list[AdminProject])
def recent_projects(limit: int = 15, db: Session = Depends(get_db)) -> list[AdminProject]:
    """Newest projects across every account, with the owner's email."""
    limit = max(1, min(limit, 100))
    rows = db.execute(
        select(Project, User.email)
        .outerjoin(User, Project.owner_id == User.id)
        .order_by(Project.created_at.desc())
        .limit(limit)
    ).all()
    return [
        AdminProject(
            id=p.id,
            topic=p.topic,
            keyword=p.keyword,
            stage=p.stage,
            created_at=_iso(p.created_at),
            owner_id=p.owner_id,
            owner_email=email,
        )
        for (p, email) in rows
    ]


@router.post("/users/{user_id}/credits", response_model=AdminUser)
def set_credits(
    user_id: str,
    payload: CreditIn,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUser:
    """Apply a signed credit adjustment; records it in the user's ledger."""
    if payload.delta == 0:
        raise HTTPException(status_code=422, detail="delta must be non-zero")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    note = (payload.reason or "").strip() or f"admin adjustment by {admin.email}"
    credits_mod.adjust(db, user, payload.delta, "admin", detail=note)
    db.add(user)
    db.commit()
    db.refresh(user)
    return _admin_user(db, user)


@router.post("/users/{user_id}/admin", response_model=AdminUser)
def set_admin(
    user_id: str,
    payload: AdminIn,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUser:
    """Promote or demote an account. You cannot demote yourself (lock-out guard)."""
    if user_id == admin.id and not payload.is_admin:
        raise HTTPException(
            status_code=400, detail="You cannot remove your own admin access."
        )
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    user.is_admin = payload.is_admin
    db.add(user)
    db.commit()
    db.refresh(user)
    return _admin_user(db, user)


@router.post("/users/{user_id}/plan", response_model=AdminUser)
def set_user_plan(
    user_id: str,
    payload: PlanIn,
    db: Session = Depends(get_db),
) -> AdminUser:
    """Change a user's plan and top their balance up to the new allowance now."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")
    credits_mod.set_plan(db, user, payload.plan)  # 422 on an unknown plan
    db.commit()
    db.refresh(user)
    return _admin_user(db, user)


@router.post("/users/{user_id}/suspend", response_model=AdminUser)
def set_suspended(
    user_id: str,
    payload: SuspendIn,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUser:
    """Suspend (block login) or reactivate an account. Not yourself."""
    if user_id == admin.id and not payload.active:
        raise HTTPException(
            status_code=400, detail="You cannot suspend your own account."
        )
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    user.is_active = payload.active
    db.add(user)
    db.commit()
    db.refresh(user)
    return _admin_user(db, user)


@router.delete("/users/{user_id}")
def delete_user(
    user_id: str,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Delete an account and everything it owns (projects cascade). Not yourself."""
    if user_id == admin.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account.")
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="user not found")

    # Projects aren't cascade-deleted from the user side, so remove them first
    # (each Project cascades to its own research/debate/draft/run children); the
    # user's ledger + WordPress config cascade on the user delete itself.
    owned = db.scalars(select(Project).where(Project.owner_id == user.id)).all()
    removed_projects = len(owned)
    for p in owned:
        db.delete(p)
    email = user.email
    db.delete(user)
    db.commit()
    return {"deleted": True, "email": email, "projects_removed": removed_projects}
