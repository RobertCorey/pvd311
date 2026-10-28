# FixMyPVD client (`app/`)

Vite + React 19 + TypeScript, installable PWA. Talks **only** to the Cloudflare Worker API (`worker/`); no Firebase SDK (auth is Firebase REST in `src/lib/auth.ts`). Accounts are required to send a report (gate at Send; draft survives the round trip). Product spec: `../docs/product-spec.md`. Wire contract: `../docs/api.md` (types mirrored in `src/api/types.ts`).

Pages: `/` report · `/street` the Map (every case on the city's public 311 list; filters, neighborhoods `?n=`, a case page `?case=`) · `/week` "This week in Providence" (Monday–Sunday weeks, `?until=` for a past one) · `/my` My reports · `/account` and `/account/updates` (every email and phone notification: your reports, your streets' Monday emails, requests you follow, the Monday city email, this phone) · `/r/:id` tracking · `/about` · `/privacy`. The Worker sends the Monday emails (one per saved street that is on, and the city's week).

## Scripts
```bash
npm run dev        # Vite on :5173 (talks to the prod Worker; localhost is allow-listed for CORS)
npm run build      # tsc -b + vite build → dist/ (PWA manifest + service worker generated)
npm test           # Playwright, iPhone 13 emulation, API mocked via page.route
npm run preview    # serve dist/ on :4173 (what Playwright runs against)
```
Push to `main` deploys the app (`.github/workflows/deploy-app.yml`, on changes under app/, shared/, firebase.json) — same as the Worker. Manual fallback from the repo root: `npm run deploy` (build + Firebase Hosting), `npm run preview:app` (preview channel; view-only — CORS isn't allow-listed for preview hosts).

## Layout
```
src/brand.ts           every brand string (name, tagline, disclaimer, URLs)
src/tokens.css         palette (light on :root, dark under prefers-color-scheme + [data-theme])
src/i18n/              strings.en.json / strings.es.json + useT(); NO hardcoded copy in components
src/api/               client.ts (fetch wrappers, timeouts, ApiError) · types.ts (wire shapes)
src/lib/               categories (from ../shared/categories.ts via @shared), geo (EXIF, geocode, ≤300KB compress),
                       outbox (IndexedDB offline queue), myReports (device-local tokens), useInstallPrompt
src/components/        Layout, TabBar, MapView (Leaflet, lazy), the /street parts (StreetSheet, StreetFilters, StreetCasePage, …), CategoryIcon
src/screens/           Report (tiles → details → gate at Send), Track (/r/:id), Street, Week, MyReports, Account (+ AccountUpdates), About, Privacy, Admin, NotFound
tests/                 Playwright specs per screen (report, track, street, week, my, account, admin, a11y) + pure unit specs (unit-*)
```

## Conventions
- **Strings**: add a key to both JSON files; `t('key', { var })`. Prefixes: `report.* track.* street.* week.* account.* about.* privacy.* header.* nav.* my.* group.* extra.* notFound.*`.
- **Categories** come from `shared/categories.ts` (single source of truth shared with the Worker). `FEATURED` in `src/lib/categories.ts` picks the 8 front tiles; seasonal ones surface in season.
- **No bot check**: the required sign-in is the human check (Turnstile removed 2026-10-17); reporter quota still applies.
- **Offline**: submit while offline → IndexedDB outbox; flushed one item at a time when back online and signed in; a failed flush pauses until the next `online` event; each item carries a `clientId` the Worker dedupes on.
- **Photos**: compressed client-side to ≤300 KB JPEG (the Worker stores them in Firestore). EXIF GPS fills the location; typed addresses are forward-geocoded (ArcGIS, Providence extent); outside-city locations block submit.
- **Statuses** (wire → UI): received → Received · awaiting_review/sending → Sending to the city · sent → Sent (+ case id, then the city's portalStatus) · failed/needs_attention/rejected → Needs attention.

## Testing notes
- `tests/*.spec.ts` mock `https://pvd311-worker.pvd311-worker.workers.dev/api/*` and the ArcGIS geocoder; OSM tiles are stubbed.
- The preview server is started by `playwright.config.ts` (`reuseExistingServer`), so a running `npm run preview` is reused.
