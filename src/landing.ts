import { CREDIT_VALUE_USD, PRODUCTS, priceUsd, type Product } from "./catalog.js";

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function skuRow(product: Product): string {
  const usd = priceUsd(product.price_credits).toFixed(2);
  return `<article class="sku">
    <div class="sku-top">
      <p class="kind">${esc(product.kind)}</p>
      <p class="price"><span>${product.price_credits}</span> cr <em>$${usd}</em></p>
    </div>
    <h3>${esc(product.name)}</h3>
    <code>${esc(product.sku)}</code>
    <p>${esc(product.description)}</p>
  </article>`;
}

export function renderLanding(): string {
  const rows = PRODUCTS.map(skuRow).join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BotSupply — Wholesale for AI agents</title>
  <meta name="description" content="BotSupply is a B2B marketplace API. AI agents buy data packs and recipes with prepaid credits.">
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b08;
      --bg-2: #10140e;
      --ink: #e7f0dc;
      --muted: #93a38a;
      --line: #2a3824;
      --stamp: #d6ff4a;
      --stamp-ink: #142000;
      --amber: #ffb020;
      --danger: #ff6b4a;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      background:
        radial-gradient(1200px 500px at 90% -10%, rgba(214, 255, 74, 0.08), transparent 55%),
        linear-gradient(180deg, var(--bg) 0%, #0c100b 100%);
      color: var(--ink);
      font-family: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      line-height: 1.5;
    }
    a { color: var(--stamp); }
    .wrap { width: min(1080px, calc(100% - 32px)); margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: center;
      padding: 22px 0;
      border-bottom: 1px solid var(--line);
    }
    .mark { display: flex; align-items: baseline; gap: 10px; letter-spacing: 0.08em; }
    .mark strong { font-size: 15px; }
    .mark span { color: var(--muted); font-size: 12px; }
    .pill {
      border: 1px solid var(--stamp);
      color: var(--stamp);
      padding: 4px 10px;
      font-size: 12px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .hero { padding: 56px 0 28px; }
    h1 {
      font-size: clamp(40px, 7vw, 76px);
      line-height: 0.92;
      letter-spacing: -0.04em;
      margin: 0 0 18px;
      max-width: 14ch;
      font-weight: 500;
    }
    h1 em { font-style: normal; color: var(--stamp); }
    .lede { max-width: 62ch; color: var(--muted); font-size: 16px; margin: 0; }
    .facts {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 28px;
    }
    .facts span {
      border: 1px solid var(--line);
      background: var(--bg-2);
      padding: 8px 12px;
      font-size: 13px;
    }
    .facts b { color: var(--amber); font-weight: 500; }
    h2 {
      font-size: 13px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 500;
      margin: 0 0 14px;
    }
    .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; }
    .sku {
      background: var(--bg-2);
      border: 1px solid var(--line);
      padding: 16px;
      min-height: 220px;
    }
    .sku-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
    .kind { margin: 0; color: var(--stamp); font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; }
    .price { margin: 0; color: var(--amber); }
    .price span { font-size: 28px; letter-spacing: -0.04em; }
    .price em { font-style: normal; color: var(--muted); font-size: 12px; }
    .sku h3 { margin: 18px 0 6px; font-size: 18px; font-weight: 500; }
    .sku code, pre code { color: var(--ink); }
    .sku code { display: block; color: var(--stamp); font-size: 12px; margin-bottom: 10px; }
    .sku p { margin: 0; color: var(--muted); font-size: 13px; }
    section { padding: 18px 0 8px; }
    pre {
      margin: 0;
      padding: 16px;
      overflow: auto;
      background: #070806;
      border: 1px solid var(--line);
      color: #d5e2c8;
      font-size: 13px;
      line-height: 1.55;
    }
    .steps { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 8px; }
    .step { border-top: 2px solid var(--stamp); padding-top: 10px; }
    .step b { display: block; color: var(--ink); font-weight: 500; margin-bottom: 4px; }
    .step span { color: var(--muted); font-size: 13px; }
    footer {
      margin-top: 36px;
      padding: 18px 0 32px;
      border-top: 1px solid var(--line);
      color: var(--muted);
      font-size: 12px;
      display: flex;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
    }
    @media (max-width: 860px) {
      .sheet, .steps { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <div class="mark"><strong>BOTSUPPLY</strong><span>// marketplace</span></div>
      <div class="pill">Dev credits · no card</div>
    </header>
    <div class="hero">
      <h1>Wholesale for <em>AI agents</em></h1>
      <p class="lede">A B2B marketplace API. An agent opens a wallet, loads prepaid credits, and buys JSON packs and action recipes over HTTP. One credit is intended retail of $${CREDIT_VALUE_USD.toFixed(2)}. Nothing here talks to Stripe.</p>
      <div class="facts">
        <span>Base URL <b>/v1</b></span>
        <span>Auth <b>Bearer API key</b> on purchase</span>
        <span>Health <b>GET /health</b></span>
        <span>Top-up <b>free in dev</b></span>
      </div>
    </div>
    <section>
      <h2>Price sheet</h2>
      <div class="sheet">
        ${rows}
      </div>
    </section>
    <section>
      <h2>How an agent buys</h2>
      <div class="steps">
        <div class="step"><b>01 Open a wallet</b><span>POST /v1/wallets returns wallet_id and api_key. The key is shown once.</span></div>
        <div class="step"><b>02 Load credits</b><span>POST /v1/wallets/:id/topup adds development credits. No payment is collected.</span></div>
        <div class="step"><b>03 Read the sheet</b><span>GET /v1/catalog lists SKUs and credit prices. Payloads stay behind purchase.</span></div>
        <div class="step"><b>04 Take delivery</b><span>POST /v1/purchase spends credits and returns the JSON. GET /v1/purchases/:id replays it.</span></div>
      </div>
    </section>
    <section>
      <h2>curl</h2>
      <pre><code>BASE=http://127.0.0.1:4317

# 1. Open a wallet
curl -s -X POST "$BASE/v1/wallets" \\
  -H 'content-type: application/json' \\
  -d '{"label":"desk-agent"}'

# 2. Development top-up (free credits, no card)
curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/topup" \\
  -H 'content-type: application/json' \\
  -d '{"credits":500}'

# 3. Price sheet
curl -s "$BASE/v1/catalog"

# 4. Buy a SKU
curl -s -X POST "$BASE/v1/purchase" \\
  -H "authorization: Bearer $API_KEY" \\
  -H 'content-type: application/json' \\
  -d '{"sku":"pack.competitor-snapshot"}'

# 5. Replay the delivery
curl -s "$BASE/v1/purchases/$PURCHASE_ID" \\
  -H "authorization: Bearer $API_KEY"</code></pre>
    </section>
    <footer>
      <span>1 credit = $${CREDIT_VALUE_USD.toFixed(2)} intended retail. Development top-ups are not invoiced.</span>
      <span>SQLite · bind 0.0.0.0 · port $PORT or 4317</span>
    </footer>
  </div>
</body>
</html>`;
}
