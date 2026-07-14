"""Claude seat — real adapter via the official ``anthropic`` SDK.

Defaults to ``claude-opus-4-8`` with adaptive thinking (per the claude-api
skill). Critically, it checks ``stop_reason`` *before* reading content: a
``"refusal"`` is surfaced as :class:`ProviderRefusal` so the router can fail
over to a permissive provider — the mechanism behind restricted-niche routing
(PRD §11) and failover (PRD §12).
"""

from __future__ import annotations

from collections.abc import Iterator

from app.providers.base import (
    AdapterResponse,
    LLMAdapter,
    ProviderError,
    ProviderRefusal,
    StreamEvent,
)

_DEFAULT_MODEL = "claude-opus-4-8"


class AnthropicAdapter(LLMAdapter):
    provider = "anthropic"

    def __init__(self, api_key: str, model: str | None = None):
        # Imported lazily so the module loads even if the SDK is absent; the
        # factory only constructs this adapter when a key is configured.
        import anthropic

        from app.config import get_settings

        settings = get_settings()
        self._anthropic = anthropic
        # Explicit timeout + reduced retries so a wedged upstream fails over
        # quickly instead of blocking a worker for the SDK's 600s default.
        self._client = anthropic.Anthropic(
            api_key=api_key,
            timeout=settings.provider_timeout_s,
            max_retries=settings.provider_max_retries,
        )
        self.model = model or _DEFAULT_MODEL

    def complete(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> AdapterResponse:
        sys_prompt = system
        if json_mode:
            sys_prompt += (
                "\n\nRespond with a single valid JSON object and nothing else."
            )

        try:
            resp = self._client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                thinking={"type": "adaptive"},
                system=sys_prompt,
                messages=[{"role": "user", "content": prompt}],
            )
        except self._anthropic.APIStatusError as exc:  # 4xx/5xx
            raise ProviderError(f"anthropic API error: {exc}") from exc
        except self._anthropic.APIConnectionError as exc:  # network
            raise ProviderError(f"anthropic connection error: {exc}") from exc

        # Check stop_reason BEFORE reading content (refusal => routing signal).
        if resp.stop_reason == "refusal":
            details = getattr(resp, "stop_details", None)
            category = getattr(details, "category", None) if details else None
            explanation = getattr(details, "explanation", None) if details else None
            raise ProviderRefusal(
                provider=self.provider, category=category, detail=explanation
            )

        text = "".join(
            block.text for block in resp.content if getattr(block, "type", None) == "text"
        )
        usage = resp.usage
        return AdapterResponse(
            text=text,
            provider=self.provider,
            model=self.model,
            input_tokens=getattr(usage, "input_tokens", 0),
            output_tokens=getattr(usage, "output_tokens", 0),
            raw={"stop_reason": resp.stop_reason},
        )

    def stream(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> Iterator[StreamEvent]:
        """Stream Claude text deltas via the SDK's ``messages.stream`` helper.

        A ``stop_reason`` of ``"refusal"`` on the final message is surfaced as
        :class:`ProviderRefusal`. With adaptive thinking, only ``text_stream``
        deltas (not thinking blocks) are emitted, so the UI shows the answer.
        """
        sys_prompt = system
        if json_mode:
            sys_prompt += "\n\nRespond with a single valid JSON object and nothing else."

        try:
            manager = self._client.messages.stream(
                model=self.model,
                max_tokens=max_tokens,
                thinking={"type": "adaptive"},
                system=sys_prompt,
                messages=[{"role": "user", "content": prompt}],
            )
            with manager as stream:
                chunks: list[str] = []
                for piece in stream.text_stream:
                    if piece:
                        chunks.append(piece)
                        yield StreamEvent(delta=piece)
                final = stream.get_final_message()
        except self._anthropic.APIStatusError as exc:  # 4xx/5xx
            raise ProviderError(f"anthropic API error: {exc}") from exc
        except self._anthropic.APIConnectionError as exc:  # network
            raise ProviderError(f"anthropic connection error: {exc}") from exc

        if getattr(final, "stop_reason", None) == "refusal":
            details = getattr(final, "stop_details", None)
            category = getattr(details, "category", None) if details else None
            explanation = getattr(details, "explanation", None) if details else None
            raise ProviderRefusal(
                provider=self.provider, category=category, detail=explanation
            )

        text = "".join(chunks)
        usage = getattr(final, "usage", None)
        yield StreamEvent(
            response=AdapterResponse(
                text=text,
                provider=self.provider,
                model=self.model,
                input_tokens=getattr(usage, "input_tokens", 0) or 0,
                output_tokens=getattr(usage, "output_tokens", 0)
                or max(1, len(text) // 4),
                raw={"stop_reason": getattr(final, "stop_reason", None), "streamed": True},
            )
        )
