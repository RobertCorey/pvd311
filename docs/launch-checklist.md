# FixMyPVD — launch checklist

Quiet launch. Go when every **Gate** is green. Rob-only items are marked **[Rob]**; everything else alice/bob/ICs do.

## Gates
- [x] **Workers Paid** — done 2026-08-22; 30-min watcher + cpu limit restored.
- [x] **Domain** — fixmypvd.org bought 2026-08-22 (Cloudflare Registrar). Firebase Hosting custom domain requested; api.fixmypvd.org attached.
- [x] **Email** — Email Routing on fixmypvd.org (rob@ → Gmail, labeled), Resend domain verified, reporter emails ENABLED, Worker vars point at fixmypvd.org. (pvdsnow.org stays at Namecheap; it will just 301.)
- [ ] **Token rotation** **[Rob]** (Anthropic, Resend, Cloudflare, DO) — values leaked into alice's transcript on 2026-08-22.
- [x] **app/ at parity** (bob): Report, Track, Map, About/Privacy, Spanish strings, PWA install, Playwright green (24) → hosting flipped 2026-08-22; `public/` removed. Live Lighthouse 99/100/100/100.
- [x] **Facelift live** (design lead + bob): FixMyPVD brand (docs/design-direction.md) on every screen, light+dark, en+es, self-hosted fonts, icons/og regenerated, axe spec green. Live Lighthouse 2026-08-22: perf 93–97 / a11y 100 / BP 100 / SEO 100, CLS 0; LCP ≈2.5–3 s is React+router+Report bundle cost (route splitting done, ~91 KB gz floor) — accepted pre-launch.
- [ ] **Accounts required** (accounts lead + bob): client gate at Send live (draft preserved across sign-in); Worker `401 auth_required` + uid pacing + per-account ramp (N=3) landing; sign-in links minted by the Worker via Resend (Firebase's own sender never delivered). Launch HITL_MODE=ramp.
- [ ] **One real report end to end**: a genuine issue, filed via the app by Rob, approved in HITL, lands as a PVD case, status update arrives. (Only real issues — never test junk to the city.)
- [ ] **Ops**: /admin reachable, daily digest arriving, canary green 3 days running, HITL_MODE=review.

## Nice-before-launch
- [ ] Photos/proofs in a real bucket (R2 scope on the token, or Blaze) — currently photos in Firestore, proofs dropped.
- [ ] Cloudflare Access in front of /admin (needs Zero Trust scope on the token).
- [x] City public feed merged + `/api/nearby` dedupe prompt (Worker + app, 2026-08-22).
- [x] Privacy page (app /privacy) + data retention job (worker 7fe7404).

## Launch day (from docs/product-spec.md §5)
1. ~~Flip hosting to app/~~ done 2026-08-22 (tracking links + Turnstile confirmed on pvdsnow.org). On domain day: repeat from fixmypvd.org (docs/cutover.md).
2. Post in r/providence + Nextdoor with 3 screenshots (marketing/ refreshed for FixMyPVD — see marketing/README.md); no press.
3. Watch /admin for the first 48h; HITL stays on review mode until 20 clean submissions, then `ramp`.
4. Rotate the pvdsnow.org sunset page into a redirect.

## Runbooks (short)
- Engine paused (breaker): /admin → Resume. Check the failed rows first.
- Portal drift alert: run `/canary` to confirm, then fix selectors in `worker/src/portal.ts`, deploy (push to main deploys).
- Stuck in "Sending": the reaper fails it after 20 min; requeue from /admin (draft resumes).
