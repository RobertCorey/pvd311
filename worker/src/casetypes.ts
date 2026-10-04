/**
 * casetypes.ts — daily census of the portal's case-type list (the Step-1 lookup modal), read-only.
 *
 * The registry (shared/categories.ts) maps our keys to case types BY GUID, so a rename never breaks a
 * submission — but it does break the wildcard search that narrows the modal to the GUID's page, and a
 * type the city ADDS is one residents can't pick until we map it. The city already renamed one type
 * between the Aug-21 census and Oct 1 ("I am unsure…" → "I do not know know how to classify…").
 *
 * runDaily: Portal.listCaseTypes() → diff against meta/caseTypes (last snapshot) and the registry →
 * event `canary.casetypes` + alert mail when something changed; the snapshot rolls forward so a change
 * mails once, not daily.
 */
import { CATEGORIES } from '../../shared/categories.js';

export interface CaseType { id: string; name: string }

export interface CaseTypeDelta {
  /** In the live list, not in the previous snapshot. */
  added: CaseType[];
  /** In the previous snapshot, gone from the live list. */
  removed: CaseType[];
  /** Same GUID, different name than the previous snapshot. */
  renamed: { id: string; from: string; to: string }[];
  /** Registry entries whose GUID is not in the live list — a submit would fail "census may be stale". */
  registryMissing: { key: string; name: string; id: string }[];
  /** Registry entries whose portalCaseTypeName differs from the live name (GUID still present). */
  registryRenamed: { key: string; from: string; to: string }[];
}

/**
 * A partial read must never become the snapshot (2026-10-04: a pager race read 5 of 13 pages → "78 removed" mail
 * and a 50-type snapshot). The list has held at 126–128 since Aug 2026; a one-day drop past a fifth is a scrape
 * fault, not the city. Exported for the unit test.
 */
export const CASE_TYPE_FLOOR = 100;
export function assertCaseTypeListComplete(liveCount: number, prevCount: number | null): void {
  if (liveCount < CASE_TYPE_FLOOR) throw new Error(`case-type list looks truncated: ${liveCount} rows (floor ${CASE_TYPE_FLOOR})`);
  if (prevCount != null && liveCount < prevCount * 0.8) throw new Error(`case-type list looks truncated: ${liveCount} rows vs ${prevCount} in the last snapshot`);
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

export function diffCaseTypes(prev: CaseType[] | null, live: CaseType[]): CaseTypeDelta {
  const liveById = new Map(live.map((t) => [t.id, norm(t.name)]));
  const prevById = new Map((prev ?? []).map((t) => [t.id, norm(t.name)]));
  const d: CaseTypeDelta = { added: [], removed: [], renamed: [], registryMissing: [], registryRenamed: [] };
  if (prev) {
    for (const [id, name] of liveById) {
      const was = prevById.get(id);
      if (was == null) d.added.push({ id, name });
      else if (was !== name) d.renamed.push({ id, from: was, to: name });
    }
    for (const [id, name] of prevById) if (!liveById.has(id)) d.removed.push({ id, name });
  }
  for (const [key, cfg] of Object.entries(CATEGORIES)) {
    const liveName = liveById.get(cfg.portalCaseTypeGuid);
    if (liveName == null) d.registryMissing.push({ key, name: cfg.portalCaseTypeName, id: cfg.portalCaseTypeGuid });
    else if (liveName !== norm(cfg.portalCaseTypeName)) d.registryRenamed.push({ key, from: cfg.portalCaseTypeName, to: liveName });
  }
  const byName = (a: { name?: string; to?: string }, b: { name?: string; to?: string }) => (a.name ?? a.to ?? '').localeCompare(b.name ?? b.to ?? '');
  d.added.sort(byName); d.removed.sort(byName); d.renamed.sort(byName);
  return d;
}

/** True when anything moved since the previous snapshot (registry drift alone does not re-alert daily). */
export const caseTypesChanged = (d: CaseTypeDelta) => d.added.length + d.removed.length + d.renamed.length > 0;

export function summarizeCaseTypes(d: CaseTypeDelta): string {
  const parts: string[] = [];
  if (d.added.length) parts.push(`${d.added.length} added`);
  if (d.removed.length) parts.push(`${d.removed.length} removed`);
  if (d.renamed.length) parts.push(`${d.renamed.length} renamed`);
  if (d.registryMissing.length) parts.push(`${d.registryMissing.length} registry GUIDs missing`);
  if (d.registryRenamed.length) parts.push(`${d.registryRenamed.length} registry names stale`);
  return parts.join(', ') || 'no change';
}

/** Alert-mail body (HTML). Lists the concrete types so Rob can map/rename without opening the portal. */
export function caseTypesHtml(d: CaseTypeDelta, esc: (s: string) => string): string {
  const li = (items: string[]) => (items.length ? `<ul>${items.map((s) => `<li>${s}</li>`).join('')}</ul>` : '');
  return [
    d.added.length ? `<p><b>New in the portal</b> (unmapped until added to shared/categories.ts):</p>${li(d.added.map((t) => `${esc(t.name)} <code>${t.id}</code>`))}` : '',
    d.removed.length ? `<p><b>Gone from the portal</b>:</p>${li(d.removed.map((t) => `${esc(t.name)} <code>${t.id}</code>`))}` : '',
    d.renamed.length ? `<p><b>Renamed</b>:</p>${li(d.renamed.map((t) => `${esc(t.from)} → ${esc(t.to)}`))}` : '',
    d.registryMissing.length ? `<p><b>Registry entries whose GUID is missing live</b> (submits for these will fail):</p>${li(d.registryMissing.map((t) => `${esc(t.key)}: ${esc(t.name)}`))}` : '',
    d.registryRenamed.length ? `<p><b>Registry names stale</b> (GUID fine; update portalCaseTypeName/portalSearchTerm):</p>${li(d.registryRenamed.map((t) => `${esc(t.key)}: ${esc(t.from)} → ${esc(t.to)}`))}` : '',
  ].join('');
}
