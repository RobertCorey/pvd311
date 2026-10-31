# Data sources

This is the catalog for a Providence real-estate map with a rent-stabilization angle. It has four parts:
1. what we already pull
2. what is online but not pulled yet
3. what needs a records request
4. what would help but isn't public

Checked 2026-10-31. Every part-1 source rebuilds with `npm run rebuild` (`scripts/fetch.ts` → `scripts/build-db.ts` → `data/parcels.sqlite`). The full research notes, with every URL, request number, column list and caveat, are in [CATALOG_RESEARCH.md](CATALOG_RESEARCH.md).

## Before filing any records request: search the portals

**Many "by request" datasets have already been released to someone else, and the releases are public.**
- **City of Providence:** https://providenceri.nextrequest.com/
- **RIDOH and other state health and human services agencies:** https://healthandhumanservicesdepts-ri.nextrequest.com/

Both share a keyless JSON API:
- search: `/client/requests?search_term=…`
- released files for a request: `/client/request_documents?request_id=…`
- download a file: `/documents/<id>/download`

City requests for OpenGov exports have come back the same week with no fee.

**APRA basics (R.I.G.L. 38-2):**
- 10 business days to respond, plus 20 more for good cause.
- The first hour of search is free, then up to $15/hour; copies up to $0.15/page.
- City requests go by portal, mail or drop box. Email and fax are not accepted.
- Court case records are not APRA records (see Evictions in part 3).

## 1. Have: pulled automatically

