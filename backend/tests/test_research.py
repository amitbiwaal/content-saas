"""Service-level tests for Research Intelligence (PRD §9.4, FR-4.1..4.5).

No DB / no TestClient — the router is wired by the integrator. These cover the
pure provider + normalisation layer against synthetic briefs.
"""

from app.research.provider import (
    AhrefsResearchProvider,
    MockResearchProvider,
    get_research_provider,
)
from app.research.service import gather_research

BRIEF = {
    "topic": "FeetFinder Review 2026",
    "keyword": "feetfinder reviews",
    "country": "US",
    "audience": "buyers evaluating the platform",
    "tone": "we-not-I",
    "goal": "rank on Google and appear in AI answers",
}

_REQUIRED_KEYS = {"serp", "headings", "paa", "entities", "sources", "intent"}
_VALID_INTENTS = {"informational", "commercial", "transactional", "navigational"}


def test_mock_provider_produces_all_keys():
    data = MockResearchProvider().gather(BRIEF)
    assert _REQUIRED_KEYS <= set(data)
    # FR-4.1/4.2: collections are non-empty lists.
    for key in ("serp", "headings", "paa", "entities", "sources"):
        assert isinstance(data[key], list) and data[key], f"{key} should be a non-empty list"
    # FR-4.4: difficulty/volume present.
    assert "keyword_difficulty" in data and "search_volume" in data


def test_mock_provider_is_deterministic():
    a = MockResearchProvider().gather(BRIEF)
    b = MockResearchProvider().gather(BRIEF)
    assert a == b


def test_mock_provider_varies_with_brief():
    other = {**BRIEF, "topic": "Best Running Shoes", "keyword": "running shoes"}
    assert MockResearchProvider().gather(BRIEF) != MockResearchProvider().gather(other)


def test_serp_results_have_expected_shape():
    serp = MockResearchProvider().gather(BRIEF)["serp"]
    first = serp[0]
    assert {"rank", "title", "url", "domain"} <= set(first)
    assert first["rank"] == 1


def test_intent_detection():
    assert MockResearchProvider().gather(
        {"topic": "buy widgets cheap", "keyword": "widget price"}
    )["intent"] == "transactional"
    assert MockResearchProvider().gather(
        {"topic": "Best CRM Compared", "keyword": "best crm"}
    )["intent"] == "commercial"
    assert MockResearchProvider().gather(
        {"topic": "How photosynthesis works", "keyword": "photosynthesis"}
    )["intent"] == "informational"


def test_gather_research_normalises_and_tags_provider():
    out = gather_research(BRIEF, provider=MockResearchProvider())
    assert _REQUIRED_KEYS <= set(out)
    assert out["provider"] == "mock"
    assert out["intent"] in _VALID_INTENTS
    for key in ("serp", "headings", "paa", "entities", "sources"):
        assert isinstance(out[key], list)


def test_gather_research_is_deterministic():
    assert gather_research(BRIEF, provider=MockResearchProvider()) == gather_research(
        BRIEF, provider=MockResearchProvider()
    )


def test_gather_research_handles_empty_brief():
    out = gather_research({}, provider=MockResearchProvider())
    assert _REQUIRED_KEYS <= set(out)
    assert out["intent"] in _VALID_INTENTS


def test_ahrefs_stub_returns_mock_shape_with_todo():
    data = AhrefsResearchProvider(api_key="").gather(BRIEF)
    assert _REQUIRED_KEYS <= set(data)
    assert "_todo" in data
    # Service tags the resolving provider name as "ahrefs".
    out = gather_research(BRIEF, provider=AhrefsResearchProvider(api_key="x"))
    assert out["provider"] == "ahrefs"


def test_get_research_provider_defaults_to_mock(monkeypatch):
    # With research_provider == "mock" (the code default) the mock is returned.
    # Force the setting so the test is independent of a local .env that may select
    # a live provider (duckduckgo/brave).
    from types import SimpleNamespace

    import app.config as cfg

    monkeypatch.setattr(
        cfg,
        "get_settings",
        lambda: SimpleNamespace(
            research_provider="mock", brave_api_key="", ahrefs_api_key=""
        ),
    )
    assert isinstance(get_research_provider(), MockResearchProvider)
