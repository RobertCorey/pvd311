import { CATEGORIES, type CategoryConfig } from '@shared/categories';

export interface UiCategory {
  key: string; label: string; short: string; photoRequired: boolean; seasonal: 'winter' | null;
  /** extra-question keys (`extra.<key>` sources in shared/categories.ts) */
  extra: string[];
}

// Picker-friendly short labels; portal-facing labels stay in shared/categories.ts.
const SHORT: Record<string, string> = {
  missed_trash: 'Missed pickup', bins_carts: 'Bins & carts', abandoned_vehicle: 'Abandoned car',
  animal_control: 'Animal issue', unsure: 'Not sure',
};

/** The eight front-and-center categories (Rob: picker first, "Other" expands the rest). */
export const FEATURED: readonly string[] = [
  'pothole', 'street_light', 'missed_trash', 'illegal_dumping', 'abandoned_vehicle', 'parking', 'bins_carts', 'animal_control',
];

export const ALL_CATEGORIES: UiCategory[] = Object.entries(CATEGORIES as Record<string, CategoryConfig>).map(([key, c]) => ({
  key,
  label: c.label,
  short: SHORT[key] ?? c.label,
  photoRequired: c.photoRequired !== false,
  seasonal: c.seasonal ?? null,
  extra: Object.values(c.fields ?? {}).map((f) => ('from' in f ? f.from.replace(/^extra\./, '') : '')).filter(Boolean),
}));

export const byKey = (k: string | null | undefined) => ALL_CATEGORIES.find((c) => c.key === k) ?? null;

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
