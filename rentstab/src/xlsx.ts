// Minimal .xlsx reader (first sheet → rows of strings) for the few spreadsheets public agencies release.
import { strFromU8, Unzip, UnzipInflate, unzipSync } from 'fflate';

const decode = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Column letters → 0-based index ("A" → 0, "AB" → 27). */
function colIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sharedStrings(buf: Uint8Array): string[] {
  const ss = unzipSync(buf, { filter: (f) => f.name === 'xl/sharedStrings.xml' })['xl/sharedStrings.xml'];
  return ss ? (strFromU8(ss).match(/<si>[\s\S]*?<\/si>/g) ?? []).map((si) => decode((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) ?? []).map((t) => t.replace(/<t[^>]*>|<\/t>/g, '')).join(''))) : [];
}

function parseRow(row: string, shared: string[]): string[] {
  const out: string[] = [];
  for (const c of row.match(/<c [^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) ?? []) {
    const ref = c.match(/ r="([A-Z]+\d+)"/)?.[1];
    const type = c.match(/ t="(\w+)"/)?.[1];
    const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? c.match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
    const val = type === 's' ? shared[Number(v)] ?? '' : decode(v);
    if (ref) out[colIndex(ref)] = val; else out.push(val);
  }
  return Array.from(out, (x) => x ?? '');
}

/** Streams one text member of a zip line by line (national CSVs inside big zips, e.g. HUD CHAS). */
export function streamZipLines(buf: Uint8Array, member: string, onLine: (line: string) => void): void {
  const decoder = new TextDecoder('latin1');
  let pending = '';
  const unzip = new Unzip((file) => {
    if (file.name !== member) return;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      pending += decoder.decode(chunk, { stream: !final });
      const lines = pending.split('\n');
      pending = final ? '' : lines.pop()!;
      for (const l of lines) onLine(l.replace(/\r$/, ''));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < buf.length; i += 1 << 20) unzip.push(buf.subarray(i, Math.min(i + (1 << 20), buf.length)), i + (1 << 20) >= buf.length);
}

/** Streams one sheet row by row, for sheets too big to hold as a string (HUD's tract file is a 500 MB sheet). */
export function streamXlsxRows(buf: Uint8Array, onRow: (row: string[]) => void, sheet = 1): void {
  const shared = sharedStrings(buf);
  const decoder = new TextDecoder();
  let pending = '';
  const unzip = new Unzip((file) => {
    if (file.name !== `xl/worksheets/sheet${sheet}.xml`) return;
    file.ondata = (err, chunk, final) => {
      if (err) throw err;
      pending += decoder.decode(chunk, { stream: !final });
      let end: number, start = 0;
      while ((end = pending.indexOf('</row>', start)) >= 0) {
        const open = pending.indexOf('<row', start);
        onRow(parseRow(pending.slice(open, end + 6), shared));
        start = end + 6;
      }
      pending = pending.slice(start);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let i = 0; i < buf.length; i += 1 << 20) unzip.push(buf.subarray(i, Math.min(i + (1 << 20), buf.length)), i + (1 << 20) >= buf.length);
}

export function readXlsx(buf: Uint8Array, sheet = 1): string[][] {
  const files = unzipSync(buf, { filter: (f) => f.name === `xl/worksheets/sheet${sheet}.xml` });
  const xml = files[`xl/worksheets/sheet${sheet}.xml`];
  if (!xml) return [];
  const shared = sharedStrings(buf);
  return (strFromU8(xml).match(/<row[^>]*>[\s\S]*?<\/row>/g) ?? []).map((row) => parseRow(row, shared));
}

/** Rows → objects keyed by the first row that contains `headerHint`. */
export function xlsxRecords(rows: string[][], headerHint: string): Record<string, string>[] {
  const norm = (c: string) => c.replace(/\s+/g, ' ').trim();
  const h = rows.findIndex((r) => r.some((c) => norm(c) === headerHint));
  if (h < 0) return [];
  const head = rows[h].map(norm);
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
