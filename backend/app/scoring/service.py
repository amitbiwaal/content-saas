"""Deterministic scoring heuristics (PRD §10, FR-8.1).

The scoring *service* is intentionally PURE: it takes plain dicts/lists (the
draft, the research brief and the extracted claims) and returns a
:class:`~app.scoring.gate.Scores` dataclass. No DB, no LLM — this keeps it
trivially unit-testable and, per the project convention, the whole module works
with ZERO API keys.

Each of the eight axes (PRD §10) is approximated with a transparent heuristic:

* **SEO**  — keyword/intent coverage + heading structure + entity presence.
* **AEO**  — answer-block / FAQ presence and snippet-ready summaries.
* **GEO**  — entity clarity + citation (source) count for AI engines.
* **HEO**  — readability proxy (sentence length) + sufficient length.
* **EEAT** — ratio of claims carrying a named source.
* **Fact** — ratio of claims that are supported (sourced and not rejected).
* **Spam** — keyword-stuffing + unsupported-claim density (LOWER is better).
* **Publish** — weighted blend of the above (PRD §10 "combined gate score").

All axis scores are clamped to ``0..100``. The blend deliberately penalises a
high Spam score and a low Fact score because those are the publish-gate
blockers (PRD §10 publishing gate).
"""

from __future__ import annotations

import re
from collections.abc import Iterable

from app.scoring.gate import Scores

# --------------------------------------------------------------------------- #
# Tunable weights / knobs (kept module-level so tests can reason about them).
# --------------------------------------------------------------------------- #

# Publish = weighted blend of the sub-axes. Fact is weighted heavily and Spam is
# subtracted, mirroring the gate's emphasis (PRD §10). Originality carries a small
# weight so an AI-detectable, templated draft can't score a clean publish — the
# product's whole pitch is content that doesn't read as one detectable voice
# (PRD §20). Weights sum to 1.0.
_PUBLISH_WEIGHTS: dict[str, float] = {
    "seo": 0.18,
    "aeo": 0.14,
    "geo": 0.14,
    "heo": 0.14,
    "eeat": 0.12,
    "fact": 0.22,
    "originality": 0.06,
}
_SPAM_PENALTY = 0.30  # fraction of the spam score subtracted from publish.

_WORD_RE = re.compile(r"[A-Za-z0-9']+")
_SENT_RE = re.compile(r"[.!?]+")

# Phrases that signal an answer block / snippet-ready summary (AEO, PRD §10).
_ANSWER_MARKERS = (
    "quick verdict",
    "quick answer",
    "in short",
    "tl;dr",
    "summary",
    "key takeaway",
    "bottom line",
    "the answer is",
)
_FAQ_MARKERS = ("faq", "frequently asked", "q:", "q&a")


def _clamp(value: float, lo: float = 0.0, hi: float = 100.0) -> float:
    """Clamp ``value`` into ``[lo, hi]`` and round to one decimal."""
    return round(max(lo, min(hi, value)), 1)


# --------------------------------------------------------------------------- #
# Draft text extraction (defensive — the draft shape is semi-structured JSON).
# --------------------------------------------------------------------------- #
def _section_iter(draft: dict) -> Iterable[dict]:
    """Yield section dicts from a draft, tolerating loose shapes."""
    sections = (draft or {}).get("sections") or []
    if isinstance(sections, dict):  # someone keyed sections by id/heading.
        sections = list(sections.values())
    for sec in sections:
        if isinstance(sec, dict):
            yield sec
        elif isinstance(sec, str):
            yield {"body": sec}


def _draft_text(draft: dict) -> str:
    """Flatten a draft's section bodies + headings into one searchable string."""
    parts: list[str] = []
    title = (draft or {}).get("title")
    if isinstance(title, str):
        parts.append(title)
    for sec in _section_iter(draft):
        for key in ("heading", "title", "h2", "h3", "markdown", "body", "text", "content"):
            val = sec.get(key)
            if isinstance(val, str):
                parts.append(val)
    return "\n".join(parts)


def _headings(draft: dict) -> list[str]:
    """Collect heading strings from the draft sections."""
    out: list[str] = []
    for sec in _section_iter(draft):
        for key in ("heading", "title", "h2", "h3"):
            val = sec.get(key)
            if isinstance(val, str) and val.strip():
                out.append(val.strip())
    return out


def _tokens(text: str) -> list[str]:
    return [t.lower() for t in _WORD_RE.findall(text)]


