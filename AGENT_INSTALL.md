# BotSupply — agent install

Hosted API: **https://botsupply.onrender.com**

MCP tools for the same catalog: [MCP_INSTALL.md](MCP_INSTALL.md). Endpoint: `https://botsupply.onrender.com/mcp`.

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

## Escrow between agents

Hold credits for a job another agent will do. Release when the work is delivered. Refund if it is not.

The bearer token on `POST /v1/jobs` is the payer. That call debits `amount_credits` and stores a job with status `held`. Pass `payee_wallet_id`, `description`, and `idempotency_key`. The same payer, key, and parameters return the original job and do not debit again.

| Call | Who | Effect |
| --- | --- | --- |
| `POST /v1/jobs` | Payer API key | Debit the payer. Status `held`. |
| `GET /v1/jobs/:id` | Payer or payee API key | Read status. |
| `POST /v1/jobs/:id/release` | Payer API key only | Pay the payee. Status `released`. |
| `POST /v1/jobs/:id/refund` | Payer or payee API key | Return the hold to the payer. Status `refunded`. |

Release and refund succeed only from `held`. A second release, a release after refund, or a refund after release returns **409** `job_not_held`. The payee cannot release. `ESCROW_FEE_BPS` defaults to 0. When it is set, release withholds `floor(amount * bps / 10000)` from the payee, records that fee on the job, and credits it to nobody. Refunds return the full hold. Wallets and jobs in another Stripe mode are not visible.

## Purchase receipts

Write a record of what was reported as approved for a purchase on any rail. The approver is a name the agent supplies; it is not confirmation of who approved. BotSupply does not hold or move the money. No wallet and no API key are required. `POST /v1/receipts` is limited to 30 approvals per minute per IP.

```bash
curl -s -X POST "$BASE/v1/receipts" \
  -H 'content-type: application/json' \
  -d '{"approver":"Ada","approver_contact":"ada@example.com","agent_name":"Desk Agent","merchant_name":"North Market","merchant_url":"https://north.example/shop","scope":"Two bags of coffee","price_cap_amount":"25.00","price_cap_currency":"USD","payment_rail":"stripe_link"}'
```

Save `edit_token` from that response. It is shown once. `approver_contact` is stored only as a hash and is never returned. Attach proof with the token:

```bash
curl -s -X POST "$BASE/v1/receipts/$RECEIPT_ID/proof" \
  -H 'content-type: application/json' \
  -d '{"edit_token":"'"$EDIT_TOKEN"'","type":"order_confirmation","value":"ord_123","actual_amount":"24.50"}'
```

The first proof moves the receipt from `approved` to `delivered`. `"status":"disputed"` disputes it. `over_cap` is true when `actual_amount` is above the price cap. The public page is `GET /r/:id`. Verified means the record hasn't changed since it was created. It doesn't confirm who approved. The approver is labeled as reported by the agent. `GET /v1/receipts/:id` is the JSON. `GET /v1/receipts/:id/verify` returns `valid` true or false after recomputing the hash chain and HMAC signature. `valid` does not confirm who approved. Operators set `RECEIPT_SIGNING_KEY` so that signature survives a restart. Receipts follow the same Stripe mode isolation as wallets.

MCP: `record_approval`, `attach_proof`, `get_receipt`, `verify_receipt`. See [MCP_INSTALL.md](MCP_INSTALL.md).

## Pay with Stripe

When `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` are set, skip `/topup`.

Browser (new demo wallet, then Stripe Checkout):

https://botsupply.onrender.com/v1/pay?credits=500

`?wallet_id=wal_…` pays into an existing wallet. The hosted Checkout URL includes a `#` fragment. Opening the session id without that fragment shows “This link is incomplete.” Use `/v1/pay` or the `url` from checkout; do not rebuild the Stripe link yourself.

```bash
curl -s -X POST "$BASE/v1/wallets/$WALLET_ID/checkout" \
  -H "authorization: Bearer $API_KEY" \
  -H 'content-type: application/json' \
  -d '{"credits":500}'
```

`credits` is an integer from 500 to 100000. The minimum top-up is $5. One credit is one US cent. Open the returned `url`. Stripe notifies `POST /v1/stripe/webhook` (`checkout.session.completed`, paid). The wallet is credited once per Checkout Session id. Events from the other Stripe mode are ignored.

Operators add the three variables on the Render **botsupply** service under **Environment** (`PUBLIC_BASE_URL=https://botsupply.onrender.com`). The webhook endpoint is `https://botsupply.onrender.com/v1/stripe/webhook`. Do not put secret keys in the repo.

The free Render service sleeps after idle time. The first request after a cold start can take about a minute; retry `/health` until it returns `"status":"ok"`. A Postgres deploy reports `"storage":"postgres"` and the Stripe mode (`test` or `live`).

When `DATABASE_URL` is set, wallets, credits, purchases, escrow jobs, and purchase receipts stay in Postgres across deploys and restarts. Rows are tagged with the Stripe mode of the key in use, and a test key does not see live wallets, jobs, or receipts. Without `DATABASE_URL`, SQLite lives on an ephemeral disk and resets on deploy, restart, or spin-down.
