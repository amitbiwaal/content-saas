"""Service-level tests for the real provider adapters (PRD §12).

These do NOT make network calls. They assert two things:

1. With no provider keys configured (the test env), ``get_adapter`` falls back
   to the deterministic :class:`MockAdapter` for every provider — so the whole
   pipeline runs with zero API spend.
2. The real adapter modules import cleanly even when their SDK is absent (lazy
   SDK import), and — when the SDK *is* installed (``pytest.importorskip``) —
   constructing an adapter with a dummy key wires up the right provider/model
   without touching the network.

No ``app.main`` / TestClient import (the router isn't wired yet).
"""

from __future__ import annotations

import importlib

import pytest

from app.config import Settings
from app.providers import get_adapter
from app.providers.base import LLMAdapter, MockAdapter
from app.providers.registry import REGISTRY


# --------------------------------------------------------------------------- #
# 1. No keys -> MockAdapter fallback (must hold with zero SDKs installed).
# --------------------------------------------------------------------------- #
@pytest.fixture(autouse=True)
def _blank_keys(monkeypatch):
    """Force a key-less Settings so the factory always falls back to mock.

    The test environment may have a real .env on disk; pin every key to "" so
    the assertions below are deterministic regardless of the host.
    """
    blank = Settings(
        anthropic_api_key="",
        openai_api_key="",
        google_api_key="",
        xai_api_key="",
        anthropic_model="",
        openai_model="",
        google_model="",
        xai_model="",
    )
    monkeypatch.setattr("app.providers.factory.get_settings", lambda: blank)


@pytest.mark.parametrize("provider", ["anthropic", "openai", "google", "xai"])
def test_blank_keys_fall_back_to_mock(provider):
    adapter = get_adapter(provider)
    assert isinstance(adapter, MockAdapter)
    assert adapter.provider == provider
    # The mock carries the registry's default model id for the seat.
    assert adapter.model == REGISTRY[provider].model


@pytest.mark.parametrize("provider", ["anthropic", "openai", "google", "xai"])
def test_mock_completes_deterministically(provider):
    adapter = get_adapter(provider)
    r1 = adapter.complete(system="s", prompt="p", json_mode=False)
    r2 = adapter.complete(system="s", prompt="p", json_mode=False)
    assert r1.text == r2.text  # deterministic
    assert r1.provider == provider
    assert r1.tokens == r1.input_tokens + r1.output_tokens


def test_mock_json_mode_is_valid_json(monkeypatch):
    import json

    adapter = get_adapter("openai")
    resp = adapter.complete(system="s", prompt="p", json_mode=True)
    parsed = json.loads(resp.text)  # must not raise
    assert isinstance(parsed, dict)


def test_model_override_propagates_to_mock():
    adapter = get_adapter("openai", model_override="gpt-custom-xyz")
    assert isinstance(adapter, MockAdapter)
    assert adapter.model == "gpt-custom-xyz"


# --------------------------------------------------------------------------- #
# 2. Modules import without their SDK present (lazy import contract).
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize(
    "module_name",
    [
        "app.providers.openai_adapter",
        "app.providers.google_adapter",
        "app.providers.xai_adapter",
    ],
)
def test_adapter_module_imports_without_sdk(module_name):
    # Importing the module must NOT require the SDK — the SDK import is deferred
    # to the adapter constructor. This is the contract that lets the package
    # load with zero keys / zero SDKs.
    mod = importlib.import_module(module_name)
    assert mod is not None


def test_openai_adapter_class_attrs():
    from app.providers.openai_adapter import OpenAIAdapter

    assert OpenAIAdapter.provider == "openai"
    assert issubclass(OpenAIAdapter, LLMAdapter)


def test_google_adapter_class_attrs():
    from app.providers.google_adapter import GoogleAdapter

    assert GoogleAdapter.provider == "google"
    assert issubclass(GoogleAdapter, LLMAdapter)


def test_xai_adapter_class_attrs():
    from app.providers.openai_adapter import OpenAIAdapter
    from app.providers.xai_adapter import XAIAdapter

    assert XAIAdapter.provider == "xai"
    # xAI reuses the OpenAI-compatible client.
    assert issubclass(XAIAdapter, OpenAIAdapter)


# --------------------------------------------------------------------------- #
# 3. With the SDK installed, construction wires up provider/model (no network).
# --------------------------------------------------------------------------- #
def test_openai_adapter_constructs_with_sdk():
    pytest.importorskip("openai")
    from app.providers.openai_adapter import OpenAIAdapter

    adapter = OpenAIAdapter(api_key="sk-test-dummy", model="gpt-test")
    assert adapter.provider == "openai"
    assert adapter.model == "gpt-test"


def test_xai_adapter_constructs_with_sdk():
    pytest.importorskip("openai")  # xAI uses the openai client
    from app.providers.xai_adapter import XAIAdapter

    adapter = XAIAdapter(api_key="xai-test-dummy", model="grok-test")
    assert adapter.provider == "xai"
    assert adapter.model == "grok-test"


def test_google_adapter_constructs_with_sdk():
    pytest.importorskip("google.genai")
    from app.providers.google_adapter import GoogleAdapter

    adapter = GoogleAdapter(api_key="goog-test-dummy", model="gemini-test")
    assert adapter.provider == "google"
    assert adapter.model == "gemini-test"
