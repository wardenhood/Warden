/**
 * @warden/client — TypeScript SDK for Warden on Robinhood Chain.
 *
 * Install:
 *   npm install @warden/client
 *
 * Usage:
 *   import { Warden, verifySignature } from "@warden/client";
 *
 *   const warden = new Warden({ rpcUrl: "...", escrowAddress: "...", privateKey: "..." });
 *
 *   // Subscribe with a plain-English description
 *   const sub = await warden.subscribe({
 *     ai: "whales over 100k TSLA",
 *     webhookUrl: "https://webhook.site/xxx",
 *     amountEth: "0.05",
 *   });
 *
 *   // OR with a JSON predicate
 *   const sub2 = await warden.subscribe({
 *     predicate: { and: [{ field: "value", op: "gte", value: "1000000000000000000000" }] },
 *     webhookUrl: "https://webhook.site/xxx",
 *     amountEth: "0.1",
 *   });
 *
 *   // Verify incoming webhook signature
 *   app.post("/hook", (req, res) => {
 *     const valid = verifySignature(secret, JSON.stringify(req.body), req.headers["x-warden-signature"]);
 *     if (!valid) return res.status(401).end();
 *     // process event...
 *   });
 */

import { createHmac, randomUUID } from "node:crypto";
import { safeFetch, validateWebhookUrl as validateUrl } from "../../matcher/src/ssrf-guard.js";

// ── Types ───────────────────────────────────────────────────────────────────

export type Op =
  | "eq" | "neq" | "gte" | "lte" | "gt" | "lt"
  | "in" | "not_in" | "contains" | "starts_with" | "ends_with" | "regex";

export interface Condition {
  field: string;
  op: Op;
  value: string | number | (string | number)[];
}

export interface Predicate {
  and?: Predicate[];
  or?: Predicate[];
  field?: string;
  op?: Op;
  value?: string | number | (string | number)[];
}

export interface SubscribeOptions {
  /** Plain-English description (e.g. "whales over 100k TSLA") */
  ai?: string;
  /** Explicit JSON predicate */
  predicate?: Predicate;
  /** Webhook URL to receive matched events */
  webhookUrl: string;
  /** Amount of ETH to lock in escrow */
  amountEth: string;
  /** Optional HMAC secret (auto-generated if not set) */
  hmacSecret?: string;
}

export interface Subscription {
  subId: string;
  txHash: string;
  predicate: Predicate;
  webhookUrl: string;
  hmacSecret: string;
  amountEth: string;
}

export interface WardenConfig {
  /** RHC HTTP RPC URL */
  rpcUrl: string;
  /** Deployed StreamEscrow contract address */
  escrowAddress: string;
  /** Subscriber private key (never share this with hosted services) */
  privateKey: string;
}

export interface DeliveryPayload {
  subId: string;
  deliveryId: string;
  matchedAt: string;
  event: Record<string, unknown>;
}

export interface DeliveryResult {
  ok: boolean;
  status?: number;
  attempts: number;
  latencyMs: number;
  deliveryId: string;
}

// ── AI Parser (client-side, no server dependency) ───────────────────────────

const TOKEN_TICKERS: Record<string, string> = {
  tsla: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  aapl: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  nvda: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  amzn: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  msft: "0xe93237C50D904957Cf27E7B1133b510C669c2e74",
  googl: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  meta: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35",
  mstr: "0xec262a75e413fAfD0dF80480274532C79D42da09",
  spy: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C",
  qcom: "0x0f17206447090e464C277571124dD2688E48AEA9",
};

const SUFFIXES: Record<string, number> = {
  k: 1_000, m: 1_000_000, b: 1_000_000_000,
};

function parseNumberPhrase(raw: string): number | null {
  const s = raw.toLowerCase().replace(/_/g, "").replace(/,/g, "").trim();
  for (const [sfx, mult] of Object.entries(SUFFIXES)) {
    const m = new RegExp(`^([\\d.]+)\\s*${sfx}$`).exec(s);
    if (m) return parseFloat(m[1]) * mult;
  }
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

function toWeiLike(n: number): string {
  return String(BigInt(Math.floor(n)) * BigInt(10 ** 18));
}

function findTicker(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [t, addr] of Object.entries(TOKEN_TICKERS)) {
    if (lower.includes(t)) return addr;
  }
  return null;
}

function detectEvent(text: string): string {
  const patterns: [RegExp, string][] = [
    [/\bswap\b/, "Swap"], [/\bliquidation\b/, "Liquidation"],
    [/\bdeposit\b/, "Deposit"], [/\bwithdraw(al)?\b/, "Withdrawal"],
    [/\bmint\b/, "Mint"], [/\bburn\b/, "Burn"],
    [/\btransfer\b/, "Transfer"], [/\bwhales?\b/, "Transfer"],
  ];
  for (const [re, name] of patterns) {
    if (re.test(text.toLowerCase())) return name;
  }
  return "Transfer";
}

