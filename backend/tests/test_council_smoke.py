"""Council smoke test — runs the full three-round flow on the mock adapter.

Uses the FeetFinder brief from PRD Appendix A so the demo path is covered.
"""

from app.council import run_council


def test_council_runs_end_to_end_on_mock():
    brief = {
        "topic": "FeetFinder Review 2026",
        "keyword": "feetfinder reviews",
        "country": "US",
        "audience": "buyers evaluating the platform",
        "tone": "we-not-I",
        "goal": "rank on Google and appear in AI answers",
        "research": {},
    }

    result = run_council(brief)

    # Round 1: one report per non-judge role.
    assert len(result.reports) == 4
    assert all(r.recommendations for r in result.reports)

    # Round 2: at least one real conflict is surfaced (PRD §8.2).
    assert len(result.conflicts) >= 1

    # Round 3: the Judge produced at least one decision with a valid label.
    valid = {"accepted", "rejected", "needs_evidence", "merge", "manual_review"}
    assert result.decisions
    assert all(d["label"] in valid for d in result.decisions)
