"""Evidence engine: page excerpts → fact bank → grounded writer/factcheck."""

from __future__ import annotations

import pytest

from app.research.evidence import (
    _fallback_facts,
    extract_evidence,
    facts_for_heading,
)
from app.research.fetcher import analyze_page_html


@pytest.fixture(autouse=True)
def force_mock(monkeypatch):
    monkeypatch.setattr("app.providers.factory._build_real", lambda *a, **k: None)


_HTML = """
<html><head><title>Desk Guide</title></head><body>
<h1>Desk Guide</h1>
<h2>Height range</h2>
<p>The SHW Electric desk adjusts from 28 to 46 inches and holds up to 154 pounds,
which covers a dual-monitor setup comfortably for most home offices today.</p>
<p>Short nav line.</p>
<li>Pricing starts at $189 for the 48 by 24 inch desktop size in most stores.</li>
</body></html>
"""


def test_page_excerpt_extracted():
    page = analyze_page_html(_HTML, url="https://ex.com/d", domain="ex.com")
    assert page is not None
    assert "28 to 46 inches" in page["excerpt"]
    assert "$189" in page["excerpt"]
    assert "Short nav line" not in page["excerpt"]  # too short → chrome


def test_fallback_facts_are_source_tagged():
    pages = [
        {
            "domain": "ex.com",
            "excerpt": (
                "The desk adjusts from 28 to 46 inches and holds 154 pounds of gear. "
                "Pricing starts at $189 for the base model in most stores today."
            ),
        }
    ]
    bank = _fallback_facts(pages)
    assert bank["facts"], "number-bearing sentences must become facts"
    assert all(f["source"] == "ex.com" for f in bank["facts"])
    kinds = {f["kind"] for f in bank["facts"]}
    assert "price" in kinds or "spec" in kinds


def test_extract_evidence_offline_uses_fallback():
    pages = [
        {
            "domain": "ex.com",
            "title": "Guide",
            "excerpt": "The base model holds 154 pounds and costs $189 at launch this year.",
        }
    ]
    bank = extract_evidence(pages, {"topic": "desks", "keyword": "desks"})
    assert bank["facts"] and bank["facts"][0]["source"] == "ex.com"
    assert bank["consensus"] == [] and bank["disagreements"] == []


def test_extract_evidence_empty_without_excerpts():
    bank = extract_evidence([{"domain": "ex.com"}], {"topic": "t"})
    assert bank == {"facts": [], "consensus": [], "disagreements": []}


def test_facts_for_heading_matches_by_overlap():
    evidence = {
        "facts": [
            {"text": "Height range spans 28 to 46 inches on the SHW.", "source": "a.com"},
            {"text": "Warranty coverage lasts five years.", "source": "b.com"},
        ]
    }
    hits = facts_for_heading(evidence, "Height range and adjustability")
    assert hits and "Height range" in hits[0]["text"]


def test_writer_prompt_carries_verified_facts():
    from app.article.service import _section_prompt

    prompt = _section_prompt(
        {"heading": "Height range", "level": 2},
        {"topic": "desks"},
        ["Height range"],
        {},
        None,
        {"facts": [{"text": "Spans 28 to 46 inches.", "source": "ex.com"}]},
    )
    assert "VERIFIED FACTS" in prompt
    assert "ex.com" in prompt


def test_factcheck_sources_include_fact_bank():
    from app.factcheck.service import _iter_sources

    research = {
        "sources": [],
        "facts": {
            "facts": [{"text": "It holds 154 pounds of equipment.", "source": "ex.com"}]
        },
        "competitors": [{"domain": "comp.com", "excerpt": "Real page prose here."}],
    }
    records = _iter_sources(research)
    texts = " | ".join(r["text"] for r in records)
    assert "154 pounds" in texts
    assert "Real page prose" in texts


def test_critique_draft_mock_is_noop():
    from app.article.polish import critique_draft

    draft = {
        "sections": [
            {"heading": f"S{i}", "level": 2, "markdown": "Body text here."}
            for i in range(4)
        ]
    }
    assert critique_draft(draft, {"topic": "t"}, {}) == []


def test_fabricated_table_prices_flag_when_evidence_exists():
    from app.factcheck.service import check_draft

    draft = {
        "sections": [
            {
                "heading": "Prices",
                "level": 2,
                "markdown": (
                    "Options below.\n\n"
                    "| Model | Price |\n|-------|-------|\n"
                    "| K552 | $60 |\n| C1 | $90 |\n"
                ),
            }
        ]
    }
    research_with_bank = {
        "facts": {"facts": [{"text": "The C1 costs $90 at launch.", "source": "ex.com"}]},
        "competitors": [],
    }
    fact = check_draft(draft, research_with_bank, use_llm_hint=False)
    # $90 is in the evidence; $60 is fabricated → exactly one table row flags.
    table_flags = [c for c in fact["claims"] if "table" in (c.get("kinds") or [])]
    assert len(table_flags) == 1 and "$60" in table_flags[0]["text"]
    assert fact["high_risk_unsupported"] >= 1

    # No evidence bank (offline/mock) → table rows stay exempt.
    fact2 = check_draft(draft, {}, use_llm_hint=False)
    assert not [c for c in fact2["claims"] if "table" in (c.get("kinds") or [])]


def test_writer_prompt_forbids_invention_when_no_section_facts():
    from app.article.service import _section_prompt

    prompt = _section_prompt(
        {"heading": "Expected Prices", "level": 2},
        {"topic": "keyboards"},
        ["Expected Prices"],
        {},
        None,
        {"facts": [], "evidence_exists": True},
    )
    assert "NO VERIFIED FACTS" in prompt
    assert "QUALITATIVELY" in prompt


def test_underserved_questions_flags_uncovered_paa():
    from app.outline.service import _underserved_questions

    research = {
        "headings": ["Height range and presets", "Cable management options"],
        "paa": [
            "What should you know about height range presets?",  # covered
            "Can landlords object to drilling for wall mounts?",  # nobody covers
        ],
    }
    gaps = _underserved_questions(research)
    assert "Can landlords object to drilling for wall mounts?" in gaps
    assert "What should you know about height range presets?" not in gaps
