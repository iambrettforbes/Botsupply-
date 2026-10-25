# BotSupply

[![iambrettforbes/Botsupply- MCP server](https://glama.ai/mcp/servers/iambrettforbes/Botsupply-/badges/score.svg)](https://glama.ai/mcp/servers/iambrettforbes/Botsupply-)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Free, rail-agnostic purchase receipts for AI agents.** Store a record of what was reported as approved for a purchase on any payment rail, attach proof of delivery, and get a public receipt URL. Verified means the record hasn't changed since it was created; it doesn't confirm who approved. Receipts do not hold or move the money, and they need no wallet.

Also included (optional): prepaid credit wallets, agent-to-agent job escrow, and a small wholesale catalog.

**Hosted service status:** live at [https://botsupply.onrender.com](https://botsupply.onrender.com) in **Stripe TEST mode** only. `/health` reports `"mode":"test"`. Do not send live card payments yet.

## Quick start (MCP)

Connect any MCP client to the hosted Streamable HTTP endpoint:

```text
https://botsupply.onrender.com/mcp
```

Examples:

```bash
npx add-mcp 'https://botsupply.onrender.com/mcp'
# or
claude mcp add --transport http botsupply 'https://botsupply.onrender.com/mcp'
```

Install notes and auth: [MCP_INSTALL.md](MCP_INSTALL.md). REST agents: [AGENT_INSTALL.md](AGENT_INSTALL.md). Demo script: [DEMO.md](DEMO.md).

## MCP tools (13)

### Purchase receipts (no wallet, free)

| Tool | What it does |
| --- | --- |
| `record_approval` | Write a record of what was reported as approved for a purchase on any rail. The approver is a name the agent supplies. Returns `receipt_id`, public `receipt_url`, and a one-time `edit_token`. |
| `attach_proof` | Attach delivery proof with the `edit_token` (order confirmation, tracking, URL, hash, …). |
| `get_receipt` | Public receipt JSON. |
| `verify_receipt` | Recompute the hash chain and HMAC; returns `valid` true/false. `valid` means the record hasn't changed. It doesn't confirm who approved. |

Public HTML page: `GET /r/:id` (Verified or Tampered badge). Verified means the record hasn't changed since it was created. It doesn't confirm who approved. The approver is shown as reported by the agent.

### Wallets and catalog

| Tool | What it does |
| --- | --- |
| `list_catalog` | List live SKUs and credit prices. |
| `open_wallet` | Create a wallet; API key returned once. |
| `get_balance` | Prepaid credit balance. |
| `purchase` | Buy one catalog SKU with credits. |
| `create_checkout` | Stripe Checkout top-up (500 to 100000 credits, $5 to $1,000). Hosted service is Stripe test mode. |

### Escrow (prepaid credits)

| Tool | What it does |
| --- | --- |
| `create_job` | Hold credits for another agent. |
| `get_job` | Read a job. |
| `release_job` | Pay the payee. |
| `refund_job` | Return the hold to the payer. |

## Purchase receipts

An agent records what was reported as approved for a purchase on any payment rail (`stripe_link`, `card`, `x402`, `botsupply_wallet`, …) and later attaches proof of delivery. The approver is a name the agent typed in. BotSupply stores that record and a public URL. **It does not hold or move the money, and it does not confirm who approved.** No wallet and no API key are required.

```bash
curl -s -X POST https://botsupply.onrender.com/v1/receipts \
  -H 'content-type: application/json' \
  -d '{"approver":"Ada","merchant_name":"North Market","scope":"Two bags of coffee","price_cap_amount":"25.00","price_cap_currency":"USD","payment_rail":"stripe_link"}'
```

Response includes `receipt_id` (`rcpt_` + 24 hex), `receipt_url`, and `edit_token` (returned once; keep it to attach proof).

```bash
curl -s -X POST https://botsupply.onrender.com/v1/receipts/$RECEIPT_ID/proof \
  -H 'content-type: application/json' \
  -d '{"edit_token":"…","type":"order_confirmation","value":"ord_123"}'
```

- `GET /v1/receipts/:id` — public JSON  
- `GET /v1/receipts/:id/verify` — hash chain + HMAC check  
- `GET /r/:id` — HTML with Verified / Tampered badge. Verified means the record hasn't changed since it was created and doesn't confirm who approved. The approver is labeled as reported by the agent.

Approvals are rate-limited (30/min/IP). Optional `approver_contact` is stored only as a SHA-256 hash and is never returned. Each change is hash-chained (SHA-256). The latest hash is signed with HMAC-SHA256 using `RECEIPT_SIGNING_KEY`. Set that to a long random secret in production; if unset, an ephemeral key is generated and signatures will not verify after a restart. Changing the key makes older receipts verify as tampered.

## Wallets and credits

**1 credit = $0.01 USD.** Agents open a wallet, top up with Stripe Checkout (test mode on the hosted service), and buy JSON products from the catalog.

`POST /v1/wallets/:id/topup` is a free development top-up only when `STRIPE_SECRET_KEY` is unset. When `STRIPE_SECRET_KEY` is set, that route returns **403** and agents pay with Checkout. Paid top-ups are **500 to 100000 credits ($5 to $1,000)**.

### Catalog

| SKU | Kind | Credits | Intended retail |
| --- | --- | ---: | ---: |
| `pack.competitor-snapshot` | pack | 50 | $0.50 |
| `pack.venue-hours` | pack | 20 | $0.20 |
| `recipe.book-table` | recipe | 100 | $1.00 |

`pack.competitor-snapshot` is a Cobble Hill casual-dining competitive set. `pack.venue-hours` is weekly hours and reservation policy for those venues. `recipe.book-table` is an executable booking recipe the agent runs itself (buying it does not place a reservation). Payloads are delivered on purchase.

## Escrow jobs

One agent can hold credits for another. `POST /v1/jobs` debits the payer and marks the job `held`. Release pays the payee; refund returns the hold. Writes run in one database transaction. `ESCROW_FEE_BPS` defaults to **0**.

```bash
curl -s -X POST https://botsupply.onrender.com/v1/jobs \
  -H "authorization: Bearer $PAYER_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"payee_wallet_id":"wal_…","amount_credits":100,"description":"Deliver the brief","idempotency_key":"job-1"}'
```

## Run locally

Requires Node.js 22+.

```bash
npm install
npm test
npm run build
npm start
```

The process binds `0.0.0.0` and listens on `PORT`, default **4317**.

```bash
curl -s http://127.0.0.1:4317/health
```

Open [http://127.0.0.1:4317](http://127.0.0.1:4317) for the price sheet and curl examples. `npm run dev` reloads with `tsx`.

## Data

When `DATABASE_URL` is set, wallets, purchases, checkout sessions, credited Checkout sessions, escrow jobs, and receipts are stored in **Postgres**. Each row is tagged `dev`, `test`, or `live` from the Stripe secret key prefix (`sk_test_` / `rk_test_` → test, `sk_live_` / `rk_live_` → live, unset → dev). Lookups include that tag, so test mode never reads live rows.

When `DATABASE_URL` is unset, the same records stay in a **SQLite** file (`SQLITE_PATH`, or `/data/botsupply.sqlite` if writable, else `./data/botsupply.sqlite`).

The hosted service uses Postgres and reports `"storage":"postgres","mode":"test"`.

## API (summary)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/receipts` | Record what was reported as approved (no auth) |
| `POST` | `/v1/receipts/:id/proof` | Attach proof (`edit_token`) |
| `GET` | `/v1/receipts/:id` | Public JSON |
| `GET` | `/v1/receipts/:id/verify` | Integrity check |
| `GET` | `/r/:id` | Public HTML receipt |
| `POST` | `/v1/wallets` | Open wallet |
| `POST` | `/v1/wallets/:id/checkout` | Stripe top-up (auth) |
| `GET` | `/v1/catalog` | List SKUs |
| `GET` | `/v1/balance` | Balance (auth) |
| `POST` | `/v1/purchase` | Buy SKU (auth) |
| `POST` | `/v1/jobs` | Create escrow hold (auth) |
| `GET` | `/v1/jobs/:id` | Get job (auth) |
| `POST` | `/v1/jobs/:id/release` | Release (auth) |
| `POST` | `/v1/jobs/:id/refund` | Refund (auth) |
| `POST` | `/mcp` | Streamable HTTP MCP |
| `GET` | `/health` | `{ status, service, storage, mode, database }` (503 if the database ping fails) |

Full curl examples for wallets, Checkout, Stripe webhook setup on Render, and escrow edge cases remain in git history and the install docs; the hosted service is the source of truth for live behavior.

### Stripe on Render (test mode today)

| Key | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | `sk_test_…` (or later `sk_live_…`). Do not commit it. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for `checkout.session.completed` |
| `PUBLIC_BASE_URL` | `https://botsupply.onrender.com` |
| `RECEIPT_SIGNING_KEY` | Long random secret for receipt HMAC |

Webhook endpoint: `https://botsupply.onrender.com/v1/stripe/webhook`.

## Tests

```bash
npm test
```

Covers wallets, DEV top-up, catalog purchases, Stripe credit application (fake client), escrow hold/release/refund/fee/idempotency/mode isolation, and purchase receipts (create, proof, verify, tamper, edit token, over-cap, mode isolation, per-IP limit).

## Deploy

Docker, Render, and Fly.io: [DEPLOY.md](DEPLOY.md).

## License

[MIT](LICENSE)
