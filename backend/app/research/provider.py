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
import re
from abc import ABC, abstractmethod
from html import unescape

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


def _domain_from_url(url: str) -> str:
    """Best-effort hostname (sans ``www.``) from a URL — for display + trust."""
    try:
        from urllib.parse import urlsplit

        host = urlsplit(url).hostname or ""
    except Exception:  # noqa: BLE001 - never fail research on a bad URL
        host = ""
    return host[4:] if host.startswith("www.") else host


def _strip_html(text: str) -> str:
    """Drop the ``<strong>`` highlight tags Brave wraps around query terms."""
    out, depth = [], 0
    for ch in text:
        if ch == "<":
            depth += 1
        elif ch == ">":
            depth = max(0, depth - 1)
        elif depth == 0:
            out.append(ch)
    return "".join(out).strip()


def _clean_html(text: str) -> str:
    """Strip all HTML tags and unescape entities (for scraped result text)."""
    return unescape(re.sub(r"<[^>]+>", "", text)).strip()


# Domains we treat as high-trust citations without further inspection (FR-4.2).
_HIGH_TRUST = frozenset(
    {"wikipedia.org", "reuters.com", "apnews.com", "nature.com", "who.int",
     "nih.gov", "ncbi.nlm.nih.gov", "bbc.com", "britannica.com"}
)


def _trust_for(domain: str) -> str:
    """Coarse citation-trust label for a real domain (high | medium)."""
    d = domain.lower()
    if d in _HIGH_TRUST or d.endswith((".gov", ".edu", ".int")):
        return "high"
    if any(d == h or d.endswith("." + h) for h in _HIGH_TRUST):
        return "high"
    return "medium"


def _finalize(base: dict, items: list[dict], provider: str, max_sources: int = 10) -> dict:
    """Overlay real search ``items`` (title/url/domain/snippet) onto a mock base.

    Shared by the real-web providers so SERP + citation-source shaping (rank,
    domain dedupe, trust labelling) lives in one place.
    """
    serp: list[dict] = []
    for i, it in enumerate(items, start=1):
        dom = it.get("domain") or _domain_from_url(it.get("url", ""))
        serp.append(
            {
                "rank": i,
                "title": it.get("title") or dom,
                "url": it.get("url", ""),
                "domain": dom,
                "snippet": it.get("snippet", ""),
                "favicon": it.get("favicon", ""),
            }
        )
    if not serp:
        return base
    base["serp"] = serp
    sources: list[dict] = []
    seen: set[str] = set()
    for it in serp:
        dom = it["domain"]
        if not dom or dom in seen:
            continue
        seen.add(dom)
        sources.append(
            {
                "title": it["title"],
                "url": it["url"],
                "trust": _trust_for(dom),
                "favicon": it.get("favicon", ""),
                "domain": dom,
            }
        )
        if len(sources) >= max_sources:
            break
    base["sources"] = sources
    base["provider"] = provider
    return base


