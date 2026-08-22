# SnapPVD — Product Spec

> Owner: product-design IC (decided, not optioned). Source of truth for name, brand, UX, and the client-facing API contract.
> Build target: Vite + React + TS mobile-first PWA (`app/`) talking only to the Cloudflare Worker API. The official Providence 311 portal remains the system of record; the Worker drives it headlessly.
> Status: DECIDED 2026-08-22. Supersedes the PVD-Snow-derived `public/` flow. Do not anchor on the old 4-step wizard — this is a single-screen report: **the reporter picks the category, then snaps + sends.** No AI photo classification; AI is invisible plumbing (moderation/abuse + optional wording cleanup) only.

---

## 1. Name

**SnapPVD** — decided.

- **Why:** "Snap" *is* the hero interaction (photo-first camera button) — the name doubles as the instruction. It is a strong single-word app-icon anchor, unmistakably a consumer app (no seal/navy/"311" officialese), and reads locally as "Snap Providence" (PVD = the airport code residents already use affectionately, not an official designation). Clears the "must never imply it is the city" bar via voice + disclaimer, not by burying the place name.
- **Domain verdict (whois, 2026-08-22):** `snappvd.org` **and** `snappvd.com` are both **available** ("Domain not found" / "No match"). **Buy `snappvd.org` as primary** (the .org reinforces independent / community / not-for-profit, which supports the "not the city" posture) and **`snappvd.com` defensively** (301 → .org).
- **Runners-up (both TLDs also verified available 2026-08-22):**
  1. **FixMyPVD** — strongest "not the city" signal via the FixMyStreet civic-tech lineage; weaker as a single-word icon and one syllable longer.
  2. **HeyPVD** — friendliest/most casual; but vague about what the app *does*.
- Rejected from the shortlist: **ReportPVD** (borders on sounding official — "report to Providence"), **SpotPVD** ("spot" is a weaker verb than "snap" for a photo-first tool).

App/store display name: **SnapPVD**. iOS home-screen / PWA short name: **SnapPVD**.

---

## 2. Brand

### Palette (5 tokens + supporting)

Chosen for WCAG AA on the pairings the UI actually uses (white text on `--accent`; ink text on `--accent-2`). Deep teal reads civic-but-not-governmental; warm orange is the "signal" color for the map pin, active states, and highlights.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#F6F7F9` | `#0D1117` | App background |
| `--surface` | `#FFFFFF` | `#161C26` | Cards, sheets, inputs |
| `--ink` | `#131A24` | `#EAF0F6` | Primary text |
| `--accent` | `#0F766E` | `#2DD4BF` | Primary actions, links, wordmark |
| `--accent-2` | `#EA6A34` | `#F98B54` | Map pin, active/selected, highlights |

Button text: **white** on `--accent` in light (contrast ≈ 5.3:1, AA); **ink `#0D1117`** on `--accent` in dark (bright teal → dark text, high contrast). `--accent-2` is a fill/stroke color, never a text background — pair it with ink text only.

Supporting tokens the engineer must also define (not part of the "5" but required):

| Token | Light | Dark | Use |
|---|---|---|---|
| `--muted` | `#5B6675` | `#9AA7B6` | Secondary text, hints |
| `--line` | `#E4E7EC` | `#26303C` | Borders, dividers |
| `--success` | `#16794C` | `#3DD68C` | Resolved status |
| `--warn` | `#B45309` | `#F5B65B` | Out-of-area, cancelled |
| `--danger` | `#B42318` | `#F97066` | Emergency/911, hard errors |

Theming rules (from artifact/PWA conventions): define the full light palette on bare `:root`; redefine only changed tokens under `@media (prefers-color-scheme: dark)` guarded `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]` so a manual toggle wins both ways. `body` gets an explicit `--bg`. Respect `prefers-reduced-motion`.

### Typography (Google Fonts)

- **Display / headings + wordmark:** **Sora** (600, 700) — geometric, confident, distinctive; carries the "SnapPVD" wordmark.
- **Body / UI:** **Inter** (400, 500, 600) — best-in-class small-size mobile legibility.
- Stacks: `"Sora", system-ui, sans-serif` / `"Inter", system-ui, -apple-system, sans-serif`. Always ship the fallbacks (fonts.googleapis.com is the only allowed remote host).

