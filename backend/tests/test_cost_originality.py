"""Originality (PRD §20) + cost estimation (PRD §13) tests."""

from app.providers.registry import estimate_cost_cents
from app.scoring.service import compute_scores

RESEARCH = {"keyword": "feetfinder reviews", "entities": [], "sources": []}


def _draft(text: str) -> dict:
    return {"sections": [{"heading": "Body", "level": 2, "markdown": text}]}


def test_originality_penalises_templated_filler():
    original = compute_scores(
        _draft(
            "Verification takes five days. Payouts clear within a week. The fee is "
            "twenty percent. Sellers keep most earnings after that deduction."
        ),
        RESEARCH,
        [],
    )
    generic = compute_scores(
        _draft("[mock:openai] in conclusion, it's important to note — in today's world — when it comes to this."),
        RESEARCH,
        [],
    )
    assert original.originality > generic.originality
    assert 0 <= generic.originality <= 100


def test_estimate_cost_cents():
    # mock provider has no registry entry -> free.
    assert estimate_cost_cents("mock", total_tokens=10_000) == 0.0
    # anthropic: 500c in / 2500c out per 1M; 1M total split 50/50 -> 250 + 1250 = 1500c.
    assert estimate_cost_cents("anthropic", total_tokens=1_000_000) == 1500.0
