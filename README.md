# <img src="logo.jpg" width="28" height="28" style="vertical-align:middle;margin-right:6px">Warden

**Watch the chain. React before the next block.**

🌐 **[wardenofficial.com](https://wardenofficial.com)**

Real-time chain surveillance for Robinhood Chain. Describe what you're watching in plain English; Warden pushes every match to your webhook, AI agent, or dashboard — signed, on-chain, and under a second. No polling, no indexer, no glue code.

---

## How it works

```
┌──────────────┐    WS (eth_subscribe)    ┌──────────────┐   POST (HMAC)   ┌─────────────┐
│  RHC RPC     │─────────────────────────▶│  Warden      │───────────────▶│  Your       │
│  (logs)      │                          │  (predicate) │                │  webhook    │
└──────────────┘                          └──────┬───────┘                └─────────────┘
                                                 │
                                                 │ recordDelivery (on-chain)
                                                 ▼
                                        ┌──────────────┐
                                        │  StreamEscrow│
                                        │  (Solidity)  │
                                        └──────────────┘
```

1. **Describe.** Type "whales over 100k TSLA" or write a JSON predicate. Lock ETH in the on-chain escrow.
2. **Match.** Warden watches RHC logs in real-time via WebSocket. Evaluates your predicate in sub-milliseconds.
3. **Deliver.** On match → POST to your webhook (HMAC-signed, idempotency-keyed, retried 3×). Receipt written on-chain.

---

## Quickstart

### CLI

```bash
# Describe an event in plain English
warden ai "whales over 100k TSLA"

# Subscribe
warden subscribe --ai "whales over 100k TSLA" \
  --webhook https://webhook.site/your-id \
  --amount 0.05

# Watch live
warden watch --ai "swap over 50k" \
  --webhook https://webhook.site/your-id \
  --amount 0.1

# Check system health
warden doctor

# Fire test webhooks (zero cost)
warden sandbox --webhook https://webhook.site/your-id

# Replay recent deliveries
warden replay-last
```

### Workspace (visual builder)

```bash
cd workspace && node server.mjs
# Open http://localhost:4000
```

### Docker (one command)

```bash
cp .env.example .env   # fill in RPC URLs + keys
docker compose -f docker/docker-compose.yml up --build
```

| Service | Port | Description |
|---------|------|-------------|
| **Workspace** | `4000` | Visual builder, dry-run, live feed, click-to-explain |
| **Prometheus** | `9091` | Metrics scraper |
| **Grafana** | `3000` | Pre-built dashboard (admin/admin) |
| **Metrics** | `9090` | Matcher metrics (Prometheus scrape target) |

---

## Predicate Language

```json
{
  "and": [
    { "field": "eventName", "op": "eq", "value": "Transfer" },
    { "field": "value", "op": "gte", "value": "1000000000000000000000" }
  ]
}
```

### Operators

`eq` `neq` `gte` `lte` `gt` `lt` `in` `not_in` `contains` `starts_with` `ends_with` `regex`

Nest `and`/`or` up to 6 levels, 32 conditions max. Regex patterns are safety-checked for catastrophic backtracking.

### Plain-English Parser

Type natural language — gets converted to JSON automatically:

| Input | Output |
|-------|--------|
| `whales over 100k TSLA` | Transfer ≥ 100,000 TSLA |
| `transfers under 10 AAPL` | Transfer ≤ 10 AAPL |
| `swap over 50000` | Swap event ≥ 50,000 |
| `liquidation from 0xPool` | Liquidation from address |
| `to 0xABC over 5000` | Transfer to address ≥ 5,000 |

Recognized tickers: TSLA, AAPL, NVDA, AMZN, MSFT, GOOGL, META, MSTR, SPY, QCOM.

---

## Architecture

```
warden/
├── matcher/     Predicate engine, RHC log listener, webhook delivery, metrics
├── cli/         warden subscribe | list | cancel | tail | watch | replay | sandbox | doctor | ai
├── mcp/         MCP server (read-only hosted + signing local stdio)
├── workspace/   Visual builder, plain-English parser, dry-run, live feed, click-to-explain
├── dashboard/   Read-only status page (Express + SQLite)
├── docker/      Docker Compose, Prometheus, Grafana dashboard
├── foundry/     StreamEscrow.sol + tests (Foundry)
└── docs/        Example predicates
```

### MCP (AI Agent Integration)

```bash
# Hosted read-only (no key needed):
WARDEN_MCP_URL=https://wardenofficial.com/mcp

# Local stdio (subscribe + cancel):
claude mcp add --transport stdio warden -- node mcp/dist/index.js
```

Tools: `recent_deliveries`, `warden_sandbox_dispatch`, `subscribe_to_events`, `list_subscriptions`, `cancel_subscription`.

---

## Monitored Contracts

Default: TSLA Transfer events.

```bash
# Single token
WATCH_TOKEN_ADDRESS=0x322F0929c4625eD5bAd873c95208D54E1c003b2d

# Multiple custom contracts (Pro)
WATCH_CONTRACTS=0xAAA:Transfer,0xBBB:Swap,0xCCC:Liquidation

# Ticker shorthand
WATCH_CONTRACTS=TSLA:Transfer,AAPL:Transfer
```

---

## Recipes

See `docs/examples/`:

- `whale.json` — Large token transfers (≥ 1,000 tokens)
- `treasury-outflow.json` — Large outflows from a treasury
- `compliance-watch.json` — KYC/compliance address activity
- `liquidation-guard.json` — Lending pool withdrawals
- `pool-deposit-rebalance.json` — Pool deposits triggering rebalance

---

## What's here (v0.2) vs what's next

**Here today:**
- 12 predicate operators + regex safety
- Plain-English parser (rule-based, no LLM)
- Web workspace with live dry-run + click-to-explain
- Webhook delivery (HMAC, idempotency, retry ×3)
- On-chain escrow + delivery receipts (Solidity)
- MCP server (5 tools, any MCP client)
- CLI (9 commands)
- Docker Compose + Prometheus + Grafana
- Configurable watch targets (ERC-20 + arbitrary events)

**Coming:**
- Durable at-least-once delivery queue
- Multiple matcher relayers / multisig
- SSE as webhook alternative
- Wallet-native subscribe
- Historical event replay

---

## Security

- `MATCHER_PRIVATE_KEY` — only needs ETH for gas. Never fund beyond that.
- `USER_PRIVATE_KEY` — never set in hosted MCP. CLI/local only.
- Contract stores `keccak256(predicate)` + `keccak256(webhook)` — never plaintext on-chain.
- HMAC-SHA256 on every webhook POST. Verify with the reference verifier in `delivery.ts`.

---

MIT License. Built for the Robinhood Chain ecosystem.