### Icon concept

A **dropped map pin whose lens is a camera aperture** — one mark that says "photo" + "location here."

- **App tile:** rounded-square (`rx≈22%`) filled `--accent` teal. Centered **white map-pin teardrop** (`M12 2a7 7 0 0 0-7 7c0 5 7 12 7 12s7-7 7-12a7 7 0 0 0-7-7z`). The pin's inner circle is a **camera aperture** — a small hexagon/iris knockout instead of a plain hole. Two thin **`--accent-2` orange focus-brackets** in opposite tile corners frame it (the "snap"). Draw as flat SVG paths, no gradients.
- **Monochrome / favicon fallback:** white pin + round hole on solid `--accent`, brackets dropped. Favicon emoji stand-in: 📍.
- Deliverables the IC draws: `icon-mark.svg` (full), `icon-mono.svg`, and PWA `192/512/maskable` PNGs (maskable = tile with ≥10% safe padding).

### Voice

**Direct, neighborly, reassuring.** Plain words, no bureaucratese, no hype; upfront about being a volunteer relay; never speaks *as* the city.

- Microcopy example (hero subtext): **"Snap a city problem. We'll file it with 311 for you."**
- Microcopy example (rate-limited): **"One report at a time — give it a minute and try again."**

### Tagline + disclaimer

- **Tagline (one sentence):** *"Report a Providence street problem in one photo — we file it with the city's 311 for you."*
- **Footer disclaimer line (verbatim, every page):** *"SnapPVD is an independent community project and is not affiliated with, endorsed by, or operated by the City of Providence."*

---

## 3. UX Spec

Mobile-first. **Happy path: ≤4 taps, under 45s.** One report screen (no multi-route wizard) with progressive disclosure. **The reporter picks the category — there is no AI "what is this photo" step.** AI is invisible plumbing: a moderation/abuse pass and an optional wording cleanup, on the review step only.

