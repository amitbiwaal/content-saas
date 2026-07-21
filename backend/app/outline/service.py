"""Outline Builder service (PRD §6 / §9.6, FR-6.1..6.3).

Converts the approved council strategy into an article skeleton:

* ``nodes``        — H1/H2/H3 tree (FR-6.1): list of ``{level, text, children}``.
* ``elements``     — table / FAQ / answer-block / image / CTA placements (FR-6.2):
                      list of ``{type, section, note}`` anchored to a heading.
* ``schema_hooks`` — JSON-LD hints (FR-6.3): list of ``{type, target}`` so the
                      exporter can emit Article / FAQPage / HowTo structured data.

The structure is produced by the Judge/strategy provider in ``json_mode`` and
parsed defensively; when no key is configured (``get_adapter`` returns a
deterministic :class:`MockAdapter`) or the JSON can't be parsed, a pure
heuristic derives sections from the accepted council decisions plus the research
headings and People-Also-Ask questions. The service is PURE (no DB, no globals)
so it is unit-testable with synthetic inputs.
"""

from __future__ import annotations

import json
import re

from app.providers import ProviderError, ProviderRefusal, get_adapter

# Element types we mark on the outline (PRD §6.2 / FR-6.2).
_ELEMENT_TYPES = ("answer_block", "table", "faq", "image", "cta")

_OUTLINE_SYSTEM = (
    "You are the Outline Builder. Turn the approved content strategy into a "
    "publish-ready article skeleton. Build an H1/H2/H3 heading tree (FR-6.1), mark "
    "where a Quick-Verdict answer block, comparison table, FAQ, image and CTA "
    "belong (FR-6.2), and attach JSON-LD schema hooks such as Article, FAQPage or "
    "HowTo (FR-6.3). Lead with a Quick-Verdict answer block so the page is "
    "answer-engine ready.\n"
    "CRITICAL: section headings MUST be reader-facing TOPICS about the subject, "
    "phrased for a reader (e.g. for standing desks: 'Adjustable height range and "
    "presets', 'Cable management for dual monitors', 'Ergonomic setup'). The "
    "'coverage_guidance' items are INTERNAL SEO/strategy instructions — use them to "
    "decide WHAT to cover, but NEVER copy a directive as a heading and NEVER write a "
    "heading that is an instruction (no 'Use...', 'Add...', 'Cover...', "
    "'Optimize...', 'Strengthen E-E-A-T', 'Build an FAQ', 'Enrich entities', "
    "'TL;DR', 'H1', 'schema'). A directive like 'add a comparison table' means MARK "
    "a table element on a real topic section, not create a section titled that.\n"
    "Output STRICT JSON only: "
    '{"nodes": [{"level": "H1|H2|H3", "text": str, "children": [...]}], '
    '"elements": [{"type": "answer_block|table|faq|image|cta", "section": str, '
    '"note": str}], "schema_hooks": [{"type": str, "target": str}]}.'
)


# --------------------------------------------------------------------------- #
# Directive vs reader-facing heading detection
# --------------------------------------------------------------------------- #
# Council seats emit STRATEGY/SEO recommendations ("Strengthen E-E-A-T", "Build an
# FAQ", "Optimise for AI answers"). Those are directives about HOW to write the
# article — they must never become the article's reader-facing section headings.
# These helpers keep directives out of the outline (and, imported by the writer,
# out of the draft as a final guard).
_DIRECTIVE_VERBS = (
    "add", "build", "optimize", "optimise", "include", "strengthen", "enrich",
    "ensure", "weave", "leverage", "open with", "lead with", "start with",
)
_SEO_JARGON = (
    "e-e-a-t", "eeat", "e-a-t", "tl;dr", "json-ld", "faqpage", "answer block",
    "answer engine", "ai answers", "ai engines",
)


