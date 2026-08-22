> **Status (2026-08-22):** production runtime is **Cloudflare Workers + Browser Run** (see `worker/`). This Docker image is the VPS *fallback* only — Rob's directive is cloud-only, no homelab. Ignore the NAS sections unless the Cloudflare path is abandoned.

# Deploying the PVD311 automation server (Docker)

Containerized deployment of the dashboard + Playwright submission engine
(`automation/`). Target order: **Synology NAS first** (residential IP the portal
trusts), small **VPS second**.

The image is built on `mcr.microsoft.com/playwright:v1.58.2-noble`, pinned to the
`playwright` version in `package.json`. It bundles a matching Chromium and its OS
libraries, so no browser is downloaded at build time. It runs headless as the
image's non-root `pwuser` (Chromium's sandbox refuses to run as root, and the
code launches with `--disable-dev-shm-usage` but not `--no-sandbox`).

---

## 1. What runs

- `node dist/automation/src/index.js --auto` — the HTTP dashboard on port **3311**
  plus the polling auto-submission engine (`--auto`).
- Auth state and proof screenshots persist on a named volume at `/data`.
- The dashboard has **no authentication**, so the host publishes it to
  **loopback only** (`127.0.0.1:3311`). Reach it via an SSH tunnel (§7).

---

## 2. Prerequisites

- Docker Engine + Compose v2 (Synology **Container Manager 24.0.2+**, or any
  x86-64 host with `docker` + `docker compose`). The base image is amd64/arm64;
  a Synology x86 box (e.g. DS920+/DS923+) is fine.
- Outbound HTTPS from the host to: `311.providenceri.gov`, Google/Firebase,
  `api.anthropic.com` (scout), and `api.telegram.org` (HITL/alerts).
- The repo checked out on the host (the build needs both `automation/` and the
  sibling `shared/` — see §9).

---

## 3. Files you provide on the host

In `automation/`:

| File | What |
| --- | --- |
| `.env` | Secrets + tunables (template in §5). Not committed. |
| `firebase-service-account.json` | Firebase Admin key (§6). Not committed. |

Everything else (Dockerfile, compose, .dockerignore) is in the repo.

---

## 4. Quick start (NAS or VPS, over SSH)

```bash
cd /path/to/pvd311/automation

# 1. Create .env  (see the template in §5) and drop in the Firebase key (§6)
vi .env
cp /path/to/your/firebase-service-account.json ./firebase-service-account.json
chmod 644 firebase-service-account.json        # readable by pwuser (uid 1000)

# 2. Build + start (compose sets the build context to the repo root for you)
docker compose up -d --build

# 3. Watch it come up — first run logs in to the portal headlessly (§8)
docker compose logs -f
docker compose ps                               # STATUS should show "healthy"
```

The container restarts automatically (`restart: unless-stopped`) and on NAS
reboot once Container Manager starts.

---

## 5. Create `.env`

Only `PORTAL_EMAIL` and `PORTAL_PASSWORD` are strictly required here
(`FIREBASE_SERVICE_ACCOUNT_PATH` is set to the mounted path by compose). Copy
this template into `automation/.env` and fill it in:

```dotenv
# ── Required: portal login (headless auth uses these) ──
PORTAL_EMAIL=you@example.com
PORTAL_PASSWORD=your-portal-password

# ── Firebase key: host path to the service-account JSON ──
# Leave unset to use ./firebase-service-account.json next to the compose file.
# FIREBASE_SERVICE_ACCOUNT_HOST_PATH=/volume1/docker/pvd311/firebase-service-account.json

# ── Portal behavior ──
# Update method the city sees: 585680003 No Contact (launch default),
# 585680002 Email, 585680001 Text, 585680000 Phone, 585680004 Portal Comment.
PORTAL_NOTIFICATION_METHOD=585680003
APP_NAME=PVD311 app

# ── Human-in-the-loop / review (launch mode = review) ──
HITL_MODE=review           # review | ramp | auto
TRUST_RAMP_N=3
TELEGRAM_BOT_TOKEN=         # set to enable Telegram approvals/alerts
TELEGRAM_CHAT_ID=7744052689

# ── Agent scout (fills unmapped Step-3 fields) ──
ANTHROPIC_API_KEY=          # required for scout; without it unmapped types fail
SCOUT_MODEL=claude-opus-5
SCOUT_MIN_CONFIDENCE=0.7

# ── Safety ──
BLOCKED_ADDRESSES=congdon st,congdon street

# ── Status watcher (optional) ──
# WATCHER_ACTIVITY=false
# WATCHER_ACTIVITY_MAX=5
```

