# SnapPVD — launch checklist

Quiet launch. Go when every **Gate** is green. Rob-only items are marked **[Rob]**; everything else alice/bob/ICs do.

## Gates
- [ ] **Workers Paid** on the Cloudflare account **[Rob]** — Free plan = 10 min/day browser time; production needs Paid ($5/mo). Then: restore `*/30` watcher cron and `[limits] cpu_ms` in `worker/wrangler.toml`.
- [ ] **Domain** bought at launch **[Rob]** (name: SnapPVD → `snappvd.org`, verify availability the day of). Until then everything runs under pvdsnow.org.
- [ ] **pvdsnow.org (or the new domain) on Cloudflare** **[Rob: 2 nameservers at Namecheap]** → then alice: Worker custom domain `api.<domain>`, Email Routing enable, Resend domain verification → flip `REPORTER_EMAIL_ENABLED=true`, set `HITL_BASE_URL`/`APP_BASE_URL`/`NOTIFY_FROM`.
- [ ] **Token rotation** **[Rob]** (Anthropic, Resend, Cloudflare, DO) — values leaked into alice's transcript on 2026-08-22.
- [ ] **app/ at parity** (bob): Report, Track, Map, About/Privacy, Spanish strings, PWA install, Playwright green → hosting flip replaces `public/`.
- [ ] **One real report end to end**: a genuine issue, filed via the app by Rob, approved in HITL, lands as a PVD case, status update arrives. (Only real issues — never test junk to the city.)
- [ ] **Ops**: /admin reachable, daily digest arriving, canary green 3 days running, HITL_MODE=review.

## Nice-before-launch
- [ ] Photos/proofs in a real bucket (R2 scope on the token, or Blaze) — currently photos in Firestore, proofs dropped.
- [ ] Cloudflare Access in front of /admin (needs Zero Trust scope on the token).
- [ ] City public feed merged + `/api/nearby` dedupe prompt (ic-feed in flight).
- [ ] Privacy page + data retention job (delete photos 30 days after Resolved).

## Launch day (from docs/product-spec.md §5)
1. Flip hosting to app/, confirm tracking links and Turnstile on the prod origin.
2. Post in r/providence + Nextdoor with 3 screenshots (marketing/ has drafts to refresh under the new name); no press.
3. Watch /admin for the first 48h; HITL stays on review mode until 20 clean submissions, then `ramp`.
4. Rotate the pvdsnow.org sunset page into a redirect.

## Runbooks (short)
- Engine paused (breaker): /admin → Resume. Check the failed rows first.
- Portal drift alert: run `/canary` to confirm, then fix selectors in `worker/src/portal.ts`, deploy (push to main deploys).
- Stuck in "Sending": the reaper fails it after 20 min; requeue from /admin (draft resumes).
