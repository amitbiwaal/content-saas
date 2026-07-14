"""Integration export tests (PRD §15): Gutenberg, DOCX, WordPress dry-run, Google Doc."""

from app.export.service import (
    google_doc_export,
    to_docx,
    to_gutenberg,
    wordpress_publish,
)

DRAFT = {
    "sections": [
        {"heading": "Quick Verdict", "level": 2, "markdown": "FeetFinder charges a 20 percent fee."},
        {"heading": "Payouts", "level": 3, "markdown": "Payouts take 5 to 7 days.\n\nVerification is mandatory."},
    ],
    "word_count": 14,
}
PROJECT = {"website": "spicyranked.com", "topic": "FeetFinder Review 2026", "keyword": "feetfinder reviews"}


def test_gutenberg_emits_blocks():
    g = to_gutenberg(DRAFT)
    assert "<!-- wp:heading" in g and "<!-- wp:paragraph" in g
    assert "<h2>Quick Verdict</h2>" in g


def test_docx_returns_bytes():
    data = to_docx(DRAFT)
    assert isinstance(data, bytes) and len(data) > 0
    assert data[:2] == b"PK"  # .docx is a zip container


def test_wordpress_dry_run_without_creds():
    out = wordpress_publish(DRAFT, PROJECT, creds=None, seo={"meta_description": "desc"})
    assert out["status"] == "would_publish"
    # SEO field mapping present for RankMath + Yoast.
    meta = out["payload"]["meta"]
    assert meta["rank_math_focus_keyword"] == "feetfinder reviews"
    assert meta["_yoast_wpseo_metadesc"] == "desc"
    # Gutenberg content, not raw HTML article.
    assert "wp:paragraph" in out["payload"]["content"]


def test_wordpress_schedule_sets_future():
    out = wordpress_publish(DRAFT, PROJECT, creds=None, schedule="2030-01-01T09:00:00")
    assert out["payload"]["status"] == "future"
    assert out["payload"]["date"] == "2030-01-01T09:00:00"


def test_google_doc_dry_run_without_token():
    out = google_doc_export(DRAFT, PROJECT, token=None)
    assert out["status"] == "would_create"
    assert "FeetFinder Review 2026" in out["content"]
