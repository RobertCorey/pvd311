# Open questions

These are places where the ordinance text or the data leaves the answer open. Each item gives how the classifier currently handles it, so the choice is visible and can be changed in `rules/ordinance-2026-04.yaml`. They are ordered by how many units the answer moves.

## The ordinance text

1. **Is the owner-occupancy test the tax status, or actual residence?**
   - Sec. 13-78(n) requires that "the owner occupies one unit as their principal residence". Principal residence means 185+ days a year, shown by "voter registration, tax filing address, or other reliable indicia" (Sec. 13-69).
   - The city's owner-occupied *tax rate* is our proxy, but about 5,600 small buildings have an owner who apparently lives there without that rate.
   - *Current handling:* OO rate → likely exempt. Non-owner rate with the owner's mail going to the property → `cant_tell`.
   - *Moves:* up to ~3,600 rental units between covered and exempt (`CITYWIDE.md`, sensitivity table).

2. **Condos.** Condos aren't mentioned. A rented condo is a "Rental Unit" (covered by default). Three things are unclear:
   - (a) Is the "housing accommodation" in Sec. 13-78(n) the condo unit or the whole building?
   - (b) Is an owner who lives in unit 1 of a 3-unit condo building occupying the same "housing accommodation" as unit 2, which is owned by someone else?
   - (c) Can a condo unit be the "one additional residential property", and does its "no more than four (4) dwelling units" test look at the unit or the building?
   - *Current handling:* a non-owner-occupied condo is covered unless the owner lives elsewhere in Providence in an owner-occupied home (then `cant_tell` under the additional-property rule).

3. **Do trusts count as an "other legal entity"?**
   - The January draft barred "a corporation, limited liability company, **trust**, partnership, or other legal entity" from the additional-property exemption. The March 26 committee amendment struck "trust".
   - Read plainly, revocable-trust owners can now qualify, but "other legal entity" could still be argued to include trusts.
   - *Current handling:* trusts are treated like people.
   - *Moves:* ~2,400 trust-owned small residential parcels are eligible for consideration.

4. **LLC-owned, owner-lived buildings.** Sec. 13-78(n) ¶1 (owner-occupied 1–4 units) doesn't exclude entities; only the additional-property paragraph does. Can the member of a single-member LLC who lives in the building be "the owner" occupying it? ("Owner" refers to R.I.G.L. § 34-18-11.)
   - *Current handling:* entity-owned → covered, with a confidence note when the LLC's mailing address is the property.
   - *Moves:* ~200 small parcels.

5. **When would a re-passed ordinance take effect?** Section 2 says "upon passage". The 5-year new-construction look-back counts back from that date, so whether a 2022–23 building is exempt depends on the passage date.
   - *Current handling:* `assumed_effective_date: 2027-04-15` (about 100 days after a January 2027 inauguration).
   - *Moves:* small (~100 units) in this data, because the CAMA extract can't see 2024–26 buildings. In reality it moves every building completed from about 2022 on.

6. **"Additions" vs. "new construction".** New construction "does not include additions to existing residential buildings or subdivision of existing dwelling units" (Sec. 13-69), yet the owner-occupied exemption covers "units created through addition, subdivision, conversion" (Sec. 13-78(n)). Is a new detached ADU or backyard cottage on an existing lot "newly built" (10-year exemption) or an "addition"? Not testable from data; flagged only.

7. **Dorms and university housing.** There's no student-housing exemption. Dorms are exempt only if residence is "incidental to … educational … service" (Sec. 13-78(a)). Do university-owned apartments leased to grad students or faculty qualify? And what about privately owned student buildings that master-lease to a university?
   - *Current handling:* School-class parcels with units → `cant_tell`.
   - *Moves:* ~500 units on record in school-class parcels. Brown's 450 Brook St alone is 219.

8. **The College Student Residential Overlay District carve-out (Sec. 13-78(m)) points at a district that doesn't appear to exist.** None of the city's public zoning layers has one. If it is created later, new construction inside it gets no exemption.
   - *Current handling:* ignored, with a note on every new-construction result.

9. **Short-term rentals.** Lodging "subject to state sales and use tax or lodgings tax" is exempt (Sec. 13-78(d)). R.I. applies the hotel tax to short-term rentals, so a unit rented on Airbnb is plausibly exempt while it is used that way. "Short-term rental use" also counts as "removed from the rental market" (Sec. 13-69), which matters for base rent when the unit comes back. No public STR registry was found.

10. **Mixed-income buildings.** Exemptions (i)/(j) are per unit: market-rate units in a LIHTC or HUD building are covered. HUD totals give the restricted share (`LI_UNITS` vs `N_UNITS`) but not which units, so a lookup can only say "some units here are exempt".
    - *Current handling:* fully restricted → likely exempt; partly restricted → `cant_tell`.

11. **Does "one to four (1-4) dwelling units" count an ADU?** The last paragraph of (n) says adding an ADU doesn't disqualify a building "even if the total number of dwelling units exceeds four (4)". Assessor data doesn't flag ADUs.
    - *Current handling:* 5 units with the owner living there → `cant_tell`.

## The data

12. **Why do ~5,700 owners who seem to live at their property lack the owner-occupied rate?** About 3,400 of them bought before 2024. The candidate explanations are never filing, losing status at the ~2020 recertification, or address aliasing. One question to the assessor ("what share of owner-occupants are on the OO rate?") would size the bias, and would show whether the city could share certification records.

13. **Certificate-of-occupancy dates.** The new-construction exemption runs from the CO date, which isn't in any public dataset. The Department of Inspections & Standards has them; the open-data permits file stops at 2018, and the ArcGIS "DIS_Active_Permit_VIew" layer wasn't explored. That layer is a slice-2 candidate.

14. **Large commercial / TSA parcels with units** (79 parcels, ~4,000 units) mix hotels, senior living, apartments and mill conversions. Owner names don't separate them. A one-time manual labelling of the ~80 parcels would turn all of them into confident answers.

15. **Unit counts on tax-exempt parcels** are mostly 0: PHA high-rises, state-owned housing. This doesn't change their status, since most are exempt anyway, but it undercounts units in the citywide totals.

16. **Address aliases.** Some condo complexes use two street numbers. 1000 Providence Pl's owners mail to "903 Providence Pl Unit 211" for unit 0211, so "mail = property" misses them and they read as covered instead of `cant_tell`. Matching on the condo unit number would fix this.
