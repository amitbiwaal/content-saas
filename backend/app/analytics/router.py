"""Analytics & cost API (PRD §12, §13)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.analytics.service import portfolio_analytics, project_analytics
from app.db import get_db
from app.security import get_current_user
from app.models import Project

# Signed-in users only.
router = APIRouter(prefix="/api/analytics", tags=["analytics"], dependencies=[Depends(get_current_user)])
@router.get("")
def get_portfolio_analytics(db: Session = Depends(get_db)) -> dict:
    """Portfolio cost + budget + traffic + content-decay alerts (PRD §12/§13)."""
    return portfolio_analytics(db)


@router.get("/projects/{project_id}")
def get_project_analytics(project_id: str, db: Session = Depends(get_db)) -> dict:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project_analytics(db, project)
