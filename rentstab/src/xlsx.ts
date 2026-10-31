// Minimal .xlsx reader (first sheet → rows of strings) for the few spreadsheets public agencies release.
import { strFromU8, unzipSync } from 'fflate';

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Column letters → 0-based index ("A" → 0, "AB" → 27). */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export function readXlsx(buf: Uint8Array, sheet = 1): string[][] {
  const files = unzipSync(buf, { filter: (f) => f.name === 'xl/sharedStrings.xml' || f.name === `xl/worksheets/sheet${sheet}.xml` });
  const shared: string[] = [];
  const ss = files['xl/sharedStrings.xml'];
  if (ss) for (const si of strFromU8(ss).match(/<si>[\s\S]*?<\/si>/g) ?? []) {
    shared.push(decode((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<t[^>]*>|<\/t>/g, '')).join('')));
  }
  const xml = files[`xl/worksheets/sheet${sheet}.xml`];
  if (!xml) return [];
  const rows: string[][] = [];
  for (const row of strFromU8(xml).match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []) {
    const out: string[] = [];
    for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
      const ref = c.match(/ r="([A-Z]+\d+)"/)?.[1];
      const type = c.match(/ t="(\w+)"/)?.[1];
      const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
      const val = type === 's' ? shared[Number(v)] ?? '' : decode(v);
      if (ref) out[colIndex(ref)] = val; else out.push(val);
    }
    rows.push(Array.from(out, (x) => x ?? ''));
  }
  return rows;
}

/** Rows → objects keyed by the first row that contains `headerHint`. */
export function xlsxRecords(rows: string[][], headerHint: string): Record<string, string>[] {
  const h = rows.findIndex((r) => r.some((c) => c.trim() === headerHint));
  if (h < 0) return [];
  const head = rows[h].map((c) => c.trim());
  return rows.slice(h + 1).filter((r) => r.some((c) => c && c.trim())).map((r) => Object.fromEntries(head.map((k, i) => [k, (r[i] ?? '').trim()])));
}

/** Excel serial day → ISO date (text dates pass through when they parse). */
export function excelDate(v: string): string | null {
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v)) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(v) * 86400000);
    return d.getUTCFullYear() > 1900 ? d.toISOString().slice(0, 10) : null;
  }
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
