"""Fact Checker service (PRD §9.9, FR-9.1..9.3).

Pure, DB-free functions so they are unit-testable with synthetic inputs:

* :func:`extract_claims` — pull every factual/statistical claim out of a draft
  (FR-9.1) using regex/heuristics: sentences carrying numbers, ``%``, ``$``,
  superlatives, or statistical/negation verbs.
* :func:`grade_claim` — attach a source, confidence and risk level, then a
  decision label (FR-9.2/9.3) by matching the claim against research sources.
  Unsourced statistical or negative claims become ``risk="high"`` /
  ``label="needs_evidence"`` — the PRD §11 house rule bans unsourced negative
  or statistical claims, and PRD §10 blocks publish on high-risk unsupported
  claims.
* :func:`check_draft` — grade the whole draft and report the
  ``high_risk_unsupported`` count that feeds the publish gate (PRD §10).

Every function works with ZERO API keys. ``grade_claim`` may consult the LLM
adapter to suggest a source, but always carries a deterministic non-LLM
heuristic fallback (defensive ``json.loads`` + token-overlap matching), so the
module behaves sensibly against the default :class:`MockAdapter`.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

from app.providers import ProviderError, get_adapter

# --------------------------------------------------------------------------- #
# Heuristic vocabularies
# --------------------------------------------------------------------------- #
# Decision labels valid across the system (PRD §8.3 / Claim.label).
LABELS = ("accepted", "rejected", "needs_evidence", "merge", "manual_review")
RISKS = ("low", "medium", "high")

# Statistical / quantitative cue words. A sentence is "statistical" if it carries
# a number/percent/currency token or one of these stat verbs.
_STAT_WORDS = (
    "percent",
    "percentage",
    "average",
    "median",
    "rate",
    "ratio",
    "share",
    "majority",
    "minority",
    "fraction",
    "double",
    "doubled",
    "triple",
    "tripled",
    "increase",
    "increased",
    "decrease",
    "decreased",
    "grew",
    "growth",
    "fell",
    "rose",
    "surveyed",
    "study",
    "studies",
    "report",
    "reported",
    "statistics",
    "data",
)

# Superlatives / absolute claims the Human Editor and house rules flag.
_SUPERLATIVES = (
    "best",
    "worst",
    "most",
    "least",
    "fastest",
    "slowest",
    "cheapest",
    "largest",
    "smallest",
    "biggest",
    "greatest",
    "highest",
    "lowest",
    "leading",
    "number one",
    "#1",
    "top-rated",
    "unbeatable",
    "guaranteed",
    "always",
    "never",
    "every",
    "all",
    "none",
    "only",
)

# Negative-claim cues. PRD §11 bans UNSOURCED negative claims, so these escalate
# risk exactly like statistical claims when no source is found.
_NEGATIVE_WORDS = (
    "scam",
    "fraud",
    "fraudulent",
    "fake",
    "illegal",
    "dangerous",
    "unsafe",
    "lawsuit",
    "sued",
    "banned",
    "ripoff",
    "rip-off",
    "complaint",
    "complaints",
    "failed",
    "failure",
    "worst",
    "terrible",
    "untrustworthy",
    "violation",
    "breach",
    "hidden fee",
    "hidden fees",
    "steals",
    "deceptive",
    "misleading",
)

# Numeric / money / percent token (e.g. "20%", "$5", "5 to 7", "200+", "1,200").
_NUMERIC_RE = re.compile(r"(?:\$\s?\d|\d[\d,\.]*\s?%|\b\d[\d,\.]*\b|\d\+)")

# Alphanumeric product/model identifiers (WH-1000XM6, QC45, EG1, M4): names,
# not quantities — stripped before the numeric test.
_MODEL_NUMBER_RE = re.compile(r"\b[A-Za-z]+[-–]?\d[\w-]*\b")

# An INLINE citation the writer attached to a claim: a URL/domain, a markdown
# link, or an explicit "according to <Source>" / "per <Source>" attribution. A
# claim that cites its own source is supported on its face (FR-9.2).
_INLINE_CITE_RE = re.compile(
    r"https?://\S+"
    r"|\bwww\.\S+"
    r"|\[[^\]]+\]\([^)]+\)"
    r"|\b\w[\w-]*\.(?:com|org|net|io|gov|edu|co)\b"
    r"|\baccording to\s+[A-Z0-9][\w .&'’-]{2,40}"
    r"|\bper\s+[A-Z0-9][\w .&'’-]{2,40}"
    # Attribution-verb forms the writer uses: "As Wirecutter notes",
    # "RTINGS reports", "Home Office Nomad highlights/praises/points out".
    # (?-i:) keeps the source-name capital REQUIRED despite IGNORECASE, so
    # "it notes that" / "as we found" never count as citations.
    # Optional closing quote/bracket between the source name and the verb, so
    # 'a review on "Good Housekeeping" highlights ...' still counts.
    r"|\bas\s+(?-i:[A-Z][\w'’&.-]*(?:\s+[A-Z][\w'’&.-]*){0,3})[\"'”’)\]]{0,2}\s+(?:notes?|reports?|highlights?|says?|states?|found|finds?|observes?|points?\s+out)"
    r"|(?-i:\b[A-Z][\w'’&.-]*(?:\s+[A-Z][\w'’&.-]*){0,3})[\"'”’)\]]{0,2}\s+(?:notes?|reports?|highlights?|praises?|recommends?|mentions?|confirms?|observes?|points?\s+out|found|finds?|states?|stated|writes?|wrote|warns?|suggests?|advises?|explains?|argues?|estimates?|predicts?|shows?)\b"
    r"|\(source:[^)]+\)",
    re.IGNORECASE,
)


def _inline_citation(text: str) -> str | None:
    """Return the inline citation a claim attaches to itself, or None."""
    match = _INLINE_CITE_RE.search(text)
    return match.group(0).strip() if match else None


# Sentence splitter — keeps it dependency-free. Splits on . ! ? followed by
# whitespace, and on newlines (so list items / headings become candidates).
_SENTENCE_RE = re.compile(r"(?<=[.!?])\s+|\n+")

# Tokeniser for source-matching overlap.
_WORD_RE = re.compile(r"[a-z0-9$%]+")
# Generic stop-words ignored when measuring claim/source overlap.
_STOP = {
    "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
    "was", "were", "be", "by", "with", "at", "as", "it", "its", "this", "that",
    "these", "those", "from", "has", "have", "had", "will", "than", "then",
    "but", "not", "no", "we", "you", "they", "their", "our", "your",
}


@dataclass
class Claim:
    """A graded claim (FR-9.2/9.3). Mirrors the ``claim`` table columns."""

    text: str
    source: str | None = None
    confidence: float | None = None
    risk: str = "low"
    label: str | None = None
    # Why the claim was extracted, for transparency in the UI.
    kinds: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "text": self.text,
            "source": self.source,
            "confidence": self.confidence,
            "risk": self.risk,
            "label": self.label,
            "kinds": self.kinds,
        }


# --------------------------------------------------------------------------- #
# Draft flattening
# --------------------------------------------------------------------------- #
def _draft_text(draft: dict) -> str:
    """Flatten a draft dict into plain prose for claim extraction.

    Tolerates several shapes: ``{"sections": [...]}`` where a section is a dict
    with ``heading``/``content``/``body``/``text`` (and possibly nested
    ``paragraphs``), a plain string, or a list of strings. Unknown shapes fall
    back to ``json.dumps`` so nothing is silently dropped.
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
            # Body prose only — a section HEADING is navigation, not a claim
            # (headings like "Top Picks Under $300" false-positived as high-risk
            # unsourced claims and blocked the gate). Note "markdown" IS
            # included: it is the actual Draft.sections body key — without it
            # the checker only ever saw headings.
            for key in ("markdown", "text", "content", "body"):
                if key in value:
                    _emit(value[key])
            for key in ("paragraphs", "sections", "items", "children"):
                if key in value:
                    _emit(value[key])
        elif isinstance(value, (list, tuple)):
            for item in value:
                _emit(item)

    sections = draft.get("sections") if isinstance(draft, dict) else None
    if sections is not None:
        _emit(sections)
    if not parts and isinstance(draft, dict):
        # Last resort: pull any string values from the dict.
        for key in ("text", "content", "body"):
            if key in draft:
                _emit(draft[key])
    if not parts:
        parts.append(json.dumps(draft)[:4000])

    return "\n".join(parts)


