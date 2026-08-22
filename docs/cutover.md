# Cutover checklist — FixMyPVD client goes live

Goal: `app/` served at **https://fixmypvd.org** (and the Firebase hosting domains), `public/` retired, pvdsnow.org redirecting.

## 0. Prereqs (Rob)
- [x] Buy `fixmypvd.org` — done 2026-08-22 (Cloudflare Registrar). `.com` later, Rob's call.
- [ ] Decide: keep Firebase Hosting for the client (current plan) or move to Cloudflare Pages later.

## 1. Hosts allow-lists (alice — Worker + Cloudflare)
- [x] Turnstile widget domains: `fixmypvd.org`, `www.fixmypvd.org` (preview channels `*--pvd-snow-report.web.app` can't be listed — previews stay view-only).
- [x] Worker CORS origins: `https://fixmypvd.org`, `https://www.fixmypvd.org`; Worker custom domain https://api.fixmypvd.org live.
- [x] Worker: APP_BASE_URL=https://fixmypvd.org (links return to the requesting origin until hosting is connected).
- [x] DNS: A/TXT/www CNAME set; Firebase HOST_ACTIVE + OWNERSHIP_ACTIVE; cert PROPAGATING as of 19:40.

## 2. Client (bob)
- [x] API primary → https://api.fixmypvd.org with workers.dev fallback (30881dc).
- [x] `app/src/brand.ts`: FixMyPVD, origin-aware siteUrl (design lead). contactEmail → hello@fixmypvd.org still TODO (inbox: alice).
- [ ] `firebase.json`: confirm headers; `npm run preview:app` → smoke on a phone.
- [x] Firebase custom domain: HOST_ACTIVE/OWNERSHIP_ACTIVE, TEMPORARY (browser-trusted GTS) cert serving 200; CERT_ACTIVE flips on Google's schedule.
- [x] `npm run deploy` — live on pvdsnow.org + pvd-snow-report.web.app since 2026-08-22.
- [x] (done from pvdsnow.org 2026-08-22; repeat from fixmypvd.org) Real-browser E2E: submit (photo-optional category, test-marked), confirm Turnstile passes, tracking page renders, `/map` loads. Tell alice to reject the test report.
- [ ] Retire legacy: DONE: `firebase.json` hosting → `app/dist`. Remove Firestore client rules/App Check enforcement once no client writes remain (alice owns rules).
- [x] pvdsnow.org → fixmypvd.org: DONE 2026-08-23 via `scripts/cutover-final.sh` — client-side forward in index.html (path/query/hash preserved) + canonical/OG → fixmypvd.org. A true HTTP 301 needs a second Firebase Hosting site for pvdsnow.org (re-verification → DNS TXT change at Namecheap) or the Cloudflare NS move — optional follow-up (Firebase Hosting has no host-based redirects, so it is a client-side forward in index.html + canonical link + marketing placeholders).

## 3. After
- [ ] `robots.txt` Sitemap line → real sitemap or drop it.
- [x] Lighthouse on the live origin 2026-08-22: perf 99 / a11y 100 / BP 100 / SEO 100 (pvdsnow.org).
- [ ] Update README, STATE.md, memory (`project-firebase-ops`): domain live, cutover date.
