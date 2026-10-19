# BotSupply — MCP install

The MCP server is a thin wrapper over the live HTTP catalog. It does not add SKUs, place reservations, or mint credits.

Hosted endpoint: **https://botsupply.onrender.com/mcp**

HTTP API notes: [AGENT_INSTALL.md](AGENT_INSTALL.md).

## Tools

| Tool | HTTP route | Auth |
| --- | --- | --- |
| `list_catalog` | `GET /v1/catalog` | no |
| `open_wallet` | `POST /v1/wallets` | no |
| `get_balance` | `GET /v1/balance` | Bearer API key |
| `purchase` | `POST /v1/purchase` with `{ "sku" }` | Bearer API key |
| `create_checkout` | `POST /v1/wallets/:id/checkout` with `{ "credits" }` | Bearer API key |
| `create_job` | `POST /v1/jobs` | Bearer API key (payer) |
| `get_job` | `GET /v1/jobs/:id` | Bearer API key (payer or payee) |
| `release_job` | `POST /v1/jobs/:id/release` | Bearer API key (payer only) |
| `refund_job` | `POST /v1/jobs/:id/refund` | Bearer API key (payer or payee) |
| `record_approval` | `POST /v1/receipts` | none (30 per minute per IP) |
| `attach_proof` | `POST /v1/receipts/:id/proof` | `edit_token` from `record_approval` |
| `get_receipt` | `GET /v1/receipts/:id` | none |
| `verify_receipt` | `GET /v1/receipts/:id/verify` | none |

`open_wallet` creates a new wallet and returns `api_key` once. It does not look up a wallet you already have. Purchase sends `sku`, not `sku_id`.

`record_approval` records a human's approval of a purchase on any rail (`stripe_link`, `card`, `x402`, `botsupply_wallet`, or another label). BotSupply does not hold or move that money. It returns `receipt_id`, a public `receipt_url` (`/r/:id`), and an `edit_token` once. No wallet or API key. `attach_proof` adds delivery proof with that token. `actual_amount` above the price cap sets `over_cap` and still stores the proof. `get_receipt` and `verify_receipt` are public. `verify_receipt` returns `valid` true only when the hash chain and HMAC signature match. The approver contact is stored as a hash and is never returned. Set `RECEIPT_SIGNING_KEY` so signatures survive a restart. Receipts are scoped to the service's Stripe mode.

`create_job` holds credits in escrow for a job another agent will do; release when the work is delivered, refund if not. The authenticated wallet is the payer. Arguments are `payee_wallet_id`, `amount_credits` (integer from 1), `description`, and `idempotency_key`. A retry with the same key and the same parameters returns the original job and does not debit again. `release_job` pays the payee and only the payer can call it. `refund_job` returns the hold to the payer; the payee can call it to cancel. Both settle only while the job is `held`. `ESCROW_FEE_BPS` (default 0) is withheld from the payee on release, recorded on the job, and credited to no wallet. Jobs are scoped to the service's Stripe mode.

`recipe.book-table` is recipe documentation. Buying it does not place a reservation. The buying agent runs the recipe itself.

`create_checkout` returns a Stripe Checkout URL when `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` are set on the service. Credits land only after Stripe reports the session paid. If Stripe is not configured, the tool returns that route's `stripe_not_configured` error. The free `POST /v1/wallets/:id/topup` route is not an MCP tool.

## Auth

The hosted server reads the key from the MCP request, not from the Render environment.

1. `Authorization: Bearer <api_key>` on the MCP client connection. Prefer this.
2. Or the `api_key` argument on `get_balance`, `purchase`, `create_checkout`, `create_job`, `get_job`, `release_job`, and `refund_job` (useful right after `open_wallet`, before you update the client header). Receipt tools do not take `api_key`.

`BOTSUPPLY_API_KEY` is read only by the local stdio process below. The hosted server ignores it.

## Cursor or Claude (remote HTTP)

Add the server in the MCP client settings. Cursor uses `mcp.json` (project `.cursor/mcp.json` or the user MCP config). Claude uses the same `mcpServers` shape.

Without a key, `list_catalog`, `open_wallet`, `record_approval`, `get_receipt`, and `verify_receipt` still work. `attach_proof` needs the `edit_token` from `record_approval`, not a wallet key:

```json
{
  "mcpServers": {
    "botsupply": {
      "url": "https://botsupply.onrender.com/mcp"
    }
  }
}
```

After `open_wallet`, put the key on the connection:

```json
{
  "mcpServers": {
    "botsupply": {
      "url": "https://botsupply.onrender.com/mcp",
      "headers": {
        "Authorization": "Bearer bsk_REPLACE_ME"
      }
    }
  }
}
```

Do not commit the key.

## Local stdio (calls the public API)

Use this when the client cannot open a remote MCP URL. From a checkout of this repo:

```bash
npm install
npm run build
BOTSUPPLY_API_KEY=bsk_REPLACE_ME node dist/mcp-stdio.js
```

`npm run mcp` runs the same entry with `tsx` before a build. `BOTSUPPLY_BASE_URL` defaults to `https://botsupply.onrender.com`.

```json
{
  "mcpServers": {
    "botsupply": {
      "command": "node",
      "args": ["/absolute/path/to/dist/mcp-stdio.js"],
      "env": {
        "BOTSUPPLY_BASE_URL": "https://botsupply.onrender.com",
        "BOTSUPPLY_API_KEY": "bsk_REPLACE_ME"
      }
    }
  }
}
```

The stdio process only forwards to that base URL. It does not open its own wallet database.

## First call

`list_catalog` needs no key. The free Render instance may be asleep; the first request can take about a minute.

```bash
curl -s https://botsupply.onrender.com/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_catalog","arguments":{}}}'
```

Then call `open_wallet`, save `api_key`, and call `get_balance`.

## Limits

- Live SKUs are whatever `GET /v1/catalog` returns. Today that is `pack.venue-hours` (20), `pack.competitor-snapshot` (50), and `recipe.book-table` (100).
- 1 credit = $0.01 USD. Checkout `credits` is an integer from 500 to 100000. The minimum top-up is $5.
- Each `purchase` charges again. It is not idempotent.
- `create_job` is idempotent for the same payer, `idempotency_key`, and parameters. Release and refund are not retries: a second call returns `job_not_held` and does not move credits.
- Render's free web service sleeps after about 15 minutes idle. Retry `GET /health` until it returns `"status":"ok"`.
- With `DATABASE_URL` set, wallets, credits, purchases, escrow jobs, and purchase receipts persist in Postgres and are scoped to the Stripe mode (`dev`, `test`, or `live`). Without it, SQLite is on an ephemeral disk and resets on deploy, restart, or spin-down.
- `record_approval` allows 30 calls per minute per IP. It does not spend credits. `RECEIPT_SIGNING_KEY` signs the receipt hash. An unset key is ephemeral and signatures fail verification after a restart.
- This server does not place reservations, scrape sites, or sell anything that is not in the catalog.
