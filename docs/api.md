# FixMyPVD Worker API — v1 (wire truth)

Base: `https://pvd311-worker.pvd311-worker.workers.dev` (custom domain at launch). CORS: pvdsnow.org, www, the two Firebase Hosting domains, `http://localhost:*`.
Errors: `{ "error": "<code>", "field"?: "<name>", "retryAfterSec"?: n }` with 400/403/404/429/500. The client never blocks on intake errors.

## POST /api/report — create a report
**Requires an account**: `Authorization: Bearer <Firebase ID token>` (see Accounts) → 401 `auth_required` without one. The report's `ownerUid` and `reporterEmail` come from the token (email only when the account's `prefs.emailUpdates` is on). Reporter quota (docs/quota.md, worker/src/quota.ts): per mailbox 5/day + 15/week, 60 s between reports; per IP 30/day. Days reset 00:00 America/New_York, weeks Monday 00:00 ET. Every accepted report counts; a reporter cancel before filing refunds its day + week.
`multipart/form-data`:
| field | rules |
|---|---|
| `category` | key from `shared/categories.ts` |
| `description` | ≤ 2000 chars (optional) |
| `address` | 3–500 chars |
| `lat`, `lng` | both or neither; inside Providence bbox (41.70–41.92, −71.52–−71.33) |
| `extra` | JSON object string, ≤ 8 keys (per-category answers, e.g. `{"size":"Medium (~28in)"}`) |
| `name` | optional |
| `deviceId` | random uuid persisted on the device (recorded for abuse forensics; pacing is per account + IP) |
| `appVersion` | string |
| `clientId` | uuid generated once per report attempt and reused on outbox retries → idempotent: a repeat returns the existing `{id,…}` with 200 and `idempotent:true` |
| `descriptionOriginal`, `intakeFlags` | from intake, optional |
| `photo` | image/*, ≤ 5 MB; required unless the category has `photoRequired:false`. Client should compress to ≤ ~300 KB. |

201 → `{ id, trackingUrl: "/r/{id}", category, createdAt }`. `id` is the tracking token (22 chars, unguessable).
Errors: `auth_required` (401), `invalid_category`, `invalid_address`, `too_long`, `lat_lng_pair`, `invalid_coords`, `outside_providence`, `invalid_extra`, `photo_required`, `invalid_photo`, `rate_limited` (429: `{ error, reason: 'gap'|'day'|'week'|'ip', retryAfterSec, quota }`, `quota` as in `GET /api/me`).

## POST /api/intake — moderation + optional wording cleanup (AI)
JSON `{ category|null, description, address, extra?, hasPhoto, appVersion }` →
`{ polishedDescription: string|null, flags: ('spam'|'abuse'|'personal_info'|'not_311'|'emergency')[], note: string|null, model: string|null }`.
Rate-limited 10/min per IP and 1,500/day globally (durable, Firestore meta). The flags are advisory for the client; the Worker re-runs moderation itself before any auto-approval (see HITL). Never suggests a category (the reporter picks). Client shows: `emergency` → 911 notice; `not_311` → notice; others are passed back as `intakeFlags` and force human review server-side.

## GET /api/reports/:id — tracking (no PII)
`{ id, category, categoryLabel, address, lat, lng, photoUrl|null, createdAt, status, portalCaseId|null, portalStatus|null, resolutionMessage|null, timeline: [{at, label, kind?, text?, vars?}], workOrder|null, department|null, cityAsk|null, nextUpdateHint|null, hasEmail, owned, cancelledByReporter, notFiled: { code: 'cancelled'|'reviewed'|'duplicate'|'outside'|'no_photo'|'no_address'|'blocked'|'other'|'failed', text, duplicateOf } | null }`
`notFiled` is set whenever the report will not / did not reach the city: reporter-safe text (admin-entered reason when there is one; never the reviewer's identity), and `duplicateOf` = the other report's id for the duplicate case (link "View that report").
`status`: `received` | `sending` | `sent` | `needs_attention` | `rejected`. `portalStatus` (from the city): `Submitted` | `Assigned` | `In Progress` | `Department Responded` | `Resolved` | `Cancelled` | `Merged` (others pass through verbatim).
Client label map: received → "Received"; sending → "Sending to the city"; sent → "Sent" + case id; needs_attention → "Needs attention — we're looking at it"; rejected → "Not filed".

`resolutionMessage`: the city's own "Resolution Message" (portal field `adx_resolution`, from the watcher's case-detail snapshot), verbatim (trimmed), public, any status; null when empty. Never parsed — the city's "Resolved" can mean "referred elsewhere" (PVD2026-90091). The app shows it as "The city's note:" and says "The city closed this request" in its own words.
Timeline rows: `label` is always an English fallback; rows with a `kind` are worded by the app. Relayed city email by what it is (`worker/src/cityask.ts` classifies at arrival; older rows by the same rules on read): `city_receipt` (the city's receipt — shown once), `city_routed` (`vars.dept` = its "Department Assigned:", verbatim), `city_message` (anything else; `label` carries the subject). `city_ask` = the city asked for more information (one row per ask, whichever channel it came on), `city_answer` = an answer went to the city (sent ones only), `work_order` = the city's work order changed (`vars.number`, `vars.status` verbatim; `at` = the city's completion time when it says Completed, else when the watcher saw it). `text` (the city's plain-text words minus `[cid:…]` lines — or, on `city_answer`, the reporter's answer) is added only for the report's owner and only on this single-report read — never public (city emails can quote the reporter's description and address) and never in `/api/me/*` lists.

`workOrder`: `{ number|null, status, completedAt|null }` from the portal case detail (`cop_workordernumber` / `cop_workorderstatus` / `cop_workcompletedon`), verbatim; null when the case has none. Its status is the work order's, not the case's — PVD2026-90090 showed "Department Responded" with its work order "Completed" (stamped before the case was routed, so possibly a linked existing job). The app says "The city marked its work order complete; the case itself is still open", never "fixed".
`department`: the "Department Assigned:" of the city's routing email (else the portal timeline's last dispatch), verbatim; null when unknown.
`cityAsk`: the newest time the city asked the reporter for more information, or null. Public: `{ askedAt, open, answered, answeredAt }` — `open` = still answerable and not answered yet. The owner also gets `{ id, canAnswer, expiresAt }`, and on this single-report read `{ text, answers: [{ at, via: 'app'|'email', status: 'sent'|'blocked'|'failed', text }] }`. Answerable while the report is `sent`, the city case is not terminal, fewer than 3 answers were sent, and for 14 days.

## POST /api/reports/:id/answer — the owner answers the city (account required)
JSON `{ text, askId? }` (`askId` defaults to the newest ask) → `{ ok: true, answer: { at, via: 'app', status: 'sent', text } }`. The Worker runs moderation (blocks `spam` / `abuse` only) and mails the answer to the city FROM the portal account's contact address (`RELAY_ADDRESS`, cases@fixmypvd.org) to the city address that asked, subject `RE: <the city's subject>` (keeps the city CRM's `PVD311:nnnnnnn` token so it threads onto the case) + the case number, with the original address / map link / description for context. Every attempt is recorded on the report (`cityAsks[].answers`). Errors: `unauthenticated` (401), `not_owner` (403), `not_found` (404), `invalid_text` (400: empty or > 2,000 chars), `no_ask` / `case_closed` / `expired` / `too_many` (409), `too_soon` (429, `retryAfterSec`; 60 s between answers), `blocked` (422, `flags`), `send_failed` (502; you are alerted, the owner may retry). The same answer can come by email: the owner replying to our "The city needs more information" mail (relay.ts; sender = the owner's address with DMARC pass, the top of the reply above the quoted message).

## GET /api/photos/:id
The report's photo bytes (immutable, cacheable).

## GET /api/stats
`{ filed }` — public counter of reports filed with the city. No resolved count (removed 2026-10-16: the city's Resolved often means referred, not fixed). (The PVD Snow-era rows were archived and purged 2026-09-30, so no date filter is needed.) Cached 5 min. For the home-page trust line.

## ~~GET /api/public-feed~~ — removed 2026-08-22
The /map page was cut, and the feed exposed every report's tracking id (the id is the read credential for `/api/reports/:id` and `/api/photos/:id`). Use `/api/nearby` for the dedupe signal.

## GET /api/nearby?lat=&lng=&category=&radiusM=75
`{ items: [{ id, source: 'snappvd'|'city', category, categoryLabel, lat, lng, address, createdAt, status, portalStatus, distanceM }] }` — reports within `radiusM` metres (default 75, max 2000) of `lat,lng`, from the last 14 days, both sources, sorted nearest-first. `category` (a `shared/categories.ts` key) optionally filters. City items with an unparseable date are kept (a fresh dedupe signal is not dropped). Used by the client's "already reported nearby?" dedupe prompt. Errors: `invalid_coords` (400).

## GET /api/street?lat=&lng=&radiusM=300&days=30 — "My street" (added 2026-10-25)
`{ items: [{ id, caseType, category, street, status, open, createdAt, closedAt, resolution, lat, lng, distanceM }], radiusM, days, at }` — everyone's cases from the city's public list (`cityCases`, worker/src/street.ts) within `radiusM` metres (50–1000) of `lat,lng` that were created or closed in the last `days` (1–90), newest activity first. `resolution` is the city's own Resolution Message (closed cases only). Public; cached 5 min. Coordinates come from a one-time ArcGIS geocode of the case's street (cases without one are left out). Errors: `invalid_coords` (400, also for points outside Rhode Island). The app page is `/street?lat&lng&q=<address>`. The /street page now reads /api/street/map; this endpoint remains for the weekly digest and old links.

## GET /api/street/map?days=30 — the /street map feed (added 2026-10-25)
The map-first `/street` page's ONE request: every non-draft case from the city's public list (`cityCases`) created or closed inside the window — located and unlocated — as columnar tuples plus two index tables, so pan/zoom/filter/cluster/counts all happen in the browser from one array (`app/src/lib/streetMap.ts`) and never touch the network again. Public, no auth, same CORS as the other GETs; routed before `/api/street` in worker/src/api.ts. Pure builder `mapFeed(rows, { days, now, truncated })`, handler `handleStreetMap(url, store)` in worker/src/street.ts; types `MapFeed` / `MapItem` exported there and mirrored in `app/src/api/street.ts`.

**`days`** is snapped so the HTTP cache and the per-isolate cache hit (`snapDays`): missing / NaN / ≤ 0 → 30; 1–7 → 7; 8–30 → 30; > 30 → 90 (MAX_DAYS). The app only asks for 30 and 90 ("This week" is cut client-side from the 30-day set).

**Response** `200 application/json`, `cache-control: public, max-age=300` (no ETag in v1 — `at` changes per isolate load; the client's 5-minute module cache plus the HTTP cache cover revisits). Reads share the existing 5-minute per-isolate `loadCases` cache with `/api/street` and `/api/street/city` (one Firestore read per window per 5 minutes, loaded over `days + 60` so a case closed this month but opened in August still shows).
```json
{
  "v": 1,
  "days": 30,
  "at": "2026-10-25T17:00:00.000Z",
  "total": 1234,
  "located": 1108,
  "truncated": false,
  "types": [["Pothole", "pothole"], ["Missed Trash Day Pick-up Issue", "missed_trash"], ["Street Light Out", "street_light"]],
  "statuses": ["Submitted", "Assigned", "In Progress", "Department Responded", "Resolved", "Closed", "Cancelled", "Merged"],
  "items": [
    ["5f0efb0b-0454-ef11-a317-001dd8068673", 0, 1, 29876650, 0, 41.82834, -71.40061, "10 Angell St", 0],
    ["1ee8b671-7a2e-ef11-840a-001dd8039400", 2, 4, 29870210, 29876100, null, null, "", "Bulb replaced."]
  ]
}
```
- `at` — when this response was built. `total` — non-draft cases created or closed inside the window (unlocated included). `located` — of those, with coordinates. `truncated` — true when the load hit LOAD_LIMIT (3000 rows over `days + 60`), so the 90-day window may be missing its oldest cases.
- `types` — index = `t`; `[city caseType, category key]`, one entry per caseType (first-seen category wins, `'unsure'` when the doc has none); ~40 entries. `statuses` — index = `s`; starts with the eight known statuses in that order, any other status string seen is appended.
- `items` — one tuple per case, columns `[id, t, s, createdMin, closedMin, lat, lng, street, res]`: `id` the city's GUID; `t` / `s` indexes into the tables; `createdMin` = floor(createdAt / 60 s) in UTC minutes, 0 when unparseable; `closedMin` = floor(closedAt / 60 s) for closed cases (the city's resolutionDate, else the statusSeen close we watched — `cityinsights.closedAt`), 0 when open/unknown; `lat` / `lng` rounded to 5 dp or `null` when the case has no coordinates; `street` `""` when blank; `res` the city's Resolution Message trimmed and cut to 300 chars, or `0` when absent (read `res || null`).
- Inclusion and order are exactly `/api/street`'s: `status` matching `/^draft$/i` is skipped, a case is kept when `max(created, closed) ≥ now − days`, sorted newest activity first (array order is the tiebreak). `open` is not transmitted — derive it as `!CLOSED.has(statuses[s])` with CLOSED = Resolved, Closed, Cancelled, Merged.
- Size (measured shape): ≈ 131 B per item raw → 30 days ≈ 1,200 items ≈ 157 KB raw + 3 KB tables ≈ 50 KB on the wire with Cloudflare brotli (the GUIDs are the ~26 KB floor); 90 days ≈ 3,000 items ≈ 390 KB raw / ≈ 120 KB wire, fetched only when "90 days" is chosen.

## ~~POST /api/reports/:id/follow~~ — removed 2026-08-22
Anonymous follow let anyone subscribe any email to any report. Use `PUT /api/me/following/:id` (account required).

## GET /api/street/case/:guid — one case for a deep link (added 2026-10-25)
`/street?case=<guid>` (the follow mail's "See it on the map", a `/my` row) must open the card even when the case is older than the page's loaded window (30 or 90 days) — following is for long-lived cases. When the page does not find `case=` in its feed it asks for the case itself; `guid` = the city's case GUID, `/^[0-9a-f-]{36}$/` (400 `invalid_id` otherwise). → `{ id, caseType, category, street, status, open, createdAt, closedAt, resolution, lat, lng, updatedAt }` — the `GET /api/me/city` item without `followedAt` (worker/src/street.ts `handleStreetCase`, `StreetCaseView`). 404 `not_found` when there is no record or it is a draft (the feed skips drafts too); only then does the page say the request is gone. Public, no auth; one Firestore doc read; `cache-control: public, max-age=300` (60 on a 404). Routed before `/api/street` in worker/src/api.ts.

## GET /api/me
`{ uid, email, emailVerified, displayName, provider, prefs: { emailUpdates, streetDigest }, addresses: [{ id, label, address, lat, lng }], following: [id], cityFollowing: [guid], createdAt, quota: { dayUsed, dayLimit, weekUsed, weekLimit, dayResetsAt, weekResetsAt, nextAllowedAt } }`. Creates the user doc on first call. `quota` times are ISO UTC; `nextAllowedAt` is null when a report would be accepted now (the per-IP backstop is not reflected).

## PATCH /api/me
JSON `{ displayName?: string|null, prefs?: { emailUpdates?: boolean, streetDigest?: boolean } }` → the `GET /api/me` shape. `emailUpdates:false` silences city-status mail for own + followed reports. `streetDigest:true` opts into the Monday "This week near …" email: one mail per week listing cases created or closed within 300 m of each saved address in the last 7 days (a saved address without coordinates is geocoded then); no activity, no mail.

## GET /api/me/reports
`{ items: [ReportView & { mine: true, following, editable, description, owned }] }` — newest first, ≤100. `editable` = still `received` (pending/awaiting review) and yours.

## POST /api/me/claim — attach this device's anonymous reports
JSON `{ ids: string[] }` (tracking tokens from the device's local list, ≤50) → `{ claimed: [id], skipped: [id] }`. Only unowned reports (or ones already yours) are claimed; knowing the id is the credential, same as `/email`.

## POST /api/me/recover — "find my reports"
Claims every unowned report whose `reporterEmail` equals the account's **verified** email → `{ claimed: [id] }`. 403 `email_unverified` otherwise.

## GET /api/me/following · PUT /api/me/following/:id · DELETE /api/me/following/:id
List (same shape as `/api/me/reports`, `mine` false) / follow (204) / unfollow (204). Followers with `emailUpdates` on get the same city-status mail as the reporter (gated like all reporter mail). Use PUT from the "already reported nearby" prompt when signed in, instead of `/follow {email}`.

## GET /api/me/city · PUT /api/me/city/:guid · DELETE /api/me/city/:guid — follow a public city case
Any case on the city's public list (`cityCases/{guid}`, the cards on `/street`), ours or not (worker/src/cityfollow.ts, routes in me.ts). `guid` = the city's case GUID, `/^[0-9a-f-]{36}$/`. PUT → 204 (404 `not_found` when no such case; idempotent). DELETE → 204 (idempotent, also for a case whose record is gone). `users/{uid}.cityFollowing` holds the GUIDs newest first, ≤100 — a full list lets the oldest follow go and that case forgets the account; `cityCases/{guid}.followerUids` ≤200. `users/{uid}.cityFollowedAt` (guid → ISO) remembers when, for `followedAt`.
GET → `{ items: FollowedCase[] }` in `cityFollowing` order (newest follow first): `{ id, caseType, category, street, status, open, createdAt, closedAt, resolution, lat, lng, followedAt, updatedAt }` — `open` = status not in Resolved / Closed / Cancelled / Merged; `closedAt` = the city's resolution date, else the close the sync watched happen (`cityinsights.closedAt`), closed cases only; `resolution` = the city's Resolution Message trimmed, or null; `followedAt` = when this account followed it (null for a follow recorded without it); `updatedAt` = `statusAt`, when the sync last saw the city move it. A case whose record vanished is skipped.
Mail — kind `city_follow` in the email log. When the 30-min sync (worker/src/citycases.ts, list status) or the daily follow-up (detail status, for open cases that left the 7-day window) sees a followed case's status move, each follower with a verified email and `prefs.emailUpdates` on gets ONE email from `mailer.sendTo`: subject `City update: <caseType> on <street> — <status>`; body: what the city did in notify.ts's neutral voice (old → new status), the city's Resolution Message as a blockquote when present, "Reported <date>", "See it on the map" → `<APP_BASE_URL>/street?case=<guid>&lat=&lng=` (lat/lng only when the case is located; the page opens the card from `case=` either way), "You follow this request on FixMyPVD — unfollow on its card." and the not-affiliated footer. Never to the city. Once per status: `cityCases/{guid}.notifiedStatus` = the status last mailed, skipped when it equals the current one. A followed case that moved gets its detail read in the same run, ahead of the per-run detail cap, so a closing mail carries the Resolution Message. Mail failures never break the sync; the health note counts `N follow mails`. A followed open case is not forgotten after 60 days like other open cases: the daily follow-up marks index entries whose doc has followers (`f`, checked from three days before the prune and daily after it, cleared when the last follower leaves), keeps them up to a year, and reads them first in the day's budget — so the closing mail still comes for a sidewalk or tree case that takes months.

## PUT /api/me/addresses · DELETE /api/me/addresses/:id
PUT JSON `{ id?, label?, address (3–300), lat?, lng? }` (both or neither) → `{ addresses }` (≤10; `id` given = replace). DELETE → `{ addresses }`.

## PATCH /api/reports/:id — edit a still-pending report (owner only)
JSON `{ description }` (≤2000) → `{ ok, description }`. 403 `not_owner`, 409 `not_editable` once it is sending/sent.

## POST /api/reports/:id/cancel — cancel a still-pending report (owner only)
→ `{ ok, status: "rejected" }`; the tracker shows "Not filed". 409 `not_cancellable` once a browser picked it up (`sending`) or after. An abandoned city draft from an earlier attempt is left alone (undeletable, harmless).

## Changes to existing endpoints
- `POST /api/report`: account required (above). `GET /api/reports/:id` with a bearer adds `mine`, `following`, `editable`, and `description` (owners only); always adds `owned` and `cancelledByReporter` (status `rejected` + this flag = the reporter withdrew it).
- HITL trust ramp (`HITL_MODE=ramp`, the launch mode): the first `ACCOUNT_TRUST_N` (3) reports of each account are human-reviewed; after that, an account with 0 rejected reports — or `users/{uid}.trusted=true` — auto-approves. `HITL_MODE=review` = every report tapped (panic switch).

## City email relay (ops, not app-facing) — added 2026-09-28
The portal account's contact email is `cases@fixmypvd.org` (Cloudflare Email Routing rule → this Worker's `email()` handler, `worker/src/relay.ts`). A city email carrying a `PVDyyyy-nnnnn` case id we filed is forwarded to that report's reporter + followers from `updates@fixmypvd.org` with `Reply-To: cases@fixmypvd.org`, and appended to `report.cityMessages` (last 20, each tagged `kind` receipt / routed (+`dept`) / ask / update, with its `messageId`; the tracking `timeline` words them by kind). When the city ASKS the reporter for something, the owner gets "The city needs more information about your report" instead of the plain copy (followers still get the copy), the ask is recorded in `report.cityAsks`, and the owner's reply (DMARC pass, from their address) is sent to the city from `cases@fixmypvd.org` — see `POST /api/reports/:id/answer`. That answer is the only thing ever sent to the city automatically. City mail with no matching case, and anything else written to the relay, goes to `NOTIFY_EMAIL`. Auto-replies, bounces and our own domain are dropped. If handling throws, the raw mail is forwarded to `RELAY_FALLBACK_TO`.
- `GET|POST /admin/portal/profile` (x-canary-token) — read the portal profile form, or `{ "email" }` to set the contact address.
- `PORTAL_NOTIFY_METHOD` var — `#cop_methodofupdate` value used on Step 1 (`585680002` Email once the relay is the profile address; default `585680003` No Contact Necessary).

## HITL (ops, not app-facing)
Review emails carry signed links `GET /hitl/approve/:id/:exp/:sig` and `/hitl/reject/:id/:exp/:sig` (HMAC-SHA256 over `action:id:exp`, 30-day expiry; path form so a quoted-printable mis-decode in transit can't corrupt them). Any intake flag — client-reported or from the Worker's own moderation pass, which runs once per report before auto-approval — forces human review regardless of account trust. No Turnstile: the required sign-in is the human check (since 2026-10-17). Pacing is per mailbox (plus-tags and gmail dots collapsed) and per IP.

## Admin — `/api/admin/*` (in-app /admin screen)
Requires a Firebase ID token whose email is in the Worker var `ADMIN_EMAILS`, verified, **Google provider** (an email-link account for the same address is refused). `GET /api/me` returns `admin: true` for such a caller so the client can show the route.
- `GET /api/admin/overview` → `{ engine: { paused, consecutiveFailures, submissionsThisHour, lastSubmissionTime, hitlMode, accountTrustN }, awaitingReview[], failed[], pending[], submitted7d[] }` — items are the admin projection (includes `description`, `descriptionOriginal`, `intakeFlags`, `reporterEmail`, `review`, `retries`, `statusDetail`).
- `GET /api/admin/reports/:id` → admin projection.
- `POST /api/admin/reports/:id/approve` (awaiting_review|pending) · `/reject` (awaiting_review|pending|failed; JSON `{ reason? }` — the reporter gets a short email, with the reason if given) · `/requeue` (failed) → updated projection; 409 `{ error, status }` if the state doesn't allow it.
- `GET /api/admin/users/:uid` → `{ uid, email, provider, trusted, submitted, rejected, createdAt }` · `POST /api/admin/users/:uid/trust` `{ trusted: boolean }` → same shape. `trusted` overrides the ramp (auto-approve) — flags still force review.
- `POST /api/admin/engine/resume` · `/pause` → `{ ok, paused }`.
- `POST /api/admin/canary/golden/:category/rebaseline` — JSON `{ controls }` replaces the live Step-3 golden for that category; no body clears it so the next live dump re-mints. Returns the canary status block.
- `GET /api/admin/reports?status&category&q&before&limit=50` → `{ items: [admin projection], next }` — every report, newest first; `q` is a case-insensitive substring over id/address/description/reporter email/case id/status detail (scans up to 10× limit); `before` = `createdAt` cursor from `next`.
- `GET /api/admin/users?before&limit=50` → `{ items: [{ uid, email, displayName, provider, emailVerified, createdAt, lastSeenAt, trusted, emailUpdates, following, addresses, submitted, rejected, awaitingReview, autoFiles }], next }`.
- `GET /api/admin/events?level&kind&reportId&before&limit=100` → `{ items, next }` (same event shape as health).
- `GET /api/admin/categories` → `{ items: [{ key, label, portalCaseTypeName, portalCaseTypeGuid, portalSearchTerm, requestType, photoRequired, seasonal, fields, golden: { source, at, lastLiveAt, drifted } | null, counts: { submitted, rejected } }] }`.
- `GET /api/admin/city-questions` → `{ generatedAt, seed: { generatedAt, dump, notes }, items: [{ category, label, demand, caseTypeName, caseTypeGuid, note, questions: [{ id, cityLabel, cityOptions, type, inSeed, lastSeenLive, counts: { app, ai, blank }, mode: 'app'|'ai', appOptions, seedLabel, seedOptions }], flags: [{ kind: 'new_question'|'gone'|'options_changed'|'app_option_stale', questionId, label, added?, removed?, firstAt, lastAt }], lastFiledAt, filings, blanks, score }] }` — read-only (docs/city-questions.md phase 1): the committed seed (`shared/city-questions.seed.json`) merged with `cityQuestions/{category}` (written after each live submit), sorted by `blanks × demand` desc, then demand.
- `GET /api/admin/config` → `{ items: [{ key, value, what }] }` — live settings and limits with one-line explanations (no secrets).
- `GET /api/admin/explain` → `{ sections: [{ key, title, summary, details[], live?, links? }] }` — the "how it works" content for the Learn tabs (pipeline, hitl, moderation, portal, sync, email, health, data), generated from the code that enforces it.
- `GET /api/admin/health?events=100` → system visibility for the /admin "System" view:
  `{ generatedAt, overall: 'ok'|'warn'|'error', engine: { paused, consecutiveFailures, submissionsThisHour, lastSubmissionTime, locked, hitlMode, accountTrustN, reporterEmailEnabled }, subsystems: [{ key, label, what, status: 'ok'|'warn'|'error'|'unknown', lastOkAt, lastErrorAt, lastError, lastDetail, okToday, errToday, expectedEvery }], counts: { pending, awaiting_review, processing, submitted, failed, rejected, 'auto-rejected' }, users, ai: { intakeToday, dailyCap }, cityFeed: { fetchedAt, items }, canary: { enabled, categories: [{ category, goldenSource: 'live'|'sim'|null, goldenAt, lastLiveAt, drifted }] }, sync: { status: 'ok'|'warn'|'error', caseIdPending, caseIdPendingOldestAt, reconcile: { at, scanned, adopted, stranded, missing (counts), ids: { adopted[], stranded[], missing[] } (PVD numbers, ≤50 each), error } | null }, events: [{ id, at, level: 'info'|'warn'|'error', kind, msg, reportId, data }] }`.
  Subsystems: tick (engine cron, expected every minute), submit (portal filing), watcher (30 min), cityfeed, canary (daily), daily, email, ai, auth_mail, api. Status is derived from heartbeat freshness (`expectedEvery` is a human string like "every 30 min" / "daily, 7 am"; null for on-demand subsystems) and whether the last error is newer than the last OK. Events are kept 14 days; kinds: report.created, hitl.requested/approved/rejected, submit.ok/failed, tick.reaped/auto_rejected, engine.breaker, watcher.status, canary.drift, retention.photo_deleted, auth.link_sent, admin.pause/resume/trust.
The token-in-URL `/admin` page is retired once the app screen ships.
