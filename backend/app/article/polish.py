"""SEO polish stage — the pass that separates the article from raw LLM output.

After the writer produces the draft, every section goes through a senior-editor
rewrite with three jobs:

1. **Humanize** — kill the patterns AI detectors and readers both flag
   (uniform sentence rhythm, cliché transitions, hedged filler), keeping the
   facts and citations intact.
2. **SEO/GEO discipline** — the assigned keyword appears naturally, the section
   opens by actually answering its heading (answer-first, so AI engines can
   quote it), and list/table formatting is used where it genuinely helps.
3. **Meta pack** — a click-worthy meta title (≤60 chars), meta description
   (140-160 chars), URL slug, and 3-5 quotable key takeaways.

Same resilience contract as the writer: every LLM call has a conservative
fallback (keep the original section; derive meta heuristically), so the stage
is a safe no-op with zero API keys and can never gut a draft.
"""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor, as_completed

from app.compliance.autofix import autofix_text
from app.providers import ProviderError, ProviderRefusal, get_adapter

_MAX_WORKERS = 4

POLISH_SYSTEM = (
    "You are a demanding senior editor at a top publication. You are handed ONE "
    "section of an article. Rewrite it so it reads like an experienced human "
    "specialist wrote it, while keeping every fact, number, citation and the "
    "Markdown structure intact.\n"
    "REWRITE FOR:\n"
    "- Rhythm: vary sentence length hard — some under 7 words, some longer. No "
    "two consecutive sentences with the same shape. Contractions are fine.\n"
    "- Directness: the FIRST sentence must directly answer or address the "
    "section's heading (a reader or an AI engine quoting only that sentence "
    "should learn something). Cut throat-clearing openers.\n"
    "- Specificity: replace vague claims with the concrete detail already in "
    "the text; delete filler that adds no information. Never add new facts, "
    "numbers or sources that are not already present.\n"
    "- Formatting: if the prose lists 3+ parallel items, convert to a Markdown "
    "bulleted list; keep tables as tables. Bold at most ONE key phrase per "
    "section. Do not add headings.\n"
    "- Keyword: if the assigned keyword is given and absent, weave it in ONCE "
    "where it reads naturally. Never repeat it unnaturally.\n"
    "BANNED (rewrite them out): 'in conclusion', 'it's important to note', "
    "'in today's world', 'when it comes to', 'a wide range of', 'plays a "
    "crucial role', 'navigating the', 'in the realm of', 'delve', 'moreover', "
    "'furthermore', 'overall,', em-dashes (use commas or periods), and any "
    "sentence that promises without evidence ('the best', 'ultimate').\n"
    "Length: stay within about 20% of the original word count.\n"
    "Return ONLY the rewritten Markdown body (no heading line, no preamble). "
    'If you reply as JSON, use the shape {"markdown": str}.'
)

_META_SYSTEM = (
    "You are an SEO editor creating the meta pack for a finished article. "
    "Given the primary keyword, the article's headings and its opening, return "
    "STRICT JSON: "
    '{"title": str, "description": str, "slug": str, "takeaways": [str]}.\n'
    "- title: <= 60 characters, primary keyword near the front, compelling but "
    "not clickbait, no site name, no year unless the content is year-specific.\n"
    "- description: 140-160 characters, includes the primary keyword once, "
    "states the concrete benefit of reading, active voice.\n"
    "- slug: 3-6 lowercase words, hyphen-separated, from the primary keyword.\n"
    "- takeaways: 3-5 standalone, quotable one-sentence facts from the article "
    "(each <= 22 words, no 'this article' meta-language) — what an AI engine "
    "should cite."
)


def _count_words(text: str) -> int:
    return len(re.findall(r"\b\w+\b", text or ""))


