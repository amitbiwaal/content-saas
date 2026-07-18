"""Network egress guards (SSRF protection).

A caller supplies the WordPress host, so before we resolve it, send credentials,
or post to it, block hosts that resolve to internal/reserved addresses (internal
services, cloud metadata at 169.254.169.254, localhost, RFC-1918, …). The check
runs both when the site is saved AND at publish time — the latter also blunts
DNS-rebinding (a host that resolved public on save, private later).
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

from fastapi import HTTPException


def guard_ssrf(url: str) -> None:
    """Raise HTTP 422 if ``url``'s host resolves to a non-public address."""
    host = urlparse(url).hostname or ""
    if not host:
        raise HTTPException(status_code=422, detail="Enter a valid site URL.")
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        raise HTTPException(status_code=422, detail="Could not resolve that site's address.")
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        # Allow only globally-routable addresses. is_global is False for loopback,
        # RFC-1918 private, link-local (incl. 169.254.169.254 cloud metadata),
        # multicast and unspecified — so this one check blocks every internal
        # target. We deliberately do NOT block on is_reserved: it also flags the
        # NAT64 prefix (64:ff9b::/96), which is how IPv6-only clients reach the
        # public IPv4 internet — blocking it would break legitimate public sites.
        if not ip.is_global:
            raise HTTPException(status_code=422, detail="That address is not allowed.")
