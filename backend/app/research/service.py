"""Research normalisation service (PRD §9.4, FR-4.5).

:func:`gather_research` is a PURE function: it takes a brief, runs the configured
:class:`~app.research.provider.ResearchProvider`, and normalises the raw signals
into the single dict the AI Council consumes (FR-4.5). No DB access lives here —
persistence is the router's job — so the function is trivially unit-testable.

The output keys mirror the :class:`~app.models.Research` columns
(``serp``/``headings``/``paa``/``entities``/``sources``/``intent``) plus the
resolving ``provider`` name, so the router can persist it field-for-field.
"""

from __future__ import annotations

from typing import Any

from app.research.provider import ResearchProvider, get_research_provider

# Intents we accept verbatim from a provider; anything else is normalised to the
# safe default so the council always sees a known value (FR-4.4/4.5).
_VALID_INTENTS = frozenset(
    {"informational", "commercial", "transactional", "navigational"}
)


def _as_list(value: Any) -> list:
    """Coerce a possibly-missing/odd value into a list (defensive normalisation)."""
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def gather_research(
    brief: dict, provider: ResearchProvider | None = None
) -> dict:
    """Gather and normalise research for ``brief`` (FR-4.5).

    Runs ``provider`` (or the configured default) and shapes the raw signals into
    the canonical brief the council consumes::

        {serp, headings, paa, entities, sources, intent, provider,
         keyword_difficulty, search_volume}

    All list fields are guaranteed to be lists and ``intent`` is guaranteed to be
    one of the four canonical intents, so downstream consumers never have to
    defend against missing/odd shapes. The function is pure and DB-free.
    """
    provider = provider or get_research_provider()

    # Defensive: a provider should never raise on the deterministic path, but if a
    # future real provider does, degrade to an empty-but-valid brief rather than
    # breaking the pipeline (mirrors the LLM layer's fallback contract).
    try:
        raw = provider.gather(brief) or {}
    except Exception:  # noqa: BLE001 - resilience boundary, see docstring
        raw = {}

    intent = str(raw.get("intent") or "informational").strip().lower()
    if intent not in _VALID_INTENTS:
        intent = "informational"

    normalised: dict = {
        "serp": _as_list(raw.get("serp")),
        "headings": _as_list(raw.get("headings")),
        "paa": _as_list(raw.get("paa")),
        "entities": _as_list(raw.get("entities")),
        "sources": _as_list(raw.get("sources")),
        "intent": intent,
        "provider": getattr(provider, "name", "mock"),
    }

    # Carry optional difficulty/volume signals when present (FR-4.4); they live
    # outside the Research columns so the router can ignore them when persisting.
    if "keyword_difficulty" in raw:
        normalised["keyword_difficulty"] = raw["keyword_difficulty"]
    if "search_volume" in raw:
        normalised["search_volume"] = raw["search_volume"]

    return normalised


def enrich_with_competitor_pages(
    research_norm: dict, keywords: dict | None, brief: dict | None = None
) -> dict:
    """Overlay REAL competitor-page structure + the keyword set onto research.

    Downloads the top SERP pages (:mod:`app.research.fetcher`) and replaces the
    templated ``headings`` with what those pages actually cover; attaches the
    per-page analysis as ``competitors``, mines the pages' prose into the
    evidence bank (``facts`` — the writer's only allowed source of figures) and
    carries the keyword-research output as ``keywords``. Longtail questions top
    up a thin ``paa`` list so the FAQ is never built from guesses when real
    queries exist. Never raises — offline the research passes through unchanged
    (mock contract).
    """
    from app.research.evidence import extract_evidence
    from app.research.fetcher import competitor_headings, fetch_competitor_pages

    # Only fetch pages a real provider actually found — the mock SERP fabricates
    # example*.com URLs that don't exist (and tests must stay offline).
    pages: list = []
    if research_norm.get("provider") != "mock":
        try:
            pages = fetch_competitor_pages(research_norm.get("serp") or [])
        except Exception:  # noqa: BLE001 - resilience boundary (never break the run)
            pages = []
    if pages:
        research_norm["competitors"] = pages
        real_headings = competitor_headings(pages)
        if real_headings:
            research_norm["headings"] = real_headings
        evidence_brief = {
            "topic": (brief or {}).get("topic", ""),
            "keyword": (brief or {}).get("keyword")
            or (keywords or {}).get("primary", ""),
        }
        try:
            research_norm["facts"] = extract_evidence(pages, evidence_brief)
        except Exception:  # noqa: BLE001 - evidence is an enhancement, never fatal
            research_norm["facts"] = {"facts": [], "consensus": [], "disagreements": []}
    else:
        research_norm.setdefault("competitors", [])
        research_norm.setdefault(
            "facts", {"facts": [], "consensus": [], "disagreements": []}
        )

    if keywords:
        research_norm["keywords"] = keywords
        # Prefer the derived intent when the provider only guessed heuristically.
        if keywords.get("intent") in _VALID_INTENTS:
            research_norm["intent"] = keywords["intent"]
        longtail = [q for q in keywords.get("longtail") or [] if isinstance(q, str)]
        if longtail:
            seen = {str(q).strip().lower() for q in research_norm.get("paa") or []}
            merged = list(research_norm.get("paa") or [])
            merged.extend(q for q in longtail if q.strip().lower() not in seen)
            research_norm["paa"] = merged[:10]
    return research_norm


def gather_full_research(brief: dict) -> dict:
    """One-call research: keywords + real SERP + fetched competitor pages.

    Used by the standalone research endpoint so a manual (re)run produces the
    same enriched artifact as the two pipeline stages combined.
    """
    from app.research.keywords import research_keywords

    keywords = research_keywords(brief)
    resolved = {**brief, "keyword": (brief.get("keyword") or keywords.get("primary") or "")}
    research_norm = gather_research(resolved)
    return enrich_with_competitor_pages(research_norm, keywords, resolved)
