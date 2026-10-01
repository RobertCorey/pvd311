import { CATEGORIES, GROUP_CATCH_ALL, GROUP_ORDER, type CategoryConfig, type GroupKey } from '@shared/categories';

export type { GroupKey };

export interface UiCategory {
  key: string; label: string; short: string; photoRequired: boolean; seasonal: 'winter' | null;
  /** extra-question keys (`extra.<key>` sources in shared/categories.ts) */
  extra: string[];
  group: GroupKey;
  /** Level-2 row this type belongs to (its own key when it has no siblings). */
  object: string;
  facet: { q: string; a: string } | null;
  synonyms: string[];
  demand: number;
  hidden: boolean;
  /** The city's own name for the type — shown small under ours so the reporter sees what 311 will receive. */
  cityName: string;
}

// Picker-friendly short labels (English fallback; i18n `cat.<key>.short` wins). Keys absent here fall back to `label`.
const SHORT: Record<string, string> = {
  missed_trash: 'Missed pickup', bins_carts: 'Bins & carts', abandoned_vehicle: 'Abandoned car',
  animal_control: 'Animal issue', unsure: 'Not sure', trash_private: 'Trash on a property', trash_public: 'Trash on the street',
  storm_drain: 'Blocked storm drain', traffic_sign: 'Damaged sign', traffic_control: 'Speeding / traffic', overgrowth: 'Overgrown yard',
  downed_wire: 'Downed wire / utility pole',
};

export const ALL_CATEGORIES: UiCategory[] = Object.entries(CATEGORIES as Record<string, CategoryConfig>).map(([key, c]) => ({
  key,
  label: c.label,
  short: SHORT[key] ?? c.label,
  photoRequired: c.photoRequired !== false,
  seasonal: c.seasonal ?? null,
  extra: Object.values(c.fields ?? {}).map((f) => ('from' in f ? f.from.replace(/^extra\./, '') : '')).filter(Boolean),
  group: c.group,
  object: c.object ?? key,
  facet: c.facet ?? null,
  synonyms: c.synonyms ?? [],
  demand: c.demand ?? 0,
  hidden: !!c.hidden,
  cityName: c.portalCaseTypeName,
}));

export const byKey = (k: string | null | undefined) => ALL_CATEGORIES.find((c) => c.key === k) ?? null;

/** Localized picker label: `cat.<key>.short` from i18n, falling back to the English `short`. */
export function shortLabel(key: string, t: (k: string) => string): string {
  const s = t(`cat.${key}.short`);
  return s.startsWith('cat.') ? (byKey(key)?.short ?? key) : s;
}

export function inSeason(c: UiCategory, now = new Date()): boolean {
  if (!c.seasonal) return true;
  const m = now.getMonth();
  return c.seasonal === 'winter' ? m >= 10 || m <= 2 : true;
}

