"""Council agent roles + default seat→provider mapping (PRD §8.1).

The mapping is a *default*; a project may override it via
``Project.council_config`` and an operator may swap any seat's provider/model
through the registry — no role is bound to a model in logic (PRD §12).
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class Role:
    key: str
    title: str
    axis: str  # what this seat optimises for
    system_prompt: str


CONTENT_STRATEGIST = Role(
    key="content_strategist",
    title="Content Strategist",
    axis="brief & outline logic",
    system_prompt=(
        "You are the Content Strategist. Decide search intent, section order, and "
        "priority for the brief. Return 3-6 specific, sourced recommendations for "
        "structure and coverage, plus a confidence score 0-1."
    ),
)

HUMAN_EDITOR = Role(
    key="human_editor",
    title="Human Editor",
    axis="natural tone & balance",
    system_prompt=(
        "You are the Human Editor. Enforce a natural, balanced voice with no "
        "over-promising or unsupported superlatives. Challenge anything repetitive "
        "or inflated. Return 3-6 recommendations plus a confidence score 0-1."
    ),
)

SEARCH_INTELLIGENCE = Role(
    key="search_intelligence",
    title="Search Intelligence",
    axis="AEO + GEO",
    system_prompt=(
        "You are Search Intelligence. Optimise entities, answer blocks, FAQ design "
        "and citation readiness for answer and AI engines. Return 3-6 "
        "recommendations plus a confidence score 0-1."
    ),
)

TREND_ANALYST = Role(
    key="trend_analyst",
    title="Trend Analyst",
    axis="fresh angles & real questions",
    system_prompt=(
        "You are the Trend Analyst. Surface fresh angles and real questions or "
        "complaints from social and Reddit. Return 3-6 recommendations plus a "
        "confidence score 0-1."
    ),
)

JUDGE = Role(
    key="judge",
    title="Judge Agent",
    axis="final decisions",
    system_prompt=(
        "You are the Judge. You are given the full council transcript — every "
        "seat's opening position AND the back-and-forth debate (rebuttals, "
        "concessions, revisions) — plus your own deliberation. Rule on each major "
        "recommendation. Reward points that survived the debate; reject ones a "
        "rival refuted and the author conceded. For every point output a label in "
        "{accepted, rejected, needs_evidence, merge, manual_review} with a short "
        "reason a human can read. Reject unsupported, risky or off-intent claims; "
        "require citations for useful-but-unsourced points. Output strict JSON: "
        '{"summary": str, "decisions": [{"source": str, "point": str, '
        '"label": str, "reason": str}]}.'
    ),
)

# Round-3.5 — the Judge's human-readable deliberation, streamed live before the
# strict-JSON verdict so the UI shows the Judge "thinking through" the debate
# rather than a silent JSON blob appearing at the end (user ask: debate visible).
JUDGE_DELIBERATION_PROMPT = (
    "You are the Judge of an AI content council. Below is the FULL debate "
    "transcript: each seat's opening recommendations, then the rounds where they "
    "challenged each other and replied (defending, conceding or revising). In 3 "
    "to 5 sentences, reason out loud about who made the strongest case, which "
    "disagreements actually got resolved during the debate, and what the winning "
    "strategy should be. Reference the seats by name. Write plain prose — no JSON, "
    "no lists, no headings."
)

# All non-judge roles that produce Round-1 reports.
ROLES: list[Role] = [
    CONTENT_STRATEGIST,
    HUMAN_EDITOR,
    SEARCH_INTELLIGENCE,
    TREND_ANALYST,
]

# Default seat → provider (PRD §8.1). Judge defaults to anthropic; the PRD allows
# rotating it OpenAI↔Claude per topic sensitivity (open question #2).
DEFAULT_SEATS: dict[str, str] = {
    "content_strategist": "openai",
    "human_editor": "anthropic",
    "search_intelligence": "google",
    "trend_analyst": "xai",
    "judge": "anthropic",
}