# Placeholder pseudo-links a model sometimes emits when asked to attribute
# ("([source: Good Housekeeping](source))") — flattened to a plain parenthetical
# citation. Real markdown links (with an actual URL) are untouched.
_FAKE_LINK_RE = re.compile(
    r"\(?\[\s*(?:source:\s*)?([^\]]+?)\s*\]\(\s*source\s*\)\)?", re.IGNORECASE
)


def _strip_fake_links(text: str) -> str:
    return _FAKE_LINK_RE.sub(lambda m: f"({m.group(1).strip()})", text)


def _parse_markdown_reply(text: str) -> str:
    """Extract body Markdown from an adapter reply (JSON or raw), defensively."""
    text = (text or "").strip()
    if not text:
        return ""
    if text.startswith("{"):
        try:
            data = json.loads(text)
            if isinstance(data, dict):
                for key in ("markdown", "text", "body", "content"):
                    val = data.get(key)
                    if isinstance(val, str) and val.strip():
                        text = val.strip()
                        break
        except (json.JSONDecodeError, ValueError):
            pass
    if text.startswith("```"):
        text = re.sub(r"^```[a-zA-Z0-9]*\s*\n?", "", text)
        text = re.sub(r"\n?```\s*$", "", text)
    return text.strip()


def _section_kind(heading: str) -> str:
    h = (heading or "").lower()
    if any(w in h for w in ("quick verdict", "verdict", "tl;dr", "bottom line", "key takeaway")):
        return "verdict"
    if any(w in h for w in ("faq", "frequently asked", "questions people", "common questions")):
        return "faq"
    return "body"


def _polish_prompt(
    section: dict, brief: dict, keyword: str | None, extra: dict | None = None
) -> str:
    extra = extra or {}
    parts = [
        f"Article topic: {brief.get('topic', '')}",
        f"Audience: {brief.get('audience') or 'general readers'}",
        f"Tone: {brief.get('tone') or 'natural, expert'}",
        f"Section heading: {section.get('heading', '')}",
    ]
    if keyword:
        parts.append(f"Assigned keyword for this section: {keyword}")

    if extra.get("critique"):
        cr = extra["critique"]
        parts.append(
            "A reviewer from a DIFFERENT model flagged this section as one of "
            f"the article's weakest.\nProblem: {cr.get('problem', '')}\n"
            f"Fix instruction (apply it precisely): {cr.get('fix', '')}\n"
            "Keep every fact and citation intact unless the fix says otherwise."
        )
    if extra.get("fix_claims"):
        srcs = ", ".join(extra.get("sources") or []) or "(none listed)"
        joined = "\n".join(f"- {c}" for c in extra["fix_claims"][:6])
        fact_lines = "\n".join(
            f"- {f['text']} [source: {f['source']}]"
            for f in (extra.get("facts") or [])[:6]
        )
        parts.append(
            "FIX UNSUPPORTED CLAIMS — the ONLY job of this rewrite. These "
            "sentences state figures or negatives with no supporting source:\n"
            f"{joined}\n"
            f"Research sources you may attribute to: {srcs}.\n"
            + (f"Verified facts you may substitute in (with their source):\n{fact_lines}\n" if fact_lines else "")
            + "For each flagged sentence do exactly one of: (a) replace/attribute "
            "it using a verified fact above, (b) rewrite it qualitatively with "
            "no bare figures, or (c) delete it. Attribute in PLAIN PROSE ('per "
            "Good Housekeeping') — never as a markdown link and never with a "
            "'(source)' placeholder. Leave every other sentence untouched."
        )

    kind = _section_kind(section.get("heading", ""))
    if kind == "faq":
        questions = extra.get("questions") or []
        if questions:
            parts.append(
                "This is the FAQ. Each item must be a bolded QUESTION (verbatim "
                "from the list below, interrogative, ending '?') on its own line, "
                "then its answer. If a bold line became a statement, restore the "
                "matching question. Polish ONLY the answers (1-2 tight sentences "
                "each).\nQuestions:\n" + "\n".join(f"- {q}" for q in questions[:8])
            )
        else:
            parts.append(
                "This is the FAQ. Keep each bolded line a natural QUESTION ending "
                "'?' (restore any that became statements); polish only the answers."
            )
    elif kind == "verdict":
        digest = extra.get("digest") or ""
        if digest:
            parts.append(
                "This is the article's Quick Verdict. Make it CONSISTENT with what "
                "the article actually covers (digest below): recommend only "
                "options the article itself names — never something absent from "
                "the digest.\nArticle digest:\n" + digest[:1500]
            )
    parts.append("\nSection body to rewrite:\n" + (section.get("markdown") or ""))
    return "\n".join(parts)


