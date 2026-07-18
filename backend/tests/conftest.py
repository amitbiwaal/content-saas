"""Shared test fixtures.

Auth is now required on the project/pipeline/export/wordpress routes. Rather than
mint a JWT in every test, override the ``get_current_user`` dependency app-wide so
each test runs as a stub account with ample credits. Tests that specifically
exercise auth do so through their own requests.
"""

from __future__ import annotations

import pytest

from app.main import app
from app.models import User
from app.security import get_current_user


@pytest.fixture(autouse=True)
def auth_as_test_user():
    # Fresh stub per test so credit charges in one test don't bleed into the next.
    user = User(id="test-user-id", email="test@contentos.ai", name="Test", credits=1_000_000)
    app.dependency_overrides[get_current_user] = lambda: user
    try:
        yield user
    finally:
        app.dependency_overrides.pop(get_current_user, None)
