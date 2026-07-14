"""Eight-score container + publish-gate logic (PRD §10).

The gate is intentionally pure (no DB, no model calls) so it's trivially
unit-testable. The actual *computation* of each score from draft + research +
fact-check lands in M2; M0 ships the data shape and the gate decision.

Publish rule (PRD §10): ready only when Publish ≥ 85, Fact > 80, and no
high-risk unsupported claim remains.
"""

from __future__ import annotations

from dataclasses import dataclass, field


# Gate targets per score (PRD §10). Spam is "lower is better".
# ``originality`` (PRD §20, the recommended 9th score) is tracked + has a target
# for the UI, but it is NOT a hard publish-gate blocker (the gate stays Publish /
# Fact / high-risk-claims per PRD §10) — it's a pre-scaling advisory signal.
GATE_TARGETS: dict[str, float] = {
    "seo": 85,
    "aeo": 85,
    "geo": 80,
    "heo": 85,
    "eeat": 80,
    "fact": 80,   # strict greater-than in the gate
    "spam": 25,   # must be BELOW this
    "originality": 70,  # higher is better; advisory (PRD §20)
    "publish": 85,
}


@dataclass
class Scores:
    seo: float = 0.0
    aeo: float = 0.0
    geo: float = 0.0
    heo: float = 0.0
    eeat: float = 0.0
    fact: float = 0.0
    spam: float = 0.0  # lower is better
    originality: float = 0.0  # higher is better (PRD §20, advisory)
    publish: float = 0.0

    def as_dict(self) -> dict[str, float]:
        return {
            "seo": self.seo,
            "aeo": self.aeo,
            "geo": self.geo,
            "heo": self.heo,
            "eeat": self.eeat,
            "fact": self.fact,
            "spam": self.spam,
            "originality": self.originality,
            "publish": self.publish,
        }


@dataclass
class GateVerdict:
    passed: bool
    reasons: list[str] = field(default_factory=list)
    # Secondary-axis shortfalls surfaced to the editor but NOT gate blockers.
    advisories: list[str] = field(default_factory=list)


def evaluate_gate(
    scores: Scores, *, high_risk_unsupported_claims: int = 0
) -> GateVerdict:
    """Apply the publish gate. An empty ``reasons`` list means it passed.

    The hard publish rule (PRD §10) is exactly three conditions: Publish ≥ 85,
    Fact > 80, and no high-risk unsupported claim. Only these decide ``passed``.
    Secondary axes (SEO/AEO/GEO/HEO/EEAT/Spam) are reported as ``advisories`` so
    the editor sees every shortfall, but they never block publish on their own.
    """
    blockers: list[str] = []

    if scores.publish < GATE_TARGETS["publish"]:
        blockers.append(
            f"Publish {scores.publish:.1f} < {GATE_TARGETS['publish']:.0f}"
        )
    if scores.fact <= GATE_TARGETS["fact"]:
        blockers.append(f"Fact {scores.fact:.1f} not > {GATE_TARGETS['fact']:.0f}")
    if high_risk_unsupported_claims > 0:
        blockers.append(
            f"{high_risk_unsupported_claims} high-risk unsupported claim(s) remain"
        )

    # Secondary axes: surfaced as advisories, never a hard blocker (PRD §10).
    advisories: list[str] = []
    for axis in ("seo", "aeo", "geo", "heo", "eeat"):
        value = getattr(scores, axis)
        if value < GATE_TARGETS[axis]:
            advisories.append(f"{axis.upper()} {value:.1f} < {GATE_TARGETS[axis]:.0f}")
    if scores.spam >= GATE_TARGETS["spam"]:
        advisories.append(
            f"Spam risk {scores.spam:.1f} ≥ {GATE_TARGETS['spam']:.0f}"
        )

    return GateVerdict(passed=not blockers, reasons=blockers, advisories=advisories)
