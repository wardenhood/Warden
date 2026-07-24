/**
 * Warden matcher test suite.
 *
 * Covers: predicate engine (all 12 operators), plain-English parser,
 * regex safety, delivery HMAC verification, subscription store.
 */

import { describe, it, expect, afterAll } from "@jest/globals";
import {
  evaluate, evaluateWithTrace, validatePredicate,
  PredicateError, type Predicate,
} from "../predicate.js";
import { parse, ParseError } from "../ai-parser.js";
import { verifySignature, validateWebhookUrl } from "../delivery.js";
import { SubscriptionStore, predicateHash, webhookHash } from "../subscriptions.js";
import { closeRegexPool } from "../safe-regex.js";

afterAll(async () => {
  await closeRegexPool();
});

// ── sample event ────────────────────────────────────────────────────────────
const event = {
  eventName: "Transfer",
  address: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  from: "0x1111111111111111111111111111111111111111",
  to: "0x2222222222222222222222222222222222222222",
  value: "1000000000000000000000", // 1000 tokens in wei
  blockNumber: 1000,
  transactionHash: "0xabc123",
  logIndex: 5,
};

function toWei(n: number): string {
  return String(BigInt(n) * BigInt(10 ** 18));
}

// ═════════════════════════════════════════════════════════════════════════════
// PREDICATE ENGINE
// ═════════════════════════════════════════════════════════════════════════════

