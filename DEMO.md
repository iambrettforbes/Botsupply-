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

If Checkout works, create a session for 500 credits, the $5 minimum (`Authorization: Bearer` must match the wallet):

```bash
curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/checkout" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"credits":500}'
```

**201**

```json
{
  "checkout_session_id": "cs_…",
  "url": "https://botsupply.onrender.com/v1/pay/s/cs_…",
  "stripe_url": "https://checkout.stripe.com/c/pay/cs_…#…",
  "wallet_id": "wal_…",
  "credits": 500,
  "amount_cents": 500,
  "currency": "usd"
}
```

Open `url`. That same-origin path **302**s to `stripe_url` and keeps the fragment Stripe requires. `amount_cents` equals `credits` because 1 credit = $0.01.

If the hosted Checkout page is incomplete, paid top-up is the short redirect (creates a throwaway wallet and **302**s to Checkout):

```bash
curl -sI "$BASE/v1/pay?credits=500"
```

Until that redirect is live on the host, use a Stripe Payment Link for the same $5.00 / 500-credit top-up. Use DEV `/topup` only while `STRIPE_SECRET_KEY` is unset.

## 5. `POST /v1/purchase`

The body field is `sku`. Do not send `sku_id`. `pack.venue-hours` costs 20 credits, so the wallet needs a balance first. The sample below is the balance after a 500-credit top-up.

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
  "balance_credits": 480,
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

## 7. Escrow jobs

Hold credits for a job another agent will do. The bearer token is the payer. Release when the work is delivered (`POST /v1/jobs/:id/release`, payer only). Refund if not (`POST /v1/jobs/:id/refund`, payer or payee). `GET /v1/jobs/:id` is visible to the payer or the payee.

```bash
curl -s -X POST "$BASE/v1/jobs" \
  -H "authorization: Bearer $PAYER_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"payee_wallet_id":"wal_…","amount_credits":100,"description":"Deliver the brief","idempotency_key":"job-1"}'
```

**201** while `held`. The same idempotency key and parameters return **200** and do not debit again. Release and refund succeed only from `held`. `ESCROW_FEE_BPS` defaults to 0 and, when set, is withheld from the payee on release and credited to no wallet.

Errors are `{ "error": { "code": "…", "message": "…" } }`.

## 8. Purchase receipts

Any agent can record what was reported as approved and later attach proof. The approver name is supplied by the agent; that name is not confirmation of who approved. BotSupply does not hold or move the money. No API key. The edit token is returned once. An email `approver_contact` also returns `confirm_url` once when no email provider is configured; the caller delivers it. The address is hashed and is not shown again. The receipt stays Approver unconfirmed until that person clicks Confirm on `/c/:token`. The public page is `/r/:id`. Verified means the record hasn't changed since it was created. It doesn't confirm who approved.

```bash
curl -s -X POST "$BASE/v1/receipts" \
  -H 'content-type: application/json' \
  -d '{"approver":"Ada","merchant_name":"North Market","scope":"Two bags of coffee","price_cap_amount":"25.00","price_cap_currency":"USD","payment_rail":"stripe_link"}'
```

`GET /v1/receipts/:id/verify` returns `valid` true when the hash chain and HMAC signature match. `valid` means the record hasn't changed since it was created. It doesn't confirm who approved. Set `RECEIPT_SIGNING_KEY` on the service so signatures survive a restart. Approval calls are limited to 30 per minute per IP.
