/**
 * ssrf-guard.ts
 * -------------------------------------------------------------------------
 * Drop-in replacement for the SSRF-guard logic in `sdk/src/index.ts`
 * (@warden/client). This closes the same two bug classes already fixed in
 * `matcher/src/delivery.ts`, but that never got propagated here:
 *
 *   1. Incomplete IP-range blocklist (missing CGNAT 100.64.0.0/10, and the
 *      IPv6 equivalents: loopback ::1, link-local fe80::/10, unique-local
 *      fc00::/7, IPv4-mapped ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d).
 *   2. TOCTOU / DNS-rebinding: the old code validated the *hostname* but
 *      let `fetch()` do its own DNS resolution afterwards, so an attacker
 *      could point a domain at a public IP during validation and rebind
 *      it to 169.254.169.254 (or similar) by the time the request fires.
 *      It also followed redirects with zero re-validation, so
 *      `http://attacker.com/` returning `Location: http://127.0.0.1/`
 *      sailed straight through.
 *
 * Fix strategy:
 *   - Resolve DNS ourselves, validate *every* returned address, then pin
 *     the connection to the address we validated (via a custom `lookup`
 *     passed to Node's http/https `request`) so nothing can re-resolve
 *     between check-time and connect-time.
 *   - Never use the global `fetch()` / `undici` redirect-follow behavior.
 *     Redirects are handled manually, one hop at a time, and every hop
 *     goes back through full validation.
 *
 * Usage:
 *   import { safeFetch, validateWebhookUrl } from "./ssrf-guard";
 *
 *   // at subscribe-time, to reject bad URLs early:
 *   await validateWebhookUrl(userProvidedUrl);
 *
 *   // wherever the SDK currently calls raw fetch() (incl. sandbox()):
 *   const res = await safeFetch(url, { method: "POST", headers, body });
 * -------------------------------------------------------------------------
 */

import * as dns from "node:dns/promises";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { URL } from "node:url";

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Escape hatch for E2E testing ONLY.
 * When true, validateWebhookUrl() skips all SSRF checks so local webhook
 * receivers work. DO NOT set this in production — it disables SSRF entirely.
 */
const ALLOW_LOCAL_WEBHOOKS = process.env.WARDEN_ALLOW_LOCAL_WEBHOOKS === "true";

// ---------------------------------------------------------------------------
// IP range checks
// ---------------------------------------------------------------------------

function isBlockedIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed -> fail closed
  }
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 ("this network")
  if (a === 127) return true; // 127.0.0.0/8 loopback (covers 127.0.0.2 etc, not just 127.0.0.1)
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT <- the missed range
  if (a === 192 && b === 0 /* 192.0.0.0/24, 192.0.2.0/24 etc. */) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255 broadcast

  return false;
}

function isBlockedIPv6(ipRaw: string): boolean {
  const ip = ipRaw.toLowerCase();

  if (ip === "::1") return true; // loopback
  if (ip === "::") return true; // unspecified

  // IPv4-mapped ::ffff:a.b.c.d — unwrap and re-check as IPv4
  const v4Mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isBlockedIPv4(v4Mapped[1]);

  // Deprecated IPv4-compatible ::a.b.c.d — unwrap and re-check as IPv4
  const v4Compat = ip.match(/^::(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Compat) return isBlockedIPv4(v4Compat[1]);

  // fe80::/10 link-local
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true;

  // fc00::/7 unique local (covers fd00::/8 from the bug report)
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true;

  // 64:ff9b::/96 well-known NAT64 prefix — can be used to reach IPv4
  // private space through a NAT64 gateway, so block defensively.
  if (ip.startsWith("64:ff9b:")) return true;

  // ff00::/8 multicast
  if (ip.startsWith("ff")) return true;

  return false;
}

/** True if `ip` is a loopback/private/link-local/CGNAT/multicast/reserved address. */
export function isBlockedIP(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // not a recognizable IP literal -> fail closed
}

// ---------------------------------------------------------------------------
// Resolve + validate + pin
// ---------------------------------------------------------------------------

/**
 * Resolves `hostname`, validates every returned address against the
 * blocklist, and returns ONE validated address to pin the connection to.
 * Throws if the hostname is a literal blocked IP, resolves to any blocked
 * IP, or fails to resolve at all.
 */
async function resolveAndValidate(hostname: string): Promise<string> {
  if (net.isIP(hostname)) {
    if (isBlockedIP(hostname)) {
      throw new Error(`Blocked destination IP: ${hostname}`);
    }
    return hostname;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (records.length === 0) {
    throw new Error(`DNS resolution failed for ${hostname}`);
  }

  for (const record of records) {
    if (isBlockedIP(record.address)) {
      throw new Error(`Blocked destination IP ${record.address} resolved for host ${hostname}`);
    }
  }

  // Pin to the address we just validated so a subsequent re-resolution
  // (DNS rebinding) inside the HTTP client can't swap in a private IP.
  return records[0].address;
}

/**
 * Validates a webhook URL at subscribe-time. Call this before persisting
 * a subscription, in addition to (not instead of) validating again at
 * delivery-time — the target can change ownership/DNS between the two.
 */
export async function validateWebhookUrl(url: string): Promise<void> {
  // Bypass for E2E testing only — DO NOT enable in production
  if (ALLOW_LOCAL_WEBHOOKS) return;

  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }
  await resolveAndValidate(parsed.hostname);
}

// ---------------------------------------------------------------------------
// safeFetch — DNS-pinned, redirect-safe replacement for fetch()
// ---------------------------------------------------------------------------

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export interface SafeFetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Same job as `fetch()`, but:
 *   - resolves DNS itself and pins the TCP connection to a validated IP
 *     (no DNS-rebinding window between check and connect)
 *   - refuses to auto-follow redirects; each hop is re-validated from
 *     scratch (protocol, hostname, resolved IPs) before being followed
 *   - caps total redirects at MAX_REDIRECTS
 */
export async function safeFetch(
  inputUrl: string,
  options: SafeFetchOptions = {},
  redirectCount = 0,
): Promise<SafeFetchResult> {
  if (redirectCount > MAX_REDIRECTS) {
    throw new Error("Too many redirects");
  }

  const parsed = new URL(inputUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Blocked protocol: ${parsed.protocol}`);
  }

  const pinnedIp = await resolveAndValidate(parsed.hostname);
  const transport = parsed.protocol === "https:" ? https : http;
  const isIPv6 = net.isIPv6(pinnedIp);

  return new Promise<SafeFetchResult>((resolve, reject) => {
    const req = transport.request(
      {
        hostname: parsed.hostname, // kept for correct Host header / TLS SNI
        // Force this request to connect to the address we already
        // validated, instead of letting Node re-resolve the hostname:
        lookup: (_hostname, _opts, cb) => cb(null, pinnedIp, isIPv6 ? 6 : 4),
        port: parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? "GET",
        headers: options.headers,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          res.resume(); // drain so the socket can be reused/closed cleanly
          const nextUrl = new URL(res.headers.location, parsed).toString();
          safeFetch(nextUrl, options, redirectCount + 1).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
        });
        res.on("error", reject);
      },
    );

    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}
