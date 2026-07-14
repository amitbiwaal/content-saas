"""On-the-fly translation API (PRD §20 localisation).

``POST /api/translate`` translates a batch of UI strings into a target language
via the LLM, with an in-process cache so each unique string is translated once.
Falls back to the original English text on any error or missing key, so the app
degrades gracefully (and stays English with zero API keys).
"""

from __future__ import annotations

import json
from collections import OrderedDict

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.providers import ProviderError, ProviderRefusal, get_adapter

router = APIRouter(prefix="/api", tags=["translate"])

_LANG_NAMES = {
    "hi": "Hindi", "es": "Spanish", "fr": "French", "ar": "Arabic",
    "de": "German", "pt": "Portuguese", "zh": "Chinese", "ja": "Japanese",
}

# Process-wide LRU cache: (lang, source) -> translation. Bounded so an
# unauthenticated caller sending unique strings cannot grow it without limit.
_CACHE: "OrderedDict[tuple[str, str], str]" = OrderedDict()
_CACHE_MAX = 50_000
# Skip caching (and translating) pathologically long strings — UI strings are
# short; anything larger is likely abuse or unbounded content.
_MAX_STR_LEN = 2000


def _cache_get(key: tuple[str, str]) -> str | None:
    value = _CACHE.get(key)
    if value is not None:
        _CACHE.move_to_end(key)
    return value


def _cache_put(key: tuple[str, str], value: str) -> None:
    _CACHE[key] = value
    _CACHE.move_to_end(key)
    while len(_CACHE) > _CACHE_MAX:
        _CACHE.popitem(last=False)


class TranslateIn(BaseModel):
    lang: str
    texts: list[str] = Field(default_factory=list)


def _llm_translate(lang_name: str, texts: list[str]) -> list[str]:
    # json_mode forces a JSON *object*, so request {"translations": [...]} rather
    # than a bare array (which the object mode would otherwise reject/mangle).
    system = (
        f"You are a professional UI localiser. Translate each string in the input "
        f"JSON array into {lang_name}, natural and concise for a web app. Preserve "
        f"numbers, URLs, emojis, brand names (ContentOS, WordPress, LinkedIn, Reddit, "
        f"OpenAI, Claude, Gemini, Grok) and placeholder tokens. Return a JSON object "
        f'exactly like {{"translations": [...]}} where the array holds the translated '
        f"strings in the SAME order and length as the input."
    )
    prompt = json.dumps(texts, ensure_ascii=False)
    try:
        resp = get_adapter("anthropic").complete(system=system, prompt=prompt, json_mode=True)
        data = json.loads(resp.text)
        arr = None
        if isinstance(data, dict):
            for key in ("translations", "result", "items", "output", "strings"):
                if isinstance(data.get(key), list):
                    arr = data[key]
                    break
            if arr is None and len(data) == len(texts):  # {"0": "...", "1": "..."}
                arr = list(data.values())
        elif isinstance(data, list):
            arr = data
        if isinstance(arr, list) and len(arr) == len(texts):
            return [str(x) for x in arr]
    except (ProviderError, ProviderRefusal, json.JSONDecodeError, TypeError, ValueError):
        pass
    return list(texts)  # graceful fallback: unchanged (English)


@router.post("/translate")
def translate(body: TranslateIn) -> dict:
    """Translate a batch of strings; cached per (lang, string)."""
    lang = (body.lang or "en").strip().lower()
    texts = [t for t in (body.texts or [])][:200]
    if lang == "en" or lang not in _LANG_NAMES or not texts:
        return {"translations": texts}

    out: list[str | None] = [None] * len(texts)
    missing: list[tuple[int, str]] = []
    for i, t in enumerate(texts):
        # Leave over-long strings untranslated/uncached (abuse guard).
        if len(t) > _MAX_STR_LEN:
            out[i] = t
            continue
        cached = _cache_get((lang, t))
        if cached is not None:
            out[i] = cached
        else:
            missing.append((i, t))

    if missing:
        translated = _llm_translate(_LANG_NAMES[lang], [t for _, t in missing])
        for (i, src), tr in zip(missing, translated, strict=False):
            _cache_put((lang, src), tr)
            out[i] = tr

    return {"translations": [o if o is not None else texts[i] for i, o in enumerate(out)]}
