/**
 * quota.ts — reporter quota (docs/quota.md). Every report is filed under FixMyPVD's one city 311 account, so one
 * person flooding the city costs everyone; the server is the only authority and the app just displays it.
 *
 *   Per mailbox (paceIdentity): 5/day + 15/week; 60 s minimum gap. Days reset 00:00 America/New_York, weeks Monday 00:00 ET.
 *   Per IP (loose backstop for shared networks): 30/day, no weekly limit, no gap.
 *
 * Records live in Firestore meta `pace_<key>` (same ids as the old 3-min/5-per-UTC-day pacing, whose shape
 * `{ last, day, count }` is read tolerantly — see normalize()). Every accepted POST /api/report counts, including
 * reports later rejected; a reporter's own cancel before filing refunds the day + week it was counted in.
 */
import type { Store } from './contracts.js';

export const QUOTA = {
  day: 5,
  week: 15,
  gapMs: 60_000,
  ipDay: 30,
} as const;

const TZ = 'America/New_York';

export type QuotaReason = 'gap' | 'day' | 'week' | 'ip';
export interface QuotaView {
  dayUsed: number; dayLimit: number; weekUsed: number; weekLimit: number;
  dayResetsAt: string; weekResetsAt: string;
  /** ISO when the next report is accepted; null = now. */
  nextAllowedAt: string | null;
}
/** What a counted report remembers so a cancel refunds the right buckets. */
export interface QuotaSlot { key: string; ipKey: string | null; day: string; week: string }

/** v2 record. `day` = ET date (YYYY-MM-DD), `week` = ET date of that week's Monday. */
type QuotaRec = { v: 2; last: number; day: string; dayCount: number; week: string; weekCount: number };
/** Pre-quota pacing record (`day` was a UTC date). */
interface LegacyRec { last?: number; day?: string; count?: number }

// ── Eastern-time calendar ───────────────────────────────────

const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function etParts(ms: number): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second };
}
const ymd = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => { const [y, m, d] = date.split('-').map(Number); return ymd(y, m, d + n); };

/** ET calendar date of an instant. */
export function etDate(ms: number): string { const p = etParts(ms); return ymd(p.y, p.m, p.d); }
/** ET date of the Monday starting the ISO week that contains this instant. */
export function etWeekStart(ms: number): string {
  const date = etDate(ms);
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((dow + 6) % 7));
}
/** UTC instant of 00:00 America/New_York on an ET date (DST changes happen at 02:00, so midnight is never ambiguous). */
export function etMidnight(date: string): number {
  const t0 = Date.parse(`${date}T00:00:00Z`);
  const probe = t0 + 5 * 3_600_000;          // 00:00 EST / 01:00 EDT that day — before any 02:00 switch
  const p = etParts(probe);
  const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - probe; // −5 h or −4 h
  return t0 - offset;
}

// ── identity ────────────────────────────────────────────────

/** One budget per mailbox, not per uid: strip +tags, lowercase, and collapse gmail dots. */
export function paceIdentity(uid: string, email: string | null | undefined): string {
  if (!email) return uid;
  const m = /^([^@]+)@(.+)$/.exec(email.trim().toLowerCase());
  if (!m) return uid;
  let local = m[1].replace(/\+.*$/, '');
  const domain = m[2];
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}
export const identityKey = (uid: string, email: string | null | undefined) => `u_${paceIdentity(uid, email)}`;
export const ipKey = (ip: string) => `ip_${ip}`;
const metaId = (key: string) => `pace_${key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120)}`;

// ── records ─────────────────────────────────────────────────

/** Bring a stored record (v2 or legacy) into the current ET day/week, zeroing buckets that have rolled over.
 *  Legacy `{ last, day: <UTC date>, count }`: the gap carries over; `count` carries into today's and this week's
 *  buckets only while its UTC day is still the current UTC day (the window the old code itself was enforcing),
 *  so the switch-over neither resets anyone mid-day nor holds anyone longer than the old pacing did. */
function normalize(raw: QuotaRec | LegacyRec | null, now: number): QuotaRec {
  const day = etDate(now), week = etWeekStart(now);
  if (!raw) return { v: 2, last: 0, day, dayCount: 0, week, weekCount: 0 };
  if ((raw as QuotaRec).v === 2) {
    const r = raw as QuotaRec;
    return { v: 2, last: r.last || 0, day, dayCount: r.day === day ? r.dayCount || 0 : 0, week, weekCount: r.week === week ? r.weekCount || 0 : 0 };
  }
  const l = raw as LegacyRec;
  const carried = l.day === new Date(now).toISOString().slice(0, 10) ? Math.max(0, Number(l.count) || 0) : 0;
  return { v: 2, last: Number(l.last) || 0, day, dayCount: carried, week, weekCount: carried };
}