def is_directive_heading(text: str) -> bool:
    """True if ``text`` reads as an editorial/SEO directive, not a reader topic."""
    low = " ".join(str(text).lower().split())
    if not low:
        return False
    if any(low.startswith(v + " ") or low.startswith(v + ":") for v in _DIRECTIVE_VERBS):
        return True
    return any(j in low for j in _SEO_JARGON)


def _is_reader_heading(text: str) -> bool:
    """Usable reader-facing heading: non-empty and not an editorial directive."""
    return bool(str(text).strip()) and not is_directive_heading(text)


# --------------------------------------------------------------------------- #
# Public entry point
# --------------------------------------------------------------------------- #
def build_outline(
    strategy_summary: str,
    decisions: list[dict],
    research: dict,
    *,
    judge_provider: str = "anthropic",
    feedback: str | None = None,
    article_type: str | None = None,
    target_words: int | None = None,
) -> dict:
    """Build an article outline from the approved strategy (PRD §6, FR-6.1..6.3).

    Args:
        strategy_summary: The Judge's final strategy text (round 3 summary).
        decisions: Judge decisions (``{source, point, label, reason}``); only
            ``accepted`` / ``merge`` points drive sections.
        research: Research Intelligence payload (``headings``, ``paa``,
            ``entities``, ``intent`` ...).
        judge_provider: Provider seat used to draft the structure; falls back to
            a deterministic mock when no key is configured.
        feedback: Optional editor instruction for a review-mode regenerate (e.g.
            "add a pricing comparison section"); woven into the model prompt.

    Returns:
        ``{"nodes": [...], "elements": [...], "schema_hooks": [...]}``. Always a
        well-formed, non-empty outline — never raises on provider failure.
    """
    keyword = _research_keyword(research, strategy_summary)
    prompt = _build_prompt(
        strategy_summary, decisions, research, feedback, article_type, target_words
    )

    try:
        resp = get_adapter(judge_provider).complete(
            system=_OUTLINE_SYSTEM, prompt=prompt, json_mode=True
        )
        parsed = _parse_outline(resp.text)
        if parsed is not None:
            return _ensure_answer_structure(parsed, research)
    except (ProviderRefusal, ProviderError):
        # Provider declined / transport failure: fall through to the heuristic so
        # the module still produces a sensible outline with zero API keys.
        pass

    return _heuristic_outline(strategy_summary, decisions, research, keyword)


# --------------------------------------------------------------------------- #
# Answer-engine structure guarantee (AEO, PRD §10)
# --------------------------------------------------------------------------- #
def _ensure_answer_structure(outline: dict, research: dict) -> dict:
    """Guarantee a Quick-Verdict answer block near the top and an FAQ section.

    A model's outline JSON may name sections however it likes; this makes sure the
    answer-engine-ready blocks always exist so the article is snippet/AEO ready
    (PRD §10) regardless of the model's phrasing.
    """
    nodes = list(outline.get("nodes") or [])
    elements = list(outline.get("elements") or [])
    hooks = list(outline.get("schema_hooks") or [])
    joined = " ".join(str(n.get("text", "")).lower() for n in nodes)

    if not any(w in joined for w in ("quick verdict", "verdict", "tl;dr", "bottom line", "key takeaway")):
        insert_at = 1 if nodes and str(nodes[0].get("level", "")).upper() == "H1" else 0
        nodes.insert(insert_at, {"level": "H2", "text": "Quick Verdict", "children": []})
        elements.insert(0, {
            "type": "answer_block",
            "section": "Quick Verdict",
            "note": "40-60 word direct answer to the primary query for AI engines.",
        })

    if not any(w in joined for w in ("faq", "frequently asked")):
        paa = [q for q in _as_text_list(research.get("paa")) if q][:6]
        children = [{"level": "H3", "text": _ensure_question(q), "children": []} for q in paa]
        nodes.append({"level": "H2", "text": "Frequently Asked Questions", "children": children})
        elements.append({
            "type": "faq",
            "section": "Frequently Asked Questions",
            "note": "FAQ built from People-Also-Ask questions.",
        })
        if not any(str(h.get("type", "")).lower() == "faqpage" for h in hooks):
            hooks.append({"type": "FAQPage", "target": "Frequently Asked Questions"})

    outline["nodes"] = nodes
    outline["elements"] = elements
    outline["schema_hooks"] = hooks
    return outline