**Happy-path tap count:** (1) tap a **category tile** (e.g. Pothole). (2) tap **Take photo** → system camera → use shot; app auto-fills location from photo EXIF and reverse-geocodes the address. (3) tap **Send to 311**. → Confirmation. (Pin drag / description / reaching a less-common category via the "Other" sheet are optional and don't add required taps.)

### 3.1 Report screen (`/`) — two phases, one screen

A **slim header** persists across both phases: "SnapPVD" wordmark (teal), a small "not the city" microtag, and a **My reports** affordance (opens the list of tokens saved on this device). No account, no login.

**Phase A — Category (step one).** A grid of **big category tiles** is the first and main thing on the screen — the reporter says what's wrong. The **eight core categories** are front and center, each a large icon + label tap target:

> **Pothole · Missed trash · Bins/carts · Street light · Illegal dumping · Abandoned vehicle · Parking · Animal control**

In winter the two **snow** tiles (**Unshoveled sidewalk**, **Street not plowed**) surface alongside them (seasonal flag in `shared/categories.ts`). A final **Other / something else** tile opens a **bottom sheet** with the full list — **Noise**, **I'm not sure**, and anything not promoted to a core tile. Tapping any tile selects it and advances to Phase B (brief auto-advance, matching the fast old flow). The full launch set and GUIDs come from `shared/categories.ts`; keep the core-eight ordering here in sync with it.

**Phase B — Details.** The chosen category shows as an **editable chip** at the top (tap it → back to the grid / sheet to change). Below it, top-to-bottom:

1. **Photo** — large tappable card, `--accent` outline. Primary **Take photo** (`<input capture="environment">`), secondary **Choose from library**. After capture: compressed thumbnail (max ~1280px, JPEG q≈0.7) + **Retake**. Photo is **required for**: pothole, illegal_dumping, abandoned_vehicle, parking, unshoveled_sidewalk, missed_plowing. **Optional for**: missed_trash, bins_carts, street_light, animal_control, noise, unsure. (Sourced from `photoRequired` in `shared/categories.ts`.)
2. **Location card** — mini interactive map with a **draggable pin** (`--accent-2`) + an **address text field** below (always editable). "Use my location" GPS chip. Resolution priority: **photo EXIF GPS → device GPS → manual type/pin-drag**. Shows the reverse-geocoded address (ArcGIS World Geocoder, matching the portal) and a subtle lat/lng line. Pin drag re-reverse-geocodes.
3. **Description field** — single growing textarea, placeholder *"What's going on? (optional)"*.
4. **Review + Submit** — sticky **"Send to Providence 311."** Just above it, two bits of **invisible AI plumbing** call `/api/intake` (debounced, once a description and/or photo exists): (a) a **moderation/abuse pass** whose `flags` surface as notices here (emergency → 911 block, not_311 notice, abuse block — see states); (b) an **optional one-tap "tidy up wording"** offering the `polishedDescription` (never auto-overwrites the reporter's text; skipping it is fine). No category suggestion — the reporter already chose. The city never receives unreviewed AI text: polish is a suggestion the reporter accepts, and final submission is HITL-gated server-side at launch. Submit is disabled only on a hard block (no category, required photo missing, outside Providence, rate-limited).

Email is **not** on this screen (kept minimal for speed) — it's offered on the confirmation screen.

**Every state:**

| State | Trigger | UX |
|---|---|---|
| No GPS / permission denied | geolocation denied or unsupported | No block. Pin sits at Providence center, address field focused, hint *"Type the nearest address or intersection."* |
| Photo has no EXIF | photo attached, no GPS tag | Photo keeps; fall back to device GPS → manual. Note: *"No location in this photo — using your device location."* |
| Photo capture fails | camera unavailable | Fall back to **Choose from library**; if none and category needs a photo, keep Submit disabled with helper; photo-optional categories may proceed. |
| Outside Providence | resolved lat/lng outside city bbox (`41.772–41.871 N, −71.473 – −71.370 W`) | Amber inline notice under address: *"SnapPVD only covers Providence city limits."* Submit disabled. Offer "fix the address" + a link to the city portal for non-PVD. |
| Offline queue | Submit while `navigator.onLine === false` | Optimistic success: *"Saved on your phone — we'll send it when you're back online."* Store in IndexedDB outbox; register Background Sync; flush on `online` + on load. A queued report has **no tracking token yet** — the confirmation shows a "pending send" state and the token appears (and is saved to My reports) once it flushes to the server. Never double-submit (queue only on known-offline start, not on timeouts). |
| Emergency flag → 911 | `/api/intake` `flags` includes `emergency` (gas leak, downed live wire, fire, injury, active hazard) | **Blocking** modal, `--danger`: *"This looks like an emergency. Call 911 now — 311 is for non-urgent city issues."* Buttons: **Call 911** (`tel:911`) primary; **It's not an emergency, continue** secondary. No submit until dismissed. |
| Not-311 notice | `flags` includes `not_311` (state road/RIDOT, RIPTA, police matter, private property dispute, utility co.) | **Non-blocking** notice with the suggested right channel from `note`; user may continue (they may know better) or switch to "Something else." |
| Rate-limited | `/api/report` → `429` (or local cooldown) | *"One report at a time — give it a minute and try again."* Submit disabled with a countdown from `Retry-After`. |
| Submit error (other) | 4xx/5xx, timeout | Inline error banner with retry; do **not** auto-queue (dup risk). Preserve all entered data. |
| Duplicate nearby | `/api/nearby` returns a close match at location-set time | Dedupe prompt (see 3.4) — surfaced before submit, dismissible. |

### 3.2 Confirmation screen

- Big check + **"Sent to Providence 311."** (or, when queued offline, **"Saved — we'll send it when you're back online."**).
- **Tracking link** — the token URL `snappvd.org/r/:token` (no account). **Copy link**, **Add to Home Screen** hint, and it's auto-saved to **My reports** on this device.
- **Optional email** — field: *"Want the city's status updates by email?"* + consent line *"We pass it to the city so they can email you about this report. Nothing else — no newsletters."* Submitting it calls `POST /api/reports/:token/email`.
- **Share** — native share (`navigator.share`) + copy; share text names the app and that it takes ~30s.
- **Submit another** — resets to a clean report screen.

### 3.3 Tracking page (`/r/:token`)

- **Timeline** (vertical, newest state emphasized):
  1. **Received by SnapPVD** — ts.
  2. **Sent to the city** — ts + **PVD case id** (e.g. `PVD2026-87657`) once the Worker's headless submit returns it. (Queued/pending shows "Sending to the city…".)
  3. **City status** — mirrors the portal: **Submitted → Assigned → Resolved / Cancelled**, each with ts, polled from My Requests + `GetActivities`.
- **Content:** the photo, map pin, category, address, description.
- **"What to expect"** — plain copy: the city works these in ~days; you'll get email if you added one; this record is public on the city feed.
- **States:** `pending_send` (offline/queued), `sent_awaiting_caseid`, `submitted`, `assigned`, `resolved`, `cancelled`, `needs_attention` (HITL rejected / submit failed). **Cancelled** shows an explainer (often duplicate / out-of-scope) + a "report again with more detail" nudge. No PII beyond what the reporter entered; the page is reachable only via the unguessable token.

### 3.4 Public map / feed (`/map`)

- Map + list toggle of **recent reports** = ours ∪ the city public feed (`/public-requests`), pins colored by status. List rows: category, street, status, age.
- **Dedupe prompt** (also fires inline on the report screen once location is set): *"Already reported nearby — pothole on Benefit St, 2 days ago. Following it helps the city prioritize."* Actions: **Follow** (attach your email to that case for updates via `POST /api/reports/:token/follow` — for a city-only item, follow subscribes by case id) or **Mine is different — continue.**
- Ours link to `/r/:token`; city-only items open a read-only detail (or out to the portal).

### 3.5 About / Privacy (`/about`)

Essentials to render (independent-project framing; the old `public/privacy.html` copy is a good base but the data model changed — **no Firebase client, no anonymous device ID**; tracking is by server-issued token):

- **What it is:** an independent, volunteer community project; **not the city**; we relay your report into the city's official 311.
- **Public record:** once filed, the report (photo, location, description, any name) is a public record on the city's feed — we can't undo that.
- **What we keep (minimal):** category, location, description, optional photo, optional email/name, per-category answers. No accounts. No ads. **Never sold.**
- **Retention:** **photos auto-deleted after the city resolves the case + 30 days**; report records minimized after resolution. Tracking tokens are random and unguessable.
- **Contact** email + link to the official portal for people who'd rather use it directly.

### 3.6 Accessibility + i18n

- **All user-facing strings in one file:** `src/i18n/strings.en.json` (+ `strings.es.json`), keyed; `useT(key, vars)` hook; **no hardcoded copy in components**. Spanish is a priority second locale (large Hispanic/Latino population in Providence) — structure for it from day one, ship `en` first, `es` when translated.
- **WCAG AA:** ≥44×44px tap targets; visible focus rings; contrast AA (palette is pre-checked); `prefers-reduced-motion`; `aria-live` on the intake band, status, and errors; real `<label>`s; the map is **never the only way** to set location (address field is always present and sufficient); semantic headings; `prefers-color-scheme` + manual light/dark toggle. Layout uses logical properties (ready for future locales).

---

## 4. API contract (client ↔ Worker)

Base: `https://snappvd.org/api`. All requests carry a **Cloudflare Turnstile token** (`cf-turnstile-response`) for bot defense (no Firebase, no anon auth). JSON everywhere except `/report` (multipart). Errors use a common shape:

```json
{ "error": { "code": "rate_limited|outside_area|bad_request|not_found|server_error", "message": "human string", "retryAfter": 120 } }
```

### POST /api/report  (multipart/form-data)
Creates a report and returns its tracking token. The Worker validates server-side, stores the photo, rate-limits by IP/device, and enqueues the headless portal submit (HITL-gated at launch).

- Parts: `photo` (file, optional per category), `data` (JSON string):
```json
{
  "category": "pothole",
  "address": "120 Benefit St, Providence, RI",
  "lat": 41.8268, "lng": -71.4053,
  "description": "Deep pothole in the right lane",
  "extra": { "size": "Medium (~28in)" },
  "reporterName": null,
  "reporterEmail": null,
  "usedPolishedText": false,
  "clientDedupeAckToken": null,
  "turnstileToken": "0.abc..."
}
```
- `201`:
```json
{ "token": "r_8kQ2f7mЬ...", "status": "pending_send", "trackingUrl": "https://snappvd.org/r/r_8kQ2f7m...", "createdAt": "2026-08-22T19:12:00Z" }
```
- Errors: `429` (`rate_limited`, `Retry-After` header), `422` (`outside_area`), `400` (`bad_request`), `403` (bad Turnstile).

### POST /api/intake  (application/json)
Moderation/abuse pass + optional wording cleanup. **No category classification** — the reporter picks the category — and **no side effects** (does not create a report). Called on the review step.
- Request (`category` is always the reporter's pick, never null):
```json
{ "category": "pothole", "description": "big hole in the road on benefit", "address": "Benefit St", "hasPhoto": true }
```
- `200`:
```json
{
  "polishedDescription": "Large pothole in the roadway on Benefit St.",
  "flags": [],
  "note": null
}
```
- `flags` ⊆ `["emergency","not_311","abuse","needs_more_info","low_quality_photo"]`. `note` is a short human string when a flag needs explaining (e.g. not_311 → which channel). `polishedDescription` is a suggestion only; the client never auto-applies it.

### GET /api/reports/:token
- `200`:
```json
{
  "token": "r_8kQ2f7m...",
  "category": "pothole",
  "address": "120 Benefit St", "lat": 41.8268, "lng": -71.4053,
  "description": "Deep pothole in the right lane",
  "photoUrl": "https://snappvd.org/p/....jpg",
  "status": "assigned",
  "pvdCaseId": "PVD2026-87657",
  "timeline": [
    { "state": "received", "at": "2026-08-22T19:12:00Z" },
    { "state": "sent", "at": "2026-08-22T19:14:20Z", "pvdCaseId": "PVD2026-87657" },
    { "state": "submitted", "at": "2026-08-22T19:14:25Z" },
    { "state": "assigned", "at": "2026-08-23T13:02:00Z", "department": "Public Works" }
  ],
  "hasEmail": false
}
```
- `404` (`not_found`) for unknown/expired tokens.

### POST /api/reports/:token/email
Attach or update the reporter email (from the confirmation screen) so the city can send updates.
- Request: `{ "email": "me@example.com", "consent": true, "turnstileToken": "..." }`
- `200`: `{ "ok": true }` · `404` unknown token.

### POST /api/reports/:token/follow
Follow an existing report/case (dedupe path) for status updates.
- Request: `{ "email": "me@example.com", "pvdCaseId": "PVD2026-87657", "turnstileToken": "..." }`
- `200`: `{ "ok": true }`

### GET /api/public-feed?bbox=minLng,minLat,maxLng,maxLat[&limit=]
Recent reports (ours ∪ city feed) for the map/list.
- `200`:
```json
{ "items": [
  { "source": "snappvd", "token": "r_...", "category": "pothole", "street": "Benefit St", "status": "assigned", "lat": 41.82, "lng": -71.40, "createdAt": "..." },
  { "source": "city", "pvdCaseId": "PVD2026-80011", "category": "Pothole Report", "street": "Hope St", "status": "submitted", "lat": 41.83, "lng": -71.39, "createdAt": "..." }
] }
```

### GET /api/nearby?lat=&lng=&radius=  (meters; default 120)
Dedupe check at location-set time.
- `200`: `{ "matches": [ { "source":"city","pvdCaseId":"PVD2026-80011","category":"pothole","street":"Benefit St","status":"submitted","ageDays":2,"distanceM":45 } ] }` (empty array when none).

---

## 5. Launch notes (quiet launch — for later)

Post in this order; each step gated on the previous going smoothly. No city outreach unless the city contacts us.

1. **Seed (private):** DM the link to ~10 neighbors/friends who already report to 311; fix rough edges from their *real* reports before any public post.
2. **Reddit** r/providence + r/RhodeIsland: one honest "I built a faster way to file 311 reports from your phone" post (reuse `marketing/reddit.md`, updated to SnapPVD), answer every comment; lead with the pothole/trash pain, disclose it's an independent volunteer project.
3. **Hyperlocal groups:** Nextdoor + neighborhood-association Facebook groups + ward groups, one tailored post each (`marketing/nextdoor.md`, `marketing/facebook.md`); let the built-in share loop + Add-to-Home carry it peer-to-peer.
4. **Local press (only if traction is organic):** a single soft tip to a RI outlet (What'sUpNewp / GoLocalProv) — still quiet, still no city contact.
5. **Watch the numbers before scaling:** track city acceptance vs. cancel rate and submit success on the dashboard; widen distribution only once the city is cleanly accepting reports.
