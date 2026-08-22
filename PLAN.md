# PLAN — PVD311 relaunch (generic, mobile-first Providence 311)

> **Reorientation 2026-08-22 (Rob):** the only sacred cow is *official portal = source of truth, driven headlessly*. Everything inherited from PVD Snow is up for removal. Rob is the client; product/design/brand decisions are delegated to sub-agents, never asked of him. M2/M3 below are superseded by **M7–M9**.

No launch date. Launch when it feels right, under a proper domain (name TBD — shortlist: FixMyPVD, FixPVD, HeyPVD, ReportPVD, SnapPVD).
Research + decisions: see `scripts/PORTAL-RESEARCH-ADDENDUM-2026-08.md`, `.claude/STATE.md`, and the dossier artifact.

## Principles
- Good tenant of the city portal: minimal drafts, conservative rate caps, no junk. Unmapped categories are handled by an **agent scout** (LLM reads the live Step-3 controls and fills them), never by erroring and never by pre-crawling.
- City never receives unreviewed AI text at launch. HITL mode (phone-tap approval) is the launch mode; full-auto with agent-in-loop is the goal.
- Every change committed small; `.claude/STATE.md` updated at end of each session.

## M1 — Generic submitter (automation/)
- [x] Select case type by GUID (`tr[data-id]`) from `scripts/case-type-census-2026-08-21.json`, not text match
- [x] Category config: per-type Step-3 field map (pothole→cop_size, animal→cop_typeofanimal, vehicle→cop_vehicledetails, …)
- [x] Generic Step-3 filler: dump visible controls, fill from config; unmapped → agent scout (Claude reads controls + report, proposes values, persists mapping; low confidence → HITL)
- [x] Draft-resume: persist wizard stepid/entity id after Step 1; retries resume the same draft
- [x] Headless re-auth inside the submit path (login redirect → re-login → retry once)
- [x] Proof capture: screenshot + case ID per submission (private Storage, 90-day lifecycle)
- [x] Selector hardening (loose aria-label match for case-type button), honeypot never filled
- [x] Relax photo-required gate per category

> PIVOT 2026-08-22 (Rob): only sacred cow = official portal driven by headless browsers. M1–M6 below are the pre-pivot plan; `public/` is FROZEN (live, no new work). See M7–M9.

## M2 — PWA de-snowed (public/) — DONE, then FROZEN by the pivot
- [x] Restore wizard index.html from git (51e3331^), strip snow copy/theme/icons (working title "PVD 311" until M6)
- [x] Category picker driven by a curated launch set (~8) mapped to census GUIDs; "I'm unsure" fallback (`scripts/gen-categories.mjs` → `public/categories.js`; seasonal hiding; per-category extra questions; photo-optional gate)
- [x] Reporter email promoted ("get the city's updates"); consent copy
- [x] Service worker: real offline queue instead of kill switch; manifest/icon fixes for iOS (app-shell cache + IndexedDB outbox, 47551b7)

## M3 — Safety before reopening writes
- [x] Firestore rules rewrite (create-only, schema-validated, deployed) + App Check registered (enforcement flips when PWA ships it)
- [x] Anonymous auth (enabled in console 2026-08-22) + per-UID pacing (users/{uid}.lastReportAt, 3 min) — PWA write path verified against prod
- [ ] Abuse config list replaces the Congdon St hack
- [ ] Billing kill switch (budget → Pub/Sub → disable billing) + alerts — BLOCKED: project needs Blaze billing (Rob)
- [x] Storage rules: authenticated per-uid uploads (deployed)

## M4 — Unattended ops
- [x] Engine state in Firestore (breaker, counters); reaper for stuck `processing`; auto-retry
- [x] HITL mode: Telegram approve/reject; trust ramp per category; switchable to full-auto (needs TELEGRAM_BOT_TOKEN)
- [x] Status watcher: poll My Requests (+ optional GetActivities) → Telegram alerts; reporter email notifications in M6
- [ ] `/healthz`, Uptime Kuma, Telegram alerts only for human-needed states; daily digest
- [x] Daily selector canary (zero-draft)
- [x] Dashboard bound to localhost (HOST env to expose)