def polish_section(
    section: dict,
    brief: dict,
    *,
    keyword: str | None = None,
    provider: str = "anthropic",
    extra: dict | None = None,
) -> dict:
    """Polish one section; conservative — keeps the original when unsure.

    Falls back to the original body on provider error, mock output, or a
    destructive edit (lost >45% or gained >80% of the words), mirroring the
    proofread contract so polishing can never gut or bloat the draft.
    """
    body = (section.get("markdown") or "").strip()
    heading = section.get("heading", "")
    level = section.get("level", 2)
    if not body:
        return {"heading": heading, "level": level, "markdown": body, "changed": False}
    try:
        resp = get_adapter(provider).complete(
            system=POLISH_SYSTEM,
            prompt=_polish_prompt(section, brief, keyword, extra),
            json_mode=False,
        )
        fixed = _parse_markdown_reply(resp.text)
    except (ProviderRefusal, ProviderError):
        fixed = ""

    original_words = max(1, _count_words(body))
    if (
        not fixed
        or "[mock:" in fixed
        or _count_words(fixed) < 0.55 * original_words
        or _count_words(fixed) > 1.8 * original_words
    ):
        return {"heading": heading, "level": level, "markdown": body, "changed": False}

    fixed = _strip_fake_links(autofix_text(fixed))
    return {
        "heading": heading,
        "level": level,
        "markdown": fixed,
        "changed": fixed.strip() != body,
    }


def _keyword_plan(sections: list[dict], keywords: dict | None) -> list[str | None]:
    """Assign one keyword per section: primary to the opener, secondaries spread.

    FAQ/verdict sections get no assignment (their format handles keywords
    naturally); assignments cycle through the secondary list so the whole set
    gets used across a long article without repeating in adjacent sections.
    """
    primary = (keywords or {}).get("primary") or ""
    secondary = [s for s in (keywords or {}).get("secondary") or [] if isinstance(s, str)]
    plan: list[str | None] = []
    sec_i = 0
    body_seen = 0
    for sec in sections:
        head = str(sec.get("heading", "")).lower()
        if any(w in head for w in ("faq", "frequently asked", "verdict", "takeaway")):
            plan.append(None)
            continue
        body_seen += 1
        if body_seen == 1 and primary:
            plan.append(primary)
        elif secondary:
            plan.append(secondary[sec_i % len(secondary)])
            sec_i += 1
        else:
            plan.append(None)
    return plan


