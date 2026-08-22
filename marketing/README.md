# FixMyPVD — quiet-launch kit

Copy for the FixMyPVD launch. Each channel has its own file; post in the order below, and **each step is gated on the previous one going smoothly.**

## The one rule

**No city outreach — ever — unless the city contacts us first.** FixMyPVD is an independent community project and is not affiliated with, endorsed by, or operated by the City of Providence. Don't tag, DM, email, or reply to city accounts to promote it. If the city reaches out, that's a separate conversation.

## The URL placeholder

Every file uses the token **`FIXMYPVD_URL`** in place of the live URL, with the current value in a header line at the top of the file:

- **Now:** `https://fixmypvd.org`
- Domain is live as of 2026-08-23.

To publish, find-and-replace `FIXMYPVD_URL` with the current URL. When the domain changes, that's the only edit.

## Launch order (from product-spec §5)

- [ ] **1. Seed privately.** DM the link to ~10 neighbors/friends who already report to 311. Watch their *real* reports go through and fix rough edges before any public post. No public posting yet.
- [ ] **2. Reddit** — `reddit.md`. Post to **r/providence** first; answer every comment. Run the shorter **r/RhodeIsland** variant a day or two later, only if r/providence went well. Lead with the pothole/trash pain; disclose the volunteer, not-the-city framing.
- [ ] **3. Hyperlocal groups** — `nextdoor.md`, `facebook.md`. Nextdoor + neighborhood-association Facebook groups + ward groups, one tailored post each. Let the built-in share loop and Add-to-Home Screen carry it peer-to-peer. `twitter.md` (X) can run alongside — space the three posts out, and don't tag the city or reporters.
- [ ] **4. Local press — only if traction is organic** — `media-tip.md`. A single soft tip to one RI outlet (What'sUpNewp or GoLocalProv). Still quiet, still no city contact. Skip this entirely if the earlier steps didn't take off on their own.
- [ ] **5. Watch the numbers before scaling.** Widen distribution only once the city is cleanly accepting reports (see below).

## What to watch (on the dashboard)

Before widening distribution, the numbers have to look healthy:

- **City acceptance vs. cancel rate** — are filed reports being accepted by the city, or getting cancelled (duplicate / out-of-scope)? A rising cancel rate means slow down and tighten review, not scale up.
- **Submit success rate** — are reports making it through the headless submit to the city cleanly, or failing/erroring?
- **Seed-report quality** — during step 1, are real neighbor reports going through end-to-end without hand-holding?

Only widen once city acceptance is clean and submit success is steady.

## Voice reminders (product-spec §1–2)

- Direct, neighborly, reassuring. Plain words, no hype.
- Always upfront that it's a **volunteer relay** — it never speaks *as* the city.
- Lead with everyday problems (**pothole, missed trash**), not edge cases. Winter categories (unshoveled sidewalks, unplowed streets) only surface in winter.
- Always note: **not for emergencies (call 911)**, a person reviews before filing, filed reports are **public records** on the city's 311 feed, no account needed, Spanish available.
- Don't invent stats, quotes, dates, or endorsements.

## Historical (do not reuse)

- `mediakit-pvdsnow/` and `screenshots/` are from the winter-only PVD Snow launch. Left in place for reference; not part of this kit.
