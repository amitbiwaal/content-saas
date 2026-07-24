"""Deterministic house-rules / compliance checker (PRD §11).

House rules are a hard pass/fail step enforced *before export*, separate from
EEAT scoring (PRD §11). This module is intentionally pure and contains NO LLM
calls — compliance must be reproducible and explainable, so every finding is a
regex/heuristic match a human can audit. The service is DB-free; persistence is
done by the router.

Rules implemented (PRD §11):

* **em_dash** — ban em-dashes (— / –); suggest a comma or period (PRD §11).
* **unsourced_claim** — every negative or statistical claim must cite a named
  source; flag those that do not (PRD §11, mirrors the fact-checker §9.9).
* **methodology_claim** — block testing / methodology claims such as
  "tested X platforms" or "200+ hours" (PRD §11).
* **faqpage_claim** — FAQ blocks/schema are parse-value only; never claim
  FAQPage rich results, deprecated May 2026 (PRD §11, FR-10.4).
* **editorial_voice** — enforce the "we, not I" editorial voice; flag
  first-person singular ("I", "my", "me", "mine") (PRD §11).
* **typography_lock** — informational note: body copy is locked to 16px /
  ``#334155``; only headers, byline and table cells may differ (PRD §11).

The ``rules`` argument makes every rule per-website configurable: pass a dict to
override ``DEFAULT_RULES`` (e.g. ``{"em_dash": {"enabled": False}}`` or extra
banned phrases) and only the enabled rules run.
"""

from __future__ import annotations

import json
import re
from typing import Any

# --------------------------------------------------------------------------- #
# Default, per-website-overridable rule configuration (PRD §11, FR-13.3)
# --------------------------------------------------------------------------- #
DEFAULT_RULES: dict[str, dict[str, Any]] = {
    # Ban em-dashes; replace with a comma or period (PRD §11).
    "em_dash": {
        "enabled": True,
        "detail": "Em-dash found; replace with a comma or period.",
    },
    # Source every negative or statistical claim to a named source (PRD §11).
    "unsourced_claim": {
        "enabled": True,
        "detail": "Negative or statistical claim without a named source.",
    },
    # Block testing / methodology claims (PRD §11).
    "methodology_claim": {
        "enabled": True,
        "detail": "Testing/methodology claim is banned by house rules.",
    },
    # Never claim FAQPage rich results — parse-only (PRD §11, FR-10.4).
    "faqpage_claim": {
        "enabled": True,
        "detail": (
            "FAQPage rich results were deprecated (May 2026); FAQ schema is "
            "parse-only. Remove the rich-result claim."
        ),
    },
    # Editorial voice: we, not I (PRD §11).
    "editorial_voice": {
        "enabled": True,
        "detail": "First-person singular; use the editorial 'we', not 'I'.",
    },
    # Typography lock note — informational only (PRD §11). Never fails the gate.
    "typography_lock": {
        "enabled": True,
        "detail": "Body typography is locked to 16px / #334155 (informational).",
    },
}

# Rules that, when matched, do NOT fail the hard gate (informational only).
_INFORMATIONAL_RULES: frozenset[str] = frozenset({"typography_lock"})


# --------------------------------------------------------------------------- #
# Detection patterns
# --------------------------------------------------------------------------- #
# Em-dash (U+2014) and en-dash (U+2013). The ASCII double hyphen "--" is also a
# common stand-in, so it is caught too.
_EM_DASH_RE = re.compile(r"[—–]|--")

# First-person singular pronouns as whole words. "I" stays uppercase so we do
# not flag the letter inside other words; the rest are case-insensitive.
_FIRST_PERSON_RE = re.compile(r"\bI\b|\b(?:my|me|mine|myself|I'm|I've|I'll|I'd)\b", re.IGNORECASE)

# Testing / methodology claims: "tested 12 platforms", "200+ hours of testing",
# "we tested", "after X hours of research/analysis", "hands-on testing", etc.
_METHODOLOGY_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\btested\b[^.?!]*\b(?:platform|product|tool|app|service|brand)s?\b", re.IGNORECASE),
    re.compile(r"\b\d[\d,]*\+?\s*(?:hours?|hrs?)\b[^.?!]*\b(?:test|research|analy|review|spent|hands?-?on)", re.IGNORECASE),
    re.compile(r"\b(?:after|over|spent)\s+\d[\d,]*\+?\s*(?:hours?|hrs?|weeks?|months?|days?)\b", re.IGNORECASE),
    re.compile(r"\bhands[-\s]?on\s+test(?:ing|ed)?\b", re.IGNORECASE),
    re.compile(r"\bwe\s+(?:tested|trialled|trialed|benchmarked|put\s+\w+\s+through)\b", re.IGNORECASE),
    re.compile(r"\b\d[\d,]*\+?\s+(?:platforms?|products?|tools?|apps?|services?)\b[^.?!]*\b(?:tested|reviewed|compared|trialled|trialed)\b", re.IGNORECASE),
)

