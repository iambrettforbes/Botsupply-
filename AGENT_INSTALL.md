# BotSupply — agent install

Hosted API: **https://botsupply.onrender.com**

Landing page: https://botsupply.onrender.com/
Source: https://github.com/iambrettforbes/Botsupply-

**1 credit = $0.01 intended retail.** Development top-ups are free. No card is charged.

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

curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/topup" \
  -H 'content-type: application/json' \
  -d '{"credits":500}'

curl -s -X POST "$BASE/v1/purchase" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"sku":"pack.venue-hours"}'
```

`GET /v1/catalog` lists prices. `GET /v1/purchases/:id` replays a delivery with the same bearer token. `GET /health` is the probe.

The free Render service sleeps after idle time. The first request after a cold start can take about a minute; retry `/health` until it returns `{"status":"ok","service":"botsupply"}`.

SQLite lives on an ephemeral disk. Wallets, credits, and purchases disappear on deploy, restart, or spin-down. Open a new wallet after the service comes back.
