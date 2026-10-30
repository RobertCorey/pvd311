# Summary: slice 1 (data + rules spike)

**Question:** can public data tell us, for most Providence rental parcels, whether they'd be covered by the April 2026 rent stabilization ordinance, and how confidently?

**Answer:**
- **For about two-thirds of rental parcels and rental units, yes, with a confident answer and a stated reason.** The remaining third is honestly "can't tell", for reasons that are mostly fixable.
- The data is good enough to keep going: the city publishes an explicit owner-occupancy tax flag, the assessor's real unit counts, and year built, all joinable for 99% of parcels.
- The rental-unit total built from those records (42.6k–48.2k) matches the Census (45.3k).

## Findings

1. **The final text differs from the starting assumptions.** Passed April 16, 2026; vetoed April 17; veto sustained May 15.
   - The owner-occupied exemption is **1–4 units**, not 1–3, and an extra ADU is allowed.
   - The additional property can also have up to 4 units, and **trusts are no longer excluded**.
   - New construction is exempt **10 years from the certificate of occupancy**, or 20 with prevailing wage plus 10% apprentice hours.
   - The "5-year delay" is really a **5-year look-back**: buildings whose CO is up to 5 years old at the effective date get the rest of their exemption, and older ones are covered immediately.
   - **Voucher tenants in private buildings are covered**, which reverses the January draft.
   - There's no student-housing exemption; dorms get in only as "institutions".
   - Most press coverage describes the January draft.
2. **Citywide (the final run):**

   | | rental units | parcels |
   |---|---:|---:|
   | likely covered | 19,233 | 6,836 |
   | likely exempt | 13,051 | 8,112 |
   | can't tell | 10,338–15,947 | 7,675 |

   So **40–73% of rental units would be covered**: 19k if every can't-tell is exempt, 35k if every one is covered.
3. **The fiscal note's 48,000 of 80,000 doesn't hold up.**
   - 80,000 is Providence's *total* housing stock (ACS: 79,423 ± 1,256), not its rental stock (≈ 45,300 including vacant-for-rent).
   - 48,000 is just 60% of that figure, from an assumed 40%-exempt-by-value. The note also pre-dates the amendments; the memo's own author reportedly called it "generously high".
   - Even if every can't-tell unit is covered, this run tops out at ~35,000, about 13,000 below the note. **The gap is the denominator, not the classifier.**
4. **Owner-occupancy is the swing factor.**
   - The tax flag is precise: 88–96% of flagged owners get their tax bill at the property.
   - It misses many owner-occupants, though. About 5,600 small buildings have an owner who apparently lives there without the owner-occupied rate.
   - Those parcels alone move 3,600 rental units between covered and exempt.
5. **Big buildings are where the data runs out.** 79 large commercial or tax-stabilization parcels hold ~4,000 units, and the records can't separate hotel, senior living, apartment or mill conversion. Neither can owner names. 1 Orms St (350 "units") is the Marriott; the data can't say so.

## What's reliable

- **Owner-occupied 2–4 unit buildings on the OO rate → likely exempt** (7,183 parcels). These rest on two independent records, the tax flag and the mailing address, and agreed in every spot check.
- **Non-owner-occupied, entity-owned 1–4 unit buildings and 6+ unit apartment buildings → likely covered.** The text leaves little room for doubt here (exemptions "construed narrowly"), and the unit counts are solid.
- **8LAW / LIHTC / HUD-listed affordable housing → likely exempt** (794 parcels). The match is per parcel, though the exemption is per unit.
- **Unit counts and year built for ordinary residential parcels.** The rental-unit total matches the Census.
- **The rules file.** Every rule cites the final text. A different ordinance is a YAML edit: the sensitivity table re-runs the January 1–3 limit, effective dates and alternative readings without code changes.

## What isn't

- **"Owner may live here" (5,609 parcels).** We can't tell whether an owner who receives tax mail at the property lives there.
- **One-additional-property (597 parcels).** This rests on name and address matching, and the exemption has to be claimed with documents anyway. It is never shown as "exempt".
- **New construction.** There are no CO dates, and the assessor extract (2024) can't see 2024–26 buildings, which are exactly the ones a 2027 ordinance would exempt. Mill conversions keep their 1890 year built.
- **Large commercial/TSA buildings, dorms and senior housing**, as above.
- **Per-unit exemptions inside buildings:** mixed-income, vouchers, short-term rentals, employee units. Parcel data can't see these.
- **Condos and trusts** depend on unresolved readings (OPEN_QUESTIONS #2, #3).
- Spot checks: 16/20 agree, 3 agree with a caveat, and 1 is likely wrong in the safe direction (an address alias made "can't tell" read as "covered"). None was wrongly "exempt".

## What slice 2 should be

Ranked by units turned from can't-tell into a confident answer per hour of work:

1. **Label the ~80 big commercial/TSA buildings by hand** (hotel, senior, apartments, conversion + CO year). About an afternoon, and ~4,000 units become confident. Do the 704 institution parcels the same way, which mostly means confirming dorms.
2. **Certificate-of-occupancy dates.** Check the city's ArcGIS `DIS_Active_Permit_VIew` / permit layers, or ask Inspections & Standards for COs since 2019. This fixes new construction properly, including 2024–26 buildings and mill conversions.
3. **Ask the assessor one question:** how many owner-occupants lack the OO rate, and can certification status be shared? Separately, check whether RI permits using voter-registration addresses (the ordinance's own "principal residence" evidence) to resolve "owner may live here" parcels. This is the biggest swing bucket.
4. **Small fixes:** condo unit-number matching for address aliases (OPEN_QUESTIONS #16); get a legal read on condos and trusts (#2, #3) before any public page says "exempt" for them.
5. **Only then the product questions:** whether the lookup shows unit-level nuance ("some units here are exempt"), and how a "this seems wrong" note feeds back.

Out of scope and untouched, as briefed: email capture, deployment, correction flows, styling, FixMyPVD integration, rent data.
