"""Fact Checker (PRD §9.9, FR-9.1..9.3).

Extracts factual/statistical claims from a draft, grades each with a source,
confidence and risk level, assigns a decision label, and counts the high-risk
unsupported claims that block the publish gate (PRD §10). The house rule that
unsourced negative/statistical claims are not allowed (PRD §11) is enforced in
:func:`grade_claim`.
"""

from app.factcheck.service import (
    Claim,
    check_draft,
    extract_claims,
    grade_claim,
)

__all__ = [
    "Claim",
    "extract_claims",
    "grade_claim",
    "check_draft",
]