# Markdown table rows are structured data (specs), attributed by the prose
# introducing the table — mirror the compliance checker's treatment.
_TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")

# Short "Label: value" spec list items ("Capacity: 3.5 quarts", "Height:
# Manual Crank") are structured data like table rows, not claim sentences.
_SPEC_LINE_RE = re.compile(r"^[A-Za-z][\w /()&'-]{0,30}:\s+\S.{0,45}$")

# Price-bracket / range scoping ("under $300", "between $200 and $500"): the
# article's own scope from the brief, not an assertion about the world.
_SCOPE_PRICE_RE = re.compile(
    r"\b(?:under|below|over|above|up\s+to|less\s+than|around|about|within|capped\s+at|at)"
    r"\s*\$\s?\d[\d,]*(?:\.\d+)?\b"
    r"|\b(?:between|from)?\s*\$\s?\d[\d,]*(?:\.\d+)?\s*(?:-|–|to|and)\s*\$\s?\d[\d,]*(?:\.\d+)?\b",
    re.IGNORECASE,
)

# Imperative buying-guidance openers: "Aim for at least 20 hours of battery" is
# editorial advice, not a verifiable factual claim.
_ADVICE_OPENER_RE = re.compile(
    r"^\s*(?:choose|aim|look\s+for|expect|plan\s+to|pick|consider|go\s+for|"
    r"target|opt\s+for|prioriti[sz]e|check\s+for|make\s+sure|ensure|budget)\b",
    re.IGNORECASE,
)