describe("predicate engine", () => {
  // ── basic operators ──
  it("eq matches exact string", async () => {
    expect(await evaluate(event, { field: "eventName", op: "eq", value: "Transfer" })).toBe(true);
  });
  it("eq rejects wrong string", async () => {
    expect(await evaluate(event, { field: "eventName", op: "eq", value: "Swap" })).toBe(false);
  });
  it("neq rejects matching string", async () => {
    expect(await evaluate(event, { field: "eventName", op: "neq", value: "Transfer" })).toBe(false);
  });
  it("neq matches different string", async () => {
    expect(await evaluate(event, { field: "eventName", op: "neq", value: "Swap" })).toBe(true);
  });

  // ── numeric comparison ──
  it("gte — value ≥ threshold", async () => {
    expect(await evaluate(event, { field: "value", op: "gte", value: "500000000000000000000" })).toBe(true);
  });
  it("gte — value < threshold", async () => {
    expect(await evaluate(event, { field: "value", op: "gte", value: "2000000000000000000000" })).toBe(false);
  });
  it("lte — value ≤ threshold", async () => {
    expect(await evaluate(event, { field: "value", op: "lte", value: "1000000000000000000000" })).toBe(true);
  });
  it("gt — value > threshold", async () => {
    expect(await evaluate(event, { field: "value", op: "gt", value: "999999999999999999999" })).toBe(true);
  });
  it("lt — value < threshold", async () => {
    expect(await evaluate(event, { field: "value", op: "lt", value: "2000000000000000000000" })).toBe(true);
  });

  // ── set operations ──
  it("in — value is in list", async () => {
    expect(await evaluate(event, { field: "from", op: "in", value: ["0x1111111111111111111111111111111111111111", "0xdead"] })).toBe(true);
  });
  it("in — value not in list", async () => {
    expect(await evaluate(event, { field: "from", op: "in", value: ["0xdead", "0xbeef"] })).toBe(false);
  });
  it("not_in — value not in list", async () => {
    expect(await evaluate(event, { field: "from", op: "not_in", value: ["0xdead", "0xbeef"] })).toBe(true);
  });
  it("not_in — value IS in list (rejects)", async () => {
    expect(await evaluate(event, { field: "from", op: "not_in", value: ["0x1111111111111111111111111111111111111111"] })).toBe(false);
  });

  // ── string operations ──
  it("contains — substring match", async () => {
    expect(await evaluate(event, { field: "transactionHash", op: "contains", value: "bc1" })).toBe(true);
  });
  it("contains — no match", async () => {
    expect(await evaluate(event, { field: "transactionHash", op: "contains", value: "xyz" })).toBe(false);
  });
  it("starts_with — prefix match", async () => {
    expect(await evaluate(event, { field: "from", op: "starts_with", value: "0x111" })).toBe(true);
  });
  it("starts_with — wrong prefix", async () => {
    expect(await evaluate(event, { field: "from", op: "starts_with", value: "0x222" })).toBe(false);
  });
  it("ends_with — suffix match", async () => {
    expect(await evaluate(event, { field: "from", op: "ends_with", value: "1111" })).toBe(true);
  });

  // ── regex ──
  it("regex — matches pattern", async () => {
    expect(await evaluate(event, { field: "from", op: "regex", value: "^0x1+" })).toBe(true);
  });
  it("regex — no match", async () => {
    expect(await evaluate(event, { field: "from", op: "regex", value: "^0x2" })).toBe(false);
  });

  // ── nested and/or ──
  it("and — all conditions match", async () => {
    expect(await evaluate(event, {
      and: [
        { field: "eventName", op: "eq", value: "Transfer" },
        { field: "value", op: "gte", value: "100000000000000000000" },
      ],
    })).toBe(true);
  });
  it("and — one fails → all fails", async () => {
    expect(await evaluate(event, {
      and: [
        { field: "eventName", op: "eq", value: "Transfer" },
        { field: "value", op: "gte", value: "999999999999999999999999999" },
      ],
    })).toBe(false);
  });
  it("or — at least one matches", async () => {
    expect(await evaluate(event, {
      or: [
        { field: "eventName", op: "eq", value: "Swap" },
        { field: "eventName", op: "eq", value: "Transfer" },
      ],
    })).toBe(true);
  });
  it("or — none match", async () => {
    expect(await evaluate(event, {
      or: [
        { field: "eventName", op: "eq", value: "Swap" },
        { field: "eventName", op: "eq", value: "Mint" },
      ],
    })).toBe(false);
  });

  // ── evaluateWithTrace ──
  it("evaluateWithTrace returns match trace", async () => {
    const result = await evaluateWithTrace(event, {
      and: [
        { field: "eventName", op: "eq", value: "Transfer" },
        { field: "value", op: "gte", value: "100000000000000000000" },
      ],
    });
    expect(result.matched).toBe(true);
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0].field).toBe("eventName");
    expect(result.trace[0].matched).toBe(true);
    expect(result.trace[1].field).toBe("value");
    expect(result.trace[1].matched).toBe(true);
  });

  // ── undefined field ──
  it("unknown field returns false", async () => {
    expect(await evaluate(event, { field: "nonexistent", op: "eq", value: "x" })).toBe(false);
  });

  // ── case-insensitive ──
  it("eq is case-insensitive for strings", async () => {
    expect(await evaluate(event, { field: "eventName", op: "eq", value: "transfer" })).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PREDICATE VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

describe("predicate validation", () => {
  it("accepts valid predicate", async () => {
    expect(() => validatePredicate({ field: "x", op: "eq", value: "y" })).not.toThrow();
  });
  it("rejects empty and[]", async () => {
    expect(() => validatePredicate({ and: [] })).toThrow(PredicateError);
  });
  it("rejects empty or[]", async () => {
    expect(() => validatePredicate({ or: [] })).toThrow(PredicateError);
  });
  it("rejects unknown op", async () => {
    expect(() => validatePredicate({ field: "x", op: "bogus" as any, value: "y" })).toThrow(PredicateError);
  });
  it("rejects empty field", async () => {
    expect(() => validatePredicate({ field: "", op: "eq", value: "y" })).toThrow(PredicateError);
  });
  it("rejects in/not_in without array", async () => {
    expect(() => validatePredicate({ field: "x", op: "in", value: "y" })).toThrow(PredicateError);
  });
  it("rejects contains with non-string value", async () => {
    expect(() => validatePredicate({ field: "x", op: "contains", value: 123 })).toThrow(PredicateError);
  });
  it("rejects unsafe regex (too long)", async () => {
    const longRegex = "a".repeat(300) + "*";
    expect(() => validatePredicate({ field: "x", op: "regex", value: longRegex })).toThrow(PredicateError);
  });
  it("rejects ReDoS nested quantifier: (a+)+", async () => {
    expect(() => validatePredicate({ field: "x", op: "regex", value: "(a+)+$" })).toThrow(PredicateError);
  });
  it("rejects ReDoS nested quantifier: (.+)+", async () => {
    expect(() => validatePredicate({ field: "x", op: "regex", value: "(.+)+$" })).toThrow(PredicateError);
  });
  it("rejects ReDoS nested quantifier: (a*)*", async () => {
    expect(() => validatePredicate({ field: "x", op: "regex", value: "(a*)*" })).toThrow(PredicateError);
  });
  it("rejects ReDoS nested quantifier: ([a-z]+)*", async () => {
    expect(() => validatePredicate({ field: "x", op: "regex", value: "([a-z]+)*" })).toThrow(PredicateError);
  });
  it("rejects ReDoS alternation bomb", async () => {
    expect(() => validatePredicate({ field: "x", op: "regex", value: "(a|b|c|d|e|f|g|h|i)+" })).toThrow(PredicateError);
  });
  it("Layer 2 defense: bypass patterns caught at runtime via worker timeout", async () => {
    // (a|aa)+$ and (a+)(a+)$ slip past Layer 1 heuristic but are caught by Layer 2 worker pool.
    // With test data "abc123", these patterns won't cause catastrophic backtracking,
    // but if they did, the worker would timeout and return false (fail-closed).
    const r1 = await evaluate(event, { field: "transactionHash", op: "regex", value: "(a|aa)+$" });
    // Should return false — pattern doesn't match "0xabc123"
    expect(r1).toBe(false);
    const r2 = await evaluate(event, { field: "transactionHash", op: "regex", value: "(a+)(a+)$" });
    expect(r2).toBe(false);
  });
  it("rejects too many nested conditions", async () => {
    const deep: Predicate = { and: [] };
    let current: Predicate = deep;
    for (let i = 0; i < 7; i++) {
      const next: Predicate = { and: [] };
      (current as any).and.push(next);
      current = next;
    }
    (current as any).and.push({ field: "x", op: "eq", value: "y" });
    expect(() => validatePredicate(deep)).toThrow(PredicateError);
  });
  it("rejects > 32 conditions", async () => {
    const conds = Array.from({ length: 33 }, (_, i) => ({ field: `f${i}`, op: "eq" as const, value: `v${i}` }));
    expect(() => validatePredicate({ and: conds })).toThrow(PredicateError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PLAIN-ENGLISH PARSER
// ═════════════════════════════════════════════════════════════════════════════

describe("plain-english parser", () => {
  it("whales over 100k TSLA", async () => {
    const r = parse("whales over 100k TSLA");
    const p = r.predicate as any;
    expect(p.and).toBeDefined();
    expect(p.and.some((c: any) => c.op === "gte" && c.value === toWei(100000))).toBe(true);
  });

  it("transfers under 10 AAPL", async () => {
    const r = parse("transfers under 10 AAPL");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.op === "lte" && c.value === toWei(10))).toBe(true);
  });

  it("swap over 50000", async () => {
    const r = parse("swap over 50000");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.field === "eventName" && c.value === "Swap")).toBe(true);
  });

  it("liquidation from 0x1234567890123456789012345678901234567890", async () => {
    const r = parse("liquidation from 0x1234567890123456789012345678901234567890");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.field === "eventName" && c.value === "Liquidation")).toBe(true);
    expect(p.and.some((c: any) => c.field === "from")).toBe(true);
  });

  it("to 0xABCDEF123456789012345678901234567890ABCD over 5000", async () => {
    const r = parse("to 0xABCDEF123456789012345678901234567890ABCD over 5000");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.field === "to")).toBe(true);
    expect(p.and.some((c: any) => c.op === "gte" && c.value === toWei(5000))).toBe(true);
  });

  it("deposit over 100k", async () => {
    const r = parse("deposit over 100k");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.field === "eventName" && c.value === "Deposit")).toBe(true);
  });

  it("mint from 0xabc", async () => {
    const r = parse("mint from 0xaBCDef123456789012345678901234567890ABCD");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.field === "eventName" && c.value === "Mint")).toBe(true);
  });

  it("burn over 500", async () => {
    const r = parse("burn over 500");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.field === "eventName" && c.value === "Burn")).toBe(true);
  });

  it("rejects empty input", async () => {
    expect(() => parse("")).toThrow(ParseError);
  });

  it("handles 'k' suffix", async () => {
    const r = parse("whales over 50k TSLA");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.value === toWei(50000))).toBe(true);
  });

  it("handles 'm' suffix", async () => {
    const r = parse("whales over 2m TSLA");
    const p = r.predicate as any;
    expect(p.and.some((c: any) => c.value === toWei(2000000))).toBe(true);
  });

  it("handles NVDA ticker", async () => {
    const r = parse("whales over 10k NVDA");
    const p = r.predicate as any;
    expect(r.description).toContain("NVDA");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// HMAC / DELIVERY
// ═════════════════════════════════════════════════════════════════════════════

describe("HMAC verification", () => {
  it("valid signature passes", async () => {
    const secret = "test-secret";
    const body = JSON.stringify({ subId: "1", event: { value: "100" } });
    const { createHmac } = require("node:crypto");
    const sig = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifySignature(secret, body, sig)).toBe(true);
  });

  it("wrong secret fails", async () => {
    const body = JSON.stringify({ subId: "1" });
    const { createHmac } = require("node:crypto");
    const sig = createHmac("sha256", "real-secret").update(body).digest("hex");
    expect(verifySignature("wrong-secret", body, sig)).toBe(false);
  });

  it("tampered body fails", async () => {
    const secret = "test-secret";
    const { createHmac } = require("node:crypto");
    const sig = createHmac("sha256", secret).update("original").digest("hex");
    expect(verifySignature(secret, "tampered", sig)).toBe(false);
  });

  it("empty signature header returns false", async () => {
    expect(verifySignature("s", "", "")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SSRF / URL VALIDATION
// ═════════════════════════════════════════════════════════════════════════════

describe("URL validation", () => {
  it("allows public URLs", async () => {
    expect(validateWebhookUrl("https://webhook.site/abc")).toBe(true);
    expect(validateWebhookUrl("https://my-bot.fly.dev/hook")).toBe(true);
    expect(validateWebhookUrl("https://api.example.com:8080/path")).toBe(true);
  });

  it("blocks localhost and loopback", async () => {
    expect(validateWebhookUrl("http://localhost:3000")).toBe(false);
    expect(validateWebhookUrl("https://127.0.0.1/hook")).toBe(false);
    expect(validateWebhookUrl("http://127.0.0.2/")).toBe(false);
    expect(validateWebhookUrl("http://127.255.255.254/")).toBe(false);
    expect(validateWebhookUrl("http://0.0.0.0:8080")).toBe(false);
    expect(validateWebhookUrl("http://[::1]:3000")).toBe(false);
  });

  it("blocks full 169.254/16 link-local", async () => {
    expect(validateWebhookUrl("http://169.254.1.1/")).toBe(false);
    expect(validateWebhookUrl("http://169.254.255.254/")).toBe(false);
  });

  it("blocks CGNAT 100.64/10", async () => {
    expect(validateWebhookUrl("http://100.64.0.1/")).toBe(false);
    expect(validateWebhookUrl("http://100.127.255.254/")).toBe(false);
  });

  it("blocks IPv6 ULA and link-local", async () => {
    expect(validateWebhookUrl("http://[fd00::1]/")).toBe(false);
    expect(validateWebhookUrl("http://[fe80::1]/")).toBe(false);
  });

  it("blocks cloud metadata endpoint", async () => {
    expect(validateWebhookUrl("http://169.254.169.254/latest/meta-data")).toBe(false);
  });

  it("blocks 10.x range", async () => {
    expect(validateWebhookUrl("http://10.0.0.1:3000")).toBe(false);
    expect(validateWebhookUrl("http://10.255.255.255")).toBe(false);
  });

  it("blocks 172.16-31 range", async () => {
    expect(validateWebhookUrl("http://172.16.0.1")).toBe(false);
    expect(validateWebhookUrl("http://172.20.0.1")).toBe(false);
    expect(validateWebhookUrl("http://172.31.255.255")).toBe(false);
  });

  it("allows 172.15 and 172.32 (public)", async () => {
    expect(validateWebhookUrl("http://172.15.0.1")).toBe(true);
    expect(validateWebhookUrl("http://172.32.0.1")).toBe(true);
  });

  it("blocks 192.168 range", async () => {
    expect(validateWebhookUrl("http://192.168.1.1")).toBe(false);
    expect(validateWebhookUrl("http://192.168.255.255")).toBe(false);
  });

  it("blocks obfuscated decimal 127.0.0.1", async () => {
    expect(validateWebhookUrl("http://2130706433/")).toBe(false);
  });

  it("rejects non-http protocols", async () => {
    expect(validateWebhookUrl("ftp://evil.com")).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SUBSCRIPTION STORE
// ═════════════════════════════════════════════════════════════════════════════

describe("subscription store", () => {
  it("upserts and lists subscriptions", async () => {
    const store = new SubscriptionStore(":memory:");
    store.upsert({ subId: "1", predicate: { field: "x", op: "eq", value: "y" }, webhookUrl: "https://hook.site/1", hmacSecret: "s1", active: true });
    store.upsert({ subId: "2", predicate: { and: [{ field: "x", op: "gte", value: "100" }] }, webhookUrl: "https://hook.site/2", hmacSecret: "s2", active: true });

    const subs = store.listActive();
    expect(subs).toHaveLength(2);
  });

  it("deactivates subscription", async () => {
    const store = new SubscriptionStore(":memory:");
    store.upsert({ subId: "1", predicate: { field: "x", op: "eq", value: "y" }, webhookUrl: "https://hook.site/1", hmacSecret: "s1", active: true });
    store.deactivate("1");
    expect(store.listActive()).toHaveLength(0);
  });

  it("records deliveries with trace", async () => {
    const store = new SubscriptionStore(":memory:");
    store.recordDelivery("d1", "1", 200, 105, "0xtxhash", [
      { field: "eventName", op: "eq", expected: "Transfer", actual: "Transfer", matched: true },
    ]);
    const deliveries = store.recentDeliveries(10);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].delivery_id).toBe("d1");
  });

  it("predicateHash is deterministic", async () => {
    const p: Predicate = { field: "x", op: "eq", value: "y" };
    expect(predicateHash(p)).toBe(predicateHash(p));
  });

  it("webhookHash is deterministic", async () => {
    expect(webhookHash("https://a.b")).toBe(webhookHash("https://a.b"));
  });
});
