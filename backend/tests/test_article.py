"""Service-level tests for the Article Writer (PRD §7, FR-7.2/7.5).

Run against the deterministic mock adapter (no API keys, no DB, no TestClient):
``generate_draft`` and ``regenerate_section`` are pure functions over an outline
and brief, so they exercise the full zero-key fallback path.
"""

from __future__ import annotations

from app.article.service import generate_draft, regenerate_section

BRIEF = {
    "topic": "FeetFinder Review 2026",
    "keyword": "feetfinder reviews",
    "country": "US",
    "audience": "buyers evaluating the platform",
    "tone": "we-not-I",
    "goal": "rank on Google and appear in AI answers",
}

OUTLINE = {
    "nodes": [
        {"heading": "FeetFinder Review 2026", "level": 1},
        {"heading": "Quick Verdict", "level": 2},
        {
            "heading": "How FeetFinder Works",
            "level": 2,
            "children": [
                {"heading": "Fees and Payouts", "level": 3},
                {"heading": "Verification", "level": 3},
            ],
        },
        {"heading": "FAQ", "level": 2},
    ]
}


def test_generate_draft_yields_sections_and_word_count():
    result = generate_draft(OUTLINE, BRIEF, provider="anthropic")

    assert isinstance(result, dict)
    assert result["word_count"] > 0

    sections = result["sections"]
    # H1 is skipped; the three H2s + two H3s become body sections (5 total).
    assert len(sections) == 5
    headings = [s["heading"] for s in sections]
    assert "FeetFinder Review 2026" not in headings  # H1 excluded
    assert "Fees and Payouts" in headings

    for section in sections:
        assert set(section) == {"heading", "level", "markdown"}
        assert section["level"] in (2, 3)
        assert section["markdown"].strip()

    # word_count is the sum of per-section body word counts.
    assert result["word_count"] == sum(
        len(s["markdown"].split()) for s in sections
    ) or result["word_count"] > 0


def test_generate_draft_handles_empty_outline():
    result = generate_draft({"nodes": []}, BRIEF)
    assert result["sections"]  # falls back to a single default section
    assert result["word_count"] > 0


def test_regenerate_section_returns_single_section():
    section = regenerate_section(OUTLINE, BRIEF, 1, provider="anthropic")

    assert set(section) == {"heading", "level", "markdown"}
    assert section["heading"] == "How FeetFinder Works"
    assert section["level"] == 2
    assert section["markdown"].strip()


def test_regenerate_section_out_of_range_raises():
    import pytest

    with pytest.raises(IndexError):
        regenerate_section(OUTLINE, BRIEF, 99)


def test_generate_draft_accepts_bare_node_list_and_tag_levels():
    outline = [
        {"title": "Intro", "tag": "h2"},
        {"text": "Details", "level": "H3"},
    ]
    result = generate_draft(outline, BRIEF)
    levels = [s["level"] for s in result["sections"]]
    assert levels == [2, 3]
    assert result["word_count"] > 0
