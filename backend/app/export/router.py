"""Schema & Export API (PRD §9.10, §10 export, FR-10.1..10.4).

* ``GET  /api/projects/{project_id}/export?format=markdown|html|jsonld`` returns
  the rendered export content for the project's latest draft. Markdown/HTML/
  JSON-LD are *previews* and are always allowed regardless of the publish gate.
* ``POST /api/projects/{project_id}/export/wordpress`` performs a (stubbed) live
  export. The publish gate (Score thresholds + high-risk unsupported claims,
  PRD §10) MUST pass before live export; on failure it returns 409 with the gate
  reasons (FR-10.3). The gate is read from the latest persisted :class:`Score`
  and evaluated by :func:`app.scoring.gate.evaluate_gate`.

Service functions in :mod:`app.export.service` stay pure; all DB work (latest
draft/score lookups, claim counting) lives here on the request ``Session``,
matching the projects/article/scoring router pattern.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.db import get_db
from app.export.service import (
    build_jsonld,
    google_doc_export,
    to_docx,
    to_gutenberg,
    to_html,
    to_markdown,
    webhook_publish,
    wordpress_publish,
)
from app.models import Claim, Draft, Project, Score, User, WebhookConfig, WordPressConfig
from app.scoring.gate import Scores, evaluate_gate
from app.security import get_current_user

router = APIRouter(prefix="/api/projects", tags=["export"])


# --------------------------------------------------------------------------- #
# Request/response models (schemas.py is owned elsewhere — keep these local).
# --------------------------------------------------------------------------- #
class WordPressPublishIn(BaseModel):
    """Request body for the WordPress live export (PRD §15, FR-10.2)."""

    creds: dict | None = None          # {site_url, username, app_password}
    schedule: str | None = None        # ISO-8601 datetime -> schedule the post
    seo: dict | None = None            # {focus_keyword, meta_description, title}


class WebhookPublishIn(BaseModel):
    """Request body for the generic (custom-site) live export."""

    status: str | None = None          # draft | publish (overrides the saved default)
    status: str | None = None          # publish | draft | future


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _require_project(project_id: str, db: Session) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _latest_draft(db: Session, project_id: str) -> Draft | None:
    """Return the project's most recent draft (highest version, else newest)."""
    return db.scalars(
        select(Draft)
        .where(Draft.project_id == project_id)
        .order_by(Draft.version.desc(), Draft.created_at.desc())
    ).first()


def _latest_score(db: Session, draft_id: str) -> Score | None:
    return db.scalars(
        select(Score)
        .where(Score.draft_id == draft_id)
        .order_by(Score.created_at.desc())
    ).first()


def _high_risk_unsupported(db: Session, draft_id: str) -> int:
    """Count high-risk claims that lack a source and were not accepted (§10)."""
    rows = db.scalars(select(Claim).where(Claim.draft_id == draft_id))
    n = 0
    for c in rows:
        if str(c.risk or "").lower() != "high":
            continue
        if c.source:
            continue
        if str(c.label or "").lower() == "accepted":
            continue
        n += 1
    return n


def _draft_payload(draft: Draft) -> dict:
    """Build the pure-service draft payload from a Draft row (PRD §14)."""
    return {"sections": draft.sections or [], "word_count": draft.word_count}


def _brief_from_project(project: Project) -> dict:
    return {
        "website": project.website,
        "topic": project.topic,
        "keyword": project.keyword,
        "country": project.country,
        "audience": project.audience,
        "tone": project.tone,
        "goal": project.goal,
    }


def _featured_image(project: Project) -> dict | None:
    """Load the project's featured image (bytes + meta) for WordPress upload."""
    fi = (project.council_config or {}).get("featured_image")
    if not fi:
        return None
    from app.media.router import MEDIA_DIR

    ext = fi.get("ext", "png")
    mime_map = {
        "png": "image/png", "svg": "image/svg+xml",
        "jpg": "image/jpeg", "webp": "image/webp",
    }
    # ``ext`` is user-settable via council_config — whitelist it so it cannot
    # inject path-traversal and read/exfiltrate an arbitrary server file.
    if ext not in mime_map:
        return None
    path = MEDIA_DIR / f"{project.id}.{ext}"
    if not path.exists():
        return None
    mime = mime_map[ext]
    return {
        "bytes": path.read_bytes(),
        "mime": mime,
        "filename": f"{_slug(project.topic)}.{ext}",
        "alt": fi.get("alt"),
    }


def _content_type(project: Project) -> str:
    """Infer the JSON-LD content type from the project's goal/topic (FR-10.1).

    Defaults to ``article``; flags ``review`` when the topic/goal reads like a
    review or comparison so :func:`build_jsonld` emits the Review type.
    """
    haystack = f"{project.topic or ''} {project.goal or ''} {project.keyword or ''}".lower()
    if any(word in haystack for word in ("review", "vs ", "versus", "comparison", "compare")):
        return "review"
    if "faq" in haystack:
        return "faq"
    return "article"


# --------------------------------------------------------------------------- #
# Endpoints
# --------------------------------------------------------------------------- #
def _slug(text: str) -> str:
    import re as _re

    return _re.sub(r"[^a-z0-9]+", "-", (text or "draft").lower()).strip("-") or "draft"


