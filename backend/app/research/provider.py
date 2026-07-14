"""Research data providers (PRD §9.4, FR-4.1..4.4).

A :class:`ResearchProvider` turns a project *brief* (topic + keyword + country)
into the raw research signals the council needs: SERP results, competitor H2
headings, People Also Ask, entities, trusted citation sources and search
intent.

Two implementations ship:

* :class:`MockResearchProvider` — fully deterministic, derived from the brief's
  topic + keyword. It needs no network or API key, so the whole pipeline runs
  with zero spend and tests are reproducible.
* :class:`AhrefsResearchProvider` — a stub that returns the same shape with a
  TODO note; real Ahrefs API v3 wiring (keyword difficulty/volume, SERP
  overview, related terms) is a manual follow-up once a key is supplied.

:func:`get_research_provider` reads ``settings.research_provider`` (``ahrefs`` |
``mock``) and defaults to the mock — mirroring the provider-key fallback used by
the LLM adapter layer.
"""

from __future__ import annotations

import hashlib
from abc import ABC, abstractmethod

# A small, deterministic stop-word set so heuristic keyword/entity extraction
# does not surface filler tokens. Intentionally tiny — this is a heuristic, not
# an NLP pipeline.
_STOP_WORDS = frozenset(
    {
        "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "is",
        "are", "with", "best", "review", "reviews", "guide", "how", "what",
        "why", "vs", "your", "you", "we", "i", "it", "this", "that",
    }
)

# Trusted citation source archetypes (FR-4.2). Real providers replace these with
# observed top-ranking / authoritative domains for the topic.
_TRUSTED_SOURCE_HINTS = (
    ("Wikipedia", "https://en.wikipedia.org/wiki/{slug}"),
    ("Official documentation", "https://{slug}.com/docs"),
    ("Reuters", "https://www.reuters.com/search/?q={slug}"),
)


def _seed(*parts: str) -> int:
    """Stable integer seed from arbitrary text parts (deterministic across runs)."""
    digest = hashlib.sha256("\x00".join(parts).encode("utf-8")).hexdigest()
    return int(digest[:12], 16)


def _slug(text: str) -> str:
    return "-".join(t for t in _tokens(text)) or "topic"


def _tokens(text: str) -> list[str]:
    """Lower-cased alpha-numeric tokens, stop-words removed, order preserved."""
    cleaned = "".join(c.lower() if c.isalnum() else " " for c in text)
    out: list[str] = []
    seen: set[str] = set()
    for tok in cleaned.split():
        if tok in _STOP_WORDS or tok in seen or len(tok) < 2:
            continue
        seen.add(tok)
        out.append(tok)
    return out


def _detect_intent(topic: str, keyword: str) -> str:
    """Heuristic search-intent classification (FR-4.4).

    Maps obvious lexical signals to one of the four canonical intents. A real
    provider replaces this with SERP-feature + volume analysis.
    """
    text = f"{topic} {keyword}".lower()
    if any(w in text for w in ("buy", "price", "pricing", "deal", "discount", "coupon", "cheap")):
        return "transactional"
    if any(w in text for w in ("review", "best", "top", "vs", "compare", "comparison", "alternative")):
        return "commercial"
    if any(w in text for w in ("login", "sign in", "download", "official", "app", "website")):
        return "navigational"
    return "informational"


class ResearchProvider(ABC):
    """Source of raw research signals for a brief (PRD §9.4).

    Implementations are stateless; ``gather`` is a pure function of the brief so
    the result can be normalised and persisted by the service/router layer.
    """

    name: str = "base"

    @abstractmethod
    def gather(self, brief: dict) -> dict:
        """Return raw research signals for ``brief``.

        The returned dict must carry the keys ``serp``, ``headings``, ``paa``,
        ``entities``, ``sources`` and ``intent`` (FR-4.1..4.4). The service
        layer normalises this into the single brief the council consumes
        (FR-4.5).
        """
        raise NotImplementedError


