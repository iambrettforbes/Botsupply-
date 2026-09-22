# BotSupply agent demo

Base URL: **https://botsupply.onrender.com**

Landing: https://botsupply.onrender.com

Agent install: [AGENT_INSTALL.md](AGENT_INSTALL.md)

BotSupply does not place reservations; it sells JSON packs and recipes.

Stripe Checkout Session hosted URLs may be broken (Stripe shows “This link is incomplete” when the URL fragment is dropped). DEV top-up (`POST /v1/wallets/:id/topup`) is disabled when Stripe keys are set: the route returns **403** `dev_topup_disabled`.

```bash
BASE=https://botsupply.onrender.com
```

## 1. `GET /health`

```bash
curl -s "$BASE/health"
```

**200**

```json
{ "status": "ok", "service": "botsupply" }
```

## 2. `GET /v1/catalog`

```bash
curl -s "$BASE/v1/catalog"
```

**200** — prices only; payloads are not in the catalog.

```json
{
  "credit_value_usd": 0.01,
  "note": "1 credit = $0.01 intended retail. Credits are prepaid units.",
  "products": [
    {
      "sku": "pack.venue-hours",
      "name": "Venue Hours",
      "kind": "pack",
      "description": "…",
      "price_credits": 20,
      "price_usd": 0.2
    }
  ]
}
```

Other SKUs: `pack.competitor-snapshot` (50 credits), `recipe.book-table` (100 credits).

## 3. `POST /v1/wallets`

```bash
curl -s -X POST "$BASE/v1/wallets" \
  -H 'content-type: application/json' \
  -d '{"label":"demo"}'
```

**201** — `api_key` is returned once.

```json
{
  "wallet_id": "wal_…",
  "api_key": "bsk_…",
  "balance_credits": 0,
  "label": "demo",
  "created_at": "2026-01-01T00:00:00.000Z"
}
```

## 4. Paid top-up

If Checkout works, create a session for 100 credits (`Authorization: Bearer` must match the wallet):

```bash
curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/checkout" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"credits":100}'
```

**201**

```json
{
  "checkout_session_id": "cs_…",
  "url": "https://botsupply.onrender.com/v1/pay/s/cs_…",
  "stripe_url": "https://checkout.stripe.com/c/pay/cs_…#…",
  "wallet_id": "wal_…",
  "credits": 100,
  "amount_cents": 100,
  "currency": "usd"
}
```

Open `url`. That same-origin path **302**s to `stripe_url` and keeps the fragment Stripe requires. `amount_cents` equals `credits` because 1 credit = $0.01.

If the hosted Checkout page is incomplete, paid top-up is the short redirect (creates a throwaway wallet and **302**s to Checkout):

```bash
curl -sI "$BASE/v1/pay?credits=100"
```

Until that redirect is live on the host, use a Stripe Payment Link for the same $1.00 / 100-credit top-up. Do not use DEV `/topup` on the hosted service while Stripe keys are set.

## 5. `POST /v1/purchase`

The body field is `sku`. Do not send `sku_id`. `pack.venue-hours` costs 20 credits, so the wallet needs a balance first.

```bash
curl -s -X POST "$BASE/v1/purchase" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"sku":"pack.venue-hours"}'
```

**201**

```json
{
  "purchase_id": "pur_…",
  "wallet_id": "wal_…",
  "sku": "pack.venue-hours",
  "credits_charged": 20,
  "balance_credits": 80,
  "created_at": "2026-01-01T00:00:00.000Z",
  "payload": {}
}
```

`payload` is the JSON pack or recipe. A short balance returns **402** `insufficient_credits` and does not deduct.

## 6. `GET /v1/purchases/:id`

```bash
curl -s "$BASE/v1/purchases/$PURCHASE_ID" \
  -H "authorization: Bearer $API_KEY"
```

**200** — same shape as the purchase response (`purchase_id`, `wallet_id`, `sku`, `credits_charged`, `balance_credits`, `created_at`, `payload`). The bearer token must own the purchase.

Errors are `{ "error": { "code": "…", "message": "…" } }`.