def _split_sentences(text: str) -> list[str]:
    raw = _SENTENCE_RE.split(text)
    out: list[str] = []
    seen: set[str] = set()
    for s in raw:
        if _TABLE_ROW_RE.match(s or ""):
            continue
        s = s.strip().strip("-•*").strip()
        if len(s) < 8:  # drop fragments / bare headings noise
            continue
        if _SPEC_LINE_RE.match(s):  # "Capacity: 3.5 quarts" spec entries
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
    return out


_YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")


def _keyword_phrases(research: dict | None) -> list[str]:
    """The article's own keyword phrases (primary + secondary), lower-cased.

    A sentence whose only "superlative"/"numeric" trigger is the keyword itself
    ("best noise cancelling headphones 2026") is using the topic phrase, not
    asserting a claim — these phrases are stripped before classification.
    """
    out: list[str] = []
    kw = (research or {}).get("keywords") or {}
    for phrase in [kw.get("primary"), (research or {}).get("keyword"), *(kw.get("secondary") or [])]:
        if isinstance(phrase, str) and len(phrase.strip()) >= 6:
            out.append(phrase.strip().lower())
    return out


def _strip_keyword_phrases(sentence: str, phrases: list[str]) -> str:
    low = sentence.lower()
    for p in phrases:
        idx = low.find(p)
        while idx != -1:
            sentence = sentence[:idx] + " " * len(p) + sentence[idx + len(p):]
            low = sentence.lower()
            idx = low.find(p)
    return sentence


