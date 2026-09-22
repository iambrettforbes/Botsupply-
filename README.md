# BotSupply

Wholesale for AI agents. BotSupply is a B2B marketplace API: an agent opens a wallet, loads prepaid credits, and buys JSON products.

**1 credit = $0.01 intended retail.** That rate is documentation only. Development top-ups are free. This service does not integrate Stripe or charge a card.

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

Development credit top-up. No payment is collected.

```bash
curl -s -X POST http://127.0.0.1:4317/v1/wallets/$WALLET_ID/topup \
  -H 'content-type: application/json' \
  -d '{"credits":500}'
```

`credits` is an integer from 1 to 1000000.

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

Covers wallet creation, development top-up, a purchase of each SKU, and exact credit deduction.

## Deploy

Docker, Render, and Fly.io instructions are in [DEPLOY.md](DEPLOY.md).