# --------------------------------------------------------------------------- #
# Prompt construction
# --------------------------------------------------------------------------- #
def _build_prompt(
    strategy_summary: str,
    decisions: list[dict],
    research: dict,
    feedback: str | None = None,
    article_type: str | None = None,
    target_words: int | None = None,
) -> str:
    accepted = [
        d.get("point", "")
        for d in decisions
        if d.get("label") in ("accepted", "merge") and d.get("point")
    ]
    payload = {
        "strategy_summary": strategy_summary,
        # Internal SEO/strategy directives — decide WHAT to cover; NEVER a heading.
        "coverage_guidance": accepted,
        "reader_topics_competitors_cover": (research.get("headings") or [])[:30],
        "reader_questions": (research.get("paa") or [])[:20],
        "entities": (research.get("entities") or [])[:30],
        "intent": research.get("intent"),
    }
    prompt = (
        "Build the outline from this approved strategy and research.\n"
        + json.dumps(payload)[:6000]
    )
    atype = (article_type or "").strip()
    if atype:
        prompt += (
            f"\n\nARTICLE FORMAT: {atype}. Shape the heading structure to match a "
            f"'{atype}' (e.g. a Listicle uses numbered item H2s; a How-to uses "
            f"ordered step H2s; a Comparison/Versus uses per-option sections + a table)."
        )
    if isinstance(target_words, int) and target_words > 0:
        # ~200 words of body per H2 is a reasonable planning heuristic.
        secs = max(3, min(12, round(target_words / 200)))
        prompt += (
            f"\n\nTARGET LENGTH: about {target_words} words — plan roughly {secs} "
            f"body sections (H2s) so the article reaches that depth without padding."
        )
    fb = (feedback or "").strip()
    if fb:
        prompt += (
            f"\n\nEDITOR FEEDBACK (the previous outline was rejected for this; "
            f"revise accordingly): {fb[:1000]}"
        )
    return prompt


# --------------------------------------------------------------------------- #
# Defensive parsing of the LLM JSON
# --------------------------------------------------------------------------- #
def _parse_outline(text: str) -> dict | None:
    """Parse adapter JSON into the outline shape; ``None`` if unusable.

    Tolerant of code fences / surrounding prose: extracts the first JSON object.
    Requires a non-empty ``nodes`` list to be considered usable (the MockAdapter
    returns a council-shaped object with no ``nodes``, so this correctly yields
    ``None`` and the caller falls back to the heuristic).
    """
    obj = _loads_loose(text)
    if not isinstance(obj, dict):
        return None

    nodes = _normalise_nodes(obj.get("nodes"))
    if not nodes:
        return None

    elements = _normalise_elements(obj.get("elements"))
    hooks = _normalise_hooks(obj.get("schema_hooks"))
    return {"nodes": nodes, "elements": elements, "schema_hooks": hooks}


def _loads_loose(text: str) -> object | None:
    if not text:
        return None
    try:
        return json.loads(text)
    except (json.JSONDecodeError, TypeError):
        pass
    # Strip code fences / prose and retry on the first {...} span.
    match = re.search(r"\{.*\}", text, re.DOTALL)
    if match:
        try:
            return json.loads(match.group(0))
        except (json.JSONDecodeError, TypeError):
            return None
    return None