def _entity_names(research: dict) -> list[str]:
    """Lower-cased entity names from research.

    Research entities are ``{"name", "type", "salience"}`` dicts (see
    :class:`~app.research.provider.MockResearchProvider`), but a bare list of
    strings is also accepted. Extracting the name here is essential: matching the
    raw ``str(dict)`` against the body never hits, which would zero out SEO's
    entity credit and GEO's entity clarity on every real run.
    """
    names: list[str] = []
    for e in (research or {}).get("entities") or []:
        if isinstance(e, dict):
            name = e.get("name") or e.get("text") or e.get("entity")
        else:
            name = e
        if isinstance(name, str) and len(name.strip()) > 2:
            names.append(name.strip().lower())
    return names


# --------------------------------------------------------------------------- #
# Individual axis heuristics
# --------------------------------------------------------------------------- #
def _seo_score(draft: dict, research: dict, words: list[str], text_lower: str) -> float:
    """Keyword/intent coverage + heading structure + entity presence (§10)."""
    text_set = set(words)
    headings = _headings(draft)

    # Keyword coverage: primary keyword tokens present in the body.
    keyword = str((research or {}).get("keyword", "")).lower()
    kw_tokens = [t for t in _tokens(keyword) if len(t) > 2]
    if kw_tokens:
        covered = sum(1 for t in kw_tokens if t in text_set) / len(kw_tokens)
    else:
        covered = 0.0
    kw_points = 35.0 * covered

    # Heading structure: reward having several headings (capped at 5).
    heading_points = 25.0 * min(len(headings), 5) / 5.0

    # Entity presence: research entities that surface in the body. Names may be
    # multi-word, so match as a substring of the flattened text.
    entities = _entity_names(research)
    if entities:
        hits = sum(1 for e in entities if e in text_lower)
        entity_points = 25.0 * min(hits, len(entities)) / len(entities)
    else:
        entity_points = 12.0  # neutral credit when no entities supplied.

    # Length floor: a non-trivial article earns the remaining 15.
    length_points = 15.0 * min(len(words), 600) / 600.0

    return _clamp(kw_points + heading_points + entity_points + length_points)


def _aeo_score(draft: dict, text_lower: str) -> float:
    """Answer-block / FAQ presence + snippet-ready summaries (§10)."""
    score = 0.0
    if any(m in text_lower for m in _ANSWER_MARKERS):
        score += 45.0
    if any(m in text_lower for m in _FAQ_MARKERS):
        score += 35.0
    # A leading short paragraph reads as a snippet-ready summary.
    first = text_lower.strip().split("\n", 1)[0]
    if 0 < len(first) <= 320:
        score += 20.0
    return _clamp(score)


def _geo_score(research: dict, claims: list[dict], text_lower: str) -> float:
    """Entity clarity + citation readiness for AI engines (§10)."""
    entities = _entity_names(research)
    if entities:
        clarity = sum(1 for e in entities if e in text_lower) / len(entities)
    else:
        clarity = 0.4  # neutral when none provided.
    clarity_points = 55.0 * clarity

    # Citation count: distinct sources across research + claims.
    sources = {str(s) for s in (research or {}).get("sources") or [] if s}
    sources |= {str(c.get("source")) for c in claims if c.get("source")}
    citation_points = 45.0 * min(len(sources), 5) / 5.0

    return _clamp(clarity_points + citation_points)


def _heo_score(text: str, words: list[str]) -> float:
    """Readability (sentence length) + adequate length (§10)."""
    sentences = [s for s in _SENT_RE.split(text) if s.strip()]
    if sentences:
        avg_len = len(words) / len(sentences)
    else:
        avg_len = float(len(words))

    # Reward an average sentence in the readable 12-22 word band; penalise far
    # from it. Centre 17, full credit within +-5 words.
    readability = max(0.0, 1.0 - abs(avg_len - 17.0) / 17.0)
    readability_points = 55.0 * readability

    # Usefulness proxy: enough content to be helpful (cap at 800 words).
    length_points = 45.0 * min(len(words), 800) / 800.0

    return _clamp(readability_points + length_points)


def _verifiable(claims: list[dict]) -> list[dict]:
    """Claims that assert something checkable (numeric/statistical/negative).

    Pure-superlative flags ("the best fit for you") are editorial style notes —
    the fact-checker lists them for a human (manual_review) but they are not
    verifiable facts, so they must not drag the Fact/EEAT ratios down. Claims
    with no ``kinds`` metadata are kept (conservative).
    """
    out: list[dict] = []
    for c in claims:
        kinds = set(c.get("kinds") or [])
        if not kinds or kinds - {"superlative"}:
            out.append(c)
    return out


def _eeat_score(claims: list[dict]) -> float:
    """Trust signal: ratio of verifiable claims carrying a named source (§10)."""
    claims = _verifiable(claims)
    if not claims:
        return 50.0  # neutral when there is nothing to source yet.
    sourced = sum(1 for c in claims if c.get("source"))
    return _clamp(100.0 * sourced / len(claims))


