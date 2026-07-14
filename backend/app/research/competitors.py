"""Competitor analysis + coverage-gap detection (PRD §9.4 FR-4.1, review mode).

Turns the research signals already gathered for a brief — the top SERP results
and the competitor H2 headings (:mod:`app.research.provider`) — into an
editor-facing competitor view, and cross-references those competitor headings
against the project's own outline to surface **coverage gaps**: subtopics rivals
cover that our article does not (yet).

Pure and DB-free (deterministic, zero API key): the router feeds it the persisted
Research + Outline rows and returns the analysis. Matching is heuristic token
overlap — good enough to flag gaps for a human to judge, never an automated edit.
"""

from __future__ import annotations

import re
from collections import Counter

# Filler tokens ignored when comparing headings, so overlap reflects real topic
# words. Intentionally small — this is a heuristic, not an NLP pipeline.
_STOP = frozenset(
    {
        "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "is", "are",
        "with", "how", "what", "why", "does", "do", "your", "you", "it", "this",
        "that", "vs", "versus", "best", "top", "guide", "review", "reviews",
        "explained", "works", "work", "using", "use", "about", "can", "should",
    }
)

# A competitor heading counts as "covered" when at least this fraction of its
# significant tokens appears in one of our outline headings.
_COVER_THRESHOLD = 0.5


def _tokens(text: str) -> set[str]:
    """Significant lower-case word tokens of a heading (stop-words removed)."""
    words = re.findall(r"[a-z0-9]+", str(text).lower())
    return {w for w in words if len(w) >= 3 and w not in _STOP}


def _best_overlap(target: set[str], candidates: list[set[str]]) -> float:
    """Max fraction of ``target`` tokens contained in any candidate token set."""
    if not target:
        return 0.0
    best = 0.0
    for cand in candidates:
        if not cand:
            continue
        frac = len(target & cand) / len(target)
        if frac > best:
            best = frac
    return best


def _common_tokens(token_sets: list[set[str]]) -> set[str]:
    """Tokens shared by a majority of headings — the brand/topic words.

    The primary keyword (e.g. the brand) appears in nearly every heading, so
    matching on it makes unrelated sections look "covered". These ubiquitous
    tokens carry no distinguishing signal, so they are stripped before comparing
    what a section is actually *about*. Only kicks in with enough headings (3+)
    to make "majority" meaningful.
    """
    if len(token_sets) < 3:
        return set()
    freq: Counter[str] = Counter()
    for toks in token_sets:
        freq.update(toks)
    threshold = max(2, (len(token_sets) * 3 + 4) // 5)  # ceil(0.6 * n)
    return {tok for tok, count in freq.items() if count >= threshold}


def _distinguishing(tokens: set[str], common: set[str]) -> set[str]:
    """A heading's tokens minus brand/topic words; falls back to all if empty."""
    sig = tokens - common
    return sig or tokens


def _outline_headings(outline: dict | None) -> list[str]:
    """Flatten an outline's H2/H3 node text into a flat heading list (skip H1)."""
    out: list[str] = []

    def walk(nodes: object) -> None:
        if not isinstance(nodes, list):
            return
        for node in nodes:
            if not isinstance(node, dict):
                continue
            level = str(node.get("level", "H2")).upper()
            text = str(node.get("text") or node.get("heading") or "").strip()
            if text and level != "H1":
                out.append(text)
            walk(node.get("children"))

    walk((outline or {}).get("nodes"))
    return out


def _competitor_headings(research: dict | None) -> list[str]:
    """Competitor H2 headings from research, as plain strings."""
    out: list[str] = []
    for h in (research or {}).get("headings") or []:
        if isinstance(h, str) and h.strip():
            out.append(h.strip())
        elif isinstance(h, dict):
            text = h.get("text") or h.get("heading") or h.get("title")
            if isinstance(text, str) and text.strip():
                out.append(text.strip())
    return out


def _serp_cards(research: dict | None) -> list[dict]:
    """Shape the top SERP results into competitor cards for the UI."""
    cards: list[dict] = []
    for i, s in enumerate((research or {}).get("serp") or [], start=1):
        if not isinstance(s, dict):
            continue
        cards.append(
            {
                "rank": s.get("rank", i),
                "title": s.get("title") or "",
                "domain": s.get("domain") or "",
                "url": s.get("url") or s.get("link") or "",
                "snippet": s.get("snippet") or "",
            }
        )
    return cards


def analyze_competitors(research: dict | None, outline: dict | None) -> dict:
    """Competitor view + coverage-gap analysis (FR-4.1, review mode).

    Args:
        research: The project's normalised research (``serp``, ``headings``, ...).
        outline: The project's outline (``nodes`` tree) or ``None`` if not built
            yet — with no outline, every competitor heading is reported as a gap.

    Returns a dict with ``competitors`` (SERP cards), ``competitor_headings``,
    ``our_headings``, ``covered`` (competitor headings we already address, with
    the outline heading that matched), ``gaps`` (competitor headings we miss —
    the actionable list), ``extra`` (our headings rivals lack — differentiators)
    and ``coverage_pct``.
    """
    comp_headings = _competitor_headings(research)
    our_headings = _outline_headings(outline)

    comp_tokens = [(_tokens(h), h) for h in comp_headings]
    our_tokens = [_tokens(h) for h in our_headings]

    # Strip the ubiquitous brand/topic tokens so matching reflects the actual
    # subtopic, not the keyword every heading shares.
    common = _common_tokens([t for t, _ in comp_tokens])
    our_sig = [_distinguishing(toks, common) for toks in our_tokens]

    covered: list[dict] = []
    gaps: list[str] = []
    for toks, heading in comp_tokens:
        sig = _distinguishing(toks, common)
        # Best-matching outline heading by fraction of distinguishing tokens shared.
        best_frac, best_idx = 0.0, -1
        for idx, ours in enumerate(our_sig):
            frac = len(sig & ours) / len(sig) if sig else 0.0
            if frac > best_frac:
                best_frac, best_idx = frac, idx
        if best_frac >= _COVER_THRESHOLD and best_idx >= 0:
            covered.append({"heading": heading, "matched_by": our_headings[best_idx]})
        else:
            gaps.append(heading)

    # Our headings that no competitor heading substantially covers = differentiators.
    comp_sig = [_distinguishing(toks, common) for toks, _ in comp_tokens]
    extra = [
        h
        for h, sig in zip(our_headings, our_sig)
        if _best_overlap(sig, comp_sig) < _COVER_THRESHOLD
    ]

    total = len(comp_headings)
    coverage_pct = round(100 * len(covered) / total, 1) if total else 0.0

    return {
        "competitors": _serp_cards(research),
        "competitor_headings": comp_headings,
        "our_headings": our_headings,
        "covered": covered,
        "gaps": gaps,
        "extra": extra,
        "coverage_pct": coverage_pct,
    }
