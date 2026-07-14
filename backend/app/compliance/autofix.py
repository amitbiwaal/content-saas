"""Deterministic auto-remediation for house-rule violations (PRD §11).

The compliance checker (:mod:`app.compliance.house_rules`) is a hard pass/fail
gate, but real model drafts routinely trip two *mechanical* rules — em-dashes and
first-person singular ("I") — that a human would simply edit out. This module
applies those safe, reversible edits automatically so the pipeline can reach a
"publish-ready in one pass" state instead of blocking on cosmetics.

Everything here is pure, LLM-free and reproducible: em/en-dashes become commas or
hyphens, and first-person singular is rewritten to the editorial "we" voice. Only
mechanical rules are touched — substantive rules (unsourced claims, methodology,
FAQPage) are never auto-"fixed", because silencing them would hide real problems.
"""

from __future__ import annotations

import re

# Contractions first (so the apostrophe forms are handled before bare "I").
_CONTRACTIONS: tuple[tuple[str, str], ...] = (
    ("I'm", "we're"),
    ("I've", "we've"),
    ("I'll", "we'll"),
    ("I'd", "we'd"),
)

# First-person singular possessives / objects -> editorial plural.
_POSSESSIVES: tuple[tuple[str, str], ...] = (
    ("myself", "ourselves"),
    ("mine", "ours"),
    ("my", "our"),
    ("me", "us"),
)

_SENTENCE_BOUNDARY = set(".!?:;\n\"')(")

# Generic AI-boilerplate openers removed at a sentence start (the next word is
# re-capitalised). These are banned by the house style and read as filler.
_FILLER_OPENERS = (
    "in conclusion,",
    "it's important to note that",
    "it is important to note that",
    "in today's world,",
)
# Mid-sentence filler rewritten to a concise equivalent (meaning preserved).
_FILLER_SWAPS = (
    ("a wide range of", "many"),
    ("when it comes to", "for"),
    ("in the realm of", "in"),
)


def _strip_filler(text: str) -> str:
    """Remove/replace generic AI-filler phrases (raises originality; PRD §20)."""
    for opener in _FILLER_OPENERS:
        text = re.sub(
            r"(^|[.!?]\s+)" + re.escape(opener) + r"\s*",
            lambda m: m.group(1),
            text,
            flags=re.IGNORECASE,
        )
    for phrase, replacement in _FILLER_SWAPS:
        text = re.sub(re.escape(phrase), replacement, text, flags=re.IGNORECASE)
    # Re-capitalise sentence starts left lowercase by an opener removal.
    text = re.sub(r"^(\s*)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)
    text = re.sub(r"([.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)
    return text


def _sub_word(text: str, word: str, replacement: str) -> str:
    """Replace whole-word ``word`` with ``replacement``, preserving leading case."""
    def repl(match: re.Match[str]) -> str:
        found = match.group(0)
        return (
            replacement[0].upper() + replacement[1:]
            if found[:1].isupper()
            else replacement
        )

    return re.sub(rf"\b{re.escape(word)}\b", repl, text, flags=re.IGNORECASE)


def _replace_standalone_i(text: str) -> str:
    """Rewrite the pronoun "I" to "we"/"We" depending on sentence position."""
    def repl(match: re.Match[str]) -> str:
        start = match.start()
        j = start - 1
        while j >= 0 and text[j].isspace():
            j -= 1
        at_sentence_start = j < 0 or text[j] in _SENTENCE_BOUNDARY
        return "We" if at_sentence_start else "we"

    return re.sub(r"\bI\b", repl, text)


# Fenced code blocks (``` / ~~~) and inline code spans (`...`). Content inside
# these is verbatim (CLI flags like --amend, C-style decrement, quoted code) and
# must NOT be rewritten by the prose fixes below.
_CODE_RE = re.compile(r"(```.*?```|~~~.*?~~~|`[^`\n]+`)", re.DOTALL)


def _autofix_prose(text: str) -> str:
    """Apply the mechanical house-style edits to a prose (non-code) segment."""
    # Em/en-dashes are unambiguous typography. The ASCII "--" is only treated as
    # a prose dash when surrounded by whitespace, so CLI flags (`--amend`) and
    # decrements (`value--`) in prose are left intact.
    result = text.replace("—", ", ").replace("–", "-")
    result = re.sub(r"\s+--\s+", ", ", result)

    for form, replacement in _CONTRACTIONS:
        result = _sub_word(result, form, replacement)
    result = _replace_standalone_i(result)
    for form, replacement in _POSSESSIVES:
        result = _sub_word(result, form, replacement)
    result = _strip_filler(result)

    # Tidy artifacts introduced by dash removal (", ," / " ," / doubled spaces).
    result = re.sub(r"\s+,", ",", result)
    result = re.sub(r",\s*,", ",", result)
    result = re.sub(r"[ \t]{2,}", " ", result)
    return result


def autofix_text(text: str) -> str:
    """Strip em/en-dashes and rewrite first-person singular to editorial "we".

    Pure and idempotent-ish: safe to run on already-clean text (leaves it
    unchanged). Only mechanical house-rule triggers are touched, and only in
    prose — fenced code blocks and inline code spans are preserved verbatim so
    technical content (CLI flags, code fragments) is never corrupted.
    """
    if not text or not text.strip():
        return text

    # Split into alternating prose / code segments; fix prose, keep code as-is.
    return "".join(
        segment if i % 2 else _autofix_prose(segment)
        for i, segment in enumerate(_CODE_RE.split(text))
    )
