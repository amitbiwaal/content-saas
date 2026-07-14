"""Ranked, highest-impact fixes per failing axis (PRD §9.8, FR-8.2).

The Optimizer turns a :class:`~app.scoring.gate.Scores` snapshot into an
actionable, ranked list: the single highest-impact fix for each axis that is
below its gate target, ordered by estimated score gain (FR-8.2 "the single
highest-impact fix per axis, ranked by score gain").

Pure and deterministic — no LLM, no DB — so it is unit-testable in isolation
and runs with zero API keys (project convention).
"""

from __future__ import annotations

from app.scoring.gate import GATE_TARGETS, Scores

# One canonical, highest-leverage fix per axis (PRD §9.8 / §10 column wording).
_FIX_FOR_AXIS: dict[str, str] = {
    "seo": (
        "Strengthen on-page SEO: work the primary keyword and key entities into "
        "the H1/H2 headings and opening paragraph, and add missing subheadings."
    ),
    "aeo": (
        "Add an answer block: a snippet-ready 'Quick Verdict' summary up top and "
        "an FAQ section answering the People-Also-Ask questions."
    ),
    "geo": (
        "Improve AI-engine citation readiness: name and define the key entities "
        "and cite trusted sources inline so generative engines can attribute you."
    ),
    "heo": (
        "Improve reading flow: shorten long sentences toward ~17 words and expand "
        "thin sections so the piece is genuinely useful end to end."
    ),
    "eeat": (
        "Add trust signals: attach a named source to every factual or statistical "
        "claim and surface author experience/expertise."
    ),
    "fact": (
        "Resolve unsupported claims: source or correct each unverified claim and "
        "remove any the Judge rejected before publishing."
    ),
    "spam": (
        "Reduce spam risk: cut keyword stuffing to a natural ~1-2% density and "
        "remove or source unsupported claims."
    ),
    "originality": (
        "Raise originality: rewrite templated AI-pattern phrasing, vary sentence "
        "structure and add first-hand specifics so it doesn't read as generic copy."
    ),
}


def _axis_is_failing(axis: str, value: float) -> bool:
    """True when ``axis`` is below (or, for spam, at/above) its gate target."""
    target = GATE_TARGETS[axis]
    if axis == "spam":  # lower is better — failing when at/above the cap.
        return value >= target
    if axis == "fact":  # strict greater-than in the gate (PRD §10).
        return value <= target
    return value < target


def _estimated_gain(axis: str, value: float) -> float:
    """Estimate the publish-relevant gain from lifting ``axis`` to target.

    For normal axes the gain is the gap to the target; for spam (lower-better)
    it is how far above the cap the score sits. Rounded for stable ranking.
    """
    target = GATE_TARGETS[axis]
    gap = (value - target) if axis == "spam" else (target - value)
    return round(max(0.0, gap), 1)


def top_fixes(scores: Scores) -> list[dict]:
    """Return the highest-impact fix per failing axis, ranked by gain (FR-8.2).

    Each entry is ``{"axis": str, "fix": str, "est_gain": float}``. The
    ``publish`` axis is intentionally excluded — it is a derived blend, so the
    actionable fixes live on the seven contributing axes. The list is sorted by
    ``est_gain`` descending (largest opportunity first), ties broken by axis
    name for determinism.
    """
    fixes: list[dict] = []
    for axis in ("seo", "aeo", "geo", "heo", "eeat", "fact", "spam", "originality"):
        value = float(getattr(scores, axis))
        if _axis_is_failing(axis, value):
            fixes.append(
                {
                    "axis": axis,
                    "fix": _FIX_FOR_AXIS[axis],
                    "est_gain": _estimated_gain(axis, value),
                }
            )

    fixes.sort(key=lambda f: (-f["est_gain"], f["axis"]))
    return fixes
