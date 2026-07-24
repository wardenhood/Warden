/**
 * Workspace server for Warden Pro.
 * Serves the visual workspace (plain-English parser, dry-run, live feed)
 * and also the original dashboard at /dashboard.
 *
 * Usage:
 *   cd workspace && npm install express && DB_PATH=../matcher/warden.db node server.mjs
 */

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.WORKSPACE_PORT ?? 4000;

const app = express();

// Landing page
// ── Static files ─────────────────────────────────────────────────────────
// Prevent Cloudflare CDN from caching HTML (JS/CSS can still cache)
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/" || req.path.endsWith("/")) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});
app.use(express.static(path.join(__dirname, "..", "web")));

// Redirect /docs to docs.html for clean URLs
app.get("/docs", (_req, res) => res.redirect("/docs.html"));

// Static files for workspace
app.use("/app", express.static(__dirname));

// ── predicate API (calls matcher parser if available) ──
app.post("/api/parse", express.json(), async (req, res) => {
  try {
    const { parse } = await import("../matcher/dist/ai-parser.js");
    const result = parse(req.body.text);
    res.json(result);
  } catch (e) {
    // Fallback: return error so frontend uses its own parser
    res.json({ error: "Matcher parser not available. Using client-side parser." });
  }
});

// ── proxy to dashboard API if running ──
app.get("/api/deliveries", async (_req, res) => {
  try {
    // Try to load deliveries directly from SQLite
    const Database = (await import("better-sqlite3")).default;
    const DB_PATH = process.env.DB_PATH ?? "./matcher/warden.db";
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: false });
    const rows = db.prepare(
      `SELECT delivery_id, sub_id, status, latency_ms, tx_hash, trace_json, created_at
       FROM deliveries ORDER BY created_at DESC LIMIT 25`
    ).all();
    db.close();
    res.json(rows);
  } catch {
    res.json([]);
  }
});

app.get("/api/stats", async (_req, res) => {
  try {
    const Database = (await import("better-sqlite3")).default;
    const DB_PATH = process.env.DB_PATH ?? "./matcher/warden.db";
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: false });
    const activeSubs = (db.prepare(`SELECT COUNT(*) as n FROM subscriptions WHERE active = 1`).get()).n;
    const totalDeliveries = (db.prepare(`SELECT COUNT(*) as n FROM deliveries`).get()).n;
    const successCount = (db.prepare(`SELECT COUNT(*) as n FROM deliveries WHERE status >= 200 AND status < 300`).get()).n;
    db.close();
    res.json({
      activeSubs,
      totalDeliveries,
      successRate: totalDeliveries ? Math.round((successCount / totalDeliveries) * 1000) / 10 : null,
    });
  } catch {
    res.json({ activeSubs: 0, totalDeliveries: 0, successRate: null });
  }
});

// Dashboard static files (same as original)
app.use("/dashboard", express.static(path.join(__dirname, "..", "dashboard", "public")));

// ── SSE endpoint (proxies to matcher's /sse — real proxy, not redirect) ────
const MATCHER_SSE_URL = process.env.MATCHER_SSE_URL || "http://matcher:9090/sse";
app.get("/sse", async (req, res) => {
  try {
    const upstream = await fetch(MATCHER_SSE_URL + (req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : ""));
    if (!upstream.ok || !upstream.body) {
      res.status(502).json({ error: "SSE upstream unavailable" });
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Pipe the upstream SSE stream directly to the client
    const reader = upstream.body.getReader();
    req.on("close", () => reader.cancel());
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch {
    if (res.headersSent) { res.end(); return; }
    res.status(502).json({ error: "SSE upstream unreachable. Is the matcher running?" });
  }
});

// ── API endpoints (for landing page live feed) ──────────────────────────────
app.get("/api/stats", (_req, res) => {
  res.json({ deliveries: 0, activeSubs: 0, successRate: 0, p50Latency: 0 });
});

app.get("/api/deliveries", (_req, res) => {
  res.json([]);
});

app.listen(PORT, () => {
  console.log(`[workspace] http://localhost:${PORT} — Warden Pro workspace`);
  console.log(`[workspace] /dashboard — original status dashboard`);
});
