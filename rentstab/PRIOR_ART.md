# Prior art: rent-stabilization coverage maps

Research date: 2026-10-31. This is read-only web research. "Unconfirmed" means I could not open the primary source.

## Bottom line

- **Providence:** I found no public map, dashboard or address lookup of which homes the April 2026 ordinance (or the January draft) would have covered. The record holds only citywide **numbers**: the fiscal note's ~48k of ~80k units (~60%), the CFO's "fewer than 44%", the mayor's "about half exempt", and city data that the owner-occupied exemption alone removes 16k+ units. None of them comes with a parcel list or a map. A building-level Providence map would appear to be the first.
- **Elsewhere:** the closest analogues are parcel-level "likely covered" audits built from assessor data:
  - Jersey City 2025
  - NYC "Am I Rent Stabilized"
  - Mission Local's SF map
  - Urban Institute's DC 2011 database

  There are also official lookups (LA ZIMAS/LAHD, Mountain View, Berkeley). None of the examples I found is an interactive *policy builder* where you toggle exemptions and the map re-classifies. That part of our tool appears novel (unconfirmed, since absence is hard to prove).

---

## A. Providence / Rhode Island

### A1. Coverage estimates for the 2026 ordinance (none published with a map)

| Source | Figure | Method / data | Map? |
|---|---|---|---|
| Tom Sgouros fiscal note to Council President Miller, 15 Feb 2026 — https://council.providenceri.gov/wp-content/uploads/2026/02/RSO-Fiscal-Note-1.pdf | ~80,000 rental units, **~48,000 controlled** (~60%) | 2025 property tax roll from data.providenceri.gov: ~44k properties, ~34k residential, "around 60%" rental or containing rentals. He says "about 40% of this value will qualify for one or another of the Act's exemptions", a value-based rule of thumb, not a parcel classification. He told the Globe the figure was "generously high". | No |
| CFO Larry Mancini, Council testimony, Feb 2026 (Boston Globe, 20 Feb 2026) — https://www.bostonglobe.com/2026/02/20/metro/rent-control-providence-city-council-stabilization/ | "**fewer than 44 percent** of apartments" | Method not described. A city spokesperson called it preliminary; it **excludes the 15-year new-construction exemption** because the city "has only three years of data" on new construction. The article notes **the city does not track rental units**. Council chief of staff June Rose said a "more precise calculation" was in progress. I found no follow-up. | No |
| City data cited in the Globe, 20 Jan 2026 — https://www.bostonglobe.com/2026/01/20/metro/providence-rent-control-stabilization | Owner-occupied exemption alone excludes **>16,000 units** (not counting the second "small landlord" building) | Department not named | No |
| Mayor Smiley's veto message, 17 Apr 2026 (Ocean State Media) — https://www.oceanstatemedia.org/housing/2026-04-17/rent-control-ordinance-vetoed-by-providence-mayor | "exempting **about half** of our rental units" | Rhetorical; no method | No |
| RIPEC "The High Cost of Rent Control in Providence", Jan 2026, commissioned by the Providence Foundation — https://www.rirealtors.org/clientuploads/documents/legislative/The%2BHigh%2BCost%2Bof%2BRent%2BControl%2Bin%2BProvidence%2BREVISED.pdfhigh_res.pdf | Unconfirmed: I could not extract its text, and press coverage cites no unit count from it | Policy argument (supply, condo conversion, tax shift) | Unconfirmed; none mentioned in coverage |

Status for context: the Council passed the ordinance 9–6 (April 16–17, 2026), Mayor Smiley vetoed it on April 17, and the override failed on May 15, 2026 (10 votes were needed). Rent stabilization became an issue in the 2026 mayoral race (Globe commentary, 20 Aug 2026). The March 12 amendments would have had the Rent Board director keep a "**limited registry of exempt units**". It never existed because of the veto, so there is no official exempt list to validate against.

### A2. Where I looked and found no coverage map

