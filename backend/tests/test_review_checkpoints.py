"""Review-mode approval ledger (app.review.service).

Pure-logic tests for the human-in-the-loop gate: (re)generating a stage marks it
pending and invalidates downstream approvals; approving advances the current step.
"""

from app.review.service import (
    GATED_STAGES,
    approve_stage,
    next_stage,
    stage_status,
    touch_stage,
)


def test_gated_stages_order():
    assert GATED_STAGES == ("research", "council", "outline", "draft")


def test_touch_marks_pending():
    cp = touch_stage(None, "research", feedback="broaden scope")
    assert cp["research"]["status"] == "pending"
    assert cp["research"]["feedback"] == "broaden scope"
    assert stage_status(cp, "research") == "pending"


def test_approve_marks_approved_and_advances_next():
    cp = touch_stage(None, "research")
    assert next_stage(cp) == "research"  # generated but not approved yet
    cp = approve_stage(cp, "research", by="editor")
    assert stage_status(cp, "research") == "approved"
    # research approved -> the human's next step is council.
    assert next_stage(cp) == "council"


def test_regenerate_upstream_clears_downstream_approvals():
    # Approve research -> council -> outline in order.
    cp = approve_stage(touch_stage(None, "research"), "research")
    cp = approve_stage(touch_stage(cp, "council"), "council")
    cp = approve_stage(touch_stage(cp, "outline"), "outline")
    assert next_stage(cp) == "draft"

    # Now regenerate research (editor changed their mind upstream): council and
    # outline approvals are stale and must be cleared.
    cp = touch_stage(cp, "research", feedback="use a different angle")
    assert stage_status(cp, "research") == "pending"
    assert stage_status(cp, "council") == "not_started"
    assert stage_status(cp, "outline") == "not_started"
    assert next_stage(cp) == "research"


def test_approve_preserves_generation_feedback_when_no_note():
    cp = touch_stage(None, "council", feedback="weigh pricing")
    cp = approve_stage(cp, "council")  # no explicit note
    assert cp["council"]["feedback"] == "weigh pricing"


def test_all_approved_next_is_none():
    cp = None
    for stage in GATED_STAGES:
        cp = approve_stage(touch_stage(cp, stage), stage)
    assert next_stage(cp) is None


def test_touch_is_pure_does_not_mutate_input():
    original: dict = {}
    returned = touch_stage(original, "research")
    assert original == {}  # input untouched
    assert returned is not original


def test_unknown_stage_is_ignored():
    cp = touch_stage(None, "scoring")  # not a gated stage
    assert cp == {}
    assert stage_status({"scoring": {"status": "pending"}}, "scoring") == "pending"