### Full environment reference

| Var | Required | Default | Set where | Purpose |
| --- | --- | --- | --- | --- |
| `PORTAL_EMAIL` | yes | — | `.env` | Portal account for headless login |
| `PORTAL_PASSWORD` | yes | — | `.env` | Portal account password |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | yes | `/run/secrets/firebase-service-account.json` | compose | Path to the mounted Admin key |
| `FIREBASE_SERVICE_ACCOUNT_HOST_PATH` | no | `./firebase-service-account.json` | `.env` | **Host** path bind-mounted to the above (compose-only) |
| `HEADLESS` | — | `true` | image/compose | Run Chromium headless |
| `HOST` | — | `0.0.0.0` | image | Bind inside the container (must be `0.0.0.0` for Docker port mapping — see §7) |
| `PORT` | — | `3311` | image | Dashboard port |
| `AUTH_STATE_PATH` | — | `/data/.auth-state.json` | image | Persisted portal session |
| `PROOF_DIR` | — | `/data/proofs` | image | Proof screenshots |
| `PORTAL_NOTIFICATION_METHOD` | no | `585680003` | `.env` | City contact method code |
| `APP_NAME` | no | `PVD311 app` | `.env` | Label used in submissions |
| `HITL_MODE` | no | `review` | `.env` | `review` \| `ramp` \| `auto` |
| `TRUST_RAMP_N` | no | `3` | `.env` | Auto-approve after N successes (ramp) |
| `TELEGRAM_BOT_TOKEN` | no | — | `.env` | Enables Telegram approvals/alerts |
| `TELEGRAM_CHAT_ID` | no | `7744052689` | `.env` | Telegram chat for approvals/alerts |
| `ANTHROPIC_API_KEY` | for scout | — | `.env` | Agent scout for unmapped Step-3 fields |
| `SCOUT_MODEL` | no | `claude-opus-5` | `.env` | Scout model id |
| `SCOUT_MIN_CONFIDENCE` | no | `0.7` | `.env` | Below this → HITL instead of auto-fill |
| `BLOCKED_ADDRESSES` | no | `congdon st,congdon street` | `.env` | Substring blocklist |
| `WATCHER_ACTIVITY` | no | `false` | `.env` | Status watcher fetches activity detail |
| `WATCHER_ACTIVITY_MAX` | no | `5` | `.env` | Max activity records per poll |

> `.env` is passed into the container by compose (`env_file`) **and** is used for
> `${...}` interpolation in `docker-compose.yml`. Keep real secrets in `.env`,
> never in `docker-compose.yml`.

---

## 6. Firebase key

The Firebase Admin service-account JSON is **bind-mounted read-only** into the
container at `/run/secrets/firebase-service-account.json` and read by `config.ts`.

- Default: place the file at `automation/firebase-service-account.json`.
- Or point elsewhere: set `FIREBASE_SERVICE_ACCOUNT_HOST_PATH=/abs/host/path.json`
  in `.env`.
- The container runs as **uid 1000 (`pwuser`)**, so the file must be readable by
  that uid. Simplest for a homelab NAS: `chmod 644 firebase-service-account.json`.
  Tighter: `sudo chown 1000:1000 firebase-service-account.json && chmod 600 ...`
  (uid 1000 inside the container need not match a NAS user; ownership by numeric
  1000 is what matters).
- Note: this key uses the Admin SDK, which **bypasses Firestore/Storage security
  rules**. Keep it off any world-readable share.
