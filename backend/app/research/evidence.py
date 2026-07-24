"""Evidence bank — real facts extracted from the fetched competitor pages.

This is what separates the article from raw ChatGPT/Claude output: the writer
does not state figures from model memory. The fetched top-ranking pages'
actual prose (``page["excerpt"]``) is mined into a source-tagged fact bank:

* ``facts``         — concrete, citable statements (stats, prices, specs,
                      pros/cons, short quotes), each tagged with the domain it
                      came from. The writer may only use figures from here.
* ``consensus``     — points multiple ranking pages agree on ("most reviewers
                      recommend X for small spaces").
* ``disagreements`` — where sources conflict. Naming these is original
                      editorial insight no single competitor page has.

An LLM (json_mode) does the mining; a deterministic regex fallback pulls
number-bearing sentences so the bank is never empty when excerpts exist.
Pure — no DB; the pipeline persists the result on ``Research.facts``.
"""

from __future__ import annotations

import json
import re

from app.providers import ProviderError, ProviderRefusal, get_adapter

_MAX_FACTS = 18
_MAX_POINTS = 6

_SYSTEM = (
    "You are a research assistant building an evidence bank from excerpts of "
    "the pages that currently rank for a topic. Extract ONLY what the excerpts "
    "actually say — never add knowledge of your own.\n"
    "Return STRICT JSON: {\"facts\": [{\"text\": str, \"source\": str, "
    "\"kind\": str}], \"consensus\": [str], \"disagreements\": [str]}.\n"
    "- facts: up to 18 concrete, self-contained statements a writer could cite "
    "(a number, price, spec, capacity, named pro/con, or a short quote of <=20 "
    "words). Each <=30 words, faithful to its excerpt. source = the domain the "
    "excerpt is labeled with (copy it EXACTLY). kind = one of "
    "stat|price|spec|pro|con|quote|fact.\n"
    "- consensus: up to 6 points that two or more DIFFERENT domains support, "
    "each naming the domains in parentheses.\n"
    "- disagreements: up to 6 points where domains conflict or one source "
    "pushes back, each naming the domains. Empty lists are fine — never "
    "invent agreement or conflict."
)

_SENT_SPLIT = re.compile(r"(?<=[.!?])\s+")
_HAS_FIGURE = re.compile(r"\d")


def _clean(text: object, cap: int = 240) -> str:
    return re.sub(r"\s+", " ", str(text or "")).strip()[:cap]


def _fallback_facts(pages: list[dict]) -> dict:
    """Deterministic: number-bearing sentences from the excerpts, source-tagged."""
    facts: list[dict] = []
    for page in pages:
        domain = page.get("domain") or ""
        excerpt = page.get("excerpt") or ""
        if not domain or not excerpt:
            continue
        for sentence in _SENT_SPLIT.split(excerpt):
            s = sentence.strip()
            if len(s) < 40 or len(s) > 220 or not _HAS_FIGURE.search(s):
                continue
            kind = "price" if re.search(r"[$₹€£]\s?\d", s) else (
                "stat" if "%" in s else "spec"
            )
            facts.append({"text": s, "source": domain, "kind": kind})
            if sum(1 for f in facts if f["source"] == domain) >= 4:
                break
        if len(facts) >= _MAX_FACTS:
            break
    return {"facts": facts[:_MAX_FACTS], "consensus": [], "disagreements": []}


def extract_evidence(
    pages: list[dict], brief: dict, *, provider: str = "anthropic"
) -> dict:
    """Mine the fetched pages' excerpts into the evidence bank. Never raises.

    Returns ``{"facts": [], "consensus": [], "disagreements": []}`` when no
    page carried an excerpt (offline/mock), so callers can rely on the shape.
    """
    with_text = [p for p in pages or [] if isinstance(p, dict) and p.get("excerpt")]
    if not with_text:
        return {"facts": [], "consensus": [], "disagreements": []}

    corpus = "\n\n".join(
        f"=== {p.get('domain', '?')} — \"{p.get('title', '')}\" ===\n{p['excerpt']}"
        for p in with_text[:6]
    )
    prompt = (
        f"Topic: {brief.get('topic', '')}\n"
        f"Primary keyword: {brief.get('keyword', '')}\n\n"
        f"Excerpts from the ranking pages:\n{corpus[:15000]}"
    )

    data: dict | None = None
    try:
        resp = get_adapter(provider).complete(system=_SYSTEM, prompt=prompt, json_mode=True)
        raw = json.loads(resp.text) if resp.text else None
        if isinstance(raw, dict):
            data = raw
    except (ProviderRefusal, ProviderError, json.JSONDecodeError, TypeError, ValueError):
        data = None
    if data is None:
        return _fallback_facts(with_text)

    known_domains = {str(p.get("domain", "")).lower() for p in with_text}
    facts: list[dict] = []
    for item in data.get("facts") or []:
        if not isinstance(item, dict):
            continue
        text = _clean(item.get("text"))
        source = _clean(item.get("source"), 100)
        # A fact whose source isn't one of the pages we actually fetched is
        # fabricated by definition — drop it.
        if not text or source.lower() not in known_domains:
            continue
        kind = str(item.get("kind") or "fact").strip().lower()
        if kind not in ("stat", "price", "spec", "pro", "con", "quote", "fact"):
            kind = "fact"
        facts.append({"text": text, "source": source, "kind": kind})
        if len(facts) >= _MAX_FACTS:
            break

    consensus = [_clean(x) for x in (data.get("consensus") or []) if _clean(x)][:_MAX_POINTS]
    disagreements = [
        _clean(x) for x in (data.get("disagreements") or []) if _clean(x)
    ][:_MAX_POINTS]

    if not facts:
        return _fallback_facts(with_text)
    return {"facts": facts, "consensus": consensus, "disagreements": disagreements}


def facts_for_heading(evidence: dict | None, heading: str, keyword: str = "", cap: int = 5) -> list[dict]:
    """The facts most relevant to one section, by token overlap. Pure/cheap."""
    facts = (evidence or {}).get("facts") or []
    if not facts:
        return []
    probe = {
        t for t in re.findall(r"[a-z0-9]+", f"{heading} {keyword}".lower()) if len(t) >= 3
    }
    scored: list[tuple[float, dict]] = []
    for fact in facts:
        toks = {t for t in re.findall(r"[a-z0-9]+", str(fact.get("text", "")).lower()) if len(t) >= 3}
        overlap = len(probe & toks)
        if overlap:
            scored.append((overlap, fact))
    scored.sort(key=lambda x: -x[0])
    return [f for _, f in scored[:cap]]
