/**
 * streetwatch.ts — "Street watch": a push the moment the 30-minute sync (citycases.ts syncCityCases) first sees a located
 * city case within WATCH_RADIUS_M of one of an account's saved addresses (users/{uid}.addresses[], the same list the
 * Monday street digest reads). Opt-in via prefs.streetWatch (PATCH /api/me); PUSH ONLY — an email per new case would be
 * spam — so an account without a push subscription (push.ts) gets nothing, and the app does not offer the switch until
 * "Notify me on this phone" is on.
 *
 * Rules, all in the pure matchWatchers:
 *   - one push per case per account, even when two of their addresses are in range (the nearest address names it);
 *   - never for a case the city created more than WATCH_MAX_AGE_MS before the run (createdAt vs now) — the index's first
 *     run, a backfill or a long outage sees hundreds of "new" cases and must not flood phones; a case without a created
 *     time cannot be aged and is skipped for the same reason;
 *   - never for Draft rows (the /street feed skips them too — a draft is not a report yet), never for an unlocated case;
 *   - never for the account's own just-filed report when its portal GUID is on one of their recent reports
 *     (portalEntityId / portalDraft.entityId — one findReportsByOwner read per account with a hit, so it costs nothing
 *     on the runs that have none).
 *
 * runStreetWatch reads the opted-in accounts (≤ WATCH_USERS_LIMIT, a Firestore equality query) only when the run has
 * fresh located cases, sends through push.pushAll, logs kind 'watch.pushed' with counts, and never throws into the sync.
 */
import type { Env, ReportDoc, SavedAddress, Store, UserDoc } from './contracts.js';
import { hoodOf } from '../../shared/neighborhoods.js';
import { caseUrl } from './cityfollow.js';
import { haversineMeters } from './street.js';
import { ensureVapid, hasPush, logPushes, pushAll, type PushPayload, type VapidKeys } from './push.js';
import { logEvent } from './health.js';

export const WATCH_RADIUS_M = 300;
export const WATCH_MAX_AGE_MS = 2 * 3_600_000;
export const WATCH_USERS_LIMIT = 500;
/** Newest reports read per account with a hit when checking "is this their own case" (a just-filed report is the newest). */
export const OWN_REPORTS_LOOKBACK = 20;

/** What the sync knows about a case it just added: the grid row plus the coordinates it geocoded in the same loop. */
export interface WatchCase {
  id: string;
  caseType: string;
  street: string;
  status: string;
  createdAt: string | null;
  lat: number | null;
  lng: number | null;
}

export interface WatchHit { user: UserDoc; case: WatchCase; address: SavedAddress; distanceM: number }

export interface WatchOpts { now: number; radiusM: number; maxAgeMs: number }

const located = (c: WatchCase): c is WatchCase & { lat: number; lng: number } =>
  typeof c.lat === 'number' && typeof c.lng === 'number' && Number.isFinite(c.lat) && Number.isFinite(c.lng);

/** A case the watch may tell anyone about: located, not a draft, created within `maxAgeMs` of `now` (unknown age → no). */
export function watchable(c: WatchCase, o: { now: number; maxAgeMs: number }): boolean {
  if (!located(c) || /^draft$/i.test(c.status)) return false;
  if (typeof c.createdAt !== 'string' || !c.createdAt) return false;
  const created = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(c.createdAt) ? c.createdAt : c.createdAt + 'Z');
  if (Number.isNaN(created)) return false;
  return o.now - created <= o.maxAgeMs;
}

/**
 * Which account hears about which case: for every watchable case and every opted-in account with a subscription, the
 * nearest saved address within `radiusM` — one hit per (account, case). Case order, then account order. Pure.
 * `prefs.streetWatch` is re-checked here so a stale query hit (the pref just turned off) still gets nothing.
 */
export function matchWatchers(newCases: WatchCase[], users: UserDoc[], o: WatchOpts): WatchHit[] {
  const out: WatchHit[] = [];
  const cases = newCases.filter((c): c is WatchCase & { lat: number; lng: number } => watchable(c, o));
  for (const c of cases) {
    const told = new Set<string>(); // one hit per account per case, even if `users` names an account twice
    for (const u of users) {
      if (!u || told.has(u.uid) || u.prefs?.streetWatch !== true || !hasPush(u)) continue;
      let best: WatchHit | null = null;
      for (const a of u.addresses ?? []) {
        if (typeof a.lat !== 'number' || typeof a.lng !== 'number') continue;
        const d = haversineMeters(a.lat, a.lng, c.lat, c.lng);
        if (d > o.radiusM) continue;
        if (!best || d < best.distanceM) best = { user: u, case: c, address: a, distanceM: Math.round(d) };
      }
      if (best) { out.push(best); told.add(u.uid); }
    }
  }
  return out;
}