- **Do not commit it.** `firebase-service-account.json` is not currently covered
  by `.gitignore` (unlike `.env`, `dist/`, `.auth-state.json`, `proofs/`). Either
  add `firebase-service-account.json` to `automation/.gitignore`, or keep the key
  outside the repo entirely and point `FIREBASE_SERVICE_ACCOUNT_HOST_PATH` at it.
  Never `git add -A` with the key sitting in `automation/`.

---

## 7. Networking & the unauthenticated dashboard

`docker-compose.yml` publishes the port as `127.0.0.1:3311:3311` — reachable only
from the **host's** loopback, never the LAN/WAN. Two layers make this work:

1. **Inside** the container the server binds `0.0.0.0` (`HOST=0.0.0.0`, baked into
   the image) so Docker's port forwarding — which targets the container's `eth0`,
   not its loopback — can reach it. Without this the mapped port is dead.
2. **On the host** the publish is pinned to `127.0.0.1`, so nothing outside the
   host can connect.

To open the dashboard from your laptop, tunnel over SSH:

```bash
ssh -L 3311:127.0.0.1:3311 user@nas-or-vps
# then browse http://localhost:3311
```

Do **not** change the publish to `0.0.0.0:3311` or set `HOST` to expose it — the
dashboard has no auth. If you need real remote access, put an authenticating
reverse proxy (Synology reverse proxy + basic auth, Caddy, Cloudflare Tunnel
with Access) in front and keep the container publish on loopback.

---

## 8. Bootstrapping `.auth-state.json` (automatic — no headed step)

There is **no manual/headed login step** for the container. On the first portal
interaction the submitter logs in headlessly with `PORTAL_EMAIL` /
`PORTAL_PASSWORD`, and on a session-expiry redirect it re-logs-in and retries
once. The resulting `storageState` is written to `AUTH_STATE_PATH`
(`/data/.auth-state.json`) on the named volume and reused on later runs and
restarts.

- To trigger the first login without a real report, submit an **inspect/dry-run**
  from the dashboard (tunnel in per §7) — it drives the portal to Step 3 without
  submitting and saves the auth state.
- If login ever breaks (password change, portal challenge), delete the saved
  state and let it re-login:
  ```bash
  docker compose exec automation rm -f /data/.auth-state.json
  docker compose restart automation
  ```
- The interactive `npm run auth` (headed) tool is **not** used in the container;
  it exists only for local desktop debugging.

---

## 9. Why the build context is the repo root

`tsconfig.json` sets `rootDir: ".."` and compiles both `src/**/*` and
`../shared/**/*`, and the source imports `../../shared/*.js`. So the build needs
`shared/` (a sibling of `automation/`). `docker-compose.yml` therefore sets:

```yaml
build:
  context: ..                      # repo root
  dockerfile: automation/Dockerfile
```

Run `docker compose` from **inside `automation/`** (compose resolves `context: ..`
to the repo root automatically). If you build by hand instead, run from the repo
root:

```bash
docker build -f automation/Dockerfile -t pvd311-automation:1.58.2 .
```

**`.dockerignore` note:** Docker only auto-reads the ignore file at the *context
root* (the repo root here), so `automation/.dockerignore` is not applied
automatically. The Dockerfile copies only exact paths (manifests, `tsconfig`,
`src/`, `shared/`) and never `COPY . .`, so **no secret or local artifact can
enter the image regardless.** To also shrink/speed the build context, symlink the
ignore to the repo root once:

```bash
ln -sf automation/.dockerignore ../.dockerignore   # run from automation/
```

---

## 10. Persistence, volumes & backup

- Named volume **`pvd311-data`** → `/data`: holds `.auth-state.json` and
  `proofs/`. Survives `up`/`down`/rebuilds. Removed only by
  `docker compose down -v` or `docker volume rm pvd311-data`.
- Back it up:
  ```bash
  docker run --rm -v pvd311-data:/data -v "$PWD":/backup alpine \
    tar czf /backup/pvd311-data-$(date +%F).tgz -C /data .
  ```
