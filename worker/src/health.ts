/**
 * System visibility: per-subsystem heartbeat + an event stream, both in Firestore so /api/admin/health
 * can show "what's healthy, what broke last, and what happened" without log access.
 *   meta/health_<sub>  { lastOkAt, lastErrorAt, lastError, lastDetail, day, okToday, errToday }
 *   events/<id>        { at, level, kind, msg, reportId?, data? }   (14-day retention, see engine.runDaily)
 * Every call is fire-and-forget safe: telemetry must never break the thing it observes.
 */
import type { Store } from './contracts.js';

export type Subsystem = 'tick' | 'submit' | 'watcher' | 'cityfeed' | 'canary' | 'daily' | 'email' | 'ai' | 'auth_mail' | 'api';
export const SUBSYSTEMS: { key: Subsystem; label: string; freshMs: number | null; staleMs: number | null; what: string; expected: string | null }[] = [
  { key: 'tick', label: 'Engine tick', freshMs: 3 * 60_000, staleMs: 10 * 60_000, what: 'Cron every minute: reaper, gates, review, submit' , expected: 'every minute' },
  { key: 'submit', label: 'Portal submit', freshMs: null, staleMs: null, what: 'Headless browser filing reports on 311.providenceri.gov' , expected: null },
  { key: 'watcher', label: 'Status watcher', freshMs: 45 * 60_000, staleMs: 2 * 3_600_000, what: 'Every 30 min: diff My Requests, email reporters' , expected: 'every 30 min' },
  { key: 'cityfeed', label: 'City feed scrape', freshMs: 45 * 60_000, staleMs: 3 * 3_600_000, what: 'Public-requests feed + geocoding (nearby dedupe)' , expected: 'every 30 min' },
  { key: 'canary', label: 'Portal canary', freshMs: 26 * 3_600_000, staleMs: 50 * 3_600_000, what: 'Daily zero-draft check that the city form has not changed' , expected: 'daily, 7 am' },
  { key: 'daily', label: 'Daily job', freshMs: 26 * 3_600_000, staleMs: 50 * 3_600_000, what: 'Digest, retention, event cleanup' , expected: 'daily, 7 am' },
  { key: 'email', label: 'Email (Resend)', freshMs: null, staleMs: null, what: 'Reporter + admin mail' , expected: null },
  { key: 'ai', label: 'AI moderation', freshMs: null, staleMs: null, what: 'Anthropic intake / server-side moderation' , expected: null },
  { key: 'auth_mail', label: 'Sign-in links', freshMs: null, staleMs: null, what: 'Worker-minted email links' , expected: null },
  { key: 'api', label: 'Public API', freshMs: null, staleMs: null, what: 'Report creation' , expected: null },
];

export interface HealthRec { lastOkAt?: string | null; lastErrorAt?: string | null; lastError?: string | null; lastDetail?: string | null; day?: string; okToday?: number; errToday?: number }
export interface EventDoc { at: string; level: 'info' | 'warn' | 'error'; kind: string; msg: string; reportId?: string | null; data?: Record<string, unknown> | null }

const today = () => new Date().toISOString().slice(0, 10);

async function bump(store: Store, sub: Subsystem, ok: boolean, text: string | null): Promise<void> {
  const id = `health_${sub}`;
  const cur = (await store.getMeta<HealthRec>(id).catch(() => null)) ?? {};
  const d = today();
  const okToday = (cur.day === d ? cur.okToday ?? 0 : 0) + (ok ? 1 : 0);
  const errToday = (cur.day === d ? cur.errToday ?? 0 : 0) + (ok ? 0 : 1);
  const now = new Date().toISOString();
  await store.setMeta(id, ok
    ? { lastOkAt: now, lastDetail: text, day: d, okToday, errToday }
    : { lastErrorAt: now, lastError: text, day: d, okToday, errToday });
}

/** Heartbeat: the subsystem ran and was fine. `detail` is a short human line ("3 rows, 1 change"). */
export function markOk(store: Store, sub: Subsystem, detail?: string): Promise<void> {
  return bump(store, sub, true, detail ? detail.slice(0, 300) : null).catch((e) => { console.error('[health] markOk failed', sub, e); });
}

/** The subsystem failed. Keeps the last error text for the dashboard. */
export function markError(store: Store, sub: Subsystem, err: unknown): Promise<void> {
  const text = (err instanceof Error ? err.message : String(err)).slice(0, 500);
  return bump(store, sub, false, text).catch((e) => { console.error('[health] markError failed', sub, e); });
}

/** Append to the event stream (shown newest-first in /admin → System). Never throws. */
export function logEvent(store: Store, ev: Omit<EventDoc, 'at'>): Promise<void> {
  const doc: EventDoc = { at: new Date().toISOString(), ...ev, msg: ev.msg.slice(0, 500) };
  return store.addEvent(doc).catch((e) => { console.error('[health] addEvent failed', ev.kind, e); });
}

/** Derive a traffic light from the record + freshness thresholds. */
export function deriveStatus(def: (typeof SUBSYSTEMS)[number], rec: HealthRec | null, now = Date.now()): 'ok' | 'warn' | 'error' | 'unknown' {
  if (!rec || (!rec.lastOkAt && !rec.lastErrorAt)) return 'unknown';
  const okAt = rec.lastOkAt ? Date.parse(rec.lastOkAt) : 0;
  const errAt = rec.lastErrorAt ? Date.parse(rec.lastErrorAt) : 0;
  if (def.freshMs != null) {
    const age = now - okAt;
    if (def.staleMs != null && age > def.staleMs) return 'error';
    if (age > def.freshMs) return 'warn';
  }
  if (errAt > okAt) return def.freshMs != null ? 'warn' : 'warn';
  return 'ok';
}
