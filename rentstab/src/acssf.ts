// Read tract estimates from the Census ACS 5-year Summary File (sequence-based releases through 2020), which needs no API key.
// Per state, one zip of "Tracts_Block_Groups_Only" files: g<year>5<st>.csv maps LOGRECNO → GEOID, and e<year>5<st><seq>000.txt
// holds estimates by sequence. The release's ACS_5yr_Seq_Table_Number_Lookup.txt gives each table's sequence and the column
// where its first cell starts (1-based, counting the six leading id fields).
import { strFromU8, unzipSync } from 'fflate';
import { readCsv } from './csv.ts';

const BASE = 'https://www2.census.gov/programs-surveys/acs/summary_file';

/** A cell id is table + line, e.g. "B25064_001". */
export interface TableStart { seq: string; start: number }

/** Lookup rows → table id → sequence and start position. */
export function tableStarts(lookupCsv: string): Map<string, TableStart> {
  const out = new Map<string, TableStart>();
  for (const r of readCsv(lookupCsv)) {
    const start = Number(r['Start Position']);
    if (r['Table ID'] && start > 0 && !out.has(r['Table ID'])) out.set(r['Table ID'], { seq: r['Sequence Number'], start });
  }
  return out;
}

/** Estimates for every tract whose GEOID starts with `prefix` ("14000US44007"), one object per tract. */
export async function acsTracts(o: { year: number; st: string; stateDir: string; prefix: string; cells: Record<string, string> }):
  Promise<Record<string, string | number | null>[]> {
  const get = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; };
  const starts = tableStarts(await (await get(`${BASE}/${o.year}/documentation/user_tools/ACS_5yr_Seq_Table_Number_Lookup.txt`)).text());
  const want = Object.entries(o.cells).map(([name, cell]) => {
    const [table, line] = cell.split('_');
    const t = starts.get(table);
    if (!t) throw new Error(`ACS ${o.year}: no table ${table}`);
    return { name, seq: t.seq.padStart(4, '0'), index: t.start - 1 + Number(line) - 1 };
  });
  const zip = new Uint8Array(await (await get(`${BASE}/${o.year}/data/5_year_by_state/${o.stateDir}_Tracts_Block_Groups_Only.zip`)).arrayBuffer());
  const seqs = new Set(want.map((w) => w.seq));
  const geoName = `g${o.year}5${o.st}.csv`;
  const files = unzipSync(zip, { filter: (f) => f.name === geoName || [...seqs].some((s) => f.name === `e${o.year}5${o.st}${s}000.txt`) });
  // Geography rows are unquoted except the NAME field; LOGRECNO is the 5th field and GEOID the one shaped like "14000US…".
  const geoid = new Map<string, string>();
  for (const line of strFromU8(files[geoName], true).split('\n')) {
    const f = line.split(',');
    const g = f.find((x) => /^\d{3}00US\d+$/.test(x));
    if (g?.startsWith(o.prefix)) geoid.set(f[4], g);
  }
  const rows = new Map<string, Record<string, string | number | null>>();
  for (const seq of seqs) {
    for (const line of strFromU8(files[`e${o.year}5${o.st}${seq}000.txt`], true).split('\n')) {
      const f = line.split(',');
      const g = geoid.get(f[5]);
      if (!g) continue;
      const row = rows.get(g) ?? rows.set(g, { geoid: g, year: o.year }).get(g)!;
      for (const w of want) if (w.seq === seq) { const v = f[w.index]; row[w.name] = v === '' || v === '.' || v == null ? null : Number(v); }
    }
  }
  return [...rows.values()];
}
