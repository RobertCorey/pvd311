// Address + owner-name normalization shared by build-db, the classifier inputs, and the lookup page.
// Deliberately simple: the brief says owner matching is low confidence and not worth a long detour.

const SUFFIX: Record<string, string> = {
  street: 'st', st: 'st', avenue: 'av', ave: 'av', av: 'av', road: 'rd', rd: 'rd', boulevard: 'bl', blvd: 'bl', bl: 'bl',
  drive: 'dr', dr: 'dr', place: 'pl', pl: 'pl', court: 'ct', ct: 'ct', lane: 'ln', ln: 'ln', terrace: 'te', ter: 'te',
  te: 'te', way: 'wy', wy: 'wy', square: 'sq', sq: 'sq', parkway: 'pk', pkwy: 'pk', pk: 'pk', highway: 'hw', hwy: 'hw',
  circle: 'ci', cir: 'ci', ci: 'ci', hill: 'hl', hl: 'hl', row: 'row', plaza: 'plz', plz: 'plz', alley: 'al', al: 'al',
};
const DIRECTION: Record<string, string> = { north: 'n', south: 's', east: 'e', west: 'w' };

export interface StreetAddress {
  lo: number;
  hi: number;
  street: string; // lowercased name without suffix, e.g. "douglas" for "31-33 Douglas Ave"
}

/** "31-33 Douglas Ave" → {lo:31, hi:33, street:"douglas"}. Null when there is no leading house number. */
export function parseAddress(raw: string | null | undefined): StreetAddress | null {
  if (!raw) return null;
  let s = raw.toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s(unit|apt|#|fl|floor|ste|suite|bldg)\b.*$/, '').replace(/#.*$/, '').trim();
  const m = s.match(/^(\d+)[a-z]?(?:\s*-\s*(\d+)[a-z]?)?\s+(.+)$/);
  if (!m) return null;
  const lo = Number(m[1]);
  let hi = m[2] ? Number(m[2]) : lo;
  if (hi < lo || hi - lo > 40) hi = lo;
  let toks = m[3].split(' ').map((t) => DIRECTION[t] ?? t);
  if (toks.length > 1 && SUFFIX[toks[toks.length - 1]]) toks = toks.slice(0, -1);
  return { lo, hi, street: toks.join(' ') };
}

/** Same street and overlapping house-number ranges (a 2-family at 13-15 matches a mailing address of 15). */
export function sameAddress(a: StreetAddress | null, b: StreetAddress | null, slack = 0): boolean {
  if (!a || !b || a.street !== b.street) return false;
  return a.lo - slack <= b.hi && b.lo - slack <= a.hi;
}

/** Tax-roll mailing lines shift when a trust name is present: find the city/state/ZIP line, the street is the line before it. */
export function mailingStreetAndCity(lines: (string | null | undefined)[]): { street: string | null; city: string | null } {
  const clean = lines.map((l) => (l && l.trim() && l.trim().toUpperCase() !== 'NULL' ? l.trim() : null));
  for (let i = clean.length - 1; i >= 0; i--) {
    const l = clean[i];
    if (l && /\b[A-Za-z]{2}\.?\s+\d{5}(-\d{4})?\s*$/.test(l)) {
      let j = i - 1;
      while (j >= 0 && !clean[j]) j--;
      return { street: j >= 0 ? clean[j] : null, city: l };
    }
  }
  return { street: clean.find(Boolean) ?? null, city: null };
}

export type OwnerKind = 'person' | 'trust' | 'entity' | 'unknown';

const ENTITY = /\b(llc|l\s?l\s?c|inc|incorporated|corp|corporation|company|co|lp|l\s?p|llp|ltd|limited|realty|properties|property|holdings?|associates|partners|partnership|group|investments?|management|housing|authority|church|university|college|bank|association|assoc|fund|ventures|development|enterprises|condominium|cooperative|apartments?|city of|state of|parish|diocese|society|foundation|institute|hospital|school)\b/i;
const TRUST = /\b(trust|trustee|trustees|tr|rev tr|living trust|revocable|estate of|life estate)\b/i;

export function ownerKind(name: string | null | undefined): OwnerKind {
  if (!name || !name.trim()) return 'unknown';
  if (ENTITY.test(name)) return 'entity';
  if (TRUST.test(name)) return 'trust';
  return 'person';
}

const DROP = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'trustee', 'trustees', 'tr', 'for', 'life', 'et', 'al', 'ux', 'etal', 'mr', 'mrs', 'ms', 'dr', 'the']);

/**
 * Order-insensitive name key: "Houle, Michael David" and "Michael D Houle" → "houle michael".
 * Keeps the last name + first given name only (initials and middles vary between rolls). Low confidence by design.
 */
export function ownerKey(name: string | null | undefined): string | null {
  if (!name) return null;
  const kind = ownerKind(name);
  const s = name.toLowerCase().replace(/[^a-z0-9&, ]/g, ' ');
  if (kind === 'entity') return 'entity:' + s.replace(/[, ]+/g, ' ').trim();
  // Several owners ("A Smith & B Smith"): key on the first named person.
  const first = s.split(/&| and /)[0];
  let toks: string[];
  if (first.includes(',')) {
    // "Last, First Middle"
    const [last, rest = ''] = first.split(',');
    toks = [...rest.split(/\s+/), ...last.split(/\s+/)];
  } else toks = first.split(/\s+/);
  toks = toks.filter((t) => t && !DROP.has(t) && t.length > 1);
  if (toks.length === 0) return null;
  if (toks.length === 1) return 'person:' + toks[0];
  const last = toks[toks.length - 1];
  return 'person:' + [last, toks[0]].sort().join(' ');
}
