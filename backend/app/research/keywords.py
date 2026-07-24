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


def research_keywords(brief: dict, *, provider: str = "anthropic") -> dict:
    """Derive the keyword set for a brief (pipeline stage 1).

    Honors an explicit user keyword: when the brief already carries one, it is
    kept as ``primary`` and the LLM only fills the supporting sets. Never raises;
    always returns the full shape.
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

    fallback = _heuristic_keywords(brief)
    if data is None:
        if user_keyword:
            fallback["primary"] = user_keyword
        return fallback

    primary = user_keyword or _clean_phrase(data.get("primary")) or fallback["primary"]
    seen = {primary.lower()}
    secondary = _clean_list(data.get("secondary"), cap=8, drop=seen) or fallback["secondary"]
    longtail = _clean_list(data.get("longtail"), cap=6, drop=seen) or fallback["longtail"]
    longtail = [q if q.endswith("?") else f"{q}?" for q in longtail]

    intent = str(data.get("intent") or "").strip().lower()
    if intent not in _VALID_INTENTS:
        intent = fallback["intent"]

    rationale = re.sub(r"\s+", " ", str(data.get("rationale") or "")).strip()[:300]
    return {
        "primary": primary,
        "secondary": secondary,
        "longtail": longtail,
        "intent": intent,
        "rationale": rationale or fallback["rationale"],
    }
