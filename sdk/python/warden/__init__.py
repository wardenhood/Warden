"""
Warden Python SDK — real-time event push for Robinhood Chain.

Install:
    pip install warden-client

Usage:
    from warden import Warden, parse, verify_signature

    warden = Warden(
        rpc_url="https://rhc-mainnet.example-rpc.com",
        escrow_address="0x...",
        private_key="0x..."
    )

    # Subscribe with plain English
    sub = warden.subscribe(
        ai="whales over 100k TSLA",
        webhook_url="https://webhook.site/xxx",
        amount_eth="0.05"
    )

    # Verify incoming webhook
    def handle_webhook(request):
        raw_body = request.body.decode()
        sig = request.headers.get("X-Warden-Signature", "")
        if not verify_signature("my-secret", raw_body, sig):
            return 401
        # process event...
"""

import hashlib
import hmac as hmac_lib
import json
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

__version__ = "0.2.0"

# ── Token Registry ───────────────────────────────────────────────────────────

TOKEN_TICKERS: dict[str, str] = {
    "tsla": "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    "aapl": "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
    "nvda": "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    "amzn": "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
    "msft": "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
    "googl": "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
    "meta": "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
    "mstr": "0xec262a75e413fAfD0dF80480274532C79D42da09",
    "spy": "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
    "qcom": "0x0f17206447090e464C277571124dD2688E48AEA9",
}

SUFFIXES: dict[str, int] = {"k": 1_000, "m": 1_000_000, "b": 1_000_000_000}

EVENT_PATTERNS: list[tuple[str, str]] = [
    (r"\bswap\b", "Swap"),
    (r"\bliquidation\b", "Liquidation"),
    (r"\bdeposit\b", "Deposit"),
    (r"\bwithdraw(al)?\b", "Withdrawal"),
    (r"\bmint\b", "Mint"),
    (r"\bburn\b", "Burn"),
    (r"\btransfer\b", "Transfer"),
    (r"\bwhales?\b", "Transfer"),
]

# ── Predicate Types ──────────────────────────────────────────────────────────

@dataclass
class Condition:
    field: str
    op: str
    value: Any


@dataclass
class Predicate:
    and_: Optional[list["Predicate"]] = None
    or_: Optional[list["Predicate"]] = None
    field: Optional[str] = None
    op: Optional[str] = None
    value: Optional[Any] = None

    def to_dict(self) -> dict:
        if self.and_ is not None:
            return {"and": [p.to_dict() for p in self.and_]}
        if self.or_ is not None:
            return {"or": [p.to_dict() for p in self.or_]}
        return {"field": self.field, "op": self.op, "value": self.value}


@dataclass
class DeliveryResult:
    ok: bool
    status: Optional[int] = None
    attempts: int = 1
    latency_ms: int = 0
    delivery_id: str = ""


# ── Plain-English Parser ─────────────────────────────────────────────────────

class ParseError(Exception):
    pass


def _parse_number(raw: str) -> Optional[int]:
    s = raw.lower().replace("_", "").replace(",", "").strip()
    for sfx, mult in SUFFIXES.items():
        m = re.match(rf"^([\d.]+)\s*{sfx}$", s)
        if m:
            return int(float(m.group(1)) * mult)
    try:
        return int(s)
    except ValueError:
        return None


def _to_wei(n: int) -> str:
    return str(n * 10**18)


def _find_ticker(text: str) -> Optional[str]:
    lower = text.lower()
    for t, addr in TOKEN_TICKERS.items():
        if t in lower:
            return addr
    return None


def _detect_event(text: str) -> str:
    lower = text.lower()
    for pattern, name in EVENT_PATTERNS:
        if re.search(pattern, lower):
            return name
    return "Transfer"


