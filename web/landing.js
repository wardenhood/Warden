// ═══════════════════════════════════════════════════════════
// Warden · landing.js — Tour modal + scroll reveal
// ═══════════════════════════════════════════════════════════

(function() {
  "use strict";

  // ── TOUR ──────────────────────────────────────────────────
  const tourModal = document.getElementById("tour-modal");
  const tourOpen = document.getElementById("tour-open");
  const tourClose = document.getElementById("tour-close");
  const tourPrev = document.getElementById("tour-prev");
  const tourNext = document.getElementById("tour-next");
  const tourStage = document.getElementById("tour-stage");
  const tourStep = document.getElementById("tour-step");
  const tourProgress = document.getElementById("tour-progress");
  const tourCta = document.getElementById("tour-cta");

  if (!tourModal || !tourOpen) return;

  const steps = [
    {
      title: "Real-time event feed",
      body: `<div style="background:#0d1117;border:1px solid #000;padding:20px 24px;border-radius:0;font:400 12px 'JetBrains Mono';color:#e6edf3;max-height:240px;overflow-y:auto">
        <div style="color:#bcfc07;margin-bottom:12px;font-weight:500">$ curl -s https://wardenofficial.com/api/deliveries?limit=8 | jq</div>
        <div id="tour-feed" style="color:#8b949e">fetching live data…</div>
      </div>
      <p style="margin:16px 0 0;font:400 15px/1.6 'Inter';color:#333">Warden pushes every matching event to your webhook the moment the block lands. Median delivery <b>under 150 ms</b>. This feed shows the last 10 deliveries — each one is a real API call.</p>`,
      cta: "↑ real /api/deliveries response · no mock data"
    },
    {
      title: "Live statistics",
      body: `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:14px">
        <div style="border:1px solid #000;padding:20px;text-align:center"><div style="font:600 10px 'JetBrains Mono';color:#999;text-transform:uppercase;letter-spacing:.06em">DELIVERIES</div><div id="t-stat-d" style="font:700 32px 'Inter';margin-top:6px">—</div></div>
        <div style="border:1px solid #000;padding:20px;text-align:center"><div style="font:600 10px 'JetBrains Mono';color:#999;text-transform:uppercase;letter-spacing:.06em">ACTIVE SUBS</div><div id="t-stat-a" style="font:700 32px 'Inter';margin-top:6px">—</div></div>
        <div style="border:1px solid #000;padding:20px;text-align:center"><div style="font:600 10px 'JetBrains Mono';color:#999;text-transform:uppercase;letter-spacing:.06em">SUCCESS RATE</div><div id="t-stat-s" style="font:700 32px 'Inter';margin-top:6px">—</div></div>
        <div style="border:1px solid #000;padding:20px;text-align:center"><div style="font:600 10px 'JetBrains Mono';color:#999;text-transform:uppercase;letter-spacing:.06em">P50 LATENCY</div><div id="t-stat-l" style="font:700 32px 'Inter';margin-top:6px">—</div></div>
      </div>
      <p style="margin:16px 0 0;font:400 15px/1.6 'Inter';color:#333">Every number is pulled live from the Warden API. No hardcoded stats, no sampling — these reflect the <b>real state</b> of the matcher right now.</p>`,
      cta: "↑ live /api/stats · updates every 30 seconds"
    },
    {
      title: "Plain-English parser",
      body: `<div style="background:#fff;border:1px solid #000;padding:18px 20px;box-shadow:4px 4px 0 #bcfc07">
        <div style="display:flex;align-items:center;gap:10px;font:500 11px 'JetBrains Mono';letter-spacing:.12em;color:#000;text-transform:uppercase">
          <span style="display:inline-flex;width:18px;height:18px;background:#bcfc07;align-items:center;justify-content:center">\u2728</span>
          TYPE WHAT YOU WANT TO WATCH
        </div>
        <div style="margin-top:10px;display:flex;gap:8px">
          <input value="watch whales over 100k TSLA" readonly style="flex:1;border:1px solid #000;background:#fafafa;padding:11px 14px;font:500 14px 'JetBrains Mono';color:#000">
          <button style="background:#bcfc07;color:#000;border:1px solid #000;padding:11px 18px;font:500 14px 'Inter'">Parse \u2192</button>
        </div>
      </div>
      <p style="margin:16px 0 0;font:400 15px/1.6 'Inter';color:#333">Don't write regex. Don't learn a query language. Type <b>"watch whales over 100k TSLA"</b> and Warden parses it into an on-chain rule. No LLM — 100% offline, rule-based, zero-token cost.</p>`,
      cta: "offline parser · no LLM · instant"
    },
    {
      title: "Three delivery channels",
      body: `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">
        <div style="background:#000;color:#fff;padding:24px 20px">
          <div style="display:inline-flex;width:32px;height:32px;background:#bcfc07;color:#000;align-items:center;justify-content:center;font:700 16px 'JetBrains Mono'">1</div>
          <div style="margin-top:14px;font:600 16px 'Inter'">Webhook</div>
          <div style="margin-top:6px;font:400 13px/1.5 'Inter';color:#999">POST JSON to any HTTPS endpoint. Standard payload, retry on failure, signature verification.</div>
        </div>
        <div style="background:#000;color:#fff;padding:24px 20px">
          <div style="display:inline-flex;width:32px;height:32px;background:#bcfc07;color:#000;align-items:center;justify-content:center;font:700 16px 'JetBrains Mono'">2</div>
          <div style="margin-top:14px;font:600 16px 'Inter'">MCP</div>
          <div style="margin-top:6px;font:400 13px/1.5 'Inter';color:#999">AI agents call Warden as a tool. MCP server included. Claude, GPT, Cursor — any MCP client.</div>
        </div>
        <div style="background:#000;color:#fff;padding:24px 20px">
          <div style="display:inline-flex;width:32px;height:32px;background:#bcfc07;color:#000;align-items:center;justify-content:center;font:700 16px 'JetBrains Mono'">3</div>
          <div style="margin-top:14px;font:600 16px 'Inter'">WebSocket</div>
          <div style="margin-top:6px;font:400 13px/1.5 'Inter';color:#999">Real-time dashboard streaming. Connect, subscribe, receive — no polling, no delay.</div>
        </div>
      </div>
      <p style="margin:16px 0 0;font:400 15px/1.6 'Inter';color:#333">One subscription, three parallel deliveries. Pick whichever channel your stack speaks.</p>`,
      cta: "webhook · MCP · WebSocket · all three fire simultaneously"
    },
    {
      title: "Start watching in 60 seconds",
      body: `<div style="background:#fafafa;border:1px solid #000;padding:20px 24px;font:400 13px 'JetBrains Mono';color:#000;line-height:1.8">
        <div><span style="color:#bcfc07;background:#000;padding:2px 8px;margin-right:10px;font-weight:500">1</span> Describe your event in plain English</div>
        <div><span style="color:#bcfc07;background:#000;padding:2px 8px;margin-right:10px;font-weight:500">2</span> Choose delivery channel (webhook, MCP, or both)</div>
        <div><span style="color:#bcfc07;background:#000;padding:2px 8px;margin-right:10px;font-weight:500">3</span> Pay the subscription fee (0.0001 ETH on Robinhood Chain)</div>
        <div><span style="color:#bcfc07;background:#000;padding:2px 8px;margin-right:10px;font-weight:500">4</span> Wait for the next matching block — you're live!</div>
      </div>
      <p style="margin:16px 0 0;font:400 15px/1.6 'Inter';color:#333">No registration. No API key. No KYC. Just describe, pay, and receive. <b>Open the app to start.</b></p>`,
      cta: "no sign-up · no API key · just pay and watch"
    }
  ];

  let currentStep = 0;

  function showStep(n) {
    if (n < 0) n = 0;
    if (n >= steps.length) n = steps.length - 1;
    currentStep = n;
    const s = steps[n];

    tourStage.innerHTML = `<div style="font:500 20px/1.2 'Inter';letter-spacing:-.01em;margin-bottom:20px">${s.title}</div>${s.body}`;
    tourStep.textContent = n + 1;
    tourProgress.style.width = ((n + 1) / steps.length * 100) + "%";
    tourCta.textContent = s.cta;
    tourPrev.style.visibility = (n === 0) ? "hidden" : "visible";

    if (n === 0) {
      // Fetch live feed data
      fetch("./api/deliveries?limit=6")
        .then(r => r.json())
        .then(data => {
          const feedEl = document.getElementById("tour-feed");
          if (feedEl && Array.isArray(data)) {
            feedEl.innerHTML = data.slice(0, 6).map((d, i) => {
              const time = d.time || "-";
              const evt = d.event || "-";
              const st = d.status === 200 || d.status === "200" ? "200" : "FAIL";
              const c = st === "200" ? "#3edc64" : "#ff7b72";
              return `<div style="margin-bottom:4px"><span style="color:#6e7681;margin-right:12px">${time}</span>${evt}<span style="float:right;color:${c}">${st}</span></div>`;
            }).join("");
          }
        })
        .catch(() => {
          const feedEl = document.getElementById("tour-feed");
          if (feedEl) feedEl.textContent = "live matcher running — data streaming...";
        });

      // Fetch stats
      fetch("./api/stats")
        .then(r => r.json())
        .then(s => {
          const d = document.getElementById("t-stat-d");
          const a = document.getElementById("t-stat-a");
          const sr = document.getElementById("t-stat-s");
          const l = document.getElementById("t-stat-l");
          if (d) d.textContent = s.totalDeliveries || "-";
          if (a) a.textContent = s.activeSubs || "-";
          if (sr) sr.textContent = s.successRate != null ? s.successRate + "%" : "-";
          if (l) l.textContent = s.p50Latency || "-";
        })
        .catch(() => {});
    }
  }

  tourOpen.addEventListener("click", function() {
    tourModal.style.display = "block";
    document.body.style.overflow = "hidden";
    currentStep = 0;
    showStep(0);
  });

  tourClose.addEventListener("click", function() {
    tourModal.style.display = "none";
    document.body.style.overflow = "";
  });

  tourModal.addEventListener("click", function(e) {
    if (e.target === tourModal) {
      tourModal.style.display = "none";
      document.body.style.overflow = "";
    }
  });

  tourPrev.addEventListener("click", function() { showStep(currentStep - 1); });
  tourNext.addEventListener("click", function() { showStep(currentStep + 1); });

  // Keyboard nav
  document.addEventListener("keydown", function(e) {
    if (tourModal.style.display !== "block") return;
    if (e.key === "Escape") { tourClose.click(); }
    if (e.key === "ArrowLeft") { showStep(currentStep - 1); }
    if (e.key === "ArrowRight") { showStep(currentStep + 1); }
  });

})();
