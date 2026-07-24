/**
 * Main matcher process — enhanced for Warden Pro.
 *
 * Wires together:
 *   ChainListener → evaluateWithTrace() → deliverWebhook() → escrow.recordDelivery()
 *
 * New in Pro:
 *   - Configurable watch targets (ERC-20 + arbitrary contract events)
 *   - Match-trace storage for click-to-explain
 *   - Plain-English parser integration
 */

import "dotenv/config";
import { createRequire } from "node:module";
import { ethers } from "ethers";
import { ChainListener, ERC20_TRANSFER_ABI, type FlatEvent, type WatchTarget } from "./listener.js";
import { evaluateWithTrace, validatePredicate, type ConditionTrace } from "./predicate.js";
import { deliverWebhook } from "./delivery.js";
import { SubscriptionStore } from "./subscriptions.js";
import { RHC_STOCK_TOKENS } from "./tokens.js";
import { recordDelivery as metricsRecordDelivery, setActiveSubscriptions, startMetricsServer } from "./metrics.js";
import { broadcastSSE } from "./sse.js";
import { prewarmRegexPool } from "./safe-regex.js";
import escrowAbi from "../abi/StreamEscrow.json" with { type: "json" };

const require = createRequire(import.meta.url);

const RHC_WSS_URL = process.env.RHC_WSS_URL ?? "wss://rhc-mainnet.example-rpc.com";
const RHC_HTTP_URL = process.env.RHC_HTTP_URL ?? "https://rhc-mainnet.example-rpc.com";
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS ?? "";
const MATCHER_PRIVATE_KEY = process.env.MATCHER_PRIVATE_KEY ?? "";

// ── configurable watch targets ──────────────────────────────────────────────
// Single token (backward compat): WATCH_TOKEN_ADDRESS=0x...
// Multiple custom contracts:   WATCH_CONTRACTS=0xAAA:Transfer,0xBBB:Swap:abi.json,...
// Default: TSLA Transfer

function buildWatchTargets(): WatchTarget[] {
  const targets: WatchTarget[] = [];

  // Single-token mode (backward-compatible)
  const singleToken = process.env.WATCH_TOKEN_ADDRESS;
  if (singleToken && singleToken !== "0x0000000000000000000000000000000000000000") {
    targets.push({
      address: singleToken,
      abi: ERC20_TRANSFER_ABI,
      eventName: "Transfer",
    });
  }

  // Multi-contract mode: WATCH_CONTRACTS=0xAAA:Transfer,0xBBB:Swap
  const custom = process.env.WATCH_CONTRACTS;
  if (custom) {
    for (const entry of custom.split(",")) {
      const parts = entry.trim().split(":");
      const address = parts[0];
      const eventName = parts[1] || "Transfer";

      if (!address.startsWith("0x")) {
        // Could be a ticker name
        const ticker = RHC_STOCK_TOKENS[eventName.toUpperCase()];
        if (ticker) {
          targets.push({ address: ticker, abi: ERC20_TRANSFER_ABI, eventName: "Transfer" });
        }
        continue;
      }

      // Use the provided ABI if it's a file path, otherwise default to ERC-20 Transfer
      const abiPath = parts[2];
      const abi = abiPath
        ? (() => { try { return require(abiPath); } catch { return ERC20_TRANSFER_ABI; } })()
        : ERC20_TRANSFER_ABI;

      targets.push({ address, abi, eventName });
    }
  }

  // Default: TSLA Transfer if nothing configured
  if (targets.length === 0) {
    targets.push({
      address: RHC_STOCK_TOKENS.TSLA,
      abi: ERC20_TRANSFER_ABI,
      eventName: "Transfer",
    });
  }

  return Array.from(new Map(targets.map(t => [t.address + t.eventName, t])).values());
}

// ── main ────────────────────────────────────────────────────────────────────