def _classify(sentence: str, phrases: list[str] | None = None) -> list[str]:
    """Return the reasons (kinds) a sentence is a claim, or [] if it is not."""
    if phrases:
        sentence = _strip_keyword_phrases(sentence, phrases)
    low = sentence.lower()
    kinds: list[str] = []

    # Strip scope-pricing before the numeric test; and advice sentences whose
    # only figure is a spec threshold are guidance, not claims.
    numeric_probe = _SCOPE_PRICE_RE.sub(" ", sentence)
    # Product model numbers (WH-1000XM6, EG1, X3) are names, not statistics;
    # bare years ("in 2026") are context, not quantities.
    numeric_probe = _MODEL_NUMBER_RE.sub(" ", numeric_probe)
    numeric_probe = _YEAR_RE.sub(" ", numeric_probe)
    if _ADVICE_OPENER_RE.match(sentence) and "%" not in sentence:
        numeric_probe = ""
    if numeric_probe and _NUMERIC_RE.search(numeric_probe):
        kinds.append("numeric")
    # Whole-word match — substring matching flagged "concentrate"/"integrated"
    # via the embedded "rate".
    if any(re.search(rf"\b{re.escape(w)}\b", low) for w in _STAT_WORDS):
        if "statistical" not in kinds:
            kinds.append("statistical")
    # "at least"/"at most" are quantifier idioms, not superlative claims.
    superlative_probe = re.sub(r"\bat\s+(?:least|most)\b", " ", low)
    if any(re.search(rf"\b{re.escape(w)}\b", superlative_probe) for w in _SUPERLATIVES):
        kinds.append("superlative")
    if any(w in low for w in _NEGATIVE_WORDS):
        kinds.append("negative")

    # Numeric tokens almost always indicate a statistical assertion too.
    if "numeric" in kinds and "statistical" not in kinds:
        kinds.append("statistical")
    return kinds


# --------------------------------------------------------------------------- #
# FR-9.1 — Claim extraction
# --------------------------------------------------------------------------- #
def extract_claims(draft: dict, research: dict | None = None) -> list[dict]:
    """Extract every factual/statistical claim from a draft (FR-9.1).

    Heuristic: a sentence is a claim if it contains a number, ``%``, ``$``, a
    superlative/absolute, or a statistical/negation cue — AFTER the article's
    own keyword phrases are stripped (their "best"/"2026" are topic wording,
    not assertions). Pure and deterministic — no LLM call.

    Returns a list of dicts with ``text`` and ``kinds`` (why it was flagged);
    grading is applied later by :func:`grade_claim`.
    """
    phrases = _keyword_phrases(research)
    text = _draft_text(draft)
    claims: list[dict] = []
    for sentence in _split_sentences(text):
        kinds = _classify(sentence, phrases)
        if kinds:
            claims.append({"text": sentence, "kinds": kinds})
    return claims


# --------------------------------------------------------------------------- #
# Source matching
# --------------------------------------------------------------------------- #
def _tokens(text: str) -> set[str]:
    return {t for t in _WORD_RE.findall(text.lower()) if t not in _STOP and len(t) > 1}


def _iter_sources(research: dict | None) -> list[dict]:
    """Normalise research into a list of ``{label, text}`` source records.

    Accepts the ``research`` brief shape (PRD §9.4): a dict that may carry
    ``sources`` (list of dicts or strings), and also mines ``serp`` results.
    Defensive about shape so it works with whatever Research Intelligence emits.
    """
    if not isinstance(research, dict):
        return []
    out: list[dict] = []

    def _add(entry: object) -> None:
        if entry is None:
            return
        if isinstance(entry, str):
            out.append({"label": entry, "text": entry})
            return
        if isinstance(entry, dict):
            label = (
                entry.get("url")
                or entry.get("link")
                or entry.get("domain")
                or entry.get("title")
                or entry.get("name")
                or entry.get("source")
                or ""
            )
            text_parts = [
                str(entry.get(k, ""))
                for k in ("title", "name", "snippet", "description", "summary",
                          "text", "domain", "url")
            ]
            out.append({"label": str(label), "text": " ".join(text_parts)})

    for key in ("sources", "serp", "entities", "headings", "paa"):
        value = research.get(key)
        if isinstance(value, list):
            for entry in value:
                _add(entry)
    return out