# FAQPage rich-result claims (deprecated May 2026): only flag when "rich
# result/snippet/SERP feature" is asserted, not benign mentions of FAQ schema.
_FAQPAGE_RES: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bFAQ\s*Page\b[^.?!]*\b(?:rich\s+result|rich\s+snippet|serp\s+feature)", re.IGNORECASE),
    re.compile(r"\bFAQ\b[^.?!]*\b(?:rich\s+result|rich\s+snippet)s?\b", re.IGNORECASE),
    re.compile(r"\b(?:rich\s+result|rich\s+snippet)s?\b[^.?!]*\bFAQ", re.IGNORECASE),
)

# A sentence carries a STATISTICAL claim if it contains a percentage, a money
# figure, or a multi-digit / written-out quantity cue.
_STAT_RE = re.compile(
    r"\d+(?:\.\d+)?\s*%"          # 20%, 4.5 %
    r"|\$\s?\d"                    # $20
    r"|\b\d[\d,]*(?:\.\d+)?\b"     # any number (caught with a quantity word below)
    , re.IGNORECASE,
)

# A sentence carries a NEGATIVE claim if it asserts a harm/criticism.
_NEGATIVE_RE = re.compile(
    r"\b(?:scam|fraud|illegal|unsafe|dangerous|risky|worst|terrible|awful|fail(?:s|ed|ure)?"
    r"|lawsuit|banned|complaint|fake|misleading|deceptive|hidden\s+fees?|rip[-\s]?off"
    r"|never|worse|poorly|broken|unreliable|loses?\b|lost)\b",
    re.IGNORECASE,
)

# A citation is present if the sentence references a named source: a URL, a
# domain, an explicit attribution phrase, or a "(Source: …)" / nofollow marker.
_CITATION_RE = re.compile(
    r"https?://|www\.|\b\w+\.(?:com|org|net|io|gov|edu|co)\b"
    # "per" only counts as attribution before a Capitalised source name
    # (per Reuters/Statista) — NOT "per month/user/year", which are statistics.
    r"|\baccording to\b|\bper\s+(?-i:[A-Z])|\bsource:|\bcited\b|\breported by\b"
    # Attribution-verb phrasing ("Wirecutter notes", "RTINGS points out", or a
    # split-off "Points out that ..." whose subject sits in the prior sentence).
    r"|\b(?:notes?|reports?|highlights?|states?|praises?|points?\s+out|observes?)\s+that\b"
    r"|(?-i:\b[A-Z][\w'’&.-]*(?:\s+[A-Z][\w'’&.-]*){0,3})[\"'”’)\]]{0,2}\s+(?:notes?|reports?|highlights?|states?|praises?|recommends?|mentions?|points?\s+out|observes?|found|finds?|warns?|suggests?)\b"
    r"|\bnofollow\b|\[[^\]]+\]\([^)]+\)",  # markdown link
    re.IGNORECASE,
)

# Sentence splitter (shared style with the fact-checker §9.9).
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n+")

# Markdown table markup: a separator row is pure syntax (|---|---|) and must
# never be treated as prose (its "--" runs are not em-dashes); a data row
# (|cell|cell|) is structured data whose figures are attributed by the
# surrounding prose, not per-cell.
_TABLE_SEPARATOR_RE = re.compile(r"^\s*\|?[\s|:\-]+\|?\s*$")
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")


# --------------------------------------------------------------------------- #
# Draft flattening (tolerant of several shapes, mirrors factcheck §9.9)
# --------------------------------------------------------------------------- #
def _draft_text(draft: Any) -> str:
    """Flatten a draft into plain prose for rule matching (PRD §11).

    Tolerates ``{"sections": [...]}`` where a section is a dict with
    ``heading``/``content``/``body``/``text`` (possibly nested ``paragraphs``),
    a plain string, or a list of strings. Unknown shapes fall back to
    ``json.dumps`` so nothing is silently dropped.
    """
    if draft is None:
        return ""
    if isinstance(draft, str):
        return draft

    parts: list[str] = []

    def _emit(value: object) -> None:
        if value is None:
            return
        if isinstance(value, str):
            if value.strip():
                parts.append(value.strip())
        elif isinstance(value, (int, float)):
            parts.append(str(value))
        elif isinstance(value, dict):
            for key in ("heading", "title", "text", "content", "body", "markdown"):
                if key in value:
                    _emit(value[key])
            for key in ("paragraphs", "sections", "items", "children"):
                if key in value:
                    _emit(value[key])
        elif isinstance(value, (list, tuple)):
            for item in value:
                _emit(item)

    if isinstance(draft, dict):
        sections = draft.get("sections")
        if sections is not None:
            _emit(sections)
        if not parts:
            for key in ("text", "content", "body", "markdown"):
                if key in draft:
                    _emit(draft[key])
    if not parts:
        parts.append(json.dumps(draft)[:4000])

    return "\n".join(parts)


