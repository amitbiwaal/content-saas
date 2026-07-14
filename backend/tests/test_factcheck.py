"""Fact Checker service unit tests (PRD §9.9, FR-9.1..9.3).

Service-level only: pure functions against synthetic drafts/research and the
default mock adapter. No app.main / TestClient (router not wired yet).
"""

from app.factcheck.service import check_draft, extract_claims, grade_claim


# Research with one source that supports the "20% fee" statistic (PRD Appendix A).
_RESEARCH = {
    "sources": [
        {
            "url": "https://help.feetfinder.com/fees",
            "title": "FeetFinder fee schedule",
            "snippet": "FeetFinder charges a 20% platform fee on every sale.",
        },
        {
            "url": "https://payments.feetfinder.com",
            "title": "Payout timing",
            "snippet": "Payouts arrive in 5 to 7 business days after a sale.",
        },
    ]
}


# --------------------------------------------------------------------------- #
# FR-9.1 — extraction
# --------------------------------------------------------------------------- #
def test_extract_picks_up_numeric_and_superlative_claims():
    draft = {
        "sections": [
            {"heading": "Intro", "content": "ContentOS is a content tool."},
            {
                "heading": "Fees",
                "content": (
                    "The platform takes a 35% cut of creator earnings. "
                    "It is simply the best service on the market."
                ),
            },
        ]
    }
    claims = extract_claims(draft)
    texts = [c["text"] for c in claims]

    # Numeric/statistical sentence is a claim.
    assert any("35%" in t for t in texts)
    # Superlative sentence is a claim.
    assert any("best service" in t for t in texts)
    # The neutral intro sentence (no number/superlative/stat cue) is not.
    assert not any("content tool" in t for t in texts)


# --------------------------------------------------------------------------- #
# FR-9.2 / FR-9.3 — grading
# --------------------------------------------------------------------------- #
def test_unsourced_statistic_is_high_risk_needs_evidence():
    # A statistic with no matching research source must be flagged (PRD §11).
    graded = grade_claim(
        "Roughly 47% of new users abandon the platform within a week.",
        _RESEARCH,
    )
    assert graded["risk"] == "high"
    assert graded["label"] == "needs_evidence"
    assert graded["source"] is None


def test_sourced_statistic_is_accepted_low_risk():
    # The 20% fee statistic IS supported by a research source -> accepted/low.
    graded = grade_claim(
        "FeetFinder charges a 20% platform fee on every creator sale.",
        _RESEARCH,
    )
    assert graded["source"] is not None
    assert graded["risk"] == "low"
    assert graded["label"] == "accepted"


def test_unsourced_negative_claim_is_high_risk():
    # PRD §11 bans unsourced negative claims too.
    graded = grade_claim(
        "The company is a scam that steals money from its users.",
        _RESEARCH,
    )
    assert graded["risk"] == "high"
    assert graded["label"] == "needs_evidence"


# --------------------------------------------------------------------------- #
# check_draft — the gate-feeding count
# --------------------------------------------------------------------------- #
def test_check_draft_counts_high_risk_unsupported():
    draft = {
        "sections": [
            {
                "heading": "Verdict",
                # Sourced: 20% fee, 5 to 7 day payout.
                "content": (
                    "FeetFinder charges a 20% platform fee. "
                    "Payouts arrive in 5 to 7 business days."
                ),
            },
            {
                "heading": "Risk",
                # Unsourced statistic -> high-risk needs_evidence.
                "content": "About 80% of sellers report being scammed.",
            },
        ]
    }
    result = check_draft(draft, _RESEARCH)

    assert result["claims"], "expected at least one extracted claim"
    assert result["high_risk_unsupported"] >= 1

    # The sourced fee claim is not counted as high-risk unsupported.
    fee = next((c for c in result["claims"] if "20%" in c["text"]), None)
    assert fee is not None
    assert fee["source"] is not None
    assert fee["risk"] == "low"


def test_check_draft_clean_when_all_sourced():
    draft = {
        "sections": [
            {
                "heading": "Facts",
                "content": (
                    "FeetFinder charges a 20% platform fee on every sale. "
                    "Payouts arrive in 5 to 7 business days after a sale."
                ),
            }
        ]
    }
    result = check_draft(draft, _RESEARCH)
    assert result["high_risk_unsupported"] == 0


def test_works_with_zero_keys_mock_adapter():
    # Smoke: grading runs and returns valid labels/risks with no API keys.
    graded = grade_claim("The service grew by 12% last year.", {})
    assert graded["risk"] in {"low", "medium", "high"}
    assert graded["label"] in {
        "accepted",
        "rejected",
        "needs_evidence",
        "merge",
        "manual_review",
    }
