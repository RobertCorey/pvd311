# Portal Research Addendum — 2026-08-21 live recon

Live verification pass against 311.providenceri.gov during relaunch research (read-only except
10 abandoned wizard drafts; zero submissions). Complements `PORTAL-RESEARCH.md` (winter 2026).

## What changed since winter research

- **Case Type launch button aria-label changed**: now `"Choose an Issue (Case Type) Launch lookup modal"`
  (was `"Case Type Launch lookup modal"`). Selector drift confirmed in the wild — match on
  `button[aria-label*="Case Type"][aria-label*="lookup modal"]`.
- Wizard structure otherwise unchanged (Step 1 of 3, same field IDs, `#NextButton`, honeypot present).
- Postback timings observed: Step 1 → 2: 5.1–18.0s; Step 2 → 3: 6.6–7.5s.

## Case-type census

`case-type-census-2026-08-21.json` — **126 case types** with GUIDs, scraped from the lookup modal
(13 pages). Includes a generic fallback type: *"I am unsure or do not know how to classify my request."*

## Step-3 conditional fields — the real model

Step 3 renders the **same ~50 controls for every case type**; the case type only toggles a small
subset visible. Full catalog of conditional controls captured (selects with option lists:
device owner/scooters, animal type, rodent request, dumpster type, property type/occupancy,
utility, violation, street/decorative/traffic light repair, service type, location, sign request,
surface type, noise source, recreation, pothole size, agricultural work, pickup type,
discrimination area/basis, backup location, illegal housing; text: vehicle details, pole number,
landlord, needed parts, number missed, cart request radios; plus hidden toggles).

Sampled visible sets (beyond case type + address + description):

| Case type | Extra visible fields |
|---|---|
| Missed Trash Day Pick-up Issue | — |
| Report Street Light Issue | — |
| Illegal Dumping | — |
| Pothole Report | `cop_size` (Small ~4in / Medium ~28in / Large ~36in / Unknown) |
| Abandoned Vehicle to Report | `cop_vehicledetails` (text) |
| Animal Control Concerns | `cop_typeofanimal` (Domestic / Wildlife) |

**Implication:** most reportable categories need 0–1 extra fields. A scripted crawl (same method)
can map all ~60 reportable types; each crawl run costs one abandoned draft per type.

- **Anti-bot honeypot on every form**: a visible-to-DOM text input labeled
  *"Leave this field blank"* (`frm_pref_*`, random id per page). Never fill it.

## Drafts & deletion (the old pain point, settled)

- Drafts appear in My Requests with status **Draft**; Action Menu offers only **Edit / View details**
  — **no constituent-side delete exists** for drafts or cases.
- The city cancels junk server-side: the 3 accidental winter reports show as **Cancelled**.
- Drafts are visible on the **public feed** (/public-requests) too.

## Account history (winter 2026 outcomes)

13 cases on the PVD Snow account: **9 Resolved** (real addresses, resolved within ~days),
3 Cancelled (the accidental no-address test reports), 1 header row. The city genuinely worked
PVD Snow's submissions.

## Per-case activity feed is scrapable

`POST /_portal/{portalId}/EntityActivity/GetActivities` returns the case activity feed for the
logged-in account's cases (fires from the record-details flyout on /my-requests). Observed it
exposing an internal "Dynamics Admin" error email: *"ERROR Updating case with Work order details…
Update a Case Failed"* with a make.gov.powerautomate.us flow-run link — the city's case→work-order
integration is Power Automate, and its failures are visible to constituents. Closed-loop status
polling can be built on My Requests grid + GetActivities without any email dependency.

## City emails are parseable (from a real Feb 2026 personal test report)

Confirmation from `pvd311@providenceri.gov`, subject `PVD2026-71677 Report Un-shoveled Sidewalks
PVD311:0287749` (case ID + CRM tracking token). Body contains structured bullets:
`Case Title`, `Address to Report`, `Department Assigned`, and promises email on status change.
Replies to that address reach a human (a reply requesting cancellation was honored).
Portal account contact email is currently `pvdsnow@proton.me` (profile page) — city notifications
for account-submitted cases route there; wizard has **no per-case email field** (constituent is
auto-filled from the login on Step 1, readonly).

## Anonymous surfaces (no login)

- **/analytics/** — "Top Requests this Year" with real volume numbers (as of 2026-08-21):
  Snow Plowing/Salting/Sanding 4,323 · Trash or Recycling Bins/Carts 2,389 · Missed Trash Day 1,460 ·
  Pothole Report 1,414 · Un-shoveled Sidewalks 887 · Parking Issues 852.
  Origins: Web 13,234 · Phone 3,814 · (blank) 1,097 · Guest Support 914 · Office Visit 157 · Email 101.
- **/public-requests/** — live citywide feed of everyone's requests (case type, street, status
  incl. Draft/Submitted/Assigned/Resolved, created-on). Usable for dedupe ("already reported")
  and ongoing demand measurement.
- **/guest-support/request/** — single-page anonymous service-request form: case-type lookup,
  ArcGIS address, Name, **Email (per-request!)**, Phone, location details, comments —
  but **image-CAPTCHA-gated** and **no photo upload**. /guest-support/comment/ similar.
  This is the city's deliberate anti-automation boundary; the authenticated wizard has no CAPTCHA.
- No robots.txt, no Terms of Use anywhere on the portal (404s); Power Pages Web API (`/_api/`)
  not anonymously enabled (404s).

## Auth notes

- Fresh headless login from env credentials works (no captcha/MFA on /SignIn) — `.auth-state.json`
  regenerated 2026-08-21 by scripted login; the headed `auth.ts` bootstrap is not strictly required.