def stream_polish(
    draft: dict,
    brief: dict,
    research: dict | None = None,
    *,
    provider: str = "anthropic",
) -> Iterator[dict]:
    """Polish every section concurrently, yielding an event per finished section.

    Yields ``{"kind": "section_done", "index", "heading", "level", "markdown",
    "changed"}`` as each section lands (indexes match the draft, so a UI can
    replace sections in place), then a terminal ``{"kind": "done", "draft":
    {...}, "changed": int}`` with the full polished payload. Never raises.
    """
    sections = [dict(s) for s in (draft or {}).get("sections") or [] if isinstance(s, dict)]
    if not sections:
        yield {"kind": "done", "draft": {"sections": [], "word_count": 0}, "changed": 0}
        return

    plan = _keyword_plan(sections, (research or {}).get("keywords"))

    # Cross-section context: the verdict must match what the article actually
    # covers, and the FAQ must keep the real reader questions verbatim.
    digest_lines = [f"- {s.get('heading', '')}" for s in sections]
    table_sec = next(
        (s for s in sections if "|---" in (s.get("markdown") or "").replace(" ", "")),
        None,
    )
    if table_sec:
        digest_lines.append("Comparison table:\n" + (table_sec.get("markdown") or "")[:900])
    digest = "\n".join(digest_lines)
    questions = [q for q in (research or {}).get("paa") or [] if isinstance(q, str)]

    def _extra_for(section: dict) -> dict:
        kind = _section_kind(section.get("heading", ""))
        if kind == "verdict":
            return {"digest": digest}
        if kind == "faq":
            return {"questions": questions}
        return {}

    results: list[dict | None] = [None] * len(sections)
    with ThreadPoolExecutor(max_workers=min(_MAX_WORKERS, len(sections))) as pool:
        futures = {
            pool.submit(
                polish_section,
                sec,
                brief,
                keyword=plan[i],
                provider=provider,
                extra=_extra_for(sec),
            ): i
            for i, sec in enumerate(sections)
        }
        for fut in as_completed(futures):
            i = futures[fut]
            try:
                out = fut.result()
            except Exception:  # noqa: BLE001 - keep the original section
                src = sections[i]
                out = {
                    "heading": src.get("heading", ""),
                    "level": src.get("level", 2),
                    "markdown": src.get("markdown", ""),
                    "changed": False,
                }
            results[i] = out
            yield {"kind": "section_done", "index": i, **out}

    final = [r for r in results if r is not None]
    word_count = sum(_count_words(s.get("markdown", "")) for s in final)
    yield {
        "kind": "done",
        "draft": {
            "sections": [
                {"heading": s["heading"], "level": s["level"], "markdown": s["markdown"]}
                for s in final
            ],
            "word_count": word_count,
        },
        "changed": sum(1 for s in final if s.get("changed")),
    }


# --------------------------------------------------------------------------- #
# Cross-model critic — a DIFFERENT model reviews the polished draft
# --------------------------------------------------------------------------- #
_CRITIC_SYSTEM = (
    "You are a ruthless external reviewer from a rival publication, judging "
    "whether this article beats the pages already ranking. Score every section "
    "against: (1) does the first sentence directly answer its heading, (2) is "
    "it concrete and evidence-grounded or hand-wavy, (3) does it add anything "
    "the competitor coverage lacks, (4) does it read like a human specialist. "
    "Name AT MOST the 2 weakest sections — the ones a reader would skip — and "
    "for each give ONE concrete, actionable fix (what to cut, sharpen, ground "
    "or restructure). If every section genuinely holds up, return an empty "
    "list. Output STRICT JSON: {\"weak\": [{\"index\": int, \"problem\": str, "
    "\"fix\": str}]}."
)

# The critic deliberately runs on a DIFFERENT provider seat than the writer —
# a second model catches patterns the author model is blind to (and the blend
# of voices is the product's whole thesis). Falls back via get_adapter.
CRITIC_PROVIDER = "xai"


