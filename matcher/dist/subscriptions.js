/**
 * Subscription store. Keeps the plaintext predicate + webhook URL (the chain
 * only stores their keccak256 hashes for privacy — see StreamEscrow.sol).
 * Swap this for Postgres/Redis in production; SQLite is plenty for v0.1.
 *
 * Pro: added trace_json column for click-to-explain match traces.
 */
import Database from "better-sqlite3";
import { ethers } from "ethers";
export function predicateHash(predicate) {
    return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(predicate)));
}
export function webhookHash(webhookUrl) {
    return ethers.keccak256(ethers.toUtf8Bytes(webhookUrl));
}
export class SubscriptionStore {
    db;
    constructor(dbPath = "./warden.db") {
        this.db = new Database(dbPath);
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        sub_id TEXT PRIMARY KEY,
        predicate_json TEXT NOT NULL,
        webhook_url TEXT NOT NULL,
        hmac_secret TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        sub_id TEXT NOT NULL,
        status INTEGER,
        latency_ms INTEGER,
        tx_hash TEXT,
        trace_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
        // migrate: add trace_json column if upgrading from v0.1
        try {
            this.db.exec(`ALTER TABLE deliveries ADD COLUMN trace_json TEXT`);
        }
        catch { /* column already exists */ }
    }
    upsert(sub) {
        this.db
            .prepare(`INSERT INTO subscriptions (sub_id, predicate_json, webhook_url, hmac_secret, active)
         VALUES (@subId, @predicateJson, @webhookUrl, @hmacSecret, @active)
         ON CONFLICT(sub_id) DO UPDATE SET
           predicate_json = excluded.predicate_json,
           webhook_url = excluded.webhook_url,
           hmac_secret = excluded.hmac_secret,
           active = excluded.active`)
            .run({
            subId: sub.subId,
            predicateJson: JSON.stringify(sub.predicate),
            webhookUrl: sub.webhookUrl,
            hmacSecret: sub.hmacSecret,
            active: sub.active ? 1 : 0,
        });
    }
    deactivate(subId) {
        this.db.prepare(`UPDATE subscriptions SET active = 0 WHERE sub_id = ?`).run(subId);
    }
    /** Get a subscription regardless of active state (for replay). */
    getAny(subId) {
        const r = this.db.prepare(`SELECT * FROM subscriptions WHERE sub_id = ?`).get(subId);
        if (!r)
            return null;
        return {
            subId: r.sub_id,
            predicate: JSON.parse(r.predicate_json),
            webhookUrl: r.webhook_url,
            hmacSecret: r.hmac_secret,
            active: !!r.active,
        };
    }
    listActive() {
        const rows = this.db.prepare(`SELECT * FROM subscriptions WHERE active = 1`).all();
        return rows.map((r) => ({
            subId: r.sub_id,
            predicate: JSON.parse(r.predicate_json),
            webhookUrl: r.webhook_url,
            hmacSecret: r.hmac_secret,
            active: !!r.active,
        }));
    }
    recordDelivery(deliveryId, subId, status, latencyMs, txHash, trace) {
        this.db
            .prepare(`INSERT INTO deliveries (delivery_id, sub_id, status, latency_ms, tx_hash, trace_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`)
            .run(deliveryId, subId, status ?? null, latencyMs, txHash ?? null, trace ? JSON.stringify(trace) : null, new Date().toISOString());
    }
    recentDeliveries(limit = 10) {
        return this.db
            .prepare(`SELECT * FROM deliveries ORDER BY created_at DESC LIMIT ?`)
            .all(limit);
    }
    /** Get a single delivery with its trace for click-to-explain. */
    getDelivery(deliveryId) {
        return this.db
            .prepare(`SELECT * FROM deliveries WHERE delivery_id = ?`)
            .get(deliveryId);
    }
}
