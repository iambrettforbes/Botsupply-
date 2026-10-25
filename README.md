# BotSupply

[![iambrettforbes/Botsupply- MCP server](https://glama.ai/mcp/servers/iambrettforbes/Botsupply-/badges/score.svg)](https://glama.ai/mcp/servers/iambrettforbes/Botsupply-)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**Free, rail-agnostic purchase receipts for AI agents.** Live at [https://botsupply.onrender.com](https://botsupply.onrender.com).

`record_approval` logs what a person approved — merchant, scope, price cap, and rail — as a public tamper-evident receipt link. The record is a SHA-256 hash chain. The latest hash is signed with HMAC-SHA256 (`RECEIPT_SIGNING_KEY`). `GET /v1/receipts/:id/verify` recomputes that chain. **Verified** means the record has not changed since it was created. It does not confirm who approved.

An email contact gets a one-time Confirm link. The public line is **Approver confirmed** after the person who opens that link clicks Confirm. BotSupply does not send the email. The caller delivers `confirm_url`. There is no identity check.

`pay_allowed` is true only after Confirm, or when no approver contact was given and the price cap is strictly under `RECEIPT_CONFIRM_THRESHOLD` (default **100**, in the price cap's currency). `record_payment` then flags **Paid before confirmation** and **Over approved cap** instead of rejecting those payments. `attach_proof` adds delivery proof. Emails and phones are masked on public pages. A `redacted` public view can hide more. See below.

**BotSupply never holds or moves the purchase money.** No wallet is required for a receipt.

Also included: prepaid credit wallets with live Stripe Checkout top-ups, and escrow jobs between agents.

Agent skill: `npx skills add iambrettforbes/Botsupply-` (see [skills/botsupply-receipts/SKILL.md](skills/botsupply-receipts/SKILL.md)).

## 10-minute quickstart

MCP endpoint:

```text
https://botsupply.onrender.com/mcp
```

```bash
npx add-mcp 'https://botsupply.onrender.com/mcp'
# or
claude mcp add --transport http botsupply 'https://botsupply.onrender.com/mcp'
```

Install notes: [MCP_INSTALL.md](MCP_INSTALL.md). REST: [AGENT_INSTALL.md](AGENT_INSTALL.md). Demo: [DEMO.md](DEMO.md).

Record an approval. Keep `edit_token`. If you passed an email, deliver `confirm_url` to that person yourself.

```bash
curl -s -X POST https://botsupply.onrender.com/v1/receipts \
  -H 'content-type: application/json' \
  -d '{"approver":"Ada","approver_contact":"ada@example.com","merchant_name":"North Market","scope":"Two bags of coffee","price_cap_amount":"25.00","price_cap_currency":"USD","payment_rail":"stripe_link"}'
```

Poll until `pay_allowed` is true, then pay on your own rail.

```bash
curl -s "https://botsupply.onrender.com/v1/receipts/$RECEIPT_ID"
```

Record what you paid, attach proof, and check the signature.

```bash
curl -s -X POST "https://botsupply.onrender.com/v1/receipts/$RECEIPT_ID/payment" \
  -H 'content-type: application/json' \
  -d '{"edit_token":"…","external_payment_ref":"pi_123","amount":"25.00"}'

curl -s -X POST "https://botsupply.onrender.com/v1/receipts/$RECEIPT_ID/proof" \
  -H 'content-type: application/json' \
  -d '{"edit_token":"…","type":"order_confirmation","value":"ord_123"}'

curl -s "https://botsupply.onrender.com/v1/receipts/$RECEIPT_ID/verify"
```

The public page is `https://botsupply.onrender.com/r/$RECEIPT_ID`.

## MCP tools (15)

### Purchase receipts (no wallet, free)

| Tool | What it does |
| --- | --- |
| `record_approval` | Write what was reported as approved. The approver name is supplied by the agent. An email contact gets a one-time confirm link returned as `confirm_url` for the caller to deliver. Optional `public_view` (`full` or `redacted`) and `public_scope`. Returns `receipt_id`, public `receipt_url`, and a one-time `edit_token`. |
| `attach_proof` | Attach delivery proof with the `edit_token`. |
| `record_payment` | Record a payment the agent already made (`edit_token`). Appends `payment_recorded`. Flags `paid_before_confirmation` and `over_cap` instead of rejecting them. |
| `set_receipt_visibility` | Change `public_view` later with the `edit_token`. Optional `public_scope`. Does not change the hash. |
| `get_receipt` | Public receipt JSON, including `approver_confirmation`, `pay_allowed`, and `public_view`. Pay only when `pay_allowed` is true. |
| `verify_receipt` | Recompute the hash chain and HMAC. `valid` means the record has not changed. It does not confirm who approved. |

Public HTML page: `GET /r/:id` (Verified or Tampered badge, and a separate Approver unconfirmed / Approver confirmed ✓ / Approver declined line).

### Wallets and catalog

| Tool | What it does |
| --- | --- |
| `list_catalog` | List live SKUs and credit prices. |
| `open_wallet` | Create a wallet. API key returned once. |
| `get_balance` | Prepaid credit balance. |
| `purchase` | Buy one catalog SKU with credits. |
| `create_checkout` | Live Stripe Checkout top-up (500 to 100000 credits, $5 to $1,000). |

### Escrow (prepaid credits)

| Tool | What it does |
| --- | --- |
| `create_job` | Hold credits for another agent. |
| `get_job` | Read a job. |
| `release_job` | Pay the payee. |
| `refund_job` | Return the hold to the payer. |

## Purchase receipts

An agent records what was reported as approved on any payment rail (`stripe_link`, `card`, `x402`, `botsupply_wallet`, or another label) and later attaches proof. The approver name is text the agent typed. BotSupply stores that record and a public URL. **It does not hold or move the money.** No wallet and no API key are required.

The response includes `receipt_id` (`rcpt_` + 24 hex), `receipt_url`, and `edit_token` (returned once). When `approver_contact` is an email, the response also includes `confirm_url` (returned once) while no email provider is configured. The address itself is not returned.

### Approver confirmation

Passing an email as `approver_contact` (a string, or `{ "channel": "email", "address": "ada@example.com" }`) issues one confirm link, `/c/:token`. The token is unguessable, stored only as a SHA-256 hash, expires (default 24 hours, `RECEIPT_CONFIRM_TTL_SECONDS`), and works once. `sms` is reserved and rejected until a sender exists. A non-email string is stored only as a hash and does not issue a link.

The approver opens the link and sees the scope, price cap, merchant, and requesting agent, with Confirm and Decline buttons. That page shows the stored text, including when the public receipt is redacted, so the person can see what they are confirming. Opening the link does not decide anything. The buttons POST. Confirm and decline are hash-chain events. The public state is then:

- **Approver unconfirmed** — default, including receipts created before this step
- **Approver confirmed ✓** — the person with access to that contact clicked Confirm, with time and channel
- **Approver declined** — that person clicked Decline

Confirmed does not mean BotSupply checked a legal identity, and it does not mean the agent-reported name was proven. The Verified badge still only means the hash chain and HMAC match.

### Confirm before pay

`pay_allowed` is the contract the paying agent follows. It is true only when `approver_confirmation.status` is `confirmed`, or when no `approver_contact` was given and the price cap is strictly under `RECEIPT_CONFIRM_THRESHOLD` (default **100**). At or above that threshold, `record_approval` without an email contact still succeeds, the receipt shows "No approver contact; confirmation required above threshold", and `pay_allowed` stays false.

Poll `get_receipt` and pay only when `pay_allowed` is true. `POST /v1/receipts/:id/payment` (`record_payment`) records what was paid. It requires `edit_token`, `external_payment_ref`, and `amount`. `paid_at` is optional and defaults to now. The call appends a signed `payment_recorded` event. It sets `paid_before_confirmation` when the payment time is before the confirm event, or when a contact was set and the receipt was never confirmed. It sets `over_cap` when `amount` exceeds the price cap. Those payments are stored and flagged. They are not rejected.

On a later read, `external_payment_ref` is the latest recorded payment's ref, taken from `receipt_payments` at read time. The stored receipt column is not rewritten, so existing hashes still verify. When no payment has been recorded, the approval-time ref is shown (or none). Top-level `paid_before_confirmation` and `over_cap` are true when any recorded payment has that flag, and false otherwise. They are also derived at read time. The response from attaching a proof still reports that proof's own `over_cap` at the top level. The next `get_receipt` uses the payment-derived flags. Each proof keeps its own `over_cap`.

The public page lists Approved by agent report, Approver confirmed, and Paid, with times, then a green "Confirmed before payment" line or a red "Paid before confirmation" / "Over approved cap" line. The Price cap section shows the same latest payment ref.

In the default `full` view, email addresses and phone numbers in the approver name, scope, merchant name, or proof value are masked (for example `i***@gmail.com`). Stored rows and hash-chain payloads are unchanged.

### Redacted public view

`public_view` is `full` (default) or `redacted`. It is stored on the receipt outside the hash snapshot. Changing it does not change the content hash, the signature, or `updated_at`. Pass it on `record_approval`, or later:

```bash
curl -s -X POST "https://botsupply.onrender.com/v1/receipts/$RECEIPT_ID/visibility" \
  -H 'content-type: application/json' \
  -d '{"edit_token":"…","public_view":"redacted","public_scope":"Two bags of coffee"}'
```

MCP: `set_receipt_visibility`. Omit `public_scope` to leave the stored public scope unchanged.

While `redacted`, the public JSON and `/r/:id` show:

- Approver as initials only (`Brett Forbes` becomes `B.F.`)
- Agent name as `Agent` (the agent id is omitted)
- No email or phone, not even masked
- Payment refs and proof values as `on file` plus the last 4 characters that remain after card phrases such as `ending 1234` are removed
- Merchant name and URL kept (emails and phones stripped from the name)
- Scope kept, with those same contact and card phrases removed, unless `public_scope` is set, which replaces the public scope
- Amounts, price cap, timeline, statuses, the confirmed and paid lines, and verify results stay visible

The receipt page adds a quiet note: "Some details hidden by the purchaser."

`verify` still checks the full stored row. `valid` does not depend on the display setting.

Optional `confirmation_webhook_url` (public https only) receives `{ "receipt_id", "approver_confirmation" }` after the click. Delivery is best-effort. Poll `get_receipt` if it does not arrive.

Email sending is behind `ApprovalNotifier`. **No email provider is included.** Leave `RECEIPT_EMAIL_PROVIDER` unset (or `none`). The confirm link is returned as `confirm_url` with `confirm_delivery: "caller"`. A future provider would read `RECEIPT_EMAIL_FROM` and `RECEIPT_EMAIL_API_KEY`. Those are unused today.

Confirm attempts are rate-limited (30/min/IP), separate from the approval limit (30/min/IP). The contact address is stored only as a SHA-256 hash. A masked form appears on a `full` receipt only after Confirm or Decline. Each hash-chain change is SHA-256. The latest hash is HMAC-SHA256. Set `RECEIPT_SIGNING_KEY` to a long random secret. If it is unset, an ephemeral key is generated and signatures will not verify after a restart.

Startup adds nullable confirmation columns and `receipt_payments`. It also adds `public_view` (default `full`) and `public_scope`. Older rows keep their signatures. The confirmation object is omitted from the hash snapshot until a decision exists, `payments` is omitted until a payment is recorded, and `public_view` is never in the snapshot.

## Wallets and credits

**1 credit = $0.01 USD.** Agents open a wallet, top up with live Stripe Checkout, and buy JSON products from the catalog.

`POST /v1/wallets/:id/topup` is a free development top-up only when `STRIPE_SECRET_KEY` is unset. When `STRIPE_SECRET_KEY` is set, that route returns **403** and agents pay with Checkout. Paid top-ups are **500 to 100000 credits ($5 to $1,000)**.

### Catalog

| SKU | Kind | Credits | Intended retail |
| --- | --- | ---: | ---: |
| `pack.competitor-snapshot` | pack | 50 | $0.50 |
| `pack.venue-hours` | pack | 20 | $0.20 |
| `recipe.book-table` | recipe | 100 | $1.00 |

`pack.competitor-snapshot` is a Cobble Hill casual-dining competitive set. `pack.venue-hours` is weekly hours and reservation policy for those venues. `recipe.book-table` is an executable booking recipe the agent runs itself (buying it does not place a reservation). Payloads are delivered on purchase.

## Escrow jobs

One agent can hold credits for another. `POST /v1/jobs` debits the payer and marks the job `held`. Release pays the payee. Refund returns the hold. Writes run in one database transaction. `ESCROW_FEE_BPS` defaults to **0**.

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

When `DATABASE_URL` is set, wallets, purchases, checkout sessions, credited Checkout sessions, escrow jobs, and receipts are stored in **Postgres**. Each row is tagged `dev`, `test`, or `live` from the Stripe secret key prefix (`sk_test_` / `rk_test_` → test, `sk_live_` / `rk_live_` → live, unset → dev). Lookups include that tag, so each mode reads only its own rows.

When `DATABASE_URL` is unset, the same records stay in a **SQLite** file (`SQLITE_PATH`, or `/data/botsupply.sqlite` if writable, else `./data/botsupply.sqlite`).

The hosted service uses Postgres. With a live Stripe key, `/health` reports `"storage":"postgres","mode":"live"`.

## API (summary)

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/receipts` | Record what was reported as approved (no auth). Email contact also issues a confirm link. Optional `public_view` and `public_scope`. |
| `POST` | `/v1/receipts/:id/proof` | Attach proof (`edit_token`) |
| `POST` | `/v1/receipts/:id/payment` | Record a payment the agent already made (`edit_token`). Flags early and over-cap payments. |
| `POST` | `/v1/receipts/:id/visibility` | Set `public_view` (`edit_token`). Does not change the hash. |
| `GET` | `/v1/receipts/:id` | Public JSON, including `approver_confirmation`, `pay_allowed`, and `public_view` |
| `GET` | `/v1/receipts/:id/verify` | Integrity check and confirmation state |
| `GET` | `/r/:id` | Public HTML receipt |
| `GET` | `/c/:token` | Confirm page. Does not decide. Shows the stored text. |
| `POST` | `/c/:token/confirm` | One-time confirm |
| `POST` | `/c/:token/decline` | One-time decline |
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

### Stripe on Render

| Key | Value |
| --- | --- |
| `STRIPE_SECRET_KEY` | Live key `sk_live_…` on the hosted service. A test key `sk_test_…` selects test storage for a self-hosted process. Do not commit it. |
| `STRIPE_WEBHOOK_SECRET` | `whsec_…` for `checkout.session.completed` |
| `PUBLIC_BASE_URL` | `https://botsupply.onrender.com` |
| `RECEIPT_SIGNING_KEY` | Long random secret for receipt HMAC |
| `RECEIPT_CONFIRM_TTL_SECONDS` | Confirm link lifetime. Default 86400 (24 hours). |
| `RECEIPT_CONFIRM_THRESHOLD` | Price-cap units at or above which a receipt with no email approver contact has `pay_allowed` false. Default 100. |
| `RECEIPT_EMAIL_PROVIDER` | Leave unset. No email provider ships in this build. The caller delivers `confirm_url`. |

Webhook endpoint: `https://botsupply.onrender.com/v1/stripe/webhook`.

## Tests

```bash
npm test
```

Covers wallets, catalog purchases, Stripe credit application (fake client), escrow, and purchase receipts (create, proof, verify, tamper, confirm, payment flags, derived payment ref, and the redacted public view).

## Deploy

Docker, Render, and Fly.io: [DEPLOY.md](DEPLOY.md).

## License

[MIT](LICENSE)
