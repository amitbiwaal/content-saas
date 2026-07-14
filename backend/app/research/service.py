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
