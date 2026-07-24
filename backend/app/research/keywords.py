"""Keyword research stage — turn a described topic into a real keyword set.

The user describes what they want in plain language ("mera site ke liye standing
desk buying guide, India ke remote workers ke liye..."); this stage derives what
searchers actually type:

* ``primary``   — the one query the article should rank for (2-5 words).
* ``secondary`` — supporting keywords/variants to weave into headings + body.
* ``longtail``  — question-style queries (feed the FAQ + PAA coverage).
* ``intent``    — informational | commercial | transactional | navigational.
* ``rationale`` — one line a human can read on why the primary was chosen.

An LLM (json_mode) does the derivation; a deterministic heuristic guarantees a
usable result with zero API keys (same contract as every other stage). Pure —
no DB access; the pipeline persists the result on the Research row.
"""

from __future__ import annotations

import json
import re

from app.providers import ProviderError, ProviderRefusal, get_adapter

_VALID_INTENTS = frozenset(
    {"informational", "commercial", "transactional", "navigational"}
)

_STOPWORDS = frozenset(
    {
        "a", "an", "the", "for", "to", "of", "in", "on", "and", "or", "with",
        "write", "create", "make", "me", "my", "our", "about", "article",
        "post", "blog", "want", "need", "please", "that", "this", "which",
        "is", "are", "be", "it", "i", "we", "you",
    }
)

_SYSTEM = (
    "You are a senior SEO keyword researcher. The user describes an article they "
    "want. Derive the real search queries people type into Google for this topic.\n"
    "Rules:\n"
    "- primary: the ONE best query to rank for — 2 to 5 words, natural search "
    "phrasing (what a real person types, not a title), lowercase unless a brand "
    "name requires caps.\n"
    "- secondary: 5 to 8 distinct supporting queries/variants (synonyms, "
    "modifiers like best/cost/for beginners, related subtopics). No duplicates "
    "of the primary.\n"
    "- longtail: 4 to 6 full question queries real people search (how/what/why/"
    "is/can...), each ending with '?'.\n"
    "- intent: one of informational|commercial|transactional|navigational for "
    "the primary.\n"
    "- rationale: ONE short sentence on why the primary wins (searchability vs "
    "competition).\n"
    "Match the language of the user's description (e.g. Hindi topic -> Hindi "
    "keywords). Output STRICT JSON only: "
    '{"primary": str, "secondary": [str], "longtail": [str], '
    '"intent": str, "rationale": str}.'
)


def _clean_phrase(value: object, max_words: int = 10) -> str:
    """Normalise one keyword phrase: collapse whitespace, cap length."""
    text = re.sub(r"\s+", " ", str(value or "")).strip().strip('"').strip()
    if not text:
        return ""
    words = text.split()
    if len(words) > max_words:
        text = " ".join(words[:max_words])
    return text[:120]


def _clean_list(raw: object, *, cap: int, drop: set[str]) -> list[str]:
    """Dedupe/clean a list of phrases, skipping any already in ``drop``."""
    out: list[str] = []
    if isinstance(raw, list):
        for item in raw:
            phrase = _clean_phrase(item)
            key = phrase.lower()
            if not phrase or key in drop:
                continue
            drop.add(key)
            out.append(phrase)
            if len(out) >= cap:
                break
    return out


def _heuristic_keywords(brief: dict) -> dict:
    """Deterministic fallback: derive a keyword set from the topic text alone."""
    topic = (brief.get("topic") or "").strip() or "untitled topic"
    tokens = [
        t for t in re.findall(r"[A-Za-z0-9]+", topic.lower())
        if t not in _STOPWORDS and len(t) > 1
    ]
    primary = " ".join(tokens[:4]) or topic[:60].lower()
    secondary = [
        f"best {primary}",
        f"{primary} guide",
        f"{primary} comparison",
        f"how to choose {primary}",
        f"{primary} for beginners",
    ]
    longtail = [
        f"what should you know about {primary}?",
        f"how much does {primary} cost?",
        f"which {primary} is best?",
        f"how do you choose {primary}?",
    ]
    return {
        "primary": primary,
        "secondary": secondary,
        "longtail": longtail,
        "intent": "informational",
        "rationale": "Derived from the topic wording (offline fallback).",
    }


