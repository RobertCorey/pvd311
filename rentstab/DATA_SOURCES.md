# Data sources

This catalog serves a Providence real-estate map with a rent-stabilization angle. It has four parts:
1. what we already pull
2. what is online but not pulled yet
3. what has to be requested
4. what would help but isn't public

Everything in part 1 rebuilds with `npm run rebuild` (`scripts/fetch.ts` → `scripts/build-db.ts` → `data/parcels.sqlite`). Checked 2026-10-31.

Records-request basics (R.I. Access to Public Records Act, R.I.G.L. 38-2):
- **Response time:** 10 business days, extendable 20 more for good cause.
- **Cost:** the first hour of search is free, then up to $15/hour; copies up to $0.15/page.
- **Court case records are not APRA records.** They have their own request process (see Evictions below).

## 1. Have: pulled automatically

| Dataset | Source | Coverage | Used for |
|---|---|---|---|
| Tax rolls FY2026 (+ FY2021–FY2025 for history) | data.providenceri.gov (Socrata `p9dd-mw2m`, `6ub4-iebe`, `xvti-7dtw`, `fd8d-n74v`, `c3q4-f95q`, `fawc-z8zq`) | every parcel; assessment as of 12/31 of the prior year | owner-occupied tax rate, class, owner, mailing address, owner-occupancy churn |
| Parcels + assessor records (CAMA) | city ArcGIS `Parcels_with_CAMA` | 44k parcels, roll year 2024 | unit count, year built, beds/baths, last sale, lot centers, lot outlines |
| Building permits | Socrata `ufmm-rbej` (Dec 2016–Jan 2020) + ArcGIS `Interactive_Permitting_Map_(BETA)` (Jan 2019–Mar 2024) | 121k permits | new-building and conversion permits, stand-ins for certificate-of-occupancy dates |
| Building outlines | city ArcGIS `Buildings_layer` | 52,362 footprints | building-level map |
| Street addresses | RIGIS E-911 address points (2026) | 47,428 Providence addresses | search by any door address, e.g. 221 Medway St → the 280 Waterman St lot |
| Streets, parks, water, neighborhoods | city ArcGIS `City_Maintained_Roads`, `Labelled_Streets`, `Parks_And_Open_Space`; Socrata `ueqj-g33x` | citywide | basemap (the page host allows no outside map tiles) |
| Subsidized housing | HUD LIHTC, Multifamily Assisted, Public Housing Buildings; city `Providence_Housing_Authority` layer | Providence projects | exemptions (i)/(j) |
| Census tracts | ACS 2020–2024 5-year via Census Reporter (no key) | 42 tracts | income overall and for renters, race/ethnicity, tenure, rent, rent burden; a tract on every parcel |
| Eviction filings | Eviction Lab ETS CSV (data from RIHousing / the courts) | filings per tract per month, Jan 2020 → Oct 2026 (2,382 in Oct 2025–Sep 2026) | eviction pressure by area. No addresses; filings, not judgments. |
| Asking rents | Zillow ZORI city + ZIP CSVs | Providence since 2015; 7 ZIPs (most since 2022) | rent trend. Asking rents for listed units, skewed to professional listings. |
| Ordinance text, fiscal note, veto | IQM2 ORD-2026-11 / record 52231; council site | final text as passed 2026-04-16 | `rules/ordinance-2026-04.yaml` |

SQLite tables: `parcels`, `permits`, `tracts`, `evictions_tract_month`, `zori_month`. Manual input: `manual/big-buildings.csv`, hand-researched labels for big ambiguous buildings, with sources.

## 2. Online, not pulled yet

| Dataset | Where | Why it'd help | Notes |
|---|---|---|---|
| HUD Small Area Fair Market Rents by ZIP | huduser.gov `FY27_safmrs.xlsx` | official rent benchmark by ZIP and bedroom count; voucher payment standards | xlsx only; needs a browser user agent |
| RIHousing evictions dashboard | rihousing.com/evictions-dashboard (Tableau Public) | judgments and money awards, which Eviction Lab lacks | municipal level; crosstab download unconfirmed |
| RIHousing rent survey | rihousing.com/rent-survey (memo + Tableau) | average rent by municipality, 2015–2025 | drawn from CoStar's big professionally managed buildings, so it misses the 2–4-unit stock the cap mostly covers |
| HousingWorks RI Fact Book 2026 | PDF | municipal context (cost burden, affordable-housing share) | PDF only |
| Older tax rolls 2002–2020 | Socrata (one dataset per year) | 20-year owner-occupancy and investor-ownership trends | same pipeline, more years |
| Permits after Mar 2024 | city OpenGov portal (providenceri.portal.opengov.com) | new construction 2024–26, which the assessor extract can't see yet | record search exists; bulk access unconfirmed |
| City 311 cases (housing complaints) | FixMyPVD already syncs the city's case feed (`cityCases` in Firestore) | complaints per building or block | our own data; join via E-911 addresses |
| Census ACS via the Census API | api.census.gov | block-group detail and more tables | now requires a free key |

## 3. By request

| Dataset | Who holds it | How | Why it matters |
|---|---|---|---|
| Case-level eviction records (filing, parties, address, outcome) | R.I. Judiciary | **not APRA.** Form Supreme-19, "Request for Electronic Information or Report (Non-APRA)", to Community Outreach & PR, 250 Benefit St, (401) 222-4580; the Judiciary's discretion, possible fees. Alternative: an APRA request to RIHousing for the monthly court extract it receives (untested). | building-level eviction pressure; the public court portal blocks scraping |
| Certificates of occupancy (2019→) | Providence Dept of Inspections & Standards | APRA request to the City of Providence | settles the new-construction exemption exactly (it runs from the CO date) |
| Owner-occupied certification records | Providence Tax Assessor | APRA request; also ask how many owner-occupants lack the rate | sizes the "probably owner-occupied" bucket, the biggest uncertainty |
| *(more pending: lead-safe certificates, short-term-rental registrations, code enforcement, deeds, business entities; catalog research still running)* | | | |

## 4. Would help, not public

- **Actual rents per unit.** The April ordinance would have created a registry for new units; nothing citywide exists. CoStar per-property data is commercial.
- **Who lives where.** Occupancy is private. The ordinance's own test (principal residence) needs voter registration or tax-filing address, which aren't available to us for this use.
- **Housing Choice Voucher locations.** HUD protects tenant addresses; only tract-level counts are public (HUD "Picture of Subsidized Households").
- **Unpermitted units.** The assessor counts legal units only.

## Access notes

- health.ri.gov and dbr.ri.gov sit behind a Cloudflare browser challenge. Reading them needs a real browser.
- The court public portal (Tyler Odyssey) uses a bot challenge, so no scraping.
- NEREVAL (assessor property cards) returns 403 to this server.
- Listing sites (Zillow listings, Apartments.com, Craigslist) prohibit scraping in their terms.