async function main() {
  const store = new SubscriptionStore(process.env.DB_PATH ?? "./warden.db");

  const httpProvider = new ethers.JsonRpcProvider(RHC_HTTP_URL);
  const wallet = new ethers.Wallet(MATCHER_PRIVATE_KEY, httpProvider);
  const escrow = new ethers.Contract(ESCROW_ADDRESS, escrowAbi, wallet);

  const WATCH_TARGETS = buildWatchTargets();
  const listener = new ChainListener(RHC_WSS_URL, WATCH_TARGETS);

  listener.on("connected", () => console.log("[matcher] connected to RHC log stream"));
  listener.on("disconnected", () => console.warn("[matcher] disconnected, reconnecting..."));

  listener.on("event", async (flat: FlatEvent) => {
    const subs = store.listActive();
    const matches: Array<{ sub: typeof subs[0]; trace: any }> = [];

    // Phase 1: evaluate all subscriptions (non-blocking)
    for (const sub of subs) {
      try {
        const result = evaluateWithTrace(flat, sub.predicate);
        const { matched, trace } = await result;
        if (matched) {
          matches.push({ sub, trace });
          broadcastSSE(sub.subId, { event: flat, matchedAt: new Date().toISOString() });
        }
      } catch (err) {
        console.error(`[matcher] predicate eval error for sub ${sub.subId}:`, err);
      }
    }

    if (matches.length === 0) return;

    // Phase 2: deliver webhooks in parallel
    const deliveries = await Promise.all(matches.map(async ({ sub, trace }) => {
      const deliveryResult = await deliverWebhook(sub.webhookUrl, sub.hmacSecret, sub.subId, flat);
      metricsRecordDelivery(deliveryResult.ok, deliveryResult.latencyMs);
      console.log(
        `[matcher] sub ${sub.subId} match -> webhook ${deliveryResult.ok ? "OK" : "FAILED"} ` +
          `(${deliveryResult.attempts} attempt(s), ${deliveryResult.latencyMs}ms)`
      );
      return { sub, trace, deliveryResult };
    }));

    // Phase 3: batch record on-chain
    const batchIds: string[] = [];
    const batchHashes: string[] = [];
    for (const { sub, deliveryResult } of deliveries) {
      if (deliveryResult.ok) {
        batchIds.push(sub.subId); // keep as string — ethers v6 accepts string numeric for uint256[]
        batchHashes.push(ethers.id(deliveryResult.deliveryId));
      }
    }

    let batchTxHash: string | undefined;
    if (batchIds.length > 0) {
      try {
        const tx = await escrow.recordDeliveries(batchIds, batchHashes);
        const receipt = await tx.wait();
        batchTxHash = receipt.hash;
        console.log(`[matcher] batch recordDeliveries: ${batchIds.length} receipts · tx ${receipt.hash.slice(0, 10)}…`);
      } catch (err) {
        console.error(`[matcher] batch recordDeliveries failed:`, err);
      }
    }

    // Phase 4: persist to local store
    for (const { sub, trace, deliveryResult } of deliveries) {
      store.recordDelivery(
        deliveryResult.deliveryId, sub.subId, deliveryResult.status,
        deliveryResult.latencyMs, batchTxHash, trace
      );
    }
  });

  // Sync: pick up on-chain Subscribed/Cancelled events
  // NOTE: Subscribed event currently only logs — the plaintext predicate + webhook URL
  // are stored via CLI/MCP (which must be co-located with the matcher's SQLite DB).
  // For multi-host deployments, implement a shared store (Postgres/Redis) or
  // an out-of-band sync mechanism so subscriptions survive across restarts.
  escrow.on("Subscribed", (subId: bigint, subscriber: string, predicateHash: string, webhookHash: string, amount: bigint) => {
    console.log(`[matcher] on-chain Subscribed sub=${subId} subscriber=${subscriber} amount=${amount}`);
  });
  escrow.on("Cancelled", (subId: bigint) => {
    store.deactivate(subId.toString());
  });

  // Start metrics server (Prometheus scrape target)
  const metricsPort = parseInt(process.env.METRICS_PORT ?? "9090");
  startMetricsServer(metricsPort);

  // Periodically update active sub count for Prometheus
  setInterval(() => {
    setActiveSubscriptions(store.listActive().length);
  }, 10_000);

  // Pre-warm regex worker pool (avoids cold-start timeout on first regex match)
  await prewarmRegexPool();

  await listener.start();
  console.log("[matcher] running. watching:", WATCH_TARGETS.map((t) => `${t.eventName}@${t.address.slice(0, 10)}…`).join(", "));
}

main().catch((err) => {
  console.error("[matcher] fatal:", err);
  process.exit(1);
});
