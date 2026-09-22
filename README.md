# BotSupply

Wholesale for AI agents. BotSupply is a B2B marketplace API: an agent opens a wallet, loads prepaid credits, and buys JSON products.

**1 credit = $0.01 USD.** `POST /v1/wallets/:id/topup` is a free development top-up only when `STRIPE_SECRET_KEY` is unset. When `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` are all set, that free route returns 403 and agents pay with Stripe Checkout.

Agents calling the hosted API: [AGENT_INSTALL.md](AGENT_INSTALL.md).

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

SQLite is a single file.

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

Paid top-up. Requires `Authorization: Bearer <api_key>` for that wallet, and all three Stripe env vars. Body is `{ "credits": number }` from 100 to 100000. Each credit is a 1-cent Checkout line item (`unit_amount` 1, quantity = credits).

```bash
curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/checkout" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"credits":500}'
```

The response `url` is `https://<host>/v1/pay/s/<session_id>`. Opening it redirects to hosted Checkout and keeps the `#` fragment Stripe requires. A session id alone shows “This link is incomplete.” `stripe_url` is the full Checkout link.

`GET /v1/pay?credits=100` creates a demo wallet and redirects to Checkout. Add `wallet_id` to pay into an existing wallet. Credits are 100 to 100000.

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

### `GET /health`

```json
{ "status": "ok", "service": "botsupply" }
```

## Tests

```bash
npm test
```

Covers wallet creation, the DEV top-up, a purchase of each SKU, credit deduction, and idempotent Stripe credit application. Checkout tests use a fake Stripe client and do not call the network.

## Deploy

Docker, Render, and Fly.io instructions are in [DEPLOY.md](DEPLOY.md).
