#!/bin/bash
# Warden auto-start: server + Cloudflare tunnel
# Usage: bash ~/warden/start.sh

WARDEN_DIR="/home/win11/warden"
CLOUDFLARED="/home/win11/.local/bin/cloudflared"
LOG_DIR="/home/win11/warden/logs"
mkdir -p "$LOG_DIR"

echo "[$(date)] Starting Warden server on :4000 ..."
cd "$WARDEN_DIR/workspace" && DB_PATH="$WARDEN_DIR/matcher/warden.db" node server.mjs >> "$LOG_DIR/server.log" 2>&1 &
echo "  Server PID: $!"

sleep 2

echo "[$(date)] Starting Cloudflare tunnel (warden)..."
$CLOUDFLARED tunnel run warden >> "$LOG_DIR/tunnel.log" 2>&1 &
echo "  Tunnel PID: $!"

sleep 3

# Verify
curl -s -o /dev/null -w "  Server health: HTTP %{http_code}\n" http://localhost:4000/
echo "  Tunnel: https://wardenofficial.com"
