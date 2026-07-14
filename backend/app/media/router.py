"""Featured-image endpoints (PRD §7 assets).

``POST /api/projects/{id}/image`` generates a 16:9 hero image for the project and
persists a small reference in ``project.council_config['featured_image']`` (the
bytes live on disk under ``backend/media/`` to keep the DB light). ``GET`` streams
the current image. Served under ``/api`` so the Next dev proxy forwards it.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.db import get_db
from app.media.image import build_image_prompt, default_alt, generate_image
from app.models import Project

router = APIRouter(prefix="/api/projects", tags=["media"])

MEDIA_DIR = Path(__file__).resolve().parents[2] / "media"
MEDIA_DIR.mkdir(parents=True, exist_ok=True)

_MIME = {"png": "image/png", "svg": "image/svg+xml", "jpg": "image/jpeg", "webp": "image/webp"}


class ImageIn(BaseModel):
    prompt: str | None = Field(default=None, max_length=2000)  # override auto prompt
    style: str | None = Field(default=None, max_length=500)    # extra style hint
    alt: str | None = Field(default=None, max_length=500)      # override alt text


def _require(project_id: str, db: Session) -> Project:
    project = db.get(Project, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="project not found")
    return project


def _brief(project: Project) -> dict:
    return {
        "topic": project.topic,
        "keyword": project.keyword,
        "audience": project.audience,
        "tone": project.tone,
    }


@router.post("/{project_id}/image")
def generate_featured_image(
    project_id: str, body: ImageIn | None = None, db: Session = Depends(get_db)
) -> dict:
    """Generate (or regenerate) the project's 16:9 featured image."""
    project = _require(project_id, db)
    body = body or ImageIn()

    prompt = (body.prompt or build_image_prompt(_brief(project), body.style or "")).strip()
    data, ext = generate_image(prompt)

    # One image per project — clear any prior extension, then write the new one.
    for old in MEDIA_DIR.glob(f"{project_id}.*"):
        old.unlink(missing_ok=True)
    (MEDIA_DIR / f"{project_id}.{ext}").write_bytes(data)

    cfg = dict(project.council_config or {})
    cfg["featured_image"] = {
        "ext": ext,
        "prompt": prompt,
        "alt": (body.alt or default_alt(_brief(project))),
        "generated": ext == "png",  # png == a real model image; svg == placeholder
    }
    project.council_config = cfg
    db.commit()

    return {
        "url": f"/api/projects/{project_id}/image",
        "ext": ext,
        "prompt": prompt,
        "alt": cfg["featured_image"]["alt"],
        "generated": cfg["featured_image"]["generated"],
    }


@router.get("/{project_id}/image")
def get_featured_image(project_id: str, db: Session = Depends(get_db)) -> Response:
    """Stream the project's current featured image (404 if none yet)."""
    project = _require(project_id, db)
    fi = (project.council_config or {}).get("featured_image")
    if not fi:
        raise HTTPException(status_code=404, detail="no featured image")
    ext = fi.get("ext", "png")
    # ``ext`` comes from user-settable council_config — whitelist it against the
    # known image types so it can never inject path-traversal into the filename.
    if ext not in _MIME:
        raise HTTPException(status_code=404, detail="image file missing")
    path = MEDIA_DIR / f"{project_id}.{ext}"
    if not path.exists():
        raise HTTPException(status_code=404, detail="image file missing")
    return Response(
        content=path.read_bytes(),
        media_type=_MIME.get(ext, "application/octet-stream"),
        headers={"Cache-Control": "no-cache"},
    )
