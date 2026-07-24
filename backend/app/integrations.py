"""Integrations status (PRD §15).

Reports which integrations are configured so the UI can show what's live vs
dry-run/mock — secrets are never returned, only booleans.
"""

from __future__ import annotations

from fastapi import Depends, APIRouter

from app.config import get_settings
from app.security import get_current_user

# Signed-in users only.
router = APIRouter(prefix="/api/integrations", tags=["integrations"], dependencies=[Depends(get_current_user)])
@router.get("")
def integrations_status() -> dict:
    s = get_settings()

    try:
        import docx  # noqa: F401  (python-docx)

        docx_available = True
    except ImportError:
        docx_available = False

    return {
        "wordpress": {
            "configured": bool(
                s.wordpress_url and s.wordpress_username and s.wordpress_app_password
            ),
            "site_url": s.wordpress_url or None,
        },
        "google_docs": {"configured": bool(s.google_oauth_token)},
        "ahrefs": {
            "configured": bool(s.ahrefs_api_key),
            "active": (s.research_provider or "").strip().lower() == "ahrefs",
        },
        "docx": {"available": docx_available},
        "exports": ["markdown", "html", "jsonld", "gutenberg"]
        + (["docx"] if docx_available else []),
        "ai_providers": {
            p: bool(getattr(s, f"{p}_api_key", "")) for p in ("anthropic", "openai", "google", "xai")
        },
    }