def critique_draft(
    draft: dict,
    brief: dict,
    research: dict | None = None,
    *,
    provider: str = CRITIC_PROVIDER,
) -> list[dict]:
    """Cross-model review: up to 2 weakest sections with a concrete fix each.

    Returns ``[{index, problem, fix}]`` (possibly empty). Never raises; an
    unusable reply (e.g. the mock adapter) yields ``[]`` so offline runs skip
    the rewrite quietly.
    """
    sections = (draft or {}).get("sections") or []
    if len(sections) < 3:
        return []
    numbered = []
    for i, s in enumerate(sections):
        if not isinstance(s, dict):
            continue
        body = re.sub(r"\s+", " ", s.get("markdown") or "")[:600]
        numbered.append(f"[{i}] {s.get('heading', '')}\n{body}")
    competitor_bar = "; ".join(
        str(h) for h in ((research or {}).get("headings") or [])[:12]
    )
    prompt = (
        f"Topic: {brief.get('topic', '')}\n"
        f"What the ranking pages cover: {competitor_bar}\n\n"
        f"The article, section by section:\n\n" + "\n\n".join(numbered)[:12000]
    )
    try:
        resp = get_adapter(provider).complete(
            system=_CRITIC_SYSTEM, prompt=prompt, json_mode=True
        )
        data = json.loads(resp.text) if resp.text else None
    except (ProviderRefusal, ProviderError, json.JSONDecodeError, TypeError, ValueError):
        return []
    if not isinstance(data, dict):
        return []
    out: list[dict] = []
    for item in data.get("weak") or []:
        if not isinstance(item, dict):
            continue
        try:
            idx = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        fix = re.sub(r"\s+", " ", str(item.get("fix") or "")).strip()
        if 0 <= idx < len(sections) and fix:
            out.append(
                {
                    "index": idx,
                    "problem": re.sub(r"\s+", " ", str(item.get("problem") or "")).strip()[:300],
                    "fix": fix[:500],
                }
            )
        if len(out) >= 2:
            break
    return out


def apply_critique(
    draft: dict,
    brief: dict,
    critiques: list[dict],
    *,
    provider: str = "anthropic",
) -> tuple[dict, list[int]]:
    """Rewrite the critic's flagged sections. Returns (draft, changed_indexes)."""
    sections = [dict(s) for s in (draft or {}).get("sections") or [] if isinstance(s, dict)]
    if not sections or not critiques:
        return draft, []
    changed: list[int] = []
    for item in critiques:
        idx = item.get("index")
        if not isinstance(idx, int) or not (0 <= idx < len(sections)):
            continue
        out = polish_section(
            sections[idx],
            brief,
            provider=provider,
            extra={"critique": item},
        )
        if out.get("changed"):
            sections[idx] = {
                "heading": out["heading"],
                "level": out["level"],
                "markdown": out["markdown"],
            }
            changed.append(idx)
    if not changed:
        return draft, []
    word_count = sum(_count_words(s.get("markdown", "")) for s in sections)
    return {"sections": sections, "word_count": word_count}, changed


# --------------------------------------------------------------------------- #
# Targeted claim remediation (feeds the fact-check → publish-gate loop)
# --------------------------------------------------------------------------- #
def _norm_probe(text: str) -> str:
    return re.sub(r"\W+", " ", (text or "").lower()).strip()


def fix_unsupported_claims(
    draft: dict,
    brief: dict,
    research: dict | None,
    claim_texts: list[str],
    *,
    provider: str = "anthropic",
) -> tuple[dict, list[int]]:
    """Rewrite ONLY the sections containing the given unsupported claims.

    Each flagged claim is located in its section (normalised-substring match)
    and that section is rewritten with a strict attribute-or-soften-or-delete
    instruction. Returns the (possibly updated) draft payload plus the indexes
    of sections that actually changed. Conservative by construction: unmatched
    claims and failed rewrites leave the draft untouched.
    """
    sections = [dict(s) for s in (draft or {}).get("sections") or [] if isinstance(s, dict)]
    if not sections or not claim_texts:
        return draft, []

    source_names: list[str] = []
    for s in (research or {}).get("sources") or []:
        if isinstance(s, dict):
            name = s.get("domain") or s.get("title") or ""
            if name:
                source_names.append(str(name))
    source_names = source_names[:8]

    targets: dict[int, list[str]] = {}
    for claim in claim_texts:
        probe = _norm_probe(claim)[:60]
        if not probe:
            continue
        for i, sec in enumerate(sections):
            if probe in _norm_probe(sec.get("markdown", "")):
                targets.setdefault(i, []).append(claim)
                break

    from app.research.evidence import facts_for_heading

    evidence = (research or {}).get("facts")
    changed: list[int] = []
    for i, claims in targets.items():
        out = polish_section(
            sections[i],
            brief,
            provider=provider,
            extra={
                "fix_claims": claims,
                "sources": source_names,
                "facts": facts_for_heading(
                    evidence, sections[i].get("heading", ""), cap=6
                ),
            },
        )
        if out.get("changed"):
            sections[i] = {
                "heading": out["heading"],
                "level": out["level"],
                "markdown": out["markdown"],
            }
            changed.append(i)

    if not changed:
        return draft, []
    word_count = sum(_count_words(s.get("markdown", "")) for s in sections)
    return {"sections": sections, "word_count": word_count}, changed