class BraveResearchProvider(ResearchProvider):
    """Real web research via the Brave Web Search API (PRD §9.4, FR-4.1..4.4).

    Runs an actual web search for the brief's keyword and overlays the **real**
    ranked results (title, URL, domain, snippet, favicon) and citation sources
    onto the deterministic mock base — so the council/UI shows the same websites
    a human (or Claude/ChatGPT) would browse, while fields Brave does not expose
    (competitor H2 headings) keep their deterministic mock values.

    **Resilient by contract:** with no key, or on any API/parse error, it degrades
    fully to :class:`MockResearchProvider` (mirrors the LLM + Ahrefs layers).
    """

    name = "brave"
    _ENDPOINT = "https://api.search.brave.com/res/v1/web/search"

    def __init__(self, api_key: str | None = None, count: int = 10) -> None:
        self.api_key = api_key or ""
        self.count = count
        self._fallback = MockResearchProvider()

    def gather(self, brief: dict) -> dict:
        data = self._fallback.gather(brief)  # complete, deterministic base
        if not self.api_key:
            data["_todo"] = "No Brave key — returning mock shape."
            return data
        try:
            self._overlay(brief, data)
        except Exception as exc:  # noqa: BLE001 - resilience boundary
            data["_brave_error"] = str(exc)
        return data

    def _overlay(self, brief: dict, data: dict) -> None:
        """Replace SERP/sources/PAA with real Brave results (best-effort)."""
        import httpx

        query = (brief.get("keyword") or brief.get("topic") or "").strip()
        if not query:
            return
        country = (brief.get("country") or "US").strip().upper() or "US"

        resp = httpx.get(
            self._ENDPOINT,
            params={"q": query, "country": country, "count": self.count},
            headers={
                "X-Subscription-Token": self.api_key,
                "Accept": "application/json",
            },
            timeout=15,
        )
        resp.raise_for_status()
        payload = resp.json() or {}

        results = ((payload.get("web") or {}).get("results")) or []
        serp: list[dict] = []
        for i, r in enumerate(results, start=1):
            url = r.get("url") or ""
            meta = r.get("meta_url") or {}
            domain = (meta.get("hostname") or _domain_from_url(url) or "").lstrip("www.")
            serp.append(
                {
                    "rank": i,
                    "title": _strip_html(r.get("title") or "") or domain,
                    "url": url,
                    "domain": domain,
                    "snippet": _strip_html(r.get("description") or ""),
                    "favicon": meta.get("favicon") or (r.get("profile") or {}).get("img") or "",
                }
            )
        if serp:
            data["serp"] = serp
            # Citation sources: top unique domains from the real SERP (FR-4.2).
            sources: list[dict] = []
            seen: set[str] = set()
            for item in serp:
                dom = item["domain"]
                if not dom or dom in seen:
                    continue
                seen.add(dom)
                sources.append(
                    {
                        "title": item["title"],
                        "url": item["url"],
                        "trust": _trust_for(dom),
                        "favicon": item["favicon"],
                        "domain": dom,
                    }
                )
                if len(sources) >= 6:
                    break
            if sources:
                data["sources"] = sources

        # People-Also-Ask style questions, when Brave returns an FAQ block.
        faq = ((payload.get("faq") or {}).get("results")) or []
        questions = [q.get("question") for q in faq if q.get("question")]
        if questions:
            data["paa"] = questions[:6]

        data["provider"] = "brave"


