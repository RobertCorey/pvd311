# syntax=docker/dockerfile:1
#
# PVD311 automation server — dashboard + Playwright submission engine.
#
# Base image is pinned to the Playwright version installed in
# automation/package.json (playwright 1.58.2). The official Playwright image
# already contains a matching Chromium build plus every OS library it needs,
# under $PLAYWRIGHT_BROWSERS_PATH=/ms-playwright, so `npm ci` reuses those
# browsers instead of downloading them again. Bump this tag whenever the
# playwright dependency changes (see DEPLOY.md → "Upgrading Playwright").
FROM mcr.microsoft.com/playwright:v1.58.2-noble

# The tsc config (automation/tsconfig.json) uses rootDir ".." and compiles both
# src/**/* and ../shared/**/*, emitting dist/automation/src/*.js and
# dist/shared/*.js. The source imports shared via ../../shared/*.js, so the app
# must live one level below the repo root inside the image. That also means the
# DOCKER BUILD CONTEXT MUST BE THE REPO ROOT (see docker-compose.yml / DEPLOY.md).
WORKDIR /app/automation

# ── Dependencies (own layer; only re-runs when the manifests change) ──────────
COPY automation/package.json automation/package-lock.json ./
RUN npm ci

# ── Source (only the paths the build needs — never .env, secrets, or dist) ────
COPY automation/tsconfig.json ./
COPY automation/src ./src
COPY shared /app/shared

# ── Build: tsc + copy dashboard.html into dist, then drop devDependencies ─────
RUN npm run build && npm prune --omit=dev

# ── Runtime configuration ─────────────────────────────────────────────────────
# Auth state (portal storageState) and proof screenshots are written to /data so
# they survive restarts/rebuilds on a named volume (mounted in compose).
# HOST=0.0.0.0: the server defaults to binding 127.0.0.1 (index.ts), but Docker
# forwards a published port to the container's eth0, not its loopback — so inside
# the container it must listen on all interfaces or the mapped port is dead.
# Host-side exposure is still locked down: compose publishes to 127.0.0.1 only.
ENV AUTH_STATE_PATH=/data/.auth-state.json \
    PROOF_DIR=/data/proofs \
    HEADLESS=true \
    HOST=0.0.0.0 \
    PORT=3311 \
    NODE_ENV=production

# Chromium's setuid sandbox refuses to run as root, and the app launches it with
# only --disable-dev-shm-usage (no --no-sandbox). The Playwright image ships a
# non-root user "pwuser" (uid 1000) that owns the browser install, so run as it.
# Pre-create /data owned by pwuser so a fresh named volume mounted here inherits
# that ownership and stays writable.
RUN mkdir -p /data/proofs && chown -R pwuser:pwuser /data

EXPOSE 3311

USER pwuser

# The dashboard has no auth and always answers /api/status once the HTTP server
# is up, so it doubles as the liveness probe. curl ships in the Playwright image.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -fsS http://localhost:3311/api/status || exit 1

# --auto enables the polling auto-submission engine (config.autoMode).
CMD ["node", "dist/automation/src/index.js", "--auto"]
