#!/usr/bin/env node
/**
 * Warden Pro CLI — enhanced with tail, watch, sandbox, replay-last, doctor, ai.
 *
 * Usage:
 *   warden subscribe --predicate ./whale.json --webhook https://webhook.site/xxx --amount 0.05
 *   warden subscribe --ai "whales over 100k TSLA" --webhook https://webhook.site/xxx --amount 0.05
 *   warden list
 *   warden cancel --sub-id 3
 *   warden tail
 *   warden watch  --predicate ./whale.json --webhook https://... --amount 0.05
 *   warden replay-last --sub-id 3
 *   warden sandbox --webhook https://webhook.site/xxx
 *   warden doctor
 *   warden ai "whales over 100k TSLA"
 */

import { Command } from "commander";
import { ethers } from "ethers";
import { readFileSync, writeFileSync } from "node:fs";
import escrowAbi from "../matcher/abi/StreamEscrow.json" with { type: "json" };
import { predicateHash, webhookHash, SubscriptionStore } from "../matcher/dist/subscriptions.js";
import { validatePredicate } from "../matcher/dist/predicate.js";
import { parse } from "../matcher/dist/ai-parser.js";
import { deliverWebhook } from "../matcher/dist/delivery.js";

const program = new Command();
program.name("warden").description("Warden Pro — real-time event push for Robinhood Chain").version("0.2.0");

const RHC_HTTP_URL = process.env.RHC_HTTP_URL ?? "https://rhc-mainnet.example-rpc.com";
const RHC_WSS_URL = process.env.RHC_WSS_URL ?? "wss://rhc-mainnet.example-rpc.com";
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS ?? "";
const PRIVATE_KEY = process.env.USER_PRIVATE_KEY ?? "";
const DB_PATH = process.env.DB_PATH ?? "./warden.db";

function getEscrow() {
  const provider = new ethers.JsonRpcProvider(RHC_HTTP_URL);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  return new ethers.Contract(ESCROW_ADDRESS, escrowAbi, wallet);
}

function getStore() {
  return new SubscriptionStore(DB_PATH);
}

// ── subscribe (enhanced with --ai flag) ─────────────────────────────────────

