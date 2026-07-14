"""LLM adapter interface + deterministic mock.

Every council seat goes through :class:`LLMAdapter`. A provider refusal raises
:class:`ProviderRefusal`, which the router treats as a routing signal — fail
over to the next policy-eligible provider (PRD §11 restricted routing, §12
failover). Transport/other failures raise :class:`ProviderError`.
"""

from __future__ import annotations

import hashlib
import json
from abc import ABC, abstractmethod
from collections.abc import Iterator
from dataclasses import dataclass, field


# --------------------------------------------------------------------------- #
# Errors
# --------------------------------------------------------------------------- #
class ProviderError(Exception):
    """Transport/timeout/server error — retry then fail over."""


class ProviderRefusal(ProviderError):
    """Provider declined on policy grounds — fail over to a permissive tier."""

    def __init__(self, provider: str, category: str | None = None, detail: str | None = None):
        self.provider = provider
        self.category = category
        self.detail = detail
        super().__init__(
            f"{provider} refused"
            + (f" ({category})" if category else "")
            + (f": {detail}" if detail else "")
        )


# --------------------------------------------------------------------------- #
# Response envelope
# --------------------------------------------------------------------------- #
@dataclass
class AdapterResponse:
    text: str
    provider: str
    model: str
    input_tokens: int = 0
    output_tokens: int = 0
    raw: dict = field(default_factory=dict)

    @property
    def tokens(self) -> int:
        return self.input_tokens + self.output_tokens


@dataclass
class StreamEvent:
    """One event in a streaming completion.

    Deltas carry incremental text (``delta``); the single terminal event carries
    the finished :class:`AdapterResponse` (``response``) with the full text and
    token usage. Callers accumulate ``delta`` and read ``response`` at the end.
    """

    delta: str = ""
    response: AdapterResponse | None = None


# --------------------------------------------------------------------------- #
# Interface
# --------------------------------------------------------------------------- #
class LLMAdapter(ABC):
    """One model seat. Implementations must be stateless across calls."""

    provider: str
    model: str

    @abstractmethod
    def complete(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> AdapterResponse:
        """Run one completion. Raise ProviderRefusal/ProviderError on failure."""
        raise NotImplementedError

    def stream(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> Iterator[StreamEvent]:
        """Stream a completion as text deltas, then one terminal event.

        Default implementation has no true token streaming: it runs
        :meth:`complete` and emits the whole text as a single delta followed by
        the terminal ``response`` event. Real adapters override this to yield
        per-token deltas. Raises ProviderRefusal/ProviderError before the first
        delta so the router can fail over cleanly.
        """
        resp = self.complete(
            system=system, prompt=prompt, max_tokens=max_tokens, json_mode=json_mode
        )
        if resp.text:
            yield StreamEvent(delta=resp.text)
        yield StreamEvent(response=resp)


# --------------------------------------------------------------------------- #
# Mock (default when no key is configured)
# --------------------------------------------------------------------------- #
class MockAdapter(LLMAdapter):
    """Deterministic stand-in so the whole pipeline runs with zero API spend.

    Output is derived from a hash of the inputs, so tests are reproducible and a
    demo produces stable council/judge behaviour. In ``json_mode`` it returns a
    minimal valid JSON object the orchestrator can consume.
    """

    def __init__(self, provider: str = "mock", model: str = "mock-1"):
        self.provider = provider
        self.model = model

    def complete(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> AdapterResponse:
        digest = hashlib.sha256((system + "\x00" + prompt).encode()).hexdigest()
        seed = int(digest[:8], 16)

        if json_mode:
            text = json.dumps(
                {
                    "summary": f"mock strategy {seed % 1000}",
                    "decisions": [],
                    "confidence": round(0.6 + (seed % 40) / 100, 2),
                }
            )
        else:
            text = (
                f"[mock:{self.provider}] recommendation {seed % 100}: "
                f"address the brief with sourced, on-intent guidance."
            )

        in_tok = max(1, len(system + prompt) // 4)
        out_tok = max(1, len(text) // 4)
        return AdapterResponse(
            text=text,
            provider=self.provider,
            model=self.model,
            input_tokens=in_tok,
            output_tokens=out_tok,
            raw={"mock": True, "seed": seed},
        )

    def stream(
        self,
        *,
        system: str,
        prompt: str,
        max_tokens: int = 16000,
        json_mode: bool = False,
    ) -> Iterator[StreamEvent]:
        """Emit the deterministic mock output word-by-word so the UI shows a
        live "typing" effect even with zero API keys. JSON (judge) is emitted
        whole so the strict-JSON contract is never split mid-token."""
        resp = self.complete(
            system=system, prompt=prompt, max_tokens=max_tokens, json_mode=json_mode
        )
        if json_mode:
            yield StreamEvent(delta=resp.text)
        else:
            words = resp.text.split(" ")
            for i, word in enumerate(words):
                yield StreamEvent(delta=word if i == 0 else " " + word)
        yield StreamEvent(response=resp)