def _normalise_nodes(raw: object, _depth: int = 0) -> list[dict]:
    """Coerce arbitrary parsed node data into the ``{level, text, children}`` shape."""
    if not isinstance(raw, list) or _depth > 2:
        return []
    out: list[dict] = []
    default_level = ("H1", "H2", "H3")[min(_depth, 2)]
    for item in raw:
        if isinstance(item, str):
            text = item.strip()
            if text:
                out.append({"level": default_level, "text": text, "children": []})
            continue
        if not isinstance(item, dict):
            continue
        text = str(item.get("text") or item.get("title") or "").strip()
        if not text:
            continue
        level = str(item.get("level") or default_level).upper()
        if level not in ("H1", "H2", "H3"):
            level = default_level
        children = _normalise_nodes(item.get("children"), _depth + 1)
        out.append({"level": level, "text": text, "children": children})
    return out


def _normalise_elements(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if not isinstance(item, dict):
            continue
        etype = str(item.get("type") or "").strip().lower().replace("-", "_")
        if etype == "answerblock":
            etype = "answer_block"
        if etype not in _ELEMENT_TYPES:
            continue
        out.append(
            {
                "type": etype,
                "section": str(item.get("section") or "").strip(),
                "note": str(item.get("note") or "").strip(),
            }
        )
    return out


def _normalise_hooks(raw: object) -> list[dict]:
    if not isinstance(raw, list):
        return []
    out: list[dict] = []
    for item in raw:
        if isinstance(item, str) and item.strip():
            out.append({"type": item.strip(), "target": ""})
        elif isinstance(item, dict) and item.get("type"):
            out.append(
                {
                    "type": str(item.get("type")).strip(),
                    "target": str(item.get("target") or "").strip(),
                }
            )
    return out


# --------------------------------------------------------------------------- #
# Deterministic heuristic fallback (works with zero API keys)
# --------------------------------------------------------------------------- #
def _heuristic_outline(
    strategy_summary: str,
    decisions: list[dict],
    research: dict,
    keyword: str,
) -> dict:
    """Derive an outline from accepted decisions + research headings/PAA (FR-6.1..6.3).

    Layout (PRD Appendix A reference output): a Quick-Verdict answer block intro,
    an H2 per accepted point / research heading, a sourced complaints/considerations
    section, an FAQ built from People-Also-Ask, and a closing CTA.
    """
    title = _title(keyword, strategy_summary)
    nodes: list[dict] = [{"level": "H1", "text": title, "children": []}]
    elements: list[dict] = []

    intro = "Quick Verdict"
    nodes.append({"level": "H2", "text": intro, "children": []})
    elements.append(
        {
            "type": "answer_block",
            "section": intro,
            "note": "40-60 word direct answer to the primary query for AI engines.",
        }
    )

    # One H2 per accepted/merge decision point, else per research heading.
    section_titles = _section_titles(decisions, research)
    seen: set[str] = {intro.lower(), title.lower()}
    body_sections: list[str] = []
    for raw_title in section_titles:
        heading = _heading_text(raw_title)
        key = heading.lower()
        if not heading or key in seen:
            continue
        seen.add(key)
        body_sections.append(heading)
        nodes.append({"level": "H2", "text": heading, "children": []})

    # Mark a comparison table on the first body section that reads comparative.
    table_section = _first_match(
        body_sections, ("compar", "vs", "versus", "pricing", "fee", "cost", "plan")
    )
    if table_section:
        elements.append(
            {
                "type": "table",
                "section": table_section,
                "note": "Comparison table of the key options / figures.",
            }
        )
    elif body_sections:
        elements.append(
            {
                "type": "table",
                "section": body_sections[0],
                "note": "Summary table of the key facts.",
            }
        )

    # Sourced complaints / considerations section (PRD Appendix A).
    complaints = "Common Complaints and Considerations"
    nodes.append({"level": "H2", "text": complaints, "children": []})
    elements.append(
        {
            "type": "image",
            "section": complaints,
            "note": "Screenshot / chart evidencing real user complaints.",
        }
    )

    # FAQ from People-Also-Ask (FR-6.2). H3 children = the questions.
    paa = [q for q in (_as_text_list(research.get("paa"))) if q][:8]
    faq_title = "Frequently Asked Questions"
    faq_children = [
        {"level": "H3", "text": _ensure_question(q), "children": []} for q in paa
    ]
    nodes.append({"level": "H2", "text": faq_title, "children": faq_children})
    elements.append(
        {
            "type": "faq",
            "section": faq_title,
            "note": (
                f"FAQ from {len(paa)} People-Also-Ask question(s)."
                if paa
                else "FAQ covering the top reader questions."
            ),
        }
    )

    # Closing CTA.
    cta_title = "Next Steps"
    nodes.append({"level": "H2", "text": cta_title, "children": []})
    elements.append(
        {
            "type": "cta",
            "section": cta_title,
            "note": "Primary call to action aligned to the project goal.",
        }
    )

    schema_hooks = [
        {"type": "Article", "target": title},
        {"type": "FAQPage", "target": faq_title},
        {"type": "AnswerBlock", "target": intro},
    ]
    return {"nodes": nodes, "elements": elements, "schema_hooks": schema_hooks}


# --------------------------------------------------------------------------- #
# Heuristic helpers
# --------------------------------------------------------------------------- #
def _section_titles(decisions: list[dict], research: dict) -> list[str]:
    """Reader-facing section topics — NOT the council's editorial directives.

    Primary source is what top-ranking pages actually cover (research headings),
    plus any accepted council points that read as real topics (a directive like
    "Strengthen E-E-A-T" is filtered out; a topic like "Compare fees vs rivals"
    is kept). Falls back to reader questions, then a generic skeleton.
    """
    headings = [h for h in _as_text_list(research.get("headings")) if _is_reader_heading(h)]
    topical_points = [
        d.get("point", "")
        for d in decisions
        if d.get("label") in ("accepted", "merge") and _is_reader_heading(d.get("point", ""))
    ]
    combined = headings + [p for p in topical_points if p]
    if combined:
        return combined[:10]
    paa = [q.rstrip("?") for q in _as_text_list(research.get("paa")) if _is_reader_heading(q)]
    if paa:
        return paa[:8]
    return ["Overview", "How It Works", "Key Details"]


def _heading_text(raw: str) -> str:
    """Turn a heading/topic into a concise H2; reject editorial directives.

    Returns "" for a directive (the caller loop skips falsy headings), so a
    directive that slipped past _section_titles can never become an H2.
    """
    if is_directive_heading(raw):
        return ""
    text = re.sub(r"\s+", " ", str(raw)).strip().strip(".")
    # Take the leading clause before any colon/dash so headings stay short.
    text = re.split(r"[:\-–—]", text, maxsplit=1)[0].strip()
    words = text.split()
    if len(words) > 9:
        text = " ".join(words[:9])
    return text[:120]


def _ensure_question(text: str) -> str:
    text = re.sub(r"\s+", " ", str(text)).strip()
    if text and not text.endswith("?"):
        text += "?"
    return text


def _first_match(candidates: list[str], needles: tuple[str, ...]) -> str | None:
    for c in candidates:
        low = c.lower()
        if any(n in low for n in needles):
            return c
    return None


def _title(keyword: str, strategy_summary: str) -> str:
    if keyword:
        return keyword if keyword.istitle() else keyword.title()
    summary = (strategy_summary or "").strip()
    if summary:
        return _heading_text(summary) or "Complete Guide"
    return "Complete Guide"


def _research_keyword(research: dict, strategy_summary: str) -> str:
    for key in ("keyword", "topic", "primary_keyword"):
        val = research.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _as_text_list(raw: object) -> list[str]:
    """Coerce a research field (list of str / dict) into plain text strings."""
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    for item in raw:
        if isinstance(item, str):
            out.append(item.strip())
        elif isinstance(item, dict):
            text = item.get("text") or item.get("question") or item.get("title")
            if isinstance(text, str):
                out.append(text.strip())
    return [t for t in out if t]
