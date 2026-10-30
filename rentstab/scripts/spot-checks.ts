// Deterministic stratified sample for SPOT_CHECKS.md: prints each parcel's raw roll + CAMA record next to its result.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { classify } from '../src/classify.ts';
import { loadParcels } from '../src/db.ts';
import { loadRules, type Status } from '../src/rules.ts';

const ROOT = join(import.meta.dirname, '..');
const rules = loadRules(join(ROOT, 'rules', 'ordinance-2026-04.yaml'));
const raw = (n: string) => JSON.parse(readFileSync(join(ROOT, 'data', 'raw', `${n}.json`), 'utf8')) as any[];
const roll = new Map(raw('taxroll2026').map((r) => [r.tax_map, r]));
const prev = new Map(raw('taxroll2025').map((r) => [r.tax_map, r.levy_code_1]));
const cama = new Map<string, any>();
for (const c of raw('cama')) if (c.PROPID && !cama.has(c.PROPID)) cama.set(c.PROPID, c);

// Small seeded PRNG so the sample is reproducible.
let seed = Number(process.env.SEED ?? 311);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const quota: Record<Status, number> = { likely_covered: 6, likely_exempt: 5, cant_tell: 6, not_residential_rental: 3 };
const all = loadParcels().map((p) => ({ p, c: classify(p, rules) }));
for (const [status, n] of Object.entries(quota)) {
  // Only parcels with dwelling units or a residential class, so "not residential" isn't 20 vacant lots.
  const pool = all.filter((x) => x.c.status === status && (x.p.units || ['1', '2', '23'].includes(x.p.taxClass)));
  for (let i = 0; i < n; i++) {
    const { p, c } = pool[Math.floor(rand() * pool.length)];
    const r = roll.get(p.id), k = cama.get(p.id);
    console.log(`\n## ${p.id} · ${p.address} · ${p.neighborhood ?? '–'}`);
    console.log(`roll: class ${r.class} ${r.class_descrip} · levy ${r.levy_code_1}${r.levy_code_2 ? '/' + r.levy_code_2 : ''} (FY2025: ${prev.get(p.id) ?? '–'}) · owner "${r.owner}" · mail "${[r.mailing_2, r.mailing_3, r.mailing_4].filter(Boolean).join(' / ')}" · exempt $${r.total_exempt}`);
    console.log(`cama: use ${k?.MuniUseCode} ${k?.MuniUseCodeDesc} · units ${k?.NumUnits} · built ${k?.YearBuilt} · beds ${k?.NumBedRooms} · baths ${k?.NumBathrooms} · sold ${p.lastSaleDate} · CAMA owner "${k?.Owner1}"`);
    console.log(`derived: ownerKind ${p.ownerKind} · mail=property ${p.mailingIsProperty} · other parcels ${p.ownerOtherResidential.map((o) => `${o.address}${o.ownerOccupied ? ' (OO)' : ''}`).join('; ') || 'none'} · home ${p.homeParcelAddress ?? '–'} · affordable ${p.affordableSignals.join(',') || '–'}`);
    console.log(`→ ${c.status} [${c.rule}] ${c.reasons[0]}`);
    for (const n of c.confidence_notes) console.log(`   · ${n}`);
  }
}