def parse(description: str) -> Predicate:
    """Convert plain English to a JSON predicate."""
    raw = description.strip()
    if not raw:
        raise ParseError("Empty input")

    ticker = _find_ticker(raw)
    event_name = _detect_event(raw)
    addr_match = re.search(r"0x[a-fA-F0-9]{40}", raw)
    address = addr_match.group(0).lower() if addr_match else None

    op: Optional[str] = None
    amount: Optional[int] = None

    over_match = re.search(r"(over|above|more than|≥|>=)\s*([\d.]+[kmb]?)", raw, re.I)
    under_match = re.search(r"(under|below|less than|≤|<=)\s*([\d.]+[kmb]?)", raw, re.I)

    if over_match:
        op = "gte"
        amount = _parse_number(over_match.group(2))
    elif under_match:
        op = "lte"
        amount = _parse_number(under_match.group(2))

    conds: list[Condition] = [Condition(field="eventName", op="eq", value=event_name)]
    if ticker:
        conds.append(Condition(field="address", op="eq", value=ticker))

    from_match = re.search(r"\b(from|out of|sender)\b", raw, re.I)
    to_match = re.search(r"\b(to|into|recipient|receiver)\b", raw, re.I)

    if (from_match or to_match) and address:
        field = "from" if from_match else "to"
        conds.append(Condition(field=field, op="eq", value=address))
    elif address and not from_match and not to_match:
        field = "to" if event_name == "Transfer" else "from"
        conds.append(Condition(field=field, op="eq", value=address))

    if op and amount is not None:
        conds.append(Condition(field="value", op=op, value=_to_wei(amount)))

    if len(conds) == 1:
        c = conds[0]
        return Predicate(field=c.field, op=c.op, value=c.value)
    return Predicate(and_=[Predicate(field=c.field, op=c.op, value=c.value) for c in conds])


# ── HMAC Verification ────────────────────────────────────────────────────────

def verify_signature(secret: str, raw_body: str, signature_header: str) -> bool:
    """Verify Warden's HMAC-SHA256 webhook signature."""
    if not signature_header:
        return False
    expected = hmac_lib.new(
        secret.encode(), raw_body.encode(), hashlib.sha256
    ).hexdigest()
    return hmac_lib.compare_digest(expected, signature_header)


# ── Warden Client ────────────────────────────────────────────────────────────

ESCROW_ABI = [
    "function subscribe(bytes32 predicateHash, bytes32 webhookHash) payable returns (uint256)",
    "function cancel(uint256 subId)",
    "event Subscribed(uint256 indexed subId, address indexed subscriber, bytes32 predicateHash, bytes32 webhookHash, uint256 amount)",
]


