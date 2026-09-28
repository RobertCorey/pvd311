import { CATEGORIES, type CategoryConfig } from '@shared/categories';

export interface UiCategory {
  key: string; label: string; short: string; photoRequired: boolean; seasonal: 'winter' | null;
  /** extra-question keys (`extra.<key>` sources in shared/categories.ts) */
  extra: string[];
}

// Picker-friendly short labels; portal-facing labels stay in shared/categories.ts.
const SHORT: Record<string, string> = {
  missed_trash: 'Missed pickup', bins_carts: 'Bins & carts', abandoned_vehicle: 'Abandoned car',
  animal_control: 'Animal issue', unsure: 'Not sure', trash_private: 'Trash on a property', trash_public: 'Trash on the street',
  storm_drain: 'Blocked storm drain', traffic_sign: 'Damaged sign', traffic_control: 'Speeding / traffic', overgrowth: 'Overgrown yard',
  downed_wire: 'Downed wire / pole',
};

export const ALL_CATEGORIES: UiCategory[] = Object.entries(CATEGORIES as Record<string, CategoryConfig>).map(([key, c]) => ({
  key,
  label: c.label,
  short: SHORT[key] ?? c.label,
  photoRequired: c.photoRequired !== false,
  seasonal: c.seasonal ?? null,
  extra: Object.values(c.fields ?? {}).map((f) => ('from' in f ? f.from.replace(/^extra\./, '') : '')).filter(Boolean),
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

export const EXTRA_QUESTIONS: Record<string, { label: string; type: 'choice' | 'text'; options?: string[]; placeholder?: string }> = {
  size: { label: 'How big is the pothole?', type: 'choice', options: ['Small (~4in)', 'Medium (~28in)', 'Large (~36in)', 'Unknown'] },
  cartIssue: { label: 'What is the issue with your carts?', type: 'choice', options: ['I did not receive my new carts.', 'My old carts were not removed', 'Other'] },
  animalType: { label: 'What kind of animal?', type: 'choice', options: ['Wildlife', 'Domestic'] },
  vehicleDetails: { label: 'Vehicle details (make, color, plate if visible)', type: 'text', placeholder: 'e.g. silver Honda Civic, RI plate ABC-123' },
};

/** Group-first picker (2026-09-28, from the citywide public feed): the first screen is these groups in demand order;
 *  tapping one lists its types, demand-ordered. `icon` is the CategoryIcon key drawn on the group tile.
 *  Keys must exist in shared/categories.ts; `inSeason` still filters the snow types (the snow group hides when empty). */
export type GroupKey = 'trash' | 'streets' | 'trees' | 'parking' | 'lights' | 'snow' | 'other';
export const GROUPS: { key: GroupKey; icon: string; keys: string[] }[] = [
  { key: 'trash', icon: 'bins_carts', keys: ['missed_trash', 'bins_carts', 'illegal_dumping', 'trash_private', 'trash_public'] },
  { key: 'streets', icon: 'pothole', keys: ['pothole', 'sidewalk_repair', 'storm_drain', 'street_flooding'] },
  { key: 'trees', icon: 'tree', keys: ['tree', 'overgrowth'] },
  { key: 'parking', icon: 'parking', keys: ['parking', 'abandoned_vehicle', 'traffic_sign', 'traffic_control'] },
  { key: 'lights', icon: 'street_light', keys: ['street_light', 'traffic_signal', 'downed_wire'] },
  { key: 'snow', icon: 'missed_plowing', keys: ['unshoveled_sidewalk', 'missed_plowing'] },
  { key: 'other', icon: 'other', keys: ['animal_control', 'dead_animal', 'noise', 'graffiti', 'unsure'] },
];
export const groupOf = (key: string): GroupKey | null => GROUPS.find((g) => g.keys.includes(key))?.key ?? null;

/** Quick picks above the groups: the two steady top types citywide, plus one seasonal third. */
export function quickPicks(now = new Date()): string[] {
  const m = now.getMonth();
  const seasonal = m === 10 ? 'street_light' : m === 11 || m <= 1 ? 'unshoveled_sidewalk' : m === 2 ? 'missed_plowing' : 'tree';
  return ['missed_trash', 'pothole', seasonal];
}

const LAST_KEY = 'fixmypvd.lastCategory';
export function rememberCategory(key: string): void { try { localStorage.setItem(LAST_KEY, key); } catch { /* private mode */ } }
export function lastCategory(): string | null { try { return localStorage.getItem(LAST_KEY); } catch { return null; } }
