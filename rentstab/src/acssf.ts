// Read tract estimates from the Census ACS 5-year Summary File (sequence-based releases through 2020), which needs no API key.
// Per state, one zip of "Tracts_Block_Groups_Only" files: g<year>5<st>.csv maps LOGRECNO → GEOID, and e<year>5<st><seq>000.txt
// holds estimates by sequence. The release's ACS_5yr_Seq_Table_Number_Lookup.txt gives each table's sequence and the column
// where its first cell starts (1-based, counting the six leading id fields).
import { strFromU8, unzipSync } from 'fflate';
import { readCsv } from './csv.ts';

const BASE = 'https://www2.census.gov/programs-surveys/acs/summary_file';

/** A cell id is table + line, e.g. "B25064_001". */
export interface TableStart { seq: string; start: number }

/** Lookup rows → table id → sequence, start position, and each line's label ("Moved in 2017 or later"). */
export function tableStarts(lookupCsv: string): Map<string, TableStart & { title: string; labels: string[] }> {
  const out = new Map<string, TableStart & { title: string; labels: string[] }>();
  for (const r of readCsv(lookupCsv)) {
    const id = r['Table ID'], start = Number(r['Start Position']), line = Number(r['Line Number']);
    if (id && start > 0 && !out.has(id)) out.set(id, { seq: r['Sequence Number'], start, title: (r['Table Title'] ?? '').trim(), labels: [] });
    if (id && line > 0 && Number.isInteger(line) && out.has(id)) out.get(id)!.labels[line - 1] = (r['Table Title'] ?? '').trim();
  }
  return out;
}

/** The release's sequence/table lookup: current path first, then the 2006–10 era path. */
async function lookupText(year: number): Promise<string> {
  for (const path of [`${year}/documentation/user_tools/ACS_5yr_Seq_Table_Number_Lookup.txt`, `${year}/documentation/5_year/user_tools/Sequence_Number_and_Table_Number_Lookup.txt`]) {
    const r = await fetch(`${BASE}/${path}`);
    if (r.ok) return r.text();
  }
  throw new Error(`ACS ${year}: no table lookup found`);
}

/** Every line of whole tables for every tract whose GEOID starts with `prefix`, long format, with the release's line labels. */
export async function acsTractTables(o: { year: number; st: string; stateDir: string; prefix: string; tables: string[] }):
  Promise<{ labels: Record<string, string>; rows: { geoid: string; cell: string; value: number | null }[] }> {
  const starts = tableStarts(await lookupText(o.year));
  const cells: Record<string, string> = {}, labels: Record<string, string> = {};
  for (const t of o.tables) {
    const info = starts.get(t);
    if (!info) throw new Error(`ACS ${o.year}: no table ${t}`);
    labels[`${t}_title`] = info.title;
    info.labels.forEach((label, i) => { const c = `${t}_${String(i + 1).padStart(3, '0')}`; cells[c] = c; labels[c] = label; });
  }
  const wide = await acsTracts({ ...o, cells });
  return { labels, rows: wide.flatMap((r) => Object.keys(cells).map((c) => ({ geoid: String(r.geoid), cell: c, value: (r[c] as number | null) ?? null }))) };
}

/** Estimates for every tract whose GEOID starts with `prefix` ("14000US44007"), one object per tract. */
export async function acsTracts(o: { year: number; st: string; stateDir: string; prefix: string; cells: Record<string, string> }):
  Promise<Record<string, string | number | null>[]> {
  const get = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r; };
  const starts = tableStarts(await lookupText(o.year));
  const want = Object.entries(o.cells).map(([name, cell]) => {
    const [table, line] = cell.split('_');
    const t = starts.get(table);
    if (!t) throw new Error(`ACS ${o.year}: no table ${table}`);
    return { name, seq: t.seq.padStart(4, '0'), index: t.start - 1 + Number(line) - 1 };
  });
  const zip = new Uint8Array(await (await get(`${BASE}/${o.year}/data/5_year_by_state/${o.stateDir}_Tracts_Block_Groups_Only.zip`)).arrayBuffer());
  const seqs = new Set(want.map((w) => w.seq));
  const geoCsv = `g${o.year}5${o.st}.csv`, geoTxt = `g${o.year}5${o.st}.txt`;
  const files = unzipSync(zip, { filter: (f) => f.name === geoCsv || f.name === geoTxt || [...seqs].some((s) => f.name === `e${o.year}5${o.st}${s}000.txt`) });
  // Geography: CSV from 2011 on (LOGRECNO is the 5th field, GEOID the one shaped like "14000US…"); fixed-width text in the
  // 2006–10 release (LOGRECNO in columns 14–20).
  const geoid = new Map<string, string>();
  const csv = files[geoCsv];
  for (const line of strFromU8(csv ?? files[geoTxt], true).split('\n')) {
    const g = csv ? line.split(',').find((x) => /^\d{3}00US\d+$/.test(x)) : line.match(/\d{3}00US\d+/)?.[0];
    if (g?.startsWith(o.prefix)) geoid.set(csv ? line.split(',')[4] : line.slice(13, 20), g);
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
