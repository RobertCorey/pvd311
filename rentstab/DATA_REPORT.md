# Data report: can public data tell coverage?

Short answer: **yes for most small buildings, no for most big ones.** Two public city datasets joined on plat-lot-unit cover 99% of parcels. Together they hold the three inputs the ordinance turns on:

- an explicit owner-occupancy flag
- a real unit count
- year built

The gaps are in the large, odd buildings, where the city's records were never meant to answer "is this an apartment?": hotels, mill conversions, senior living, and big projects under tax-stabilization agreements.

All numbers below come from `npm run rebuild`, fetched 2026-10-30. `node scripts/profile.ts` prints every table in full.

## The four questions

| Question | Answer |
|---|---|
| **Owner-occupancy signal?** | **Yes, explicit.** The FY2026 tax roll's `LEVY_CODE_1` puts every 1-family, 2–5 family, condo and ≤5-unit mixed-use parcel on either the owner-occupied rate (`OO01`, `OO2-5`) or the non-owner rate (`NO01`, `NOO2-5`). Coverage is 100% of those classes; mixed-use parcels carry it on `LEVY_CODE_2`. The OO rate is about half the non-owner rate (≈ $7.5–8.4 vs ≈ $14.0–14.6 per $1,000 of assessed value, computed from `TOTAL_TAXES`/`TOTAL_ASSMT`). The assessor grants it only to a deeded owner who lives there, through an "Owner Occupied Certification" (assessor FAQ). It is **high-precision, lower-recall**: see §2. |
| **Unit count?** | **Yes.** The roll's own class only says "2-5 Family" (14,204 parcels), which is useless for a 1–4-unit test. The city GIS layer *Parcels_with_CAMA* carries the assessor's `NumUnits`: filled for 97.6% of residential parcels, with 7,509 two-family, 5,599 three-family, 523 four-family and 115 five-family buildings. On commercial and tax-exempt parcels `NumUnits` is unreliable: it counts hotel rooms and storefronts, and it reads 0 on most public-housing high-rises. |
| **Year built?** | **Yes**, `YearBuilt` in the same layer, 97.7% filled for residential. Pre-1950 values are rounded to decades (1930: 5,642 parcels; 1900: 3,726). Recent years look exact: 2016–2023 has 588 residential parcels with 1,135 units. Three limits: no certificate-of-occupancy dates anywhere public; the 2024 extract has no 2024–26 buildings; and mill conversions keep the original mill's year. |
| **Condos?** | **One parcel per unit.** Class 23 has 3,920 parcels, each with its own owner, OO/NOO levy code and `NumUnits = 1`. The building is the plat-lot: 649 of them, of which 413 are 2–3-unit condo conversions holding 975 units. Deeded parking, storage and garage spaces are also class-23 parcels (unit IDs with P/S/G, ~205). The classifier drops them. |

**Stop condition not triggered:** there is a usable owner-occupancy signal, so the classifier was built.

## 1. Sources