def _best_source(claim_text: str, sources: list[dict]) -> tuple[str | None, float, bool]:
    """Return (source_label, match_score 0-1, number_matched) for the best source.

    Score = Jaccard-ish overlap weighted toward content tokens shared with the
    claim, with a bonus when a distinctive numeric token co-occurs.
    ``number_matched`` reports whether a figure from the claim actually appears in
    the winning source's text — used to gate statistical claims so a loosely
    word-overlapping source can't "support" a number it never mentions.
    """
    claim_tokens = _tokens(claim_text)
    if not claim_tokens or not sources:
        return None, 0.0, False

    claim_numbers = set(_NUMERIC_RE.findall(claim_text))
    best_label: str | None = None
    best_score = 0.0
    best_num_ok = False
    for src in sources:
        src_tokens = _tokens(src["text"])
        if not src_tokens:
            continue
        overlap = claim_tokens & src_tokens
        if not overlap:
            continue
        score = len(overlap) / len(claim_tokens)
        num_ok = bool(claim_numbers) and any(n in src["text"] for n in claim_numbers)
        # Bonus when a number in the claim also appears in the source text.
        if num_ok:
            score = min(1.0, score + 0.3)
        if score > best_score:
            best_score = score
            best_label = src["label"] or src["text"][:80]
            best_num_ok = num_ok
    return best_label, best_score, best_num_ok


def _llm_source_hint(claim_text: str, sources: list[dict]) -> str | None:
    """Optionally ask the adapter to name a supporting source.

    Defensive: parses JSON in a try/except and never raises. Returns None on any
    failure so the deterministic heuristic in :func:`grade_claim` remains the
    source of truth. With the MockAdapter this simply yields no usable hint.
    """
    if not sources:
        return None
    system = (
        "You are a fact-checker. Given a claim and candidate sources, return "
        'strict JSON {"source": str|null} naming the single best supporting '
        "source label, or null if none supports the claim."
    )
    catalogue = [{"label": s["label"], "text": s["text"][:200]} for s in sources[:8]]
    prompt = json.dumps({"claim": claim_text, "sources": catalogue})
    try:
        resp = get_adapter("anthropic").complete(
            system=system, prompt=prompt, json_mode=True
        )
        data = json.loads(resp.text)
        source = data.get("source")
        if isinstance(source, str) and source.strip():
            # Only trust the hint if it names a real candidate label.
            labels = {s["label"] for s in sources}
            if source in labels:
                return source
    except (ProviderError, json.JSONDecodeError, TypeError, AttributeError):
        pass
    return None


