"""xAI / Grok seat — real adapter via the OpenAI-compatible client (PRD §12).

xAI exposes an OpenAI-compatible Chat Completions API at
``https://api.x.ai/v1``, so this adapter reuses :class:`OpenAIAdapter` with the
``openai`` SDK pointed at the xAI base URL (no separate SDK). The ``openai``
package is imported lazily inside ``OpenAIAdapter.__init__`` so this module
loads even when the SDK is absent — the factory only constructs this adapter
when ``settings.xai_api_key`` is set.

Grok is a :class:`~app.providers.registry.PolicyTier.PERMISSIVE` provider, so it
is eligible for restricted-niche routing and refusal failover (PRD §11, §12).
"""

from __future__ import annotations

from app.providers.openai_adapter import OpenAIAdapter

_XAI_BASE_URL = "https://api.x.ai/v1"
_DEFAULT_MODEL = "grok-4"


class XAIAdapter(OpenAIAdapter):
    """One Grok model seat over xAI's OpenAI-compatible endpoint (PRD §12)."""

    provider = "xai"

    def __init__(self, api_key: str, model: str | None = None):
        # Reuse the OpenAI client machinery against the xAI base URL. The SDK
        # import stays lazy (it happens inside the parent __init__).
        super().__init__(
            api_key=api_key,
            model=model or _DEFAULT_MODEL,
            base_url=_XAI_BASE_URL,
        )
        # Override the provider label inherited from OpenAIAdapter so the
        # AdapterResponse and any ProviderRefusal report "xai".
        self.provider = "xai"
