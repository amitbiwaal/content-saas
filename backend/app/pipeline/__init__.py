"""End-to-end pipeline orchestration (PRD §7 pipeline).

Chains Research → Council → Judge → Outline → Article → Fact-check → Scores →
Publish gate → Compliance, persisting every entity, so a single call runs a
brief all the way to a gated, ready-or-not draft.
"""

from app.pipeline.service import run_full_pipeline

__all__ = ["run_full_pipeline"]
