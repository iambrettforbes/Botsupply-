# BotSupply — agent install

Hosted API: **https://botsupply.onrender.com**

Landing page: https://botsupply.onrender.com/
Source: https://github.com/iambrettforbes/Botsupply-

**1 credit = $0.01 USD.** `POST /v1/wallets/:id/topup` is free only while `STRIPE_SECRET_KEY` is unset. That is the hosted behavior until Stripe keys are added. After they are set, `/topup` returns 403 and you pay with Checkout.

| SKU | Credits |
| --- | ---: |
| `pack.competitor-snapshot` | 50 |
| `pack.venue-hours` | 20 |
| `recipe.book-table` | 100 |

Purchase body field is `sku`. Do not send `sku_id`.

```bash
BASE=https://botsupply.onrender.com

curl -s -X POST "$BASE/v1/wallets" \
  -H 'content-type: application/json' \
  -d '{"label":"agent"}'
# save wallet_id and api_key

# DEV top-up. Works only when STRIPE_SECRET_KEY is unset.
curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/topup" \
  -H 'content-type: application/json' \
  -d '{"credits":500}'

curl -s -X POST "$BASE/v1/purchase" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"sku":"pack.venue-hours"}'
```

`GET /v1/catalog` lists prices. `GET /v1/purchases/:id` replays a delivery with the same bearer token. `GET /health` is the probe. Purchase and checkout both use their own body fields: purchase is `sku`, checkout is `credits`. Do not send `sku_id`.

## Pay with Stripe

When `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` are set, skip `/topup`:

```bash
curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/checkout" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"credits":500}'
```

`credits` is an integer from 100 to 100000. One credit is one US cent. Open the returned `url`. Stripe notifies `POST /v1/stripe/webhook` (`checkout.session.completed`, paid). The wallet is credited once per Checkout Session id.

Operators add the three variables on the Render **botsupply** service under **Environment** (`PUBLIC_BASE_URL=https://botsupply.onrender.com`). The webhook endpoint is `https://botsupply.onrender.com/v1/stripe/webhook`. Do not put secret keys in the repo.

The free Render service sleeps after idle time. The first request after a cold start can take about a minute; retry `/health` until it returns `{"status":"ok","service":"botsupply"}`.

SQLite lives on an ephemeral disk. Wallets, credits, and purchases disappear on deploy, restart, or spin-down. Open a new wallet after the service comes back.