- **Council Housing Hub** (council.providenceri.gov/housinghub/rent-stabilization/). A Sucuri bot wall returned a 307, so I could not load the page directly, and the archive was unreachable. Search snippets show only text (cap, exemptions list, status). **Unconfirmed** that it has no map, but nothing in any coverage points to one.
- **Tenant groups.** DARE's Tenant & Homeowner Association (which drafted the original proposal), Reclaim RI, POWR and the Providence Tenants Union show campaign pages only.
- **RI Coalition of Housing Providers.** Its VoterVoice alert (https://www.votervoice.net/RICOHP/campaigns/133361/respond) summarizes exemptions. Notably it stresses that "Properties owned by LLCs, trusts, or other entities do not qualify for the owner-occupied or small landlord exemptions." It has no map or lookup.
- **Media and data sources.** HousingWorks RI, Brown (Daily Herald, TIP), RI Current, Boston Globe, Ocean State Media, WPRI, GoLocal and Steve Ahlquist all have articles or op-eds only, with no data visualizations of coverage.
- **Reddit r/providence.** Reddit blocked my JSON and HTML fetches, so this is **unchecked**.

### A3. Earlier Providence/RI rental maps (adjacent prior art)

- **RI Department of Health Rental Registry map (statewide, launched Feb 2025).** It offers address search plus a map. **Yellow dots = registered rentals; green dots = "suspected" rentals inferred from tax-assessor and other public data** (98,539 properties at launch). The RI Coalition of Housing Providers attacked the "suspected" label as "AI" labeling done without owners' consent, and objected to owner-occupied single-family homes and landlords' home addresses being shown. Within about a day some data was pulled; one report says 355 properties were removed. Sources: https://www.wpri.com/health/rhode-island-officially-launches-rental-registry-database/amp , https://www.oceanstatemedia.org/community/2025-02-18/rhode-islands-new-database-for-renters-raises-concerns-over-privacy-and-ai-generated-property-listings , RI Current "Landlord group blasts 'suspected rental properties' feature" (https://rhodeislandcurrent.com/?p=19678; it returned 403 to me, so I relied on the snippet). **This is the most important local lesson. The same constituency would push back on our "can't tell" and owner-occupancy inferences.**
- **Providence Preservation Society, "Most Endangered" 2025.** An interactive map of 260 parcels around Providence College owned by nine landlords/developers (owner, purchase date, assessment). It covers 02908 only. I could not find the map URL. Coverage: https://steveahlquist.substack.com/p/providence-preservation-society-identifies
- **Brown "The Information Project", *Mapping the Shape of the Housing Crisis*.** Zip-level eviction rates and municipal rent change. Static. https://sites.brown.edu/tip/?p=129
- **Eviction Lab, Providence tracking.** Tract choropleth of filings plus a "top 100 hotspots" layer. https://evictionlab.org/eviction-tracking/providence-ri
- **HousingWorks RI ward data sheets** (ACS 2012–16). Housing stock by structure type, tenure and cost burden per ward and tract. A ward framing the Council uses. https://stdidhousingworksriprod.blob.core.windows.net/housingworksri/documents/PVD_data-maps.pdf

---

## B. Other places: scan

| Place | Example | Unit | Coverage encoding | Lookup? |
|---|---|---|---|---|
| Jersey City NJ | Sarah Levine, "Mapping Rent Control in Jersey City, Part 1" (Sep 2025) | Parcel (+ OSM footprints) | Rule layers: property class 4C, redevelopment areas, exemption filings, public housing | Not yet (planned) |
| NYC | Chris Henrick, *Am I Rent Stabilized* (2015) | Tax lot | Orange = likely contains stabilized units (registered list + "likely unregistered" query) | Yes (address + borough) |
| NYC | BetaNYC *Tenants Map* | Building | **Solid outline = both sources agree; dashed = only one**; fill = 311 complaints | Filter by community district |
| NYC | JustFix *Who Owns What* | Building + owner portfolio | Portfolio map; stabilized-unit change over time on the building page | Yes |
| NYC | THE CITY, lost stabilized units (Feb 2023) | Unit / building | Buildings that stopped registering units 2019→2021 | Yes |
| San Francisco | Mission Local zoning × rent control (Oct 2025) | Parcel | Pre-1979, >1 unit, non-condo/TIC parcels shaded light gray | Unconfirmed |
| San Francisco | SF Standard "vibe-coded" map (27 Sep 2026) + Neil Rao's Rent Board map | Building dots | **Dot color by building size**: black 15+, dark blue 5–14, light blue 2–4 | Not stated |
| San Francisco | rentcontrolchecker.com (Gabrielle Lewis) | Parcel | Text result from assessor roll; lists exemptions it ignores | Yes (autocomplete) |
| Los Angeles | ZIMAS / LAHD RSO Property Search (official) | Parcel | RSO Yes/No (Yes = at least 1 unit covered); ZIMAS also shows Ellis Act and Just Cause | Yes |
| Los Angeles | City Controller RSO analysis | Council district | Counts (661,851 RSO units in 2024) | No (data page; 403 to me) |
| Washington DC | Urban Institute / NeighborhoodInfo DC rent control report (2011) | Property | "Potentially subject" database + static map + ward tables | No |
| Mountain View CA | Official CSFRA map, maps.mountainview.gov/RentStabilization | Property | **Fully covered** (pre-1995 multifamily) / **partially covered** (1995–2016/17, just-cause only) / not covered | Yes |
| Berkeley CA | Rent Registry public unit lookup | Unit | Fully vs partially covered (partial = no rent ceiling shown) | Yes |
| Oakland CA | Rent Registry lookup (rentregistry.oaklandca.gov) | Property | Registered / exempt claimed | Yes |
| Portland ME | Press Herald "Search Portland's rent control database by address" | Unit | Rent-change data from the city registry | Yes (live status unconfirmed) |
| Boston 2023 | City estimate 55–56% (~185k units); Contrarian Boston claimed higher coverage share in Back Bay/Beacon Hill than Roxbury/Mattapan | Citywide / neighborhood | No map found | — |
| Massachusetts 2026 ballot | ~70% statewide (proponents); removed from the ballot by the SJC on 23 Jun 2026 | Statewide | No map found | — |
| Montgomery Co. MD | County ORS: 65,669 of ~114k licensed units (57%) covered as of 31 Dec 2025; rolling 23-year exemption | County | No public lookup/map found | — |
| St. Paul MN | 2025 permanent exemption for post-2004 buildings; staff: ~95% of stock built before 2005 | Citywide | No exemption map found (city or press) | — |
| Washington state HB 1217 | 12-year new-construction exemption, owner-occupied ≤4 units | Statewide | No coverage map found | — |
| California (jurisdiction level) | Tenants Together + Anti-Eviction Mapping Project tenant-protections map; TechEquity/ACCE rent calculator | City | Which jurisdictions have which protections | Calculator |

---

## C. Deep dives (most relevant)

### 1. Jersey City: "Mapping Rent Control in Jersey City, Part 1" (Sarah Levine, 13 Sep 2025)
- **URL:** http://www.sarahmakesmaps.com/blog/mapping-rent-control
- **What:** a citywide audit of which buildings are legally rent controlled. **This is the methodological twin of ours.**
- **Unit:** parcel (Hudson County GIS, Aug 2025), shown on hand-edited OSM building footprints.
- **Rules:** controlled by default if 5+ units (property class 4C "Apartment" as proxy). Exempt if (built after 1987 AND exemption filing), OR public housing (JCHA), OR (redevelopment area AND built after plan adoption AND 25+ units).
- **Data:** county assessor (Mod-IV class, year built, owner); OPRA request for ~128 exemption filings since 1987; 104 redevelopment plan areas with adoption dates; JCHA site.
- **Uncertainty:** the handling is explicit and documented:
  - ~1,300 "nonsense" build years (0800, 0000) set to null
  - ~9.9k of 59.5k parcels missing a year
  - year-only precision against a June 1987 cutoff
  - spatial joins right only ~60% of the time, so the rest were checked by hand
  - named misclassifications (a residential tower coded vacant, another coded commercial)
  - she says outright that the assessor has **no reliable unit counts**
- **Lookup:** planned ("make it searchable"), not built.
- **Good:** shows its work, names failure cases, uses filings as ground truth where they exist. **Bad:** a blog walkthrough, not a finished product; it does not handle owner-occupancy (not needed under the Jersey City rules).

### 2. NYC: *Am I Rent Stabilized?* (Chris Henrick, Parsons MFA, 2015)
- **URLs:** amirentstabilized.com (live status unconfirmed); code at https://github.com/clhenrick/am-i-rent-stabilized; talk at https://clhenrick.github.io/presentations/am-i-rent-stabilized
- **Unit:** tax lot (MapPLUTO, joined by BBL).
- **Data:** DHCR registered-building list (obtained machine-readable by FOIL, after the city published it as a giant PDF), plus a "likely unregistered" MapPLUTO query: built before 1974, 6+ residential units, condos/co-ops excluded. Also John Krauss's 421-a data and Furman Center subsidy data. Totals: 47,150 registered and 12,549 likely-unregistered properties.
- **Encoding:** "if the lot appears orange on the map, it likely contains rent-stabilized units."
- **Lookup:** address + borough. It explicitly "can't tell you if your specific apartment is one of them," then walks you to the action: request your DHCR rent history, or file an overcharge complaint.
- **Good:** the result is framed as a *prompt for civic action*; it is in English, Spanish and Chinese; it is mobile-first; and it separates *registered* from *likely*. **Bad:** a single "likely" color merges two very different confidence levels, and the data froze in 2015.

### 3. NYC: BetaNYC *Tenants Map*
- **URLs:** https://www.beta.nyc/products/tenants-map/ ; https://github.com/BetaNYC/Tenants-Maps ; tenants.beta.nyc (live status unconfirmed)
- **Unit:** building, Manhattan.
- **Data:** Rent Guidelines Board building lists (scraped from PDFs) and John Krauss's tax-bill scrape (stabilized units per building per year, 2007–2016), plus owner and 311 complaints.
- **Encoding:** **solid black outline = both sources say the building has stabilized units; dashed = only one does ("data … is inconsistent").** Fill color = housing 311 complaints. Click a building for details.
- **Good:** the cleanest example found of putting **source agreement / confidence into a separate visual channel** (outline style) from the main variable (fill). **Bad:** Manhattan only, stale, and there is no address search, only a community-district filter.

### 4. NYC: JustFix *Who Owns What* + THE CITY "lost stabilized units"
- **URLs:** https://whoownswhat.justfix.org ; https://www.thecityreporter.nyc/2023/02/15/rent-stabilized-apartments-disappearing/
- **WOW:** address-first. It builds a landlord portfolio by matching names and addresses across HPD registrations (200k+ buildings), maps the other buildings that owner may control, and shows violations, evictions and the change in rent-regulated unit counts. Portfolios are explicitly *inferred*.
- **THE CITY:** address-searchable map of every unit registered as stabilized in 2019 but no longer. It used JustFix's tax-bill records (44,470 buildings). Caveats are spelled out: registration lag, so a drop is not proof of deregulation; ask HCR for your rent history; email us if your listing is wrong.
- **Good:** treats the **building page as the product** (one address → everything known), and gives a feedback channel for errors. **Bad (for us):** WOW's ownership matching is the kind of individual-landlord exposure our payload deliberately avoids.

### 5. San Francisco: Mission Local (Oct 2025) and SF Standard (Sep 2026)
- **Mission Local:**
  - **URL:** https://missionlocal.org/2025/10/rent-control-exempted-sf-upzoning/ (and the companion "Explore" map piece)
  - **What it shows:** a parcel-level map of how a rent-control carve-out changes an upzoning plan. "Rent-control eligible" means built before 1979, more than one unit, selected class codes, condos/TICs excluded. These parcels are shaded light gray.
  - **Data:** Planning zoning files plus Assessor-Recorder roll. 0.37% of rows were unmatched (reported).
  - **Caveat:** "does not necessarily mean those parcels are currently tenant occupied". The 84,000-unit figure is stated as "at least".
- **SF Standard:**
  - **URL:** https://sfstandard.com/2026/09/27/san-francisco-rent-control-vibecoded-map/
  - **Rao's map:** a 17-year-old (Neil Rao) mapped ~463k Rent Board records (complaints, landlord disclosures, move-out notices), geocoded with Claude, to find "no Rent Board activity" areas.
  - **The Standard's map:** it then "vibe-coded" a map of ~174k pre-1979 units as **building dots colored by size class** (black 15+, dark blue 5–14, light blue 2–4).
  - **Caveat:** the city "does not have an official map of rent-controlled homes", and the pre-1979 filter overestimates coverage.
- **Good:** honest "eligible ≠ occupied/covered" framing, and size-aware dots that stop a triple-decker looking as important as a 200-unit building. **Bad:** neither documents a per-parcel "why" or offers an obvious lookup.
- **Related:** https://rentcontrolchecker.com, an SF address checker built on the assessor's historical secured roll. Good practice: it **lists the exemptions it does *not* model** (post-1996 conversions, substantial rehab, government-financed, Costa-Hawkins) and says it is not an official determination.

### 6. Los Angeles: ZIMAS / LAHD RSO lookup (official)
- **URLs:** https://housing.lacity.gov/rental-property-owners/rso-property-search (403 to me) ; zimas.lacity.org
- **Unit:** parcel.
- **Encoding:** a single **RSO Yes/No** field under "Housing". "Yes" means *at least one* unit is covered, shown next to Ellis Act and Just Cause status.
- **Data:** LAHD inventory, updated annually. The City Controller reports 661,851 RSO units (2024) by council district.
- **Good:** authoritative, and puts the coverage flag where people already look up parcels. **Bad:** binary at parcel level hides partial coverage. Law firms note a "No" can still be covered (e.g., unpermitted units), so even official binaries carry caveats.

### 7. Washington DC: *A Rent Control Report for the District of Columbia* (Urban Institute / NeighborhoodInfo DC, Tatian & Williams, June 2011)
- **URL:** copy filed as a Zoning Commission exhibit: https://app.dcoz.dc.gov/Exhibits/2010/ZC/19-10/Exhibit262.pdf
- **What:** a database of 9,352 rental properties with a flag per exclusion/exemption, giving "**4,818 properties with 79,145 housing units potentially subject**". It adds ward tables and a static citywide map (Appendix B).
- **Data:**
  - OTR real property + CAMA files (use, year built, owner)
  - Master Address Repository, with **unit counts derived by counting apartment addresses per parcel**
  - DC Preservation Catalog for subsidized properties
  - NeighborhoodInfo DC owner classification, used to deny the small-landlord exemption to non-natural-person owners and to measure owner portfolio size
- **Uncertainty:** insists on the qualifier "potentially subject" because "it is not possible to construct a definitive list … from current electronic records alone". Exemption *claims* (which must be filed) and permit dates weren't available, and it recommends a manual paper-records review.
- **Good:** the closest analogue to Providence's rules (small-landlord portfolio test, natural persons only, subsidized carve-out). Its address-count method for unit counts is reusable if Providence/E-911 address points exist. **Bad:** static PDF, no lookup.

### 8. Mountain View CA: official CSFRA coverage map
- **URL:** maps.mountainview.gov/RentStabilization (403 to me; content from city flyers and FAQs). Also mvrent.mountainview.gov.
- **Encoding:** three tiers: **fully covered** (multifamily, 3+ units, built before 1995: cap plus just-cause), **partially covered** (1995–2016/17: just-cause only), not covered (including government-subsidized).
- **Good:** a tiered vocabulary when different protections attach to different stock, plus an official address search. Berkeley's registry uses the same fully/partially covered split (https://rentboard.berkeleyca.gov/services/unit-information-lookup). **Bad:** city documents disagree on the cutoff date, which shows how brittle date thresholds are in public materials.

---

## D. Design lessons for a building-level coverage map

1. **Say "would likely be covered", never "is covered".** DC/Urban ("potentially subject"), Henrick ("likely"), Mission Local ("eligible ≠ tenant-occupied") and rentcontrolchecker ("not an official determination") all frame results as eligibility. Unit status depends on facts not in public data (owner residence, exemption filings, subsidy contracts).
2. **Put confidence in its own visual channel, separate from the category.** BetaNYC: solid vs dashed outline for source agreement. Henrick: registered vs likely. RI DOH: registered vs suspected. Keep "can't tell" as a visible class, not folded into "not covered".
3. **Address lookup first, map second, and every answer comes with its reasons and a next step.** Every tenant-facing tool (Henrick, ZIMAS/LAHD, Berkeley, Mountain View, rentcontrolchecker, THE CITY) leads with search. The best ones end with what to do next (request rent history, contact the board, report an error).
4. **List what you don't model, and show your nulls.** rentcontrolchecker names the exemptions it ignores. Jersey City reports 1,300 nonsense years nulled, 9.9k missing, and a 60% join accuracy. Mission Local reports 0.37% unmatched. This builds trust and pre-empts "your map is wrong" attacks.
5. **Weight by units, not parcels.** SF Standard colors dots by building size. Parcel fills overweight 1–3-unit lots, and ~54% of Providence housing units are in 2–4-unit or 1-family-attached structures (38,150 of 70,766; HousingWorks RI ward sheet, ACS 2012–16). Headline numbers should be unit-weighted, and should sit next to the official estimates (fiscal note ~60%, CFO <44%, veto "about half").
6. **Expect the RI DOH backlash.** Labeling homes "suspected rental" from assessor data, and showing owners' home addresses, drew organized landlord pushback and takedowns within a day in this exact state. Keep individuals' names and other-home addresses out (already done). Word owner-occupancy inferences carefully ("records suggest the owner lives here").
7. **Tiered vocabulary when rules differ by stock.** Mountain View/Berkeley "fully/partially covered" is a clean way to show "cap applies" vs "new-construction exempt until YEAR" vs "owner-occupied exempt".
8. **Show time-based exemptions.** Montgomery County (23-year), AB 1482 (15-year) and Providence (15 years from first occupancy) all roll, so a lookup can say "would enter coverage in 2031". Jersey City shows year precision matters at the cutoff.
9. **Offer a feedback path for corrections** (THE CITY's tips email, RI DOH's "email us if missing"). It doubles as ground truth.
10. **Multilingual.** Henrick shipped EN/ES/ZH. Providence is ~42% Hispanic (ACS, per HousingWorks RI), so a Spanish lookup is high-value.

## E. Most relevant examples (ranked)

1. Jersey City audit (Sarah Levine, 2025): http://www.sarahmakesmaps.com/blog/mapping-rent-control
2. Am I Rent Stabilized (NYC, Henrick): https://github.com/clhenrick/am-i-rent-stabilized / amirentstabilized.com
3. Urban Institute DC rent control database (2011): https://app.dcoz.dc.gov/Exhibits/2010/ZC/19-10/Exhibit262.pdf
4. Mission Local SF parcel map (2025): https://missionlocal.org/2025/10/rent-control-exempted-sf-upzoning/ and SF Standard (2026): https://sfstandard.com/2026/09/27/san-francisco-rent-control-vibecoded-map/
5. BetaNYC Tenants Map (solid/dashed confidence encoding): https://github.com/BetaNYC/Tenants-Maps
6. RI DOH Rental Registry map (local cautionary tale): https://www.oceanstatemedia.org/community/2025-02-18/rhode-islands-new-database-for-renters-raises-concerns-over-privacy-and-ai-generated-property-listings
7. LA ZIMAS / LAHD RSO lookup (official parcel flag): https://housing.lacity.gov/rental-property-owners/rso-property-search
8. Mountain View CSFRA map (tiered coverage): maps.mountainview.gov/RentStabilization