# --------------------------------------------------------------------------- #
# Ahrefs enrichment — pick the primary by REAL search volume, not phrasing luck
# --------------------------------------------------------------------------- #
# A candidate must be at least plausibly rankable to win the primary slot.
_MAX_DIFFICULTY = 40

# Ahrefs expects ISO alpha-2; map the few non-ISO values the form allows.
_COUNTRY_FIX = {"UK": "GB", "GLOBAL": "US", "EU": "DE"}


def _keyword_variants(primary: str) -> list[str]:
    """Cheap high-value variants of the primary (singular/plural, 'best X').

    The LLM picks a phrasing blind to volume; the variants let Ahrefs data
    decide (live example: plural 'quiet mechanical keyboards' = 150/mo while
    the singular = 2,500/mo).
    """
    out: list[str] = []
    words = primary.split()
    if words:
        last = words[-1]
        if last.endswith("s") and len(last) > 3:
            out.append(" ".join(words[:-1] + [last[:-1]]))
        else:
            out.append(" ".join(words[:-1] + [last + "s"]))
    if not primary.lower().startswith("best "):
        out.append(f"best {primary}")
    return [v for v in out if v and v.lower() != primary.lower()]


def _ahrefs_metrics(candidates: list[str], country: str, api_key: str) -> dict[str, dict]:
    """Volume/difficulty for candidates via the Ahrefs v3 API. Never raises."""
    import httpx

    cc = (country or "US").strip().upper()
    cc = _COUNTRY_FIX.get(cc, cc)[:2]
    try:
        resp = httpx.get(
            "https://api.ahrefs.com/v3/keywords-explorer/overview",
            params={
                "select": "keyword,volume,difficulty,traffic_potential",
                "country": cc,
                "keywords": ",".join(candidates[:10]),
            },
            headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
            timeout=20,
        )
        resp.raise_for_status()
        rows = (resp.json() or {}).get("keywords") or []
    except Exception:  # noqa: BLE001 - enrichment is best-effort, never fatal
        return {}
    out: dict[str, dict] = {}
    for row in rows:
        if isinstance(row, dict) and row.get("keyword"):
            out[str(row["keyword"]).strip().lower()] = row
    return out


def _select_primary(original: str, candidates: list[str], metrics: dict[str, dict]) -> str:
    """The candidate with the most volume at a rankable difficulty.

    Falls back to ``original`` when no candidate has usable data, so a failed/
    empty Ahrefs response never degrades the LLM's choice.
    """
    best, best_volume = original, -1
    for cand in candidates:
        row = metrics.get(cand.lower())
        if not row:
            continue
        volume = row.get("volume")
        difficulty = row.get("difficulty")
        if not isinstance(volume, int) or volume <= 0:
            continue
        if isinstance(difficulty, int) and difficulty > _MAX_DIFFICULTY:
            continue
        if volume > best_volume:
            best, best_volume = cand, volume
    return best


