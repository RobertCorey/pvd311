# rentstab: would this Providence apartment be rent-stabilized?

This is slice 1, a data and rules spike. It tests whether public records can tell, parcel by parcel, whether a home would be covered by the Providence Rent Stabilization Act as the City Council passed it in April 2026. The mayor vetoed the ordinance and the veto was sustained, so **it is not law**. This is not the product.

Start with **[SUMMARY.md](SUMMARY.md)**, then **[DATA_REPORT.md](DATA_REPORT.md)**.

| File | What |
|---|---|
| `rules/ordinance-2026-04.yaml` | every coverage/exemption rule, with section citations and verbatim quotes; thresholds, code mappings, statuses and messages |
| `src/classify.ts` | `classify(parcel, rules) → { status, reasons[], confidence_notes[] }`, pure, driven entirely by the YAML |
| `DATA_REPORT.md` | fields, fill rates, the owner-occupancy / unit-count / year-built / condo answers |
| `CITYWIDE.md` | generated: counts by status, building size and neighborhood; fiscal-note + Census comparison; sensitivity |
| `SPOT_CHECKS.md` · `OPEN_QUESTIONS.md` | 20 random + 6 targeted hand checks · everything ambiguous |

## Run

Requires Node 24 (runs `.ts` directly; `node:sqlite` is built in). No API keys.

```sh
npm install
npm run rebuild     # fetch public data → data/parcels.sqlite → CITYWIDE.md (~1 min)
npm test            # 57 classifier/normalizer tests
npm run serve       # bare lookup page on http://localhost:4173
npm run profile     # field fill-rate tables behind DATA_REPORT.md
npm run spot-checks # the seeded spot-check sample
```

`data/` is gitignored, and every number rebuilds from the fetch script. Sources: Providence's FY2026 and FY2025 tax rolls (Socrata), the city's parcel+CAMA layer (ArcGIS), neighborhoods, PHA sites, and HUD's LIHTC / assisted-multifamily / public-housing layers.