/** Labels/placeholders live in i18n (extra.*). */
export const EXTRA_QUESTIONS: Record<string, { type: 'choice' | 'text'; options?: string[] }> = {
  size: { type: 'choice', options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'] },
  cartIssue: { type: 'choice', options: ['I did not receive my new carts.', 'My old carts were not removed', 'Other'] },
  animalType: { type: 'choice', options: ['Wildlife', 'Domestic'] },
  vehicleDetails: { type: 'text' },
};

/* ── Browse-then-disambiguate picker (2026-10-01) ─────────────────────────────────────────────────
 * Level 1: group tiles (icons) in GROUP_ORDER; `other` renders as the wide "Not sure" tile.
 * Level 2: object rows for the group — one row per `object`, demand-sorted; a row with one type files it,
 *          a row with siblings opens level 3.
 * Level 3: the siblings' shared facet question as 2–4 cards; picking one files the exact city type.
 * Plus: search over short labels, synonyms and the city's names; "Something else in this group" → GROUP_CATCH_ALL.
 * Icons exist only for level 1 and the quick picks (Rob: icon volume was the concern), so rows are text. */

/** CategoryIcon key drawn on each group tile. */
export const GROUP_ICON: Record<GroupKey, string> = {
  trash: 'bins_carts', streets: 'pothole', traffic: 'traffic_signal', trees: 'tree', property: 'property',
  lights: 'street_light', nuisance: 'noise', water: 'water', animals: 'animal_control', other: 'unsure',
};
export const GROUPS: { key: GroupKey; icon: string }[] = GROUP_ORDER.filter((g) => g !== 'other').map((key) => ({ key, icon: GROUP_ICON[key] }));
export const groupOf = (key: string): GroupKey | null => byKey(key)?.group ?? null;
/** The type a group's "Something else" row files as. */
export const catchAllFor = (g: GroupKey): string => GROUP_CATCH_ALL[g] ?? 'unsure';

export interface ObjectRow {
  /** `object` key; equals the type key for single-type rows. */
  key: string;
  group: GroupKey;
  /** Visible, in-season types under this row (1 = leaf row; >1 = facet question). */
  cats: UiCategory[];
  /** The facet question the siblings share (null for a leaf row). */
  facetQ: string | null;
  demand: number;
}

/** Level-2 rows for a group: not hidden, in season, demand-sorted (stable on the registry order for ties). */
export function groupRows(g: GroupKey, now = new Date()): ObjectRow[] {
  const rows = new Map<string, ObjectRow>();
  for (const c of ALL_CATEGORIES) {
    if (c.group !== g || c.hidden || !inSeason(c, now)) continue;
    const row = rows.get(c.object) ?? { key: c.object, group: g, cats: [], facetQ: null, demand: 0 };
    row.cats.push(c);
    row.demand += c.demand;
    rows.set(c.object, row);
  }
  for (const row of rows.values()) {
    if (row.cats.length > 1) {
      row.facetQ = row.cats[0].facet?.q ?? null;
      row.cats.sort((a, b) => b.demand - a.demand);
    }
  }
  return [...rows.values()].sort((a, b) => b.demand - a.demand);
}

/** The level-2 row a type belongs to, or null if it is hidden / out of season. */
export function rowFor(objectKey: string, now = new Date()): ObjectRow | null {
  const c = ALL_CATEGORIES.find((x) => x.object === objectKey && !x.hidden);
  return c ? groupRows(c.group, now).find((r) => r.key === objectKey) ?? null : null;
}

/** Row label: `obj.<object>` for multi-type rows, else the type's short label. */
export function rowLabel(row: ObjectRow, t: (k: string) => string): string {
  if (row.cats.length === 1) return shortLabel(row.cats[0].key, t);
  const s = t(`obj.${row.key}`);
  return s.startsWith('obj.') ? row.key : s;
}

/** Facet answer label for a type: `facet.<q>.<a>`. */
export function facetLabel(c: UiCategory, t: (k: string) => string): string {
  if (!c.facet) return shortLabel(c.key, t);
  const s = t(`facet.${c.facet.q}.${c.facet.a}`);
  return s.startsWith('facet.') ? c.facet.a : s;
}

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Free-text search over every visible type: short label (both languages via `t`), synonyms (English + i18n
 *  `cat.<key>.syn`), the object row label and the city's own name. Ranks whole-word prefix hits over substrings,
 *  then demand. Empty / 1-char queries return nothing. */
export function searchTypes(query: string, t: (k: string) => string, now = new Date(), limit = 8): UiCategory[] {
  const q = fold(query);
  if (q.length < 2) return [];
  const terms = q.split(' ');
  const scored: { c: UiCategory; score: number }[] = [];
  for (const c of ALL_CATEGORIES) {
    if (c.hidden || !inSeason(c, now)) continue;
    const syn = t(`cat.${c.key}.syn`);
    const hay = [
      shortLabel(c.key, t), c.short, c.label, c.cityName,
      ...c.synonyms, ...(syn.startsWith('cat.') ? [] : syn.split(',')),
      ...(c.object !== c.key ? [t(`obj.${c.object}`)] : []),
    ].map(fold);
    let score = 0;
    for (const term of terms) {
      let best = 0;
      for (const h of hay) {
        if (h === term || h.startsWith(term + ' ')) best = Math.max(best, 3);
        else if (h.startsWith(term) || h.includes(' ' + term)) best = Math.max(best, 2);
        else if (h.includes(term)) best = Math.max(best, 1);
      }
      if (!best) { score = 0; break; }
      score += best;
    }
    if (score) scored.push({ c, score: score * 100 + Math.min(c.demand, 99) });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.c);
}

/** Two quick picks above the groups: the season's top two citywide types (snow Dec–Mar, dark commutes in Nov, trash + potholes otherwise).
 *  The account's last type, if any, takes the first slot. */
export function quickPicks(now = new Date()): string[] {
  const m = now.getMonth();
  if (m === 11 || m <= 1) return ['unshoveled_sidewalk', 'missed_plowing'];
  if (m === 2) return ['missed_plowing', 'pothole'];
  if (m === 10) return ['street_light', 'missed_trash'];
  return ['missed_trash', 'pothole'];
}

const LAST_KEY = 'fixmypvd.lastCategory';
export function rememberCategory(key: string): void { try { localStorage.setItem(LAST_KEY, key); } catch { /* private mode */ } }
export function lastCategory(): string | null { try { return localStorage.getItem(LAST_KEY); } catch { return null; } }
