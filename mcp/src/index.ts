/**
 * Warden MCP server. Exposes on-chain event tools to any MCP client.
 *
 * Split design:
 *   - read-only tools (recent_deliveries, parse_predicate, sandbox) → safe to host
 *   - signing tools (subscribe, list, cancel) → local stdio only (needs private key)
 *
 * Any MCP client works: Claude, Cursor, Windsurf, Cline, VS Code, Codex.
 *
 * Hosted:   claude mcp add --transport http warden https://your-host/mcp
 * Local:    cd mcp && npm run build && claude mcp add --transport stdio warden -- node dist/index.js
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ethers } from "ethers";
import escrowAbi from "../../matcher/abi/StreamEscrow.json" with { type: "json" };
import { predicateHash, webhookHash, SubscriptionStore } from "../../matcher/src/subscriptions.js";
import { validatePredicate, type Predicate } from "../../matcher/src/predicate.js";
import { parse } from "../../matcher/src/ai-parser.js";
import { validateWebhookUrl } from "../../matcher/src/delivery.js";

const RHC_HTTP_URL = process.env.RHC_HTTP_URL ?? "https://rhc-mainnet.example-rpc.com";
const ESCROW_ADDRESS = process.env.ESCROW_ADDRESS ?? "";
const USER_PRIVATE_KEY = process.env.USER_PRIVATE_KEY; // only present in local stdio server

const store = new SubscriptionStore(process.env.DB_PATH ?? "./warden.db");
const provider = new ethers.JsonRpcProvider(RHC_HTTP_URL);

const server = new McpServer({ name: "warden", version: "0.2.0" });

// ═════════════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════════════

server.registerTool(
  "recent_deliveries",
  {
    title: "Recent deliveries",
    description: "List the most recent matched-event deliveries with webhook status, latency, and match trace.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
  },
  async ({ limit }) => {
    const rows = store.recentDeliveries(limit ?? 10);
    // Enrich with full delivery details including trace
    const enriched = rows.map((r: any) => ({
      delivery_id: r.delivery_id,
      sub_id: r.sub_id,
      status: r.status,
      latency_ms: r.latency_ms,
      tx_hash: r.tx_hash,
      trace: r.trace_json ? JSON.parse(r.trace_json) : null,
      created_at: r.created_at,
    }));
    return { content: [{ type: "text", text: JSON.stringify(enriched, null, 2) }] };
  }
);

server.registerTool(
  "parse_predicate",
  {
    title: "Parse plain English to predicate",
    description: "Convert a natural-language description into a Warden JSON predicate. No LLM — offline rule-based parser.",
    inputSchema: { text: z.string().describe("Plain English description, e.g. 'whales over 100k TSLA'") },
  },
  async ({ text }) => {
    const result = parse(text);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          description: result.description,
          predicate: result.predicate,
          suggestions: result.suggestions,
        }, null, 2),
      }],
    };
  }
);

server.registerTool(
  "warden_sandbox_dispatch",
  {
    title: "Sandbox dispatch",
    description: "Fire a fake HMAC-signed event at a test webhook with zero on-chain cost. Useful for verifying webhook setup.",
    inputSchema: { webhookUrl: z.string().url() },
  },
  async ({ webhookUrl }) => {
    if (!validateWebhookUrl(webhookUrl)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid or blocked webhook URL" }) }] };
    }
    const { deliverWebhook } = await import("../../matcher/src/delivery.js");
    const result = await deliverWebhook(webhookUrl, "sandbox-secret", "sandbox", {
      note: "This is a sandbox event, no on-chain cost.",
      sampleField: "amount",
      sampleValue: "1000000000000000000",
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// SIGNING TOOLS (local stdio server only — needs USER_PRIVATE_KEY)
// ═════════════════════════════════════════════════════════════════════════════

if (USER_PRIVATE_KEY) {
  const wallet = new ethers.Wallet(USER_PRIVATE_KEY, provider);
  const escrow = new ethers.Contract(ESCROW_ADDRESS, escrowAbi, wallet);

  server.registerTool(
    "subscribe_to_events",
    {
      title: "Subscribe to events",
      description: "Lock ETH and register a predicate + webhook. Supports plain English (ai) or raw JSON predicate.",
      inputSchema: {
        ai: z.string().optional().describe("Plain English description (e.g. 'whales over 100k TSLA')"),
        predicate: z.record(z.any()).optional().describe("Raw JSON predicate"),
        webhookUrl: z.string().url(),
        amountEth: z.string(),
      },
    },
    async ({ ai, predicate: rawPredicate, webhookUrl, amountEth }) => {
      let predicate: Predicate;
      if (ai) {
        const result = parse(ai);
        predicate = result.predicate;
      } else if (rawPredicate) {
        predicate = rawPredicate as Predicate;
      } else {
        throw new Error("Either 'ai' or 'predicate' is required");
      }

      validatePredicate(predicate);
      const pHash = predicateHash(predicate);
      const wHash = webhookHash(webhookUrl);
      const tx = await escrow.subscribe(pHash, wHash, { value: ethers.parseEther(amountEth) });
      const receipt = await tx.wait();

      const parsed = receipt.logs
        .map((l: any) => { try { return escrow.interface.parseLog(l); } catch { return null; } })
        .find((l: any) => l?.name === "Subscribed");
      const subId = parsed?.args?.subId?.toString();

      store.upsert({
        subId,
        predicate,
        webhookUrl,
        hmacSecret: ethers.hexlify(ethers.randomBytes(16)),
        active: true,
      });

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ subId, txHash: receipt.hash, amountEth }, null, 2),
        }],
      };
    }
  );

  server.registerTool(
    "list_subscriptions",
    {
      title: "List subscriptions",
      description: "Show your active subscriptions.",
      inputSchema: {},
    },
    async () => {
      const subs = store.listActive();
      // Redact hmacSecret before returning to client
      const safe = subs.map(({ hmacSecret, ...rest }) => rest);
      return { content: [{ type: "text", text: JSON.stringify(safe, null, 2) }] };
    }
  );

  server.registerTool(
    "cancel_subscription",
    {
      title: "Cancel subscription",
      description: "Cancel a subscription on-chain and refund the remaining escrow balance.",
      inputSchema: { subId: z.string() },
    },
    async ({ subId }) => {
      const tx = await escrow.cancel(subId);
      const receipt = await tx.wait();
      store.deactivate(subId);
      return { content: [{ type: "text", text: JSON.stringify({ subId, txHash: receipt.hash }, null, 2) }] };
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
