"""Scoring service + optimizer unit tests (PRD §10, FR-8.1..8.2).

Pure service-level tests on synthetic inputs — no DB, no TestClient, no LLM
keys required. Covers: a rich, well-structured draft beats an empty one across
the axes, and the optimizer returns ranked fixes for the failing axes.
"""

from __future__ import annotations

from app.scoring import GATE_TARGETS, Scores, compute_scores, top_fixes


# --------------------------------------------------------------------------- #
# Synthetic fixtures
# --------------------------------------------------------------------------- #
_RICH_DRAFT = {
    "title": "FeetFinder Reviews 2026: Quick Verdict",
    "sections": [
        {
            "heading": "Quick Verdict",
            "body": (
                "In short, FeetFinder is a legitimate platform. It charges a 20% "
                "fee and pays out in 5 to 7 days after identity verification."
            ),
        },
        {
            "heading": "What is FeetFinder",
            "body": (
                "FeetFinder is a marketplace for foot content. It verifies sellers "
                "and buyers. The platform is owned by its parent company and has "
                "clear payout rules that buyers should understand before joining."
            ),
        },
        {
            "heading": "Fees and payouts",
            "body": (
                "The FeetFinder fee is 20% of each sale. Payouts arrive in about a "
                "week. Trustpilot and Scamadviser both rate the service."
            ),
        },
        {
            "heading": "FAQ",
            "body": (
                "Q: Is FeetFinder safe? A: Yes, with verification. Q: What is the "
                "fee? A: Twenty percent. Q: How fast are payouts? A: 5 to 7 days."
            ),
        },
    ],
}

_RICH_RESEARCH = {
    "keyword": "feetfinder reviews",
    "topic": "FeetFinder Review 2026",
    "entities": ["FeetFinder", "Trustpilot", "Scamadviser"],
    "sources": [
        "https://trustpilot.com/feetfinder",
        "https://scamadviser.com/feetfinder",
        "https://feetfinder.com/terms",
    ],
    "intent": "commercial investigation",
}

_RICH_CLAIMS = [
    {
        "text": "FeetFinder charges a 20% fee.",
        "source": "https://feetfinder.com/terms",
        "risk": "medium",
        "label": "accepted",
    },
    {
        "text": "Payouts take 5 to 7 days.",
        "source": "https://feetfinder.com/terms",
        "risk": "low",
        "label": "accepted",
    },
    {
        "text": "FeetFinder is rated on Trustpilot.",
        "source": "https://trustpilot.com/feetfinder",
        "risk": "low",
        "label": "accepted",
    },
]

_EMPTY_DRAFT: dict = {"sections": []}
_EMPTY_RESEARCH: dict = {"keyword": "feetfinder reviews"}
_EMPTY_CLAIMS: list[dict] = []


# --------------------------------------------------------------------------- #
# compute_scores
# --------------------------------------------------------------------------- #
def test_rich_draft_scores_higher_than_empty():
    rich = compute_scores(_RICH_DRAFT, _RICH_RESEARCH, _RICH_CLAIMS)
    empty = compute_scores(_EMPTY_DRAFT, _EMPTY_RESEARCH, _EMPTY_CLAIMS)

    # Every quality axis should be at least as good, and overall clearly better.
    for axis in ("seo", "aeo", "geo", "heo", "eeat", "fact"):
        assert getattr(rich, axis) >= getattr(empty, axis), axis
    assert rich.publish > empty.publish

    # Spam is lower-is-better: the rich, sourced draft must not be spammier.
    assert rich.spam <= empty.spam


def test_scores_are_clamped_to_unit_range():
    for src in (
        compute_scores(_RICH_DRAFT, _RICH_RESEARCH, _RICH_CLAIMS),
        compute_scores(_EMPTY_DRAFT, _EMPTY_RESEARCH, _EMPTY_CLAIMS),
    ):
        for value in src.as_dict().values():
            assert 0.0 <= value <= 100.0


def test_rich_draft_hits_answer_and_entity_signals():
    rich = compute_scores(_RICH_DRAFT, _RICH_RESEARCH, _RICH_CLAIMS)
    # AEO rewards the Quick Verdict + FAQ; GEO rewards entities + citations.
    assert rich.aeo >= 60
    assert rich.geo >= 60
    # All claims are sourced -> strong EEAT and Fact.
    assert rich.eeat >= 80
    assert rich.fact >= 80


def test_compute_scores_handles_none_and_loose_shapes():
    # Defensive: None inputs and string sections must not raise.
    scores = compute_scores(None, None, None)  # type: ignore[arg-type]
    assert isinstance(scores, Scores)
    loose = compute_scores({"sections": ["just a paragraph of text here"]}, {}, [])
    assert 0.0 <= loose.publish <= 100.0


# --------------------------------------------------------------------------- #
# top_fixes
# --------------------------------------------------------------------------- #
def test_top_fixes_lists_failing_axes_only():
    empty = compute_scores(_EMPTY_DRAFT, _EMPTY_RESEARCH, _EMPTY_CLAIMS)
    fixes = top_fixes(empty)

    assert fixes, "an empty draft must surface fixes"
    axes = {f["axis"] for f in fixes}

    # Each returned axis is genuinely below (or, for spam, at/above) its target.
    for f in fixes:
        axis, gain = f["axis"], f["est_gain"]
        assert axis != "publish"  # publish is derived, not directly fixable.
        assert gain > 0.0
        assert set(f) == {"axis", "fix", "est_gain"}
        assert isinstance(f["fix"], str) and f["fix"]

    # SEO of an empty draft is well below 85, so it must appear.
    assert "seo" in axes


def test_top_fixes_ranked_by_estimated_gain_desc():
    empty = compute_scores(_EMPTY_DRAFT, _EMPTY_RESEARCH, _EMPTY_CLAIMS)
    gains = [f["est_gain"] for f in top_fixes(empty)]
    assert gains == sorted(gains, reverse=True)


def test_top_fixes_empty_when_all_axes_pass():
    perfect = Scores(
        seo=95, aeo=95, geo=95, heo=95, eeat=95, fact=95, spam=5, originality=90, publish=95
    )
    assert top_fixes(perfect) == []


def test_top_fixes_flags_spam_when_above_cap():
    spammy = Scores(
        seo=90, aeo=90, geo=90, heo=90, eeat=90, fact=90, spam=40, publish=80
    )
    fixes = top_fixes(spammy)
    spam_fix = next((f for f in fixes if f["axis"] == "spam"), None)
    assert spam_fix is not None
    assert spam_fix["est_gain"] == round(40 - GATE_TARGETS["spam"], 1)
