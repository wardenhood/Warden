import { createServer } from "node:http";
import { createHmac } from "node:crypto";

const PORT = parseInt(process.env.WEBHOOK_PORT || "4321");
const SECRET = process.env.WARDEN_SECRET || "";

let deliveries = [];

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><head><title>Warden · Demo Receiver</title>
<style>body{font:14px Inter,system-ui;max-width:800px;margin:40px auto;padding:0 20px;background:#fff;color:#000}
h1{font-size:18px}h1 span{color:#bcfc07}.d{background:#0d1117;color:#e6edf3;padding:16px;border-radius:10px;margin:12px 0;font:12px JetBrains Mono,monospace;white-space:pre-wrap}
.b{font:10px JetBrains Mono;padding:3px 8px;border-radius:6px;display:inline-block;margin-bottom:8px}.ok{background:#3edc64;color:#000}.fail{background:#f85149;color:#fff}
</style></head><body><h1>warden <span>demo receiver</span></h1>
<p>${deliveries.length} deliveries received. POST to <code>/webhook</code></p>
${deliveries.slice(-20).reverse().map(d=>`<div class="d"><span class="b ${d.ok?'ok':'fail'}">${d.ok?'OK':'FAILED'} · ${d.status}</span><br>${JSON.stringify(d.payload,null,2)}</div>`).join('')}
</body></html>`);
    return;
  }

  if (req.method === "POST" && (req.url === "/webhook" || req.url === "/")) {
    let body = "";
    req.on("data", d => body += d);
    req.on("end", () => {
      const sig = req.headers["x-warden-signature"] || "";
      const idKey = req.headers["x-warden-idempotency-key"] || "";
      const subId = req.headers["x-warden-sub-id"] || "";
      let ok = true;
      let status = 200;

      if (SECRET) {
        const expected = createHmac("sha256", SECRET).update(body).digest("hex");
        if (sig !== expected) { ok = false; status = 401; }
      }

      try {
        const payload = JSON.parse(body);
        deliveries.push({ ok, status, subId, idKey, payload, receivedAt: new Date().toISOString() });
        if (deliveries.length > 200) deliveries = deliveries.slice(-200);
        console.log(`[receiver] ${ok ? "✓" : "✗"} sub=${subId} id=${idKey.slice(0,8)}… status=${status}`);
      } catch (e) {
        ok = false; status = 400;
      }

      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok, id: idKey }));
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`[demo-receiver] http://localhost:${PORT}/webhook`);
  if (SECRET) console.log(`[demo-receiver] HMAC enabled`);
});