def enrich_with_ahrefs(keywords: dict, country: str, *, api_key: str | None = None) -> dict:
    """Re-rank the keyword set with real Ahrefs volume/difficulty data.

    - The primary is re-picked from {primary + its variants + secondaries} by
      volume (difficulty-capped); the displaced primary joins the secondaries.
    - The winning metrics are attached as ``volume``/``difficulty``/
      ``traffic_potential`` so the UI can show WHY this keyword won.
    No key / API error / no data → the set passes through unchanged.
    """
    if api_key is None:
        from app.config import get_settings

        api_key = get_settings().ahrefs_api_key
    if not api_key:
        return keywords

    primary = keywords.get("primary") or ""
    if not primary:
        return keywords
    # A user-chosen keyword is never swapped — only annotated with its metrics.
    locked = bool(keywords.get("user_locked"))
    candidates = (
        [primary]
        if locked
        else [primary, *_keyword_variants(primary), *(keywords.get("secondary") or [])[:6]]
    )
    metrics = _ahrefs_metrics(candidates, country, api_key)
    if not metrics:
        return keywords

    winner = primary if locked else _select_primary(primary, candidates, metrics)
    row = metrics.get(winner.lower()) or {}
    if winner.lower() != primary.lower():
        secondary = [s for s in keywords.get("secondary") or [] if s.lower() != winner.lower()]
        keywords["secondary"] = ([primary] + secondary)[:8]
        keywords["primary"] = winner
        keywords["rationale"] = (
            f"Chosen by real search data: {row.get('volume', '?')}/mo, "
            f"difficulty {row.get('difficulty', '?')} (Ahrefs). "
            + str(keywords.get("rationale") or "")
        ).strip()[:300]
    if isinstance(row.get("volume"), int):
        keywords["volume"] = row["volume"]
    if isinstance(row.get("difficulty"), int):
        keywords["difficulty"] = row["difficulty"]
    if isinstance(row.get("traffic_potential"), int):
        keywords["traffic_potential"] = row["traffic_potential"]
    return keywords


def research_keywords(brief: dict, *, provider: str = "anthropic") -> dict:
    """Derive the keyword set for a brief (pipeline stage 1).

    Honors an explicit user keyword: when the brief already carries one, it is
    kept as ``primary`` and the LLM only fills the supporting sets. When an
    Ahrefs API key is configured, the primary is then re-picked by REAL search
    volume/difficulty across the candidate set. Never raises; always returns
    the full shape.
    """
    user_keyword = _clean_phrase(brief.get("keyword"))
    prompt_parts = [
        f"Article description: {brief.get('topic', '')}",
        f"Country/market: {brief.get('country') or 'US'}",
    ]
    if brief.get("audience"):
        prompt_parts.append(f"Audience: {brief['audience']}")
    if brief.get("goal"):
        prompt_parts.append(f"Goal: {brief['goal']}")
    if user_keyword:
        prompt_parts.append(
            f"The user chose the primary keyword themselves: \"{user_keyword}\". "
            "Keep it as primary; derive only secondary/longtail around it."
        )

    data: dict | None = None
    try:
        resp = get_adapter(provider).complete(
            system=_SYSTEM, prompt="\n".join(prompt_parts), json_mode=True
        )
        raw = json.loads(resp.text) if resp.text else None
        if isinstance(raw, dict):
            data = raw
    except (ProviderRefusal, ProviderError, json.JSONDecodeError, TypeError, ValueError):
        data = None

    country = brief.get("country") or "US"
    fallback = _heuristic_keywords(brief)
    if data is None:
        if user_keyword:
            fallback["primary"] = user_keyword
            fallback["user_locked"] = True
        return enrich_with_ahrefs(fallback, country)

    primary = user_keyword or _clean_phrase(data.get("primary")) or fallback["primary"]
    seen = {primary.lower()}
    secondary = _clean_list(data.get("secondary"), cap=8, drop=seen) or fallback["secondary"]
    longtail = _clean_list(data.get("longtail"), cap=6, drop=seen) or fallback["longtail"]
    longtail = [q if q.endswith("?") else f"{q}?" for q in longtail]

    intent = str(data.get("intent") or "").strip().lower()
    if intent not in _VALID_INTENTS:
        intent = fallback["intent"]

    rationale = re.sub(r"\s+", " ", str(data.get("rationale") or "")).strip()[:300]
    result = {
        "user_locked": bool(user_keyword),
        "primary": primary,
        "secondary": secondary,
        "longtail": longtail,
        "intent": intent,
        "rationale": rationale or fallback["rationale"],
    }
    return enrich_with_ahrefs(result, country)
