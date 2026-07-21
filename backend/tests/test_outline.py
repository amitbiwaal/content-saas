"""Service-level unit tests for the Outline Builder (PRD §6, FR-6.1..6.3).

Runs against the deterministic mock adapter (zero API keys) and synthetic
inputs; does NOT import app.main or use TestClient (router not wired yet).
"""

from __future__ import annotations

from app.outline import build_outline
from app.outline.service import (
    _heuristic_outline,
    _parse_outline,
    _research_keyword,
)


def _collect_levels(nodes: list[dict]) -> set[str]:
    levels: set[str] = set()
    for n in nodes:
        levels.add(n["level"])
        levels |= _collect_levels(n.get("children", []))
    return levels


SYNTHETIC_DECISIONS = [
    {"source": "content_strategist", "point": "Compare FeetFinder fees vs competitors", "label": "accepted", "reason": "on-intent"},
    {"source": "search_intelligence", "point": "Add an answer block on payout timing", "label": "merge", "reason": "AEO"},
    {"source": "human_editor", "point": "Drop the inflated superlatives", "label": "rejected", "reason": "unsupported"},
]

SYNTHETIC_RESEARCH = {
    "keyword": "feetfinder reviews",
    "topic": "FeetFinder Review 2026",
    "intent": "commercial",
    "headings": ["Pricing and fees", "Verification process", "Payout times"],
    "paa": ["Is FeetFinder legit?", "How much does FeetFinder cost?", {"question": "Is FeetFinder safe?"}],
    "entities": ["FeetFinder", "verification", "payout"],
}


def test_build_outline_returns_nodes_elements_and_hooks():
    """build_outline with synthetic inputs returns nodes + elements (FR-6.1/6.2)."""
    out = build_outline(
        "Approved: compare fees, add answer block",
        SYNTHETIC_DECISIONS,
        SYNTHETIC_RESEARCH,
        judge_provider="anthropic",  # no key -> mock -> heuristic fallback
    )

    assert set(out) == {"nodes", "elements", "schema_hooks"}
    assert out["nodes"], "expected a non-empty heading tree"
    assert out["elements"], "expected element placements"
    assert out["schema_hooks"], "expected schema hooks"

    # FR-6.1: H1 root plus H2/H3 structure.
    assert out["nodes"][0]["level"] == "H1"
    levels = _collect_levels(out["nodes"])
    assert "H2" in levels
    assert "H3" in levels  # FAQ questions come from PAA

    # FR-6.2: each marked element uses a recognised type and names a section.
    valid_types = {"answer_block", "table", "faq", "image", "cta"}
    for el in out["elements"]:
        assert el["type"] in valid_types
        assert el["section"]
    types = {el["type"] for el in out["elements"]}
    assert {"answer_block", "faq", "cta"} <= types


def test_heuristic_fallback_with_empty_inputs():
    """Heuristic still produces a sensible outline with empty strategy/research."""
    out = _heuristic_outline("", [], {}, "")
    assert out["nodes"][0]["level"] == "H1"
    assert len(out["nodes"]) >= 4  # H1 + quick verdict + body + complaints + faq + cta
    # Always includes answer block, FAQ and CTA even with no research.
    types = {el["type"] for el in out["elements"]}
    assert {"answer_block", "faq", "cta"} <= types
    # Schema hooks present (FR-6.3).
    hook_types = {h["type"] for h in out["schema_hooks"]}
    assert "FAQPage" in hook_types


def test_sections_use_research_topics_not_editorial_directives():
    """Sections come from reader-facing research topics + non-directive council
    points; editorial/SEO directives are filtered out (regression: the draft used
    to render 'Strengthen E-E-A-T' / 'Build an FAQ' as literal H2 headings)."""
    decisions = SYNTHETIC_DECISIONS + [
        {"source": "search_intelligence", "point": "Strengthen E-E-A-T and optimize for AI answers", "label": "accepted", "reason": "seo"},
        {"source": "content_strategist", "point": "Enrich entities and schema", "label": "merge", "reason": "aeo"},
    ]
    out = build_outline("strategy", decisions, SYNTHETIC_RESEARCH)
    heading_texts = [n["text"].lower() for n in out["nodes"]]
    joined = " | ".join(heading_texts)
    # Reader-facing research headings drive the outline.
    assert "pricing and fees" in joined
    # A non-directive council topic is still allowed through.
    assert "compare feetfinder fees" in joined
    # Editorial/SEO directives must NOT become headings.
    assert all("strengthen" not in t and "e-e-a-t" not in t for t in heading_texts)
    assert all(not t.startswith("enrich") for t in heading_texts)
    # The rejected superlatives point must NOT become a section.
    assert all("superlative" not in t for t in heading_texts)


def test_paa_becomes_faq_questions():
    """People-Also-Ask drives FAQ H3 children, normalised to questions (FR-6.2)."""
    out = build_outline("s", [], SYNTHETIC_RESEARCH)
    faq = next(n for n in out["nodes"] if n["text"] == "Frequently Asked Questions")
    questions = [c["text"] for c in faq["children"]]
    assert "Is FeetFinder legit?" in questions
    assert "Is FeetFinder safe?" in questions  # dict-form PAA coerced
    assert all(q.endswith("?") for q in questions)


def test_parse_outline_handles_well_formed_json():
    """A model returning proper outline JSON is parsed and normalised."""
    text = """```json
    {"nodes": [{"level": "h1", "text": "Title"},
               {"level": "H2", "text": "Section", "children": [{"text": "Sub"}]}],
     "elements": [{"type": "answer-block", "section": "Title", "note": "n"},
                  {"type": "bogus", "section": "x"}],
     "schema_hooks": ["Article", {"type": "FAQPage", "target": "FAQ"}]}
    ```"""
    parsed = _parse_outline(text)
    assert parsed is not None
    assert parsed["nodes"][0]["level"] == "H1"  # upper-cased
    # Child with no explicit level inherits a depth-1 default (H2).
    assert parsed["nodes"][1]["children"][0]["level"] == "H2"
    # answer-block normalised; bogus type dropped.
    el_types = [e["type"] for e in parsed["elements"]]
    assert el_types == ["answer_block"]
    hook_types = [h["type"] for h in parsed["schema_hooks"]]
    assert hook_types == ["Article", "FAQPage"]


def test_parse_outline_rejects_council_shaped_mock_output():
    """The MockAdapter's council JSON has no nodes -> None (forces heuristic)."""
    assert _parse_outline('{"summary": "x", "decisions": [], "confidence": 0.7}') is None
    assert _parse_outline("not json at all") is None
    assert _parse_outline("") is None


def test_research_keyword_resolution():
    assert _research_keyword({"keyword": "abc"}, "") == "abc"
    assert _research_keyword({"topic": "Topic X"}, "") == "Topic X"
    assert _research_keyword({}, "summary") == ""
