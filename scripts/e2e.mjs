#!/usr/bin/env node
/**
 * Warden E2E Pipeline Test
 * 
 * Tests the full flow: parse → subscribe → match → deliver → record
 * Spawns its own demo receiver internally — no external dependencies.
 * 
 * Usage: node scripts/e2e.mjs
 */

import { fork } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

// WARDEN_ALLOW_LOCAL_WEBHOOKS hanya dipakai di sini untuk menembak webhook
// internal e2e test sendiri (localhost). JANGAN set env var ini di matcher
// production — itu akan mematikan proteksi SSRF sepenuhnya.
process.env.WARDEN_ALLOW_LOCAL_WEBHOOKS = "true";

const FAIL = "\x1b[31m✗\x1b[0m";
const PASS = "\x1b[32m✓\x1b[0m";
const DIM  = "\x1b[90m";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  if (ok) { passed++; console.log(`  ${PASS} ${name} ${DIM}${detail}${DIM}`); }
  else { failed++; console.log(`  ${FAIL} ${name} ${DIM}${detail}${DIM}`); }
}

// ── Spawn internal demo receiver on random port ──────────────────────────────
function startReceiver() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
      let body = "";
      req.on("data", d => body += d);
      req.on("end", () => {
        try { JSON.parse(body); res.writeHead(200); } catch { res.writeHead(400); }
        res.end(JSON.stringify({ ok: true, id: randomUUID() }));
      });
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" ? addr.port : 0;
      resolve({ port, close: () => server.close() });
    });
  });
}

console.log(`\n🛡️  Warden E2E Pipeline Test\n${"─".repeat(50)}`);

const receiver = await startReceiver();
const WEBHOOK_URL = `http://localhost:${receiver.port}/webhook`;

// ── Test 1: Parser ──
console.log(`\n📝 Parser`);
{
  const { parse: aiParse } = await import("../matcher/dist/ai-parser.js");
  const { validatePredicate } = await import("../matcher/dist/predicate.js");

  const r = aiParse("whales over 100k TSLA");
  check("AI: 'whales over 100k TSLA'", r.description.includes("Transfer"));
  check("AI: includes 100k threshold", JSON.stringify(r.predicate).includes("100000000000000000000000"));
  check("AI: includes TSLA address", JSON.stringify(r.predicate).includes("0x322F"));

  const r2 = aiParse("swap over 50000");
  check("AI: 'swap over 50000' detected as Swap", r2.description.includes("Swap"));

  try { validatePredicate(r.predicate); check("Validate: whale predicate valid", true); }
  catch { check("Validate: whale predicate valid", false); }

  try { validatePredicate({ and: [] }); check("Validate: rejects empty and[]", false); }
  catch { check("Validate: rejects empty and[]", true); }

  try { validatePredicate({ field: "x", op: "regex", value: "(a+)+$" }); check("ReDoS: (a+)+ rejected", false); }
  catch { check("ReDoS: (a+)+ rejected", true); }
}

// ── Test 2: Subscriptions ──
console.log(`\n📋 Subscriptions`);
{
  const { SubscriptionStore } = await import("../matcher/dist/subscriptions.js");
  const store = new SubscriptionStore(":memory:");

  store.upsert({ subId: "1", predicate: { field: "x", op: "eq", value: "y" }, webhookUrl: WEBHOOK_URL, hmacSecret: "s1", active: true });
  store.upsert({ subId: "2", predicate: { and: [{ field: "x", op: "gte", value: "100" }] }, webhookUrl: WEBHOOK_URL, hmacSecret: "s2", active: true });
  check("Store: upsert + list", store.listActive().length === 2);

  store.deactivate("2");
  check("Store: deactivate", store.listActive().length === 1);

  const deactivated = store.getAny("2");
  check("Store: getAny finds deactivated", deactivated !== null && !deactivated.active);
}

// ── Test 3: Predicate Evaluation ──
console.log(`\n⚡ Evaluation`);
{
  const { evaluate, evaluateWithTrace } = await import("../matcher/dist/predicate.js");

  const event = {
    eventName: "Transfer",
    address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: "150000000000000000000000",
    transactionHash: "0xabc123",
  };

  const pred = { and: [
    { field: "eventName", op: "eq", value: "Transfer" },
    { field: "value", op: "gte", value: "100000000000000000000000" },
  ]};

  check("Basic AND match", await evaluate(event, pred));
  check("No match on high threshold", !(await evaluate(event, { field: "value", op: "gte", value: "999999999999999999999999" })));

  const traceResult = await evaluateWithTrace(event, pred);
  check("evaluateWithTrace returns trace", traceResult.trace.length === 2);
  check("Trace has matched flags", traceResult.trace.every(t => t.matched));
}

// ── Test 4: Delivery ──
console.log(`\n📨 Delivery`);
{
  const { deliverWebhook, verifySignature } = await import("../matcher/dist/delivery.js");

  const result = await deliverWebhook(WEBHOOK_URL, "test-secret", "test-sub", {
    eventName: "Transfer", value: "100", from: "0xSender", to: "0xRecipient",
  });
  check(`Dispatch to internal receiver`, result.ok, `${result.status} · ${result.latencyMs}ms`);

  const { createHmac } = await import("node:crypto");
  const body = JSON.stringify({ test: true });
  const sig = createHmac("sha256", "secret").update(body).digest("hex");
  check("HMAC: valid signature", verifySignature("secret", body, sig));
  check("HMAC: wrong secret", !verifySignature("wrong", body, sig));
}

// ── Test 5: Metrics ──
console.log(`\n📊 Metrics`);
{
  const { recordDelivery, setActiveSubscriptions } = await import("../matcher/dist/metrics.js");
  recordDelivery(true, 85);
  recordDelivery(true, 92);
  recordDelivery(false, 150);
  setActiveSubscriptions(3);
  check("Metrics: records deliveries (no crash)", true);
}

// ── Cleanup ──
receiver.close();

// ── Summary ──
console.log(`\n${"─".repeat(50)}`);
const total = passed + failed;
const pct = Math.round((passed / total) * 100);
console.log(`  ${passed}/${total} passed (${pct}%)  ${failed ? FAIL + " " + failed + " failed" : "🎉 ALL PASSED"}`);
console.log();

process.exit(failed > 0 ? 1 : 0);
