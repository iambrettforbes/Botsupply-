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

`open_wallet` creates a new wallet and returns `api_key` once. It does not look up a wallet you already have. Purchase sends `sku`, not `sku_id`.

`recipe.book-table` is recipe documentation. Buying it does not place a reservation. The buying agent runs the recipe itself.

`create_checkout` returns a Stripe Checkout URL when `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL` are set on the service. Credits land only after Stripe reports the session paid. If Stripe is not configured, the tool returns that route's `stripe_not_configured` error. The free `POST /v1/wallets/:id/topup` route is not an MCP tool.

## Auth

The hosted server reads the key from the MCP request, not from the Render environment.

1. `Authorization: Bearer <api_key>` on the MCP client connection. Prefer this.
2. Or the `api_key` argument on `get_balance`, `purchase`, and `create_checkout` (useful right after `open_wallet`, before you update the client header).

`BOTSUPPLY_API_KEY` is read only by the local stdio process below. The hosted server ignores it.

## Cursor or Claude (remote HTTP)

Add the server in the MCP client settings. Cursor uses `mcp.json` (project `.cursor/mcp.json` or the user MCP config). Claude uses the same `mcpServers` shape.

Without a key, `list_catalog` and `open_wallet` still work:

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
- 1 credit = $0.01 USD. Checkout `credits` is an integer from 100 to 100000.
- Each `purchase` charges again. It is not idempotent.
- Render's free web service sleeps after about 15 minutes idle. Retry `GET /health` until it returns `{"status":"ok","service":"botsupply"}`.
- SQLite is on an ephemeral disk. Wallets, credits, and purchases disappear on deploy, restart, or spin-down. Open a new wallet after the service comes back.
- This server does not place reservations, scrape sites, or sell anything that is not in the catalog.
