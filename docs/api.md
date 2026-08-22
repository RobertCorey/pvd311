# FixMyPVD Worker API — v1 (wire truth)

Base: `https://pvd311-worker.pvd311-worker.workers.dev` (custom domain at launch). CORS: pvdsnow.org, www, the two Firebase Hosting domains, `http://localhost:*`.
Errors: `{ "error": "<code>", "field"?: "<name>", "retryAfterSec"?: n }` with 400/403/404/429/500. The client never blocks on intake errors.

## POST /api/report — create a report
**Requires an account**: `Authorization: Bearer <Firebase ID token>` (see Accounts) → 401 `auth_required` without one. The report's `ownerUid` and `reporterEmail` come from the token (email only when the account's `prefs.emailUpdates` is on). Pacing is per account (1 per 3 min, 5 per day) plus per IP.
`multipart/form-data`:
| field | rules |
|---|---|
| `category` | key from `shared/categories.ts` |
| `description` | ≤ 2000 chars (optional) |
| `address` | 3–500 chars |
| `lat`, `lng` | both or neither; inside Providence bbox (41.70–41.92, −71.52–−71.33) |
| `extra` | JSON object string, ≤ 8 keys (per-category answers, e.g. `{"size":"Medium (~28in)"}`) |
| `name` | optional |
| `turnstileToken` | required (Cloudflare Turnstile, sitekey `0x4AAAAAAEYpfrjTLnEgk7-y`) |
| `deviceId` | random uuid persisted on the device (recorded for abuse forensics; pacing is per account + IP) |
| `appVersion` | string |
| `clientId` | uuid generated once per report attempt and reused on outbox retries → idempotent: a repeat returns the existing `{id,…}` with 200 and `idempotent:true` |
| `descriptionOriginal`, `intakeFlags` | from intake, optional |
| `photo` | image/*, ≤ 5 MB; required unless the category has `photoRequired:false`. Client should compress to ≤ ~300 KB. |

201 → `{ id, trackingUrl: "/r/{id}", category, createdAt }`. `id` is the tracking token (22 chars, unguessable).
Errors: `auth_required` (401), `invalid_category`, `invalid_address`, `too_long`, `lat_lng_pair`, `invalid_coords`, `outside_providence`, `invalid_extra`, `photo_required`, `invalid_photo`, `turnstile_failed` (403), `rate_limited` (429).

## POST /api/intake — moderation + optional wording cleanup (AI)
JSON `{ category|null, description, address, extra?, hasPhoto, appVersion }` →
`{ polishedDescription: string|null, flags: ('spam'|'abuse'|'personal_info'|'not_311'|'emergency')[], note: string|null, model: string|null }`.
Rate-limited ~10/min per IP. Never suggests a category (the reporter picks). Client shows: `emergency` → 911 notice; `not_311` → notice; others are passed back as `intakeFlags` and force human review server-side.

## GET /api/reports/:id — tracking (no PII)
`{ id, category, categoryLabel, address, lat, lng, photoUrl|null, createdAt, status, portalCaseId|null, portalStatus|null, timeline: [{at, label}], nextUpdateHint|null, hasEmail }`
`status`: `received` | `sending` | `sent` | `needs_attention` | `rejected`. `portalStatus` (from the city): `Submitted` | `Assigned` | `Resolved` | `Cancelled`.
Client label map: received → "Received"; sending → "Sending to the city"; sent → "Sent" + case id; needs_attention → "Needs attention — we're looking at it"; rejected → "Not filed".

## GET /api/photos/:id
The report's photo bytes (immutable, cacheable).

## GET /api/public-feed?bbox=minLng,minLat,maxLng,maxLat&limit=100
`{ items: [{ id, source, category, categoryLabel, lat, lng, address, createdAt, status, portalStatus }] }`.
Two sources merged (bbox + limit apply to the combined set; limit ≤ 200):
- `source: 'snappvd'` — our reports, last 30 days. `status`: received/sending/sent/rejected; `id` = tracking token.
- `source: 'city'` — the city's own anonymous feed (`/public-requests/`, refreshed by the 30-min watcher into `meta/cityFeed`). `id` = `city:<hash>`, `address` = street only, `createdAt` parsed from the grid's "Created On" (may be null), `status` = `'city'`, and the city's Status Reason (Draft/Submitted/Assigned/Resolved/Cancelled/…) is in `portalStatus`. City items have no case id and are geocoded street-level via ArcGIS, so `lat`/`lng` are approximate; un-geocodable rows are omitted from the feed.

## GET /api/nearby?lat=&lng=&category=&radiusM=75
`{ items: [{ ...same fields as public-feed..., distanceM }] }` — reports within `radiusM` metres (default 75, max 2000) of `lat,lng`, from the last 14 days, both sources, sorted nearest-first. `category` (a `shared/categories.ts` key) optionally filters. City items with an unparseable date are kept (a fresh dedupe signal is not dropped). Used by the client's "already reported nearby?" dedupe prompt. Errors: `invalid_coords` (400).

## POST /api/reports/:id/follow — follow someone else's report
JSON `{ email }` → 204. Followers receive the same city-status emails as the reporter (gated until the sending domain is verified). Use from the "already reported nearby" prompt for `source:'snappvd'` items (city items can't be followed).

---

# Accounts (required to report) — v1

Identity provider: **Firebase Auth** (project `pvd-snow-report`), driven from the client over its REST API (no SDK). Providers: **email link** (link minted by the Worker and sent via Resend — Firebase's own sender is dropped by Gmail) and **Google** (GIS button, Web client ID `224841506687-4jjb…`). Anonymous-provider tokens are rejected. Reading (tracking pages, map, nearby, intake) needs no account; **creating a report does**.

**Transport:** `Authorization: Bearer <Firebase ID token>`. The Worker verifies RS256 against Google's securetoken JWKS, `aud`/`iss` = the project, `exp`/`iat` ±60 s. `/api/me/*`, `PATCH /api/reports/:id` and `POST /api/reports/:id/cancel` require it → 401 `unauthenticated` otherwise. Any other endpoint accepts it optionally. `ownerUid` is set **only** from a verified token, never from a client field.

Client-side flow (`K` = the Firebase Web API key from `firebase apps:sdkconfig web` — a public, referrer-restricted identifier that ships in the client bundle; kept out of docs only to quiet GitHub secret scanning):
1. `POST /api/auth/link` (Worker) JSON `{ email, returnTo?: "/…", lang?: "en"|"es" }` → `{ sent: true }`. Mints the Firebase email-link (Identity Toolkit admin, `returnOobLink`) and emails it from `AUTH_FROM` via Resend. `returnTo` (same-origin path) is embedded in the link's continueUrl. Rate limits: 3 / 15 min per email, 12 / h per IP → 429 `rate_limited`. Errors: `invalid_email` (400). Remember `email` locally.
2. The link lands on `<origin>/account?returnTo=…&mode=signIn&oobCode=…` → `POST https://identitytoolkit.googleapis.com/v1/accounts:signInWithEmailLink?key=K` `{ oobCode, email }` → `{ idToken, refreshToken, expiresIn, localId, email }`; the client then navigates to `returnTo`.
3. Refresh: `POST https://securetoken.googleapis.com/v1/token?key=K` `grant_type=refresh_token&refresh_token=…` → `{ id_token, refresh_token, expires_in }`. ID tokens live 1 h.
4. Google: GIS credential → `accounts:signInWithIdp?key=K` `{ postBody: "id_token=…&providerId=google.com", requestUri: origin, returnSecureToken: true }`.

Data: `users/{uid}` `{ email, emailVerified, displayName, provider, createdAt, lastSeenAt, prefs: { emailUpdates }, addresses: [≤10], following: [reportId ≤200], trusted? }`. Reports gain `ownerUid`, `claimedAt`, `followerUids`, `cancelledByReporter`.

## GET /api/me
`{ uid, email, emailVerified, displayName, provider, prefs: { emailUpdates }, addresses: [{ id, label, address, lat, lng }], following: [id], createdAt }`. Creates the user doc on first call.

## PATCH /api/me
JSON `{ displayName?: string|null, prefs?: { emailUpdates?: boolean } }` → the `GET /api/me` shape. `emailUpdates:false` silences city-status mail for own + followed reports.

## GET /api/me/reports
`{ items: [ReportView & { mine: true, following, editable, description, owned }] }` — newest first, ≤100. `editable` = still `received` (pending/awaiting review) and yours.

## POST /api/me/claim — attach this device's anonymous reports
JSON `{ ids: string[] }` (tracking tokens from the device's local list, ≤50) → `{ claimed: [id], skipped: [id] }`. Only unowned reports (or ones already yours) are claimed; knowing the id is the credential, same as `/email`.

## POST /api/me/recover — "find my reports"
Claims every unowned report whose `reporterEmail` equals the account's **verified** email → `{ claimed: [id] }`. 403 `email_unverified` otherwise.

## GET /api/me/following · PUT /api/me/following/:id · DELETE /api/me/following/:id
List (same shape as `/api/me/reports`, `mine` false) / follow (204) / unfollow (204). Followers with `emailUpdates` on get the same city-status mail as the reporter (gated like all reporter mail). Use PUT from the "already reported nearby" prompt when signed in, instead of `/follow {email}`.

## PUT /api/me/addresses · DELETE /api/me/addresses/:id
PUT JSON `{ id?, label?, address (3–300), lat?, lng? }` (both or neither) → `{ addresses }` (≤10; `id` given = replace). DELETE → `{ addresses }`.

## PATCH /api/reports/:id — edit a still-pending report (owner only)
JSON `{ description }` (≤2000) → `{ ok, description }`. 403 `not_owner`, 409 `not_editable` once it is sending/sent.

## POST /api/reports/:id/cancel — cancel a still-pending report (owner only)
→ `{ ok, status: "rejected" }`; the tracker shows "Not filed". 409 `not_cancellable` once a browser picked it up (`sending`) or after. An abandoned city draft from an earlier attempt is left alone (undeletable, harmless).

## Changes to existing endpoints
- `POST /api/report`: account required (above). `GET /api/reports/:id` with a bearer adds `mine`, `following`, `editable`, and `description` (owners only); always adds `owned` and `cancelledByReporter` (status `rejected` + this flag = the reporter withdrew it).
- HITL trust ramp (`HITL_MODE=ramp`, the launch mode): the first `ACCOUNT_TRUST_N` (3) reports of each account are human-reviewed; after that, an account with 0 rejected reports — or `users/{uid}.trusted=true` — auto-approves. `HITL_MODE=review` = every report tapped (panic switch).