- Proof screenshots also inform Storage lifecycle (90-day) — treat `/data/proofs`
  as ephemeral evidence, the volume backup as belt-and-suspenders.

---

## 11. Operations

```bash
docker compose ps                     # health (healthcheck hits /api/status)
docker compose logs -f automation     # follow logs (rotated 10m x5)
docker compose restart automation     # restart
docker compose up -d --build          # rebuild + redeploy after a git pull
docker compose down                   # stop (keeps the volume)
docker compose exec automation sh     # shell inside (as pwuser)
curl -fsS http://localhost:3311/api/status   # after tunneling (§7)
```

**Upgrading Playwright:** when `package.json`'s `playwright` version changes,
bump the base image tag in `Dockerfile` (`mcr.microsoft.com/playwright:v<X.Y.Z>-noble`)
to the **same** version so the bundled Chromium matches, then
`docker compose up -d --build`. Mismatched tag ⇒ Playwright re-downloads a browser
at build time (slow) or fails to find one.

---

## 12. NAS (Synology Container Manager, GUI path)

SSH + `docker compose up -d --build` (§4) is the simplest and is recommended. If
you prefer the GUI:

1. Copy the repo to the NAS (e.g. `/volume1/docker/pvd311`), including `shared/`.
2. Put `.env` and `firebase-service-account.json` in `.../pvd311/automation/`
   (`chmod 644` the key, §6).
3. Container Manager → **Project** → **Create** → set the path to
   `.../pvd311/automation` (where `docker-compose.yml` lives) → it reads the
   compose file → **Build**. Container Manager honors the `context: ..` build
   context, so keep the full repo (with `shared/`) present.
4. Start the project. Confirm health under the project's container list.
5. Tunnel in (§7) to reach the dashboard; do not add a Synology port-forward rule.

---

## 13. VPS variant

Same image and compose. Differences:

- **IP reputation / WAF:** the portal is more likely to challenge or block a
  datacenter IP than the NAS's residential IP. Before trusting a VPS, do a WAF
  smoke test **from the VPS IP** (a single inspect/dry-run) and watch for
  block/CAPTCHA pages in the logs. This is the M5 "VPS spike with WAF test."
- **Firewall:** the publish is already loopback-only; additionally keep the VPS
  firewall (ufw/security group) closed on 3311. Access via SSH tunnel (§7).
- **Resources:** headless Chromium wants ~1 vCPU / 1–2 GB RAM headroom. The
  `shm_size: 1gb` in compose covers `/dev/shm`; if you still see renderer crashes,
  add `ipc: host` to the service.
- **Time zone / cron:** none required — the engine polls on its own interval.

---

## 14. Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Port 3311 refuses connection through the tunnel, but container is "healthy" | You changed `HOST` away from `0.0.0.0`, or published to the wrong interface. Container must bind `0.0.0.0`; host publishes `127.0.0.1:3311` (§7). |
| Container exits immediately, logs show "Missing required environment variable" | `PORTAL_EMAIL`/`PORTAL_PASSWORD` missing in `.env`, or the Firebase key path unreadable (§5/§6). |
| `Error: ENOENT ... firebase-service-account.json` or a permission error | Key not mounted or not readable by uid 1000 — check `FIREBASE_SERVICE_ACCOUNT_HOST_PATH` and `chmod 644` (§6). |
| Chromium fails to launch / "Running as root without --no-sandbox" | Container isn't running as `pwuser`. Don't override `user:` in compose; the image sets `USER pwuser`. |
| Browser renderer crashes / "Target closed" under load | Raise `shm_size` or add `ipc: host` (§13). |
| Healthcheck stuck "starting" | First boot is fast, but if login stalls, tunnel in and check logs; `start_period` is 40s. |
| Portal shows CAPTCHA / block pages | IP reputation (esp. VPS). Prefer the NAS residential IP; re-run the WAF smoke test (§13). |
| Unmapped case type fails instead of scouting | `ANTHROPIC_API_KEY` not set (§5). |