class MockResearchProvider(ResearchProvider):
    """Deterministic research, derived from topic + keyword (no network).

    Every field is a pure function of the brief, so repeated calls return
    identical output and unit tests are reproducible — the research analogue of
    :class:`~app.providers.base.MockAdapter`.
    """

    name = "mock"

    def gather(self, brief: dict) -> dict:
        topic = (brief.get("topic") or "").strip() or "untitled topic"
        keyword = (brief.get("keyword") or "").strip() or topic
        country = (brief.get("country") or "US").strip() or "US"

        seed = _seed(topic, keyword, country)
        slug = _slug(keyword)
        terms = _tokens(f"{topic} {keyword}") or [slug]

        serp = self._serp(topic, keyword, slug, seed)
        return {
            "serp": serp,
            "headings": self._headings(topic, keyword, terms),
            "paa": self._paa(topic, keyword),
            "entities": self._entities(terms, seed),
            "sources": self._sources(slug),
            "intent": _detect_intent(topic, keyword),
            "keyword_difficulty": seed % 100,  # 0-99 (FR-4.4)
            "search_volume": 100 * (1 + seed % 200),  # deterministic estimate
        }

    # -- field builders ---------------------------------------------------- #
    def _serp(self, topic: str, keyword: str, slug: str, seed: int) -> list[dict]:
        """Top SERP results (FR-4.1)."""
        archetypes = [
            ("{topic}: Complete Guide", "guide"),
            ("Best {keyword} Compared", "compare"),
            ("{topic} Review", "review"),
            ("{keyword} Explained", "explained"),
            ("How {topic} Works", "how"),
        ]
        results: list[dict] = []
        for i, (title_tpl, path) in enumerate(archetypes, start=1):
            results.append(
                {
                    "rank": i,
                    "title": title_tpl.format(topic=topic, keyword=keyword),
                    "url": f"https://example{i}.com/{slug}-{path}",
                    "domain": f"example{i}.com",
                    "snippet": (
                        f"An overview of {keyword} covering {topic.lower()} "
                        f"with practical guidance."
                    ),
                }
            )
        return results

    def _headings(self, topic: str, keyword: str, terms: list[str]) -> list[str]:
        """Competitor H2 headings (FR-4.1)."""
        base = [
            f"What is {topic}?",
            f"How does {keyword} work?",
            f"Key features of {keyword}",
            f"Pros and cons of {keyword}",
            f"{topic} pricing and plans",
            f"Is {keyword} worth it?",
        ]
        # Add a couple of term-derived headings for variety, still deterministic.
        for term in terms[:2]:
            base.append(f"{term.capitalize()} considerations")
        return base

    def _paa(self, topic: str, keyword: str) -> list[str]:
        """People Also Ask questions (FR-4.1)."""
        return [
            f"Is {keyword} legit?",
            f"How much does {keyword} cost?",
            f"What are the best alternatives to {keyword}?",
            f"How do I get started with {topic}?",
            f"Is {topic} safe to use?",
        ]

    def _entities(self, terms: list[str], seed: int) -> list[dict]:
        """Salient entities for topical coverage (FR-4.2)."""
        kinds = ["concept", "product", "organization", "feature"]
        entities: list[dict] = []
        for i, term in enumerate(terms[:8]):
            entities.append(
                {
                    "name": term,
                    "type": kinds[(seed + i) % len(kinds)],
                    "salience": round(1.0 - i * 0.1, 2) if i < 10 else 0.1,
                }
            )
        return entities

    def _sources(self, slug: str) -> list[dict]:
        """Trusted citation sources for the topic (FR-4.2)."""
        return [
            {"title": title, "url": url.format(slug=slug), "trust": "high"}
            for title, url in _TRUSTED_SOURCE_HINTS
        ]


class AhrefsResearchProvider(ResearchProvider):
    """Ahrefs-backed research provider (PRD §15 SERP/keyword provider, FR-4.1..4.4).

    Calls the Ahrefs API v3 (Bearer auth) for real keyword volume/difficulty and
    related terms, and blends the deterministic mock for fields Ahrefs does not
    expose directly (SERP titles, competitor H2s) — so the council always gets a
    complete brief. **Resilient by contract:** with no key, or on any API error,
    it falls back fully to :class:`MockResearchProvider` (mirrors the LLM layer's
    "no key => deterministic mock"). The exact v3 field names are best-effort and
    flagged TODO; confirm against the account's plan when a key is supplied.
    """

    name = "ahrefs"
    _BASE = "https://api.ahrefs.com/v3"

    def __init__(self, api_key: str | None = None) -> None:
        self.api_key = api_key or ""
        self._fallback = MockResearchProvider()

    def gather(self, brief: dict) -> dict:
        data = self._fallback.gather(brief)  # complete, deterministic base
        if not self.api_key:
            data["_todo"] = "No Ahrefs key — returning mock shape."
            return data
        try:
            self._enrich(brief, data)
        except Exception as exc:  # noqa: BLE001 - resilience boundary
            data["_ahrefs_error"] = str(exc)
        return data

    def _enrich(self, brief: dict, data: dict) -> None:
        """Overlay real Ahrefs signals onto the base brief (best-effort)."""
        import httpx

        keyword = (brief.get("keyword") or brief.get("topic") or "").strip()
        country = (brief.get("country") or "US").strip().lower()
        if not keyword:
            return
        headers = {"Authorization": f"Bearer {self.api_key}", "Accept": "application/json"}

        # Keyword volume + difficulty (FR-4.4). TODO: confirm v3 path/params per plan.
        ov = httpx.get(
            f"{self._BASE}/keywords-explorer/overview",
            params={"keywords": keyword, "country": country, "select": "keyword,volume,difficulty"},
            headers=headers,
            timeout=30,
        )
        ov.raise_for_status()
        rows = (ov.json() or {}).get("keywords") or (ov.json() or {}).get("data") or []
        if rows:
            row = rows[0]
            if "volume" in row:
                data["search_volume"] = row["volume"]
            if "difficulty" in row:
                data["keyword_difficulty"] = row["difficulty"]

        # Related terms -> extra PAA-style questions / entities (FR-4.1/4.2).
        rel = httpx.get(
            f"{self._BASE}/keywords-explorer/related-terms",
            params={"keyword": keyword, "country": country, "limit": 10},
            headers=headers,
            timeout=30,
        )
        if rel.status_code == 200:
            terms = [t.get("keyword") for t in (rel.json() or {}).get("related_terms", []) if t.get("keyword")]
            if terms:
                data["entities"] = [{"name": t, "type": "related", "salience": 0.5} for t in terms[:8]]
        data["provider"] = "ahrefs"


def get_research_provider() -> ResearchProvider:
    """Resolve the configured research provider (PRD §9.4).

    Reads ``settings.research_provider`` (``ahrefs`` | ``mock``). Defaults to the
    deterministic mock — and falls back to it for any unknown value or a missing
    Ahrefs key — so research always runs with zero configuration.
    """
    from app.config import get_settings

    settings = get_settings()
    choice = (settings.research_provider or "mock").strip().lower()

    if choice == "ahrefs":
        return AhrefsResearchProvider(api_key=settings.ahrefs_api_key)
    return MockResearchProvider()