class Warden:
    """Warden client — subscribe to on-chain events, cancel, sandbox test."""

    def __init__(self, rpc_url: str, escrow_address: str, private_key: str):
        self.rpc_url = rpc_url
        self.escrow_address = escrow_address
        self.private_key = private_key

    @staticmethod
    def _validate_webhook_url(url: str) -> bool:
        """Block private/internal IPs and cloud metadata endpoints."""
        try:
            from urllib.parse import urlparse
            import ipaddress
            import re
            parsed = urlparse(url)
            hostname = parsed.hostname or ""
            if hostname in ("localhost", "127.0.0.1", "0.0.0.0", "169.254.169.254", "[::1]"):
                return False
            # Normalize obfuscated numeric hostnames (decimal/hex/octal) to dotted-quad
            if re.fullmatch(r"0x[0-9a-fA-F]+|0[0-7]+|\d+", hostname):
                try:
                    base = 16 if hostname.lower().startswith("0x") else 8 if hostname.startswith("0") and hostname != "0" else 10
                    ip_int = int(hostname, base)
                    hostname = str(ipaddress.IPv4Address(ip_int))
                except (ValueError, ipaddress.AddressValueError):
                    pass
            try:
                ip = ipaddress.ip_address(hostname)
                if ip.is_private or ip.is_loopback or ip.is_link_local:
                    return False
            except ValueError:
                pass  # not an IP literal
            return True
        except Exception:
            return False

    def subscribe(
        self,
        *,
        webhook_url: str,
        amount_eth: str,
        ai: Optional[str] = None,
        predicate: Optional[Predicate] = None,
        hmac_secret: Optional[str] = None,
    ) -> dict:
        """
        Create a subscription.

        Either `ai` (plain English) or `predicate` must be provided.
        """
        try:
            from web3 import Web3
        except ImportError:
            raise ImportError("pip install web3 (warden requires web3.py for on-chain operations)")

        if ai:
            pred = parse(ai)
        elif predicate:
            pred = predicate
        else:
            raise ValueError("Either 'ai' or 'predicate' is required")

        w3 = Web3(Web3.HTTPProvider(self.rpc_url))
        account = w3.eth.account.from_key(self.private_key)
        contract = w3.eth.contract(address=Web3.to_checksum_address(self.escrow_address), abi=ESCROW_ABI)

        predicate_json = pred.to_dict()
        p_hash = Web3.keccak(text=json.dumps(predicate_json, sort_keys=True))
        w_hash = Web3.keccak(text=webhook_url)
        secret = hmac_secret or "0x" + uuid.uuid4().hex

        tx = contract.functions.subscribe(p_hash, w_hash).build_transaction({
            "from": account.address,
            "value": w3.to_wei(amount_eth, "ether"),
            "nonce": w3.eth.get_transaction_count(account.address),
            "gas": 200000,
        })

        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash)

        # Parse Subscribed event
        logs = contract.events.Subscribed().process_receipt(receipt)
        sub_id = str(logs[0]["args"]["subId"]) if logs else None

        return {
            "sub_id": sub_id,
            "tx_hash": receipt["transactionHash"].hex(),
            "predicate": predicate_json,
            "webhook_url": webhook_url,
            "hmac_secret": secret,
            "amount_eth": amount_eth,
        }

    def cancel(self, sub_id: str) -> str:
        """Cancel subscription and refund remaining escrow."""
        try:
            from web3 import Web3
        except ImportError:
            raise ImportError("pip install web3")

        w3 = Web3(Web3.HTTPProvider(self.rpc_url))
        account = w3.eth.account.from_key(self.private_key)
        contract = w3.eth.contract(address=Web3.to_checksum_address(self.escrow_address), abi=ESCROW_ABI)

        tx = contract.functions.cancel(int(sub_id)).build_transaction({
            "from": account.address,
            "nonce": w3.eth.get_transaction_count(account.address),
            "gas": 120000,
        })
        signed = account.sign_transaction(tx)
        tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
        receipt = w3.eth.wait_for_transaction_receipt(tx_hash)
        return receipt["transactionHash"].hex()

    def sandbox(self, webhook_url: str, count: int = 1) -> list[DeliveryResult]:
        """Fire test webhooks (zero on-chain cost). Uses DNS-pinned SSRF guard."""
        from . import ssrf_guard

        try:
            ssrf_guard.validate_webhook_url(webhook_url)
        except ValueError:
            return [DeliveryResult(ok=False, status=403, attempts=0, latency_ms=0, delivery_id="")]

        results: list[DeliveryResult] = []
        for i in range(count):
            delivery_id = str(uuid.uuid4())
            payload = {
                "subId": "sandbox",
                "deliveryId": delivery_id,
                "matchedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "event": {
                    "note": f"Sandbox event {i+1}/{count}",
                    "sampleTransfer": {"from": "0xSender", "to": "0xRecipient", "value": "1000000000000000000"},
                },
            }
            body = json.dumps(payload).encode()
            sig = hmac_lib.new(b"sandbox-secret", body, hashlib.sha256).hexdigest()

            start = time.time()
            try:
                status, _, _ = ssrf_guard.safe_request(
                    webhook_url,
                    method="POST",
                    data=body,
                    headers={
                        "Content-Type": "application/json",
                        "X-Warden-Idempotency-Key": delivery_id,
                        "X-Warden-Sub-Id": "sandbox",
                        "X-Warden-Signature": sig,
                    },
                )
                results.append(DeliveryResult(
                    ok=200 <= status < 300,
                    status=status,
                    latency_ms=int((time.time() - start) * 1000),
                    delivery_id=delivery_id,
                ))
            except Exception:
                results.append(DeliveryResult(
                    ok=False,
                    latency_ms=int((time.time() - start) * 1000),
                    delivery_id=delivery_id,
                ))
        return results
