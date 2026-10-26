/**
 * watchgroups.ts — "Only tell me about…": prefs.watchGroups (PATCH /api/me, me.ts) narrows what an account hears about
 * near its saved addresses to some of the picker's ten level-1 groups (shared/categories.ts GROUP_ORDER — trash, streets,
 * traffic, trees, property, lights, nuisance, water, animals, other). Shared by the two features so they cannot drift:
 *   - the street watch (streetwatch.ts matchWatchers): the instant push, and the morning catch-up — the hits are filtered
 *     before they are held in meta/watchOvernight, and runWatchMorning re-checks each held item's recorded category
 *     against the selection as it stands in the morning;
 *   - the Monday street digest (street.ts runStreetDigest): a section lists only matching cases, and a section with
 *     nothing left sends nothing (no mail, no push).
 * An empty or absent list means everything, which is what every account has until it touches the chip row.
 *
 * A city case carries our category key (cityfeed.mapCategory — 'unsure' when no type matched); its group is that
 * category's `group`, 'other' for 'unsure' and for anything unknown. Pure, no I/O.
 */
import { CATEGORIES, GROUP_ORDER, type GroupKey } from '../../shared/categories.js';

/** The ten groups; a selection can never hold more. */
export const MAX_WATCH_GROUPS = GROUP_ORDER.length;
const GROUPS = new Set<string>(GROUP_ORDER);

export const isGroupKey = (x: unknown): x is GroupKey => typeof x === 'string' && GROUPS.has(x);

/** The level-1 group of a case from its category key: 'other' when the key is missing, 'unsure' or unknown. */
export function caseGroup(c: { category?: unknown }): GroupKey {
  const key = typeof c.category === 'string' ? c.category : '';
  return (Object.prototype.hasOwnProperty.call(CATEGORIES, key) ? CATEGORIES[key].group : null) ?? 'other';
}

/**
 * PATCH /api/me's validation of `prefs.watchGroups`: null / undefined → [] (everything); an array → its known group keys,
 * deduped, in GROUP_ORDER (a set, so the stored order is canonical), ≤ MAX_WATCH_GROUPS — unknown strings and non-strings
 * are dropped, not rejected, so a stale client after a group rename loses that one chip rather than the whole save;
 * anything else (a string, a number, an object) → null, which the route turns into 400 `invalid_groups`.
 */
export function parseWatchGroups(input: unknown): GroupKey[] | null {
  if (input == null) return [];
  if (!Array.isArray(input)) return null;
  const want = new Set<string>(input.filter(isGroupKey));
  return GROUP_ORDER.filter((g) => want.has(g)).slice(0, MAX_WATCH_GROUPS);
}

type WithPrefs = { prefs?: { watchGroups?: unknown } | null } | null | undefined;

/** The account's selection as the route stores it; a corrupt or missing value reads as [] = everything. */
export function watchGroupsOf(u: WithPrefs): GroupKey[] {
  return parseWatchGroups(u?.prefs?.watchGroups) ?? [];
}

/** Does this account want to hear about this case? An empty selection says yes to everything. */
export function groupAllowed(u: WithPrefs, c: { category?: unknown }): boolean {
  const groups = watchGroupsOf(u);
  return groups.length === 0 || groups.includes(caseGroup(c));
}
