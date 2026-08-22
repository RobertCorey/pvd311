# PLAN — PVD311 relaunch (generic, mobile-first Providence 311)

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

## M2 — PWA de-snowed (public/)
- [x] Restore wizard index.html from git (51e3331^), strip snow copy/theme/icons (working title "PVD 311" until M6)
- [x] Category picker driven by a curated launch set (~8) mapped to census GUIDs; "I'm unsure" fallback (`scripts/gen-categories.mjs` → `public/categories.js`; seasonal hiding; per-category extra questions; photo-optional gate)
- [x] Reporter email promoted ("get the city's updates"); consent copy
- [ ] Service worker: real offline queue instead of kill switch; manifest/icon fixes for iOS

## M3 — Safety before reopening writes
- [x] Firestore rules rewrite (create-only, schema-validated, deployed) + App Check registered (enforcement flips when PWA ships it)
- [ ] Anonymous auth + per-UID quota; abuse config list replaces the Congdon St hack
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
- [ ] Dockerfile (official Playwright image, shm fix), compose, secrets as mounts
- [ ] NAS first (known-good residential IP); VPS spike with WAF test from its IP
- [ ] Sentry restore (front + back)

## M6 — Domain, relay, launch
- [ ] Pick name, buy domain, inbound routing → readable inbox; set as portal contact email
- [ ] Relay: parse city emails (case ID keyed) → reporter; ESP for outbound
- [ ] AI intake call (category suggestion + polish + moderation), reporter approves
- [ ] 1–2 real E2E reports; soft launch; marketing kit (already drafted in marketing/)

## Later
- Full-auto agent loop default; VPS primary; languages; native apps; public-feed dedupe UX
