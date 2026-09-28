# FixMyPVD — launch strategy

_Written 2026-09-28. Rob is the client; these are decisions, not options. Research behind it: `.claude/research-seasonal.md`, `.claude/research-readiness.md`, the channels brief (summarised in §6). Copy lives in `marketing/`._

## 1. The read

- **PVD Snow worked because of timing, not marketing.** It went up on r/providence (~94k members) during the Blizzard of '26 (Jan 25–26, record 37.9"), when everyone was indoors with one obvious problem to report. It produced **101 filed cases over the whole winter** — that is the realistic scale of a "viral" moment for this project: tens a day for a few days, ~100 a season. Not 300 in a night.
- **FixMyPVD has 0 organic reports since the 2026-08-22 relaunch because it was never posted anywhere.** The product is not the problem. The pipeline has also **never carried a single real case** (`/api/stats` → `filed: 0`).
- **The system today handles PVD Snow scale.** Engine cap is 15 submissions/hour (360/day). The real bottleneck on a busy night is the review ramp: every new account's first 3 reports wait for Rob to tap an email. Sign-in is a wall the old copy said didn't exist (fixed 2026-09-28).
- **A generic 311 app has no forcing event.** So we borrow them from the calendar: dark commutes, holiday trash delays, the first parking ban, pothole season. Each beat below rides one.

## 2. The plan: four beats, each gated on the last

| Beat | When | Hook | Channel | Expected volume |
|---|---|---|---|---|
| **0 — Prove it** | now → Oct 31 | Rob's own fall reports + 10 seeded neighbours | private | 10–20 cases |
| **1 — "Dark at 5"** | week of **Mon Nov 2** (DST ends Sun Nov 1) | dead street lights on the evening commute; Veterans Day trash delay Nov 11 as the follow-up | r/providence, then hyperlocal | 20–60 reports over 2 weeks |
| **2 — First storm** | the first **snow-emergency parking ban** (avg first measurable snow ≈ Dec 1; peak Jan–Feb) | unshoveled sidewalks (8 h after daylight, $25–500/day fine) + streets not plowed | r/providence again, Nextdoor, neighbourhood FB groups | 50–150 over 3 days |
| **3 — Pothole season** | late Feb → mid Mar | freeze-thaw pothole surge; the city's annual pothole-blitz news cycle | r/providence + soft press tip if traction is organic | steady trickle, then seasonal baseline |

Gates: Beat 1 only if Beat 0 filed ≥10 real cases with no engine failures and the relay forwarded ≥1 real city email. Beat 2 only if Beat 1 produced no city cancellations for duplicate/out-of-scope above ~20%. Beat 3 only if Beat 2 didn't need the kill switch.

### Beat 0 — Prove it (now → Oct 31)

The only beat with no post. Everything here is about the pipeline having carried real cases before strangers touch it.