/** Why this identity can't send right now (week before day before gap: the longest wait is the useful one), or null. */
function blockedBy(rec: QuotaRec, now: number): { reason: QuotaReason; until: number } | null {
  const lim = QUOTA;
  if (rec.weekCount >= lim.week) return { reason: 'week', until: etMidnight(addDays(rec.week, 7)) };
  if (rec.dayCount >= lim.day) return { reason: 'day', until: etMidnight(addDays(rec.day, 1)) };
  if (rec.last && now - rec.last < QUOTA.gapMs) return { reason: 'gap', until: rec.last + QUOTA.gapMs };
  return null;
}

function view(rec: QuotaRec, now: number): QuotaView {
  const lim = QUOTA;
  const b = blockedBy(rec, now);
  return {
    dayUsed: rec.dayCount, dayLimit: lim.day, weekUsed: rec.weekCount, weekLimit: lim.week,
    dayResetsAt: new Date(etMidnight(addDays(rec.day, 1))).toISOString(),
    weekResetsAt: new Date(etMidnight(addDays(rec.week, 7))).toISOString(),
    nextAllowedAt: b ? new Date(b.until).toISOString() : null,
  };
}

/** Read-only quota for GET /api/me. */
export async function quotaFor(store: Store, uid: string, email: string | null | undefined, now = Date.now()): Promise<QuotaView> {
  const rec = normalize(await store.getMeta<QuotaRec | LegacyRec>(metaId(identityKey(uid, email))), now);
  return view(rec, now);
}

export type QuotaCheck =
  | { ok: true; quota: QuotaView; slot: QuotaSlot }
  | { ok: false; reason: QuotaReason; retryAfterSec: number; quota: QuotaView };

/** Two phases so one key's rejection never consumes the other key's budget: peek both, then commit both. */
export async function checkQuota(store: Store, o: { uid: string; email: string | null | undefined; ip: string | null; now?: number }): Promise<QuotaCheck> {
  const now = o.now ?? Date.now();
  const idKey = identityKey(o.uid, o.email);
  const ipK = o.ip ? ipKey(o.ip) : null;
  const [idRaw, ipRaw] = await Promise.all([
    store.getMeta<QuotaRec | LegacyRec>(metaId(idKey)),
    ipK ? store.getMeta<QuotaRec | LegacyRec>(metaId(ipK)) : Promise.resolve(null),
  ]);
  const idRec = normalize(idRaw, now);
  const ipRec = ipK ? normalize(ipRaw, now) : null;
  const retry = (until: number) => Math.max(1, Math.ceil((until - now) / 1000));

  const b = blockedBy(idRec, now);
  if (b) return { ok: false, reason: b.reason, retryAfterSec: retry(b.until), quota: view(idRec, now) };
  if (ipRec && ipRec.dayCount >= QUOTA.ipDay) return { ok: false, reason: 'ip', retryAfterSec: retry(etMidnight(addDays(ipRec.day, 1))), quota: view(idRec, now) };

  const idNext: QuotaRec = { ...idRec, last: now, dayCount: idRec.dayCount + 1, weekCount: idRec.weekCount + 1 };
  await store.setMeta(metaId(idKey), idNext);
  if (ipK && ipRec) await store.setMeta(metaId(ipK), { ...ipRec, last: now, dayCount: ipRec.dayCount + 1, weekCount: ipRec.weekCount + 1 });
  return { ok: true, quota: view(idNext, now), slot: { key: idKey, ipKey: ipK, day: idRec.day, week: idRec.week } };
}

/** Give a cancelled report's slot back: −1 in the day and week buckets it was counted in, if those are still current.
 *  (A bucket that has rolled over is already zero, so there is nothing to give back.) The gap is not refunded. */
export async function refundQuota(store: Store, slot: QuotaSlot | null | undefined, now = Date.now()): Promise<void> {
  if (!slot?.key || !slot.day || !slot.week) return;
  for (const key of [slot.key, slot.ipKey]) {
    if (!key) continue;
    const id = metaId(key);
    const raw = await store.getMeta<QuotaRec | LegacyRec>(id);
    if (!raw) continue;
    const rec = normalize(raw, now);
    const dayCount = rec.day === slot.day ? Math.max(0, rec.dayCount - 1) : rec.dayCount;
    const weekCount = rec.week === slot.week ? Math.max(0, rec.weekCount - 1) : rec.weekCount;
    if (dayCount !== rec.dayCount || weekCount !== rec.weekCount) await store.setMeta(id, { ...rec, dayCount, weekCount });
  }
}

export const _test = { normalize, metaId };
