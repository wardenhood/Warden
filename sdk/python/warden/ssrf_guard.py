"""
ssrf_guard.py
-----------------------------------------------------------------------------
Drop-in replacement for the SSRF-guard logic in `sdk/python/warden/__init__.py`.

Two gaps fixed:

  1. `_validate_webhook_url` used Python's `ipaddress.ip_address(...).is_private`
     / `.is_loopback` / `.is_link_local`, which is good but does NOT flag the
     CGNAT range 100.64.0.0/10 as private (confirmed against Python 3.12 --
     `ipaddress.ip_address("100.64.0.1").is_private` returns False). That
     range is used by cloud providers for internal traffic, so it needs its
     own explicit check.

  2. `urllib.request.urlopen()` resolves DNS itself, separately from when
     `_validate_webhook_url` checked it -- classic TOCTOU / DNS-rebinding.
     It also follows redirects automatically with no re-validation, so a
     validated `http://attacker.com/` that 302s to `http://169.254.169.254/`
     goes straight through.

Fix strategy: resolve the hostname ourselves, validate every returned
address, pin the socket connection to the validated address, and walk
redirects manually so each hop is re-validated from scratch.

Usage:
    from ssrf_guard import validate_webhook_url, safe_request

    # at subscribe-time:
    validate_webhook_url(user_provided_url)

    # wherever the SDK currently calls urllib.request.urlopen(...):
    status, headers, body = safe_request(url, method="POST", data=payload, headers=hdrs)
-----------------------------------------------------------------------------
"""

from __future__ import annotations

import http.client
import ipaddress
import socket
from typing import Optional
from urllib.parse import urljoin, urlparse

MAX_REDIRECTS = 5
DEFAULT_TIMEOUT_SECONDS = 10

# CGNAT range that ipaddress.IPv4Address.is_private does NOT cover.
_CGNAT_RANGE = ipaddress.ip_network("100.64.0.0/10")


def _is_blocked_ip(ip_str: str) -> bool:
    """True if ip_str is loopback/private/link-local/CGNAT/multicast/reserved."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True  # not a parseable IP literal -> fail closed

    # Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1) so it hits the same checks
    # as a plain IPv4 address, per the bug report.
    mapped = getattr(ip, "ipv4_mapped", None)
    if mapped is not None:
        ip = mapped

    if isinstance(ip, ipaddress.IPv4Address) and ip in _CGNAT_RANGE:
        return True  # <- the missed range (100.64.0.0/10)

    return bool(
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def _resolve_and_pin(hostname: str) -> str:
    """Resolve hostname, validate every address, return one to pin to."""
    try:
        ipaddress.ip_address(hostname)
        is_literal = True
    except ValueError:
        is_literal = False

    if is_literal:
        if _is_blocked_ip(hostname):
            raise ValueError(f"Blocked destination IP: {hostname}")
        return hostname

    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as exc:
        raise ValueError(f"DNS resolution failed for {hostname}: {exc}") from exc

    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise ValueError(f"No addresses resolved for {hostname}")

    for addr in addresses:
        if _is_blocked_ip(addr):
            raise ValueError(f"Blocked destination IP {addr} resolved for host {hostname}")

    # Pin to one validated address so a later re-resolution (DNS rebinding)
    # can't swap in a private IP between check-time and connect-time.
    return next(iter(addresses))


def validate_webhook_url(url: str) -> None:
    """Validate a webhook URL at subscribe-time (call again at delivery-time too)."""
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Blocked protocol: {parsed.scheme}")
    if not parsed.hostname:
        raise ValueError("Invalid URL: no hostname")
    _resolve_and_pin(parsed.hostname)


class _PinnedHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that connects to a pre-validated IP instead of re-resolving the host."""

    def __init__(self, host: str, pinned_ip: str, *args, **kwargs):
        super().__init__(host, *args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):
        self.sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    """HTTPSConnection that connects to a pre-validated IP; TLS SNI/hostname checks still use the real hostname."""

    def __init__(self, host: str, pinned_ip: str, *args, **kwargs):
        super().__init__(host, *args, **kwargs)
        self._pinned_ip = pinned_ip

    def connect(self):
        sock = socket.create_connection((self._pinned_ip, self.port), self.timeout)
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


def _do_request(
    url: str,
    method: str = "GET",
    data: Optional[bytes] = None,
    headers: Optional[dict] = None,
    redirect_count: int = 0,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
):
    if redirect_count > MAX_REDIRECTS:
        raise ValueError("Too many redirects")

    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError(f"Blocked protocol: {parsed.scheme}")
    if not parsed.hostname:
        raise ValueError("Invalid URL: no hostname")

    pinned_ip = _resolve_and_pin(parsed.hostname)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)

    conn_cls = _PinnedHTTPSConnection if parsed.scheme == "https" else _PinnedHTTPConnection
    conn = conn_cls(parsed.hostname, pinned_ip, port=port, timeout=timeout)

    try:
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        conn.request(method, path, body=data, headers=headers or {})
        resp = conn.getresponse()
        body = resp.read()

        if resp.status in (301, 302, 303, 307, 308):
            location = resp.getheader("Location")
            if not location:
                raise ValueError("Redirect response with no Location header")
            next_url = urljoin(url, location)
            return _do_request(next_url, method, data, headers, redirect_count + 1, timeout)

        return resp.status, dict(resp.getheaders()), body
    finally:
        conn.close()


def safe_request(
    url: str,
    method: str = "GET",
    data: Optional[bytes] = None,
    headers: Optional[dict] = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
):
    """
    Drop-in replacement for `urllib.request.urlopen(...)` with SSRF protection:
    DNS-pinned connection + manually re-validated redirects.

    Returns (status_code, headers_dict, body_bytes).
    """
    return _do_request(url, method, data, headers, timeout=timeout)