class DuckDuckGoResearchProvider(ResearchProvider):
    """Real web research via DuckDuckGo's HTML endpoint — free, no API key.

    Scrapes DuckDuckGo's public HTML results page for the brief's keyword and
    overlays the **real** ranked results (title, URL, domain, snippet) and
    citation sources onto the deterministic mock base — so the council/UI shows
    the same websites a human would browse, with **zero cost, no key, no signup**.

    **Resilient by contract:** on any network/parse error, a rate-limit, or an
    empty result set, it degrades fully to :class:`MockResearchProvider` (mirrors
    the LLM + Brave layers). Being a scraper it is best-effort — prefer
    :class:`BraveResearchProvider` when reliability matters.
    """

    name = "duckduckgo"
    # Two mirrors with different markup; we try html first, fall back to lite.
    _ENDPOINTS = (
        ("https://html.duckduckgo.com/html/", "html"),
        ("https://lite.duckduckgo.com/lite/", "lite"),
    )
    # Rotate a few realistic desktop UAs to look less like a single scraper.
    _UAS = (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.1 Safari/605.1.15",
        "Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0",
    )

    def __init__(
        self, count: int = 10, max_queries: int = 5, cap: int = 30
    ) -> None:
        self.count = count            # results pulled per sub-search
        self.max_queries = max_queries  # how many angles to search (deep research)
        self.cap = cap                # max unique results kept after aggregation
        self._fallback = MockResearchProvider()

    def gather(self, brief: dict) -> dict:
        data = self._fallback.gather(brief)  # complete, deterministic base
        try:
            self._overlay(brief, data)
        except Exception as exc:  # noqa: BLE001 - resilience boundary
            data["_ddg_error"] = str(exc)
        return data

    def _deep_queries(self, brief: dict) -> list[str]:
        """Expand the brief into several real search angles (deep research).

        A human researching a topic doesn't run one query — they check reviews,
        alternatives, pricing, legitimacy, complaints, comparisons. We search each
        angle and aggregate, so the council sees the *breadth* of the web, not just
        the first page for one phrase.
        """
        kw = (brief.get("keyword") or "").strip()
        topic = (brief.get("topic") or "").strip()
        base = kw or topic
        if not base:
            return []
        variants = [
            base,
            f"{base} reviews",
            f"{base} alternatives",
            f"{base} pricing cost",
            f"is {base} legit safe",
            f"{base} complaints problems",
            f"{base} vs competitors",
        ]
        if topic and topic.lower() != base.lower():
            variants.append(topic)
        out: list[str] = []
        seen: set[str] = set()
        for q in variants:
            key = q.lower()
            if key not in seen:
                seen.add(key)
                out.append(q)
            if len(out) >= self.max_queries:
                break
        return out

    def _parse(self, page: str, kind: str) -> list[tuple[str, str, str]]:
        """Extract (href, title_html, snippet_html) rows from a results page."""
        if kind == "lite":
            anchors = re.findall(
                r'<a[^>]*class="result-link"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
                page, re.S,
            )
            snips = re.findall(
                r'class="result-snippet"[^>]*>(.*?)</td>', page, re.S
            )
        else:  # html
            anchors = re.findall(
                r'<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>',
                page, re.S,
            )
            snips = re.findall(r'class="result__snippet"[^>]*>(.*?)</a>', page, re.S)
        return [
            (href, title, snips[i] if i < len(snips) else "")
            for i, (href, title) in enumerate(anchors)
        ]

    def _fetch(self, query: str, country: str) -> list[dict]:
        """Run one search, trying each mirror until one returns real rows."""
        import httpx
        from urllib.parse import unquote

        ua = self._UAS[_seed(query) % len(self._UAS)]
        headers = {
            "User-Agent": ua,
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://duckduckgo.com/",
        }
        for endpoint, kind in self._ENDPOINTS:
            try:
                resp = httpx.post(
                    endpoint,
                    data={"q": query, "kl": f"{country}-en"},
                    headers=headers,
                    timeout=15,
                    follow_redirects=True,
                )
            except Exception:  # noqa: BLE001 - try the next mirror
                continue
            # 202 is DuckDuckGo's bot-challenge; a real result page is 200.
            if resp.status_code != 200:
                continue
            rows = self._parse(resp.text, kind)
            if not rows:
                continue
            items: list[dict] = []
            for i, (href, title_html, snip_html) in enumerate(rows[: self.count]):
                m = re.search(r"uddg=([^&]+)", href)
                url = unquote(m.group(1)) if m else href
                if url.startswith("//"):
                    url = "https:" + url
                domain = _domain_from_url(url)
                if not domain:
                    continue
                items.append(
                    {
                        "rank_in_q": i + 1,
                        "title": _clean_html(title_html) or domain,
                        "url": url,
                        "domain": domain,
                        "snippet": _clean_html(snip_html),
                    }
                )
            if items:
                return items
        return []

    def _overlay(self, brief: dict, data: dict) -> None:
        """Run several searches, aggregate + dedupe into one deep SERP."""
        import random
        import time

        queries = self._deep_queries(brief)
        if not queries:
            return
        country = (brief.get("country") or "US").strip().lower() or "us"

        # Sequential with jitter — a polite cadence trips DuckDuckGo's rate limiter
        # far less than a concurrent burst. A blocked query just contributes nothing.
        batches: list[list[dict]] = []
        for i, q in enumerate(queries):
            if i:
                time.sleep(0.3 + random.random() * 0.6)
            try:
                batches.append(self._fetch(q, country))
            except Exception:  # noqa: BLE001 - resilience boundary
                batches.append([])

        # Aggregate by URL; a page found across multiple angles is more relevant,
        # so rank by (# of searches it appeared in) then its best per-search rank.
        agg: dict[str, dict] = {}
        for items in batches:
            for it in items:
                key = it["url"].rstrip("/").lower()
                cur = agg.get(key)
                if cur is None:
                    agg[key] = {**it, "hits": 1, "best": it["rank_in_q"]}
                else:
                    cur["hits"] += 1
                    cur["best"] = min(cur["best"], it["rank_in_q"])
        if not agg:
            return

        ranked = sorted(agg.values(), key=lambda x: (-x["hits"], x["best"]))
        serp = [
            {
                "rank": i,
                "title": it["title"],
                "url": it["url"],
                "domain": it["domain"],
                "snippet": it["snippet"],
                "favicon": "",  # frontend derives one from the domain
            }
            for i, it in enumerate(ranked[: self.cap], start=1)
        ]
        data["serp"] = serp

        sources: list[dict] = []
        seen: set[str] = set()
        for item in serp:
            dom = item["domain"]
            if dom in seen:
                continue
            seen.add(dom)
            sources.append(
                {
                    "title": item["title"],
                    "url": item["url"],
                    "trust": _trust_for(dom),
                    "favicon": "",
                    "domain": dom,
                }
            )
            if len(sources) >= 10:
                break
        data["sources"] = sources
        data["provider"] = "duckduckgo"


