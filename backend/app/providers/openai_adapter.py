"""OpenAI seat — real adapter via the official ``openai`` SDK (PRD §12).

Routes a council seat to an OpenAI chat model. The SDK is imported lazily inside
``__init__`` so this module always imports even when ``openai`` is absent — the
factory only constructs this adapter when ``settings.openai_api_key`` is set
(PRD §12 swappable providers). Policy refusals are mapped to
:class:`ProviderRefusal` so the router can fail over to a permissive tier (PRD
§11 restricted routing, §12 failover); transport/server errors become
:class:`ProviderError`.
"""

from __future__ import annotations

import json
from collections.abc import Iterator

from app.providers.base import (
    AdapterResponse,
    LLMAdapter,
    ProviderError,
    ProviderRefusal,
    StreamEvent,
)

_DEFAULT_MODEL = "gpt-5"

# Substrings that signal a content-policy refusal in an OpenAI error/finish.
_REFUSAL_MARKERS = (
    "content_policy",
    "content policy",
    "content_filter",
    "content filter",
    "safety",
    "refus",
)


class OpenAIAdapter(LLMAdapter):
    """One OpenAI model seat (PRD §12)."""

    provider = "openai"

    def __init__(self, api_key: str, model: str | None = None, base_url: str | None = None):
        # Lazy import: the module must load even if the SDK isn't installed.
        import openai

        from app.config import get_settings

        settings = get_settings()
        self._openai = openai
        # Explicit timeout + reduced retries so a wedged upstream fails over
        # quickly instead of blocking a worker for the SDK's 600s default.
        client_kwargs: dict = {
            "api_key": api_key,
            "timeout": settings.provider_timeout_s,
            "max_retries": settings.provider_max_retries,
        }
        # base_url lets the xAI adapter reuse this client against api.x.ai.
        if base_url:
            client_kwargs["base_url"] = base_url
        self._client = openai.OpenAI(**client_kwargs)
        self.model = model or _DEFAULT_MODEL

    def complete(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> AdapterResponse:
        # Newer OpenAI models (gpt-5, o-series) reject ``max_tokens`` and require
        # ``max_completion_tokens``; xAI's OpenAI-compatible API still uses
        # ``max_tokens``. Pick the right one per provider.
        token_param = "max_tokens" if self.provider == "xai" else "max_completion_tokens"
        sys_content = _ensure_json_hint(system, prompt) if json_mode else system
        kwargs: dict = {
            "model": self.model,
            token_param: max_tokens,
            "messages": [
                {"role": "system", "content": sys_content},
                {"role": "user", "content": prompt},
            ],
        }
        if json_mode:
            # Ask for a strict JSON object. The API rejects json_object mode
            # unless the word "json" appears in the messages — _ensure_json_hint
            # guarantees it regardless of the caller's prompt.
            kwargs["response_format"] = {"type": "json_object"}

        try:
            resp = self._client.chat.completions.create(**kwargs)
        except self._openai.BadRequestError as exc:  # 400 — may be a policy block
            if _looks_like_refusal(str(exc)):
                raise ProviderRefusal(provider=self.provider, detail=str(exc)) from exc
            raise ProviderError(f"openai bad request: {exc}") from exc
        except self._openai.APIStatusError as exc:  # other 4xx/5xx
            raise ProviderError(f"openai API error: {exc}") from exc
        except self._openai.APIConnectionError as exc:  # network/timeout
            raise ProviderError(f"openai connection error: {exc}") from exc
        except self._openai.APIError as exc:  # catch-all SDK error
            raise ProviderError(f"openai error: {exc}") from exc

        choice = resp.choices[0] if resp.choices else None
        message = getattr(choice, "message", None) if choice else None

        # A structured refusal field (newer SDKs) or a content-filter finish
        # reason is a routing signal, not text.
        refusal = getattr(message, "refusal", None) if message else None
        finish = getattr(choice, "finish_reason", None) if choice else None
        if refusal:
            raise ProviderRefusal(provider=self.provider, detail=str(refusal))
        if finish == "content_filter":
            raise ProviderRefusal(provider=self.provider, category="content_filter")

        text = (getattr(message, "content", None) or "") if message else ""

        usage = getattr(resp, "usage", None)
        in_tok = getattr(usage, "prompt_tokens", 0) or 0
        out_tok = getattr(usage, "completion_tokens", 0) or 0

        return AdapterResponse(
            text=text,
            provider=self.provider,
            model=self.model,
            input_tokens=in_tok,
            output_tokens=out_tok,
            raw={"finish_reason": finish},
        )

    def stream(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> Iterator[StreamEvent]:
        """Stream chat-completion token deltas, then a terminal response event.

        Requests usage in the final chunk (``stream_options``) so token counts
        stay accurate. Policy blocks surface as :class:`ProviderRefusal` before
        the first delta (raised when the stream opens) so the router fails over.
        """
        token_param = "max_tokens" if self.provider == "xai" else "max_completion_tokens"
        sys_content = _ensure_json_hint(system, prompt) if json_mode else system
        kwargs: dict = {
            "model": self.model,
            token_param: max_tokens,
            "messages": [
                {"role": "system", "content": sys_content},
                {"role": "user", "content": prompt},
            ],
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}

        try:
            stream = self._client.chat.completions.create(**kwargs)
        except self._openai.BadRequestError as exc:  # 400 — may be a policy block
            if _looks_like_refusal(str(exc)):
                raise ProviderRefusal(provider=self.provider, detail=str(exc)) from exc
            raise ProviderError(f"openai bad request: {exc}") from exc
        except self._openai.APIError as exc:  # transport/status/connection
            raise ProviderError(f"openai error: {exc}") from exc

        chunks: list[str] = []
        finish: str | None = None
        in_tok = out_tok = 0
        try:
            for chunk in stream:
                usage = getattr(chunk, "usage", None)
                if usage is not None:
                    in_tok = getattr(usage, "prompt_tokens", 0) or in_tok
                    out_tok = getattr(usage, "completion_tokens", 0) or out_tok
                choices = getattr(chunk, "choices", None) or []
                if not choices:
                    continue
                choice = choices[0]
                fr = getattr(choice, "finish_reason", None)
                if fr:
                    finish = fr
                delta = getattr(choice, "delta", None)
                piece = getattr(delta, "content", None) if delta else None
                if piece:
                    chunks.append(piece)
                    yield StreamEvent(delta=piece)
        except self._openai.APIError as exc:
            raise ProviderError(f"openai stream error: {exc}") from exc

        if finish == "content_filter":
            raise ProviderRefusal(provider=self.provider, category="content_filter")

        text = "".join(chunks)
        yield StreamEvent(
            response=AdapterResponse(
                text=text,
                provider=self.provider,
                model=self.model,
                input_tokens=in_tok or max(1, len(system + prompt) // 4),
                output_tokens=out_tok or max(1, len(text) // 4),
                raw={"finish_reason": finish, "streamed": True},
            )
        )


def _ensure_json_hint(system: str, prompt: str) -> str:
    """Guarantee the literal word 'json' is present when using json_object mode.

    OpenAI's Chat Completions API returns a 400 for
    ``response_format={"type":"json_object"}`` unless "json" appears somewhere in
    the messages. Callers usually include it, but this makes the adapter robust
    regardless of the prompt.
    """
    if "json" in system.lower() or "json" in prompt.lower():
        return system
    return system + "\n\nRespond with a single valid JSON object and nothing else."


def _looks_like_refusal(detail: str) -> bool:
    """Heuristic: does an error string read like a content-policy refusal?"""
    low = detail.lower()
    return any(marker in low for marker in _REFUSAL_MARKERS)


def _safe_json_loads(text: str) -> dict | None:
    """Best-effort JSON parse — callers fall back to a heuristic on None."""
    try:
        parsed = json.loads(text)
    except (ValueError, TypeError):
        return None
    return parsed if isinstance(parsed, dict) else None
