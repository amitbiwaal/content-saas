"""Competitor coverage-gap analysis (app.research.competitors).

Verifies the heuristic that flags which competitor subtopics an outline already
covers, which are gaps, and that the ubiquitous brand/keyword token does not
create false "covered" matches.
"""

from app.research.competitors import analyze_competitors

# Research as gathered for a brief: SERP rivals + their H2 headings. The brand
# token "feetfinder" appears in every heading (the false-match trap).
RESEARCH = {
    "serp": [
        {"rank": 1, "title": "FeetFinder Guide", "domain": "a.com", "url": "https://a.com", "snippet": "s"},
        {"rank": 2, "title": "FeetFinder Review", "domain": "b.com", "url": "https://b.com"},
    ],
    "headings": [
        "What is FeetFinder",
        "How FeetFinder payments work",
        "FeetFinder pricing and fees",
        "Is FeetFinder safe",
        "FeetFinder alternatives",
    ],
}

# Our outline covers "what is" + "payments", plus a differentiator competitors lack.
OUTLINE = {
    "nodes": [
        {"level": "H1", "text": "FeetFinder Review 2026", "children": []},
        {"level": "H2", "text": "What is FeetFinder", "children": []},
        {"level": "H2", "text": "FeetFinder payments explained", "children": []},
        {"level": "H2", "text": "Payout trust and timing", "children": []},
    ],
}


def test_gaps_and_coverage():
    result = analyze_competitors(RESEARCH, OUTLINE)

    # Pricing, safety and alternatives are competitor subtopics we do NOT cover.
    assert "FeetFinder pricing and fees" in result["gaps"]
    assert "Is FeetFinder safe" in result["gaps"]
    assert "FeetFinder alternatives" in result["gaps"]

    # The two we do cover are matched to the outline heading that addresses them.
    covered_headings = {c["heading"] for c in result["covered"]}
    assert "How FeetFinder payments work" in covered_headings

    # Coverage percent is covered / total competitor headings.
    assert 0 < result["coverage_pct"] < 100


def test_brand_token_does_not_create_false_coverage():
    # "Is FeetFinder safe" shares only the brand token with our headings; it must
    # be reported as a gap, not covered, because "safe" is uncovered.
    result = analyze_competitors(RESEARCH, OUTLINE)
    assert "Is FeetFinder safe" not in {c["heading"] for c in result["covered"]}


def test_our_differentiators_are_reported_as_extra():
    result = analyze_competitors(RESEARCH, OUTLINE)
    # No competitor heading is about payout trust/timing — it's our edge.
    assert "Payout trust and timing" in result["extra"]


def test_serp_cards_shaped_for_ui():
    result = analyze_competitors(RESEARCH, OUTLINE)
    assert len(result["competitors"]) == 2
    top = result["competitors"][0]
    assert top["rank"] == 1 and top["domain"] == "a.com" and top["url"]


def test_no_outline_makes_everything_a_gap():
    result = analyze_competitors(RESEARCH, None)
    assert result["gaps"] == RESEARCH["headings"]
    assert result["covered"] == []
    assert result["coverage_pct"] == 0.0


def test_empty_research_is_safe():
    result = analyze_competitors({}, OUTLINE)
    assert result["competitors"] == []
    assert result["gaps"] == []
    assert result["coverage_pct"] == 0.0
