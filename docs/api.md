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
Rate-limited 10/min per IP and 1,500/day globally (durable, Firestore meta). The flags are advisory for the client; the Worker re-runs moderation itself before any auto-approval (see HITL). Never suggests a category (the reporter picks). Client shows: `emergency` → 911 notice; `not_311` → notice; others are passed back as `intakeFlags` and force human review server-side.

## GET /api/reports/:id — tracking (no PII)
`{ id, category, categoryLabel, address, lat, lng, photoUrl|null, createdAt, status, portalCaseId|null, portalStatus|null, timeline: [{at, label}], nextUpdateHint|null, hasEmail }`
`status`: `received` | `sending` | `sent` | `needs_attention` | `rejected`. `portalStatus` (from the city): `Submitted` | `Assigned` | `Resolved` | `Cancelled`.
Client label map: received → "Received"; sending → "Sending to the city"; sent → "Sent" + case id; needs_attention → "Needs attention — we're looking at it"; rejected → "Not filed".

## GET /api/photos/:id
The report's photo bytes (immutable, cacheable).

## ~~GET /api/public-feed~~ — removed 2026-08-22
The /map page was cut, and the feed exposed every report's tracking id (the id is the read credential for `/api/reports/:id` and `/api/photos/:id`). Use `/api/nearby` for the dedupe signal.

## GET /api/nearby?lat=&lng=&category=&radiusM=75
`{ items: [{ id, source: 'snappvd'|'city', category, categoryLabel, lat, lng, address, createdAt, status, portalStatus, distanceM }] }` — reports within `radiusM` metres (default 75, max 2000) of `lat,lng`, from the last 14 days, both sources, sorted nearest-first. `category` (a `shared/categories.ts` key) optionally filters. City items with an unparseable date are kept (a fresh dedupe signal is not dropped). Used by the client's "already reported nearby?" dedupe prompt. Errors: `invalid_coords` (400).

## ~~POST /api/reports/:id/follow~~ — removed 2026-08-22
Anonymous follow let anyone subscribe any email to any report. Use `PUT /api/me/following/:id` (account required).

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

## HITL (ops, not app-facing)
Review emails carry signed links `GET /hitl/approve/:id/:exp/:sig` and `/hitl/reject/:id/:exp/:sig` (HMAC-SHA256 over `action:id:exp`, 30-day expiry; path form so a quoted-printable mis-decode in transit can't corrupt them). Any intake flag — client-reported or from the Worker's own moderation pass, which runs once per report before auto-approval — forces human review regardless of account trust. Report creation fails closed if `TURNSTILE_SECRET` is unset (set `ALLOW_NO_TURNSTILE=1` only in tests/dev). Pacing is per mailbox (plus-tags and gmail dots collapsed) and per IP.

## Admin — `/api/admin/*` (in-app /admin screen)
Requires a Firebase ID token whose email is in the Worker var `ADMIN_EMAILS`, verified, **Google provider** (an email-link account for the same address is refused). `GET /api/me` returns `admin: true` for such a caller so the client can show the route.
- `GET /api/admin/overview` → `{ engine: { paused, consecutiveFailures, submissionsThisHour, lastSubmissionTime, hitlMode, accountTrustN }, awaitingReview[], failed[], pending[], submitted7d[] }` — items are the admin projection (includes `description`, `descriptionOriginal`, `intakeFlags`, `reporterEmail`, `review`, `retries`, `statusDetail`).
- `GET /api/admin/reports/:id` → admin projection.
- `POST /api/admin/reports/:id/approve` (awaiting_review|pending) · `/reject` (awaiting_review|pending|failed; JSON `{ reason? }` — the reporter gets a short email, with the reason if given) · `/requeue` (failed) → updated projection; 409 `{ error, status }` if the state doesn't allow it.
- `GET /api/admin/users/:uid` → `{ uid, email, provider, trusted, submitted, rejected, createdAt }` · `POST /api/admin/users/:uid/trust` `{ trusted: boolean }` → same shape. `trusted` overrides the ramp (auto-approve) — flags still force review.
- `POST /api/admin/engine/resume` · `/pause` → `{ ok, paused }`.
- `GET /api/admin/health?events=100` → system visibility for the /admin "System" view:
  `{ generatedAt, overall: 'ok'|'warn'|'error', engine: { paused, consecutiveFailures, submissionsThisHour, lastSubmissionTime, locked, hitlMode, accountTrustN, reporterEmailEnabled }, subsystems: [{ key, label, what, status: 'ok'|'warn'|'error'|'unknown', lastOkAt, lastErrorAt, lastError, lastDetail, okToday, errToday, expectedEvery }], counts: { pending, awaiting_review, processing, submitted, failed, rejected, 'auto-rejected' }, users, ai: { intakeToday, dailyCap }, cityFeed: { fetchedAt, items }, events: [{ id, at, level: 'info'|'warn'|'error', kind, msg, reportId, data }] }`.
  Subsystems: tick (engine cron, expected every minute), submit (portal filing), watcher (30 min), cityfeed, canary (daily), daily, email, ai, auth_mail, api. Status is derived from heartbeat freshness (`expectedEvery` is a human string like "every 30 min" / "daily, 7 am"; null for on-demand subsystems) and whether the last error is newer than the last OK. Events are kept 14 days; kinds: report.created, hitl.requested/approved/rejected, submit.ok/failed, tick.reaped/auto_rejected, engine.breaker, watcher.status, canary.drift, retention.photo_deleted, auth.link_sent, admin.pause/resume/trust.
The token-in-URL `/admin` page is retired once the app screen ships.
