# Spot checks

I hand-checked 20 parcels, drawn by `node scripts/spot-checks.ts` with seed 311 and stratified by status: 6 covered, 5 exempt, 6 can't-tell, 3 not-a-rental. Each one was checked against:

- the raw FY2026 roll row
- the raw assessor CAMA row
- the FY2025 roll (has the owner-occupancy flag changed?)
- the owner's other parcels and the affordable-housing lists
- the ordinance text

The assessor's property-card site (NEREVAL) blocks this server, so nothing was checked on the ground. The question for each parcel is **"does the result follow from the best public records, and are those records plausible?"**, not "is this unit really rented today?".

Four earlier draws (see "Bugs the spot checks found") turned up four classifier bugs. All four were fixed before this final sample was drawn.

**Verdicts:**
- ✅ **agree:** the result follows from the records and nothing contradicts it.
- ⚠️ **agree, with caveat:** right given the data, but the data has a known weakness here.
- ❌ **disagree.**

## Final sample (seed 311)

| # | Parcel · address | Key records | Result | Verdict |
|---|---|---|---|---|
| 1 | 113-0341-0000 · 481 Hartford Ave (Hartford) | 2–5 fam, NOO both years, A & F Properties LLC, mails to 600 Plainfield St; 3 units, 1930 | likely_covered — entity-owned 3-family | ✅ LLC can't use the additional-property exemption; not owner-lived |
| 2 | 070-0500-0000 · 44 Pumgansett St (Wanskuck) | NOO, Marsocci Ventures LLC (Johnston), 20+ Providence parcels under that name; 2 units, built 2005 | likely_covered | ✅ 2005 is long before the 5-year look-back; a portfolio landlord |
| 3 | 114-0273-0000 · 617 Hartford Ave (Hartford) | NOO, United Homes LLC, PO box; 3 units, 1925 | likely_covered | ✅ |
| 4 | 026-0367-0211 · 1000 Providence Pl (Downtown) | condo, NOO both years, person; mails to "903 Providence Pl **Unit 211**"; built 2003 | likely_covered — "owner mails elsewhere" | ⚠️ **Probably wrong.** 903 is the same complex's other street number and the unit number matches, so the owner likely lives here without the OO rate. Should be `cant_tell`. Address-alias gap (OPEN_QUESTIONS #16). |
| 5 | 077-0659-0000 · 15 Enterprise St (Charles) | single family, NOO both years, owner mails from North Providence; built 1991 | likely_covered (only if actually rented) | ✅ An out-of-town owner can't claim (n). The note covers "might be a family member's home". |
| 6 | 013-0180-0025 · 157 Waterman St Unit 2-5 (College Hill) | condo, NOO, owner in Narragansett; roll owner ≠ 2024 CAMA owner (sold 2021) | likely_covered | ✅ The roll is newer than CAMA; the owner lives outside Providence |
| 7 | 065-0288-0000 · 980 Chalkstone Ave (Elmhurst) | 2–5 fam **OO** in FY2026, NOO in FY2025; sold 2024-01-11; mail = property; 2 units | likely_exempt | ✅ The new owner applied for the OO rate after buying, which shows the flag updating as it should |
| 8 | 006-0548-0000 · 98 Woodbine St (Mount Hope) | OO both years, mail = property, owner since 2009, $99k exemption (elderly/veteran); 2 units | likely_exempt | ✅ |
| 9 | 107-0598-0000 · 35 Dewey St (Silver Lake) | OO both years, mail = property; 2 units, **built 2006** | likely_exempt | ✅ Built 2006 doesn't qualify as new construction, but the owner-occupied exemption applies |
| 10 | 049-0300-0000 · 21 Redwing St (West End) | OO, "Dionisio Ramos **For Life**" (life estate), mail = property | likely_exempt | ✅ The assessor's FAQ says life estates qualify for the OO rate; the life tenant is the occupant |
| 11 | 009-0330-0000 · 22 Creighton St (College Hill) | OO in FY2026, NOO in FY2025; the same name also holds 79 Barnes St (also OO) | likely_exempt | ⚠️ Two OO parcels under one name means either two people named Craig Barton or a stale flag on one of them. This one flipped to OO this year, so it's probably current. |
| 12 | 109-0564-0000 · 15 Westerly Ave (Silver Lake) | single family, NOO both years, mail = property, owner since 2017 | cant_tell — owner may live here | ✅ Exactly the case the bucket exists for |
| 13 | 005-0529-0004 · 120 Grand View St Unit 4 (Mount Hope) | condo, NOO, revocable trust; mail = this unit; owner since 2009 | cant_tell — owner may live here | ✅ The trust holder appears to live in the unit |
| 14 | 078-0395-0000 · 390 Woodward Rd (Wanskuck) | single family, NOO, mail = property, bought 2022 | cant_tell — owner may live here | ✅ |
| 15 | 033-0273-0002 · 54 Ring St Unit 2 (Federal Hill) | condo, NOO both years, mail = this unit, owner since 2009 | cant_tell — owner may live here | ✅ A 16-year owner mailing to the unit is likely an owner-occupant who never filed |
| 16 | 062-0288-0000 · 109 Bowdoin St (Olneyville) | 2–5 fam, NOO, mail = property; 2 units, **built 2022**, bought 2023 | cant_tell — look-back boundary year | ✅ Exempt only if the CO came on/after 2022-04-15. The owner may also live here. Two independent reasons to say "can't tell". |
| 17 | 065-0757-0000 · 24 Health Ave (Valley) | 2–5 fam, NOO both years, mail = property; 3 units; roll owner ≠ 2024 CAMA owner | cant_tell — owner may live here | ✅ |
| 18 | 092-0154-0000 · 20 Alfred Stone Rd (Blackstone) | single family, OO both years; owner mails from 33 Alfred Stone Rd; roll owner ≠ 2024 CAMA owner | not_residential_rental — owner's home | ⚠️ The OO rate says the owner lives here, but the mailing address is a house down the street. Possibly a recent buyer still mailing from the old address, or a stale flag. |
| 19 | 099-0429-0000 · 48 Virginia Ln (Wanskuck) | single family, OO both years, mail = property | not_residential_rental | ✅ |
| 20 | 126-0196-0000 · 2 Molter St (Reservoir) | single family, OO both years, mail = property, bought 2024-01 | not_residential_rental | ✅ |

