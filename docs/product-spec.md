# FixMyPVD — Product Spec

> Owner: product-design IC (decided, not optioned). Source of truth for name, brand, UX, and the client-facing API contract.
> Build target: Vite + React + TS mobile-first PWA (`app/`) talking only to the Cloudflare Worker API. The official Providence 311 portal remains the system of record; the Worker drives it headlessly.
> Status: DECIDED 2026-08-22. Supersedes the PVD-Snow-derived `public/` flow. Do not anchor on the old 4-step wizard — this is a single-screen report: **the reporter picks the category, then photo + send.** No AI photo classification; AI is invisible plumbing (moderation/abuse + optional wording cleanup) only.

---

## 1. Name

**FixMyPVD** — decided 2026-08-22 (client rejected "SnapPVD"; alice's call, folded into the design direction).

- **Why:** "Fix my" is the ask in the resident's own words, and it carries the FixMyStreet civic-tech lineage — an independent tool that talks *to* the city, unmistakably *not* the city. PVD is the airport code residents use affectionately. No camera pun anywhere: the photo is the means, the fix is the point.
- **Domains:** `fixmypvd.org` (primary) + `fixmypvd.com` (defensive 301) — both verified available 2026-08-22. Build under pvdsnow.org meanwhile.
- **Display / PWA short name:** **FixMyPVD**. Wordmark is set "FixMy" in harbor ink + "PVD" in ember.
- Internal storage keys (`snappvd` IndexedDB / localStorage, API `source: 'snappvd'`) are *not* renamed — they're invisible and renaming would orphan device-local data.

---

## 2. Brand

**Superseded by [`design-direction.md`](design-direction.md) ("Ember & Harbor")** — palette, type, mark, motion, and component language live there. Summary: two inks (harbor navy `#16213A` + ember `#F4652A`) on cream paper `#F7F1E6`; dark mode = the same inks on harbor night `#0C1222`; display face Bricolage Grotesque, body Inter; mark = ink map pin with an × ("X marks the spot to fix") over an off-register ember plate.

Still binding from the original spec:

- **Theming rules:** define the full light palette on bare `:root`; redefine only changed tokens under `@media (prefers-color-scheme: dark)` guarded `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]` so a manual toggle wins both ways. `body` gets an explicit `--bg`. Respect `prefers-reduced-motion`.
- **Voice:** direct, neighborly, reassuring. Plain words, no bureaucratese, no hype; upfront about being a volunteer relay; never speaks *as* the city.
- **Tagline:** *"Report a Providence street problem in one photo — we file it with the city's 311 for you."*
- **Footer disclaimer (verbatim, every page):** *"FixMyPVD is an independent community project and is not affiliated with, endorsed by, or operated by the City of Providence."*

---

## 3. UX Spec

Mobile-first. **Happy path: ≤4 taps, under 45s.** One report screen (no multi-route wizard) with progressive disclosure. **The reporter picks the category — there is no AI "what is this photo" step.** AI is invisible plumbing: a moderation/abuse pass and an optional wording cleanup, on the review step only.

**Happy-path tap count:** (1) tap a **category tile** (e.g. Pothole). (2) tap **Take photo** → system camera → use shot; app auto-fills location from photo EXIF and reverse-geocodes the address. (3) tap **Send to 311**. → Confirmation. (Pin drag / description / reaching a less-common category via the "Other" sheet are optional and don't add required taps.)

### 3.1 Report screen (`/`) — two phases, one screen

A **slim header** persists across both phases: "FixMyPVD" wordmark (ink + ember), a small "not the city" microtag, and a **My reports** affordance (opens the list of tokens saved on this device). No account, no login.

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
| Outside Providence | resolved lat/lng outside city bbox (`41.772–41.871 N, −71.473 – −71.370 W`) | Amber inline notice under address: *"FixMyPVD only covers Providence city limits."* Submit disabled. Offer "fix the address" + a link to the city portal for non-PVD. |
| Offline queue | Submit while `navigator.onLine === false` | Optimistic success: *"Saved on your phone — we'll send it when you're back online."* Store in IndexedDB outbox; register Background Sync; flush on `online` + on load. A queued report has **no tracking token yet** — the confirmation shows a "pending send" state and the token appears (and is saved to My reports) once it flushes to the server. Never double-submit (queue only on known-offline start, not on timeouts). |
| Emergency flag → 911 | `/api/intake` `flags` includes `emergency` (gas leak, downed live wire, fire, injury, active hazard) | **Blocking** modal, `--danger`: *"This looks like an emergency. Call 911 now — 311 is for non-urgent city issues."* Buttons: **Call 911** (`tel:911`) primary; **It's not an emergency, continue** secondary. No submit until dismissed. |
| Not-311 notice | `flags` includes `not_311` (state road/RIDOT, RIPTA, police matter, private property dispute, utility co.) | **Non-blocking** notice with the suggested right channel from `note`; user may continue (they may know better) or switch to "Something else." |
| Rate-limited | `/api/report` → `429` (or local cooldown) | *"One report at a time — give it a minute and try again."* Submit disabled with a countdown from `Retry-After`. |
| Submit error (other) | 4xx/5xx, timeout | Inline error banner with retry; do **not** auto-queue (dup risk). Preserve all entered data. |
| Duplicate nearby | `/api/nearby` returns a close match at location-set time | Dedupe prompt (see 3.4) — surfaced before submit, dismissible. |

### 3.2 Confirmation screen

- Big check + **"Sent to Providence 311."** (or, when queued offline, **"Saved — we'll send it when you're back online."**).
- **Tracking link** — the token URL `fixmypvd.org/r/:token` (no account). **Copy link**, **Add to Home Screen** hint, and it's auto-saved to **My reports** on this device.
- **Optional email** — field: *"Want the city's status updates by email?"* + consent line *"We pass it to the city so they can email you about this report. Nothing else — no newsletters."* Submitting it calls `POST /api/reports/:token/email`.
- **Share** — native share (`navigator.share`) + copy; share text names the app and that it takes ~30s.
- **Submit another** — resets to a clean report screen.

### 3.3 Tracking page (`/r/:token`)

- **Timeline** (vertical, newest state emphasized):
  1. **Received by FixMyPVD** — ts.
  2. **Sent to the city** — ts + **PVD case id** (e.g. `PVD2026-87657`) once the Worker's headless submit returns it. (Queued/pending shows "Sending to the city…".)
  3. **City status** — mirrors the portal: **Submitted → Assigned → Resolved / Cancelled**, each with ts, polled from My Requests + `GetActivities`.
- **Content:** the photo, map pin, category, address, description.
- **"What to expect"** — plain copy: the city works these in ~days; you'll get email if you added one; this record is public on the city feed.
- **States:** `pending_send` (offline/queued), `sent_awaiting_caseid`, `submitted`, `assigned`, `resolved`, `cancelled`, `needs_attention` (HITL rejected / submit failed). **Cancelled** shows an explainer (often duplicate / out-of-scope) + a "report again with more detail" nudge. No PII beyond what the reporter entered; the page is reachable only via the unguessable token.

### 3.4 Public map — CUT (Rob, 2026-08-22: "half baked… keep focused")

No `/map` page. What survives from it:
- **Dedupe prompt** fires inline on the report screen once location is set (`GET /api/nearby`, 75 m same category): *"Already reported nearby — pothole on Benefit St, 2 days ago."* Actions: **View that report** / **Report anyway.**
- Backend `/api/public-feed` + the city-feed scrape stay (they feed nearby + the watcher); no UI consumes the feed.

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

**Superseded — the wire truth is [`docs/api.md`](api.md)** (v1, implemented and live on the Worker). Differences from the original draft: plain `id` tracking tokens (no `r_` prefix), multipart fields instead of a `data` JSON part, flat `{error}` shape, Worker status vocabulary `received|sending|sent|rejected` mapped to labels in the client, no `suggestedCategory` in intake (reporter picks), photos served at `/api/photos/:id`. `/api/reports/:id/email` ships; `/api/nearby` and follow come later.

## 5. Launch notes (quiet launch — for later)

Post in this order; each step gated on the previous going smoothly. No city outreach unless the city contacts us.

1. **Seed (private):** DM the link to ~10 neighbors/friends who already report to 311; fix rough edges from their *real* reports before any public post.
2. **Reddit** r/providence + r/RhodeIsland: one honest "I built a faster way to file 311 reports from your phone" post (reuse `marketing/reddit.md`, updated to FixMyPVD), answer every comment; lead with the pothole/trash pain, disclose it's an independent volunteer project.
3. **Hyperlocal groups:** Nextdoor + neighborhood-association Facebook groups + ward groups, one tailored post each (`marketing/nextdoor.md`, `marketing/facebook.md`); let the built-in share loop + Add-to-Home carry it peer-to-peer.
4. **Local press (only if traction is organic):** a single soft tip to a RI outlet (What'sUpNewp / GoLocalProv) — still quiet, still no city contact.
5. **Watch the numbers before scaling:** track city acceptance vs. cancel rate and submit success on the dashboard; widen distribution only once the city is cleanly accepting reports.
