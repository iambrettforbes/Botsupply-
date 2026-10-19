# BotSupply

Wholesale for AI agents. BotSupply is a B2B marketplace API: an agent opens a wallet, loads prepaid credits, and buys JSON products.

**1 credit = $0.01 USD.** `POST /v1/wallets/:id/topup` is a free development top-up only when `STRIPE_SECRET_KEY` is unset. When `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` are all set, that free route returns 403 and agents pay with Stripe Checkout.

Agents calling the hosted API: [AGENT_INSTALL.md](AGENT_INSTALL.md). MCP tools for the same catalog: [MCP_INSTALL.md](MCP_INSTALL.md). Public demo script: [DEMO.md](DEMO.md).

## Products

| SKU | Kind | Credits | Intended retail |
| --- | --- | ---: | ---: |
| `pack.competitor-snapshot` | pack | 50 | $0.50 |
| `pack.venue-hours` | pack | 20 | $0.20 |
| `recipe.book-table` | recipe | 100 | $1.00 |

`pack.competitor-snapshot` is a Cobble Hill casual-dining competitive set. `pack.venue-hours` is weekly hours and reservation policy for those venues. `recipe.book-table` is an executable booking recipe the agent runs itself. Payloads are delivered on purchase.

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

Open [http://127.0.0.1:4317](http://127.0.0.1:4317) for the price sheet and curl examples.

`npm run dev` reloads the TypeScript server with `tsx`.

## Data

When `DATABASE_URL` is set, wallets, purchases, checkout sessions, credited Checkout sessions, escrow jobs, and purchase receipts are stored in Postgres. Each row is tagged `dev`, `test`, or `live` from the Stripe secret key prefix (`sk_test_` / `rk_test_` → test, `sk_live_` / `rk_live_` → live, unset → dev). Every lookup includes that tag, so a test-mode process does not read live rows. The webhook accepts `checkout.session.completed` only when the event's `livemode` matches that tag.

When `DATABASE_URL` is unset, the same records stay in a SQLite file:

1. `SQLITE_PATH`, if set, is used as-is.
2. Otherwise the file is `/data/botsupply.sqlite` when `/data` is writable.
3. Otherwise it is `./data/botsupply.sqlite`.

The database and catalog are created on startup. Wallets start at 0 credits.

## API

### `POST /v1/wallets`

Opens a wallet. The API key is returned once.

```bash
curl -s -X POST http://127.0.0.1:4317/v1/wallets \
  -H 'content-type: application/json' \
  -d '{"label":"desk-agent"}'
```

```json
{ "wallet_id": "wal_…", "api_key": "bsk_…", "balance_credits": 0 }
```

### `POST /v1/wallets/:id/topup`

DEV credit top-up. No payment is collected. This is the current behavior only when `STRIPE_SECRET_KEY` is unset (local runs and the hosted service before Stripe keys are added). After the key is set, the route returns **403** `dev_topup_disabled`.

```bash
curl -s -X POST http://127.0.0.1:4317/v1/wallets/$WALLET_ID/topup \
  -H 'content-type: application/json' \
  -d '{"credits":500}'
```

`credits` is an integer from 1 to 1000000.

### `POST /v1/wallets/:id/checkout`

Paid top-up. Requires `Authorization: Bearer <api_key>` for that wallet, and all three Stripe env vars. Body is `{ "credits": number }` from 500 to 100000 ($5 to $1,000). Each credit is a 1-cent Checkout line item (`unit_amount` 1, quantity = credits).

```bash
curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/checkout" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"credits":500}'
```

The response `url` is `https://<host>/v1/pay/s/<session_id>`. Opening it redirects to hosted Checkout and keeps the `#` fragment Stripe requires. A session id alone shows “This link is incomplete.” `stripe_url` is the full Checkout link.

`GET /v1/pay?credits=500` creates a demo wallet and redirects to Checkout. Add `wallet_id` to pay into an existing wallet. Credits are 500 to 100000. The minimum top-up is $5.

Credits are applied when Stripe calls `POST /v1/stripe/webhook` with `checkout.session.completed` and `payment_status` `paid`. The same Checkout Session id is credited once.

### Stripe on Render

The live service does not charge cards until these are set. In the Render Dashboard, open the **botsupply** service, then **Environment**, and add:

| Key | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | Secret key from Stripe (`sk_test_…` or `sk_live_…`). Do not commit it. |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for the endpoint below (`whsec_…`). |
| `PUBLIC_BASE_URL` | `https://botsupply.onrender.com` |

Save and redeploy. In Stripe, add a webhook endpoint `https://botsupply.onrender.com/v1/stripe/webhook` for the event `checkout.session.completed`, then paste its signing secret into `STRIPE_WEBHOOK_SECRET`.

`render.yaml` lists the two secrets with `sync: false` and sets `PUBLIC_BASE_URL`. The service already exists, so fill the secrets in the Dashboard. An empty value counts as unset, and the DEV top-up stays on until `STRIPE_SECRET_KEY` is non-empty. Leave the key unset to keep free top-ups.

### `GET /v1/catalog`

Lists SKUs, credit prices, and the intended retail rate. Product payloads are not included.

### `GET /v1/balance`

Requires `Authorization: Bearer <api_key>`. Returns `wallet_id`, `balance_credits`, `label`, and `created_at`. The API key is not included.

### Escrow jobs

One agent can hold credits for another agent. `POST /v1/jobs` debits the authenticated payer and marks the job `held`. `POST /v1/jobs/:id/release` pays the payee. `POST /v1/jobs/:id/refund` returns the hold to the payer. Each of those writes runs in one database transaction.

The bearer token is the payer on create. Release requires the payer's API key. Refund accepts the payer's key or the payee's key (the payee can cancel). `GET /v1/jobs/:id` requires the payer or the payee. A wallet from another Stripe mode is not a party, and a job created in one mode is invisible in the others.

```bash
curl -s -X POST http://127.0.0.1:4317/v1/jobs \
  -H "authorization: Bearer $PAYER_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"payee_wallet_id":"wal_…","amount_credits":100,"description":"Deliver the brief","idempotency_key":"job-1"}'
```

`amount_credits` is an integer from 1 to 1000000000. The payer and payee must be different wallets in the same mode, and the payer must have the credits. `idempotency_key` is unique per payer and mode (1 to 128 characters). The same key and the same parameters return the original job and do not debit again. The same key with different parameters returns **409** `idempotency_conflict`.

Release and refund move credits only while the status is `held`. A second release, a release after refund, or a refund after release returns **409** `job_not_held` and does not move credits. Insufficient balance returns **402** and does not create a job.

`ESCROW_FEE_BPS` is an optional integer from 0 to 10000 (100 bps = 1%). The default is 0. On release the fee is `floor(amount_credits * ESCROW_FEE_BPS / 10000)`, recorded on the job as `fee_bps` and `fee_credits`, and credited to nobody. The payee receives `payee_credits` (`amount_credits - fee_credits`). Refunds return the full hold and charge no fee. While the job is held, `fee_credits` and `payee_credits` are 0.

### Purchase receipts

An agent can record a human's approval of a purchase on any payment rail and later attach proof of delivery. BotSupply stores the receipt and a public URL. It does not hold or move the money.

`POST /v1/receipts` needs no wallet and no API key. It is limited to 30 approvals per minute per IP. The response includes `receipt_id` (`rcpt_` plus 24 hex characters), `receipt_url`, and `edit_token`. The edit token is returned once. Keep it. It is the only way to attach proof.

```bash
curl -s -X POST http://127.0.0.1:4317/v1/receipts \
  -H 'content-type: application/json' \
  -d '{"approver":"Ada","merchant_name":"North Market","scope":"Two bags of coffee","price_cap_amount":"25.00","price_cap_currency":"USD","payment_rail":"stripe_link"}'
```

`approver` is a display name or handle. Optional `approver_contact` (email or phone) is stored only as a SHA-256 hash and is never returned. `payment_rail` is free text such as `stripe_link`, `card`, `x402`, or `botsupply_wallet`. `price_cap_amount` is a positive decimal. Optional fields: `agent_id`, `agent_name`, `merchant_url` (http or https), `external_payment_ref`.

`POST /v1/receipts/:id/proof` requires `edit_token`, `type` (`order_confirmation`, `tracking`, `url`, `hash`, or any other short label), and `value`. Optional `actual_amount` sets `over_cap` when it is above the price cap. The proof is still stored. The first proof moves `approved` to `delivered`. Pass `"status":"disputed"` to dispute. A disputed receipt cannot move back to delivered.

`GET /v1/receipts/:id` is public JSON. `GET /v1/receipts/:id/verify` recomputes the hash chain and the HMAC signature and returns `valid` true or false. `GET /r/:id` is the same receipt as HTML, with a Verified or Tampered badge. None of these show `approver_contact` or the edit token.

Each change hashes a canonical JSON snapshot with SHA-256. Every event stores `prev_hash` and `hash`. The receipt's `content_hash` is the latest event hash. That hash is signed with HMAC-SHA256 using `RECEIPT_SIGNING_KEY`. Set that variable to a long random secret. If it is unset, the process generates an ephemeral key and logs a warning. Signatures from that key do not verify after a restart. Changing the key makes older receipts verify as tampered.

Receipts are scoped to the process Stripe mode, the same way wallets and jobs are.

### `POST /v1/purchase`

Requires `Authorization: Bearer <api_key>`. Spends the SKU price and returns the JSON payload.

```bash
curl -s -X POST http://127.0.0.1:4317/v1/purchase \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"sku":"pack.venue-hours"}'
```

Insufficient balance returns **402** and does not deduct credits. An unknown SKU returns **404**. A missing or unknown key returns **401**.

### `GET /v1/purchases/:id`

Replays a purchase for the wallet that owns it. Same bearer token as purchase.

### MCP

`POST /mcp` is a stateless Streamable HTTP MCP server on this same process. The tools call the routes above (`list_catalog`, `open_wallet`, `get_balance`, `purchase`, `create_checkout`, `create_job`, `get_job`, `release_job`, `refund_job`, `record_approval`, `attach_proof`, `get_receipt`, `verify_receipt`). Install steps and auth: [MCP_INSTALL.md](MCP_INSTALL.md).

### `GET /health`

```json
{ "status": "ok", "service": "botsupply", "storage": "sqlite", "mode": "dev", "database": "ok" }
```

`storage` is `postgres` or `sqlite`. `mode` is `dev`, `test`, or `live`. `database` is `ok` after a successful ping, and the route returns **503** when the ping fails. With `DATABASE_URL` set and a test Stripe key, a healthy process reports `"storage":"postgres"` and `"mode":"test"`.

## Tests

```bash
npm test
```

Covers wallet creation, the DEV top-up, a purchase of each SKU, credit deduction, idempotent Stripe credit application, escrow hold, release, refund, fee, idempotency, and mode isolation, and purchase receipts (create, proof, verify, tamper, edit token, over-cap, mode isolation, and the per-IP approval limit). Checkout tests use a fake Stripe client and do not call the network.

## Deploy

Docker, Render, and Fly.io instructions are in [DEPLOY.md](DEPLOY.md).