1. **Rob files 5 real reports on a walk** (pothole, broken sidewalk, street light, tree, graffiti — one of tree/noise/traffic-signal to exercise the AI scout on the city's conditional fields). First 3 land in Rob's inbox for approval; that is the review loop test.
2. **Watch the relay on the first city email.** With notifications now set to Email and the portal contact address at `cases@fixmypvd.org`, the city's confirmation and status mails for those cases should arrive in Rob's Gmail as forwarded copies and on the tracking page timeline.
3. **Seed 10 neighbours privately** (people who already report to 311). DM the link, watch their real reports, fix rough edges.
4. **Rob-only click:** rotate the four tokens leaked in August (Anthropic, Resend, Cloudflare, DigitalOcean). (Workers Paid confirmed active 2026-09-28, renews Oct 22.)
5. Exit: ≥10 filed cases, canary green 3 days, digest quiet, no reaper/breaker alerts.

### Beat 1 — "Dark at 5" (week of Nov 2)

Why this and not the storm: it is a real, city-wide, low-stakes hook that arrives on a known date, builds the account base and the trust ramp before winter, and exercises the system at tens rather than hundreds. Providence owns its ~16,000 street lights, so "street light out" is a clean 311 category (many towns route it to the utility).

- **Config for the week:** `ACCOUNT_TRUST_N=1` (first report per account reviewed, then auto). One var change + deploy.
- **Mon/Tue evening post on r/providence** from Rob's account (copy in §5). Answer every comment for 48 h. Never repost the link. Have the "why not SeeClickFix / the city app?" answer ready (§5).
- **Day 2–3, only if r/providence went well:** the shorter r/RhodeIsland variant (`marketing/reddit.md`).
- **Week 2:** Veterans Day (Wed Nov 11) trash-delay reminder as a comment or a Nextdoor post in Rob's own neighbourhood; neighbourhood-association Facebook pages (WBNA, Fox Point, Summit, Mount Hope) one tailored post each (`marketing/facebook.md`); Olneyville Neighborhood Association gets the Spanish angle.
- **Pitch one newsletter:** Neighborly Actions (Substack, "things Providence people can do for neighbours") is the exact audience.
- Watch: reports/day, SignInGate shown → sent drop-off, submit success, city cancel rate.

### Beat 2 — First storm (Dec–Feb)

Post when the city **announces** the parking ban (press release, social, PVD311 text alerts go out ahead of the storm), not during. People are planning their evening indoors then. Winter tiles (unshoveled sidewalk, street not plowed) auto-appear in the app Nov–Mar.

- **Prereqs, done before the first ban:** global intake kill switch + daily create cap in the Worker (1–2 h; today pausing the engine stops filing but not report creation); `MAX_PER_HOUR` moved to an env var (30 min) so it can go to 30 without a code change; a bulk-approve action in /admin Queue (2 h, nice-to-have).
- **Config for the storm week:** `ACCOUNT_TRUST_N=1` stays. Rob pre-commits to ~50 approval taps over 48 h. If it gets heavy, flip `HITL_MODE=auto` (moderation flags still force review) via a push; deploy is ~1 min.
- **Post:** the PVD Snow structure that already worked, with the ordinance facts (clear a 3-ft path within 8 hours of first daylight; $25–500/day) and "streets not plowed" as the headline. pvdsnow.org still redirects, so old links and QR codes work.
- Do not widen to press during the storm. Cancel-rate is the number to watch; a rising duplicate/out-of-scope rate means tighten review, not scale.

### Beat 3 — Pothole season (late Feb → Mar)

Second general post on r/providence keyed to the freeze-thaw surge (March 2026 coverage: West End hit hardest, asphalt plants reopening). Only now, and only if Beats 1–2 grew on their own, a single soft press tip: ecoRI News or Steve Ahlquist are the most civic-aligned; What'sUpNewp / GoLocalProv as in `marketing/media-tip.md`. The Boston Globe / ecoRI journalist who emailed Rob on Sep 27 about the portal research is a wildcard: if that piece runs, ask for the link in it and skip our own tip.

## 3. Calendar

| Date | Event | What we do |
|---|---|---|
| Oct 12 (Mon) | Indigenous Peoples' Day, trash one day late all week | nothing public; Rob's own missed-pickup report if it happens |
| Oct 31 (Sat) | Halloween on a weekend, party noise near Brown/RISD/PC | nothing; noise category exists if asked |
| **Nov 1 (Sun)** | **DST ends** | Beat 1 config deployed the day before |
| **Nov 2–3** | first dark commutes | **r/providence post** |
| Nov 4–5 | | r/RhodeIsland variant if warranted |
| Nov 7 (Sat) | WaterFire final full lighting | none (crowd/parking noise, not our moment) |
| Nov 11 (Wed) | Veterans Day, trash one day late | Nextdoor / comment follow-up |
| Nov 9–20 | | neighbourhood FB pages, Neighborly Actions pitch |
| Nov 26 (Thu) | Thanksgiving; Thu→Fri, Fri→Sat pickup | one reminder post in a hyperlocal channel, not Reddit |
| ~Dec 1 | avg first measurable snow | Beat 2 prereqs must be done |
| Dec 24 (Thu) | yard-waste season ends | illegal-dumping reports rise; no post |
| Dec 25 / Jan 1 (Fri) | trash Fri→Sat | none |
| **first parking ban** | Dec–Feb | **Beat 2 post** |
| Jan 18 (Mon) | MLK Day, trash delay | none |
| Feb 15 (Mon) | Presidents' Day: **no** Providence trash delay | fun-fact comment if a thread appears |
| late Feb–Mar | pothole surge | **Beat 3 post**, optional press tip |

## 4. Engineering before each beat

| Beat | Work | Effort | Who |
|---|---|---|---|
| 0 | nothing new (relay live 2026-09-28; marketing copy fixed) | — | — |
| 0 | rotate tokens (Workers Paid confirmed 2026-09-28) | 45 min | Rob (agent sets the Worker secrets once Rob has values) |
| 1 | `ACCOUNT_TRUST_N=1` | 5 min | agent |
| 1 | `MAX_PER_HOUR` → env var | 30 min | agent |
| 1 | SignInGate funnel event (shown / signed-in / sent) in the events stream | 1 h | agent |
| 2 | global intake kill switch + daily create cap | 1–2 h | agent |
| 2 | bulk approve in /admin Queue | 2 h | agent, nice-to-have |
| 2 | re-verify Google sign-in + email-link deliverability from a fresh account | 30 min | agent |
| 3 | nothing new | — | — |

## 5. The Beat 1 post (r/providence) — paste-ready

**Title:** It gets dark at 5 now. I built a free way to report dead Providence street lights (and potholes, missed trash, and more) to 311 from your phone in about 30 seconds

**Body:**

Clocks went back this weekend, so a lot of us are walking home in the dark and noticing which street lights are out. Providence owns its street lights, and the way to get one fixed is a 311 report. The city's portal works, but it's a pain on a phone, so I built **FixMyPVD**, a free way to file one in about 30 seconds.

Pick the problem (street light out, pothole, missed trash or recycling, broken sidewalk, illegal dumping, abandoned vehicle, and more), snap a photo, confirm the address, send. It's relayed into the city's official 311 for you, you get a tracking link, and you'll get an email when the city updates it. No app store. It's in Spanish too.

A few honest notes:

- It's a **volunteer community project.** FixMyPVD is an independent project and is not affiliated with, endorsed by, or operated by the City of Providence.
- You sign in with Google or an email link so every report has a real person behind it. The city never sees your email; reports are filed from the project's 311 account.
- A person reviews each new reporter's first report before it's filed, so it's not instant, and it's **not for emergencies.** Call 911 for anything urgent.
- Once filed, a report is a public record on the city's 311 feed.
- Some of you may remember PVD Snow from the blizzard. Same project, now year-round.

Give it a shot: **https://fixmypvd.org**

Happy to answer anything.

**Ready answer for "why not just use SeeClickFix / the PVD311 app?":** You can, and the same city system receives it either way. This files into that same official portal, but from a phone in 30 seconds, with a tracking link, email updates, Spanish, and a person checking for duplicates and out-of-scope stuff so the city's queue stays clean. The official app is rated about 2 stars for crashes and location bugs, which is why I built this.

## 6. Channels, ranked (from the research)

1. **r/providence** (~94k) — the proven channel; one honest disclosed post per beat, engage every comment. Verify the sub's self-promotion rule text in a browser on the day; it could not be fetched by tooling.
2. **r/RhodeIsland** (~140k) — bigger, more diffuse; day-2 follow-up only.
3. **Neighbourhood associations** — West Broadway (WBNA), Fox Point (FPNA), Summit (snaprov@gmail.com), Mount Hope (MHNAInc@gmail.com), Downtown (DNA), Olneyville (ONA, Spanish). Hundreds to low thousands each, high intent.
4. **Nextdoor** — own-neighbourhood posts only (no citywide blast); peer-to-peer via the share loop.
5. **Newsletters** — Neighborly Actions (best fit), The Providence Eye, Base Local Providence.
6. **Press, last and only on traction** — ecoRI News, Steve Ahlquist (Substack + Bluesky), What'sUpNewp, GoLocalProv, Boston Globe RI.

Adjacent tools to expect in comments: the official PVD311 app (~2/5 stars) and SeeClickFix's Providence page (same CivicPlus backend, proof of demand).

## 7. Rules carried forward

- No city outreach unless the city contacts us. Never speak as the city.
- Never invent numbers; the only stat we quote is our own live "reports filed" pill (hidden under 20).
- One post per beat per channel; never repost the link.
- Only real issues go to the city. Test reports get rejected in review.
- If the cancel/duplicate rate climbs, slow down and tighten review. Scale is not the goal; clean cases reaching the city is.

## 8. What Rob personally does (everything else is agent work)

1. Beat 0: walk, file 5 real reports, tap the 3 approvals.
2. Beat 0: rotate the four tokens.
3. Beat 1: paste the §5 post on r/providence Mon/Tue evening Nov 2–3; answer comments for 48 h.
4. Beat 2: paste the storm post when the parking ban is announced; tap approvals for ~48 h.
5. Beat 3: paste the pothole post; decide on the press tip.
