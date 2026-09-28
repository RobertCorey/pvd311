# Citywide 311 demand vs weather — late September 2026

Captured 2026-09-28 ~18:35 EDT. Question: what are the most-requested case types lately, and do they track weather?

## Sources and limits

- **Public feed** (`/public-requests/` grid, hit via its `entity-grid-data.json` endpoint): the view is a rolling **7-day window** (an OData filter for earlier dates returns 0 rows), so it covers only **Sep 21 00:00Z – Sep 28 22:33Z**, 300 requests. Raw rows: `scripts/city-requests-2026-09-21_28.csv`.
- **/analytics/** "Top Requests this Year" (year-to-date totals, top 6 types only), diffed against the 2026-08-21 snapshot in `scripts/PORTAL-RESEARCH-ADDENDUM-2026-08.md` → a 38-day delta for those types.
- **Weather**: Open-Meteo archive, Providence (41.824, -71.413), daily precipitation / max gust / max temp.
- No Providence open-data 311 dataset exists (data.providenceri.gov catalog search only returns other cities), and the Worker's `meta/cityFeed` snapshot is overwritten each run, so there is no month-long per-day history. A cron that appends the 7-day feed daily would fix this going forward.

## Most popular types

**Last 7 days (Sep 21–28, n=300):**

| # | Case type |
|---|---|
| 33 | Tree Related Issue(s) |
| 27 | Missed Trash Day Pick-up Issue |
| 21 | Trash or Recycling Bins or Carts |
| 19 | Trash on Private Property or Sidewalk |
| 15 | Parking Issues to Report |
| 14 | Illegal Dumping |
| 11 | Repair a Traffic Sign |
| 11 | General Question or Concern DPW related |
| 9 | Pothole Report |
| 9 | Sidewalk Panel Repair |
| 8 | Overgrowth or High Grass on Private Property |
| 8 | Traffic Control Issues or Changes |
| 7 | Blocked Storm Drain or Catch Basin |
| 7 | Substandard Housing Code Issues or Violations |

Status mix: Resolved 116, Assigned 88, In Progress 50, Cancelled 12, On Hold 9, Dept Responded 7, Submitted 6, Draft 6, Merged 5.

**Aug 21 → Sep 28 (38 days), year-to-date deltas from /analytics/:**

| Case type | YTD Aug 21 | YTD Sep 28 | Δ |
|---|---|---|---|
| Missed Trash Day | 1,460 | 1,576 | +116 |
| Trash or Recycling Bins/Carts | 2,389 | 2,482 | +93 |
| Parking Issues | 852 | 939 | +87 |
| Pothole Report | 1,414 | 1,475 | +61 |
| Snow Plowing/Salting/Sanding | 4,323 | 4,323 | 0 |
| Un-shoveled Sidewalks | 887 | 887 | 0 |

Origins YTD: Web 14,193 (+959 since Aug 21), Phone 4,290 (+476), Guest Support 1,020 (+106). Web is ~2/3 of new intake.

So across the month the steady load is **trash (missed pickup + bins/carts), parking, potholes**. Trees only jump to #1 in the storm week.

## Weather correlation

Daily counts vs weather (local days; Sep 28 is partial, through 18:33):

| Day | Requests | Rain (in) | Max gust (mph) | Note |
|---|---|---|---|---|
| Mon 09-21 | 78 | 0.08 | 27 | |
| Tue 09-22 | 47 | 0.00 | 28 | |
| Wed 09-23 | 36 | 0.00 | 34 | |
| Thu 09-24 | 34 | 0.00 | 32 | |
| Fri 09-25 | 31 | 0.09 | 35 | nor'easter arrives overnight |
| Sat 09-26 | 9 | 1.28 | 47 | storm |
| Sun 09-27 | 9 | 3.02 | 37 | storm, Flood Watch |
| Mon 09-28 | 56* | 0.78 | 29 | *partial day |

The Sep 26–28 event was a rare September nor'easter (2–4 in of rain, 47 mph gusts, Flood Watch through Monday night — WPRI/NBC10 coverage).

Type mix, weekday baseline (Sep 21–25, per day) vs the storm days:

| Case type | Baseline /day | Sat+Sun | Mon 09-28 |
|---|---|---|---|
| Tree Related Issue(s) | 3.8 | 5 | **9** |
| Blocked Storm Drain / Catch Basin | 0.6 | 2 | 2 |
| Pothole Report | 1.0 | 0 | **4** |
| Traffic Signal Malfunction | 0.4 | 0 | 2 |
| Parking Meters Malfunction | 0.0 | 0 | 2 |
| Repair a Traffic Sign | 1.0 | 3 | 3 |
| Downed Wire / Leaning Pole | 0.8 | 0 | 1 |
| Missed Trash Day | 5.0 | 0 | 2 |
| Trash or Recycling Bins/Carts | 3.4 | 0 | 4 |
| Illegal Dumping | 2.6 | 0 | 1 |

Findings:

1. **During the storm, volume collapses rather than spikes.** 9 requests/day on Sat/Sun vs 31–47 on weekdays. Part of that is weekend (no prior weekend in the window to separate it), but the mix shifts to storm types: 5 of the 18 weekend requests are trees, 2 are storm drains, plus one "Emergency and Disaster Information".
2. **The catch-up lands the next business day, concentrated on storm-damage types.** Monday 09-28 by 18:30 already has 9 tree requests (2.4× baseline), 4 potholes (4× baseline), 2 storm drains, 2 signal faults, 2 parking-meter faults. Filing peaks 9–11am (23 requests in three hours).
3. **Trash/parking/dumping are weather-insensitive** — they track the collection calendar and weekdays, and drop to zero on the weekend regardless of rain. Monday trash counts are back near baseline.
4. Total Monday volume (56 by 18:30, on pace for ~65) is *not* above the previous Monday (78), so the storm changes **what** people report more than **how much** — at least on day one; tree/drain/pothole backlog usually builds over the following days.
5. Over the wider month the /analytics/ deltas show no weather signal at all: the four active top types grew at a steady 1.6–3/day, and the two snow types are frozen at their winter totals. Weather is the *dominant* driver for the year (snow = 4,323, 25% of all YTD cases) but a minor one for a summer/fall month until a named event hits.

## If we want this properly

- Add a daily cron in the Worker that appends the 7-day feed to a `cityFeedHistory/{date}` doc (dedupe on `incidentid`), so next time we have per-type daily series and can correlate against Open-Meteo directly (lagged 1–3 days for trees/drains/potholes).
- Product angle: on and after rain/wind days, surface **Tree issue / Blocked storm drain / Pothole** tiles first; on weekdays lead with **Missed trash / Bins & carts**.
