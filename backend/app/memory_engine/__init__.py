"""Content Memory + Internal Links engine (PRD §9.11, FR-11.1..11.3).

Maintains a per-website knowledge graph of covered topics (``Memory`` rows,
FR-11.1), suggests internal links with anchor text for the current draft
(FR-11.2), and warns on duplicate / thin overlapping content with a merge / 301
suggestion (FR-11.3). Topical authority coverage by cluster (FR-11.4) is surfaced
via :func:`topic_coverage`.

Service functions are PURE (dicts in -> dicts/dataclasses out) so they unit-test
without a DB or any provider keys; DB persistence lives in the router on the
request ``Session``. There is no hard LLM dependency here — matching draft
entities/headings to existing topic nodes is a deterministic heuristic — so the
module works end-to-end with zero API keys.
"""

from app.memory_engine.service import (
    LinkSuggestion,
    OverlapReport,
    detect_overlap,
    suggest_internal_links,
    topic_coverage,
    upsert_topic_node,
)

__all__ = [
    "LinkSuggestion",
    "OverlapReport",
    "detect_overlap",
    "suggest_internal_links",
    "topic_coverage",
    "upsert_topic_node",
]
