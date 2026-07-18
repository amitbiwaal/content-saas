"""SSRF egress guard — rejects internal/reserved hosts, allows public ones."""

import pytest
from fastapi import HTTPException

from app.net import guard_ssrf


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/wp-json",          # loopback
        "http://localhost/wp-json",          # loopback by name
        "http://10.1.2.3/wp-json",           # RFC-1918 private
        "http://192.168.0.5/wp-json",        # RFC-1918 private
        "http://169.254.169.254/latest",     # link-local / cloud metadata
        "http://0.0.0.0/x",                  # unspecified
        "not-a-url",                         # no host
        "",                                  # empty
    ],
)
def test_blocks_internal_and_invalid(url):
    with pytest.raises(HTTPException) as ei:
        guard_ssrf(url)
    assert ei.value.status_code == 422


def test_allows_public_ip():
    # A public IP literal resolves without network and must pass.
    guard_ssrf("https://8.8.8.8/wp-json/wp/v2/posts")


def test_allows_nat64_global_ipv6():
    # 64:ff9b::/96 is IANA "reserved" yet globally routable (IPv6-only clients
    # reach the IPv4 internet through it). Real hosts resolve here — must pass.
    guard_ssrf("https://[64:ff9b::808:808]/wp-json")  # NAT64 form of 8.8.8.8
