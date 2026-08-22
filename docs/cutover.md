# Cutover checklist — SnapPVD client goes live

Goal: `app/` served at **https://snappvd.org** (and the Firebase hosting domains), `public/` retired, pvdsnow.org redirecting.

## 0. Prereqs (Rob)
- [ ] Buy `snappvd.org` (Cloudflare Registrar, dashboard; no API). `.com` optional → redirect.
- [ ] Decide: keep Firebase Hosting for the client (current plan) or move to Cloudflare Pages later.

## 1. Hosts allow-lists (alice — Worker + Cloudflare)
- [ ] Turnstile widget domains: add `snappvd.org`, `www.snappvd.org` (preview channels `*--pvd-snow-report.web.app` can't be listed — previews stay view-only).
- [ ] Worker CORS origins: add `https://snappvd.org`, `https://www.snappvd.org`.
- [ ] Worker: tracking URLs / emails use `https://snappvd.org/r/{id}`.
- [ ] DNS (Cloudflare zone, DNS-only/grey cloud for Firebase): `A`/`TXT` records from the Firebase custom-domain wizard.

## 2. Client (bob)
- [ ] `app/src/brand.ts`: `siteUrl`, `domain`, `contactEmail` final.
- [ ] `firebase.json`: confirm headers; `npm run preview:app` → smoke on a phone.
- [ ] Firebase console → Hosting → add custom domain `snappvd.org` (+ `www`), complete verification, wait for cert.
- [x] `npm run deploy` — live on pvdsnow.org + pvd-snow-report.web.app since 2026-08-22.
- [x] (done from pvdsnow.org 2026-08-22; repeat from snappvd.org) Real-browser E2E: submit (photo-optional category, test-marked), confirm Turnstile passes, tracking page renders, `/map` loads. Tell alice to reject the test report.
- [ ] Retire legacy: DONE: `firebase.json` hosting → `app/dist`. Remove Firestore client rules/App Check enforcement once no client writes remain (alice owns rules).
- [ ] pvdsnow.org → 301 to snappvd.org (Firebase Hosting `redirects` in `firebase.json`, keyed on host, or at Cloudflare once the old zone moves).

## 3. After
- [ ] `robots.txt` Sitemap line → real sitemap or drop it.
- [x] Lighthouse on the live origin 2026-08-22: perf 99 / a11y 100 / BP 100 / SEO 100 (pvdsnow.org).
- [ ] Update README, STATE.md, memory (`project-firebase-ops`): domain live, cutover date.