export function parse(input: string): Predicate {
  const raw = input.trim();
  if (!raw) throw new Error("Empty input");

  const ticker = findTicker(raw);
  const eventName = detectEvent(raw);
  const address = /0x[a-fA-F0-9]{40}/.exec(raw)?.[0]?.toLowerCase();

  let op: string | null = null;
  let amount: number | null = null;
  const overMatch = /(over|above|more than|≥|>=)\s*([\d.]+[kmb]?)/i.exec(raw);
  const underMatch = /(under|below|less than|≤|<=)\s*([\d.]+[kmb]?)/i.exec(raw);
  if (overMatch) { op = "gte"; amount = parseNumberPhrase(overMatch[2]); }
  else if (underMatch) { op = "lte"; amount = parseNumberPhrase(underMatch[2]); }

  const conds: Condition[] = [{ field: "eventName", op: "eq", value: eventName }];
  if (ticker) conds.push({ field: "address", op: "eq", value: ticker });

  const fromMatch = /\b(from|out of|sender)\b/i.test(raw);
  const toMatch = /\b(to|into|recipient)\b/i.test(raw);

  if ((fromMatch || toMatch) && address) {
    conds.push({ field: fromMatch ? "from" : "to", op: "eq", value: address });
  } else if (address && !fromMatch && !toMatch) {
    conds.push({ field: eventName === "Transfer" ? "to" : "from", op: "eq", value: address });
  }

  if (op && amount !== null) {
    conds.push({ field: "value", op: op as Op, value: toWeiLike(amount) });
  }

  return conds.length === 1 ? conds[0] as Predicate : { and: conds as Predicate[] };
}

// ── HMAC Verification ──────────────────────────────────────────────────────

function hmacSign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

export function verifySignature(secret: string, rawBody: string, signatureHeader: string): boolean {
  if (!signatureHeader) return false;
  const expected = hmacSign(secret, rawBody);
  if (expected.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  return diff === 0;
}

// ── Warden Client ───────────────────────────────────────────────────────────

export class Warden {
  private config: WardenConfig;

  constructor(config: WardenConfig) {
    this.config = config;
  }

  /**
   * Create a subscription.
   *
   * Uses ethers.js (brought in by the host project) to sign the on-chain
   * subscribe transaction, then returns the subscription details.
   *
   * Requires the host project to have ethers installed as a peer dependency.
   */
  async subscribe(opts: SubscribeOptions): Promise<Subscription> {
    // Dynamically import ethers (peer dependency of the host project)
    const { ethers } = await import("ethers");

    const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    const wallet = new ethers.Wallet(this.config.privateKey, provider);

    const escrowAbi = [
      "function subscribe(bytes32 predicateHash, bytes32 webhookHash) payable returns (uint256)",
      "event Subscribed(uint256 indexed subId, address indexed subscriber, bytes32 predicateHash, bytes32 webhookHash, uint256 amount)",
    ];
    const escrow = new ethers.Contract(this.config.escrowAddress, escrowAbi, wallet);

    // Resolve predicate
    let predicate: Predicate;
    if (opts.ai) {
      predicate = parse(opts.ai);
    } else if (opts.predicate) {
      predicate = opts.predicate;
    } else {
      throw new Error("Either 'ai' or 'predicate' is required");
    }

    const pHash = ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(predicate)));
    const wHash = ethers.keccak256(ethers.toUtf8Bytes(opts.webhookUrl));
    const hmacSecret = opts.hmacSecret ?? ethers.hexlify(ethers.randomBytes(16));

    const tx = await escrow.subscribe(pHash, wHash, {
      value: ethers.parseEther(opts.amountEth),
    });
    const receipt = await tx.wait();

    const parsed = receipt.logs
      .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
      .find((l: any) => l?.name === "Subscribed");
    const subId = parsed?.args?.subId?.toString();

    return {
      subId,
      txHash: receipt.hash,
      predicate,
      webhookUrl: opts.webhookUrl,
      hmacSecret,
      amountEth: opts.amountEth,
    };
  }

  /**
   * Cancel a subscription and get remaining ETH refunded.
   */
  async cancel(subId: string): Promise<string> {
    const { ethers } = await import("ethers");
    const provider = new ethers.JsonRpcProvider(this.config.rpcUrl);
    const wallet = new ethers.Wallet(this.config.privateKey, provider);
    const escrowAbi = ["function cancel(uint256 subId)"];
    const escrow = new ethers.Contract(this.config.escrowAddress, escrowAbi, wallet);
    const tx = await escrow.cancel(subId);
    await tx.wait();
    return tx.hash;
  }

  /**
   * Deliver a mock event to a webhook for testing (zero on-chain cost).
   */
  async sandbox(webhookUrl: string, count = 1): Promise<DeliveryResult[]> {
    try { await validateUrl(webhookUrl); } catch { return [{ ok: false, status: 403, attempts: 0, latencyMs: 0, deliveryId: "" }]; }
    const results: DeliveryResult[] = [];
    for (let i = 0; i < count; i++) {
      const deliveryId = randomUUID();
      const payload: DeliveryPayload = {
        subId: "sandbox",
        deliveryId,
        matchedAt: new Date().toISOString(),
        event: {
          note: `Sandbox event ${i + 1}/${count}`,
          sampleTransfer: { from: "0xSender", to: "0xRecipient", value: "1000000000000000000" },
        },
      };
      const body = JSON.stringify(payload);
      const signature = hmacSign("sandbox-secret", body);
      const start = Date.now();

      try {
        const res = await safeFetch(webhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Warden-Idempotency-Key": deliveryId,
            "X-Warden-Sub-Id": "sandbox",
            "X-Warden-Signature": signature,
          },
          body,
        });
        results.push({ ok: res.status >= 200 && res.status < 300, status: res.status, attempts: 1, latencyMs: Date.now() - start, deliveryId });
      } catch {
        results.push({ ok: false, attempts: 1, latencyMs: Date.now() - start, deliveryId });
      }
    }
    return results;
  }
}
