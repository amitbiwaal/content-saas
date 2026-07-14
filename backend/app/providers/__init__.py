"""Swappable AI provider adapter layer (PRD §12).

Each council seat resolves to an :class:`~app.providers.base.LLMAdapter` via the
registry — no model name is hardcoded in logic. ``get_adapter`` returns the real
adapter when a key is configured, otherwise a deterministic mock.
"""

from app.providers.base import (
    AdapterResponse,
    LLMAdapter,
    MockAdapter,
    ProviderError,
    ProviderRefusal,
)
from app.providers.factory import get_adapter
from app.providers.registry import REGISTRY, ModelInfo, PolicyTier

__all__ = [
    "AdapterResponse",
    "LLMAdapter",
    "MockAdapter",
    "ProviderError",
    "ProviderRefusal",
    "get_adapter",
    "REGISTRY",
    "ModelInfo",
    "PolicyTier",
]
