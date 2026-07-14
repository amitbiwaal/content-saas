"""Service-level tests for Schema & Export (PRD §9.10, §10 export, FR-10.1..10.4).

Pure-function tests over synthetic draft/project dicts: no DB, no TestClient, no
API keys. Cover Markdown/HTML/JSON-LD rendering, the Review content type, the
FAQPage parse-value-only flag (FR-10.4), inline body typography (PRD §11) and the
WordPress publish stub (FR-10.2).
"""

from __future__ import annotations

import json

from app.export.service import (
    BODY_COLOR,
    BODY_FONT_SIZE,
    build_jsonld,
    to_docx,
    to_html,
    to_markdown,
    wordpress_publish,
)

PROJECT = {
    "website": "spicyranked.com",
    "topic": "FeetFinder Review 2026",
    "keyword": "feetfinder reviews",
    "country": "US",
    "audience": "buyers evaluating the platform",
    "tone": "we-not-I",
    "goal": "rank on Google and appear in AI answers",
}

DRAFT = {
    "sections": [
        {"heading": "Quick Verdict", "level": 2, "markdown": "FeetFinder is **legit** for most sellers."},
        {
            "heading": "Fees and Payouts",
            "level": 3,
            "markdown": "The platform takes a 20% fee.\n\nPayouts land in 5 to 7 days.",
        },
        {"heading": "Is FeetFinder safe?", "level": 2, "markdown": "Yes, verification is mandatory."},
    ],
    "word_count": 20,
}


# --------------------------------------------------------------------------- #
# Markdown (FR-10.2)
# --------------------------------------------------------------------------- #
def test_to_markdown_is_non_empty_and_structured():
    md = to_markdown(DRAFT)
    assert md.strip()
    # Title H1 + section headings at their outline levels.
    assert "# FeetFinder Review 2026" in md or md.startswith("#")
    assert "## Quick Verdict" in md
    assert "### Fees and Payouts" in md
    assert "20% fee" in md


# --------------------------------------------------------------------------- #
# HTML (FR-10.2, PRD §11 inline body typography)
# --------------------------------------------------------------------------- #
def test_to_html_non_empty_with_inline_body_typography():
    html = to_html(DRAFT, inline_typography=True)
    assert html.strip()
    assert "<article" in html
    assert "<h2>Quick Verdict</h2>" in html
    assert "<h3>Fees and Payouts</h3>" in html
    # Body locked to 16px / #334155 inline (PRD §11).
    assert f"font-size:{BODY_FONT_SIZE}" in html
    assert f"color:{BODY_COLOR}" in html
    # Inline markdown is rendered and HTML is escaped (no raw ** survives).
    assert "<strong>legit</strong>" in html
    assert "**" not in html


def test_to_html_without_inline_typography_omits_body_style():
    html = to_html(DRAFT, inline_typography=False)
    assert html.strip()
    assert "<article>" in html  # no inline style attribute on the wrapper
    assert f"color:{BODY_COLOR}" not in html


# --------------------------------------------------------------------------- #
# JSON-LD (FR-10.1 / FR-10.4)
# --------------------------------------------------------------------------- #
def test_build_jsonld_article_default():
    data = build_jsonld("article", DRAFT, PROJECT)
    assert data["@type"] == "Article"
    assert data["headline"] == "FeetFinder Review 2026"
    assert data["articleBody"].strip()
    # JSON-LD must be serialisable.
    assert json.loads(json.dumps(data))


def test_build_jsonld_review_uses_review_type():
    data = build_jsonld("review", DRAFT, PROJECT)
    assert data["@type"] == "Review"
    assert data["itemReviewed"]["@type"] == "Thing"
    assert data["reviewBody"].strip()


def test_build_jsonld_faqpage_is_parse_value_only():
    faq_draft = {
        "sections": [
            {"heading": "Is FeetFinder safe?", "level": 2, "markdown": "Yes, verification is required."},
            {"heading": "What is the fee?", "level": 2, "markdown": "The fee is 20%."},
        ],
        "word_count": 10,
    }
    data = build_jsonld("faq", faq_draft, PROJECT)
    assert data["@type"] == "FAQPage"
    # FR-10.4: FAQ schema is parse-value-only, never a SERP rich-result claim.
    assert data["x-contentos-parse-value-only"] is True
    questions = [q["name"] for q in data["mainEntity"]]
    assert "Is FeetFinder safe?" in questions
    assert all(q["acceptedAnswer"]["@type"] == "Answer" for q in data["mainEntity"])


def test_build_jsonld_handles_unknown_type_as_article():
    data = build_jsonld("listicle", DRAFT, PROJECT)
    assert data["@type"] == "Article"


# --------------------------------------------------------------------------- #
# WordPress publish stub (FR-10.2 / PRD §15)
# --------------------------------------------------------------------------- #
def test_wordpress_publish_returns_would_publish_payload():
    result = wordpress_publish(DRAFT, PROJECT, {"site_url": "https://spicyranked.com"})
    assert result["status"] == "would_publish"
    assert result["endpoint"].endswith("/wp-json/wp/v2/posts")
    assert result["payload"]["title"] == "FeetFinder Review 2026"
    # RankMath/Yoast focus keyword mapping (PRD §15).
    assert result["payload"]["meta"]["rank_math_focus_keyword"] == "feetfinder reviews"
    # Stub never auto-publishes.
    assert result["payload"]["status"] == "draft"


def test_wordpress_publish_does_not_leak_secrets():
    result = wordpress_publish(
        DRAFT, PROJECT, {"site_url": "https://x.com", "password": "secret", "token": "abc"}
    )
    blob = json.dumps(result)
    assert "secret" not in blob
    assert "abc" not in blob


# --------------------------------------------------------------------------- #
# DOCX (FR-10.2) — degrade clearly when python-docx is absent.
# --------------------------------------------------------------------------- #
def test_to_docx_returns_bytes_or_raises_clear_error():
    try:
        import docx  # noqa: F401
    except ImportError:
        import pytest

        with pytest.raises(NotImplementedError):
            to_docx(DRAFT)
    else:
        data = to_docx(DRAFT)
        assert isinstance(data, bytes)
        # A .docx is a ZIP container — check the local-file-header magic.
        assert data[:2] == b"PK"


# --------------------------------------------------------------------------- #
# Robustness — empty / odd shapes still export without raising.
# --------------------------------------------------------------------------- #
def test_export_handles_empty_draft():
    empty = {"sections": [], "word_count": 0}
    assert to_markdown(empty).strip()  # at least the title line
    assert "<article" in to_html(empty)
    assert build_jsonld("article", empty, PROJECT)["@type"] == "Article"


def test_sections_accept_bare_list_and_alt_keys():
    bare = [{"title": "Intro", "level": 2, "body": "Hello world."}]
    md = to_markdown(bare)
    assert "## Intro" in md
    assert "Hello world." in md