@router.get("/{project_id}/export")
def export_draft(
    project_id: str,
    format: str = Query("markdown", pattern="^(markdown|html|jsonld|docx|gutenberg)$"),
    db: Session = Depends(get_db),
) -> Response:
    """Export the latest draft as markdown / HTML / JSON-LD / DOCX / Gutenberg.

    These are *portable previews* and are always allowed regardless of the publish
    gate (only live-site export is gated, FR-10.3).
    """
    project = _require_project(project_id, db)
    draft = _latest_draft(db, project_id)
    if not draft:
        raise HTTPException(status_code=404, detail="no draft to export")

    payload = _draft_payload(draft)

    if format == "markdown":
        return Response(content=to_markdown(payload), media_type="text/markdown")
    if format == "html":
        return Response(content=to_html(payload, inline_typography=True), media_type="text/html")
    if format == "gutenberg":
        return Response(content=to_gutenberg(payload), media_type="text/html")
    if format == "docx":
        try:
            data = to_docx(payload)
        except NotImplementedError as exc:
            raise HTTPException(status_code=501, detail=str(exc)) from exc
        fname = _slug(project.topic) + ".docx"
        return Response(
            content=data,
            media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            headers={"Content-Disposition": f'attachment; filename="{fname}"'},
        )
    # jsonld
    import json

    data = build_jsonld(_content_type(project), payload, _brief_from_project(project))
    return Response(content=json.dumps(data, indent=2), media_type="application/ld+json")


def _enforce_publish_gate(db: Session, draft: Draft) -> None:
    """Raise 409 (with blocker reasons) unless the draft clears the publish gate.

    Shared by every live-export target (WordPress, custom webhook) so the same
    Score thresholds + no-high-risk-unsupported-claim rule guards all of them.
    """
    score = _latest_score(db, draft.id)
    if score is None:
        raise HTTPException(
            status_code=409,
            detail={
                "passed": False,
                "reasons": ["draft has not been scored; run scoring before live export"],
            },
        )
    scores = Scores(
        seo=score.seo, aeo=score.aeo, geo=score.geo, heo=score.heo,
        eeat=score.eeat, fact=score.fact, spam=score.spam, publish=score.publish,
    )
    verdict = evaluate_gate(
        scores, high_risk_unsupported_claims=_high_risk_unsupported(db, draft.id)
    )
    if not verdict.passed:
        # FR-10.3: block live export and surface every gate blocker.
        raise HTTPException(status_code=409, detail={"passed": False, "reasons": verdict.reasons})


@router.post("/{project_id}/export/wordpress")
def export_to_wordpress(
    project_id: str,
    body: WordPressPublishIn | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Export the latest draft to WordPress (STUB) behind the publish gate (FR-10.2/10.3).

    The publish gate (Score thresholds + no high-risk unsupported claim, PRD §10)
    must pass before live export. If there is no score yet, or the gate fails,
    this returns 409 with the blocking reasons (FR-10.3). On pass it returns the
    would-publish payload from :func:`app.export.service.wordpress_publish` — the
    real WordPress REST call is wired manually later (PRD §15).
    """
    project = _require_project(project_id, db)
    draft = _latest_draft(db, project_id)
    if not draft:
        raise HTTPException(status_code=404, detail="no draft to export")

    _enforce_publish_gate(db, draft)

    # Prefer the current user's saved WordPress connection (PRD §15); fall back to
    # the server-configured defaults; a request body can still override per call.
    if project.owner_id is not None and project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="project not found")
    user_wp = db.scalars(
        select(WordPressConfig).where(WordPressConfig.user_id == user.id)
    ).first()
    settings = get_settings()
    creds = {
        "site_url": (user_wp.site_url if user_wp else settings.wordpress_url),
        "username": (user_wp.username if user_wp else settings.wordpress_username),
        "app_password": (user_wp.app_password if user_wp else settings.wordpress_app_password),
        **((body.creds if body else None) or {}),
    }
    status = (body.status if body else None) or (user_wp.default_status if user_wp else None)
    return wordpress_publish(
        _draft_payload(draft),
        _brief_from_project(project),
        creds,
        schedule=body.schedule if body else None,
        seo=body.seo if body else None,
        status=status,
        featured_image=_featured_image(project),
    )


@router.post("/{project_id}/export/webhook")
def export_to_webhook(
    project_id: str,
    body: WebhookPublishIn | None = None,
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
) -> dict:
    """Publish the latest draft to the user's custom endpoint, behind the gate.

    Same publish gate as WordPress; reads the current user's saved webhook
    connection and POSTs the article as a JSON envelope (dry run if none set).
    """
    project = _require_project(project_id, db)
    draft = _latest_draft(db, project_id)
    if not draft:
        raise HTTPException(status_code=404, detail="no draft to export")
    _enforce_publish_gate(db, draft)
    if project.owner_id is not None and project.owner_id != user.id:
        raise HTTPException(status_code=404, detail="project not found")

    cfg = db.scalars(
        select(WebhookConfig).where(WebhookConfig.user_id == user.id)
    ).first()
    config = {
        "endpoint_url": cfg.endpoint_url if cfg else "",
        "auth_token": cfg.auth_token if cfg else None,
        "default_status": cfg.default_status if cfg else "draft",
    }
    status = (body.status if body else None) or (cfg.default_status if cfg else None)
    return webhook_publish(
        _draft_payload(draft), _brief_from_project(project), config, status=status
    )


@router.post("/{project_id}/export/google-doc")
def export_to_google_doc(project_id: str, db: Session = Depends(get_db)) -> dict:
    """Export the latest draft to a Google Doc for review (PRD §15).

    A review export (not live publish), so it is NOT gated. Uses the configured
    Google OAuth token; without one it returns the doc-ready content (dry run).
    """
    project = _require_project(project_id, db)
    draft = _latest_draft(db, project_id)
    if not draft:
        raise HTTPException(status_code=404, detail="no draft to export")
    token = get_settings().google_oauth_token or None
    return google_doc_export(_draft_payload(draft), _brief_from_project(project), token)