def _split_sentences(text: str) -> list[str]:
    """Split flattened prose into trimmed, non-empty sentences.

    Markdown table separator rows (pure ``|---|`` markup) are dropped — they are
    syntax, not prose, and their dash runs would false-positive the em-dash rule
    now that drafts legitimately contain comparison tables.
    """
    out: list[str] = []
    for raw in _SENTENCE_RE.split(text):
        if _TABLE_SEPARATOR_RE.match(raw or ""):
            continue
        s = raw.strip().strip("-•*").strip()
        if s:
            out.append(s)
    return out


def _is_table_row(sentence: str) -> bool:
    """True for a Markdown table data row (structured data, not a sentence)."""
    return bool(_TABLE_ROW_RE.match(sentence))


# Price-bracket scoping ("under $500", "up to $300"): defines the article's
# scope (usually straight from the user's own brief/keyword), not an assertion
# about the world — a bare "costs $299" is still a claim needing a source.
_SCOPE_PRICE_RE = re.compile(
    r"\b(?:under|below|over|above|up\s+to|less\s+than|around|about|within|capped\s+at|at)"
    r"\s*\$\s?\d[\d,]*(?:\.\d+)?\b"
    # Price ranges are budget guidance, not a verifiable fact:
    # "between $200 and $500", "$200 to $500", "from $200-$500".
    r"|\b(?:between|from)?\s*\$\s?\d[\d,]*(?:\.\d+)?\s*(?:-|–|to|and)\s*\$\s?\d[\d,]*(?:\.\d+)?\b"
    # "...a $400 budget/limit/cap/mark/price point/range" — the reader's budget
    # (usually straight from the brief), not a product-price assertion.
    r"|\$\s?\d[\d,]*(?:\.\d+)?\s+(?:budget|limit|cap|mark|range|price\s+point|price\s+range)\b",
    re.IGNORECASE,
)


# Imperative buying-guidance openers: "Aim for at least 20 hours of battery" is
# editorial advice, not a factual claim needing a citation (mirrors factcheck).
_ADVICE_OPENER_RE = re.compile(
    r"^\s*(?:choose|aim|look\s+for|expect|plan\s+to|pick|consider|go\s+for|"
    r"target|opt\s+for|prioriti[sz]e|check\s+for|make\s+sure|ensure|budget|try)\b",
    re.IGNORECASE,
)


def _is_statistical(sentence: str) -> bool:
    """True if the sentence makes a statistical/quantitative claim (PRD §11)."""
    sentence = _SCOPE_PRICE_RE.sub(" ", sentence)
    if re.search(r"\d+(?:\.\d+)?\s*%|\$\s?\d", sentence):
        return True
    # Imperative advice with a spec threshold is guidance, not a claim.
    if _ADVICE_OPENER_RE.match(sentence):
        return False
    # A bare number plus a quantity/measure cue counts as statistical.
    if re.search(r"\b\d[\d,]*(?:\.\d+)?\b", sentence) and re.search(
        r"\b(?:percent|users?|customers?|people|times|days?|hours?|years?|"
        r"creators?|sales?|fee|fees|cut|rate|average|out of|million|billion|"
        r"thousand|x\b)\b",
        sentence,
        re.IGNORECASE,
    ):
        return True
    return False


def _has_citation(sentence: str) -> bool:
    """True if the sentence names/links a source (PRD §11)."""
    return bool(_CITATION_RE.search(sentence))


# --------------------------------------------------------------------------- #
# Public API
# --------------------------------------------------------------------------- #
def _figure_in_evidence(sentence: str, evidence_texts: list[str] | None) -> bool:
    """True when a $-figure/percent in ``sentence`` appears in the evidence bank.

    The fact-checker verifies such claims against the fetched pages' actual
    text; this keeps the compliance gate consistent with it — a figure the
    evidence bank contains (with its source) is not "unsourced", even when the
    sentence lacks an inline attribution.
    """
    if not evidence_texts:
        return False
    figures = re.findall(r"\$\s?\d[\d,]*(?:\.\d+)?|\d+(?:\.\d+)?\s*%", sentence)
    if not figures:
        return False
    corpus = " ".join(evidence_texts)
    return all(fig.replace(" ", "") in corpus.replace(" ", "") for fig in figures)


