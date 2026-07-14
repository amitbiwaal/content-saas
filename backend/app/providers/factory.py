"""Resolve a provider name to a concrete adapter (PRD §12).

Returns the real adapter when that provider's key is configured in settings,
otherwise a deterministic :class:`MockAdapter` carrying the registry's model id —
so every seat is callable in dev/test without any keys. Per-seat model overrides
come from settings (``<provider>_model``) or an explicit ``model_override``
argument; the override takes precedence (PRD §12 swappable providers, no model
hardcoded in logic).
"""

from __future__ import annotations

from app.config import get_settings
from app.providers.base import LLMAdapter, MockAdapter
from app.providers.registry import resolve_model


def _build_real(provider: str, model_override: str | None) -> LLMAdapter | None:
    """Construct the real adapter for ``provider`` iff its key is configured."""
    settings = get_settings()

    def _seat_model(settings_model: str) -> str | None:
        return model_override or (settings_model or None)

    if provider == "anthropic" and settings.anthropic_api_key:
        from app.providers.anthropic_adapter import AnthropicAdapter

        return AnthropicAdapter(
            api_key=settings.anthropic_api_key,
            model=_seat_model(settings.anthropic_model),
        )
    if provider == "openai" and settings.openai_api_key:
        from app.providers.openai_adapter import OpenAIAdapter

        return OpenAIAdapter(
            api_key=settings.openai_api_key,
            model=_seat_model(settings.openai_model),
        )
    if provider == "google" and settings.google_api_key:
        from app.providers.google_adapter import GoogleAdapter

        return GoogleAdapter(
            api_key=settings.google_api_key,
            model=_seat_model(settings.google_model),
        )
    if provider == "xai" and settings.xai_api_key:
        from app.providers.xai_adapter import XAIAdapter

        return XAIAdapter(
            api_key=settings.xai_api_key,
            model=_seat_model(settings.xai_model),
        )
    return None


# Preference order when a seat's mapped provider has no key: use a real, keyed
# provider before falling back to the mock, so a partial key set (e.g. only
# OpenAI + xAI) still runs the whole council on real models.
_FALLBACK_ORDER = ("openai", "xai", "anthropic", "google")


def get_adapter(provider: str, model_override: str | None = None) -> LLMAdapter:
    # 1) The seat's own provider, if its key is configured.
    adapter = _build_real(provider, model_override)
    if adapter is not None:
        return adapter

    # 2) No key for the mapped provider — borrow the first available keyed
    #    provider (the override was for the original model, so don't reuse it).
    for alt in _FALLBACK_ORDER:
        if alt == provider:
            continue
        adapter = _build_real(alt, None)
        if adapter is not None:
            return adapter

    # 3) No keys at all — deterministic mock so the pipeline still runs.
    return MockAdapter(provider=provider, model=resolve_model(provider, model_override))