**Tally:**
- 16 agree, 3 agree with a caveat, and 1 is probably wrong: #4, an address alias. The direction of the error is benign: it says "covered" where the honest answer is "can't tell".
- No sampled parcel was wrongly called **exempt**.

## Targeted checks: notable buildings (not random)

| Parcel | Records | Result | Verdict |
|---|---|---|---|
| 1 Orms St (003-0500-0000) | Commercial II, 350 "units", 0 beds / 0 baths, CJUF III MJH Providence LLC | cant_tell | ⚠️ This is the Providence Marriott Downtown (hotel → exempt). The owner name doesn't say "hotel". |
| 1 West Exchange (019-0143-H001) | Commercial II, 364 units, Omni Rhode Island LLC | not_residential_rental (transient lodging) | ✅ The Omni hotel |
| 450 Brook St (013-0314-0000) | School, BROWN UNIVERSITY, 219 units, 160 beds, built 2021 | cant_tell (institution) | ✅ A Brown residence hall. Dorm → exempt under (a) if "incidental to educational service"; see OPEN_QUESTIONS #7 |
| 20 Randall Sq (002-0253-8LAW) | 8LAW, 100 units, built 1981 | likely_exempt (8% low-income assessment) | ✅ |
| 123 Regency Plaza (025-0459-0000) | apt 11+, 192 units, 1967, Regency Plaza I LLC | likely_covered | ✅ A market-rate tower with no subsidy signal. The adaptive-reuse caveat doesn't apply (built as apartments). |
| 125 Clifford St (024-0676-0000) | TSA, 249 units, built 2021, EM 28 Providence L.P. | cant_tell (TSA) | ⚠️ A 2021 apartment building. A 2021 CO is outside a look-back starting 2022-04-15, so it's likely covered. The TSA rule fires first and says "can't tell". Acceptable, but a CO-date source (OPEN_QUESTIONS #13) would settle it. |

## Bugs the spot checks found (fixed before the final draw)

1. **Common names joined unrelated people.** "Jose A Perez" matched 11 parcels, 4 of them owner-occupied, so they are clearly different people. That produced a false "owns too many properties" note. Fix: a name that covers 2+ owner-occupied parcels is marked ambiguous, and only the mailing address is used (519 names, 1,391 parcels).
2. **Deeded condo parking and storage spaces** (1000 Providence Pl unit S424, P-, G- units) were treated as 1-unit homes. Fix: condo parcels with P/S/G in the unit ID and no units → not a dwelling (~205 parcels).
3. **Mailing city lines without a state** ("Providence  02919") weren't recognized, so 16 Maria Ave's owner-at-property signal was missed. Fix: the regex accepts a ZIP without a state and 9-digit ZIPs.
4. **Numbered streets**: the roll writes "Twelfth St" while mailing addresses and people write "12th St", so owner-at-property matches failed on numbered streets (187 Tenth St vs. "187 10TH ST") and the lookup found nothing for "12th St" (Rob, 2026-10-30). Fix: ordinals 1st–20th map to words in address matching and search.
5. **Small commercial "units"** (storefronts) were sent to `cant_tell`. Fix: no bedrooms and no bathrooms → not a dwelling (1,165 parcels).
