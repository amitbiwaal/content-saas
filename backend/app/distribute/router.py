"""Distribution API (PRD §15) — repurpose an article + publish to social channels.

* ``POST /api/projects/{id}/repurpose/{channel}`` — generate a channel-native post
  (LinkedIn text / Reddit title+body) from the latest draft.
* ``POST /api/projects/{id}/distribute/{channel}`` — publish the (possibly edited)
  content. Real API call when the channel's credentials are set; a ``would_publish``
  dry run otherwise.

Social posts are short teasers derived from the article, so they are NOT held
behind the article publish gate (unlike WordPress live export).
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.distribute.repurpose import repurpose_linkedin, repurpose_reddit
from app.distribute.service import linkedin_publish, reddit_publish
from app.models import Draft, Project

router = APIRouter(prefix="/api/projects", tags=["distribute"])

_CHANNELS = {"linkedin", "reddit"}


class RepurposeIn(BaseModel):
    provider: str = "anthropic"


class DistributeIn(BaseModel):
    text: str | None = None       # linkedin
    title: str | None = None      # reddit
    body: str | None = None       # reddit
    subreddit: str | None = None  # reddit


def _require_project(project_id: str, db: Session) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _latest_draft(project_id: str, db: Session) -> Draft | None:
    return db.scalars(
        select(Draft)
        .where(Draft.project_id == project_id)
        .order_by(Draft.version.desc(), Draft.created_at.desc())
    ).first()


def _brief(project: Project) -> dict:
    return {
        "topic": project.topic,
        "keyword": project.keyword,
        "audience": project.audience,
        "tone": project.tone,
        "goal": project.goal,
    }


@router.post("/{project_id}/repurpose/{channel}")
def repurpose(
    project_id: str, channel: str, body: RepurposeIn | None = None, db: Session = Depends(get_db)
) -> dict:
    """Generate a channel-native post from the latest draft (LinkedIn / Reddit)."""
    if channel not in _CHANNELS:
        raise HTTPException(status_code=404, detail=f"unknown channel: {channel}")
    project = _require_project(project_id, db)
    draft = _latest_draft(project_id, db)
    if draft is None:
        raise HTTPException(status_code=404, detail="no draft yet")

    payload = {"sections": draft.sections or []}
    brief = _brief(project)
    provider = (body.provider if body else None) or "anthropic"
    content = (
        repurpose_linkedin(payload, brief, provider=provider)
        if channel == "linkedin"
        else repurpose_reddit(payload, brief, provider=provider)
    )
    return {"channel": channel, "content": content}


@router.post("/{project_id}/distribute/{channel}")
def distribute(
    project_id: str, channel: str, body: DistributeIn, db: Session = Depends(get_db)
) -> dict:
    """Publish the given content to a channel (live if creds set, else dry run)."""
    if channel not in _CHANNELS:
        raise HTTPException(status_code=404, detail=f"unknown channel: {channel}")
    _require_project(project_id, db)
    settings = get_settings()

    if channel == "linkedin":
        return linkedin_publish(
            {"text": body.text or ""},
            {
                "access_token": settings.linkedin_access_token,
                "author_urn": settings.linkedin_author_urn,
            },
        )
    return reddit_publish(
        {
            "title": body.title or "",
            "body": body.body or "",
            "subreddit": body.subreddit or settings.reddit_default_subreddit,
        },
        {
            "access_token": settings.reddit_access_token,
            "user_agent": settings.reddit_user_agent,
            "subreddit": settings.reddit_default_subreddit,
        },
    )
