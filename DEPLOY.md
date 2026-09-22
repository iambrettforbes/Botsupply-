# Deploy BotSupply

The app is a single Node.js process. It listens on `0.0.0.0:$PORT` (default `4317`) and serves `GET /health` for platform checks. SQLite is stored at `/data/botsupply.sqlite` when that directory is writable, otherwise at `./data/botsupply.sqlite`. Set `SQLITE_PATH` to override.

**1 credit = $0.01 intended retail.** Top-ups are a development convenience. There is no Stripe billing to configure.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `PORT` | Set by Render and by `fly.toml` | HTTP port. Defaults to `4317`. |
| `NODE_ENV` | No | `production` in the container and on Render. |
| `SQLITE_PATH` | No | Absolute path to the SQLite file. |

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

Free web services spin down after about 15 minutes without traffic. The filesystem is ephemeral, so wallets and purchases reset on every deploy, restart, or spin-down. That matches a development marketplace. Do not put a persistent disk on the free plan; disks require a paid instance.

To keep SQLite across deploys, move the service to a paid plan and attach a 1 GB disk mounted at `/data`. The entrypoint chowns `/data` to `nodejs` before listen. Zero-downtime deploys are unavailable while a disk is attached, and the service stays on one instance.

### Apply the Blueprint

1. Push this repo to GitHub, including `render.yaml` and `Dockerfile`.
2. Open [the Blueprint deeplink](https://dashboard.render.com/blueprint/new?repo=https://github.com/iambrettforbes/Botsupply-).
3. Review the `botsupply` web service. There are no secrets to fill in.
4. Apply, then wait until the deploy is live.
5. Confirm `GET https://<service>.onrender.com/health` returns `{"status":"ok","service":"botsupply"}`.

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
