/**
 * Delivery layer: pushes a matched event to a subscriber's webhook.
 * HMAC-signed, idempotency-keyed, retried with backoff (1s, 4s, 16s).
 *
 * SSRF protection, two layers:
 *   Layer 1 (validateWebhookUrl) — fast reject of literal hostnames/IPs that are
 *     obviously private/internal. Cheap, synchronous, used as an early filter
 *     (e.g. when a user first registers a webhook).
 *   Layer 2 (pinnedRequest)      — the real guarantee. Resolves DNS exactly ONCE
 *     per connection attempt, validates the resolved IP, then connects directly
 *     to that IP (never re-resolving). This is what actually stops DNS-rebinding:
 *     Layer 1 alone can't, because a hostname that looks public at validation time
 *     can be repointed to an internal IP by the time the real request is made.
 */
import { createHmac, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];
const REQUEST_TIMEOUT_MS = 10_000;
/**
 * Escape hatch for E2E testing ONLY.
 * When true, validateWebhookUrl() skips all SSRF checks so local webhook
 * receivers work. DO NOT set this in production — it disables SSRF entirely.
 */
const ALLOW_LOCAL_WEBHOOKS = process.env.WARDEN_ALLOW_LOCAL_WEBHOOKS === "true";
function sign(secret, body) {
    return createHmac("sha256", secret).update(body).digest("hex");
}
// ── IP-range blocklist (shared by both layers) ──────────────────────────────
function isBlockedIPv4(ip) {
    const octets = ip.split(".").map(Number);
    if (octets.length !== 4 || octets.some((n) => Number.isNaN(n) || n < 0 || n > 255))
        return false;
    const [a, b] = octets;
    if (a === 127)
        return true; // 127.0.0.0/8 loopback
    if (a === 10)
        return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31)
        return true; // 172.16.0.0/12
    if (a === 192 && b === 168)
        return true; // 192.168.0.0/16
    if (a === 169 && b === 254)
        return true; // 169.254.0.0/16 link-local + metadata
    if (a === 100 && b >= 64 && b <= 127)
        return true; // 100.64.0.0/10 CGNAT
    if (a === 0)
        return true; // 0.0.0.0/8 ("this network")
    return false;
}
function isBlockedIPv6(ip) {
    const v = ip.toLowerCase();
    if (v === "::1" || v === "::" || v === "0:0:0:0:0:0:0:0" || v === "0:0:0:0:0:0:0:1")
        return true; // loopback / unspecified
    if (v.startsWith("fc") || v.startsWith("fd"))
        return true; // fc00::/7 ULA
    if (/^fe[89ab][0-9a-f]?:/.test(v) || /^fe[89ab]$/.test(v))
        return true; // fe80::/10 link-local
    // IPv4-mapped / IPv4-compatible IPv6 — unwrap and re-check as IPv4.
    // Handles both "::ffff:1.2.3.4" and the fully-expanded hex form.
    let mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v);
    if (!mapped)
        mapped = /^0:0:0:0:0:ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(v);
    if (mapped)
        return isBlockedIPv4(mapped[1]);
    const hexMapped = /^(?:0:){5}ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v)
        || /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(v);
    if (hexMapped) {
        const hi = parseInt(hexMapped[1], 16), lo = parseInt(hexMapped[2], 16);
        const ipv4 = [(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255].join(".");
        return isBlockedIPv4(ipv4);
    }
    return false;
}
function isBlockedIP(ip) {
    return ip.includes(":") ? isBlockedIPv6(ip) : isBlockedIPv4(ip);
}
// ── Layer 1: literal-hostname pre-filter ────────────────────────────────────
/** Fast reject of obviously-private literal hosts. Not sufficient on its own — see pinnedRequest(). */
export function validateWebhookUrl(url) {
    // Bypass for E2E testing only — DO NOT enable in production
    if (ALLOW_LOCAL_WEBHOOKS)
        return true;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
            return false;
        let hostname = parsed.hostname;
        if (hostname === "localhost")
            return false;
        // Normalize obfuscated single-integer IP formats (decimal, hex, octal) to dotted quad.
        const numericMatch = /^0x[0-9a-f]+$|^0[0-7]+$|^\d+$/i.exec(hostname);
        if (numericMatch && !hostname.includes(".")) {
            try {
                const base = /^0x/i.test(hostname) ? 16 : (hostname.startsWith("0") && hostname !== "0" ? 8 : 10);
                const ip = parseInt(hostname, base);
                if (Number.isFinite(ip) && ip >= 0) {
                    hostname = [(ip >>> 24) & 255, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join(".");
                }
            }
            catch { /* leave as-is */ }
        }
        if (hostname.startsWith("[")) {
            const ipv6 = hostname.slice(1, -1);
            if (isBlockedIPv6(ipv6))
                return false;
        }
        else if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
            if (isBlockedIPv4(hostname))
                return false;
        }
        // Anything else is a hostname — Layer 2 (DNS-pinned connect) is what actually
        // validates it, since a hostname's resolved IP can change between now and connect time.
        return true;
    }
    catch {
        return false;
    }
}
// ── Layer 2: DNS-pinned request — resolves once, connects to exactly that IP ─
class SsrfBlockedError extends Error {
}
function pinnedRequest(urlStr, opts) {
    return new Promise(async (resolve, reject) => {
        let url;
        try {
            url = new URL(urlStr);
        }
        catch (e) {
            reject(e);
            return;
        }
        if (url.protocol !== "https:" && url.protocol !== "http:") {
            reject(new SsrfBlockedError("protocol not allowed"));
            return;
        }
        // Resolve DNS exactly once for this attempt, and connect directly to the
        // resulting IP — never let Node re-resolve the hostname itself, or a
        // rebinding attacker could swap the answer between check and connect.
        let address;
        try {
            const result = await dnsLookup(url.hostname, { family: 0 });
            address = result.address;
        }
        catch {
            reject(new SsrfBlockedError("DNS resolution failed"));
            return;
        }
        if (isBlockedIP(address)) {
            reject(new SsrfBlockedError(`resolved to blocked IP: ${address}`));
            return;
        }
        const mod = url.protocol === "https:" ? https : http;
        const req = mod.request({
            hostname: address, // connect straight to the pinned, validated IP
            servername: url.protocol === "https:" ? url.hostname : undefined, // correct SNI/cert check
            port: url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80),
            path: url.pathname + url.search,
            method: opts.method,
            headers: { ...opts.headers, Host: url.hostname },
            timeout: opts.timeoutMs,
        }, (res) => {
            res.resume(); // drain body — we don't need it
            const status = res.statusCode ?? 0;
            resolve({ ok: status >= 200 && status < 300, status });
        });
        req.on("timeout", () => req.destroy(new Error("request timeout")));
        req.on("error", reject);
        req.write(opts.body);
        req.end();
    });
}
export async function deliverWebhook(webhookUrl, hmacSecret, subId, event) {
    // E2E/dev bypass — skip ALL SSRF layers, direct HTTP call
    if (ALLOW_LOCAL_WEBHOOKS) {
        const deliveryId = randomUUID();
        const payload = { subId, deliveryId, matchedAt: new Date().toISOString(), event };
        const body = JSON.stringify(payload);
        const signature = sign(hmacSecret, body);
        const start = Date.now();
        try {
            const res = await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Warden-Idempotency-Key": deliveryId, "X-Warden-Sub-Id": subId, "X-Warden-Signature": signature },
                body,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            return { ok: res.ok, status: res.status, attempts: 1, latencyMs: Date.now() - start, deliveryId };
        }
        catch {
            return { ok: false, status: 0, attempts: 1, latencyMs: Date.now() - start, deliveryId };
        }
    }
    // Layer 1 guard — cheap early reject, also covers junk/malformed URLs.
    if (!validateWebhookUrl(webhookUrl)) {
        return { ok: false, status: 403, attempts: 0, latencyMs: 0, deliveryId: "" };
    }
    const deliveryId = randomUUID();
    const payload = {
        subId,
        deliveryId,
        matchedAt: new Date().toISOString(),
        event,
    };
    const body = JSON.stringify(payload);
    const signature = sign(hmacSecret, body);
    const start = Date.now();
    let attempts = 0;
    for (const delay of [0, ...RETRY_DELAYS_MS]) {
        if (delay > 0)
            await new Promise((r) => setTimeout(r, delay));
        attempts++;
        try {
            const res = await pinnedRequest(webhookUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Warden-Idempotency-Key": deliveryId,
                    "X-Warden-Sub-Id": subId,
                    "X-Warden-Signature": signature,
                },
                body,
                timeoutMs: REQUEST_TIMEOUT_MS,
            });
            if (res.ok) {
                return { ok: true, status: res.status, attempts, latencyMs: Date.now() - start, deliveryId };
            }
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                return { ok: false, status: res.status, attempts, latencyMs: Date.now() - start, deliveryId };
            }
            // 3xx (no auto-follow — we never trust a redirect target without re-validating
            // it through this same pinned-DNS path) and 5xx/429 fall through to retry.
        }
        catch (e) {
            if (e instanceof SsrfBlockedError) {
                // Resolved to a blocked destination — do not retry, it won't get safer.
                return { ok: false, status: 403, attempts, latencyMs: Date.now() - start, deliveryId };
            }
            // network error — fall through to retry
        }
    }
    return { ok: false, attempts, latencyMs: Date.now() - start, deliveryId };
}
/** Reference verifier — subscribers run this on their own endpoint to check X-Warden-Signature. */
export function verifySignature(secret, rawBody, signatureHeader) {
    const expected = sign(secret, rawBody);
    if (expected.length !== signatureHeader.length)
        return false;
    let diff = 0;
    for (let i = 0; i < expected.length; i++)
        diff |= expected.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
    return diff === 0;
}