program
  .command("subscribe")
  .option("--ai <text>", "plain-English description (e.g. \"whales over 100k TSLA\")")
  .option("--predicate <path>", "path to predicate JSON file")
  .requiredOption("--webhook <url>", "webhook URL to receive matches")
  .requiredOption("--amount <eth>", "amount of ETH to lock, e.g. 0.05")
  .action(async (opts) => {
    let predicate;
    if (opts.ai) {
      const result = parse(opts.ai);
      predicate = result.predicate;
      console.log(`ai: ${result.description}`);
      console.log(`predicate: ${JSON.stringify(predicate)}`);
    } else if (opts.predicate) {
      predicate = JSON.parse(readFileSync(opts.predicate, "utf-8"));
    } else {
      console.error("Error: --ai or --predicate required");
      process.exit(1);
    }

    validatePredicate(predicate);
    const escrow = getEscrow();
    const pHash = predicateHash(predicate);
    const wHash = webhookHash(opts.webhook);

    console.log("submitting...");
    const tx = await escrow.subscribe(pHash, wHash, { value: ethers.parseEther(opts.amount) });
    console.log(`tx_hash: ${tx.hash}`);
    const receipt = await tx.wait();

    const parsed = receipt.logs
      .map((l) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((l) => l?.name === "Subscribed");
    const subId = parsed?.args?.subId?.toString();

    const store = getStore();
    store.upsert({ subId, predicate, webhookUrl: opts.webhook, hmacSecret: ethers.hexlify(ethers.randomBytes(16)), active: true });

    console.log(`subscription id: ${subId}`);
    console.log(`amount locked: ${opts.amount} ETH`);
    console.log(`webhook: ${opts.webhook}`);
    console.log(`→ tip: run 'warden tail' to watch deliveries`);
  });

// ── list ────────────────────────────────────────────────────────────────────

program.command("list").action(() => {
  const store = getStore();
  const subs = store.listActive();
  if (subs.length === 0) {
    console.log("No active subscriptions.");
    return;
  }
  console.table(subs.map(s => ({
    id: s.subId, active: s.active, webhook: s.webhookUrl.slice(0, 40) + (s.webhookUrl.length > 40 ? "…" : ""),
  })));
});

// ── cancel ──────────────────────────────────────────────────────────────────

program.command("cancel")
  .requiredOption("--sub-id <id>", "subscription id to cancel")
  .action(async (opts) => {
    const escrow = getEscrow();
    const tx = await escrow.cancel(opts.subId);
    console.log(`tx_hash: ${tx.hash}`);
    await tx.wait();
    getStore().deactivate(opts.subId);
    console.log("cancelled, remaining balance refunded on-chain.");
  });

// ── tail — live stream deliveries ───────────────────────────────────────────

program.command("tail")
  .description("Live-stream recent deliveries (polling every 3s)")
  .option("--limit <n>", "how many to show", "20")
  .action(async (opts) => {
    const limit = parseInt(opts.limit);
    const store = getStore();
    let lastCount = 0;

    console.log("Tailing deliveries (ctrl-c to quit)...\n");

    const poll = () => {
      const deliveries = store.recentDeliveries(limit);
      if (deliveries.length > lastCount) {
        for (let i = lastCount; i < deliveries.length; i++) {
          const d = deliveries[i];
          const ok = d.status >= 200 && d.status < 300;
          const icon = ok ? "✓" : "✗";
          const time = new Date(d.created_at).toLocaleTimeString();
          console.log(`${icon} ${time} | sub ${d.sub_id} | ${d.status ?? "failed"} | ${d.latency_ms}ms | ${d.tx_hash ? d.tx_hash.slice(0, 10) + "…" : "—"}`);
        }
        lastCount = deliveries.length;
      }
    };

    poll();
    const interval = setInterval(poll, 3000);
    process.on("SIGINT", () => { clearInterval(interval); console.log("\nstopped."); process.exit(0); });
    process.on("SIGTERM", () => { clearInterval(interval); process.exit(0); });
  });

// ── watch — subscribe + tail in one command ─────────────────────────────────

program.command("watch")
  .option("--ai <text>", "plain-English description")
  .option("--predicate <path>", "path to predicate JSON file")
  .requiredOption("--webhook <url>", "webhook URL")
  .requiredOption("--amount <eth>", "amount of ETH to lock")
  .action(async (opts) => {
    // Reuse subscribe logic
    let predicate;
    if (opts.ai) {
      const result = parse(opts.ai);
      predicate = result.predicate;
      console.log(`ai: ${result.description}`);
    } else if (opts.predicate) {
      predicate = JSON.parse(readFileSync(opts.predicate, "utf-8"));
    } else {
      console.error("Error: --ai or --predicate required");
      process.exit(1);
    }

    validatePredicate(predicate);
    const escrow = getEscrow();
    const pHash = predicateHash(predicate);
    const wHash = webhookHash(opts.webhook);

    console.log("submitting...");
    const tx = await escrow.subscribe(pHash, wHash, { value: ethers.parseEther(opts.amount) });
    console.log(`tx_hash: ${tx.hash}`);
    const receipt = await tx.wait();

    const parsed = receipt.logs
      .map((l) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((l) => l?.name === "Subscribed");
    const subId = parsed?.args?.subId?.toString();

    const store = getStore();
    store.upsert({ subId, predicate, webhookUrl: opts.webhook, hmacSecret: ethers.hexlify(ethers.randomBytes(16)), active: true });

    console.log(`subscription id: ${subId}`);
    console.log(`→ watching... (ctrl-c to quit)\n`);

    // Tail loop
    let lastCount = 0;
    const poll = () => {
      const deliveries = store.recentDeliveries(20);
      if (deliveries.length > lastCount) {
        for (let i = lastCount; i < deliveries.length; i++) {
          const d = deliveries[i];
          const ok = d.status >= 200 && d.status < 300;
          console.log(`${ok ? "✓" : "✗"} ${new Date(d.created_at).toLocaleTimeString()} | ${d.status ?? "failed"} | ${d.latency_ms}ms`);
        }
        lastCount = deliveries.length;
      }
    };
    poll();
    const interval = setInterval(poll, 3000);
    process.on("SIGINT", () => { clearInterval(interval); console.log("\nstopped. subscription still active."); process.exit(0); });
  });

// ── replay-last — re-send recent deliveries (no on-chain cost) ──────────────

program.command("replay-last")
  .description("Re-send the most recent deliveries with no new on-chain cost")
  .option("--sub-id <id>", "filter by subscription id")
  .option("--count <n>", "how many to replay", "3")
  .action(async (opts) => {
    const store = getStore();
    let deliveries = store.recentDeliveries(50);

    if (opts.subId) {
      deliveries = deliveries.filter(d => String(d.sub_id) === opts.subId);
    }

    const count = parseInt(opts.count);
    const toReplay = deliveries.slice(0, count);

    if (toReplay.length === 0) {
      console.log("No deliveries to replay.");
      return;
    }

    console.log(`Replaying ${toReplay.length} delivery(s)...\n`);

    for (const d of toReplay.reverse()) {
      // Try active subs first, then deactivated ones
      let sub = store.listActive().find(s => s.subId === String(d.sub_id));
      if (!sub) sub = store.getAny(String(d.sub_id));
      if (!sub) {
        console.log(`  sub ${d.sub_id}: cannot replay (subscription not found in store)`);
        continue;
      }

      // Fire a replay using sandbox dispatch
      const result = await deliverWebhook(sub.webhookUrl, sub.hmacSecret, String(d.sub_id), {
        note: `[REPLAY] ${d.delivery_id}`,
        original_delivery_id: d.delivery_id,
        original_created_at: d.created_at,
      });
      console.log(`  ${result.ok ? "✓" : "✗"} sub ${d.sub_id} → ${sub.webhookUrl.slice(0, 30)}… | ${result.status ?? "err"} | ${result.latencyMs}ms`);
    }
    console.log("\ndone. (no on-chain receipts written for replays)");
  });

// ── sandbox — fire test webhooks (zero on-chain cost) ───────────────────────

program.command("sandbox")
  .description("Fire a test webhook with zero on-chain cost")
  .requiredOption("--webhook <url>", "webhook URL to test")
  .option("--count <n>", "number of test events to fire", "1")
  .action(async (opts) => {
    const count = parseInt(opts.count);
    console.log(`Firing ${count} sandbox event(s) to ${opts.webhook}...\n`);

    for (let i = 0; i < count; i++) {
      const result = await deliverWebhook(opts.webhook, "sandbox-secret", "sandbox", {
        note: `Sandbox event ${i + 1}/${count}`,
        sampleTransfer: { from: "0xSender", to: "0xRecipient", value: "1000000000000000000" },
        timestamp: new Date().toISOString(),
      });
      console.log(`  ${result.ok ? "✓" : "✗"} attempt ${result.attempts} | ${result.status ?? "err"} | ${result.latencyMs}ms`);
    }
    console.log("\ndone. (no on-chain cost, no subscription needed)");
  });

// ── doctor — health check ───────────────────────────────────────────────────

program.command("doctor")
  .description("Check system health — RPC, matcher, DB, escrow contract")
  .action(async () => {
    console.log("Warden Pro · Doctor\n");

    // 1. RPC check
    console.log("1. RPC endpoint:");
    try {
      const provider = new ethers.JsonRpcProvider(RHC_HTTP_URL);
      const block = await provider.getBlockNumber();
      console.log(`   ✓ connected · block ${block.toLocaleString()} · ${RHC_HTTP_URL}`);
    } catch (e) {
      console.log(`   ✗ failed · ${RHC_HTTP_URL} · ${e.message}`);
    }

    // 2. WebSocket check
    console.log("2. WebSocket endpoint:");
    try {
      const ws = new ethers.WebSocketProvider(RHC_WSS_URL);
      await ws.ready;
      console.log(`   ✓ connected · ${RHC_WSS_URL}`);
      await ws.destroy();
    } catch (e) {
      console.log(`   ✗ failed · ${RHC_WSS_URL} · ${e.message}`);
    }

    // 3. Escrow contract
    console.log("3. Escrow contract:");
    if (!ESCROW_ADDRESS || ESCROW_ADDRESS === "0x0000000000000000000000000000000000000000") {
      console.log("   ⚠ not configured · set ESCROW_ADDRESS in .env");
    } else {
      try {
        const provider = new ethers.JsonRpcProvider(RHC_HTTP_URL);
        const code = await provider.getCode(ESCROW_ADDRESS);
        if (code === "0x") {
          console.log(`   ✗ no contract at ${ESCROW_ADDRESS}`);
        } else {
          const escrow = new ethers.Contract(ESCROW_ADDRESS, escrowAbi, provider);
          const fee = await escrow.feePerDelivery();
          const matcher = await escrow.matcher();
          console.log(`   ✓ deployed · fee=${ethers.formatEther(fee)} ETH · matcher=${matcher}`);
        }
      } catch (e) {
        console.log(`   ✗ failed · ${e.message}`);
      }
    }

    // 4. Matcher private key
    console.log("4. Matcher private key:");
    const matcherKey = process.env.MATCHER_PRIVATE_KEY;
    if (matcherKey && matcherKey.length > 10) {
      try {
        const wallet = new ethers.Wallet(matcherKey, new ethers.JsonRpcProvider(RHC_HTTP_URL));
        const balance = await wallet.provider.getBalance(wallet.address);
        console.log(`   ✓ ${wallet.address} · balance=${ethers.formatEther(balance)} ETH`);
      } catch (e) {
        console.log(`   ✗ invalid or RPC down · ${e.message}`);
      }
    } else {
      console.log("   ⚠ not configured · set MATCHER_PRIVATE_KEY in .env");
    }

    // 5. Database
    console.log("5. Database:");
    try {
      const store = getStore();
      const subs = store.listActive();
      const deliveries = store.recentDeliveries(1);
      console.log(`   ✓ ${subs.length} active subs · ${deliveries.length ? "deliveries found" : "no deliveries yet"} · ${DB_PATH}`);
    } catch (e) {
      console.log(`   ⚠ ${e.message}`);
    }

    // 6. Subscription private key
    console.log("6. User private key:");
    if (PRIVATE_KEY && PRIVATE_KEY.length > 10) {
      try {
        const wallet = new ethers.Wallet(PRIVATE_KEY, new ethers.JsonRpcProvider(RHC_HTTP_URL));
        const balance = await wallet.provider.getBalance(wallet.address);
        console.log(`   ✓ ${wallet.address} · balance=${ethers.formatEther(balance)} ETH`);
      } catch {
        console.log(`   ⚠ RPC down, cannot check balance`);
      }
    } else {
      console.log("   ⚠ not configured · set USER_PRIVATE_KEY in .env (for subscribe/cancel)");
    }

    console.log("\n✓ doctor complete.");
  });

// ── ai — plain-English predicate parser (standalone) ────────────────────────

program.command("ai")
  .description("Convert plain English to a JSON predicate")
  .argument("<text>", "natural-language description")
  .option("--save <path>", "save predicate to file")
  .action((text, opts) => {
    const result = parse(text);
    console.log(result.description);
    console.log();
    console.log(JSON.stringify(result.predicate, null, 2));

    if (opts.save) {
      writeFileSync(opts.save, JSON.stringify(result.predicate, null, 2));
      console.log(`\nsaved to ${opts.save}`);
    }
  });

// ── ai — subcommand aliases ─────────────────────────────────────────────────

program.parse();
