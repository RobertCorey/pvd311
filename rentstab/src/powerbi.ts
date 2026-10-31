// Read a public ("publish to web") Power BI report's data: the same calls the report page makes. Used for RIDOH's
// lead-certificate report. Grouped queries only (one row per address), paged with restart tokens.
export interface PbiReport { url: string; resourceKey: string; datasetId: string; reportId: string; modelId: number }

const col = (p: string) => ({ Column: { Expression: { SourceRef: { Source: 't' } }, Property: p }, Name: `t.${p}` });
const agg = (p: string, fn: number, name: string) => ({ Aggregation: { Expression: { Column: { Expression: { SourceRef: { Source: 't' } }, Property: p } }, Function: fn }, Name: name });
export const COUNT = 5, MAX = 4;

/** Decode a DSR page: "S" schema on the first row, "R" bitmask = repeat previous value, "Ø" bitmask = null, ValueDicts. */
export function decodeDsr(ds: any, names: string[]): Record<string, unknown>[] {
  const rows = ds.PH?.[0]?.DM0 ?? [];
  const schema = rows[0]?.S ?? [];
  const dicts = ds.ValueDicts ?? {};
  const out: Record<string, unknown>[] = [];
  let prev: unknown[] = [];
  for (const r of rows) {
    const vals: unknown[] = [];
    let k = 0;
    const rep = r.R ?? 0, nul = r['Ø'] ?? 0;
    for (let i = 0; i < schema.length; i++) {
      if (rep & (1 << i)) vals.push(prev[i]);
      else if (nul & (1 << i)) vals.push(null);
      else { let v = r.C?.[k++]; if (schema[i].DN && typeof v === 'number') v = dicts[schema[i].DN][v]; vals.push(v); }
    }
    prev = vals;
    out.push(Object.fromEntries(names.map((n, i) => [n, vals[i]])));
  }
  return out;
}

/** All groups of `entity` by `groups` (filtered to column = value), with aggregates, paged 30,000 at a time. */
export async function pbiGroupedRows(rpt: PbiReport, entity: string, groups: string[], aggs: [string, number, string][], filter: [string, string]) {
  const sel = [...groups.map(col), ...aggs.map(([p, f, n]) => agg(p, f, n))];
  const names = sel.map((s) => s.Name.replace(/^t\./, ''));
  const where = [{ Condition: { In: { Expressions: [{ Column: { Expression: { SourceRef: { Source: 't' } }, Property: filter[0] } }], Values: [[{ Literal: { Value: `'${filter[1]}'` } }]] } } }];
  const all: Record<string, unknown>[] = [];
  let restart: unknown = undefined;
  for (let page = 0; page < 20; page++) {
    const window: Record<string, unknown> = { Count: 30000 };
    if (restart) window.RestartTokens = restart;
    const body = { version: '1.0.0', queries: [{ Query: { Commands: [{ SemanticQueryDataShapeCommand: {
      Query: { Version: 2, From: [{ Name: 't', Entity: entity, Type: 0 }], Select: sel, Where: where },
      Binding: { Primary: { Groupings: [{ Projections: sel.map((_, i) => i) }] }, DataReduction: { DataVolume: 6, Primary: { Window: window } }, Version: 1 } } }] },
      QueryId: '', ApplicationContext: { DatasetId: rpt.datasetId, Sources: [{ ReportId: rpt.reportId }] } }], cancelQueries: [], modelId: rpt.modelId };
    const res = await fetch(rpt.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-PowerBI-ResourceKey': rpt.resourceKey, 'User-Agent': 'Mozilla/5.0' }, body: JSON.stringify(body) });
    const ds = (await res.json()).results?.[0]?.result?.data?.dsr?.DS?.[0];
    if (!ds) throw new Error(`Power BI ${entity}: no data (HTTP ${res.status})`);
    all.push(...decodeDsr(ds, names));
    if (!ds.RT) break;
    restart = ds.RT;
    await new Promise((r) => setTimeout(r, 1500)); // polite paging
  }
  return all;
}
