# Status: shelved 2026-11-10

Every records request is answered and loaded. Nothing is open and nothing is scheduled. The map runs on the dev box only (`npm run serve`, port 4173); it isn't published.

## Where it ended

73,679 homes in Providence, by what the April 2026 ordinance would do (assumed effective date 2027-04-15):

| | homes | before the last two loads |
|---|---:|---:|
| Rent-stabilized | 19,426 | 19,517 |
| Exempt, market rate | 15,658 | 12,056 |
| Exempt, subsidized | 7,219 | 7,140 |
| Owner lives there | 26,003 | 20,353 |
| Can't tell | 5,373 | 14,609 |

Full tables: [CITYWIDE.md](CITYWIDE.md). Rules: `rules/ordinance-2026-04.yaml`.

## The last decision: "owner may live here"

About 5,600 one-to-four-home lots (about 9,150 homes) were not on the owner-occupied tax rate although the owner's tax bill goes to the property. They were the biggest can't-tell group. Records request #26-3023 settled it this way:

- **The city approved an owner-occupied application since January 2025** (617 lots, 993 homes, not yet on the rate): counted as owner-occupied, same as the tax rate.
- **The city denied one** (78 lots, 126 homes; 64 of them had been "owner may live here"): not treated as owner-occupied; they count as rent-stabilized, with the denial noted.
- **Still open with the city** (40 lots) and **no application on file** (4,976 lots, 8,213 homes): "probably exempt, if the owner actually lives here". One home counted as the owner's, the rest as exempt market-rate.

Why "probably" and not "can't tell":

- Owners in this position who applied were approved 486 times out of 550 decided (88%).
- In December 2020 the city made every owner re-apply. Approved lots went from 21,008 (2020) to 18,353 (2021) and were back to only 20,774 by 2024, so about 2,655 owners dropped off at once and most never re-applied.
- The Census counts about 9,200 more owner-occupied homes than the tax rate shows.

The other reading is one switch away: in CITYWIDE.md's sensitivity table, treating these lots as covered moves 3,266 rental homes from exempt to rent-stabilized (19,426 → 22,692).

## Known gaps, not fixed

- **Can't tell, 5,373 homes:** 17 large buildings researched by hand without an answer (1,546), owner's-one-extra-property matches (1,176), new construction dated only by permit (774), institutions (712), tax-stabilization or mixed commercial lots (679), small remainders (486).
- **Public housing is undercounted.** The 148 Housing Authority lots count 341 homes; the state list shows about 2,606. This lowers "subsidized" and the citywide total, not the rent-stabilized count.
- **10 properties (1,033 homes) on the state's affordable-housing list match no lot** (Hartford Park and its tower, Summer Street, Cathedral Square I, The Composition and five smaller ones). The list's 1,904 federal vouchers are not tied to addresses and are not used.
- **The tax roll's owner-occupied codes are current to about May or June 2026**, not 12/31/2024 as some notes here say: approved applications filed through May 2026 are already at the rate on the roll.
- **13 lots whose affordability period has ended** are marked but still counted as before.
- The parcel card wording for these lots ("Likely exempt · the owner probably lives here") is built but not looked at: the report panel is switched off in `tool/main.ts` (`REPORT_PANEL`).

## Dropped at wrap-up

Certificate-of-occupancy dates (the city's export has none), the 100-lot random check, tax-stabilization agreement dates, an appeal of #26-3024 (no landlord declarations exist), any appeal of #26-3023, and requests #3, #4 and #6 in [REQUESTS.md](REQUESTS.md) (never sent).

## To pick it up again

`npm run build-db` (about 5 minutes) → `npm run derive` → `npm run citywide` → `npm run build-tool` → `npm run serve`. The records releases live in `manual/` as reduced files with no owner or applicant names; the originals are not in the repo and the city's download links expire 2026-12-09 and 2026-12-10.
