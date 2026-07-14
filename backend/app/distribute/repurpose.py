"""Repurpose a long-form article into channel-native social posts (PRD §15).

LinkedIn and Reddit take short, platform-shaped posts — not the full article — so
each channel gets its own LLM pass that rewrites the draft into that platform's
voice and length. Every function is defensive: on a provider error, an empty/mock
response, or missing keys it falls back to a deterministic heuristic built from
the draft, so the feature works with ZERO API keys (same contract as the rest of
the pipeline).
"""

from __future__ import annotations

import json
import re

from app.providers import ProviderError, ProviderRefusal, get_adapter

_LINKEDIN_SYSTEM = (
    "You are a senior B2B social writer. Turn the article into ONE LinkedIn post "
    "of 900-1400 characters. Open with a strong one-line hook, then 3-5 short "
    "insight lines or a tight list, then a light call to action, then 3-5 relevant "
    "hashtags on the last line. Professional and human, at most 1-2 emojis, plain "
    "text only (LinkedIn has no markdown). Return only the post text."
)

_REDDIT_SYSTEM = (
    "You are a helpful Redditor sharing genuinely useful insight (NOT an ad). Turn "
    "the article into a Reddit self-post: a specific, non-clickbait title (max 280 "
    "chars) and a conversational, valuable body in Markdown. No marketing speak, no "
    "hard sell, no links spam. Return STRICT JSON: {\"title\": str, \"body\": str}."
)


def _article_text(draft: dict) -> str:
    parts: list[str] = []
    for s in (draft or {}).get("sections") or []:
        if isinstance(s, dict):
            if s.get("heading"):
                parts.append(f"## {s['heading']}")
            if s.get("markdown"):
                parts.append(str(s["markdown"]))
    return "\n".join(parts).strip()


def _brief_line(brief: dict) -> str:
    return (
        f"Topic: {brief.get('topic', '')} | Keyword: {brief.get('keyword', '')} | "
        f"Audience: {brief.get('audience') or 'general'} | Goal: {brief.get('goal') or 'inform'}"
    )


def _first_sentences(text: str, n: int = 2) -> str:
    plain = re.sub(r"[#*`>\-]", "", text).strip()
    sents = re.split(r"(?<=[.!?])\s+", plain)
    return " ".join(s.strip() for s in sents[:n] if s.strip())


def _hashtags(brief: dict) -> str:
    words = re.findall(r"[A-Za-z0-9]+", f"{brief.get('keyword', '')} {brief.get('topic', '')}")
    seen: list[str] = []
    for w in words:
        if len(w) > 2 and w.lower() not in [s.lower() for s in seen]:
            seen.append(w)
    return " ".join(f"#{w}" for w in seen[:5]) or "#ContentOS"


def _usable(text: str) -> bool:
    return bool(text) and "[mock:" not in text and len(text.strip()) > 40


def repurpose_linkedin(draft: dict, brief: dict, *, provider: str = "anthropic") -> dict:
    """Return ``{"text": str}`` — a LinkedIn-ready post."""
    prompt = f"{_brief_line(brief)}\n\nARTICLE:\n{_article_text(draft)[:6000]}"
    try:
        resp = get_adapter(provider).complete(system=_LINKEDIN_SYSTEM, prompt=prompt, json_mode=False)
        post = (resp.text or "").strip()
        if _usable(post):
            return {"text": post[:2900]}
    except (ProviderError, ProviderRefusal):
        pass
    # Deterministic fallback.
    topic = brief.get("topic") or brief.get("keyword") or "this"
    body = _first_sentences(_article_text(draft), 3) or f"A quick take on {topic}."
    text = f"{topic}: what actually matters.\n\n{body}\n\nWhat's your take?\n\n{_hashtags(brief)}"
    return {"text": text[:2900]}


def repurpose_reddit(draft: dict, brief: dict, *, provider: str = "anthropic") -> dict:
    """Return ``{"title": str, "body": str}`` — a Reddit-ready self-post."""
    prompt = f"{_brief_line(brief)}\n\nARTICLE:\n{_article_text(draft)[:6000]}"
    try:
        resp = get_adapter(provider).complete(system=_REDDIT_SYSTEM, prompt=prompt, json_mode=True)
        data = json.loads(resp.text)
        title = str(data.get("title") or "").strip()
        body = str(data.get("body") or "").strip()
        if title and _usable(body):
            return {"title": title[:300], "body": body}
    except (ProviderError, ProviderRefusal, json.JSONDecodeError, TypeError):
        pass
    topic = brief.get("topic") or brief.get("keyword") or "this topic"
    title = f"What I learned looking into {topic}"
    body = _first_sentences(_article_text(draft), 5) or f"Some notes on {topic}."
    return {"title": title[:300], "body": body}
