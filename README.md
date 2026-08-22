# SnapPVD

Report a Providence street problem in one photo — we file it with the city's 311 for you. **SnapPVD is an independent community project and is not affiliated with, endorsed by, or operated by the City of Providence.**

Pre-launch. The legacy PWA (`public/`, frozen) is live at [pvdsnow.org](https://pvdsnow.org); the new client (`app/`) deploys to preview channels until snappvd.org is bought. Product spec: [`docs/product-spec.md`](docs/product-spec.md).

Relaunched August 2026 from the winter-only PVD Snow project (same repo, see git history before `c81a893`). Plan and status: [`PLAN.md`](PLAN.md), [`.claude/STATE.md`](.claude/STATE.md). Portal research: [`scripts/`](scripts/).

## How it works

1. **Resident** opens the app, taps a category (8 big tiles; "Other" expands the full list), snaps a photo (EXIF fills the location) or types the address, adds a description, and sends. Turnstile gates bots; an AI pass (Claude) only moderates and offers clearer wording — the reporter approves every change. Offline? The report waits in an IndexedDB outbox.
2. **Worker** (`worker/`, Cloudflare) validates, rate-limits per device, stores the report + photo, and returns an unguessable tracking id (`/r/:id`).
3. **Review** — HITL at launch: the operator gets an email and approves/rejects from `/admin`; full-auto with an agent in the loop is the goal.
4. **Portal submit** — the Worker drives the city's 311 portal with a headless browser (Browser Rendering): case type by census GUID, conditional fields (unmapped → an LLM "scout" reads the live controls), submit, case id.
5. **Status** — the Worker polls the portal; the resident sees the timeline on the tracking page and under **My reports**; everything also shows on the public map.

## Stack

| Layer | Tech |
|---|---|
| Client (`app/`) | Vite + React + TypeScript, installable PWA (vite-plugin-pwa), react-router, Leaflet map, Cloudflare Turnstile, Playwright tests. Talks only to the Worker API. |
| Worker (`worker/`) | Cloudflare Workers + Browser Rendering + cron; Firestore (Admin) as the store; Resend email; Claude for intake/scout |
| Shared | `shared/categories.ts` (category registry → portal GUIDs/fields) |
| Legacy | `public/` (frozen PWA, live until cutover), `automation/` (laptop engine, reference only) |
| Target | Providence 311 portal (Power Pages / Dynamics 365) |

## Project structure

```
app/               SnapPVD client (React)
  src/screens/     Report (tiles → details), Track (/r/:id), Feed (/map), MyReports, About, Privacy
  src/api/         Worker API client + types (wire contract)
  src/lib/         categories (from shared/), geo (EXIF, geocode, compress), outbox, myReports
  src/i18n/        strings.en.json / strings.es.json + useT
  src/brand.ts     every brand string
  tests/           Playwright (mobile emulation, API mocked)
worker/            Cloudflare Worker: app API, engine, HITL, watcher, admin
shared/            category registry (single source of truth)
docs/              product-spec.md (SnapPVD), provisioning-task.md
public/            legacy PWA (frozen)
automation/        legacy laptop engine (reference)
scripts/           portal research, case-type census
firebase.json      hosting for public/ (legacy) · firebase.app.json hosting for app/dist
```

## Development

```bash
# Client
npm run app:dev                  # Vite dev server on :5173 (talks to the prod Worker; localhost is allow-listed)
npm run app:test                 # Playwright, mobile emulation, API mocked
npm run preview:app              # build + Firebase Hosting preview channel (view-only: Turnstile/CORS not allow-listed there)
npm run deploy:app               # build + deploy app/dist to Firebase Hosting (cutover)

# Worker
cd worker && npx wrangler dev    # see worker/README

# Legacy
npm run dev                      # serves public/ on :3999
npm run test:rules               # Firestore/Storage rules (emulator, needs Java)
```

Headless browsers cannot pass Turnstile (by design) — real end-to-end submits are done from a real browser.

## Principles

- Good tenant of the city portal: minimal drafts (they are permanent), conservative rate caps, no junk, no pre-crawling.
- The city never receives unreviewed AI text at launch.
- Small commits; `.claude/STATE.md` updated every session.
