# PVD 311 (working title)

Community app for reporting everyday issues — potholes, street lights, missed trash, illegal dumping, abandoned vehicles, parking, animal control — to Providence, RI's 311 system from a phone in ~30 seconds. **Not affiliated with the City of Providence.**

Live (pre-launch, quiet): [pvdsnow.org](https://pvdsnow.org). The name/domain is still TBD; the site runs under the old PVD Snow domain until then.

Relaunched August 2026 from the winter-only PVD Snow project (same repo, see git history before `c81a893`). Plan and status: [`PLAN.md`](PLAN.md), [`.claude/STATE.md`](.claude/STATE.md). Portal research: [`scripts/`](scripts/).

## How it works

1. **Resident** opens the PWA, picks a category, optionally snaps a photo, confirms the location, adds a description, optionally leaves an email.
2. **PWA** signs the device in anonymously (Firebase Auth), uploads the photo to Cloud Storage under that uid, and writes the report to Firestore with `status: pending` in the same batch as a per-device pacing marker (`users/{uid}.lastReportAt`; rules enforce one report per device every 3 minutes). Offline? The report is saved in an IndexedDB outbox and sent when the page next opens online.
3. **Review** — HITL mode (launch mode): the operator is notified by email (Resend) and approves/rejects from the dashboard. Full-auto with an agent in the loop is the goal.
4. **Automation** (`automation/`) logs into the city's 311 portal with Playwright, selects the case type by census GUID, fills the conditional Step-3 fields (unmapped fields → an LLM "scout" reads the live controls), submits, and stores the case ID + proof screenshot.
5. **Status watcher** polls the portal and records the city's status; the resident sees it under **My reports** in the PWA (reporters can read their own docs).

## Stack

| Layer | Tech |
|---|---|
| PWA | Vanilla JS (no build), Firebase Hosting, Auth (anonymous), Firestore, Storage, App Check (reCAPTCHA Enterprise), service worker + IndexedDB outbox |
| Shared | `shared/categories.ts` (category registry → portal GUIDs/fields), `shared/types.ts` |
| Automation | Node + TypeScript, Playwright, Firebase Admin SDK; runtime: Cloudflare Workers + Browser Rendering (in progress), Docker image for a VPS fallback |
| Target | Providence 311 portal (Power Pages / Dynamics 365) |

Firebase project `pvd-snow-report` is on the **Spark** plan (no billing): no Cloud Functions; rules + App Check + pacing do the protecting.

## Project structure

```
public/            PWA
  index.html       4-step wizard + My reports + footer (about/privacy)
  app.js           wizard logic, auth, App Check, submit (batched write)
  categories.js    GENERATED from shared/categories.ts — do not edit
  status.js        My reports (own-docs live query)
  outbox.js        IndexedDB offline queue
  sw.js            app-shell cache (versioned)
  tests/           Playwright specs
shared/            category registry + types (single source of truth)
automation/        portal submitter, HITL review, watcher, canary, dashboard; Dockerfile + DEPLOY.md
scripts/           portal research, case-type census, gen-categories.mjs
tests/rules/       Firestore/Storage rules tests (emulator)
firestore.rules    create-only, schema-validated, per-device pacing; owner read
storage.rules      per-uid image uploads, owner read
marketing/         launch kit drafts
docs/              provisioning task brief for Rob
```

## Development

```bash
# PWA (static, talks to the real Firebase project; localhost is allow-listed)
npm run dev                      # serves public/ on :3999
cd public && npx playwright test # wizard + location-step specs

# Categories: edit shared/categories.ts, then regenerate the PWA copy
node scripts/gen-categories.mjs

# Security rules (needs Java for the emulator)
npm run test:rules

# Automation
cd automation && npm run build && npm run auth   # one-time interactive portal login
npm start                                         # dashboard on :3311
```

Deploy: `npm run deploy` (hosting), `npm run deploy:rules` (Firestore + Storage rules). Automation deploy: Cloudflare (see `automation/`), or the Docker image per [`automation/DEPLOY.md`](automation/DEPLOY.md) — cloud only, never homelab.

## Principles

- Good tenant of the city portal: minimal drafts (they are permanent), conservative rate caps, no junk, no pre-crawling.
- The city never receives unreviewed AI text at launch.
- Small commits; `.claude/STATE.md` updated every session.
