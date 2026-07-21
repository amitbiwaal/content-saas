"""Provider/model registry (PRD §12).

Holds model id, context window, cost per token, and content-policy tier per
provider so routing and cost logic are data-driven. ``PolicyTier.PERMISSIVE``
providers are the ones eligible for restricted-niche topics (PRD §11) and for
failover when a mainstream provider refuses.

Cost is expressed in USD cents per 1M tokens to match the rest of the codebase
(monetary values are stored in cents).
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from enum import Enum

logger = logging.getLogger("contentos.registry")


class PolicyTier(str, Enum):
    MAINSTREAM = "mainstream"  # may refuse adult-adjacent / restricted topics
    PERMISSIVE = "permissive"  # eligible for restricted-niche routing & failover


@dataclass(frozen=True)
class ModelInfo:
    provider: str
    model: str
    context_window: int
    input_cost_cents_per_mtok: float
    output_cost_cents_per_mtok: float
    policy_tier: PolicyTier


# Default model per provider. Override per-seat via env (see app/config.py) or
# per-project via Project.council_config — never edit call sites.
#
# Anthropic default is claude-opus-4-8 (adaptive thinking) per the claude-api
# skill. The OpenAI / Google / xAI ids are placeholders the operator confirms
# when supplying keys; pricing is approximate and refined as keys land.
REGISTRY: dict[str, ModelInfo] = {
    "anthropic": ModelInfo(
        provider="anthropic",
        model="claude-opus-4-8",
        context_window=1_000_000,
        input_cost_cents_per_mtok=500.0,   # $5.00 / 1M in
        output_cost_cents_per_mtok=2500.0,  # $25.00 / 1M out
        policy_tier=PolicyTier.PERMISSIVE,
    ),
    # NOTE: the openai/google/xai rates below are APPROXIMATE published list
    # prices for the placeholder model ids — confirm exact rates per model with
    # the operator when keys land. They are non-zero on purpose: a 0.0 rate makes
    # cost tracking (PRD §13) and budget guards silently under-report real spend.
    "openai": ModelInfo(
        provider="openai",
        model="gpt-4o",  # best quality/latency balance for long-form content
        context_window=128_000,
        input_cost_cents_per_mtok=250.0,    # $2.50 / 1M in (gpt-4o)
        output_cost_cents_per_mtok=1000.0,  # $10.00 / 1M out (gpt-4o)
        policy_tier=PolicyTier.MAINSTREAM,
    ),
    "google": ModelInfo(
        provider="google",
        model="gemini-2.5-pro",  # placeholder — confirm on key supply
        context_window=1_000_000,
        input_cost_cents_per_mtok=125.0,   # ~$1.25 / 1M in (approx — confirm)
        output_cost_cents_per_mtok=1000.0,  # ~$10.00 / 1M out (approx — confirm)
        policy_tier=PolicyTier.MAINSTREAM,
    ),
    "xai": ModelInfo(
        provider="xai",
        model="grok-4",  # placeholder — confirm on key supply
        context_window=256_000,
        input_cost_cents_per_mtok=300.0,   # ~$3.00 / 1M in (approx — confirm)
        output_cost_cents_per_mtok=1500.0,  # ~$15.00 / 1M out (approx — confirm)
        policy_tier=PolicyTier.PERMISSIVE,
    ),
}


def permissive_providers() -> list[str]:
    """Providers eligible for restricted topics / refusal failover (PRD §11)."""
    return [p for p, info in REGISTRY.items() if info.policy_tier is PolicyTier.PERMISSIVE]


def resolve_model(provider: str, override: str | None = None) -> str:
    """Return the model id for a provider, honouring an optional override."""
    if override:
        return override
    if provider not in REGISTRY:
        raise KeyError(f"Unknown provider: {provider!r}")
    return REGISTRY[provider].model


def estimate_cost_cents(
    provider: str,
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    total_tokens: int | None = None,
) -> float:
    """Estimate USD-cent cost for a call from the registry rates (PRD §13).

    If only a combined ``total_tokens`` is known, it is split 50/50 across the
    input/output rates. Unknown providers (e.g. the deterministic ``mock``) have
    no registry entry and cost 0 — so mock runs are free.
    """
    info = REGISTRY.get(provider)
    if not info:
        return 0.0
    if (
        info.input_cost_cents_per_mtok == 0.0
        and info.output_cost_cents_per_mtok == 0.0
    ):
        # A keyed provider with no configured rate silently under-reports spend.
        logger.warning(
            "No cost rate configured for provider %s; billing will under-report.",
            provider,
        )
    if total_tokens is not None and not (input_tokens or output_tokens):
        input_tokens = output_tokens = total_tokens / 2
    cost = (
        input_tokens / 1_000_000 * info.input_cost_cents_per_mtok
        + output_tokens / 1_000_000 * info.output_cost_cents_per_mtok
    )
    return round(cost, 4)