# --------------------------------------------------------------------------- #
# Meta pack (title / description / slug / takeaways)
# --------------------------------------------------------------------------- #
def _slugify(text: str, max_words: int = 6) -> str:
    words = re.findall(r"[a-z0-9]+", (text or "").lower())
    return "-".join(words[:max_words]) or "article"


def _heuristic_meta(draft: dict, brief: dict, keywords: dict | None) -> dict:
    primary = (keywords or {}).get("primary") or brief.get("keyword") or brief.get("topic") or "article"
    sections = (draft or {}).get("sections") or []
    first_body = ""
    for s in sections:
        if isinstance(s, dict) and (s.get("markdown") or "").strip():
            first_body = re.sub(r"\s+", " ", s["markdown"]).strip()
            break
    title = primary if primary[:1].isupper() else primary.title()
    description = first_body[:157].rstrip() + "…" if len(first_body) > 157 else first_body
    takeaways = [
        str(s.get("heading", "")).strip()
        for s in sections
        if isinstance(s, dict) and s.get("heading")
    ][:4]
    return {
        "title": title[:60],
        "description": description,
        "slug": _slugify(primary),
        "takeaways": takeaways,
    }


def generate_seo_meta(
    draft: dict,
    brief: dict,
    research: dict | None = None,
    *,
    provider: str = "anthropic",
) -> dict:
    """Generate the meta pack for the polished draft. Never raises."""
    keywords = (research or {}).get("keywords")
    fallback = _heuristic_meta(draft, brief, keywords)

    sections = (draft or {}).get("sections") or []
    headings = [s.get("heading", "") for s in sections if isinstance(s, dict)]
    opening = ""
    for s in sections:
        if isinstance(s, dict) and (s.get("markdown") or "").strip():
            opening = s["markdown"][:900]
            break
    prompt = json.dumps(
        {
            "primary_keyword": (keywords or {}).get("primary") or brief.get("keyword") or "",
            "secondary_keywords": (keywords or {}).get("secondary") or [],
            "topic": brief.get("topic", ""),
            "headings": headings[:14],
            "opening": opening,
        }
    )
    try:
        resp = get_adapter(provider).complete(
            system=_META_SYSTEM, prompt=prompt, json_mode=True
        )
        data = json.loads(resp.text) if resp.text else None
    except (ProviderRefusal, ProviderError, json.JSONDecodeError, TypeError, ValueError):
        data = None
    if not isinstance(data, dict):
        return fallback

    title = re.sub(r"\s+", " ", str(data.get("title") or "")).strip()
    description = re.sub(r"\s+", " ", str(data.get("description") or "")).strip()
    slug = _slugify(str(data.get("slug") or ""), max_words=8)
    takeaways = [
        re.sub(r"\s+", " ", str(t)).strip()
        for t in (data.get("takeaways") or [])
        if str(t).strip()
    ][:5]
    return {
        "title": (title or fallback["title"])[:70],
        "description": (description or fallback["description"])[:200],
        "slug": slug if slug != "article" else fallback["slug"],
        "takeaways": takeaways or fallback["takeaways"],
    }
