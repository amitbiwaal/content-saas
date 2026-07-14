"""Publish-gate unit tests (PRD §10)."""

from app.scoring import Scores, evaluate_gate


def _passing_scores() -> Scores:
    return Scores(
        seo=90, aeo=88, geo=85, heo=87, eeat=82, fact=85, spam=10, publish=87
    )


def test_gate_passes_when_all_targets_met():
    verdict = evaluate_gate(_passing_scores(), high_risk_unsupported_claims=0)
    assert verdict.passed
    assert verdict.reasons == []


def test_gate_blocks_low_publish():
    scores = _passing_scores()
    scores.publish = 80
    verdict = evaluate_gate(scores)
    assert not verdict.passed
    assert any("Publish" in r for r in verdict.reasons)


def test_gate_blocks_fact_at_threshold():
    # Fact must be strictly greater than 80.
    scores = _passing_scores()
    scores.fact = 80
    verdict = evaluate_gate(scores)
    assert not verdict.passed
    assert any("Fact" in r for r in verdict.reasons)


def test_gate_blocks_high_risk_unsupported_claim():
    verdict = evaluate_gate(_passing_scores(), high_risk_unsupported_claims=1)
    assert not verdict.passed
    assert any("high-risk" in r for r in verdict.reasons)


def test_gate_high_spam_is_advisory_not_a_blocker():
    # PRD §10: the hard gate is exactly Publish>=85, Fact>80, no high-risk
    # unsupported claim. Spam (and SEO/AEO/GEO/HEO/EEAT) are advisories — high
    # spam already depresses the Publish score, so it is not a second blocker.
    scores = _passing_scores()
    scores.spam = 30
    verdict = evaluate_gate(scores)
    assert verdict.passed
    assert verdict.reasons == []
    assert any("Spam" in a for a in verdict.advisories)


def test_gate_secondary_axis_shortfall_is_advisory_not_a_blocker():
    scores = _passing_scores()
    scores.aeo = 20  # well below its 85 target — must NOT block publish
    verdict = evaluate_gate(scores)
    assert verdict.passed
    assert any("AEO" in a for a in verdict.advisories)


def test_gate_passes_with_zero_claims_default_fact():
    # A claimless draft (fact defaults to 85) must be publishable, not blocked.
    from app.scoring.service import _fact_score

    assert _fact_score([]) > 80
