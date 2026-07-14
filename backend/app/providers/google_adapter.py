"""Google Gemini seat — real adapter via the ``google-genai`` SDK (PRD §12).

Routes a council seat to a Gemini model through the unified ``google-genai``
client (``from google import genai``). The SDK is imported lazily inside
``__init__`` so this module always imports even when the package is absent — the
factory only constructs this adapter when ``settings.google_api_key`` is set
(PRD §12 swappable providers).

Gemini surfaces content-policy blocks as a ``prompt_feedback.block_reason`` or an
empty-candidate ``finish_reason`` of ``SAFETY``/``BLOCKLIST`` rather than an
exception; those are mapped to :class:`ProviderRefusal` so the router can fail
over to a permissive tier (PRD §11, §12). Transport/server errors become
:class:`ProviderError`.
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

_DEFAULT_MODEL = "gemini-2.5-pro"

# finish_reason values (name or enum) that mean the model declined on policy.
_REFUSAL_FINISHES = {"SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "RECITATION"}


class GoogleAdapter(LLMAdapter):
    """One Gemini model seat (PRD §12)."""

    provider = "google"

    def __init__(self, api_key: str, model: str | None = None):
        # Lazy import: the module must load even if the SDK isn't installed.
        from google import genai

        from app.config import get_settings

        settings = get_settings()
        self._genai = genai
        # google-genai timeout is milliseconds; bound it so a wedged upstream
        # fails over instead of hanging a worker.
        self._client = genai.Client(
            api_key=api_key,
            http_options={"timeout": int(settings.provider_timeout_s * 1000)},
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
        # Build a generation config. The system instruction and JSON mode are
        # set via the typed config object. TODO: confirm the exact field names
        # against the operator's installed google-genai version when a key
        # lands — the config shape is stable but evolves.
        config: dict = {
            "system_instruction": system,
            "max_output_tokens": max_tokens,
        }
        if json_mode:
            config["response_mime_type"] = "application/json"

        try:
            resp = self._client.models.generate_content(
                model=self.model,
                contents=prompt,
                config=config,
            )
        except (TypeError, AttributeError, KeyError):
            # Programming/shape bugs (e.g. a wrong config field) must surface as
            # a crash, not be masked as a provider refusal/failover.
            raise
        except Exception as exc:  # google-genai raises its own error hierarchy
            # Re-raise refusal-shaped errors as ProviderRefusal; everything else
            # is transport/server failure.
            if _looks_like_refusal(str(exc)):
                raise ProviderRefusal(provider=self.provider, detail=str(exc)) from exc
            raise ProviderError(f"google API error: {exc}") from exc

        # A prompt-level block carries no candidates — treat as a refusal.
        feedback = getattr(resp, "prompt_feedback", None)
        block_reason = getattr(feedback, "block_reason", None) if feedback else None
        if block_reason:
            raise ProviderRefusal(
                provider=self.provider, category=str(block_reason)
            )

        candidates = getattr(resp, "candidates", None) or []
        if candidates:
            finish = getattr(candidates[0], "finish_reason", None)
            if finish is not None and _finish_name(finish) in _REFUSAL_FINISHES:
                raise ProviderRefusal(
                    provider=self.provider, category=_finish_name(finish)
                )

        # ``resp.text`` is the SDK's convenience accessor for the concatenated
        # text parts; fall back to manual extraction if it's unavailable.
        text = getattr(resp, "text", None) or _extract_text(candidates)

        usage = getattr(resp, "usage_metadata", None)
        in_tok = getattr(usage, "prompt_token_count", 0) or 0
        out_tok = getattr(usage, "candidates_token_count", 0) or 0

        return AdapterResponse(
            text=text or "",
            provider=self.provider,
            model=self.model,
            input_tokens=in_tok,
            output_tokens=out_tok,
            raw={"finish_reason": _finish_name(
                getattr(candidates[0], "finish_reason", None)
            ) if candidates else None},
        )

    def stream(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> Iterator[StreamEvent]:
        """Stream Gemini text chunks via ``generate_content_stream``.

        Policy blocks (prompt ``block_reason`` or a SAFETY-class ``finish_reason``)
        map to :class:`ProviderRefusal`. Usage metadata, when present on the final
        chunk, feeds accurate token counts; otherwise counts are estimated.
        """
        config: dict = {
            "system_instruction": system,
            "max_output_tokens": max_tokens,
        }
        if json_mode:
            config["response_mime_type"] = "application/json"

        try:
            stream = self._client.models.generate_content_stream(
                model=self.model,
                contents=prompt,
                config=config,
            )
            chunks: list[str] = []
            in_tok = out_tok = 0
            block_reason: object | None = None
            finish: object | None = None
            for chunk in stream:
                feedback = getattr(chunk, "prompt_feedback", None)
                if feedback is not None and getattr(feedback, "block_reason", None):
                    block_reason = getattr(feedback, "block_reason", None)
                candidates = getattr(chunk, "candidates", None) or []
                if candidates:
                    finish = getattr(candidates[0], "finish_reason", None) or finish
                usage = getattr(chunk, "usage_metadata", None)
                if usage is not None:
                    in_tok = getattr(usage, "prompt_token_count", 0) or in_tok
                    out_tok = getattr(usage, "candidates_token_count", 0) or out_tok
                piece = getattr(chunk, "text", None)
                if piece:
                    chunks.append(piece)
                    yield StreamEvent(delta=piece)
        except (TypeError, AttributeError, KeyError):
            raise  # surface programming/shape bugs instead of masking them
        except Exception as exc:  # google-genai raises its own error hierarchy
            if _looks_like_refusal(str(exc)):
                raise ProviderRefusal(provider=self.provider, detail=str(exc)) from exc
            raise ProviderError(f"google API error: {exc}") from exc

        if block_reason:
            raise ProviderRefusal(provider=self.provider, category=str(block_reason))
        if finish is not None and _finish_name(finish) in _REFUSAL_FINISHES:
            raise ProviderRefusal(provider=self.provider, category=_finish_name(finish))

        text = "".join(chunks)
        yield StreamEvent(
            response=AdapterResponse(
                text=text,
                provider=self.provider,
                model=self.model,
                input_tokens=in_tok or max(1, len(system + prompt) // 4),
                output_tokens=out_tok or max(1, len(text) // 4),
                raw={"finish_reason": _finish_name(finish), "streamed": True},
            )
        )


def _finish_name(finish: object) -> str:
    """Normalise a finish_reason (enum or str) to its bare name string."""
    if finish is None:
        return ""
    return getattr(finish, "name", None) or str(finish)


def _extract_text(candidates: list) -> str:
    """Concatenate text parts from the first candidate (defensive fallback)."""
    if not candidates:
        return ""
    content = getattr(candidates[0], "content", None)
    parts = getattr(content, "parts", None) or []
    return "".join(getattr(p, "text", "") or "" for p in parts)


def _looks_like_refusal(detail: str) -> bool:
    """Heuristic: does an error string read like a content-policy block?

    Deliberately excludes the bare token "refus" so transport failures like
    "Connection refused" are not misclassified as content refusals — genuine
    Gemini refusals surface via block_reason/finish_reason, handled separately.
    """
    low = detail.lower()
    return any(m in low for m in ("safety", "blocked", "prohibited", "content policy"))
