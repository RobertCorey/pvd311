# SnapPVD Worker API — v1 (wire truth)

Base: `https://pvd311-worker.pvd311-worker.workers.dev` (custom domain at launch). CORS: pvdsnow.org, www, the two Firebase Hosting domains, `http://localhost:*`.
Errors: `{ "error": "<code>", "field"?: "<name>", "retryAfterSec"?: n }` with 400/403/404/429/500. The client never blocks on intake errors.

## POST /api/report — create a report
`multipart/form-data`:
| field | rules |
|---|---|
| `category` | key from `shared/categories.ts` |
| `description` | ≤ 2000 chars (optional) |
| `address` | 3–500 chars |
| `lat`, `lng` | both or neither; inside Providence bbox (41.70–41.92, −71.52–−71.33) |
| `extra` | JSON object string, ≤ 8 keys (per-category answers, e.g. `{"size":"Medium (~28in)"}`) |
| `email`, `name` | optional |
| `turnstileToken` | required (Cloudflare Turnstile, sitekey `0x4AAAAAAEYpfrjTLnEgk7-y`) |
| `deviceId` | random uuid persisted on the device (pacing: 1 per 3 min, 5 per day; also per IP) |
| `appVersion` | string |
| `descriptionOriginal`, `intakeFlags` | from intake, optional |
| `photo` | image/*, ≤ 5 MB; required unless the category has `photoRequired:false`. Client should compress to ≤ ~300 KB. |

201 → `{ id, trackingUrl: "/r/{id}", category, createdAt }`. `id` is the tracking token (22 chars, unguessable).
Errors: `invalid_category`, `invalid_address`, `too_long`, `lat_lng_pair`, `invalid_coords`, `outside_providence`, `invalid_extra`, `invalid_email`, `photo_required`, `invalid_photo`, `turnstile_failed` (403), `rate_limited` (429).

## POST /api/intake — moderation + optional wording cleanup (AI)
JSON `{ category|null, description, address, extra?, hasPhoto, appVersion }` →
`{ polishedDescription: string|null, flags: ('spam'|'abuse'|'personal_info'|'not_311'|'emergency')[], note: string|null, model: string|null }`.
Rate-limited ~10/min per IP. Never suggests a category (the reporter picks). Client shows: `emergency` → 911 notice; `not_311` → notice; others are passed back as `intakeFlags` and force human review server-side.

## GET /api/reports/:id — tracking (no PII)
`{ id, category, categoryLabel, address, lat, lng, photoUrl|null, createdAt, status, portalCaseId|null, portalStatus|null, timeline: [{at, label}], nextUpdateHint|null, hasEmail }`
`status`: `received` | `sending` | `sent` | `rejected`. `portalStatus` (from the city): `Submitted` | `Assigned` | `Resolved` | `Cancelled`.
Client label map: received → "Received"; sending → "Sending to the city"; sent → "Sent" + case id; rejected → "Needs attention".

## POST /api/reports/:id/email — attach an email after submit
JSON `{ email }` → 204. Knowing the id is the credential.

## GET /api/photos/:id
The report's photo bytes (immutable, cacheable).

## GET /api/public-feed?bbox=minLng,minLat,maxLng,maxLat&limit=100
`{ items: [{ id, source, category, categoryLabel, lat, lng, address, createdAt, status, portalStatus }] }`.
Two sources merged (bbox + limit apply to the combined set; limit ≤ 200):
- `source: 'snappvd'` — our reports, last 30 days. `status`: received/sending/sent/rejected; `id` = tracking token.
- `source: 'city'` — the city's own anonymous feed (`/public-requests/`, refreshed by the 30-min watcher into `meta/cityFeed`). `id` = `city:<hash>`, `address` = street only, `createdAt` parsed from the grid's "Created On" (may be null), `status` = `'city'`, and the city's Status Reason (Draft/Submitted/Assigned/Resolved/Cancelled/…) is in `portalStatus`. City items have no case id and are geocoded street-level via ArcGIS, so `lat`/`lng` are approximate; un-geocodable rows are omitted from the feed.

## GET /api/nearby?lat=&lng=&category=&radiusM=75
`{ items: [{ ...same fields as public-feed..., distanceM }] }` — reports within `radiusM` metres (default 75, max 2000) of `lat,lng`, from the last 14 days, both sources, sorted nearest-first. `category` (a `shared/categories.ts` key) optionally filters. City items with an unparseable date are kept (a fresh dedupe signal is not dropped). Used by the client's "already reported nearby?" dedupe prompt. Errors: `invalid_coords` (400).

## Later
`POST /api/reports/:id/follow`.
