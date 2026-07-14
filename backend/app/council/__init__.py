"""AI Council: role-based debate + Judge (PRD §8)."""

from app.council.orchestrator import CouncilResult, run_council, run_council_events
from app.council.roles import DEFAULT_SEATS, JUDGE, ROLES, Role

__all__ = [
    "CouncilResult",
    "run_council",
    "run_council_events",
    "ROLES",
    "Role",
    "JUDGE",
    "DEFAULT_SEATS",
]
