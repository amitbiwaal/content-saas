"""Content Memory + Internal Links service (PRD §9.11, FR-11.1..11.3).

Pure, DB-free, zero-LLM logic:

* :func:`suggest_internal_links` (FR-11.2) matches the draft's entities and
  headings against the existing per-website knowledge graph (``Memory`` topic
  nodes) and returns anchored link suggestions.
* :func:`detect_overlap` (FR-11.3) flags a duplicate / thin overlapping topic
  for the same website and recommends ``merge`` | ``301`` | ``none``.
* :func:`upsert_topic_node` (FR-11.1) returns the row-shaped dict for a
  ``Memory`` node so the router can persist/update the knowledge graph.
* :func:`topic_coverage` (FR-11.1/11.4) summarises coverage by cluster for a
  website.

Matching is a deterministic token-overlap heuristic (Jaccard-style), so the
module produces sensible results with no API keys. The functions accept plain
dicts for ``draft`` and ``existing`` (each existing node carrying at least
``topic_node`` and an optional ``url``/``target_url``, ``cluster``, ``coverage``)
so they are trivially unit-testable without the ORM.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# --------------------------------------------------------------------------- #
# Tuning constants
# --------------------------------------------------------------------------- #
# Minimum token-overlap similarity (0..1) for a draft phrase to be linked to an
# existing topic node (FR-11.2). Below this a node is treated as unrelated.
_LINK_THRESHOLD = 0.34
# A new topic this similar (or more) to an existing node for the same website is
# treated as a near-duplicate / thin overlap (FR-11.3).
_DUPLICATE_THRESHOLD = 0.7
# Below the duplicate bar but still clearly related — surfaced as an overlap to
# review, with a "none" (keep both, just interlink) recommendation.
_OVERLAP_THRESHOLD = 0.45

# Common stop words stripped before token comparison so anchors match on the
# meaningful terms rather than glue words.
_STOPWORDS: frozenset[str] = frozenset(
    {
        "a", "an", "and", "the", "of", "to", "for", "in", "on", "with", "vs",
        "best", "guide", "how", "what", "why", "is", "are", "your", "you",
        "review", "reviews", "2024", "2025", "2026", "top",
    }
)


# --------------------------------------------------------------------------- #
# Result shapes (pure data; JSON-serialisable)
# --------------------------------------------------------------------------- #
@dataclass
class LinkSuggestion:
    """One internal-link suggestion (PRD §11.2 -> ``InternalLink`` row)."""

    target_url: str
    anchor: str
    # Diagnostics (not persisted) so the editor can rank/explain suggestions.
    topic_node: str = ""
    score: float = 0.0

    def as_link(self) -> dict[str, str]:
        """The persisted shape: just ``target_url`` + ``anchor`` (FR-11.2)."""
        return {"target_url": self.target_url, "anchor": self.anchor}


@dataclass
class OverlapReport:
    """Duplicate / thin-overlap verdict for a topic (PRD §11.3)."""

    duplicate: bool
    overlaps: list[dict] = field(default_factory=list)
    # merge | 301 | none — what to do about the overlap (FR-11.3).
    suggestion: str = "none"

    def as_dict(self) -> dict:
        return {
            "duplicate": self.duplicate,
            "overlaps": self.overlaps,
            "suggestion": self.suggestion,
        }


# --------------------------------------------------------------------------- #
# Tokenisation + similarity (deterministic, zero-LLM)
# --------------------------------------------------------------------------- #
def _stem(word: str) -> str:
    """Very light suffix stemmer so 'method'/'methods' and 'option'/'options'
    collapse to one token. Deliberately conservative (plurals/gerunds only) — it
    is a matching aid, not linguistically exact."""
    for suffix in ("ies", "es", "s", "ing", "ed"):
        if word.endswith(suffix) and len(word) - len(suffix) >= 3:
            base = word[: -len(suffix)]
            return base + "y" if suffix == "ies" else base
    return word


def _tokens(text: str) -> set[str]:
    """Lower-cased, stop-word-filtered, lightly-stemmed tokens for matching."""
    if not text:
        return set()
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {_stem(w) for w in words if w not in _STOPWORDS and len(w) > 1}


def _similarity(a: str, b: str) -> float:
    """Jaccard token overlap of two phrases (0..1).

    Symmetric and deterministic; used both to match a draft phrase to a topic
    node (FR-11.2) and to score topic-vs-topic overlap (FR-11.3).
    """
    ta, tb = _tokens(a), _tokens(b)
    if not ta or not tb:
        return 0.0
    inter = ta & tb
    if not inter:
        return 0.0
    return len(inter) / len(ta | tb)


def _node_topic(node: dict) -> str:
    """Best-effort topic text for an existing memory node."""
    for key in ("topic_node", "topic", "title", "name", "heading"):
        value = node.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _node_url(node: dict) -> str:
    """Best-effort canonical URL for an existing memory node."""
    for key in ("target_url", "url", "permalink", "link", "slug"):
        value = node.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


# --------------------------------------------------------------------------- #
# Draft phrase extraction (entities + headings)
# --------------------------------------------------------------------------- #
def _draft_phrases(draft: dict) -> list[str]:
    """Ordered, de-duplicated candidate anchor phrases from a draft (FR-11.2).

    Pulls explicit ``entities`` first (highest-signal anchors), then section
    headings, then the topic/keyword. Accepts the ``Draft.sections`` shape
    (``[{"heading","level","markdown"}]``) and looser hand-built dicts so tests
    can pass either.
    """
    phrases: list[str] = []

    def _add(value: object) -> None:
        if isinstance(value, str) and value.strip():
            phrases.append(value.strip())
        elif isinstance(value, dict):
            text = value.get("name") or value.get("text") or value.get("entity")
            if isinstance(text, str) and text.strip():
                phrases.append(text.strip())

    entities = draft.get("entities")
    if isinstance(entities, list):
        for item in entities:
            _add(item)

    sections = draft.get("sections")
    if isinstance(sections, list):
        for section in sections:
            if isinstance(section, dict):
                _add(section.get("heading"))

    headings = draft.get("headings")
    if isinstance(headings, list):
        for item in headings:
            _add(item)

    for key in ("topic", "keyword", "title"):
        _add(draft.get(key))

    # De-dupe case-insensitively, preserving first-seen order.
    seen: set[str] = set()
    unique: list[str] = []
    for phrase in phrases:
        low = phrase.lower()
        if low not in seen:
            seen.add(low)
            unique.append(phrase)
    return unique


# --------------------------------------------------------------------------- #
# FR-11.2 — internal-link suggestions
# --------------------------------------------------------------------------- #
def suggest_internal_links(
    website: str, draft: dict, existing: list[dict], *, max_links: int = 10
) -> list[dict]:
    """Suggest internal links with anchor text for the current draft (FR-11.2).

    Heuristic: match the draft's entities/headings/topic against existing
    ``Memory`` topic nodes for the *same* website and emit one link per matched
    node — anchored on the draft phrase that best matches it. The best-scoring
    draft phrase wins each node, and a node is never linked to itself (a phrase
    whose own URL equals the node URL is skipped).

    Args:
        website: The site the draft belongs to; existing nodes for other sites
            are ignored so links stay on-site (PRD §11.1 per-website graph).
        draft: Draft payload carrying ``entities`` / ``sections`` / ``headings``
            and ``topic`` / ``keyword`` (the article being linked *from*).
        existing: Existing memory nodes — dicts with ``topic_node`` and a URL
            (``target_url`` / ``url``); optionally ``website`` for filtering.
        max_links: Cap on returned suggestions, highest score first.

    Returns:
        ``[{"target_url", "anchor"}, ...]`` ready to persist as ``InternalLink``
        rows. Empty when nothing matches — never raises.
    """
    phrases = _draft_phrases(draft)
    if not phrases:
        return []

    self_topic = (draft.get("topic") or draft.get("title") or "").strip().lower()

    # For each candidate node, keep the single best-matching draft phrase.
    best_by_url: dict[str, LinkSuggestion] = {}
    for node in existing:
        if not isinstance(node, dict):
            continue
        node_site = node.get("website")
        if isinstance(node_site, str) and website and node_site != website:
            continue
        topic = _node_topic(node)
        url = _node_url(node)
        if not topic or not url:
            continue
        # Never suggest a link to the article we are writing.
        if self_topic and topic.lower() == self_topic:
            continue

        best_phrase = ""
        best_score = 0.0
        for phrase in phrases:
            score = _similarity(phrase, topic)
            if score > best_score:
                best_score = score
                best_phrase = phrase
        if best_score < _LINK_THRESHOLD or not best_phrase:
            continue

        existing_best = best_by_url.get(url)
        if existing_best is None or best_score > existing_best.score:
            best_by_url[url] = LinkSuggestion(
                target_url=url,
                anchor=best_phrase,
                topic_node=topic,
                score=round(best_score, 4),
            )

    ranked = sorted(
        best_by_url.values(), key=lambda s: (s.score, s.target_url), reverse=True
    )
    return [s.as_link() for s in ranked[:max_links]]


# --------------------------------------------------------------------------- #
# FR-11.3 — duplicate / thin-overlap detection
# --------------------------------------------------------------------------- #
def detect_overlap(
    website: str, topic: str, existing: list[dict]
) -> dict:
    """Warn on duplicate / thin overlapping content for a website (FR-11.3).

    Compares a proposed ``topic`` against existing topic nodes for the same
    website. The closest match drives the recommendation:

    * similarity >= ``_DUPLICATE_THRESHOLD`` -> ``duplicate=True``; suggest
      ``merge`` (consolidate into one stronger page) or ``301`` (redirect the
      thinner page) depending on the existing node's recorded ``coverage``.
    * ``_OVERLAP_THRESHOLD`` <= similarity < duplicate bar -> not a duplicate,
      but the overlap is surfaced with a ``none`` suggestion (keep both,
      interlink instead).
    * otherwise -> no overlap.

    Args:
        website: Site to scope the comparison to (per-website graph, PRD §11.1).
        topic: The proposed/new topic being checked before it is written.
        existing: Existing memory nodes (``topic_node`` + optional ``coverage`` /
            URL / ``website``).

    Returns:
        ``{"duplicate": bool, "overlaps": [...], "suggestion": "merge|301|none"}``.
        ``overlaps`` is sorted by similarity, highest first; never raises.
    """
    overlaps: list[dict] = []
    for node in existing:
        if not isinstance(node, dict):
            continue
        node_site = node.get("website")
        if isinstance(node_site, str) and website and node_site != website:
            continue
        node_topic = _node_topic(node)
        if not node_topic:
            continue
        score = _similarity(topic, node_topic)
        if score < _OVERLAP_THRESHOLD:
            continue
        coverage = node.get("coverage")
        overlaps.append(
            {
                "topic_node": node_topic,
                "target_url": _node_url(node),
                "similarity": round(score, 4),
                "coverage": float(coverage) if isinstance(coverage, (int, float)) else 0.0,
            }
        )

    overlaps.sort(key=lambda o: o["similarity"], reverse=True)

    if not overlaps:
        return OverlapReport(duplicate=False, overlaps=[], suggestion="none").as_dict()

    top = overlaps[0]
    duplicate = top["similarity"] >= _DUPLICATE_THRESHOLD
    if duplicate:
        # A well-covered existing page absorbs the new one (merge); a thin
        # existing page is redirected to the stronger new coverage (301).
        suggestion = "merge" if top["coverage"] >= 0.5 else "301"
    else:
        suggestion = "none"

    return OverlapReport(
        duplicate=duplicate, overlaps=overlaps, suggestion=suggestion
    ).as_dict()


# --------------------------------------------------------------------------- #
# FR-11.1 / 11.4 — knowledge-graph helpers
# --------------------------------------------------------------------------- #
def upsert_topic_node(
    website: str,
    topic_node: str,
    *,
    cluster: str | None = None,
    coverage: float = 0.0,
) -> dict:
    """Return the row-shaped dict for a ``Memory`` topic node (FR-11.1).

    Normalises inputs (trimmed strings, coverage clamped to 0..1) so the router
    can create or update a :class:`~app.models.Memory` row from it without
    re-validating. Pure: it persists nothing itself.

    Returns:
        ``{"website", "topic_node", "cluster", "coverage"}`` — the exact
        ``Memory`` column names (PRD §14 ``memory``).
    """
    clamped = max(0.0, min(1.0, float(coverage)))
    return {
        "website": (website or "").strip(),
        "topic_node": (topic_node or "").strip(),
        "cluster": cluster.strip() if isinstance(cluster, str) and cluster.strip() else None,
        "coverage": clamped,
    }


def topic_coverage(website: str, existing: list[dict]) -> dict:
    """Summarise topical authority coverage by cluster for a website (FR-11.1/11.4).

    Args:
        website: The site to scope to (informational; ``existing`` is assumed to
            already be that site's nodes, but a ``website`` field is honoured).
        existing: Memory nodes with ``topic_node`` + optional ``cluster`` /
            ``coverage``.

    Returns:
        ``{"website", "topic_count", "average_coverage", "clusters":
        [{"cluster", "topics", "topic_count", "average_coverage"}]}`` — a
        coverage map the dashboard can render. Clusters are sorted by topic
        count then name; ``None`` cluster is reported as ``"uncategorised"``.
    """
    nodes = [n for n in existing if isinstance(n, dict) and _node_topic(n)]
    if website:
        nodes = [
            n for n in nodes
            if not isinstance(n.get("website"), str) or n.get("website") == website
        ]

    clusters: dict[str, dict] = {}
    total_coverage = 0.0
    for node in nodes:
        cluster = node.get("cluster")
        key = cluster.strip() if isinstance(cluster, str) and cluster.strip() else "uncategorised"
        cov = node.get("coverage")
        cov = float(cov) if isinstance(cov, (int, float)) else 0.0
        total_coverage += cov
        bucket = clusters.setdefault(
            key, {"cluster": key, "topics": [], "_coverage_sum": 0.0}
        )
        bucket["topics"].append(_node_topic(node))
        bucket["_coverage_sum"] += cov

    cluster_out: list[dict] = []
    for bucket in clusters.values():
        count = len(bucket["topics"])
        cluster_out.append(
            {
                "cluster": bucket["cluster"],
                "topics": bucket["topics"],
                "topic_count": count,
                "average_coverage": round(bucket["_coverage_sum"] / count, 4) if count else 0.0,
            }
        )
    cluster_out.sort(key=lambda c: (-c["topic_count"], c["cluster"]))

    topic_count = len(nodes)
    return {
        "website": website,
        "topic_count": topic_count,
        "average_coverage": round(total_coverage / topic_count, 4) if topic_count else 0.0,
        "clusters": cluster_out,
    }
