# Providence rent-stabilization map — data source catalog

Research date: 2026-10-31. Read-only web research. Status key: **ONLINE** (machine-readable or scrapeable now) · **BY REQUEST** (APRA, R.I.G.L. 38-2) · **NOT PUBLIC**. "(unconfirmed)" marks claims not verified against a primary page.

Access notes found along the way:
- health.ri.gov and dbr.ri.gov sit behind a Cloudflare managed challenge (plain curl gets "Just a moment..."); a real browser is needed to read them.
- APRA basics (R.I.G.L. 38-2): agency must respond within 10 business days, extendable 20 more for good cause; first hour of search/retrieval free, then up to $15/hr; copies up to $0.15/page. (verified below in the APRA section)

## 1. Evictions

Context: Providence evictions are filed in R.I. District Court, Sixth Division (Garrahy Complex). The "Providence Housing Court" is a municipal court for code cases, not evictions (see §7).

### 1a. Eviction Lab — Eviction Tracking System (ETS), Providence County
- **What:** monthly (and weekly) eviction *filings* per census tract, Providence County (146 GEOIDs incl. a "sealed" bucket; 42 are city-of-Providence tracts), with a 2016–2019 baseline average and tract racial-majority label.
- **Status:** **ONLINE**, CSV, no login. Verified by download 2026-10-31.
- **Access:** `https://evictionlab.org/uploads/providence_monthly_2020_2021.csv` and `https://evictionlab.org/uploads/providence_weekly_2020_2021.csv` (the filename says 2020_2021 but the file runs 01/2020 → 10/2026; `last_updated` column = 2026-10-10). All sites in one file: `https://eviction-lab-data-downloads.s3.amazonaws.com/ets/all_sites_monthly_2020_2021.csv` (70 MB). The HTML pages (evictionlab.org/eviction-tracking/providence-ri, /get-the-data/) return 403 to scripts; the dev mirror https://dev.evictionlab.org/eviction-tracking/get-the-data/ lists the links. CSVs download fine.
- **Coverage:** counts only, no addresses, plaintiffs, or outcomes. City tracts: 2,382 filings Oct 2025–Sep 2026 (my sum). Source line on the tracker: "Eviction filing data for Providence County are provided by the Rhode Island Housing Authority" (i.e., RIHousing, which gets it from the courts).
- **Caveats:** tract geography is 2010 or 2020 vintage (check before joining). The current month is partial. Filings are not judgments.
- **URLs:** https://evictionlab.org/eviction-tracking/providence-ri · https://dev.evictionlab.org/eviction-tracking/get-the-data/

### 1b. RIHousing Evictions Dashboard (Tableau Public)
- **What:** statewide monthly filings by type (9-day nonpayment vs. 20-day other), hearings, judgments, monetary awards, plus "Cases by Rent Pop Map" (by municipality, apparently). Monthly data from the R.I. Supreme Court, "updated by the 15th of each month".
- **Status:** **ONLINE** as a viz. Tableau workbook `rihousing/EvictionsTrackingDashboard` was last updated 2026-10-06. Tableau Public often permits "Download → Crosstab/Data" if the author enabled it (unconfirmed for this workbook).
- **Access:** https://www.rihousing.com/evictions-dashboard/ · workbook metadata `https://public.tableau.com/profile/api/workbook/EvictionsTrackingDashboard` (sheets: filings by type, hearings, judgments, judgments by representation, median award, cases-by-rent-pop maps).
- **Coverage:** aggregate only, statewide/municipal. Useful for judgments and awards, which ETS lacks.

### 1c. R.I. Judiciary Public Portal (Tyler Odyssey), case-level dockets
- **What:** register of actions/docket for each District Court case (parties, filing date, events, judgment). The public gets the docket only. Documents (complaints with addresses) are remote-accessible only to R.I.-admitted attorneys and approved agencies.
- **Status:** case-by-case lookup is ONLINE, but **scraping is blocked**: https://publicportal.courts.ri.gov/PublicPortal returns 403 with a DataDome bot challenge (`geo.captcha-delivery.com`), verified 2026-10-31. No bulk download.
- **URLs:** https://www.courts.ri.gov/Public-Resources/Pages/case-information.aspx (remote-access rule: public "shall have remote access to the register of actions or docket but shall not have remote access to other electronic case information").

### 1d. Case-level bulk eviction data — BY REQUEST (not under APRA)
- **Path:** The Judiciary says court case files and "electronic reports derived from court case files" are **not APRA records** (R.I.G.L. 38-2-2(4) excludes judicial case records). Instead, file form Supreme-19 "Request to Inspect and/or Copy Documents or Records or Request for Electronic Information or Report", ticking "Obtain Electronic Information/Report (Non-APRA Request)". It is governed by the Judiciary "Policy Regarding the Request for and Production of Electronic Information" (eff. Jan 25, 2018). Send to the Office of Community Outreach & Public Relations, 250 Benefit St, Providence, (401) 222-4580. The form names akriss@courts.ri.gov (older version: cberke@courts.ri.gov).
- **Expect:** a custom report (case no., filing date, plaintiff, defendant, property address if captured, disposition) at the Judiciary's discretion, possibly with programming fees (unconfirmed). Researchers (Eviction Lab via RIHousing) evidently get monthly extracts.
- **Alternative path:** an APRA request to **RIHousing** (a quasi-public agency subject to APRA) for the monthly court extract it receives. Likely denial grounds: data-sharing agreement or "court records" (unconfirmed, untested).
- **Pending law:** H 8350 (2026, Rep. Baginski) would "clarify the right of the public to have access to bulk electronic data processing records" incl. compilations of electronic court records. It was **held for further study** in House State Gov't & Elections on 2026-03-31; companions S 2138/2277/2389/2164.
- **URLs:** https://courts.ri.gov/Forms/Record,%20Report,%20and%20Document%20Requests.pdf · https://courts.ri.gov/programs-services/Documents/Media/APRA%20request%20form.pdf · https://fastdemocracy.com/bill-search/ri/2026/bills/RIB00035983/
- **Older archives:** the Judicial Records Center does on-site research. $15/hr staff search, first hour free. https://www.courts.ri.gov/programs-services/Pages/judicial-records.aspx

### 1e. Others checked
- **HousingWorks RI:** no eviction dataset of its own found. It republishes court/RIHousing totals in its Fact Book.
- **R.I. Center for Justice / RILS:** they publish caseload anecdotes (e.g., 358 PHA eviction cases handled in one year), not datasets; they presented to the Council Housing Crisis Task Force. Reported via https://steveahlquist.substack.com/p/state-of-tenant-evictions-in-ri-bleak. **NOT PUBLIC** as data.
- **Federal court:** wrong venue (MuckRock request bounced): https://www.muckrock.com/foi/providence-106/evictions-in-rhode-island-from-2019-20-united-states-district-court-for-the-district-of-rhode-island-98890/

## 2. Rents

