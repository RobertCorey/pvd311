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
 *     on the runs that have none);
 *   - only for the picker groups the account chose under "Only tell me about…" (prefs.watchGroups, watchgroups.ts
 *     groupAllowed: the case's category key → its group, 'other' when unmapped; an empty list = everything). Applied in
 *     matchWatchers, i.e. before a hit is pushed OR held for the morning, and again by the morning catch-up against the
 *     selection as it stands then (each held item records the case's category), so a selection narrowed overnight
 *     applies to the catch-up too.
 *
 * runStreetWatch reads the opted-in accounts (≤ WATCH_USERS_LIMIT, a Firestore equality query) only when the run has
 * fresh located cases, sends through push.pushAll, logs kind 'watch.pushed' with counts, and never throws into the sync.
 *
 * QUIET HOURS (22:00–07:00 America/New_York, isQuietHour): nobody wants a 3 AM buzz about a noise complaint. A sync in
 * that window pushes nothing; the hits it would have pushed go to meta/watchOvernight instead (recordOvernight — append,
 * one item per account × case, newest OVERNIGHT_CAP kept; the 2-hour age rule still applies at record time). The record
 * is flushed by runWatchMorning — ONE "Overnight near <label>" push per account that still has the pref and a
 * subscription, then the record is cleared — from two places: the daily job (engine.runDaily, 11:00 UTC = 07:00 EDT /
 * 06:00 EST) and the first awake syncs (07:00–08:59 ET, isSyncFlushHour — in winter the daily fires inside quiet hours,
 * so without this the 06:00/06:30 ET hits would never be pushed). A run outside 05:00–09:00 ET (a manual /admin/daily)
 * leaves the record for the next proper morning; an item whose case is older than MORNING_MAX_AGE_MS (13 h, derived) by
 * then is a stale record and is dropped, not pushed.
 */
import type { Env, ReportDoc, SavedAddress, Store, UserDoc } from './contracts.js';
import { hoodOf } from '../../shared/neighborhoods.js';
import { caseUrl } from './cityfollow.js';
import { haversineMeters, streetUrl } from './street.js';
import { ensureVapid, hasPush, logPushes, pushAll, type PushPayload, type VapidKeys } from './push.js';
import { logEvent } from './health.js';
import { groupAllowed } from './watchgroups.js';

export const WATCH_RADIUS_M = 300;
export const WATCH_MAX_AGE_MS = 2 * 3_600_000;
export const WATCH_USERS_LIMIT = 500;
/** Newest reports read per account with a hit when checking "is this their own case" (a just-filed report is the newest). */
export const OWN_REPORTS_LOOKBACK = 20;

/** Quiet hours, America/New_York: [QUIET_START_H, 24) ∪ [0, QUIET_END_H). */
export const QUIET_START_H = 22;
export const QUIET_END_H = 7;
/** The morning catch-up only runs when the daily fires in [MORNING_FROM_H, MORNING_TO_H) ET — the 11:00 UTC cron lands at 06:00 or 07:00. */
export const MORNING_FROM_H = 5;
export const MORNING_TO_H = 9;
export const OVERNIGHT_META = 'watchOvernight';
export const OVERNIGHT_CAP = 200;
/**
 * An overnight item whose case the city created more than this long before the morning run is a stale record (a night
 * nobody flushed): dropped. Derived, not guessed: the oldest legitimately held case is WATCH_MAX_AGE_MS before the first
 * quiet sync (22:00 ET), and the latest legitimate flush is the last sync inside the morning window (08:30 ET) — a 2 h +
 * 11 h = 13 h span. (10 h, the first cut, dropped every case the 22:00–22:59 syncs held once the 07:00 EDT morning came.)
 * A record resurrected 24 h later still fails it.
 */
export const MORNING_MAX_AGE_MS = ((24 - QUIET_START_H) + MORNING_TO_H) * 3_600_000 + WATCH_MAX_AGE_MS;
export const MORNING_TAG = 'watch:morning';

// ── New York clock (pure; the instant is injected so tests pin EST and EDT dates) ────────

const nyHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' });
/** The hour of the day (0–23) in America/New_York at `nowMs` — DST follows the zone, not the cron. */
export function nyHour(nowMs: number): number {
  const h = nyHourFmt.formatToParts(new Date(nowMs)).find((p) => p.type === 'hour')?.value;
  return Number(h) % 24; // some ICU builds spell midnight "24"
}
/** 22:00 ≤ ET clock < 07:00. */
export const isQuietHour = (nowMs: number): boolean => { const h = nyHour(nowMs); return h >= QUIET_START_H || h < QUIET_END_H; };
/** 05:00 ≤ ET clock < 09:00 — when the morning catch-up may push (the daily job, or the first awake syncs). */
export const isMorningWindow = (nowMs: number): boolean => { const h = nyHour(nowMs); return h >= MORNING_FROM_H && h < MORNING_TO_H; };
/**
 * 07:00 ≤ ET clock < 09:00 — the syncs that flush the overnight record themselves (isSyncFlushHour). The 11:00 UTC daily
 * is 06:00 ET in winter, INSIDE quiet hours: it would clear the record and the 06:00/06:30 syncs would then hold hits
 * nothing flushes until they are stale. So the first awake syncs (07:00, 07:30 — 08:00/08:30 as slack for an evicted
 * cron) run the catch-up too, before their own live pushes; the daily's call is then the main path in summer and a no-op
 * in winter. Both fire at 11:00 UTC in summer; a duplicate from that race carries one tag and replaces on the device.
 */
export const isSyncFlushHour = (nowMs: number): boolean => { const h = nyHour(nowMs); return h >= QUIET_END_H && h < MORNING_TO_H; };

/** What the sync knows about a case it just added: the grid row plus the coordinates it geocoded in the same loop. */
export interface WatchCase {
  id: string;
  caseType: string;
  /** Our category key for the city's type (cityfeed.mapCategory; 'unsure' when none matched) — the "Only tell me about…" filter reads its group. */
  category: string;
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
/** What a push calls a saved address: its label, else the address itself. */
const placeLabel = (a: SavedAddress): string => a.label.trim() || a.address.trim();

/** A case the watch may tell anyone about: located, not a draft, created within `maxAgeMs` of `now` (unknown age → no). */
export function watchable(c: WatchCase, o: { now: number; maxAgeMs: number }): boolean {
  if (!located(c) || /^draft$/i.test(c.status)) return false;
  const created = parseCreated(c.createdAt);
  if (created == null) return false;
  return o.now - created <= o.maxAgeMs;
}

/** The city's created time as ms; a bare ISO (no zone) is read as UTC, like the feed does. null when absent or unreadable. */
export function parseCreated(s: string | null | undefined): number | null {
  if (typeof s !== 'string' || !s) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s + 'Z');
  return Number.isNaN(t) ? null : t;
}

/**
 * Which account hears about which case: for every watchable case and every opted-in account with a subscription whose
 * "Only tell me about…" selection covers the case's group (watchgroups.groupAllowed; an empty selection covers all), the
 * nearest saved address within `radiusM` — one hit per (account, case). Case order, then account order. Pure.
 * `prefs.streetWatch` is re-checked here so a stale query hit (the pref just turned off) still gets nothing.
 */
export function matchWatchers(newCases: WatchCase[], users: UserDoc[], o: WatchOpts): WatchHit[] {
  const out: WatchHit[] = [];
  const cases = newCases.filter((c): c is WatchCase & { lat: number; lng: number } => watchable(c, o));
  for (const c of cases) {
    const told = new Set<string>(); // one hit per account per case, even if `users` names an account twice
    for (const u of users) {
      if (!u || told.has(u.uid) || u.prefs?.streetWatch !== true || !hasPush(u) || !groupAllowed(u, c)) continue;
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
    title: `New near ${placeLabel(hit.address)}`,
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

// ── Overnight record (meta/watchOvernight) ─────────────────────────────────────────────

/** One held hit: what the push would have said, plus what the morning push needs (the case's type, street and created
 *  time for the stale rule; the saved address for the several-items link). `at` = when the sync held it. */
export interface OvernightItem {
  uid: string; caseId: string; label: string; body: string; url: string; at: string;
  caseType: string; street: string; createdAt: string | null;
  /** Our category key (WatchCase.category), so the morning re-checks the "Only tell me about…" selection as it stands
   *  THEN, not as it stood when the sync held the hit; '' on a record written before this field existed → not re-checked. */
  category: string;
  near: { address: string; lat: number | null; lng: number | null };
}
export interface OvernightRecord { items: OvernightItem[]; since: string | null; at?: string }

export const overnightKey = (i: { uid: string; caseId: string }): string => `${i.uid}\u0000${i.caseId}`;

/** The held form of one hit (the same words streetWatchPush would have pushed). */
export function overnightItem(hit: WatchHit, base: string, now: number): OvernightItem {
  const p = streetWatchPush(hit, base);
  const a = hit.address;
  return {
    uid: hit.user.uid, caseId: hit.case.id, label: placeLabel(a), body: p.body, url: p.url, at: new Date(now).toISOString(),
    caseType: hit.case.caseType.trim(), street: hit.case.street.trim(), createdAt: hit.case.createdAt, category: hit.case.category,
    near: { address: a.address, lat: typeof a.lat === 'number' ? a.lat : null, lng: typeof a.lng === 'number' ? a.lng : null },
  };
}

/** Only well-formed items (a string uid + caseId) survive a read; anything else in the doc is ignored. */
export function parseOvernight(rec: unknown): OvernightItem[] {
  const items = (rec as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const out: OvernightItem[] = [];
  for (const x of items) {
    if (!x || typeof x !== 'object') continue;
    const i = x as Record<string, unknown>;
    if (typeof i.uid !== 'string' || !i.uid || typeof i.caseId !== 'string' || !i.caseId) continue;
    const near = (i.near ?? {}) as Record<string, unknown>;
    out.push({
      uid: i.uid, caseId: i.caseId, label: str(i.label), body: str(i.body), url: str(i.url), at: str(i.at),
      caseType: str(i.caseType), street: str(i.street), createdAt: typeof i.createdAt === 'string' && i.createdAt ? i.createdAt : null, category: str(i.category),
      near: { address: str(near.address), lat: num(near.lat), lng: num(near.lng) },
    });
  }
  return out;
}

/** Append `add` to `existing`, one item per account × case (the first record of a pair wins), the newest `cap` kept. Pure. */
export function mergeOvernight(existing: OvernightItem[], add: OvernightItem[], cap = OVERNIGHT_CAP): OvernightItem[] {
  const seen = new Set<string>();
  const out: OvernightItem[] = [];
  for (const i of [...existing, ...add]) {
    const k = overnightKey(i);
    if (seen.has(k)) continue;
    seen.add(k); out.push(i);
  }
  return out.length > cap ? out.slice(out.length - cap) : out;
}

/** Hold `hits` for the morning: read-merge-write of meta/watchOvernight. Returns how many of this run's hits were not
 *  already held (counted before the cap trims, so a full record still reports what the run added).
 *  Never throws; a failed READ holds nothing (losing one run's hits beats overwriting the night's record on a blind write). */
export async function recordOvernight(store: Store, hits: WatchHit[], base: string, now: number): Promise<number> {
  try {
    const prev = await store.getMeta<OvernightRecord>(OVERNIGHT_META);
    const existing = parseOvernight(prev);
    const add = hits.map((h) => overnightItem(h, base, now));
    const items = mergeOvernight(existing, add);
    const nowIso = new Date(now).toISOString();
    const since = existing.length && typeof prev?.since === 'string' && prev.since ? prev.since : nowIso;
    await store.setMeta(OVERNIGHT_META, { items, since, at: nowIso });
    const had = new Set(existing.map(overnightKey));
    return new Set(add.map(overnightKey).filter((k) => !had.has(k))).size;
  } catch (e) {
    console.error('[watch] overnight record failed:', e instanceof Error ? e.message : e);
    return 0;
  }
}

export interface WatchRun {
  cases: number; users: number; hits: number; pushed: number; skippedOwn: number; held: number;
  /** Set on the first awake syncs (isSyncFlushHour): the overnight catch-up this run did before its live pushes. */
  morning?: MorningRun;
}

/**
 * From the end of syncCityCases, with the cases that run added (the sync has them in hand — no re-read). Reads the
 * opted-in accounts only when at least one of them is watchable, drops hits on an account's own report, pushes once per
 * hit (pushAll — per phone inside), logs 'watch.pushed' (and push.ts's 'push.sent', source street_watch) when anything
 * matched. In quiet hours (isQuietHour at `now`) the hits are held in meta/watchOvernight instead (logged 'watch.held');
 * the first awake syncs (isSyncFlushHour) flush that record through runWatchMorning first, whether or not this run added
 * anything. Never throws: a failure is logged and the sync goes on.
 */
export async function runStreetWatch(env: Env, store: Store, o: { newCases: WatchCase[]; now?: number }): Promise<WatchRun> {
  const now = o.now ?? Date.now();
  const run: WatchRun = { cases: 0, users: 0, hits: 0, pushed: 0, skippedOwn: 0, held: 0 };
  try {
    if (isSyncFlushHour(now)) run.morning = await runWatchMorning(env, store, { now }); // never throws
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
    if (isQuietHour(now)) {
      // Quiet hours: hold for runWatchMorning instead of buzzing a phone at 3 AM.
      run.held = await recordOvernight(store, hits, base, now);
      const accounts = new Set(hits.map((h) => h.user.uid)).size;
      console.log(`[watch] quiet hours (${nyHour(now)}:00 ET): ${run.hits} hit${run.hits === 1 ? '' : 's'} across ${accounts} account${accounts === 1 ? '' : 's'} held for the morning (${run.held} new in the record)${run.skippedOwn ? `, ${run.skippedOwn} own skipped` : ''}`);
      await logEvent(store, { level: 'info', kind: 'watch.held', msg: `Street watch: ${run.hits} hit${run.hits === 1 ? '' : 's'} near ${accounts} account${accounts === 1 ? '' : 's'} held for the morning catch-up (quiet hours)`, data: { ...run, accounts } });
      return run;
    }
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

// ── Morning catch-up (runDaily at 11:00 UTC, and the 07:00–08:59 ET syncs) ─────────────

/** '<caseType> · <street>' (a blank part left out). */
const caseLine = (i: OvernightItem): string => [i.caseType.trim(), i.street.trim()].filter(Boolean).join(' · ');

/**
 * ONE push for everything held overnight for one account: "Overnight near <label>" (the first item's saved address;
 * 'your places' when the items name several), body "1 new request: <caseType> · <street>" for one item, else
 * "<n> new requests near your places: <line> · <line>" (the first two), url the case card for one item, else the
 * first item's address page (/street?lat&lng&q — plain /street when that address has no coordinates). One tag, so a
 * second morning replaces, never stacks.
 */
export function morningPush(items: OvernightItem[], base: string): PushPayload {
  const labels = new Set(items.map((i) => i.label.trim()).filter(Boolean));
  const where = labels.size === 1 ? [...labels][0] : 'your places';
  const title = `Overnight near ${where}`;
  if (items.length === 1) return { title, body: `1 new request: ${caseLine(items[0])}`, url: items[0].url, tag: MORNING_TAG };
  const lines = items.slice(0, 2).map(caseLine).filter(Boolean).join(' · ');
  const root = base.replace(/\/+$/, '');
  const near = items[0].near;
  const url = near.lat != null && near.lng != null ? streetUrl(root, { lat: near.lat, lng: near.lng, address: near.address }) : `${root}/street`;
  return { title, body: `${items.length} new requests near your places${lines ? `: ${lines}` : ''}`, url, tag: MORNING_TAG };
}

export interface MorningRun {
  /** false = the daily fired outside 05:00–09:00 ET (a manual run): nothing read, the record kept. */
  ran: boolean;
  items: number; stale: number; accounts: number; skippedOff: number; pushedTo: number; pushed: number;
}

/** Drop the handled items from meta/watchOvernight — re-read first, so a sync that held something while the morning
 *  run was pushing keeps its items for the next morning. */
async function clearOvernight(store: Store, handled: OvernightItem[], now: number): Promise<void> {
  const done = new Set(handled.map(overnightKey));
  const again = await store.getMeta<OvernightRecord>(OVERNIGHT_META).catch(() => null);
  const left = parseOvernight(again).filter((i) => !done.has(overnightKey(i)));
  const nowIso = new Date(now).toISOString();
  const since = left.length ? (typeof again?.since === 'string' && again.since ? again.since : nowIso) : null;
  await store.setMeta(OVERNIGHT_META, { items: left, since, at: nowIso, clearedAt: nowIso });
}

/**
 * From runDaily, and from runStreetWatch on the first awake syncs (isSyncFlushHour): everything the quiet-hour syncs
 * held (meta/watchOvernight), grouped per account, ONE push each (morningPush) to the accounts that still have
 * prefs.streetWatch and a subscription (re-read — the pref may have turned off overnight), naming only the items whose
 * group the account's "Only tell me about…" selection still covers (an account with nothing left counts as skippedOff;
 * an item held before the category was recorded is not re-checked), then the record is cleared.
 * An item whose case is older than MORNING_MAX_AGE_MS is a stale record and is dropped. Outside 05:00–09:00 ET (a
 * manual run) nothing happens and the record is kept. Logs 'watch.morning' (and push.ts's 'push.sent', source
 * street_watch, morning: true) when the record held anything. Never throws.
 */
export async function runWatchMorning(env: Env, store: Store, o: { now?: number } = {}): Promise<MorningRun> {
  const now = o.now ?? Date.now();
  const run: MorningRun = { ran: false, items: 0, stale: 0, accounts: 0, skippedOff: 0, pushedTo: 0, pushed: 0 };
  try {
    if (!isMorningWindow(now)) {
      console.log(`[watch] morning catch-up skipped: ${nyHour(now)}:00 ET is outside ${MORNING_FROM_H}–${MORNING_TO_H}; the overnight record is kept`);
      return run;
    }
    run.ran = true;
    const all = parseOvernight(await store.getMeta<OvernightRecord>(OVERNIGHT_META).catch(() => null));
    run.items = all.length;
    if (!all.length) return run;
    const fresh = all.filter((i) => { const c = parseCreated(i.createdAt); return c != null && now - c <= MORNING_MAX_AGE_MS; });
    run.stale = all.length - fresh.length;
    const byUid = new Map<string, OvernightItem[]>();
    for (const i of fresh) { const list = byUid.get(i.uid); if (list) list.push(i); else byUid.set(i.uid, [i]); }
    run.accounts = byUid.size;

    const base = env.APP_BASE_URL ?? 'https://fixmypvd.org';
    let keys: VapidKeys | null = null;
    for (const [uid, items] of byUid) {
      try {
        const u = await store.getUser(uid);
        if (!u || u.prefs?.streetWatch !== true || !hasPush(u)) { run.skippedOff++; continue; }
        const wanted = items.filter((i) => !i.category || groupAllowed(u, { category: i.category })); // the selection may have narrowed overnight
        if (!wanted.length) { run.skippedOff++; continue; }
        keys ??= await ensureVapid(store);
        const n = await pushAll(store, u, morningPush(wanted, base), keys);
        run.pushed += n;
        if (n) run.pushedTo++;
      } catch (e) { console.error(`[watch] morning push failed for ${uid}:`, e instanceof Error ? e.message : e); }
    }
    await clearOvernight(store, all, now);
    console.log(`[watch] morning catch-up: ${fresh.length} overnight item${fresh.length === 1 ? '' : 's'} across ${run.accounts} account${run.accounts === 1 ? '' : 's'}, ${run.pushed} pushed to ${run.pushedTo}${run.skippedOff ? `, ${run.skippedOff} no longer watching` : ''}${run.stale ? `, ${run.stale} stale dropped` : ''}`);
    await logEvent(store, { level: 'info', kind: 'watch.morning', msg: `Street watch morning catch-up: ${run.pushed} push${run.pushed === 1 ? '' : 'es'} to ${run.pushedTo} account${run.pushedTo === 1 ? '' : 's'} for ${fresh.length} overnight case${fresh.length === 1 ? '' : 's'}`, data: { ...run } });
    await logPushes(store, 'street_watch', { users: run.pushedTo, sent: run.pushed, morning: true });
    return run;
  } catch (e) {
    console.error('[watch] morning catch-up failed:', e instanceof Error ? e.message : e);
    return run;
  }
}