class HybridResearchProvider(ResearchProvider):
    """Free DuckDuckGo first, reliable LLM web search as fallback (user's pick).

    Runs the free :class:`DuckDuckGoResearchProvider` deep search; if DuckDuckGo
    returns real results, those are used (zero cost). If DuckDuckGo is rate-limited
    or empty, it falls back to **real web search via the operator's existing keys**
    — OpenAI's ``gpt-4o-search-preview`` first, then xAI Grok Live Search — so deep
    research is always backed by real websites without any new signup or card. If
    every path fails it degrades to the deterministic mock.
    """

    name = "hybrid"

    def __init__(self) -> None:
        self._ddg = DuckDuckGoResearchProvider()
        self._fallback = MockResearchProvider()

    def gather(self, brief: dict) -> dict:
        # 1) Free DuckDuckGo. It marks provider="duckduckgo" only on real success.
        data = self._ddg.gather(brief)
        if data.get("provider") == "duckduckgo" and data.get("serp"):
            return data
        # 2) DuckDuckGo blocked/empty -> reliable web search on existing keys.
        try:
            llm = self._llm_search(brief)
        except Exception as exc:  # noqa: BLE001 - resilience boundary
            data["_hybrid_error"] = str(exc)
            llm = None
        return llm if llm is not None else data

    def _llm_search(self, brief: dict) -> dict | None:
        from app.config import get_settings

        settings = get_settings()
        query = (brief.get("keyword") or brief.get("topic") or "").strip()
        if not query:
            return None
        base = self._fallback.gather(brief)

        if settings.openai_api_key:
            try:
                items = self._openai_search(query, settings.openai_api_key)
                if items:
                    return _finalize(base, items, "web·openai")
            except Exception:  # noqa: BLE001 - try the next backend
                pass
        if settings.xai_api_key:
            try:
                model = settings.xai_model or "grok-4"
                items = self._xai_search(query, settings.xai_api_key, model)
                if items:
                    return _finalize(base, items, "web·grok")
            except Exception:  # noqa: BLE001 - fall through to mock
                pass
        return None

    def _openai_search(self, query: str, key: str) -> list[dict]:
        """Real web search via OpenAI ``gpt-4o-search-preview`` (url citations)."""
        import httpx

        resp = httpx.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": "gpt-4o-search-preview",
                "web_search_options": {"search_context_size": "high"},
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            f"Research '{query}' on the web. Cover reviews, "
                            "alternatives, pricing, legitimacy and complaints, and "
                            "cite as many distinct authoritative sources as you can."
                        ),
                    }
                ],
            },
            timeout=45,
        )
        resp.raise_for_status()
        choices = resp.json().get("choices") or [{}]
        anns = (choices[0].get("message") or {}).get("annotations") or []
        items: list[dict] = []
        seen: set[str] = set()
        for a in anns:
            uc = a.get("url_citation") or {}
            url = uc.get("url") or ""
            dom = _domain_from_url(url)
            if not dom or url in seen:
                continue
            seen.add(url)
            items.append(
                {"title": _clean_html(uc.get("title") or dom), "url": url, "domain": dom, "snippet": ""}
            )
        return items

    def _xai_search(self, query: str, key: str, model: str) -> list[dict]:
        """Real web search via xAI Grok Live Search (returns citation URLs)."""
        import httpx

        resp = httpx.post(
            "https://api.x.ai/v1/chat/completions",
            headers={"Authorization": f"Bearer {key}"},
            json={
                "model": model,
                "messages": [
                    {
                        "role": "user",
                        "content": (
                            f"Search the web for '{query}' and list the most "
                            "relevant authoritative sources you used."
                        ),
                    }
                ],
                "search_parameters": {
                    "mode": "on",
                    "return_citations": True,
                    "sources": [{"type": "web"}],
                },
            },
            timeout=45,
        )
        resp.raise_for_status()
        cites = resp.json().get("citations") or []
        items: list[dict] = []
        seen: set[str] = set()
        for url in cites:
            if not isinstance(url, str):
                continue
            dom = _domain_from_url(url)
            if not dom or url in seen:
                continue
            seen.add(url)
            items.append({"title": dom, "url": url, "domain": dom, "snippet": ""})
        return items


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

    if choice == "hybrid":
        return HybridResearchProvider()
    if choice in ("duckduckgo", "ddg"):
        return DuckDuckGoResearchProvider()
    if choice == "brave":
        return BraveResearchProvider(api_key=settings.brave_api_key)
    if choice == "ahrefs":
        return AhrefsResearchProvider(api_key=settings.ahrefs_api_key)
    return MockResearchProvider()