| Source | What it gives | Rows | Vintage |
|---|---|---:|---|
| [2026 Property Tax Roll](https://data.providenceri.gov/d/p9dd-mw2m) (Socrata `p9dd-mw2m`) | class, levy codes (owner-occupancy), owner, mailing address, assessment, exemptions, point, neighborhood | 44,090 | assessment date 12/31/2024, billed FY2026 (updated 2026-10-20) |
| [Parcels_with_CAMA](https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services/Parcels_with_CAMA/FeatureServer/0) (city ArcGIS) | assessor CAMA: `NumUnits`, `YearBuilt`, `MuniUseCode`, beds/baths, last sale | 44,161 (43,678 distinct parcels; duplicates are multipart polygons with identical attributes) | `TaxRollYear` 2024; layer edited 2025-05-30; latest sale 2025-05-19 |
| [2025 Property Tax Roll](https://data.providenceri.gov/d/6ub4-iebe) | prior-year levy code, only to measure churn | 44,372 | assessment 12/31/2023 |
| [Providence neighborhoods](https://data.providenceri.gov/d/ueqj-g33x) | names for the roll's computed region column | 25 | – |
| [Providence_Housing_Authority](https://services6.arcgis.com/wv9mHoqblhTsnqdG/arcgis/rest/services/Providence_Housing_Authority/FeatureServer/0) | PHA scattered-site addresses (not the high-rises) | 421 (933 units) | edited 2024-02 |
| HUD eGIS [LIHTC](https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/LIHTC/FeatureServer/0), [Multifamily Assisted](https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/MULTIFAMILY_PROPERTIES_ASSISTED/FeatureServer/0), [Public Housing Buildings](https://services.arcgis.com/VTyQ9soqVukalItT/arcgis/rest/services/Public_Housing_Buildings/FeatureServer/0) | regulated-affordable projects with unit counts | 78 / 49 / 255 | current HUD extracts |

**Join:** roll `TAX_MAP` = CAMA `PROPID` ("016-0194-0000"). It matches 43,590 of 44,090 parcels (98.9%), and 99.3% of residential classes. `P_ID` ≠ `AV_PID`: different ID systems, never equal on the same parcel.

**Checked and not usable:**
- the 2013 Residential Assessment (stale)
- PVD_Parcels 2017 (no CAMA fields)
- the Property ID Catalog (2020, no units)
- DIS permits 2009–2018 (ends 2018)
- the ArcGIS overlay-zoning layers: no College Student Residential Overlay District exists in them
- NEREVAL, the assessor's property-card site: it returns 403 to this server, so property cards weren't reachable for spot checks
- Census API (needs a key now). ACS figures came from Census Reporter instead.

## 2. Owner-occupancy: how good is the flag?

Mailing address, owner type and last-year's flag were cross-checked against the OO rate (classes 1, 2, 23):

| | OO rate | of which mail = property | NOO rate | of which mail = property |
|---|---:|---:|---:|---:|
| Single family | 10,995 | 10,529 (96%) | 3,721 | 2,482 (67%) |
| 2–5 family | 7,284 | 6,415 (88%) | 6,920 | 2,601 (38%) |
| Condo | 2,058 | 1,663 (81%) | 1,862 | 853 (46%) |

- **Precision looks high.** 88–96% of OO parcels mail tax bills to the property itself. Many of the rest are trusts, PO boxes or address aliases. Only 119 entity-owned parcels carry the OO rate.
- **Recall is the weak side.** About 5,700 single-family, 2–5 family and condo parcels owned by people or trusts are on the *non-owner* rate yet have their tax bill mailed to the property. 3,379 of the house and 2–5 family ones were bought before 2024, so a lag after a sale explains only part of it. The likely causes are owners who never filed the certification, or lost it at recertification (the city ran a homestead recertification around 2020). If all of them really live there, the flag misses ~18% of owner-occupied single-families and ~25% of owner-occupied 2–5 families. The classifier sends these to `cant_tell`. It is the largest can't-tell bucket: 5,609 parcels, 3,600–9,200 rental units.
- **Churn:** 1,964 of 32,735 parcels (6%) changed flag between the FY2025 and FY2026 rolls (1,076 NOO→OO, 888 OO→NOO). Expect the flag to be about one year stale on ~6% of parcels.
- **The ordinance's test is different.** The ordinance asks about *principal residence*: 185+ days a year, shown by voter registration, tax filing address or "other reliable indicia" (Sec. 13-69). The OO tax rate is good evidence of that, but it is not the legal test.

## 3. Unit count

| 2–5 Family (roll class 2) | parcels | OO rate | NOO rate |
|---|---:|---:|---:|
| 2 units | 7,509 | 4,470 | 3,039 |
| 3 units | 5,599 | 2,519 | 3,080 |
| 4 units | 523 | 157 | 366 |
| 5 units | 115 | 19 | 96 |
| 1 or 6 units (odd) | 177 | 74 | 103 |
| missing / 0 | 281 | 45 | 236 |

- Single family: 14,582 have 1 unit, 23 have 2–3, 111 are missing (treated as 1).
- Apartments 6–10 (375 parcels, 2,270 units) and 11+ (138 parcels, 3,022 units) are reliable.
- **The CAMA counts are legal units.** Unpermitted basement and attic units are not counted, and the ordinance covers units "whether or not … lawfully registered or licensed".
- **On commercial classes `NumUnits` means something else.**
  - Of 765 Commercial II parcels with 1–3 "units", 747 have no bedrooms. These are storefronts, and the classifier treats them as non-residential when beds = baths = 0.
  - The big commercial and TSA "units" are hotel rooms (1 Orms St 350, Omni 364, Biltmore 292), senior living, or apartments, and the data can't separate them.
- **Tax-exempt parcels** (municipal, state, PHA high-rises) mostly show 0 units. Housing-authority-owned parcels sum to ~330 units on record against the PHA's 2,603.
- **Total on record:** 70,833 dwelling units, against 79,423 ± 1,256 housing units in ACS 2020–24. The ~8,600-unit gap is mostly big exempt and commercial buildings recorded with 0 units, plus unpermitted units. Some of it runs the other way: dorm rooms count in CAMA but not in the ACS.

## 4. Year built and new construction

- 97.7% filled for residential parcels. Missing values are mostly condo parcels without a CAMA record.
- **No certificate-of-occupancy date exists in any public dataset.** The exemption runs from the CO date (Sec. 13-78(m)). The classifier uses year built as a stand-in, and the look-back's boundary year → `cant_tell`.
- **The 2024 CAMA extract can't see the buildings that matter most.** If a re-passed ordinance takes effect in 2027, everything with a CO from ~2022 on is exempt. That includes 2024–26 completions, which still look like vacant land or old buildings in this data.
- **Adaptive reuse** (mills to lofts) is "new construction" under the text, but CAMA keeps the mill's year: 765 Branch Ave reads 1900 with 228 units; Rising Sun Mills reads 1890. Old apartment-class results carry a caveat.

## 5. Regulated affordable housing

| Signal | Parcels | Units on record | Notes |
|---|---:|---:|---|
| Levy `8LAW` (R.I.G.L. § 44-5-13.11 low-income housing assessment; all 647 "Miscellaneous" class parcels) | 647 | 2,288 | requires a recorded affordability restriction, so a strong match to Sec. 13-78(i) |
| HUD LIHTC, address match | 45 projects matched + 23 by proximity | – | projects with some unrestricted units → `lihtc_partial` → can't tell |
| HUD project-based multifamily | 31 + 10 | – | Sec. 13-78(j) |
| HUD public housing buildings | 91 + 25 | – | 139 didn't match a parcel point; PHA-owned parcels are caught by owner name anyway |
| Housing-authority owner (name) | ~140 | ~330 | |

The exemption applies **per unit**, so a market-rate unit in a mixed-income building is covered. Housing Choice Voucher tenants in private buildings are covered too, which reverses the January draft. Neither of these can be seen in parcel data.

## 6. Other exemptions vs. data

| Ordinance exemption | Data signal | Quality |
|---|---|---|
| (a) institutions: dorms, nursing, religious | tax class School / Hospital / Charitable / Church | Class tells you who owns it, not whether residence is "incidental to" the service. School and charitable → can't tell. |
| (d) hotels / lodging | none: no hotel class | Owner name only ("… Hotel LLC") catches 14. Big hotels named "… Owner LLC" are missed and fall to can't tell. Short-term rentals: no public registry. |
| (f) cooperatives | owner name only | 4 found. Laurelmead, a known co-op, is not caught by name. |
| (b)(c)(e)(g)(h)(k)(l) | none | listed as not evaluable; surfaced as a caveat on every "likely covered" result |
| (n) one additional property | normalized owner name + owner mailing address | Low confidence. 519 name keys cover 2+ owner-occupied parcels, i.e. different people share the name, so names are ignored for those. A match is never "exempt", because the owner must also claim it with documents. |

## 7. External benchmarks

- **ACS 2020–24 5-year** (Providence city, via Census Reporter): 79,423 housing units; 41,896 renter-occupied (±1,394); 2,746 vacant for rent plus 690 rented-not-occupied. That makes ≈ 45,300 rental units.
- **This run's rental-unit estimate:** 42,600–48,200. These are dwelling units minus the owner's own unit where the OO rate is on file, and the range spans the "owner may live here" uncertainty. **It lands right on the Census figure,** the best evidence that the unit counts and the OO flag are usable.
- **The fiscal note's "80,000 rental units"** equals the city's *total* housing stock (79,423), not its rental stock. See `CITYWIDE.md`.

## 8. Field reference (residential classes, n = 34,161)

| Field (normalized) | Source column | Fill | Example values | Used for |
|---|---|---:|---|---|
| `taxClass` / `taxClassDesc` | roll `CLASS`, `CLASS_DESCRIP` | 100% | `2` "2-5 Family", `23` "Residential Condo", `03-11+` "apt 11+ units" | building type, institution/commercial routing |
| `levyCode`, `levyCode2` | roll `LEVY_CODE_1/2` | 100% | `OO2-5`, `NOO2-5`, `OO01`, `NO01`, `8LAW`, `TSA`, `C11` | owner-occupancy, affordability, TSA |
| `ownerOccupiedTaxRate` | derived from levy | 96.1% (the rest are 6+ unit classes with no OO split) | true / false | Sec. 13-78(n) |
| `owner`, `ownerKind`, `ownerKey` | roll `OWNER` | 100% | "Rachel Barrett" person; "Stephen Lederer Trustee" trust; "02908 Holdco LLC" entity | entity exclusion; additional property |
| `mailingStreet/City`, `mailingIsProperty` | roll `MAILING_2..5` | 100% / 97.6% computable | "135 Brook St / Providence, RI 02906" | owner-may-live-here; owner's home parcel |
| `units` | CAMA `NumUnits` | 97.6% | 1–6 for houses; 192 for 123 Regency Plaza | 1–4 unit test |
| `yearBuilt` | CAMA `YearBuilt` | 97.7% | 1930, 1900, 2021 | new construction |
| `bedrooms` / `bathrooms` | CAMA | ~98% | 0/0 on storefronts | commercial "units" vs dwellings |
| `lastSaleDate` | CAMA `SaleDate` | 86.3% | 2024-01-11 | staleness caveat |
| `neighborhood` | roll computed region → `ueqj-g33x` | 99.6% | "Elmhurst" | reporting |
| `condoBuildingUnits` | derived (condos per plat-lot) | condos only | 2, 3, 120 | reporting |
| `affordableSignals` | `8LAW` levy + HUD/PHA matches + owner name | 1.7% of parcels | `8law`, `lihtc`, `hud_assisted_nearby` | Sec. 13-78(i)(j) |
