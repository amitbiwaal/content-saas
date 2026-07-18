"""In-process rate limiter — window behaviour + path routing."""

import time

from app.ratelimit import _FixedWindow, _limit_for


def test_allows_up_to_limit_then_blocks():
    fw = _FixedWindow()
    key = ("run", "u:x")
    for _ in range(5):
        assert fw.check(key, 5, 60.0)[0] is True
    allowed, retry = fw.check(key, 5, 60.0)
    assert allowed is False
    assert retry > 0  # a Retry-After hint is returned


def test_window_resets_after_it_elapses():
    fw = _FixedWindow()
    key = ("run", "u:y")
    for _ in range(3):
        assert fw.check(key, 3, 0.05)[0] is True
    assert fw.check(key, 3, 0.05)[0] is False  # over the limit
    time.sleep(0.06)  # let the window elapse
    assert fw.check(key, 3, 0.05)[0] is True  # counter reset


def test_keys_are_independent():
    fw = _FixedWindow()
    assert fw.check(("run", "u:a"), 1, 60.0)[0] is True
    assert fw.check(("run", "u:a"), 1, 60.0)[0] is False  # a is capped
    assert fw.check(("run", "u:b"), 1, 60.0)[0] is True   # b is unaffected


def test_path_routing():
    # Only POSTs to the expensive/auth surfaces are throttled.
    assert _limit_for("/api/auth/login", "POST")[1] == "auth"
    assert _limit_for("/api/auth/signup", "POST")[1] == "auth"
    assert _limit_for("/api/projects/abc123/run", "POST")[1] == "run"
    assert _limit_for("/api/projects/abc123/council", "POST")[1] == "run"
    assert _limit_for("/api/projects/from-message", "POST")[1] == "run"
    # untouched surfaces
    assert _limit_for("/api/projects/abc123/run", "GET") == (None, None)
    assert _limit_for("/api/projects", "GET") == (None, None)
    assert _limit_for("/api/auth/me", "GET") == (None, None)
