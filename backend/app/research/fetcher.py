"""Fetch + analyse real competitor pages (competitor-research stage).

Given the real SERP for the primary keyword, this module downloads the
top-ranking pages and extracts what actually makes them rank: their title,
H1/H2/H3 structure, approximate word count, and whether they use comparison
tables or an FAQ. The council debates and the outline is built against this
REAL structure — not templated guesses — which is what lets the article
out-cover the current page one.

Design constraints:

* Zero new dependencies — ``httpx`` (already used by the research providers) +
  stdlib regex parsing. This is heading/length extraction, not a DOM pipeline.
* Never raises: a page that fails to download or parse is simply skipped, so a
  slow/blocked site can never break the run. With no network at all the caller
  just gets ``[]`` and the pipeline continues on SERP snippets alone.
* Bounded: N pages, fetched concurrently, each capped in size and time.
"""

from __future__ import annotations

import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from html import unescape

# How many top results to download and analyse. 6 covers "page one" signal
# without turning the stage into a crawl.
_MAX_PAGES = 6
_TIMEOUT_S = 10.0
_MAX_BYTES = 600_000  # per page; headings live early, no need for megabytes
_MAX_WORKERS = 4

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)

# Drop these blocks wholesale before text/heading extraction — nav/footer/script
# noise otherwise pollutes headings and inflates word counts.
_STRIP_BLOCKS = re.compile(
    r"<(script|style|noscript|svg|nav|footer|header|form|iframe)\b.*?</\1>",
    re.IGNORECASE | re.DOTALL,
)
_TAG = re.compile(r"<[^>]+>")
_HEADING = re.compile(r"<h([1-3])\b[^>]*>(.*?)</h\1>", re.IGNORECASE | re.DOTALL)
_TITLE = re.compile(r"<title\b[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_FAQ_HINT = re.compile(r"\b(faq|frequently asked|common questions)\b", re.IGNORECASE)

# Domains that block scrapers or are not articles — skip without wasting a slot.
_SKIP_DOMAINS = (
    "youtube.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
    "linkedin.com", "pinterest.com", "tiktok.com", "amazon.",
)


def _clean_text(html_fragment: str) -> str:
    """Tag-strip + entity-unescape one fragment into plain text."""
    return unescape(_TAG.sub(" ", html_fragment)).replace("\xa0", " ").strip()


def _looks_like_navigation(text: str) -> bool:
    """Filter heading noise: empty, one-word chrome, or absurdly long strings."""
    words = text.split()
    if not words or len(text) > 140:
        return True
    if len(words) == 1 and text.lower() in (
        "menu", "search", "share", "comments", "contents", "newsletter",
        "related", "categories", "tags", "login", "subscribe",
    ):
        return True
    return False


def analyze_page_html(html: str, *, url: str = "", domain: str = "") -> dict | None:
    """Extract structure signals from one page's HTML. Pure + deterministic.

    Returns ``{domain, url, title, h1, headings, word_count, has_table,
    has_faq}`` or ``None`` when the page yields no usable article signal.
    ``headings`` is the ordered H2/H3 text list (the page's table of contents).
    """
    if not html:
        return None
    body = _STRIP_BLOCKS.sub(" ", html)

    title_match = _TITLE.search(html)
    title = _clean_text(title_match.group(1))[:200] if title_match else ""

    h1 = ""
    headings: list[str] = []
    for level, inner in _HEADING.findall(body):
        text = re.sub(r"\s+", " ", _clean_text(inner))
        if not text or _looks_like_navigation(text):
            continue
        if level == "1":
            h1 = h1 or text[:160]
        else:
            headings.append(text[:160])
    # An article page has a heading structure; a storefront/JS shell does not.
    if not headings and not h1:
        return None

    words = len(re.findall(r"\b\w+\b", _TAG.sub(" ", body)))
    return {
        "domain": domain,
        "url": url,
        "title": title or h1,
        "h1": h1,
        "headings": headings[:24],
        "word_count": words,
        "has_table": "<table" in body.lower(),
        "has_faq": bool(_FAQ_HINT.search(" ".join(headings) or body[:20000])),
    }


def _fetch_one(item: dict) -> dict | None:
    """Download + analyse one SERP result. Never raises."""
    import httpx

    url = item.get("url") or ""
    domain = (item.get("domain") or "").lower()
    if not url.startswith("http"):
        return None
    try:
        with httpx.Client(
            headers={
                "User-Agent": _UA,
                "Accept": "text/html,application/xhtml+xml",
                "Accept-Language": "en-US,en;q=0.9",
            },
            timeout=_TIMEOUT_S,
            follow_redirects=True,
        ) as client:
            with client.stream("GET", url) as resp:
                if resp.status_code != 200:
                    return None
                ctype = resp.headers.get("content-type", "")
                if "html" not in ctype:
                    return None
                chunks: list[bytes] = []
                size = 0
                for chunk in resp.iter_bytes():
                    chunks.append(chunk)
                    size += len(chunk)
                    if size >= _MAX_BYTES:
                        break
        html = b"".join(chunks).decode("utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - a dead page is skipped, never fatal
        return None
    return analyze_page_html(html, url=url, domain=domain)


def fetch_competitor_pages(serp: list[dict], *, max_pages: int = _MAX_PAGES) -> list[dict]:
    """Fetch + analyse the top SERP pages concurrently (order preserved).

    Skips social/video/storefront domains and dedupes by domain so the analysis
    reflects distinct ranking articles. Returns at most ``max_pages`` entries;
    an unreachable web (offline/test) returns ``[]``.
    """
    picked: list[dict] = []
    seen: set[str] = set()
    for item in serp or []:
        if not isinstance(item, dict):
            continue
        domain = (item.get("domain") or "").lower()
        url = item.get("url") or ""
        if not domain or domain in seen or not url.startswith("http"):
            continue
        if any(s in domain for s in _SKIP_DOMAINS):
            continue
        seen.add(domain)
        picked.append(item)
        if len(picked) >= max_pages:
            break
    if not picked:
        return []

    results: dict[int, dict] = {}
    with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, len(picked))) as pool:
        futures = {pool.submit(_fetch_one, item): i for i, item in enumerate(picked)}
        for fut in as_completed(futures):
            try:
                page = fut.result()
            except Exception:  # noqa: BLE001 - defensive; _fetch_one already guards
                page = None
            if page:
                results[futures[fut]] = page
    return [results[i] for i in sorted(results)]


def competitor_headings(pages: list[dict], *, cap: int = 40) -> list[str]:
    """Flatten fetched pages into one deduped heading list (research.headings).

    Order interleaves pages (first heading of each page, then second, ...) so a
    single long page can't crowd out the rest within the cap.
    """
    out: list[str] = []
    seen: set[str] = set()
    columns = [p.get("headings") or [] for p in pages]
    for i in range(max((len(c) for c in columns), default=0)):
        for col in columns:
            if i >= len(col):
                continue
            text = col[i]
            key = text.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(text)
            if len(out) >= cap:
                return out
    return out
