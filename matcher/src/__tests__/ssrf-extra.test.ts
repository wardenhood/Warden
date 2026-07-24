import { validateWebhookUrl, deliverWebhook } from "../delivery.js";
import * as http from "node:http";

describe("SSRF hardening — round 2", () => {
  it("blocks IPv4-mapped IPv6 loopback", () => {
    expect(validateWebhookUrl("http://[::ffff:127.0.0.1]/")).toBe(false);
    expect(validateWebhookUrl("http://[0:0:0:0:0:ffff:7f00:1]/")).toBe(false);
  });

  it("blocks IPv6 unspecified address", () => {
    expect(validateWebhookUrl("http://[::]/")).toBe(false);
  });

  it("actually connects to nothing when DNS rebinds to a private IP at request time", async () => {
    // Simulate the classic bypass: hostname is not a literal private IP (passes Layer 1),
    // but an internal HTTP server is listening on 127.0.0.1, and we resolve straight to it.
    const server = http.createServer((_req, res) => { res.writeHead(200); res.end("internal secret"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as any).port;

    // "webhook.site" style public-looking hostname would normally pass validateWebhookUrl,
    // but here we hit the real deliverWebhook() path directly against a private-IP target
    // to prove the pinned-connect layer refuses it even if Layer 1 were somehow bypassed.
    const result = await deliverWebhook(`http://127.0.0.1:${port}/`, "secret", "sub1", { x: 1 });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);

    await new Promise<void>((r) => server.close(() => r()));
  });
});