| Dataset | Source | Coverage | Used for |
|---|---|---|---|
| Tax rolls FY2026, plus FY2021–FY2025 for history | data.providenceri.gov (Socrata `p9dd-mw2m`, `6ub4-iebe`, `xvti-7dtw`, `fd8d-n74v`, `c3q4-f95q`, `fawc-z8zq`) | every parcel | owner-occupied tax rate, class, owner, mailing address, owner-occupancy churn |
| Parcels + assessor records (CAMA) | city ArcGIS `Parcels_with_CAMA` | 44k parcels, roll year 2024 | units, year built, beds/baths, last sale, lot centers, lot outlines |
| **Building permits, Dec 2016 → 2026-09-15** | public release of city request **26-2355** (OpenGov export, `providenceri.nextrequest.com/documents/70401717/download`), plus the older Socrata and ArcGIS extracts | 40,378 permits, 99.5% matched to parcels by address | new-building and conversion permits with dwelling-unit counts, standing in for certificate-of-occupancy dates; catches 2024–26 buildings |
| Building outlines | city ArcGIS `Buildings_layer` | 52,362 | building-level map |
| Street addresses | RIGIS E-911 address points (2026) | 47,428 Providence addresses | search by any door address; permit-to-parcel matching |
| Streets, parks, water, neighborhoods | city ArcGIS layers; Socrata `ueqj-g33x` | citywide | basemap |
| Subsidized housing | HUD LIHTC, Multifamily Assisted, Public Housing Buildings; city PHA layer | Providence projects | exemptions (i)/(j) |
| Owner-occupancy history | tax rolls FY2013–FY2026 (Socrata, one dataset per year) | `owner_occupancy_history`: one row per parcel per year, FY2013–FY2026 | owner-occupant vs. investor trend (54% → ~60% → 57%). FY2013–20 and FY2024–26 use the owner-occupied levy code. FY2021–23 had a single residential code, so owner-occupancy there is inferred from a homestead exemption of 30% or more of assessed value (`method = 'homestead'`); on FY2022 that agrees with the surrounding years about 99% of the time. FY2021 may undercount (the exemption's first year). Before FY2013 there is no owner-occupied split. |
| HUD voucher households by tract | HUD ArcGIS `Housing_Choice_Vouchers_by_Tract` | 36 Providence tracts, 2,868 households | voucher units are covered unless the building is exempt for another reason (`tracts.hcv_households`) |
| HUD Small Area FMRs FY2027 | huduser.gov `FY27_safmrs.xlsx` | Providence ZIPs, 0–4 bedrooms (2BR: $1,730 in 02907 to $2,630 in 02903) | official rent benchmark (`safmr_fy27`) |
| Census tracts | ACS 2020–2024 5-year via Census Reporter | 42 tracts | income overall and for renters, race/ethnicity, tenure, rent, rent burden; a tract on every parcel |
| Eviction filings | Eviction Lab ETS CSV (data from RIHousing / the courts) | per tract per month, Jan 2020 → Oct 2026 | eviction pressure by area. Filings, not judgments; no addresses. |
| Asking rents | Zillow ZORI city + ZIP | Providence since 2015; 7 ZIPs | rent trend. Listed units only. |
| **Rental registry** (RIDOH) | public release of RIDOH request 26-278 | 15,169 statewide → 3,713 rows / 12,152 units matched to Providence addresses (an upper bound: the file has no town column, so same-named streets elsewhere can match) | "registered rental" per parcel, with units and lead status. Owner and manager contacts are never downloaded. |
| **Short-term rentals** | state DBR active roster (daily CSV); city permits (request 26-2245); Inside Airbnb 2026-09-28 | 412 state registrations (383 matched), 252 city permits, 1,066 Airbnb listings (373 joined through the registration number) | units taken off the long-term market |
| **Housing Court cases** | public release of city request 26-521 | 5,130 cases 1998 → 2026-03, 4,943 matched (plat/lot, else address) | building distress, receiverships |
| **Lead-safe certificates** (RIDOH) | the public Power BI report behind RIDOH's lead-certificate search (refreshed daily; `src/powerbi.ts` pages through it) | 44,760 Providence address records (38,592 current 2004→2026, 6,168 legacy 1994→2019), 42,955 matched; 11,928 parcels with a certificate history | evidence a pre-1978 building has been rented; certificate units and dates |
| **Active code-enforcement cases** | public release of city request 26-1279 | 1,269 cases 2023 → 2026-06, all matched by plat-lot-unit | building condition. Owner names are never downloaded. |
| **Vacant/abandoned registry** | public release of city request 25-339 | 327 entries 2017–2025, 276 matched by plat/lot | vacancy |
| **2026 tax sale** | city Collector CSV, as `manual/tax-sale-2026.csv` (name-free; the site blocks scripted downloads) | 214 parcels, 213 matched | distress and turnover |
| Researched big buildings | `manual/big-buildings.csv` (hand research, with sources) | 66 buildings | hotels, senior care, co-ops, new and converted buildings |
| Ordinance text, fiscal note, veto | IQM2 ORD-2026-11 / record 52231 | final text, passed 2026-04-16 | `rules/ordinance-2026-04.yaml` |

SQLite tables: `parcels`, `permits`, `tracts`, `evictions_tract_month`, `zori_month`, `rental_registry`, `str_registrations`, `str_city_permits`, `airbnb_listings`, `housing_court_cases`, `code_cases_active`, `vacant_registry`, `tax_sale_2026`, `owner_occupancy_history`, `safmr_fy27`, `lead_certificates`. View: `parcel_signals` (one row per parcel with every signal). Personal columns (names, emails, phones) are dropped at download time (`kind: 'records'` sources in `scripts/fetch.ts` keep an explicit column list).

## 2. Online, not pulled yet (ranked)

| # | Dataset | Where | Why | Notes |
|---|---|---|---|---|
| 1 | HUD Picture of Subsidized Households 2025 (all programs, by tract) | huduser.gov tract xlsx (70 MB, a 500 MB sheet) | program mix and household income by tract | needs a streaming xlsx parse; voucher counts alone are already pulled |
| 2 | RIHousing evictions dashboard and rent survey | Tableau Public | judgments and awards; average rents | the rent survey comes from CoStar's large buildings, so it misses 2–4-unit stock |
| 3 | City 311 housing complaints | FixMyPVD's own `cityCases` feed | complaints by building | ours; join via E-911 addresses |
| 4 | National Housing Preservation Database | preservationdatabase.org (free sign-up) | subsidy **expiration dates** | adds the risk of affordable units losing their restriction |
| — | Recorder of Deeds (Kofile CountyFusion) | guest search | deeds, liens, foreclosure deeds | search one record at a time; no bulk; the city denies bulk deed requests by pointing here |

## 3. By request (ranked)

| # | Dataset | Who holds it | How | Why it matters |
|---|---|---|---|---|
| 1 | **Certificates of occupancy** | Dept of Inspections & Standards | city NextRequest: "CSV export of all OpenGov 'Certificate of Occupancy' records, all statuses, with address, plat-lot, issued date, dwelling units, linked permit #" | settles the new-construction exemption exactly; permit request 26-2355 came back the same day |
| 2 | **Assessor package** | Tax Assessor | one request asking for: (a) owner-occupied certification records and how many owner-occupants lack the rate; (b) landlord fire-insurance declarations (R.I.G.L. 34-43-1: every non-owner-occupied 3+-household building must file one, so effectively a list of 3+-unit rentals); (c) active tax-stabilization agreements; (d) the assessor's valid/invalid sales file | (a) is our biggest uncertainty; (b) is a rental list the city already holds |
| 3 | **Case-level eviction records** | R.I. Judiciary (not APRA) | form Supreme-19, "Request for Electronic Information or Report (Non-APRA)", to Community Outreach & PR, 250 Benefit St, (401) 222-4580. Alternative: APRA request to RIHousing for the monthly court extract it receives | building-level eviction pressure; the public portal blocks scraping |
| 4 | **Code-enforcement history** | Inspections & Standards | full export, all statuses since 2016: type, violation codes, notice and condemnation dates, closed date; plus the vacant registry without redaction | building condition and enforcement |
| 5 | **Affordable-housing inventory by property** | RIHousing (recordsrequests@rihousing.com) / Executive Office of Housing | the low- and moderate-income housing database for Providence: property, plat-lot, units, program, affordability end date | per-unit precision for exemptions (i)/(j) |
| — | **Buy instead:** RI corporate database | Dept of State (corp_tech@sos.ri.gov) | one-time extract: active $250 + inactive $50 | group owner LLCs into landlord portfolios via shared agents and addresses; ask first whether managers and officers are included |
| — | Nonresident-landlord agent designations | City Clerk (and SOS PDFs) | NextRequest | out-of-state landlords |

## 4. Would help, not public

- **Actual rents per unit.** No registry exists. The April ordinance would have created one for new units. CoStar is commercial.
- **Who lives where.** Occupancy is private. The ordinance's own principal-residence test leans on voter registration and tax-filing address, which aren't available to us for this use.
- **Voucher holder addresses.** HUD/PHA privacy; tract counts only (part 2, #5).
- **Unpermitted units.** The assessor counts legal units only.
- **USPS vacancy data by tract.** HUD gives it only to governments and nonprofits.
- **University master leases.** Private contracts.
- **A city rental registry.** None exists. The city answered request 26-1082 in 2026 with "does not maintain".

## Settled questions from the research

- **The College Student Residential Overlay District isn't law.** It was drafted July 2026 (Referral 3619), sent to the City Plan Commission, with no Council passage found. The 2015 rule still applies: at most 3 students in a non-owner-occupied single-family house in R-1 and R-1A zones. So the new-construction carve-out in Sec. 13-78(m) currently applies nowhere.
- **Owner-occupied 2–3-unit buildings were exempt from lead certificates until 2024.** A 2024 amendment removed that exemption for the rental units, so the certificate history under-represents those buildings before 2024.

## Access notes

- **health.ri.gov and dbr.ri.gov** use a Cloudflare challenge. Headless Firefox (Playwright) gets through; plain curl doesn't.
- **The court public portal** uses a bot challenge, so no scraping.
- **NEREVAL** (assessor property cards) returns 403 here.
- **OpenCorporates** sits behind a reCAPTCHA.
- **Eviction Lab's CDN** accepts only browser user agents.
- **Census Reporter** asks for a project-specific user agent.
- **The Census API** now needs a free key.
- **Listing sites** (Zillow listings, Apartments.com, Craigslist) prohibit scraping.
- **Privacy rule for anything published:** no individuals' names, phone numbers, emails, or an owner's other addresses. The state Health Department's 2025 "suspected rental" map drew pushback for exactly that.
