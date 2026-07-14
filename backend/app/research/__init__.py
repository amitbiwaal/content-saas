"""Research Intelligence: normalised brief the council consumes (PRD §9.4).

Gathers SERP results, competitor headings, People Also Ask, entities, trusted
citation sources and search intent (FR-4.1..4.5), then normalises them into a
single dict the AI Council debates over (FR-4.5).
"""

from app.research.provider import (
    AhrefsResearchProvider,
    MockResearchProvider,
    ResearchProvider,
    get_research_provider,
)
from app.research.service import gather_research

__all__ = [
    "ResearchProvider",
    "MockResearchProvider",
    "AhrefsResearchProvider",
    "get_research_provider",
    "gather_research",
]
