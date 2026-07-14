"""House-rules / compliance engine unit tests (PRD §11).

Service-level only: pure deterministic checks against synthetic drafts. No LLM,
no app.main / TestClient (router not wired yet). The compliance engine is the
hard pass/fail export gate (PRD §11).
"""

from app.compliance import DEFAULT_RULES, check
from app.compliance.house_rules import _draft_text


def _draft(*paragraphs: str) -> dict:
    """Build a Draft.sections-shaped dict from raw paragraphs."""
    return {
        "sections": [
            {"heading": "Section", "content": p} for p in paragraphs
        ]
    }


# --------------------------------------------------------------------------- #
# Core spec: em-dash and first-person-singular are flagged; clean text passes
# --------------------------------------------------------------------------- #
def test_em_dash_is_flagged():
    """Em-dashes are banned (PRD §11): suggest a comma or period."""
    draft = _draft("FeetFinder is reputable — but verification is mandatory.")
    report = check(draft)

    assert report["passed"] is False
    rules = {v["rule"] for v in report["violations"]}
    assert "em_dash" in rules
    em = next(v for v in report["violations"] if v["rule"] == "em_dash")
    assert em["locations"]  # the offending sentence is captured


def test_first_person_singular_is_flagged():
    """Editorial voice is we-not-I (PRD §11): flag 'I'/'my'."""
    draft = _draft("I tried the platform and my payout arrived quickly.")
    report = check(draft)

    assert report["passed"] is False
    rules = {v["rule"] for v in report["violations"]}
    assert "editorial_voice" in rules


def test_clean_text_passes():
    """Compliant, sourced, we-voice prose passes the gate (PRD §11)."""
    draft = _draft(
        "We reviewed the payout policy in detail.",
        "Payouts arrive in five to seven business days for verified creators.",
        "FeetFinder charges a 20% platform fee, per help.feetfinder.com.",
    )
    report = check(draft)

    assert report["passed"] is True
    # Only the informational typography note may appear, never with locations.
    enforced = [
        v for v in report["violations"] if v["rule"] != "typography_lock"
    ]
    assert enforced == []


# --------------------------------------------------------------------------- #
# Unsourced negative / statistical claims (PRD §11)
# --------------------------------------------------------------------------- #
def test_unsourced_statistic_is_flagged():
    draft = _draft("Roughly 47% of new creators abandon the platform within a week.")
    report = check(draft)
    rules = {v["rule"] for v in report["violations"]}
    assert "unsourced_claim" in rules
    assert report["passed"] is False


def test_sourced_statistic_passes_unsourced_rule():
    draft = _draft(
        "Roughly 47% of new creators churn within a week, according to "
        "https://example.com/report."
    )
    report = check(draft)
    rules = {v["rule"] for v in report["violations"]}
    assert "unsourced_claim" not in rules


def test_unsourced_negative_claim_is_flagged():
    draft = _draft("The service is a scam that loses creator earnings.")
    report = check(draft)
    rules = {v["rule"] for v in report["violations"]}
    assert "unsourced_claim" in rules


# --------------------------------------------------------------------------- #
# Methodology / testing claims (PRD §11)
# --------------------------------------------------------------------------- #
def test_methodology_claim_is_flagged():
    for sentence in (
        "We tested 12 platforms before writing this guide.",
        "After 200+ hours of hands-on testing we ranked them.",
    ):
        report = check(_draft(sentence))
        rules = {v["rule"] for v in report["violations"]}
        assert "methodology_claim" in rules, sentence
        assert report["passed"] is False


# --------------------------------------------------------------------------- #
# FAQPage rich-result claims are blocked (PRD §11, FR-10.4)
# --------------------------------------------------------------------------- #
def test_faqpage_rich_result_claim_is_flagged():
    draft = _draft("Our FAQ schema will earn FAQPage rich results in Google.")
    report = check(draft)
    rules = {v["rule"] for v in report["violations"]}
    assert "faqpage_claim" in rules


def test_plain_faq_mention_passes():
    draft = _draft("We add an FAQ block so AI engines can parse the answers.")
    report = check(draft)
    rules = {v["rule"] for v in report["violations"]}
    assert "faqpage_claim" not in rules


# --------------------------------------------------------------------------- #
# Typography lock is informational only — never fails the gate (PRD §11)
# --------------------------------------------------------------------------- #
def test_typography_lock_is_informational_only():
    report = check(_draft("We keep the prose clean and sourced."))
    typo = [v for v in report["violations"] if v["rule"] == "typography_lock"]
    assert len(typo) == 1
    assert typo[0]["locations"] == []
    assert report["passed"] is True


# --------------------------------------------------------------------------- #
# Per-website configurability (PRD §11, FR-13.3)
# --------------------------------------------------------------------------- #
def test_rule_can_be_disabled_per_website():
    draft = _draft("FeetFinder is reputable — verification is mandatory.")
    # Disabling em_dash removes that violation; the gate then passes.
    report = check(draft, rules={"em_dash": {"enabled": False}})
    rules = {v["rule"] for v in report["violations"]}
    assert "em_dash" not in rules
    assert report["passed"] is True


def test_rule_bool_override_disables():
    draft = _draft("I think this works.")
    report = check(draft, rules={"editorial_voice": False})
    rules = {v["rule"] for v in report["violations"]}
    assert "editorial_voice" not in rules


def test_default_rules_are_all_enabled():
    assert all(spec.get("enabled") for spec in DEFAULT_RULES.values())


# --------------------------------------------------------------------------- #
# Defensive input handling
# --------------------------------------------------------------------------- #
def test_handles_string_and_list_and_none_drafts():
    # Plain string draft.
    assert check("We write cleanly.")["passed"] is True
    # List-of-strings draft (still flattened).
    flagged = check({"sections": ["I love this product."]})
    assert any(v["rule"] == "editorial_voice" for v in flagged["violations"])
    # None / empty drafts must not raise and pass the enforced gate.
    assert check(None)["passed"] is True
    assert _draft_text(None) == ""
