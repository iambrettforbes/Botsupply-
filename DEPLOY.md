# Deploy BotSupply

The app is a single Node.js process. It listens on `0.0.0.0:$PORT` (default `4317`) and serves `GET /health` for platform checks. When `DATABASE_URL` is set, wallets, purchases, Checkout rows, and escrow jobs are stored in Postgres and tagged with the Stripe mode (`dev`, `test`, or `live`). Otherwise SQLite is stored at `/data/botsupply.sqlite` when that directory is writable, or at `./data/botsupply.sqlite`. Set `SQLITE_PATH` to override the file path.

**1 credit = $0.01 USD.** DEV top-up stays free until `STRIPE_SECRET_KEY` is set. Paid Checkout needs the Stripe variables below.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | Set by Render and by `fly.toml` | HTTP port. Defaults to `4317`. |
| `NODE_ENV` | No | `production` in the container and on Render. |
| `SQLITE_PATH` | No | Absolute path to the SQLite file. Used when `DATABASE_URL` is unset. |
| `DATABASE_URL` | No | Postgres connection string. When set, the process stores wallets, purchases, checkout sessions, credits, and escrow jobs in Postgres and pings that database from `/health`. |
| `ESCROW_FEE_BPS` | No | Platform fee in basis points, withheld from the payee when an escrow job is released. Integer 0 to 10000. Default 0. The fee is recorded on the job and credited to no wallet. |
| `STRIPE_SECRET_KEY` | No | Stripe secret key. When set, DEV top-up is disabled. The key prefix selects storage mode: `sk_test_`/`rk_test_` → `test`, `sk_live_`/`rk_live_` → `live`. |
| `STRIPE_WEBHOOK_SECRET` | With the secret key | Signing secret for `POST /v1/stripe/webhook`. |
| `PUBLIC_BASE_URL` | With the secret key | Public origin for Checkout success and cancel URLs, no trailing path. |

## Docker

```bash
docker build -t botsupply .
docker run --rm -p 4317:4317 botsupply
curl -s http://127.0.0.1:4317/health
```

The image is a multi-stage build. `docker-entrypoint.sh` starts as root only long enough to make `/data` writable, then runs the server as the unprivileged `nodejs` user. Render injects `PORT` at runtime (often `10000`); the process honors that value.

Local data disappears when the container is removed. Mount a volume if you want it kept:

```bash
docker run --rm -p 4317:4317 -v botsupply-data:/data botsupply
```

## Render

`render.yaml` defines one Docker web service:

- name: `botsupply`
- runtime: `docker`
- plan: `free`
- health check: `/health`
- region: `oregon`

Free web services spin down after about 15 minutes without traffic. The filesystem is ephemeral, so the SQLite file resets on every deploy, restart, or spin-down. With `DATABASE_URL` set to the internal URL of the Render Postgres instance, wallets and purchases survive those restarts. Rows are filtered by Stripe mode, and the webhook ignores events whose `livemode` belongs to the other mode. Do not put a persistent disk on the free plan; disks require a paid instance.

To keep SQLite across deploys, move the service to a paid plan and attach a 1 GB disk mounted at `/data`. The entrypoint chowns `/data` to `nodejs` before listen. Zero-downtime deploys are unavailable while a disk is attached, and the service stays on one instance.

### Apply the Blueprint

1. Push this repo to GitHub, including `render.yaml` and `Dockerfile`.
2. Open [the Blueprint deeplink](https://dashboard.render.com/blueprint/new?repo=https://github.com/iambrettforbes/Botsupply-).
3. Review the `botsupply` web service. `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` are `sync: false` — enter them in the Dashboard, not in git. `PUBLIC_BASE_URL` is `https://botsupply.onrender.com`.
4. Apply, then wait until the deploy is live.

The service is already live, so add keys on the existing service: Render Dashboard → **botsupply** → **Environment**. Set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `PUBLIC_BASE_URL=https://botsupply.onrender.com`, then save and redeploy. In Stripe, create a webhook endpoint `https://botsupply.onrender.com/v1/stripe/webhook` listening for `checkout.session.completed`, and store its signing secret as `STRIPE_WEBHOOK_SECRET`. Leave `STRIPE_SECRET_KEY` empty to keep the free DEV top-up.
5. Confirm `GET https://<service>.onrender.com/health` returns `"status":"ok"`. With Postgres and a test key that includes `"storage":"postgres"`, `"mode":"test"`, and `"database":"ok"`.

Render sets `PORT`. The Dockerfile does not hard-code it.

Validate the Blueprint locally when the Render CLI is installed and authenticated:

```bash
render whoami -o json
render blueprints validate
```

## Fly.io

`fly.toml` builds the same Dockerfile, sets `PORT=4317`, and checks `GET /health`.

```bash
fly launch --copy-config --no-deploy
fly deploy
curl -s "https://<app>.fly.dev/health"
```

Change `app` in `fly.toml` if `botsupply` is already taken. Without a volume, SQLite is ephemeral. To persist it:

```bash
fly volumes create botsupply_data --region iad --size 1
```

Then add this to `fly.toml` and redeploy:

```toml
[mounts]
  source = "botsupply_data"
  destination = "/data"
```

A volume pins the app to one machine in that region.