## M5 — Deploy
- [x] Dockerfile (official Playwright image, shm fix), compose, secrets as mounts — build unverified (no Docker on the Mac); verify on NAS
- [x] SPIKE GREEN 2026-08-22: Cloudflare Browser Run logs into the portal with no WAF challenge (egress 104.28.163.178, 48s canary). Runtime = Cloudflare Workers + Browser Run. DO is out.
- [ ] Port to the Worker: Firestore via REST (service-account JWT), portal.ts → @cloudflare/playwright, auth state in KV, proofs in R2, cron triggers (1-min submit tick, 30-min watcher, daily canary/digest), HITL approve/reject endpoints (signed links), dashboard behind Cloudflare Access
- [ ] GitHub Actions: deploy Worker on push to main
- [ ] Sentry restore (front + back)

## M6 — Domain, relay, launch
- [ ] Pick name, buy domain, inbound routing → readable inbox; set as portal contact email
- [ ] Relay: parse city emails (case ID keyed) → reporter; ESP for outbound
- [ ] AI intake call (category suggestion + polish + moderation), reporter approves
- [ ] 1–2 real E2E reports; soft launch; marketing kit (already drafted in marketing/)

## Later
- Full-auto agent loop default; VPS primary; languages; native apps; public-feed dedupe UX

## M7 — Worker is the product backbone (supersedes the laptop engine + client Firestore writes)
- [x] Engine/HITL/watcher/canary running on cron in the Worker (deployed 2026-08-22; E2E: API report → cron → HITL email → signed reject; inspect-mode wizard from the edge)
- [x] App API: POST /api/report (Turnstile, pacing, photo → Firestore on Spark, served by /api/photos/:id), POST /api/intake (moderation + polish; verified it strips PII), GET /api/reports/:id, GET /api/public-feed
- [ ] Proof screenshots + photos to a real bucket (R2 or Blaze) — Spark can't take server-side bucket writes
- [ ] POST /api/reports/:id/email (attach email after submit); later: /api/nearby, follow
- [ ] Archive automation/ (reference only); delete Firestore client rules/App Check enforcement once the client no longer writes

## M8 — Product identity + UX (decided by a product-design IC, not Rob)
- [x] Name: SnapPVD (snappvd.org/.com available 2026-08-22 — Rob buys), brand tokens, logo concept
- [x] UX spec (docs/product-spec.md): category-first one-screen report, AI = moderation/polish only (Rob), tracking page, public map, copy

## M9 — New client `app/` (bob) — SnapPVD per docs/product-spec.md
- [x] Scaffold: Vite + React + TS, installable PWA, Playwright; Worker API client; Turnstile; brand + tokens + i18n strings file
- [x] Report screen: 8 tiles + Other (picker first, per Rob), photo (camera/library, EXIF → location), geolocation + forward/reverse geocode + Providence guard, per-category extra questions, description + AI intake (moderation/polish, reporter approves), sticky submit
- [x] Offline outbox (IndexedDB) with flush on reconnect
- [x] My reports (device-local tokens)
- [ ] Tracking page `/r/:id` + confirmation (copy/share, email attach once the Worker has the endpoint)  ← IC app-track
- [ ] Public map + feed `/map` (Leaflet, lazy) ← IC app-map
- [ ] About + Privacy, SnapPVD icon set ← IC app-about
- [ ] Spanish strings (`strings.es.json`) + language switch
- [ ] Location mini-map with draggable pin (spec §3.1) — after MapView lands
- [ ] Dedupe prompt (needs GET /api/nearby) — parked until the Worker ships it
- [ ] Flip Firebase Hosting to `app/dist` once the Worker endpoints are live (firebase.json `_comment`), then retire `public/`; later Cloudflare
