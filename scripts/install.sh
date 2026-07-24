#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════
# Warden — one-click VPS install
# ═══════════════════════════════════════════════════════════
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/wardenhood/Warden/main/scripts/install.sh | \
#     WARDEN_RHC_WSS_URL=wss://... \
#     WARDEN_RHC_HTTP_URL=https://... \
#     WARDEN_ESCROW_ADDRESS=0x... \
#     WARDEN_MATCHER_PRIVATE_KEY=0x... \
#     bash
#
# Supports: Ubuntu 22.04 / 24.04
# Installs: Node 20, Foundry, Caddy, systemd service
# Idempotent — safe to re-run.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[warden]${NC} $1"; }
warn() { echo -e "${YELLOW}[warden]${NC} $1"; }
err()  { echo -e "${RED}[warden]${NC} $1"; exit 1; }

# ── required env vars ─────────────────────────────────────
: ${WARDEN_RHC_WSS_URL:?set WARDEN_RHC_WSS_URL}
: ${WARDEN_RHC_HTTP_URL:?set WARDEN_RHC_HTTP_URL}
: ${WARDEN_ESCROW_ADDRESS:?set WARDEN_ESCROW_ADDRESS}
: ${WARDEN_MATCHER_PRIVATE_KEY:?set WARDEN_MATCHER_PRIVATE_KEY}

WARDEN_DIR="${WARDEN_DIR:-/opt/warden}"
WARDEN_DOMAIN="${WARDEN_DOMAIN:-}"
WARDEN_WATCH_CONTRACTS="${WARDEN_WATCH_CONTRACTS:-TSLA:Transfer}"

log "Warden VPS installer starting..."
log "target dir: $WARDEN_DIR"

# ── system deps ───────────────────────────────────────────
log "Installing system dependencies..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl git build-essential unzip

# ── Caddy ───────────────────────────────────────────────
log "Installing Caddy (official repo)..."
sudo apt-get install -y -qq debian-archive-keyring apt-transport-https
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf "https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt" | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update -qq
sudo apt-get install -y -qq caddy || true

# ── Node 20 ───────────────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  log "Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
log "Node: $(node -v)"

# ── Foundry ───────────────────────────────────────────────
if ! command -v forge &>/dev/null; then
  log "Installing Foundry..."
  curl -L https://foundry.paradigm.xyz | bash
  export PATH="$HOME/.foundry/bin:$PATH"
  foundryup
fi
log "Foundry: $(forge --version)"

# ── Clone / update repo ───────────────────────────────────
if [ -d "$WARDEN_DIR" ]; then
  log "Updating existing Warden repo..."
  cd "$WARDEN_DIR"
  git pull origin main 2>/dev/null || true
else
  log "Cloning Warden..."
  git clone https://github.com/wardenhood/Warden.git "$WARDEN_DIR"
  cd "$WARDEN_DIR"
fi

# ── Install deps + build ──────────────────────────────────
log "Installing matcher dependencies..."
cd "$WARDEN_DIR/matcher"
npm ci --omit=dev 2>/dev/null || npm install --omit=dev
npm run build 2>/dev/null || true

# ── .env file ─────────────────────────────────────────────
log "Writing .env..."
cat > "$WARDEN_DIR/.env" <<EOF
RHC_WSS_URL=${WARDEN_RHC_WSS_URL}
RHC_HTTP_URL=${WARDEN_RHC_HTTP_URL}
ESCROW_ADDRESS=${WARDEN_ESCROW_ADDRESS}
MATCHER_PRIVATE_KEY=${WARDEN_MATCHER_PRIVATE_KEY}
WATCH_CONTRACTS=${WARDEN_WATCH_CONTRACTS}
DB_PATH=${WARDEN_DIR}/warden.db
METRICS_PORT=9090
WORKSPACE_PORT=4000
EOF
chmod 600 "$WARDEN_DIR/.env"

# ── systemd service ───────────────────────────────────────
log "Installing systemd service..."
sudo tee /etc/systemd/system/warden-matcher.service > /dev/null <<EOF
[Unit]
Description=Warden — real-time event push for Robinhood Chain
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$WARDEN_DIR/matcher
EnvironmentFile=$WARDEN_DIR/.env
ExecStart=$(which node) dist/index.js
Restart=on-failure
RestartSec=10
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable warden-matcher
sudo systemctl restart warden-matcher

# ── Caddy reverse proxy (optional, if domain set) ─────────
if [ -n "$WARDEN_DOMAIN" ]; then
  log "Configuring Caddy for $WARDEN_DOMAIN..."
  sudo tee /etc/caddy/Caddyfile.d/warden.conf > /dev/null <<EOF
$WARDEN_DOMAIN {
  reverse_proxy /metrics* localhost:9090
  reverse_proxy /* localhost:4000
}
EOF
  sudo systemctl restart caddy
  log "TLS certificate issued for $WARDEN_DOMAIN"
fi

# ── Verify ───────────────────────────────────────────────
sleep 3
if systemctl is-active --quiet warden-matcher; then
  log "Warden matcher is running ✓"
else
  warn "Matcher may not have started. Check: journalctl -u warden-matcher -f"
fi

echo ""
echo "══════════════════════════════════════════"
echo -e "${GREEN}Warden installed!${NC}"
echo ""
echo "  Matcher:   sudo journalctl -u warden-matcher -f"
echo "  Metrics:   http://localhost:9090/metrics"
if [ -n "$WARDEN_DOMAIN" ]; then
  echo "  Workspace: https://$WARDEN_DOMAIN"
else
  echo "  Workspace: http://localhost:4000"
fi
echo ""
echo "  Restart:   sudo systemctl restart warden-matcher"
echo "  Stop:      sudo systemctl stop warden-matcher"
echo "══════════════════════════════════════════"