def check(
    draft: Any,
    rules: dict[str, Any] | None = None,
    *,
    evidence_texts: list[str] | None = None,
) -> dict[str, Any]:
    """Run the house-rules compliance check (PRD §11).

    Deterministic and LLM-free: this is the hard pass/fail gate enforced before
    export, separate from EEAT scoring (PRD §11). Rules are per-website
    configurable via ``rules`` — anything passed there is shallow-merged over
    :data:`DEFAULT_RULES`, and a rule with ``{"enabled": False}`` is skipped.

    Args:
        draft: The draft payload — a ``{"sections": [...]}`` dict (the
            ``Draft.sections`` shape), a string, or a list of strings.
        rules: Optional per-website overrides for :data:`DEFAULT_RULES`.
        evidence_texts: Fact-bank texts from the fetched pages; a $-figure/%
            present there counts as sourced for the unsourced-claim rule.

    Returns:
        ``{"passed": bool, "violations": [{"rule", "detail", "locations"}, ...]}``.
        ``passed`` is False when any non-informational rule is violated;
        informational rules (typography_lock) never fail the gate but are still
        reported. ``locations`` lists the offending snippets/sentences.
    """
    cfg = _merge_rules(rules)
    text = _draft_text(draft)
    sentences = _split_sentences(text)
    # Section headings are navigation, not claims — they stay in the pool for
    # the style rules (em-dash, voice) but never flag as unsourced claims.
    headings: set[str] = set()
    if isinstance(draft, dict):
        for sec in draft.get("sections") or []:
            if isinstance(sec, dict):
                h = str(sec.get("heading") or sec.get("title") or "").strip()
                if h:
                    headings.add(h)

    violations: list[dict[str, Any]] = []

    def _enabled(name: str) -> bool:
        rule = cfg.get(name) or {}
        return bool(rule.get("enabled", False))

    def _detail(name: str) -> str:
        rule = cfg.get(name) or {}
        return str(rule.get("detail") or DEFAULT_RULES.get(name, {}).get("detail", name))

    def _add(name: str, locations: list[str]) -> None:
        if locations:
            violations.append(
                {"rule": name, "detail": _detail(name), "locations": locations}
            )

    # --- em_dash --------------------------------------------------------- #
    if _enabled("em_dash"):
        hits = [s for s in sentences if _EM_DASH_RE.search(s)]
        _add("em_dash", hits)

    # --- editorial_voice (we, not I) ------------------------------------- #
    if _enabled("editorial_voice"):
        hits = [s for s in sentences if _FIRST_PERSON_RE.search(s)]
        _add("editorial_voice", hits)

    # --- methodology_claim ----------------------------------------------- #
    if _enabled("methodology_claim"):
        hits = [
            s for s in sentences if any(p.search(s) for p in _METHODOLOGY_RES)
        ]
        _add("methodology_claim", hits)

    # --- faqpage_claim --------------------------------------------------- #
    if _enabled("faqpage_claim"):
        hits = [s for s in sentences if any(p.search(s) for p in _FAQPAGE_RES)]
        _add("faqpage_claim", hits)

    # --- unsourced_claim (negative or statistical without a source) ------ #
    # Table data rows are structured data: their figures are attributed by the
    # prose introducing the table (the writer is instructed to name the source
    # there), so only a NEGATIVE claim inside a table cell still flags.
    if _enabled("unsourced_claim"):
        hits = [
            s
            for s in sentences
            if s not in headings
            and not _has_citation(s)
            and not _figure_in_evidence(s, evidence_texts)
            and (
                _NEGATIVE_RE.search(s)
                or (_is_statistical(s) and not _is_table_row(s))
            )
        ]
        _add("unsourced_claim", hits)

    # --- typography_lock (informational note, always emitted) ------------ #
    if _enabled("typography_lock"):
        # Informational: report the rule once with no offending locations so
        # the editor sees the lock without it ever failing the gate.
        violations.append(
            {"rule": "typography_lock", "detail": _detail("typography_lock"), "locations": []}
        )

    # The gate passes only when no *enforced* rule has offending locations.
    failed = any(
        v["rule"] not in _INFORMATIONAL_RULES and v["locations"] for v in violations
    )
    return {"passed": not failed, "violations": violations}


def _merge_rules(rules: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    """Shallow-merge per-website ``rules`` over :data:`DEFAULT_RULES` (PRD §11)."""
    merged: dict[str, dict[str, Any]] = {
        name: dict(spec) for name, spec in DEFAULT_RULES.items()
    }
    if not rules:
        return merged
    for name, override in rules.items():
        base = merged.get(name, {})
        if isinstance(override, dict):
            base = {**base, **override}
        elif isinstance(override, bool):
            base = {**base, "enabled": override}
        merged[name] = base
    return merged