# --------------------------------------------------------------------------- #
# FR-9.2 / FR-9.3 — Grading
# --------------------------------------------------------------------------- #
def grade_claim(claim_text: str, research: dict, *, use_llm_hint: bool = True) -> dict:
    """Grade one claim: attach source, confidence, risk and label.

    FR-9.2: every claim gets a source, confidence score and risk level.
    FR-9.3: a decision label is assigned and unsupported high-risk claims are
    surfaced so the publish gate (PRD §10) can block them.

    House rule (PRD §11): unsourced negative or statistical claims are not
    allowed — these become ``risk="high"`` / ``label="needs_evidence"``. A
    sourced statistical claim is ``accepted`` with low risk. Superlatives with
    no source are ``medium`` risk and ``manual_review`` (editorial, not a hard
    block). Plain factual claims with no special cue default low/accepted.

    ``use_llm_hint`` gates the optional per-claim LLM source suggestion; the
    pipeline passes ``False`` so scoring stays fast and fully deterministic (the
    hint is an editor-time nicety, not a batch-run cost).
    """
    kinds = _classify(claim_text, _keyword_phrases(research))
    sources = _iter_sources(research)
    label_source, score, num_ok = _best_source(claim_text, sources)

    # The heuristic match is authoritative; the LLM hint can only *add* a source
    # the heuristic missed, never remove one — keeping a deterministic floor.
    SUPPORT_THRESHOLD = 0.45
    supported = label_source is not None and score >= SUPPORT_THRESHOLD

    is_stat = "statistical" in kinds or "numeric" in kinds
    # A numeric claim needs its actual figure in the source (unless word overlap
    # is very strong) — stops a merely word-similar page from "supporting" a
    # number it never mentions (the misattributed-source bug).
    if supported and is_stat and _NUMERIC_RE.search(claim_text) and not num_ok and score < 0.7:
        supported = False

    chosen_source = label_source if supported else None

    # A claim that cites its own source inline (URL / "according to X") is
    # supported on its face — credit the writer's attribution even when the
    # source is not in the research list (FR-9.2).
    if not supported:
        inline = _inline_citation(claim_text)
        if inline:
            chosen_source = inline
            supported = True
            score = max(score, 0.6)

    if not supported and use_llm_hint:
        hint = _llm_source_hint(claim_text, sources)
        if hint:
            chosen_source = hint
            supported = True
            score = max(score, 0.5)

    is_negative = "negative" in kinds
    is_superlative = "superlative" in kinds

    if supported:
        # Sourced claim — confidence scales with match strength.
        confidence = round(min(0.95, 0.55 + score * 0.4), 2)
        risk = "low"
        # A sourced *pure* superlative still warrants a human glance, but a
        # superlative that is also a sourced statistic (e.g. "the only platform
        # charging 20%") is accepted — the number is what's being verified.
        pure_superlative = is_superlative and not is_stat
        label = "manual_review" if pure_superlative else "accepted"
    elif is_stat or is_negative:
        # PRD §11: unsourced statistical OR negative claim — must be cited first.
        confidence = round(0.2 + score * 0.2, 2)
        risk = "high"
        label = "needs_evidence"
    elif is_superlative:
        # Unsupported absolute/superlative — soften or review, but not a hard block.
        confidence = 0.4
        risk = "medium"
        label = "manual_review"
    else:
        # Plain factual statement with no risky cue and no matching source.
        confidence = round(0.4 + score * 0.3, 2)
        risk = "low"
        label = "accepted"

    return {
        "text": claim_text,
        "source": chosen_source,
        "confidence": confidence,
        "risk": risk,
        "label": label,
        "kinds": kinds,
    }


# --------------------------------------------------------------------------- #
# Whole-draft check
# --------------------------------------------------------------------------- #
def check_draft(draft: dict, research: dict, *, use_llm_hint: bool = True) -> dict:
    """Fact-check a whole draft (FR-9.1..9.3).

    Extracts every claim, grades each, and counts ``high_risk_unsupported`` —
    high-risk claims with no source. That count feeds the publish gate
    (PRD §10): publish is blocked while any high-risk unsupported claim remains.

    ``use_llm_hint`` is forwarded to :func:`grade_claim`; the pipeline passes
    ``False`` so a batch run makes no per-claim LLM calls (fast + deterministic).
    """
    graded: list[dict] = []
    high_risk_unsupported = 0
    for claim in extract_claims(draft, research):
        result = grade_claim(claim["text"], research, use_llm_hint=use_llm_hint)
        # Preserve extraction reasons (union of both passes).
        merged_kinds = sorted(set(claim.get("kinds", [])) | set(result.get("kinds", [])))
        result["kinds"] = merged_kinds
        if result["risk"] == "high" and not result["source"]:
            high_risk_unsupported += 1
        graded.append(result)

    return {
        "claims": graded,
        "high_risk_unsupported": high_risk_unsupported,
    }