### 2a. Zillow Observed Rent Index (ZORI)
- **What:** smoothed asking-rent index (typical observed market rent, all homes + multifamily), monthly.
- **Status:** **ONLINE**, CSV, no key. Verified by download 2026-10-31; latest month 2026-09-30.
- **Access (direct file URLs):**
  - ZIP: `https://files.zillowstatic.com/research/public_csvs/zori/Zip_zori_uc_sfrcondomfr_sm_month.csv` (seasonally adjusted: `..._sm_sa_month.csv`)
  - City: `https://files.zillowstatic.com/research/public_csvs/zori/City_zori_uc_sfrcondomfr_sm_month.csv`
  - Metro: `https://files.zillowstatic.com/research/public_csvs/zori/Metro_zori_uc_sfrcondomfr_sm_month.csv`
  - (index page https://www.zillow.com/research/data/ is 403 to scripts. The files themselves download fine.)
- **Coverage, Providence:** City series since 2015-01 ($2,190 in Sep 2026). ZIPs: 02903 (from 2017-08), 02905 (2022-01), 02906 (2015-01), 02907 (2024-01 only), 02908 (2022-05), 02909 (2015-07). 02904 is labelled North Providence; 02910/02911 are labelled Cranston/North Providence. Sep 2026 levels: 02906 $2,606, 02903 $2,318, 02908 $2,136, 02909 $2,054, 02905 $2,006, 02907 $1,827.
- **Caveats:** asking rents for listed units, skewed to professionally listed stock. Not in-place rents. ZIP-level only.
- **Terms:** Zillow's research-data terms allow use with attribution. Scraping zillow.com listings is prohibited by its ToS.

### 2b. HUD Fair Market Rents + Small Area FMRs (ZIP)
- **What:** 40th-percentile gross rent (rent + utilities) by bedroom count. SAFMRs are per ZIP, with 90%/110% payment-standard bands.
- **Status:** **ONLINE**, xlsx. FY2027 is already posted (FY starts Oct 1).
- **Access:** `https://www.huduser.gov/portal/datasets/fmr/fmr2027/FY27_safmrs.xlsx` (also `fy2027_safmrs_revised.xlsx`), `https://www.huduser.gov/portal/datasets/fmr/fmr2027/FY27_FMRs.xlsx`. FY2026 is at `/fmr2026/fy2026_safmrs.xlsx`. Needs a browser User-Agent (plain curl gets an empty 202). The API `https://www.huduser.gov/hudapi/public/fmr/...` needs a free bearer token (401 "Unauthenticated" without it).
- **Coverage:** every ZIP. FY27 area name is now "Providence-Fall River, RI-MA HUD Metro FMR Area" (METRO39300M39300; new OMB delineation). FY27 2BR SAFMR: 02903 $2,630 · 02906 $2,500 · 02909 $1,940 · 02908 $1,850 · 02905 $1,810 · 02907 $1,730.
- **Caveats:** I could not confirm whether Providence is a *mandatory* SAFMR area (i.e., whether PHA voucher payment standards follow these). Gross rent, not contract rent.
- **URLs:** https://www.huduser.gov/portal/datasets/fmr.html · https://www.huduser.gov/portal/datasets/fmr/smallarea/index.html

### 2c. RIHousing annual Rent Survey
- **What:** average rent by municipality and bedroom size, 2015–2025, plus a statewide vacancy rate (3.85% in 2025).
- **Status:** **ONLINE** as a memo and Tableau viz, no raw file. The 2025 memo is dated 2026-01-14. The Tableau workbook `RentSurveyDashboard` (sheets: State, Municipal, Vacancy Rate) was updated 2026-03-30.
- **Access:** https://www.rihousing.com/rent-survey/ · memo https://www.rihousing.com/wp-content/uploads/2026/02/Rental-Survey-Memo-2025.pdf · metadata https://public.tableau.com/profile/api/workbook/RentSurveyDashboard
- **Big caveat (from the memo):** "The Rent Survey sample is drawn from CoStar ... over 60,000 units in the state. CoStar mainly collects data on large, professionally managed apartment buildings ... smaller multifamily and single-family rentals are not typically included." So it misses exactly the 2–4-unit stock a Providence rent cap mostly covers. Per-property CoStar data is **NOT PUBLIC** (commercial license).

### 2d. HousingWorks RI Housing Fact Book 2026
- **What:** annual municipal profiles (rent and ownership affordability, cost burden, LMI share). The rent figures come from the RIHousing survey above.
- **Status:** **ONLINE**, PDF only. No xlsx/csv found.
- **Access:** https://stdidhousingworksriprod.blob.core.windows.net/housingworksri/documents/Housing-Fact-Books/HFB2026.pdf · municipal pages https://www.housingworksri.org/local-housing-facts/local-housing-facts-overview · methods https://www.housingworksri.org/research-policy/methods-sources

### 2e. ACS median gross / contract rent by tract
- **What:** B25064 (median gross rent), B25058 (median contract rent), B25063 (rent distribution), B25070 (rent burden), B25003 (tenure), B25127 (tenure × year built × units in structure), by tract or block group.
- **Status:** **ONLINE**. The 2020–2024 5-year (`/data/2024/acs/acs5`) and the 2025 1-year (`/data/2025/acs/acs1`, city level only) are live. **The Census API now requires a free key**: keyless calls 302 to `missing_key.html`, verified 2026-10-31. Key signup: https://api.census.gov/data/key_signup.html.
- **Example:** `https://api.census.gov/data/2024/acs/acs5?get=NAME,B25064_001E&for=tract:*&in=state:44%20county:007&key=KEY`
- **Caveats:** in-place rents, 5-year pooled, wide margins of error at tract level. Census Reporter (already used) wraps the same tables.

### 2f. Apartment List rent estimates
- **What:** new-lease median rent, vacancy index, time on market, concessions. Monthly from 2017.
- **Status:** **ONLINE**, CSV (Oct 2026 files): `https://assets.ctfassets.net/jeox55pd4d8n/22URKuUw4Fjzg4cODP5YBf/e2ca9fa8c46588a7ee139301984b108a/Apartment_List_Rent_Estimates_2026_10.csv` (file URLs change monthly; index https://www.apartmentlist.com/rentonomics/rental-data).
- **Coverage:** **no Providence city row**, only Providence-Warwick metro and Providence County. Low value.

### 2g. Listing sites (Zillow, Apartments.com, Craigslist, HotPads, Rentometer)
- **Status:** **NOT for ingestion.** Their ToS prohibit automated scraping, and Craigslist has litigated it (3Taps). Rentometer sells a paid API. A one-off manual sample is the only clean use.


**Access-note update (2026-10-31):** headless **Firefox via Playwright passes the health.ri.gov Cloudflare challenge** (used `/home/pwuser/pvd311/app/node_modules/playwright` + `/ms-playwright/firefox-1538`; chromium untested). Plain curl still gets "Just a moment...". dbr.ri.gov: see §5.

## 3. Lead-safe / lead-conformance certificates

Context: the Lead Hazard Mitigation Act (R.I.G.L. 42-128.1, 2002, enforced 2005) requires pre-1978 rentals to hold a lead certificate. The Housing Resources Commission (HRC) used to run the certificate program; RIDOH runs it now (certificate types in the data still carry "(Legacy HRC)" labels). A 2024 amendment removed the owner-occupied 2–3-unit exemption for the rental units (per RIDOH FAQ, below). Certificate of Lead Conformance = valid 2 years; Full Lead Safe = no expiry.

### 3a. RIDOH "Search Rhode Island Lead Property, Violation, and License Records" (Power BI, publish-to-web)
- **What:** every lead certificate RIDOH/HRC has on file, plus properties with a *second* notice of violation, plus licensed lead professionals. Linked from https://health.ri.gov/lead-poisoning/ri-rental-registry ("Find → Lead Certificates and Violations").
- **Status:** **ONLINE**, and the underlying model is queryable anonymously. Verified 2026-10-31. Report footer: "Last Data Update 30-Oct-26 09:41 PM" (daily refresh).
- **Access:** report `https://app.powerbigov.us/view?r=eyJrIjoiMDFiZGM3OTQtMjg2NC00MWNkLTlmNDctZGFkYjg0YWJkZTEyIiwidCI6IjUyY2E2YTU0LTQ0NjUtNDYzNS1iZmYzLTY1ZDBhODQxMjI4OCJ9`. Data API (Power BI public "querydata"): `POST https://wabi-us-gov-virginia-api.analysis.usgovcloudapi.net/public/reports/querydata?synchronous=true` with header `X-PowerBI-ResourceKey: 01bdc794-2864-41cd-9f47-dadb84abde12`, DatasetId `08d6da19-9904-4cf9-8466-48be8303548b`, ReportId `80eec9e1-a841-4def-943d-a18efcb692af`, modelId `550161`. Schema via `.../public/reports/conceptualschema`.
- **Tables / fields (from the schema):**
  - `Certificates` (204,760 rows statewide; **64,621 with Town = Providence**): CaseID, AddressID, Address, StrNum/StrName/StrType, Unit, Town, Zip, YearBuilt, NumUnits, PropertyType, LetterDate (issue date), Outcome (certificate type), Expiration_Date. Also `Old Certificates` (32,273) and `New Certificates` (172,487).
  - Providence by type (my query): Independent Clearance Inspection (Legacy HRC) 23,270 · Lead Conformance-Interior/Exterior 18,578 · Lead Safe 12,320 · Interior Only (Legacy HRC) 2,248 · Lead Conformance-Interior 1,576 · Full Lead Safe 1,326 · Conditional 1,296 · smaller types (Lead Free 620, Presumptive Compliance, condo, partial, etc.).
  - `NOVList`: properties with a second notice of violation, with owner/org name, mail address, property address. Only **54 rows statewide**.
  - `Licence`: lead inspectors/contractors with license dates, address, phone, email.
- **Caveats:** rows are certificates (history), not properties; one unit can have many. LetterDate has junk values (min 1940, max 2027) and Expiration_Date mixes dates and text ("See note below"), so filter. The report text says it searches properties "with a current certificate", but the model also holds legacy HRC and expired certificates (Expiration_Date back to 2008). Querying the model directly is how the report itself loads data; Microsoft documents publish-to-web data as public, but no RIDOH terms on bulk use were found (unconfirmed). Use polite, low-volume paging.
- **Why it matters:** a certificate's existence = an owner admitted the unit is a pre-1978 rental (or condo) at some point. The history gives a **list of pre-1978 rental addresses with unit counts**, back to the HRC era.

### 3b. RIDOH Rental Registry public map (Tolemi "Building Blocks")
- **What:** a statewide parcel map (434,797 parcels: 63,625 land + 371,172 structures) with, per parcel: **Lead Certificate Status** (Valid 18,426 · Partially Valid 1,734 · Expired 23,833 · Exempt 113,430 · No Certificate 277,376), Active Lead Certificate y/n, number of active certificates, certificates by type (historical), Registered Rental (19,218 parcels), Year Built, Number of Units, Is Residential, Is Multifamily, and public "Rental Property Owner" / "Rental Property Manager" identities. Filter metadata says these were refreshed 2026-10-28 → 2026-10-30.
- **Status:** **ONLINE to view; export disabled.** The site config returned by its API has `publicExportDisabled: true` and `publiCityExportFields: []`. It's a JS app on an anonymous GraphQL endpoint (`POST https://cg.tolemi.com/q`, operations `getCityFilters`, `fetchAssetCount`, list queries); filter queries are passed as an encrypted token, so automated pulls would mean reverse-engineering against the agency's evident choice. Not recommended. Verified 2026-10-31 (headless Firefox; the map itself needs WebGL2, the List view does not).
- **Access:** https://ridoh-ri.tolemi.com/ (linked as "Public Database" from https://health.ri.gov/rentalregistry; rentalregistry.ri.gov redirects there). Landlord registration side: https://slate.tolemi.com/c/ridoh-ri
- **Note:** the earlier "suspected rental" layer that caused the Feb 2025 controversy (§4b) no longer appears among the public filters (observed 2026-10-31; only "Registered Rentals" is exposed).

### 3c. Childhood lead poisoning data (RIDOH)
- Municipal-level incidence/prevalence by year (≥5 and ≥3.5 µg/dL), served from a public Google Sheet (`https://docs.google.com/spreadsheet/tq?key=0AoOx0r6ZIWi0dGhlSDV3WUZuWFVaMF90UHk4TjFDX0E`) behind https://health.ri.gov/data/childhood-lead-poisoning-data. **ONLINE**, municipal only. Address- or tract-level child data is **NOT PUBLIC** (health privacy).

### 3d. BY REQUEST: certificate and violation extracts (RIDOH)
- **Where:** RIDOH NextRequest portal https://healthandhumanservicesdepts-ri.nextrequest.com/ (or Pamela Lopes, Legal Services, Suite 404, 3 Capitol Hill, Providence 02908; pamela.lopes@health.ri.gov; fax 401-222-1797). Source: https://health.ri.gov/public-records-requests. Standard APRA terms: 10 business days (+20 for good cause), first hour free then ≤$15/hr, $0.15/page; denials go to the Director, then the AG.
- **Ask for:** full certificate table (all years) with AddressID and assessor parcel/plat-lot if held, and first and second notices of violation (only second notices are public in 3a). Likely redactions: owner personal phone/email (R.I.G.L. 38-2-2(4)(A)(I) personal-privacy exemption, unconfirmed how RIDOH applies it), and anything tied to a lead-poisoned child (health records, confidential under R.I.G.L. 23-24.6 / HIPAA-type rules; unconfirmed citation).

## 4. Rental registration / licensing

### 4a. RI Statewide Mandatory Rental Registry (R.I.G.L. 34-18-58)
- **Law:** P.L. 2023 ch. 156/157, eff. 2023-06-20. Every landlord registers with RIDOH: landlord/entity name, business or home address, email, phone, property manager/agent contacts, and dwelling-unit identification; pre-1978 non-exempt units must also show a lead certificate. Initial deadline 2024-10-01; new owners within 30 days; **annual re-registration by Oct 1**. Fines $50/unit/month (unregistered), $125/unit/month (no lead certificate); **no nonpayment eviction filing unless registered** (subsection g). Statute requires a "publicly accessible online database". Text: https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-58.htm
- **Fines:** RIDOH FAQ (page updated 2026-09-04): "As of April 2026, property owners who have failed to meet the requirements of the rental registry have started to be fined." Short-term rentals (Airbnb, summer rentals) need not register. FAQ: https://health.ri.gov/lead-poisoning-exposure/ri-rental-registry-faqs
- **Status:** **ONLINE as a full export via a past APRA release.** RIDOH answered APRA request **26-278** (2026-04-21, "list of all registered rental properties") on 2026-05-01 by publishing **"Approved Registrations - Export.xlsx"** (1.27 MB) as a *public* document: https://healthandhumanservicesdepts-ri.nextrequest.com/requests/26-278 → download `https://healthandhumanservicesdepts-ri.nextrequest.com/documents/62808486/download`. Downloaded and checked 2026-10-31.
  - Columns: Street Address, Number of Units, License Advisory (Lead Compliant 9,266 / Lead Exempt 5,382 / Lead Out of Compliance 521), Built Before 1978 (9,065 yes), Is Exempt (832), Property Manager (+ email, phone), Property Owner (+ email, phone).
  - 15,169 registrations, 49,585 units, statewide. **No town or ZIP column**, so Providence rows must be matched by street address. My rough match against Providence parcel + E-911 addresses: ~3,012 rows / ~9,651 units (upper bound; includes same-name streets in other towns). Against ~41,900 Providence renter households (ACS 2020–24, sum of our 42 tracts), that is low coverage.
  - Snapshot as of ~2026-05-01. A fresh copy is one APRA request away (same request text works; turnaround here was 8 business days, no fee).
  - Handle the owner phone/email columns carefully: personal contact data the agency released, but republishing it on a map is a separate choice.
- **Also:** the public Tolemi map (3b) shows registered-rental status per parcel with owner/manager names, daily, but no export.

### 4b. The Feb 2025 registry map controversy
- RIDOH launched the searchable public map on 2025-02-12 (built on Tolemi). The RI Coalition of Housing Providers objected to automatically flagged "suspected rental" parcels (derived, RIDOH said, from tax assessor and other public data), including owner-occupied single-family homes, and to landlords' home addresses being shown. Within days RIDOH removed landlords' home addresses; a later report says owners' names and 355 properties were removed. Sources: https://www.oceanstatemedia.org/news-and-culture/community/rhode-islands-new-database-for-renters-raises-concerns-over-privacy-and-ai-generated-property-listings · https://rhodeislandcurrent.com/?p=19678 (403 to scripts; content via search snippets) · launch: https://www.wpri.com/health/rhode-island-officially-launches-rental-registry-database/amp
- Current state (observed 2026-10-31): only registered rentals are flagged; no suspected-rental filter in the public filter list.

### 4c. Nonresident landlord agent designation (R.I.G.L. 34-18-22.3)
- **Law:** a landlord who doesn't live in RI must designate an in-state agent, filed **with the Secretary of State and with the city/town clerk**, listing each property's street address. Fine $100/month up to $1,200/yr. (34-18-58 is now the registry; the agent rule is 34-18-22.3.) https://webserver.rilegislature.gov/Statutes/TITLE34/34-18/34-18-22.3.htm
- **SOS side: ONLINE as scanned PDFs, not structured.** Filings are titled "Non Resident Landlord, Landlord Registration" (no fee) and are imaged on the business-filings server, e.g. https://business.sos.ri.gov/CORP_DRIVE1/2025/1005/000000000/6884/202579489880_1.pdf. They surface through the SOS business search (§9) but there's no list or bulk export of them (unconfirmed whether the SOS search can filter by this filing type).
- **City side: BY REQUEST.** APRA to the Providence City Clerk via https://providenceri.nextrequest.com/ for "all nonresident landlord designations of agent filed under R.I.G.L. 34-18-22.3, with property addresses". Not tested; compliance is probably spotty.

### 4d. Providence city registry: none
- The City says it has **no rental registry**: APRA request 26-1082 (2026-05-07, "list of all registered rental properties with the City") was closed 2026-05-12 with "The City of Providence does not maintain documents responsive to this request." https://providenceri.nextrequest.com/requests/26-1082
- Proposals that didn't pass: 2023 Miller/Sanchez citywide rental registry, referred to Ordinance Committee, never voted (https://www.bostonglobe.com/2023/09/21/metro/providence-council-president-wants-landlords-register-apartments-with-city ; https://pbn.com/providence-considering-citys-first-ever-rental-registry/). 2025 **"Student Housing Providers" license** (Ch. 14, Sec. 14-343 ff.): non-owner-occupied buildings housing only undergrads, 4+ students; $500/yr license; DIS to keep a registry; $100–$500/day fines. Introduced 2025-06-05, **continued in Ordinance Committee 2025-07-17**, no later action shown (checked 2026-10-31): https://providenceri.iqm2.com/Citizens/Detail_LegiFile.aspx?ID=49728

## 5. Short-term rentals

Why it matters: STRs remove units from the long-term stock, and an STR-registered address is a strong "not a long-term rental right now" signal. RIDOH says STRs (Airbnb, summer rentals) need not join the long-term rental registry (§4a FAQ).

### 5a. RI DBR Short-Term Rental registration roster (R.I.G.L. 42-63.1-14)
- **What:** every *active* state STR registration: registrant name, registration no. (format `RE.0200787.STR`), status, effective and expiration dates, STR street address, unit, city, ZIP. Platforms must show the registration number and expiry on listings since 2025-01-30 (DBR Real Estate Bulletin 2025-03 on mandatory platform reporting: https://dbr.ri.gov/sites/g/files/xkgbur696/files/2025-04/REBulletin_STRPlatform_V2%20%28003%29_0.pdf).
- **Status:** **ONLINE, CSV, no login, plain curl works.** Downloaded 2026-10-31: `https://ridbrprod.state-reg-eastern.tylerapp.com/licensing/page.request.do?page=page.shorttermRentalRoster` → "Short Term Rental Roster - Active Credentials - 10-30-2026.csv" (regenerated daily, apparently). Index: https://ridbrprod.state-reg-eastern.tylerapp.com/portal/public/online-reports (linked as "Generate a roster" from https://dbr.ri.gov/real-estate-and-commercial-licensing/short-term-rentals). DBR moved to this Tyler system on 2025-11-03; the old `elicensing.ri.gov/Lookup/...queryIdnt=1298` lookup now 404s.
- **Coverage:** 3,717 active registrations statewide; **412 with STR City = Providence** (by ZIP: 02906 125, 02903 91, 02909 79, 02908 66, 02904 20, 02907 17, 02905 10). Active only, so no history; snapshot it monthly to build one.
- Individual lookup: https://ridbrprod-search.state-reg-eastern.tylerapp.com/

### 5b. Providence STR rules + city permit list
- **Rules (city page):** STR = under 28 consecutive days. In R-1, R-1A, R-3 and R-4, only **owner-occupied** dwellings may be STRs (incl. an owner-occupant's spare apartments); in all other residential-allowed zones any dwelling may be. Whole-unit STRs need an annual **Temporary Use Permit** from Inspections & Standards; owner-present room rentals don't. https://www.providenceri.gov/short-term-rentals (the older info sheet lists R1/R1A/R2/R3: https://www.providenceri.gov/wp-content/uploads/2016/01/STR-Information-Sheets.pdf, conflict noted). Ordinance took effect Nov. 30, 2019 (https://pbn.com/?p=305461 ; AP 2019-11-20: https://m.washingtontimes.com/news/2019/nov/20/providence-to-start-regulating-short-term-rentals-/).
- **Permit list: ONLINE via past APRA releases (OpenGov exports).** Request 26-2245 (2026-09-02) got an unredacted CSV, `Short-Term_providenceri_2026-09-02 14_12_12.csv`: https://providenceri.nextrequest.com/requests/26-2245 → `https://providenceri.nextrequest.com/documents/69800665/download`. Columns: Record # (TEMP-yy-n), Record Type ("Short Term Rental - Temporary Use Permit"), Applicant Name, Date Submitted, Address, Record Status. **252 records** (190 Complete, 62 Active), submitted 2024-09 → 2026-09. Earlier copies: 25-1903 (2025-10-31 CSV, doc 53965361) and 26-1236 (2026-06 redacted PDF). The same request can be re-filed any time; past turnarounds ran from same day (26-2245) to ~5 weeks (26-1236).
- **Gap:** 252 city permits vs. 412 state registrations vs. 1,066 Airbnb listings (5c), so most Providence STRs have no city permit.

### 5c. Inside Airbnb, Rhode Island (statewide)
- **Status:** **ONLINE**, CSV/GeoJSON, CC BY 4.0. Latest scrape **2026-09-28**: `https://data.insideairbnb.com/united-states/ri/rhode-island/2026-09-28/data/listings.csv.gz` (detailed), `.../visualisations/listings.csv` (summary), `.../data/calendar.csv.gz`, `.../data/reviews.csv.gz`, `.../visualisations/neighbourhoods.geojson`. Index: https://insideairbnb.com/get-the-data/ (only the latest quarter is free; archives on request/paid).
- **Coverage:** 6,026 RI listings; **1,066 in Providence** (764 entire home/apt, 302 private room); 928 of the Providence listings show a state registration no. in `license` (joinable to 5a); 95 entire-home listings require 30+ nights (mid-term rentals, not STRs under city/state definitions).
- **Caveats:** Airbnb only (no Vrbo). Coordinates are jittered up to ~150 m by Airbnb, so join to parcels via the registration number → DBR address, not lat/lng.

### 5d. BY REQUEST
- **DBR:** expired/lapsed STR registrations (history) and the platform reports required under Bulletin 2025-03. APRA to DBR (contact on https://dbr.ri.gov, unconfirmed exact APRA page; DBR publishes APRA procedures). Likely personal-contact redactions.
- **City:** STR complaints/violations from DIS via https://providenceri.nextrequest.com/.

## 6. Certificates of occupancy + permits after Mar 2024

### 6a. City of Providence APRA portal (NextRequest) — the key to most city data
- **Portal:** https://providenceri.nextrequest.com/ (Public Records Unit, Law Dept, 444 Westminster St, Suite 220, Providence 02903; mail/drop-box accepted, **email and fax are not**). Anonymous requests allowed, and then everything is posted publicly. Procedures: https://www.providenceri.gov/law-department/public-records-request/ . Appeals go to the department head (e.g., DIS Director James C. Moore III), then the AG or Superior Court.
- **Its public JSON API makes past releases searchable and downloadable** (no key, plain curl): `GET https://providenceri.nextrequest.com/client/requests?search_term=<q>&page_number=1` (search), `/client/requests/<id>` and `/client/requests/<id>/timeline?page_number=1` (status and response text), `/client/request_documents?request_id=<id>&page_number=1` (released files), then `https://providenceri.nextrequest.com/documents/<doc id>/download`. Verified 2026-10-31. **Before filing anything, search here: many datasets in this catalog were already released to someone else.** (RIDOH and other HHS agencies share one instance: https://healthandhumanservicesdepts-ri.nextrequest.com/, same API.)
- **Turnaround seen:** OpenGov exports usually come back within days (26-2355 same day; 26-1629 six days; one STR request took ~5 weeks), mostly unredacted, no fee charged in any request checked.

### 6b. Building permits through Sep 2026: ONLINE via a past release
- APRA **26-2355** (filed 2026-09-14) got two full OpenGov exports, released publicly 2026-09-14 and re-cut 2026-09-15: https://providenceri.nextrequest.com/requests/26-2355
  - `All-building-permits_providenceri_2026-09-15 16_13_30.csv` → `https://providenceri.nextrequest.com/documents/70401717/download` (12.5 MB). **40,378 Building Permit records**, submitted Dec 2016 → 2026-09-15. Fields: Record #, Record Type, Applicant Name, Date Submitted, Address, Record Status (Complete 27,626 / Stopped 8,820 / Active 3,932), Type of Improvement, Approved Permit Language, Description of Work, **Number of Dwelling Units**, Living Space (sq ft), Commercial or Residential?, Structure Type, Permit/License Issued Date (16,255 filled; issued per year ≈1,250–1,400 for 2020–2025, 936 in 2026 to mid-Sep).
  - `All-demo-permits_providenceri_2026-09-15 16_09_59.csv` → `https://providenceri.nextrequest.com/documents/70401671/download`. 571 Raze Building Permits, Dec 2016 → Sep 2026, with Former Building Use and Building Type.
  - City's note: it **can't export the issue dates for permits imported from the prior (pre-OpenGov) system**; the vendor has disabled that function and a ticket is open. For recent permits, a blank issue date probably means never issued.
- **Monthly all-trade permit exports** exist as well: a research firm files every month (e.g. 26-1629 → `All-4-trays-permits-issued-for-year----APRA_providenceri_2026-07-06.csv`, doc 66307910, 927 permits issued June 2026, with project cost, contractor, owner name/city, structure type, building type). Series: 24-958, 24-1322, 24-1677, 25-2, 25-414, 25-667, 25-803, 25-1145, 25-1301, 25-1907, 25-1957, 26-289, 26-800, 26-1330, 26-1395, 26-1428, 26-1629, 26-1964 … (search "permit data points"). A solar-research requester has filed monthly since 2019 too.
- **Stale ArcGIS copies:** `DIS_Active_Permit_VIew` (18,213 rows, an Excel dump, last edit 2023-12-19) and `Interactive_Permitting_Map_(BETA)` (already pulled, to Mar 2024) at https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services. Socrata `ufmm-rbej` stops at 2020-01-23.

### 6c. OpenGov public portal (record-by-record)
- https://providenceri.portal.opengov.com/search — "Search for public records" by **Location** (address) or **Record** number. Anonymous browsing works, but the data API (`https://api-east.viewpointcloud.com/v2/providenceri/...`) returns `{"errors":["forbidden"]}` without a session token, and Cloudflare rate-limited a few probes (error 1015). The public endpoint `/v2/providenceri/record_types` lists 83 record types, including **"Certificate of Occupancy" (id 6565)**, "Zoning Certificate for Compliance" (6406), "Short Term Rental - Temporary Use Permit" (6424), and a **"Multi-unit Dwelling Property Management Registration" (6571)** (purpose unconfirmed; no ordinance found; worth an APRA question). **No bulk API**: use APRA exports.

### 6d. Certificates of occupancy: BY REQUEST (easy)
- No CO list is published anywhere (Socrata, ArcGIS or OpenGov). APRA history shows ~125 per-property CO requests and no citywide CO export yet.
- **Ask (to DIS via NextRequest):** "An electronic export (CSV) of all OpenGov records of record type 'Certificate of Occupancy' (and 'Zoning Certificate for Compliance'), all statuses, with record #, address, MBL/plat-lot, date submitted, date issued, record status, number of dwelling units, occupancy type, and linked building permit #." Based on 26-2355, expect a same-week CSV with no fee. Pre-OpenGov COs (before ~Dec 2016) may be paper only or stuck behind the vendor export problem (6b).
- Also ask what record type 6571 "Multi-unit Dwelling Property Management Registration" is, plus an export of it.

## 7. Code enforcement / housing court / 311

### 7a. Providence Housing Court case list: ONLINE via past release
- The Providence Housing Court is a municipal court for minimum-housing code cases (R.I.G.L. 45-24.2-7 and 8-8-3 give it jurisdiction over Providence violations instead of the District Court: https://codes.findlaw.com/ri/title-45-towns-and-cities/ri-gen-laws-sect-45-24-2-7/). The city's Prosecution Division brings DIS cases there: https://www.providenceri.gov/inspection/prosecution/
- APRA **26-521** (2026-03-12, "list of code enforcement cases") got `Housing Cases.xlsx`: https://providenceri.nextrequest.com/requests/26-521 → `https://providenceri.nextrequest.com/documents/60717056/download`. **5,193 housing court cases filed 1998-12 → 2026-03-09** (about 180–480 a year), columns: CASE NO., Prop.#, Property St, PLAT, LOT, DATE FILED, PRF, RCVR (receivership flag), CLOSED, FINAL JUDGMENT, AMOUNT, COUNT O/S. Dates are Excel serials, with some text. No party names. Downloaded and checked 2026-10-31.
- No online docket. Case-level dockets go by APRA to "Housing Court" (a NextRequest department; e.g. 18-260 got a docket copy).

### 7b. DIS code enforcement cases (OpenGov "CODE-" records): ONLINE via past releases
- APRA **26-1279** (2026-05) → `APRA 26-1279 Pt 1.xlsx` (doc 64624609) + Pt 2 (doc 64624610) + doc 64108399: https://providenceri.nextrequest.com/requests/26-1279 . Pt 1 = **1,269 active code-enforcement records** submitted 2023-01-03 → 2026-06-02, with Record #, Occupancy Type (free text, e.g. "(15 Story) 202 dwelling Units"), MBL, Address, Date Submitted, Last Record Activity, Status, **Owner Name/Street/City/State**.
- APRA **25-2315** (2025-12) → last-30-days CSVs (Record #, Record Type "Code Enforcement Inspection", Date Submitted, Address, Status); the city said it keeps no "case logs" and **withheld inspection summaries** (reason truncated in the response; likely the investigatory exemption, unconfirmed).
- **ArcGIS snapshot:** `Violations_Code_Enforcement_` (999 rows, first inspections 2013-04 → 2024-05, last edit 2024-03-25): Record #, Address, MBL, status, owner, Complaint_Type (595 "Substandard Housing Code Issues or Violations", 81 "Systematic", 58 "No Heat, Hot Water, Gas or Electricity", 21 "Illegal Housing"…), first/second NOV issued/posted/released dates, condemnation dates (12 condemned), lat/long. `https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services/Violations_Code_Enforcement_/FeatureServer/0`. The 999 count looks like a truncated export.
- **Ask (BY REQUEST, to DIS):** a full export of all OpenGov code-enforcement records (all statuses, 2016 →) with complaint type, violation codes, NOV dates, condemnation, and closed date. 26-1279 suggests it will come back as xlsx; inspection narratives will probably be withheld.

### 7c. 311 housing complaints
- **Not on data.providenceri.gov** (Socrata catalog search for "311", "violation", "housing": nothing relevant, checked 2026-10-31).
- **Ours:** FixMyPVD already syncs the city's 311 case feed (`cityCases` in Firestore; per repo DATA_SOURCES.md). Filter to housing-type categories (no heat/hot water, substandard housing, illegal housing, rodents) and join by address. Coverage starts when our sync began; older 311 history is **BY REQUEST** (311 / Dynamics export via NextRequest).

### 7d. Problem-property lists
- No published "problem properties" list found (APRA search turns up only per-property asks). The nearest are the Housing Court receivership flag (7a, RCVR column), condemnations (7b), and the vacant/abandoned registry (§11). Police "nuisance property" designations, if any, are **unconfirmed / not found**.

## 8. Property sales / deeds

### 8a. Providence Recorder of Deeds: Kofile CountyFusion ("Town Fusion")
- **What:** index + images of land evidence records (deeds, mortgages, liens, foreclosure deeds, lis pendens, nonresident-landlord designations, maps). Online from ~2000 (city: "after January 1, 2000, as well as intermittent older records"); older material is in the vault (book an appointment) or the digital archives.
- **Status:** **ONLINE for search, not bulk.** Guest login, free index search; image prints/downloads are paid (fee schedule on the site, unconfirmed amounts). Interactive session app, no API or bulk export found; scraping it at volume would be unwelcome (vendor terms unconfirmed). Recorder: Room 508, City Hall, 25 Dorrance St; Recorder@providenceri.gov.
- **Access:** https://countyfusion10.kofiletech.us/countyweb/login.do?countyname=TownFusion&town=ProvidenceRI (linked from https://www.providenceri.gov/recorder-of-deeds/, which also states the Providence deed rules: address, grantee mailing address and plat/lot required on every deed; foreclosure deeds must meet the city's Foreclosure Conciliation requirements, see §11).
- **APRA catch:** the city now **denies bulk sales/deed requests by pointing to this site**: APRA 25-1669 (sales 2002–2013) and 25-1788 (2024 sales) were both closed citing R.I.G.L. 38-2-3(e) ("available for inspection ... on the City of Providence web site"): https://providenceri.nextrequest.com/requests/25-1788 . Earlier the Assessor did release spreadsheets: 21-515 → "All 2020 sales.xlsx" (doc 7751819) and 20-209. So ask the **Tax Assessor** for an *assessor sales file* (their valid/invalid sales list with sale codes), not "deeds".
- Nonresident-landlord designations are supposed to be recorded here too (the page tells landlords to record the SOS form 34-18-22, citing 34-18-22.3 and the 34-18-57 absentee landlord enforcement act), so a CountyFusion document-type search could list them (unconfirmed which document type code they file under).

### 8b. Assessor sales already online
- **CAMA last sale** (book/page, price, date) per parcel is already in our `parcels` table.
- **City ArcGIS "valid sales" layers** (2024 revaluation): `Residential_ValidSales_All_2024` (layer 25, **1,543** valid residential sales, SaleDate 2002 → Jan 2025, mostly warranty deeds) and `Commercial_ValidSales_All_2024` (layer 26, 247), with parcel, owner, LastBook/LastPage, SalePrice, SaleDate, Instrument_Type, NumUnits, YearBuilt, assessed values. Last edit 2025-03-05. https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services/Residential_ValidSales_All_2024/FeatureServer/25 . Arm's-length sales only, so it understates investor/LLC churn.
- **Tax rolls FY2021–26** (already pulled): owner changes year over year are a proxy for transfers.

### 8c. Statewide
- No public statewide per-property sales file found. The conveyance tax (rate up to $3.75/$500 above the Tier 2 threshold since 2025-10-01; 2026 threshold $824,000) is collected by towns via the RI Division of Taxation form, but the returns aren't published (https://www.rirealtors.org/news/2026/01/14/news/tier-2-conveyance-tax-increases-for-2026/). RI Realtors publishes monthly MLS medians by town only. Per-transaction statewide data = Warren Group/ATTOM (commercial, **NOT PUBLIC**).
- Assessor property cards (NEREVAL/Vision) return 403 to this server (already noted).

## 9. Ownership / LLCs

### 9a. RI Department of State business entity search (free, one at a time)
- **What:** Corp., LP, LLP, LLC **and Non-resident Landlord** filings. Search by entity name, by individual (officer/director/manager), by agent, by business address, by purpose or NAICS, or by ID/filing no.; includes inactive entities. Filing images are PDFs on `business.sos.ri.gov/CORP_DRIVE1/...`.
- **Status:** **ONLINE**, plain curl gets 200 (ASP.NET WebForms, so scripted search means viewstate posts). No API. Good for resolving the owner LLCs in our tax roll one by one (registered agent, manager names, principal office), and searching "Non-resident Landlord" entity names gives the 34-18-22.3 filings (§4c).
- **Access:** https://business.sos.ri.gov/CorpWeb/CorpSearch/CorpSearch.aspx

### 9b. RI corporate database bulk download (paid, ONLINE by purchase)
- **What:** one-time .TXT extracts by SFTP: Corporate Database **Active $250**, Inactive $50, RI Active LLCs $50, RI Active Business Corps $50, Non-profits $50, Trade Names $500. Annual subscription (daily/monthly): Corporate Active $3,000/yr, Active+Inactive $3,600/yr. Order by email corp_tech@sos.ri.gov or 401-222-3040; two business days. State agencies subscribe free.
- **Source:** https://www.sos.ri.gov/divisions/business-services/business-data-hub/data-subscription (verified 2026-10-31). Field list not published (unconfirmed whether officers/managers and agents are in the extract, or only entity + agent + principal office; ask before buying).
- **Why:** **$300 (active + inactive) gets every RI entity**, so you can join the tax-roll owner name → entity → agent/manager address and cluster LLCs that share an agent, manager or mailing address into landlord portfolios. Probably the best-value purchase in this catalog.
- **APRA alternative:** the same records are public, so an APRA request to the Department of State for the database in electronic form might be cheaper (APRA caps at $15/hr after the first hour), but the agency may point to its own published fee schedule instead. Untested.

### 9c. OpenCorporates
- Covers Rhode Island (`us_ri`, source "Division of Business Services, Rhode Island Office of the Secretary of State" per its register list https://assets.opencorporates.com/registers). The website is behind a reCAPTCHA browser check (failed in headless Firefox, 2026-10-31), and the API needs a token (`{"error":{"message":"Invalid Api Token..."}}`); free tokens go to qualifying public-benefit/journalism projects on application. Record count and freshness for RI **unconfirmed**. Officer data in US states is often thin. Lower value than the $300 state extract.

### 9d. NOT PUBLIC
- Beneficial ownership: RI has no beneficial-owner register; the federal FinCEN BOI database is not public (and domestic companies were exempted in 2025). So LLC → human only works through manager/agent names on state filings, deed signatures (§8a), and the RIDOH registry owner contacts (§4a).

## 10. Subsidies

### 10a. HUD Picture of Subsidized Households (PSH): tract-level vouchers
- **What:** per tract × program (Housing Choice Vouchers split into tenant-based/project-based, Public Housing, Project-Based Section 8, 202/811 PRAC, Mod Rehab, plus "Summary of All HUD Programs"): units, occupied, people, average rent paid, household income, % below 30/50/80% AMI, demographics, months on waiting list, % overhoused. Also PROJECT, PHA, ZIP and PLACE files.
- **Status:** **ONLINE**, xlsx, no key. **2025 data (as of 31 Dec 2025, 2020 tracts)** posted 2026-02-18. Verified by download 2026-10-31.
- **Access:** index https://www.huduser.gov/portal/datasets/assthsg.html . Tract file with RI: `https://www.huduser.gov/portal/datasets/pictures/files/TRACT_MO_WY_2025_2020census.xlsx` (70 MB, one 500 MB sheet: stream-parse; it took ~2 min with stdlib iterparse). Project file: `.../PROJECT_2025_2020census.xlsx`. Needs a browser User-Agent.
- **Providence (42 city tracts, my sums):** all HUD programs 9,899 occupied units; HCV 2,751 occupied in 39 tracts (tenant-based 2,377, project-based 264; 3 tracts suppressed); Public Housing 2,468 in 26 tracts; Project-Based Section 8 4,279 in 26 tracts. Small cells are suppressed (−1/−4 codes).
- **Also:** HUD's ArcGIS `Housing_Choice_Vouchers_by_Tract` (https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Housing_Choice_Vouchers_by_Tract/FeatureServer) is the same HCV counts as a feature layer (vintage unconfirmed).
- **NOT PUBLIC:** voucher holder addresses (HUD/PHA privacy). Tract counts are the floor of what's possible.

### 10b. RIHousing / EOH Low- and Moderate-Income Housing (LMIH) chart (R.I.G.L. 45-53)
- **What:** units counted toward each town's 10% affordable goal. 2025 chart released 2026-05-22: statewide 43,954 LMIH units (net −524 vs 2024; 565 new units placed in service). **This is RIHousing's last chart; 2025 legislation moves it to the Executive Office of Housing (EOH, housing.ri.gov).** Memo: https://www.rihousing.com/wp-content/uploads/2026/05/2025-LMIH-External-Memo.pdf · chart: https://www.rihousing.com/wp-content/uploads/2026/05/Final-2025-LMIH-Chart.pdf
- **Property level:** each town's "Municipal Sheet" lists only the year's **changes by property** (e.g., Providence 2025: added Summer Street Apartments 176 units, Tempo 45, Potters Tigrai 20; removed McAuley Village 23 (expired), Linwood Court II 44, etc.): https://rihousing.com/wp-content/uploads/2026/04/2025-Providence-Municipal-Sheet.pdf (PDF). **The full property-by-property inventory isn't posted** (not found on https://www.rihousing.com/public-information/rihousing-reports/low-moderate-income-housing-by-community/).
- **BY REQUEST:** APRA to RIHousing for the **LMIH inventory database for Providence** (property name, address, plat/lot, units by type, subsidy program, affordability start/end, deed restriction recording ref.). RIHousing: recordsrequests@rihousing.com (or form https://www.rihousing.com/wp-content/uploads/APRA_Request_Form_2019-.pdf; 44 Washington St, Providence); rules 825-RICR-10-00-3; "reasonable efforts" to answer within 10 business days. As of the 2025 handoff, EOH may hold the master copy, so send the same request to EOH (contact via https://housing.ri.gov/about-us/contact-us). Exemptions: unlikely for project-level data; tenant data would be withheld.

### 10c. Deed-restriction registry
- **None public statewide.** Restrictions are recorded in local land records (search CountyFusion, §8a, e.g. for "DECLARATION OF RESTRICTIVE COVENANTS"/"LAND USE RESTRICTION AGREEMENT" document types, names unconfirmed). Compliance is tracked by approved Monitoring Agents, which EOH/HRC certifies and which report to the state; the April 2026 guidebook aims for "statewide consistent and transparent procedures": https://housing.ri.gov/sites/g/files/xkgbur401/files/2026-05/RI%20Monitoring%20Agent%20Guidebook%20April%202026.pdf · program: https://housing.ri.gov/programs/monitoring-agent-program . A 2026 rulemaking on the program (https://housing.ri.gov/sites/g/files/xkgbur401/files/2026-05/Pub.Notice%20of%20Prop.Rulemaking%20-%20Monitoring%20Agent%20Program.pdf) may create a central list (unconfirmed). **BY REQUEST** from EOH: monitoring-agent portfolio reports for Providence.
- **National Housing Preservation Database** (NHPD, https://preservationdatabase.org/): property-level federal subsidy inventory with subsidy **end dates** (LIHTC, Section 8 contracts, HOME, USDA). **ONLINE, free registration.** It adds expiration risk that the HUD layers we hold lack; Providence counts unconfirmed.

## 11. Tax sales / foreclosures / vacancies

### 11a. Providence tax sales: ONLINE (city Collector page)
- **Files** (linked from https://www.providenceri.gov/collector, verified 2026-10-31):
  - **2026 sale results CSV:** `https://www.providenceri.gov/wp-content/uploads/2026/08/Tax-Sale-Results-Final-08-2026.csv`. **214 parcels** sold 2026-05-21: buyer entity/address, primary owner, parcel no. (plat-lot-unit), parcel location, face value, interest rate, total; 2 flagged "DIS LIEN" (code-enforcement liens sold).
  - 2026 pre-sale advertisement (all advertised parcels, PDF): `https://www.providenceri.gov/wp-content/uploads/2026/04/FINAL-AD-CITY-2026-Revised-042426-Final.pdf`. 2026 sale ran on GovEase (flyer `.../2026/04/GovEase2026-Sale-Flyer-INFORMATION.pdf`); 2025 used CivicSource.
  - 2025: `.../2025/06/Properties-Sold-at-the-May-22-2025-Tax-Sale.xlsx`, ad `.../2025/05/collectors-sale-may-22-2025.pdf`, redeemed list `.../2026/05/Redeemed-Properties-52225-Tax-Sale1.pdf`. 2024 redeemed: https://www.providenceri.gov/collector/properties-redeemed-from-the-may-23-2024-tax-sale/
- **Cadence:** one sale a year in May; results posted ~Aug. Older years: by request to the Collector (taxsale@providenceri.gov) or NextRequest.
- **Why:** tax-sale parcels are distress and turnover signals; tax-sale buyers (LLCs, out-of-state bidders) end up as new landlords.

### 11b. Foreclosures
- **Statewide mediation:** the old R.I.G.L. 34-27-3.2 was **repealed eff. 2024-06-26** and replaced by **34-27-9 "Mediation conference"** (P.L. 2024 ch. 403 art. 3): before foreclosing an owner-occupied primary residence, the mortgagee must offer mediation through a HUD-approved counseling agency acting as "mediation coordinator", and the coordinator's certificate **must be recorded with the foreclosure deed**. https://webserver.rilegislature.gov/Statutes/TITLE34/34-27/34-27-9.htm . No public program statistics found (RIHousing used to coordinate it; NCSHA 2014 case study: 6,165 notices in year one: https://www.ncsha.org/wp-content/uploads/2018/05/RhodeIsland_T_15.pdf). Aggregate counts **BY REQUEST** (RIHousing or DBR Banking; whether any agency now compiles them is unconfirmed).
- **Providence:** foreclosure deeds must meet the city's **Foreclosure Conciliation** requirements (linked from https://www.providenceri.gov/recorder-of-deeds/; ordinance text not retrieved). Foreclosure deeds, mediation certificates, and the R.I.G.L. 34-27-4 sale notices are recorded/published, so the **property-level source is CountyFusion (§8a)**, searching document types like FORECLOSURE DEED (names unconfirmed). No bulk feed. Legal-notice foreclosure auctions also run in the Providence Journal (commercial).
- **Tenants in foreclosed buildings:** 34-27-7 requires notice to tenants of a foreclosure sale (https://webserver.rilegislature.gov/Statutes/TITLE34/34-27/INDEX.htm). No dataset.

### 11c. Vacant / abandoned property registry (Providence Code ch. 13, art. VII, §13-53)
- Owners of vacant/abandoned buildings must register with the city, $250 fine for noncompliance (deregistration form, 2026: https://www.providenceri.gov/wp-content/uploads/2026/02/Deregistration-Request-for-Abandoned-or-Vacant-Property.pdf).
- **ONLINE via past release:** APRA **25-339** (2025-02-27, "list of properties currently categorized as abandoned and/or vacant") → `apra 25-26.xlsx`, doc 43471545: https://providenceri.nextrequest.com/requests/25-339 → `https://providenceri.nextrequest.com/documents/43471545/download`. 5 sheets (by registration year, ~2017–2025), roughly 100 properties per sheet, columns ADDRESS, PLAT, LOT, OWNER, OWNER/MANAGEMENT ADDRESS, REGISTERED AGENT, PROPERTY MANAGEMENT, 1ST/2ND YEAR + dates. **House numbers partly redacted** (city cited 38-2-2(4)(D)(c) privacy, odd for real property), but plat/lot survive, so it's joinable.
- **ArcGIS snapshot:** `Vacant_Properties_Layer` (722 parcels with owner, use, units, year built; last edit 2023-08-02; source and definition unstated, maybe a utility-shutoff or survey list): https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services/Vacant_Properties_Layer/FeatureServer/0
- **Non-utilization tax list:** APRA 22-1097 → `RecordedNONU.propertylist.2019 year.xlsx` (doc 15777180; 68 parcels, address + parcel ID) = properties the city charged its vacant-property "non-utilization" tax.
- **BY REQUEST (refresh):** ask DIS for the current vacant/abandoned registry export **unredacted** (appeal the street-number redaction: addresses of registered vacant buildings aren't personal information) plus the current non-utilization list from the Assessor/Collector.

### 11d. HUD-aggregated USPS vacancy data
- Quarterly counts of vacant and "no-stat" residential/business addresses by **tract** (and ZIP), from mail carriers. **Restricted:** "HUD can make the data accessible only to governmental entities and non-profit organizations registered as users", for a stated purpose under a sublicense: https://www.huduser.gov/portal/datasets/usps.html . A private project can't get it directly; a partner nonprofit (e.g., HousingWorks RI) or the city could. Treat as **NOT PUBLIC** for us.

## 12. Anything else a rent-cap map wants

### 12a. Rent-burden studies and the Council "Housing Hub"
- **Housing Hub** (https://council.providenceri.gov/housinghub/): a policy page (supply, rental market regulation, tenant protections, homelessness), **no datasets**. Its research link is the **Housing Crisis Task Force 2025 Report** (chair Mary Kay Harris): https://council.providenceri.gov/wp-content/uploads/2025/09/HCTF-Report-2025-4_smaller.pdf ("Nearly half of Providence renters ... spending more than they can afford"). PDF; useful for framing and cited sources, not ingestion.
- **City plans:** 2025–2029 Consolidated Plan and the Annual Action Plan draft posted June 2026 (needs assessment, CHAS-based): https://www.providenceri.gov/wp-content/uploads/2026/06/2029-2027-Annual-Action-Plan-DRAFT.pdf ; comprehensive housing strategy and FY2025 progress report: https://www.providenceri.gov/wp-content/uploads/2025/10/City-of-Prov-FY2025-Housing-Progress-Report_2-Pager.pdf . PDFs.
- **HUD CHAS** (Comprehensive Housing Affordability Strategy): tract-level cost burden **by income band (≤30/50/80% HAMFI) × tenure**, which ACS doesn't give. **ONLINE**, CSV zip by geography (tract level included) plus a token API (https://www.huduser.gov/portal/dataset/chas-api.html). **Latest: 2018–2022 ACS basis, released 2025-12-23**: https://www.huduser.gov/portal/datasets/cp.html . Worth ingesting next to our ACS tract table.
- Others: RI Foundation 2023 housing needs study (statewide; Providence among the most cost-burdened); HousingWorks RI Fact Book (§2d). No dedicated 2025–26 Providence rent-burden study found.

### 12b. "College Student Residential Overlay District" (zoning Ch. 27): proposed, not law (as of 2026-10-31)
- **In force:** the 2015 amendment (Zoning Ordinance §201 definition + §1202(L)(5) per the court) bars non-owner-occupied single-family dwellings in **R-1 and R-1A** from housing more than three college students. Upheld in *Federal Hill Capital, LLC v. City of Providence* (R.I. 2020): https://law.justia.com/cases/rhode-island/supreme-court/2020/18-114.html . A 2022 attempt to extend it to R-2/R-3 multifamily was scaled back (Referral 3523: https://www.providenceri.gov/wp-content/uploads/2022/06/Referral-3523-College-Student-Occupancy-Dwelllings-petition.pdf).
- **Proposed 2026:** Councilwoman Shelley Peterson's ordinance (introduced March 2026: https://council.providenceri.gov/2026/03/19/councilors-present-ordinances-on-student-housing-zoning-and-rental-assistance-pass-resolution-opposing-state-8-law-expansion/), City Plan Commission **Referral 3619** (draft, July 2026): new **"CS College Student Residential Overlay District"** (up to **5 college students per unit**, to concentrate off-campus student housing) and **"CS College Student Residential Buffer Overlay District"** (non-owner-occupied single-family ≤3 students per property; other non-owner-occupied ≤3 per unit, ≤6 per property), with a map: https://www.providenceri.gov/wp-content/uploads/2026/07/Referral-3619-Student-housing-growth-control-petition.pdf . CPC took it up 2026-07-28 (ACLU opposition letter: https://www.riaclu.org/app/uploads/2026/07/Letter-–-2026-Providence-Student-Housing-Ordinance.pdf); PBN (Aug 2026) reports the commission agreed with stricter regulation. **Council passage not confirmed.** The city's ArcGIS `Overlay_Zoning` layer (last edit 2024-09-19) has no CS district, only CC, DD, ESOD, I-3E (Educational Institutional), I-3H, HD, PLD, TOD: https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services/Overlay_Zoning/FeatureServer/0 . If it passes, the map attached to Referral 3619 is the boundary source until GIS updates.
- Related: the stalled Ch. 14 "Student Housing Providers" license (§4d).

### 12c. University housing master leases: NOT PUBLIC
- Brown, RISD, JWU and PC are private, so not subject to APRA. Brown has said lease financial terms are "not information that we'd share publicly" (via https://browncovidarchive.omeka.net/items/show/642). Known examples are anecdotal (JWU at Capitol Cove, ~334 students c. 2013: https://pbn.com/jwu-condo-deal-a-major-market-sign70353/ ; Brown bought River House, 174 units, 2021). Proxies: university-owned/exempt parcels in the tax roll (have), the Ch. 14 registry if it passes, and students-per-unit from the Referral 3619 debate. The universities' institutional master plans filed with the CPC list owned and leased housing inventory in some years (PDFs on providenceri.gov, coverage unconfirmed).

### 12d. Building energy benchmarking (BERO)
- Providence Building Energy Reporting Ordinance (ORD-2024-41, amending ORD-2023-35, per the city's webinar): privately owned buildings **>50,000 sq ft reported from 2025; >20,000 sq ft from 2026** (due May 15). Page: https://www.providenceri.gov/sustainability/building-energy-reporting/ . Annual report: **2024 Building Energy Report** (PDF, aggregate): https://www.providenceri.gov/wp-content/uploads/2024/12/2024-BERO-Report-FINAL-1.pdf . No 2025 report found.
- **"Public Covered Properties List"** is linked as a SharePoint Excel file, but the link now **redirects to a Microsoft sign-in** (checked 2026-10-31), so it isn't actually public at the moment. **BY REQUEST** (Office of Sustainability via NextRequest): covered-properties list + building-level reported data (ENERGY STAR score, EUI, gross floor area, property type). Why: it's a list of every 20k+ sq ft building with its use type, a decent cross-check for big multifamily.

### 12e. Small extras found along the way
- **Landlord fire-insurance declarations (R.I.G.L. 34-43-1, Providence only):** every landlord of non-owner-occupied residential property with **3+ households** must file a declaration with the **Providence Tax Assessor** (insurer, policy no., named insured, coverage) within 10 days of taking title. That would be a de facto list of 3+-unit rentals. **BY REQUEST** to the Assessor; compliance and recordkeeping unknown. https://webserver.rilegislature.gov/Statutes/TITLE34/34-43/34-43-1.htm
- **Tax stabilization agreements (TSAs):** relevant to the new-construction exemption; applications run through OpenGov ("Application for Tax Stabilization", Tax Assessor) and Council resolutions on IQM2. **BY REQUEST:** the Assessor's list of active TSAs with parcel, start year and term.
- **Absentee landlord enforcement act (R.I.G.L. 34-18-57)** is referenced by the Recorder alongside 34-18-22.3. Not researched further.

## Summary

**Main finding:** before filing any APRA request, search the city and RIDOH **NextRequest archives** (public JSON API, §6a). Several "by request" datasets were already released publicly to someone else and can be downloaded today.

**5 most valuable ONLINE sources to ingest next**
1. **City building permits, Dec 2016 → 2026-09-15** (APRA 26-2355 CSV, 40,378 permits with dwelling units and issue date): closes our post-Mar-2024 permit gap. `providenceri.nextrequest.com/documents/70401717/download`
2. **RIDOH statewide rental registry export** (APRA 26-278 xlsx, 15,169 registrations / 49,585 units, lead status, owner and manager contacts; no town column, ~3,000 match Providence addresses): the only list of declared rentals. `healthandhumanservicesdepts-ri.nextrequest.com/documents/62808486/download`
3. **RIDOH lead-certificate Power BI model** (64,621 Providence certificate records with address, units, year built, type, issue/expiry dates, refreshed daily; anonymous querydata API): a history of pre-1978 rental addresses.
4. **Short-term rentals**: DBR active STR roster CSV (daily, 412 Providence) + city STR permit CSV (APRA 26-2245, 252) + Inside Airbnb 2026-09-28 (1,066 Providence listings, 928 with a state registration no.), to flag units out of the long-term stock.
5. **Code distress**: Housing Court case list 1998–2026 (APRA 26-521, 5,193 cases by plat/lot, receivership flag) + active DIS code cases with owners (APRA 26-1279, 1,269), plus 2026 tax-sale results CSV (214 parcels).
   - Runners-up: HUD Picture of Subsidized Households 2025 by tract, HUD CHAS 2018–2022 tract cost burden, vacant-property registry (APRA 25-339).

**5 most valuable BY-REQUEST sources**
1. **Certificates of occupancy** (DIS, NextRequest): OpenGov export of record type "Certificate of Occupancy" (+ Zoning Certificate for Compliance) with issue dates and unit counts. Settles the new-construction exemption; 26-2355 suggests a fast, free CSV.
2. **Tax Assessor bundle** (NextRequest): owner-occupancy certification records; R.I.G.L. 34-43-1 landlord insurance declarations (a list of 3+-household rentals); active tax stabilization agreements.
3. **Case-level eviction records** (R.I. Judiciary, non-APRA form Supreme-19; or APRA to RIHousing for its monthly court extract): building-level eviction filings and outcomes.
4. **Full DIS code-enforcement export, all statuses since 2016** (complaint type, violation codes, NOV and condemnation dates, closed date), plus an unredacted vacant/abandoned registry.
5. **LMIH property inventory** (RIHousing recordsrequests@rihousing.com and/or EOH): every counted affordable property with units, program, and affordability end date, to mark subsidized/deed-restricted exemptions and expiring units.
   - Best paid option: **RI Dept. of State corporate database extract, $250 active + $50 inactive** (corp_tech@sos.ri.gov), to cluster owner LLCs into landlord portfolios.
