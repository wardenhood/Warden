# Changelog

## v0.2.0 — 2026-07-22

### Added
- 12 predicate operators: eq, neq, gte, lte, gt, lt, in, not_in, contains, starts_with, ends_with, regex
- ReDoS safety checker (nested quantifier + alternation bomb detection)
- Plain-English parser: "whales over 100k TSLA" → JSON predicate (rule-based, no LLM)
- evaluateWithTrace() for click-to-explain match diagnostics
- Contract events support via WATCH_CONTRACTS env variable
- Custom ABI loading via dynamic import + createRequire
- SSE (Server-Sent Events) broadcast channel
- Prometheus metrics endpoint: total, ok, failed, mean, p50, p95, p99, uptime
- CLI: tail, watch, replay-last, sandbox, doctor, ai commands
- Web workspace: visual builder + dry-run + live feed + click-to-explain
- Dashboard: live stats + delivery table + trace expansion (Sluice theme)
- Landing page: full Sluice-style layout with Warden branding
- @warden/client TypeScript SDK
- warden-client Python SDK (pip install ready)
- Docker Compose: matcher + workspace + Prometheus + Grafana (10-panel dashboard)
- One-click VPS install script (systemd + Caddy + TLS)
- DemoDex contract (Swap/Liquidation/Deposit events) + keeper bot
- GitHub Actions CI/CD: 4 jobs (matcher, foundry, python, ts-sdk)
- 63 Jest tests + 22 Foundry tests
- .gitignore, LICENSE, CHANGELOG

### Fixed
- ReDoS: `(a+)+$` now properly rejected by REDOS_NESTED_RE + REDOS_ALTERNATION_RE
- CI: jest.config.ts excludes /dist/ to prevent ESM/CJS mismatch
- Custom ABI: `require()` replaced with `createRequire(import.meta.url)` in ESM context
- Docker: added workspace/package.json + multi-stage build with npm run build
- Metrics: `p50` renamed to `mean`, real p50/p95/p99 from 10-min sliding window
- Landing page: scroll-reveal IntersectionObserver inline script

### Changed
- Brand: Sluice-RHC → Warden (all files, packages, configs, docs)
- Chain: Casper/CSPR → Robinhood Chain/ETH (all references)
- Theme: green (#bcfc07) + black + white, Inter + JetBrains Mono fonts

## v0.1.0 — Initial

- StreamEscrow.sol: on-chain escrow + delivery receipts (Solidity + Foundry)
- Predicate engine: 7 operators + nested and/or
- ChainListener: eth_subscribe with reconnect
- Webhook delivery: HMAC-SHA256, idempotency key, 3x retry with backoff
- MCP stdio server: 5 tools
- CLI: subscribe, list, cancel
- Dashboard: read-only SQLite status page
- RHC Stock Token registry: TSLA, AAPL, NVDA, AMZN, MSFT, GOOGL, META, MSTR, SPY, QCOM
- 17 Foundry tests
