#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════════════════════
# Warden — Mainnet Deployment Script
# ═════════════════════════════════════════════════════════════════════════════
set -euo pipefail

echo "🛡️  Warden Mainnet Deployment"
echo "═══════════════════════════════════"

# ── Config ───────────────────────────────────────────────────────────────────
RHC_RPC="${RHC_HTTP_URL:-https://rpc.mainnet.chain.robinhood.com}"
DEPLOYER_KEY="${DEPLOYER_PRIVATE_KEY:?Set DEPLOYER_PRIVATE_KEY}"
MATCHER_KEY="${MATCHER_PRIVATE_KEY:?Set MATCHER_PRIVATE_KEY}"
RHC_WSS="${RHC_WSS_URL:?Set RHC_WSS_URL (e.g. Alchemy: wss://robinhood-mainnet.g.alchemy.com/v2/<key>)}"
FEE="${WARDEN_FEE:-100000000000000}"  # 0.0001 ETH per delivery

MATCHER_ADDRESS=$(cast wallet address --private-key "$MATCHER_KEY")

echo ""
echo "  Deployer:  $(cast wallet address --private-key "$DEPLOYER_KEY")"
echo "  Matcher:   $MATCHER_ADDRESS"
echo "  Fee:       $FEE wei"

# ── Check Foundry ────────────────────────────────────────────────────────────
if ! command -v forge &>/dev/null; then
  echo "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  source ~/.bashrc
  foundryup
fi

# ── Build ────────────────────────────────────────────────────────────────────
cd "$(dirname "$0")/../foundry"
echo ""
echo "Building contracts..."
forge build

# ── Deploy StreamEscrow ─────────────────────────────────────────────────────
echo ""
echo "Deploying StreamEscrow to Robinhood Chain mainnet..."
echo "  RPC: $RHC_RPC"
echo "  Matcher (owner): $MATCHER_ADDRESS"
echo ""

DEPLOY_OUTPUT=$(forge create \
  --rpc-url "$RHC_RPC" \
  --private-key "$DEPLOYER_KEY" \
  --priority-gas-price 20000000 \
  src/StreamEscrow.sol:StreamEscrow \
  --constructor-args "$MATCHER_ADDRESS" "$FEE" \
  --json 2>&1)

echo "$DEPLOY_OUTPUT"

ESCROW_ADDRESS=$(echo "$DEPLOY_OUTPUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['deployedTo'])")
TX_HASH=$(echo "$DEPLOY_OUTPUT" | python3 -c "import sys,json;print(json.load(sys.stdin)['transactionHash'])")

echo ""
echo "═══════════════════════════════════"
echo "✅ StreamEscrow Deployed!"
echo ""
echo "  Address:  $ESCROW_ADDRESS"
echo "  TX:       $TX_HASH"
echo ""
echo "  Explorer: https://robinhoodchain.blockscout.com/address/$ESCROW_ADDRESS"
echo ""

# ── Write .env ───────────────────────────────────────────────────────────────
cat > ../.env << EOF
# ── RPC endpoints ────────────────────────────────────────────────────────
RHC_HTTP_URL=$RHC_RPC
RHC_WSS_URL=$RHC_WSS

# ── Deployed StreamEscrow ────────────────────────────────────────────────
ESCROW_ADDRESS=$ESCROW_ADDRESS

# ── Matcher relayer wallet (runs 24/7, keep low balance — gas only) ──────
MATCHER_PRIVATE_KEY=$MATCHER_KEY

# ── Subscriber signing key ──────────────────────────────────────────────
USER_PRIVATE_KEY=0xYOUR_SUBSCRIBER_KEY

# ── Watch targets ────────────────────────────────────────────────────────
WATCH_CONTRACTS=TSLA:Transfer,AAPL:Transfer,NVDA:Transfer

# ── Database ─────────────────────────────────────────────────────────────
DB_PATH=./warden.db
EOF

echo "✅ .env written with $ESCROW_ADDRESS"
echo ""
echo "═══════════════════════════════════"
echo "Next steps:"
echo "  1. Fund matcher wallet (gas only — 0.01 ETH): $MATCHER_ADDRESS"
echo "     (deployer wallet used: $(cast wallet address --private-key "$DEPLOYER_KEY"))"
echo "     Bridge ETH to RHC: https://bridge.arbitrum.io"
echo "  2. Start matcher:  cd matcher && node dist/index.js"
echo "  3. Subscribe:      warden subscribe --ai \"whales over 100k TSLA\" --webhook URL --amount 0.05"
echo "═══════════════════════════════════"
