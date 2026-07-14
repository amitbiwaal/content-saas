"""House-rules / compliance engine (PRD §11).

A deterministic, NON-LLM hard pass/fail gate that runs before export, separate
from EEAT scoring (PRD §11). Rules are configurable per website via the ``rules``
argument to :func:`~app.compliance.house_rules.check`.
"""

from app.compliance.house_rules import DEFAULT_RULES, check

__all__ = ["DEFAULT_RULES", "check"]
