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

Searched 2026-10-31 (certificate of occupancy, owner occupied, homestead, tax stabilization, code enforcement, violations, sales, landlord, affordable housing): pulled 20-209 (sales extracts) and 22-1323 (lead cases). 18-27 (2018 code-enforcement database) has street names without house numbers, so it can't join to parcels. 25-1068 ("Statistical Data on Homestead Exemption Changes 2021–2025") and 24-1460 (units and bedrooms for every taxed property) were closed with no public files: ask for the same thing by number. Downloads need a browser user agent (S3 redirect).

**APRA basics (R.I.G.L. 38-2):**
- 10 business days to respond, plus 20 more for good cause.
- The first hour of search is free, then up to $15/hour; copies up to $0.15/page.
- City requests go by portal, mail or drop box. Email and fax are not accepted.
- Court case records are not APRA records (see Evictions in part 3).

## 1. Have: pulled automatically

| Dataset | Source | Coverage | Used for |
|---|---|---|---|
| Tax rolls FY2026, plus FY2002–FY2025 for history | data.providenceri.gov (Socrata, one dataset per year: `p9dd-mw2m` FY2026 … `e3qk-fibu` FY2002) | every parcel | owner-occupied tax rate, class, owner, mailing address; owner-occupancy and ownership history |
| Parcels + assessor records (CAMA) | city ArcGIS `Parcels_with_CAMA` | 44k parcels, roll year 2024 | units, year built, beds/baths, last sale, lot centers, lot outlines |
| **Building permits, Dec 2016 → 2026-09-15** | public release of city request **26-2355** (OpenGov export, `providenceri.nextrequest.com/documents/70401717/download`), plus the older Socrata and ArcGIS extracts | 40,378 permits, 99.5% matched to parcels by address | new-building and conversion permits with dwelling-unit counts, standing in for certificate-of-occupancy dates; catches 2024–26 buildings |
| Building outlines | city ArcGIS `Buildings_layer` | 52,362 | building-level map |
| Street addresses | RIGIS E-911 address points (2026) | 47,428 Providence addresses | search by any door address; permit-to-parcel matching |
| Streets, parks, water, neighborhoods | city ArcGIS layers; Socrata `ueqj-g33x` | citywide | basemap |
| **2024 valid sales** (the assessor's revaluation sales file) | city ArcGIS `Parcels_wCAMA_Valid_Sales_2024_Reval` layer 24 | 1,826 sales in calendar 2024 (1,359 coded valid, 367 multi-parcel, 47 outliers), 1,803 matched by plat-lot | `sales_2024`: price, date, units, building type, validity code, quality and condition. Valid 2024 sales averaged $615k for a single unit, $257k per unit in 2–4 family houses and $153k per unit in 5+ buildings. Owner columns aren't requested. One year only. |
| **Sales history 2002–2018** | assessor (Vision) extracts for 2013 and 2019, public release of city APRA **20-209** (`documents/4804481`, `4804482`) | 80,863 sale records (last six per lot in each extract, de-duplicated; 14,813 unpriced placeholder rows dated 2012-07-07 dropped), 78,258 matched; 2,000–3,300 priced sales a year 2002–2018 | `sales_history`: date, price, sale code, qualified (Q/U), improved; `parcel_signals.last_arms_length_sale`. Lots only (no condo units). Owner and grantee columns aren't kept. Qualified sales averaged $166k in 2002, $304k at the 2007 peak, $160k in 2010 and $294k in 2018. |
| **Lead-hazard code cases** | public release of city APRA **22-1323** (2022) | 152 cases with lead violations (61 active, 91 released), 143 matched | `lead_violations_2022`: inspection and notice dates, violation counts. Owner not kept. |
| **Code-enforcement history** | city ArcGIS `Violations_Code_Enforcement_` (snapshot, last edited 2024-03) | 999 records, nearly all first inspected 2022-05 → 2024-05 (595 substandard housing, 81 systematic, 58 no heat/hot water, 21 illegal housing; 12 condemned), 993 matched | `code_cases_history`. The round 999 suggests a truncated export; the full history remains a records request. Owner names aren't requested. |
| **Lead service lines** (Providence Water, private side) | city ArcGIS `Private_Side_Lead_Providence` layer 31 (edited 2025-01) | 16,588 lines → 16,232 parcels (each line joined to the lot its end falls in) | `lead_service_lines`: lead water service on record, per parcel. 3,508 parcels whose rentals would be covered have one. `PRIV_SIDE_` (True on 2,539) is undocumented. |
| Overlay zoning + National Register districts | city ArcGIS `Overlay_Zoning` (edited 2026-08), `Federal_Historic_Districts_2016` | 270 + 63 polygons | `parcel_overlay`: local historic (2,507 lots), Providence Landmark (722), Downcity (606), institutional, Capital Center, transit-oriented (190); National Register (`NR`, 2,974 lots in 50 districts) |
| Flood areas | city ArcGIS `Parcels1percent`, `Parcels1andpoint2percent` (2019, FEMA maps of the time) | 1,055 current parcels: 701 in the 1% (100-year) area with 1,077 homes, 354 more in the 0.2% area | `flood_zone`; `parcel_signals.flood_zone`. Parcels split or renumbered since 2019 are missed. |
| Base zoning | city ArcGIS `PVD_ZoningMap` layer 15 | 510 district polygons, 29 codes (R-1A … R-4, R-P, C, D-1, M, I, W, OS, PS, CD) | zone on every lot (`parcel_zoning`) |
| Subsidized housing | HUD LIHTC, Multifamily Assisted, Public Housing Buildings; city PHA layer | Providence projects | exemptions (i)/(j). `lihtc_projects` adds each tax-credit project's 15-year compliance and 30-year extended-use end, counted from the year placed in service (78 projects, 67 matched). 36 projects with 2,475 income-restricted units reach the 30-year federal minimum in 2027–2036, and 7 (391 units) already have. Many Rhode Island deals carry longer restrictions than the federal minimum, so treat these dates as earliest possible. |
| Owner-occupancy history | tax rolls FY2002–FY2026 | `owner_occupancy_history`: one row per parcel per year | FY2013–20 and FY2024–26 use the owner-occupied levy code (`method = 'levy'`; 54% → ~60% → 57%). FY2021–23 had one residential code, so owner-occupancy is a homestead exemption of 30%+ of assessed value (`'homestead'`, ~99% agreement with the years around it; FY2021 may undercount). FY2002–12 use the old homestead exemption (`'exemption_pre2013'`: 20%+ in FY2002–03, 45%+ from FY2004). FY2012 holders were 99% owner-occupied a year later, but FY2004–11 holders only 76–81%, and the holder count fell 18% in FY2012, so the list looks purged then. Pre-2013 years are per-parcel evidence, not a trend line. |
| HUD voucher households by tract | HUD ArcGIS `Housing_Choice_Vouchers_by_Tract` | 36 Providence tracts, 2,868 households | voucher units are covered unless the building is exempt for another reason (`tracts.hcv_households`) |
| **HUD Picture of Subsidized Households 2025** (as of 2025-12-31) | huduser.gov `TRACT_MO_WY_2025_2020census.xlsx`, streamed and cut to Providence County (`streamXlsxRows`) | 42 city tracts × program: all HUD programs 9,899 occupied homes; project-based Section 8 4,295; tenant-based vouchers 2,377; public housing 2,468; project-based vouchers 264; 202/811 255 | `hud_psh_tract`: units, occupancy, tenant rent paid, household income, AMI bands, household makeup by program. Tenant-based voucher homes sit in private buildings, so the cap would reach them; the project-based programs are the ones exempt. Small cells are suppressed (NULL). |
| **HUD Multifamily Assistance & Section 8 Contracts** (monthly) | hud.gov `MF-Properties-with-Assistance-Sec8-Contracts1.xlsx` + `MF-Assistance-Sec8-Contracts1.xlsx` | 69 Providence properties (5,436 units), 77 active contracts; 64 properties matched to a parcel | `hud_mf_properties`, `hud_mf_contracts`: each contract's **expiration date** (2026–2046; 13 contracts covering 276 assisted units expire by the end of 2027), assisted units, rent-to-FMR. Also supplies project sizes for 8%-law parcels. Owner and agent people, phones and emails are never downloaded. |
| **City 311 cases** | FixMyPVD's public map feed `api.fixmypvd.org/api/street/map?days=90` (FixMyPVD has kept every case on the city's public grid since 2026-10-09; the city's grid itself shows only 7 days) | 632 cases 2026-10-09 → 2026-10-31; 409 matched to a parcel by door address (cases with only a street name stay unmatched) | `city_cases`: type, status, created/closed, address, a `housing` flag (substandard housing, building code, illegal housing, vacant private property, rodents: 26 cases, 24 matched). Per parcel in `parcel_signals` (`city_cases`, `city_cases_housing`). The feed's longest window is 90 days, so `fetch.ts` merges each fetch into the stored copy by case id (`accumulate`): history grows with every rebuild on this machine. A fresh clone starts from the last 90 days; FixMyPVD keeps everything, so an export endpoint would restore the full record. |
| **RIHousing rent survey and evictions tracker** | Tableau Public dashboards `RentSurveyDashboard`, `EvictionsTrackingDashboard`, downloads turned off; read through the page's own session calls (`src/tableau.ts`) | rent: 39 towns; evictions: statewide monthly Oct 2024 → Sep 2026, 60 ZIPs | `rihousing_rent_town`: 2-bedroom rent *including utilities*, 2025 dollars (Providence $2,184 in 2020 → $2,396 in 2025); CoStar sample of large managed buildings, so it misses 2–4-unit stock. `rihousing_evictions_month`: statewide filings (nonpayment / other), hearings, judgments, median money award ($3,555 in Sep 2026). `rihousing_evictions_zip`: cases per renter household, about the last 12 months; Providence 02903 9.0%, 02908 7.2%, 02909 7.0%, 02906 1.5%. `rihousing_judgments_year`: judgments and award totals 2021–2026 (2023 peak: 5,288 judgments, $17.4M). The statewide rent-by-bedroom sheet decodes to utility costs, so it isn't stored. |
| HUD Small Area FMRs FY2027 | huduser.gov `FY27_safmrs.xlsx` | Providence ZIPs, 0–4 bedrooms (2BR: $1,730 in 02907 to $2,630 in 02903) | official rent benchmark (`safmr_fy27`) |
| Census tracts | ACS 2020–2024 5-year via Census Reporter | 42 tracts | income overall and for renters, race/ethnicity, tenure, rent, rent burden; a tract on every parcel |
| **Housing cost burden by income** | HUD CHAS 2018–2022 Table 8, streamed from the national tract zip (226 MB; `streamZipLines`) with labels from HUD's data dictionary | 42 city tracts | `chas_tract_burden`: households by tenure × income band (% of HUD area median) × cost burden (≤30%, 30–50%, >50%). Of 41,494 renter households, 13,745 earn under 30% of area median and 6,825 of those pay more than half their income for housing. |
| **Census tracts over time** | ACS 5-year **Summary File** for 2010–14 and 2015–19 (census.gov downloads, no API key; `src/acssf.ts`) | 39 city tracts in 2010 geography; 36 unchanged in 2020, 3 split in two | `acs_tract_history`: the same measures as `tracts`. Renter-weighted median gross rent: $894 (2010–14) → $992 (2015–19) → $1,436 (2020–24). Compare split tracts as a sum. |
| Eviction filings | Eviction Lab ETS CSV (data from RIHousing / the courts) | per tract per month, Jan 2020 → Oct 2026 | eviction pressure by area. Filings, not judgments; no addresses. |
| Asking rents | Zillow ZORI city + ZIP | Providence since 2015; 7 ZIPs | rent trend. Listed units only. |
| New units authorized, 1980–2025 | Census Building Permits Survey, annual place files (Northeast) | Providence, every year | `bps_units_year`: units by building size (1, 2, 3–4, 5+). Good for long-run context before 2017. Providence's reporting lapsed in 2017–18, 2021 and 2023, and since 2017 the survey runs well below the city's own permits (2025: 324 vs 699), so use `new_housing_by_year` from 2017 on. |
| Home values | Zillow ZHVI (typical home, middle third) city + ZIP, Rhode Island rows only | Providence monthly since 2000; 7 ZIPs | `zhvi_month`: $109k (2000-01) → $270k (2006-06) → $148k (2012-01) → $432k (2026-09) |
| **House price index by tract** | FHFA annual tract HPI (repeat sales, developmental series), Providence County rows | 22 of 42 city tracts, 1986–2025 (FHFA suppresses tracts with too few repeat sales) | `fhfa_hpi_tract` (2020 tracts) |
| **Mortgages: owner-occupant vs investor** | HMDA public loan records (CFPB data browser API), originated loans in Providence County 2018–2024, anonymized | 42 city tracts; 1,239–2,020 home-purchase loans a year | `hmda_loans`; `hmda_purchases_tract_year`: purchases, investor share (9–13% citywide), 2–4-unit and 5+ purchases, median property value. All-cash purchases, common among investors, aren't in HMDA. |
| **Rental registry** (RIDOH) | public release of RIDOH request 26-278 | 15,169 statewide → 3,713 rows / 12,152 units matched to Providence addresses (an upper bound: the file has no town column, so same-named streets elsewhere can match) | "registered rental" per parcel, with units and lead status. Owner and manager contacts are never downloaded. |
| **RIDOH suspected unregistered rentals** (as of 2025-05-01) | public release of RIDOH APRA **26-225** (`documents/61611122`) | 88,013 statewide; 15,403 Providence rows, 15,392 matched by plat-lot-unit | `ridoh_suspected_rentals`; `parcel_signals.ridoh_suspected_rental`. The list behind RIDOH's winter 2025 enforcement letters. Broad: 7,557 of the matched parcels are on the owner-occupied rate (rented units in owner-occupied 2–4 families must register too) and 1,104 are owner-occupied single-family homes, so it is a weak rental signal. Owner names and addresses are never downloaded. |
| **Short-term rentals** | state DBR active roster (daily CSV); city permits (request 26-2245); Inside Airbnb 2026-09-28 | 412 state registrations (383 matched), 252 city permits, 1,066 Airbnb listings (373 joined through the registration number) | units taken off the long-term market |
| **Housing Court cases** | public release of city request 26-521 | 5,130 cases 1998 → 2026-03, 4,943 matched (plat/lot, else address) | building distress, receiverships |
| **Lead-safe certificates** (RIDOH) | the public Power BI report behind RIDOH's lead-certificate search (refreshed daily; `src/powerbi.ts` pages through it) | 44,760 Providence address records (38,592 current 2004→2026, 6,168 legacy 1994→2019), 42,955 matched; 11,928 parcels with a certificate history | evidence a pre-1978 building has been rented; certificate units and dates |
| **Active code-enforcement cases** | public release of city request 26-1279 | 1,269 cases 2023 → 2026-06, all matched by plat-lot-unit | building condition. Owner names are never downloaded. |
| **Vacant/abandoned registry** | public release of city request 25-339 | 327 entries 2017–2025, 276 matched by plat/lot | vacancy |
| **2026 tax sale** | city Collector CSV, as `manual/tax-sale-2026.csv` (name-free; the site blocks scripted downloads) | 214 parcels, 213 matched | distress and turnover |
| Researched big buildings | `manual/big-buildings.csv` (hand research, with sources) | 66 buildings | hotels, senior care, co-ops, new and converted buildings |
| Ordinance text, fiscal note, veto | IQM2 ORD-2026-11 / record 52231 | final text, passed 2026-04-16 | `rules/ordinance-2026-04.yaml` |

SQLite tables: `parcels`, `permits`, `tracts`, `evictions_tract_month`, `zori_month`, `rental_registry`, `str_registrations`, `str_city_permits`, `airbnb_listings`, `housing_court_cases`, `code_cases_active`, `vacant_registry`, `tax_sale_2026`, `owner_occupancy_history`, `safmr_fy27`, `hud_psh_tract`, `hud_mf_properties`, `hud_mf_contracts`, `city_cases`, `sales_2024`, `code_cases_history`, `lead_service_lines`, `flood_zone`, `rihousing_rent_town`, `rihousing_evictions_month`, `rihousing_evictions_zip`, `rihousing_judgments_year`, `sales_history`, `lead_violations_2022`, `ridoh_suspected_rentals`, `hmda_loans`, `hmda_purchases_tract_year`, `zhvi_month`, `fhfa_hpi_tract`, `acs_tract_history`, `lihtc_projects`, `bps_units_year`, `chas_tract_burden`, `lead_certificates`, `parcel_signals` (one row per parcel with every signal, materialized and indexed). Personal columns (names, emails, phones) are dropped at download time (`kind: 'records'` sources in `scripts/fetch.ts` keep an explicit column list).

### Derived tables (`npm run derive`, part of `rebuild`)

| Table | What | Caveats |
|---|---|---|
| `parcel_signals` (built by build-db) | one row per parcel: registered rental units, short-term-rental registrations, permits and listings, court cases, code cases, tax sale, vacant registry, lead-certificate units and date, HUD-assisted units and earliest contract expiration, 311 cases (all and housing), 2013–2024 code cases, lead service lines, 2024 sale price and date, flood zone, last arm's-length sale since 2000, 2022 lead violations, RIDOH suspected-rental flag | materialized table, indexed |
| `parcel_status` | every parcel's result under the April 2026 rules: status, deciding rule, reason, homes by category | recomputed from the rules YAML on every rebuild |
| `owner_groups`, `parcel_owner_group` | landlord portfolios over non-owner-occupied parcels with homes. Owners are linked by a shared mailing address, or by an identical name for entities and trusts. 10,376 groups. 46 groups hold 100+ homes each (8,304 homes total, 3,353 covered), e.g. an 8-LLC network sharing one office address with 126 parcels and 279 homes. | a management company's or law firm's address can join unrelated owners; individuals' names stay in the local database and never appear in anything published |
| `ownership_changes` | owner-name changes between consecutive rolls FY2002→FY2026 on parcels with homes, with seller and buyer kind (person / trust / entity) and a `comparable` flag. Comparable years: FY2005–06, FY2009–12, FY2018–26, about 2,200–4,000 changes a year. Entity buyers: 9–11% in FY2005–06, **31–37% in FY2009–12** (the foreclosure years: banks, the state housing agency, and two LLCs that each took 185–231 parcels in a year), 15–29% since FY2018. | name formats shift between rolls (FY2003 names missing; case and "Last, First" changes in FY2004, FY2007, FY2008 and FY2013; first/last split in FY2014; company field in FY2017). Those years show 9,000–31,000 "changes" and are flagged not comparable. A format change can still look like a sale. The FY2026 roll names trustees where earlier rolls named the trust, which inflates FY2026 "trust buyers". |
| `tract_summary`, `neighborhood_summary`, `tract_profile` (view) | per area: homes by result (owned / stabilized / exempt / subsidized / can't tell), short-term rentals, Housing Court and code cases (active and 2022–24), 311 housing cases, parcels with lead certificates and with lead service lines, homes in the 100-year flood area, registered and RIDOH-suspected rentals, HUD-assisted units, 2024 sales, new units permitted since 2022. The tract view adds the Census measures, HUD vouchers (tenant-based households), eviction filings in the last 12 months, mortgage purchases and the investor share 2022–24, and the latest FHFA price index. | assembled data only; how to compare coverage with demographics is a framing decision still open |
| `parcel_overlay` | overlay and National Register districts at each lot's centroid, one row per lot and district: 8,210 rows | same centroid caveat as `parcel_zoning` |
| `parcel_zoning` | base zoning district at each lot's centroid: 44,043 of 44,077 mapped parcels. Homes by zone: R-3 25,825; R-2 18,879; R-1 10,524; C-2 3,345; everything else under 1,600 each. | a centroid near a zone line can land in the neighbor; condo units share their lot's zone; the 34 unzoned lots have centroids in streets or water |
| `new_housing_by_year` | dwelling units in new-building and conversion permits by year issued: 135–390 a year in 2017–2020, 400–700 a year since 2021 | a permit isn't a finished building; units missing from a permit count as 0 |

## 2. Online, not pulled yet (ranked)

| # | Dataset | Where | Why | Notes |
|---|---|---|---|---|
| 1 | National Housing Preservation Database | preservationdatabase.org (free sign-up) | recorded LIHTC, HOME and other non-Section-8 subsidy **end dates** | Section 8 expirations come straight from HUD and federal-minimum LIHTC dates are derived (`lihtc_projects`); NHPD would replace those estimates with recorded end dates |
| 2 | Other city ArcGIS layers, found 2026-10-31 | `services6.arcgis.com/wv9mHoqblhTsnqdG` (315 services) | `Vacant_Properties_Layer` (722 parcels, 2023, source unstated); `Public_Side_Lead_Providence`; `DIS_Active_Permit_VIew` (2024 permit snapshot with unnamed columns) | superseded or unclear: the 2026 permit export and the vacant-registry release cover the permit and vacancy questions; the vacant layer's definition is unstated |
| — | Recorder of Deeds (Kofile CountyFusion) | guest search | deeds, liens, foreclosure deeds | search one record at a time; no bulk; the city denies bulk deed requests by pointing here |

## 3. By request (ranked)

Ready-to-send text for each, with where to send it: **REQUESTS.md**.

| # | Dataset | Who holds it | How | Why it matters |
|---|---|---|---|---|
| 1 | **Certificates of occupancy** | Dept of Inspections & Standards | city NextRequest: "CSV export of all OpenGov 'Certificate of Occupancy' records, all statuses, with address, plat-lot, issued date, dwelling units, linked permit #" | settles the new-construction exemption exactly; permit request 26-2355 came back the same day |
| 2 | **Assessor package** | Tax Assessor | one request asking for: (a) owner-occupied certification records and how many owner-occupants lack the rate, and whether the FY2021 homestead switch required owners to re-file (the rolls show 530–920 extra same-owner parcels losing the rate across FY2020→FY2024); (b) landlord fire-insurance declarations (R.I.G.L. 34-43-1: every non-owner-occupied 3+-household building must file one, so effectively a list of 3+-unit rentals); (c) active tax-stabilization agreements; (d) the assessor's sales file for years before 2024, invalid sales included (2024's valid sales are online, see §1) | (a) is our biggest uncertainty; (b) is a rental list the city already holds |
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
- **The Census API** now needs a free key. Census Reporter serves only the latest ACS; earlier releases come from the Summary File downloads (`src/acssf.ts`).
- **Listing sites** (Zillow listings, Apartments.com, Craigslist) prohibit scraping.
- **Privacy rule for anything published:** no individuals' names, phone numbers, emails, or an owner's other addresses. The state Health Department's 2025 "suspected rental" map drew pushback for exactly that.
