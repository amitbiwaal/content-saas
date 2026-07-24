"""Redesigned pipeline: keywords → competitors → council → outline → article →
polish → checks, all offline (mock adapters + mock research).

Covers the new stage modules (keyword research, competitor-page analysis, SEO
polish) and the stream contract the frontend depends on: stage event order,
derived project keyword, the persisted Research keywords/competitors, the
seo_meta event, and the gated pauses (research checkpoint after competitors,
draft checkpoint after polish).
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.article.polish import generate_seo_meta, stream_polish
from app.db import Base
from app.models import Project, Research
from app.pipeline.service import STAGES, stream_full_pipeline
from app.research.fetcher import analyze_page_html, competitor_headings
from app.research.keywords import research_keywords


@pytest.fixture(autouse=True)
def force_mock(monkeypatch):
    """No live LLM or research calls, regardless of .env keys."""
    monkeypatch.setattr("app.providers.factory._build_real", lambda *a, **k: None)
    monkeypatch.setattr("app.config.Settings.research_provider", "mock", raising=False)


@pytest.fixture()
def db(tmp_path):
    engine = create_engine(
        f"sqlite:///{tmp_path / 'redesign.db'}",
        connect_args={"check_same_thread": False},
    )
    Base.metadata.create_all(engine)
    Session = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        engine.dispose()


def _project(db, **overrides) -> Project:
    fields = {
        "website": "example.com",
        "topic": "Best standing desks for a home office, for remote workers",
        "keyword": "",
        "country": "US",
    }
    fields.update(overrides)
    project = Project(**fields)
    db.add(project)
    db.commit()
    return project


# --------------------------------------------------------------------------- #
# Keyword research (stage 1)
# --------------------------------------------------------------------------- #
def test_research_keywords_offline_shape():
    kw = research_keywords({"topic": "Best standing desks for a home office"})
    assert kw["primary"]
    assert isinstance(kw["secondary"], list) and kw["secondary"]
    assert isinstance(kw["longtail"], list) and kw["longtail"]
    assert all(q.endswith("?") for q in kw["longtail"])
    assert kw["intent"] in {"informational", "commercial", "transactional", "navigational"}


def test_research_keywords_honors_user_keyword():
    kw = research_keywords(
        {"topic": "why ergonomic chairs beat couches", "keyword": "ergonomic chair"}
    )
    assert kw["primary"] == "ergonomic chair"


def test_keyword_variants_and_volume_selection():
    from app.research.keywords import _keyword_variants, _select_primary, enrich_with_ahrefs

    # Variants: plural↔singular flip + a "best X" form.
    variants = _keyword_variants("quiet mechanical keyboards")
    assert "quiet mechanical keyboard" in variants
    assert "best quiet mechanical keyboards" in variants

    # Selection: highest volume wins under the difficulty cap...
    metrics = {
        "quiet mechanical keyboards": {"volume": 150, "difficulty": 0},
        "quiet mechanical keyboard": {"volume": 2500, "difficulty": 0},
        "hard one": {"volume": 90000, "difficulty": 80},  # over the cap → skipped
    }
    picked = _select_primary(
        "quiet mechanical keyboards",
        ["quiet mechanical keyboards", "quiet mechanical keyboard", "hard one"],
        metrics,
    )
    assert picked == "quiet mechanical keyboard"
    # ...and no data at all keeps the original.
    assert _select_primary("x", ["x"], {}) == "x"

    # No API key → the set passes through untouched.
    kw = {"primary": "quiet mechanical keyboards", "secondary": []}
    assert enrich_with_ahrefs(dict(kw), "US", api_key="") == kw


def test_user_locked_keyword_never_swapped(monkeypatch):
    from app.research import keywords as kwmod

    monkeypatch.setattr(
        kwmod,
        "_ahrefs_metrics",
        lambda cands, country, key: {
            "my keyword": {"volume": 10, "difficulty": 0},
            "better keyword": {"volume": 9999, "difficulty": 0},
        },
    )
    out = kwmod.enrich_with_ahrefs(
        {"primary": "my keyword", "secondary": ["better keyword"], "user_locked": True},
        "US",
        api_key="k",
    )
    assert out["primary"] == "my keyword"  # annotated, never replaced
    assert out["volume"] == 10


def test_auto_word_target_tracks_competitor_median():
    from app.pipeline.service import _auto_word_target

    norm = {"competitors": [{"word_count": w} for w in (3349, 4117, 4280, 7520)]}
    target = _auto_word_target(norm)
    assert target == 2600  # median 4280 * 0.85 = 3638 → clamped to 2600
    assert _auto_word_target({"competitors": []}) is None
    thin = {"competitors": [{"word_count": 900}]}
    assert _auto_word_target(thin) == 1200  # floor


# --------------------------------------------------------------------------- #
# Competitor page analysis (stage 2)
# --------------------------------------------------------------------------- #
_HTML = """
<html><head><title>Standing Desk Guide | ExampleSite</title></head><body>
<nav><h2>Menu</h2></nav>
<h1>The Standing Desk Guide</h1>
<p>Long intro paragraph with a number of words in it for counting purposes.</p>
<h2>Height range and presets</h2><p>Body text one two three.</p>
<h2>Cable management</h2><p>More body text here.</p>
<h3>Frequently asked questions</h3>
<table><tr><td>a</td></tr></table>
<script>var junk = 'ignored heading text';</script>
</body></html>
"""


def test_analyze_page_html_extracts_structure():
    page = analyze_page_html(_HTML, url="https://ex.com/desk", domain="ex.com")
    assert page is not None
    assert page["h1"] == "The Standing Desk Guide"
    assert "Height range and presets" in page["headings"]
    assert "Cable management" in page["headings"]
    # nav chrome (h2 inside <nav>) must not leak into headings
    assert "Menu" not in page["headings"]
    assert page["title"].startswith("Standing Desk Guide")
    assert page["has_table"] is True
    assert page["has_faq"] is True
    assert page["word_count"] > 10


def test_analyze_page_html_rejects_headingless_shell():
    assert analyze_page_html("<html><body><p>no structure</p></body></html>") is None


def test_competitor_headings_interleaves_and_dedupes():
    pages = [
        {"headings": ["A", "B", "C"]},
        {"headings": ["A", "D"]},
    ]
    flat = competitor_headings(pages)
    assert flat == ["A", "B", "D", "C"]


# --------------------------------------------------------------------------- #
# SEO polish (stage: polish) — safe no-op with the mock adapter
# --------------------------------------------------------------------------- #
def test_stream_polish_mock_is_lossless():
    draft = {
        "sections": [
            {"heading": "Overview", "level": 2, "markdown": "Original body text here."},
            {"heading": "FAQ", "level": 2, "markdown": "**Q?** A."},
        ],
        "word_count": 6,
    }
    events = list(stream_polish(draft, {"topic": "t"}, {}))
    done = events[-1]
    assert done["kind"] == "done"
    # Mock output is rejected by the conservative guard → originals survive.
    assert done["draft"]["sections"][0]["markdown"] == "Original body text here."
    assert done["changed"] == 0
    # One section_done event per section, indexes intact.
    idx = sorted(e["index"] for e in events if e["kind"] == "section_done")
    assert idx == [0, 1]


def test_strip_fake_links():
    from app.article.polish import _strip_fake_links

    assert (
        _strip_fake_links("Great basket ([source: Good Housekeeping](source)).")
        == "Great basket (Good Housekeeping)."
    )
    assert (
        _strip_fake_links("Care needed ([per Talk of the House](source)).")
        == "Care needed (per Talk of the House)."
    )
    # Real markdown links stay untouched.
    real = "See [the review](https://ex.com/review) for details."
    assert _strip_fake_links(real) == real


def test_generate_seo_meta_fallback_shape():
    draft = {"sections": [{"heading": "Overview", "level": 2, "markdown": "Body."}]}
    meta = generate_seo_meta(
        draft, {"topic": "t"}, {"keywords": {"primary": "standing desk", "secondary": []}}
    )
    assert meta["title"]
    assert meta["slug"]
    assert isinstance(meta["takeaways"], list)


# --------------------------------------------------------------------------- #
# Full pipeline stream: stage order, artifacts, derived keyword, seo_meta
# --------------------------------------------------------------------------- #
def test_full_pipeline_emits_new_stages_and_artifacts(db):
    project = _project(db)
    events = list(stream_full_pipeline(db, project))

    started = [e["data"]["stage"] for e in events if e["event"] == "stage" and e["data"]["status"] == "start"]
    assert started == list(STAGES)

    # Keyword stage derived + persisted the primary keyword on the project.
    assert (project.keyword or "").strip()
    kw_done = next(
        e for e in events
        if e["event"] == "stage" and e["data"]["stage"] == "keywords" and e["data"]["status"] == "done"
    )
    assert kw_done["data"]["info"]["keywords"]["primary"]

    # Research row carries the keyword set (mock => no fetched competitors).
    row = db.scalars(select(Research).where(Research.project_id == project.id)).first()
    assert row is not None and row.keywords and row.keywords.get("primary")

    # Polish emitted the meta pack and the done summary carries it.
    assert any(e["event"] == "seo_meta" for e in events)
    done = events[-1]
    assert done["event"] == "done"
    assert done["data"]["keywords"]["primary"]
    assert done["data"]["seo"] and done["data"]["seo"].get("title")
    assert done["data"]["research"]["pages_analyzed"] == 0  # mock => no fetches


def test_gated_run_pauses_after_competitors_then_polish(db):
    project = _project(db)

    # First leg: pauses at the research checkpoint (after competitors).
    events = list(stream_full_pipeline(db, project, gated=True))
    waits = [e for e in events if e["event"] == "awaiting_approval"]
    assert len(waits) == 1
    assert waits[0]["data"]["stage"] == "research"
    assert waits[0]["data"]["next"] == "council"
    assert waits[0]["data"]["regenerate"] == "keywords"

    # Resume through council → outline → polish (each pauses in turn).
    for start, expected_checkpoint in (
        ("council", "council"),
        ("outline", "outline"),
        ("article", "draft"),
    ):
        events = list(stream_full_pipeline(db, project, start_stage=start, gated=True))
        waits = [e for e in events if e["event"] == "awaiting_approval"]
        assert len(waits) == 1, f"no pause after {start}"
        assert waits[0]["data"]["stage"] == expected_checkpoint

    # Final leg: factcheck → done.
    events = list(stream_full_pipeline(db, project, start_stage="factcheck", gated=True))
    assert events[-1]["event"] == "done"


def test_legacy_stage_aliases_still_resume(db):
    project = _project(db)
    list(stream_full_pipeline(db, project))  # full run persists artifacts
    # An old client resuming "research" restarts from the keywords stage.
    events = list(stream_full_pipeline(db, project, start_stage="research"))
    started = [e["data"]["stage"] for e in events if e["event"] == "stage" and e["data"]["status"] == "start"]
    assert started[0] == "keywords"


# --------------------------------------------------------------------------- #
# Fact-check refinements: body scanning + claim-noise carve-outs
# --------------------------------------------------------------------------- #
def test_factcheck_scans_body_not_headings():
    from app.factcheck.service import check_draft

    draft = {
        "sections": [
            {
                # Heading full of claim-bait must NOT become a claim…
                "heading": "Best Price-to-Performance Ratio Under $300",
                "level": 2,
                # …but the body's unsourced hard statistic MUST.
                "markdown": "The device sold 4 million units last year worldwide.",
            }
        ]
    }
    fact = check_draft(draft, {}, use_llm_hint=False)
    texts = [c["text"] for c in fact["claims"]]
    assert any("4 million units" in t for t in texts)
    assert not any("Ratio Under" in t for t in texts)
    assert fact["high_risk_unsupported"] == 1


def test_factcheck_ignores_claim_noise():
    from app.factcheck.service import _classify, _inline_citation

    # Model numbers, years, advice thresholds, scope prices: not claims.
    assert _classify("The Sony WH-1000XM6 impressed us in 2026.") in ([], ["superlative"])
    assert _classify("Aim for at least 20 hours of battery life.") == []
    assert _classify("Great desks exist under $500 if you look.") == []
    # The article's own keyword phrase is topic wording, not a superlative claim.
    assert _classify(
        "Our pick for best noise cancelling headphones 2026 follows.",
        ["best noise cancelling headphones 2026"],
    ) == []
    # Attribution-verb citations are recognised; pronouns are not.
    assert _inline_citation("As Wirecutter notes, padding matters.")
    assert _inline_citation("Trusted Reviews states battery drains faster.")
    assert _inline_citation("it notes that things happen") is None


def test_compliance_table_and_guidance_carveouts():
    from app.compliance.house_rules import check

    ok = {
        "sections": [
            {
                "heading": "Comparison of Desks Under $500",
                "level": 2,
                "markdown": (
                    "Specs per ExampleReview.\n\n"
                    "| Model | Height |\n|-------|--------|\n| A1 | 28-46 |\n\n"
                    "Choose models with at least 20 hours of battery. "
                    "Plan to spend between $200 and $500."
                ),
            }
        ]
    }
    res = check(ok, None)
    assert res["passed"], res["violations"]

    bad = {
        "sections": [
            {"heading": "X", "level": 2, "markdown": "The fee rose 20% this year."}
        ]
    }
    assert not check(bad, None)["passed"]


def test_scoring_excludes_pure_superlatives_from_fact_ratio():
    from app.scoring import compute_scores

    claims = [
        {"text": "sourced stat", "source": "ex.com", "label": "accepted", "risk": "low", "kinds": ["numeric"]},
        {"text": "best fit for you", "source": None, "label": "manual_review", "risk": "medium", "kinds": ["superlative"]},
    ]
    scores = compute_scores(
        {"sections": [{"heading": "H", "markdown": "body"}]}, {"keyword": "k"}, claims
    )
    # The unsourced pure-superlative must not drag fact/eeat below the sourced ratio.
    assert scores.fact == 100.0
    assert scores.eeat == 100.0
