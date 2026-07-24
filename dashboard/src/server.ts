/**
 * Lightweight read-only API for the status dashboard. Reads the same
 * SQLite store the matcher writes to (warden.db) — no separate database,
 * no write endpoints, so this is safe to expose publicly.
 */
import "dotenv/config";
import express from "express";
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH ?? "../matcher/warden.db";
const PORT = process.env.DASHBOARD_PORT ?? 4322;

const app = express();
app.use(express.static(path.join(__dirname, "..", "public")));

function getDb(): Database.Database | null {
  try {
    return new Database(DB_PATH, { readonly: true, fileMustExist: true });
  } catch {
    return null; // matcher hasn't started / written anything yet
  }
}

app.get("/api/stats", (_req, res) => {
  const db = getDb();
  if (!db) return res.json({ activeSubs: 0, totalDeliveries: 0, successRate: null, p50LatencyMs: null });

  const activeSubs = (db.prepare(`SELECT COUNT(*) as n FROM subscriptions WHERE active = 1`).get() as any).n;
  const totalDeliveries = (db.prepare(`SELECT COUNT(*) as n FROM deliveries`).get() as any).n;
  const successCount = (
    db.prepare(`SELECT COUNT(*) as n FROM deliveries WHERE status >= 200 AND status < 300`).get() as any
  ).n;
  const latencies = (db.prepare(`SELECT latency_ms FROM deliveries ORDER BY latency_ms`).all() as any[]).map(
    (r) => r.latency_ms
  );
  const p50 = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;

  db.close();
  res.json({
    activeSubs,
    totalDeliveries,
    successRate: totalDeliveries ? Math.round((successCount / totalDeliveries) * 1000) / 10 : null,
    p50LatencyMs: p50,
  });
});

app.get("/api/deliveries", (req, res) => {
  const rawLimit = Number(req.query.limit ?? 20);
  const limit = Math.min(Number.isNaN(rawLimit) ? 20 : rawLimit, 100);
  const db = getDb();
  if (!db) return res.json([]);
  const rows = db
    .prepare(`SELECT delivery_id, sub_id, status, latency_ms, tx_hash, trace_json, created_at FROM deliveries ORDER BY created_at DESC LIMIT ?`)
    .all(limit);
  db.close();
  res.json(rows);
});

app.listen(PORT, () => {
  console.log(`[dashboard] api listening on :${PORT}`);
});
