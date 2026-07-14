"""Service-level tests for Content Memory + Internal Links (PRD §9.11, FR-11.1..11.3).

No DB / no TestClient — the router is wired by the integrator. These cover the
pure heuristic service against synthetic drafts and knowledge-graph nodes, so
they run with zero API keys.
"""

from app.memory_engine.service import (
    detect_overlap,
    suggest_internal_links,
    topic_coverage,
    upsert_topic_node,
)

WEBSITE = "feetfinder.com"

# Existing per-website knowledge graph (FR-11.1).
EXISTING = [
    {
        "website": WEBSITE,
        "topic_node": "FeetFinder Payment Methods",
        "target_url": "/payment-methods",
        "cluster": "payments",
        "coverage": 0.8,
    },
    {
        "website": WEBSITE,
        "topic_node": "FeetFinder Account Verification",
        "target_url": "/account-verification",
        "cluster": "onboarding",
        "coverage": 0.6,
    },
    {
        "website": WEBSITE,
        "topic_node": "Best Running Shoes 2026",
        "target_url": "/running-shoes",
        "cluster": "fitness",
        "coverage": 0.3,
    },
]


# --------------------------------------------------------------------------- #
# FR-11.2 — internal-link suggestions
# --------------------------------------------------------------------------- #
def test_suggest_links_returns_anchored_links_for_matching_node():
    draft = {
        "topic": "FeetFinder Review 2026",
        "keyword": "feetfinder reviews",
        "entities": ["FeetFinder Payment Methods", "Account Verification"],
        "sections": [
            {"heading": "How payments work", "level": 2, "markdown": "..."},
        ],
    }
    links = suggest_internal_links(WEBSITE, draft, EXISTING)

    assert links, "should suggest at least one internal link"
    # Every suggestion carries a target_url + non-empty anchor text (FR-11.2).
    for link in links:
        assert set(link) == {"target_url", "anchor"}
        assert link["anchor"].strip()
        assert link["target_url"].strip()

    targets = {link["target_url"] for link in links}
    assert "/payment-methods" in targets
    assert "/account-verification" in targets
    # The unrelated fitness topic must not be linked.
    assert "/running-shoes" not in targets


def test_suggest_links_uses_draft_phrase_as_anchor():
    draft = {
        "topic": "FeetFinder Review 2026",
        "entities": ["FeetFinder Payment Methods accepted"],
    }
    links = suggest_internal_links(WEBSITE, draft, EXISTING)
    payment = next(l for l in links if l["target_url"] == "/payment-methods")
    # Anchor is drawn from the draft phrase, not the raw topic node.
    assert "payment" in payment["anchor"].lower()


def test_suggest_links_empty_when_no_match():
    draft = {"topic": "Quantum Chromodynamics Explained", "entities": ["gluons"]}
    assert suggest_internal_links(WEBSITE, draft, EXISTING) == []


def test_suggest_links_filters_other_websites():
    draft = {"entities": ["FeetFinder Payment Methods"]}
    other = [{**EXISTING[0], "website": "other.com"}]
    assert suggest_internal_links(WEBSITE, draft, other) == []


def test_suggest_links_never_self_links():
    # The draft topic equals an existing node -> no self-link.
    draft = {"topic": "FeetFinder Payment Methods", "entities": ["FeetFinder Payment Methods"]}
    links = suggest_internal_links(WEBSITE, draft, EXISTING)
    assert "/payment-methods" not in {l["target_url"] for l in links}


# --------------------------------------------------------------------------- #
# FR-11.3 — duplicate / thin-overlap detection
# --------------------------------------------------------------------------- #
def test_detect_overlap_flags_near_duplicate_topic():
    report = detect_overlap(
        WEBSITE, "FeetFinder Payment Method Options", EXISTING
    )
    assert report["duplicate"] is True
    assert report["overlaps"], "near-duplicate should surface overlaps"
    assert report["overlaps"][0]["topic_node"] == "FeetFinder Payment Methods"
    # Well-covered existing page -> merge (FR-11.3).
    assert report["suggestion"] == "merge"


def test_detect_overlap_suggests_301_for_thin_existing_page():
    thin = [{"website": WEBSITE, "topic_node": "Quick Yoga Routine", "coverage": 0.1}]
    report = detect_overlap(WEBSITE, "Quick Yoga Routine Guide", thin)
    assert report["duplicate"] is True
    assert report["suggestion"] == "301"


def test_detect_overlap_no_duplicate_for_distinct_topic():
    report = detect_overlap(WEBSITE, "Deep Sea Fishing Charters", EXISTING)
    assert report["duplicate"] is False
    assert report["suggestion"] == "none"
    assert report["overlaps"] == []


def test_detect_overlap_surfaces_related_without_duplicate():
    # Shares "feetfinder account verification" but adds a distinct angle -> lands
    # in the overlap band (>= 0.45) yet below the duplicate bar (< 0.7).
    related = [
        {"website": WEBSITE, "topic_node": "FeetFinder Account Verification Steps", "coverage": 0.6}
    ]
    report = detect_overlap(WEBSITE, "FeetFinder Account Verification Troubleshooting", related)
    assert report["overlaps"]
    assert report["duplicate"] is False
    # Partial overlap -> keep both and interlink rather than merge/redirect.
    assert report["suggestion"] == "none"


# --------------------------------------------------------------------------- #
# FR-11.1 / 11.4 — knowledge-graph helpers
# --------------------------------------------------------------------------- #
def test_upsert_topic_node_shape_and_clamping():
    row = upsert_topic_node(WEBSITE, "  New Topic  ", cluster="  payments  ", coverage=1.5)
    assert row == {
        "website": WEBSITE,
        "topic_node": "New Topic",
        "cluster": "payments",
        "coverage": 1.0,  # clamped to 0..1
    }
    blank = upsert_topic_node(WEBSITE, "Solo", cluster="   ", coverage=-3)
    assert blank["cluster"] is None
    assert blank["coverage"] == 0.0


def test_topic_coverage_groups_by_cluster():
    cov = topic_coverage(WEBSITE, EXISTING)
    assert cov["website"] == WEBSITE
    assert cov["topic_count"] == 3
    clusters = {c["cluster"]: c for c in cov["clusters"]}
    assert {"payments", "onboarding", "fitness"} <= set(clusters)
    assert clusters["payments"]["topic_count"] == 1
    assert clusters["payments"]["average_coverage"] == 0.8
    # Average coverage across all nodes.
    assert abs(cov["average_coverage"] - round((0.8 + 0.6 + 0.3) / 3, 4)) < 1e-9


def test_topic_coverage_empty_graph():
    cov = topic_coverage(WEBSITE, [])
    assert cov["topic_count"] == 0
    assert cov["average_coverage"] == 0.0
    assert cov["clusters"] == []
