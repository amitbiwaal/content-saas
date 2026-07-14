"""Scoring service + publish gate (PRD §10)."""

from app.scoring.gate import (
    GATE_TARGETS,
    GateVerdict,
    Scores,
    evaluate_gate,
)
from app.scoring.optimizer import top_fixes
from app.scoring.service import compute_scores

__all__ = [
    "Scores",
    "GateVerdict",
    "GATE_TARGETS",
    "evaluate_gate",
    "compute_scores",
    "top_fixes",
]