/**
 * The push (push.ts) for one hit: "New near <label>" (the saved address's label, else its address) / "<caseType> · <street>"
 * (+ " · <neighborhood>" when the point falls inside one of the 25 official rings; a blank street is left out), opening
 * the case's card on the map (cityfollow.caseUrl), tagged per case so two addresses in range never stack two cards.
 */
export function streetWatchPush(hit: WatchHit, base: string): PushPayload {
  const c = hit.case;
  const hood = located(c) ? hoodOf(c.lat, c.lng) : null;
  const body = [c.caseType.trim(), c.street.trim(), hood ?? ''].filter(Boolean).join(' · ');
  return {
    title: `New near ${hit.address.label.trim() || hit.address.address.trim()}`,
    body,
    url: caseUrl(base, c.id, c.lat, c.lng),
    tag: `watch:${c.id}`,
  };
}

/** The portal GUIDs (lower-case) this account's reports carry — portalEntityId once filed, the draft's before that. */
export function ownCaseIds(reports: ReportDoc[]): Set<string> {
  const ids = new Set<string>();
  for (const r of reports) {
    const filed = (r as unknown as { portalEntityId?: unknown }).portalEntityId;
    if (typeof filed === 'string' && filed) ids.add(filed.toLowerCase());
    const draft = r.portalDraft?.entityId;
    if (typeof draft === 'string' && draft) ids.add(draft.toLowerCase());
  }
  return ids;
}

export interface WatchRun { cases: number; users: number; hits: number; pushed: number; skippedOwn: number }

/**
 * From the end of syncCityCases, with the cases that run added (the sync has them in hand — no re-read). Reads the
 * opted-in accounts only when at least one of them is watchable, drops hits on an account's own report, pushes once per
 * hit (pushAll — per phone inside), logs 'watch.pushed' (and push.ts's 'push.sent', source street_watch) when anything
 * matched. Never throws: a failure is logged and the sync goes on.
 */
export async function runStreetWatch(env: Env, store: Store, o: { newCases: WatchCase[]; now?: number }): Promise<WatchRun> {
  const now = o.now ?? Date.now();
  const run: WatchRun = { cases: 0, users: 0, hits: 0, pushed: 0, skippedOwn: 0 };
  try {
    const fresh = o.newCases.filter((c) => watchable(c, { now, maxAgeMs: WATCH_MAX_AGE_MS }));
    run.cases = fresh.length;
    if (!fresh.length) return run;
    const users = await store.listStreetWatchUsers(WATCH_USERS_LIMIT);
    run.users = users.length;
    let hits = matchWatchers(fresh, users, { now, radiusM: WATCH_RADIUS_M, maxAgeMs: WATCH_MAX_AGE_MS });
    if (!hits.length) return run;

    // Not for your own just-filed report: one read of the account's newest reports per account with a hit.
    const own = new Map<string, Set<string>>();
    for (const uid of new Set(hits.map((h) => h.user.uid))) {
      try { own.set(uid, ownCaseIds(await store.findReportsByOwner(uid, OWN_REPORTS_LOOKBACK))); }
      catch (e) { console.warn('[watch] own-report check failed:', e instanceof Error ? e.message : e); }
    }
    const before = hits.length;
    hits = hits.filter((h) => !own.get(h.user.uid)?.has(h.case.id.toLowerCase()));
    run.skippedOwn = before - hits.length;
    run.hits = hits.length;
    if (!hits.length) return run;

    const base = env.APP_BASE_URL ?? 'https://fixmypvd.org';
    let keys: VapidKeys | null = null;
    const pushedTo = new Set<string>();
    for (const h of hits) {
      try {
        keys ??= await ensureVapid(store);
        const n = await pushAll(store, h.user, streetWatchPush(h, base), keys);
        run.pushed += n;
        if (n) pushedTo.add(h.user.uid);
      } catch (e) { console.error('[watch] push failed:', e instanceof Error ? e.message : e); }
    }
    console.log(`[watch] ${run.hits} hit${run.hits === 1 ? '' : 's'} across ${pushedTo.size} account${pushedTo.size === 1 ? '' : 's'}, ${run.pushed} pushed${run.skippedOwn ? `, ${run.skippedOwn} own skipped` : ''}`);
    await logEvent(store, { level: 'info', kind: 'watch.pushed', msg: `Street watch: ${run.pushed} push${run.pushed === 1 ? '' : 'es'} for ${run.hits} new case${run.hits === 1 ? '' : 's'} near ${pushedTo.size} account${pushedTo.size === 1 ? '' : 's'}`, data: { ...run, accounts: pushedTo.size } });
    await logPushes(store, 'street_watch', { users: pushedTo.size, sent: run.pushed });
    return run;
  } catch (e) {
    console.error('[watch] failed:', e instanceof Error ? e.message : e);
    return run;
  }
}