def _fact_score(claims: list[dict]) -> float:
    """Verifiable-claim support ratio: sourced and not rejected (§10, FR-9)."""
    claims = _verifiable(claims)
    if not claims:
        # Nothing to verify and nothing disproven -> pass. A neutral value below
        # the >80 Fact gate would make every claimless draft unpublishable.
        return 85.0
    supported = 0
    for c in claims:
        label = str(c.get("label") or "").lower()
        if label == "rejected":
            continue
        if c.get("source") or label == "accepted":
            supported += 1
    return _clamp(100.0 * supported / len(claims))


def _spam_score(words: list[str], claims: list[dict], research: dict) -> float:
    """Keyword-stuffing + unsupported-claim density. LOWER is better (§10)."""
    if not words:
        # Thin/empty content is itself a spam/low-quality signal, so it lands
        # above the gate cap rather than looking pristine.
        return 35.0

    # Keyword stuffing: max frequency of any primary-keyword token. A natural
    # density up to ~4% is fine (no penalty) — brand-name reviews legitimately
    # repeat the brand; the penalty ramps from 4% up to ~10%, where the body
    # reads as stuffed.
    keyword = str((research or {}).get("keyword", "")).lower()
    kw_tokens = [t for t in _tokens(keyword) if len(t) > 2]
    stuffing = 0.0
    if kw_tokens:
        total = len(words)
        for t in kw_tokens:
            density = words.count(t) / total
            stuffing = max(stuffing, density)
        over = max(0.0, stuffing - 0.04)  # only density above ~4% counts.
        stuffing_points = 60.0 * min(over / 0.06, 1.0)
    else:
        stuffing_points = 0.0

    # Unsupported-claim density.
    if claims:
        unsupported = sum(
            1
            for c in claims
            if not c.get("source") and str(c.get("label") or "").lower() != "accepted"
        )
        unsupported_points = 40.0 * unsupported / len(claims)
    else:
        unsupported_points = 0.0

    return _clamp(stuffing_points + unsupported_points)


# Filler / AI-pattern phrases that read as unoriginal, templated copy (PRD §20).
_AI_MARKERS = (
    "in conclusion",
    "it's important to note",
    "it is important to note",
    "in today's world",
    "when it comes to",
    "a wide range of",
    "plays a crucial role",
    "navigating the",
    "in the realm of",
    "[mock",  # the deterministic mock seats are inherently unoriginal
)


def _originality_score(text: str, words: list[str]) -> float:
    """Originality / AI-detection proxy — higher is better (PRD §20).

    Combines lexical diversity (unique/total words) with a penalty for repeated
    AI-pattern filler phrases and em-dash density. Deterministic, no LLM. A real
    plagiarism/AI-detector swaps in here before scaling; this gives a sensible
    advisory signal in the meantime.
    """
    if not words:
        return 30.0
    diversity = len(set(words)) / len(words)
    diversity_points = 60.0 * min(diversity / 0.5, 1.0)  # ~0.5 ratio earns full

    low = text.lower()
    marker_hits = sum(low.count(m) for m in _AI_MARKERS)
    em_dashes = low.count("—") + low.count("–")
    penalty = min(45.0, marker_hits * 8.0 + em_dashes * 4.0)

    return _clamp(40.0 + diversity_points - penalty)


def _publish_score(partial: Scores) -> float:
    """Weighted blend of the sub-axes minus a spam penalty (§10)."""
    blend = sum(_PUBLISH_WEIGHTS[axis] * getattr(partial, axis) for axis in _PUBLISH_WEIGHTS)
    return _clamp(blend - _SPAM_PENALTY * partial.spam)


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def compute_scores(
    draft: dict, research: dict, claims: list[dict]
) -> Scores:
    """Compute all eight scores from a draft + research + claims (PRD §10).

    Pure and deterministic — no LLM, no DB. ``draft`` is the persisted draft
    payload (notably ``sections``), ``research`` the normalised brief (notably
    ``keyword``, ``entities`` and ``sources``) and ``claims`` the fact-check
    records (each a dict with ``source``/``label`` — PRD §14 ``claim``).

    Returns a :class:`~app.scoring.gate.Scores` ready for
    :func:`~app.scoring.gate.evaluate_gate`.
    """
    draft = draft or {}
    research = research or {}
    claims = list(claims or [])

    text = _draft_text(draft)
    text_lower = text.lower()
    words = _tokens(text)

    scores = Scores(
        seo=_seo_score(draft, research, words, text_lower),
        aeo=_aeo_score(draft, text_lower),
        geo=_geo_score(research, claims, text_lower),
        heo=_heo_score(text, words),
        eeat=_eeat_score(claims),
        fact=_fact_score(claims),
        spam=_spam_score(words, claims, research),
        originality=_originality_score(text, words),
    )
    scores.publish = _publish_score(scores)
    return scores
