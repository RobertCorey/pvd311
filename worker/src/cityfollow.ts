/**
 * cityfollow.ts — follow any public city case (cityCases/{guid}, citycases.ts) from its card on /street, and hear
 * once by email when the city moves its status (Rob, 2026-10-25: "make the app more something you'd want to check in on").
 * Mirrors following our own reports (me.ts /api/me/following, notify.ts): users/{uid}.cityFollowing (GUIDs, newest
 * first, ≤ MAX_CITY_FOLLOWING) ↔ cityCases/{guid}.followerUids (≤ MAX_CASE_FOLLOWERS). The pure parts live here; the
 * routes are in me.ts and the sender in citycases.ts (notifyCityFollowers).
 */
import type { UserDoc } from './contracts.js';
import { CLOSED, closedAt, type CaseLike } from './cityinsights.js';
import { statusPhrase } from './notify.js';
import { hasPush, type PushPayload } from './push.js';

export const MAX_CITY_FOLLOWING = 100;  // per account
export const MAX_CASE_FOLLOWERS = 200;  // per case
export const CITY_GUID_RE = /^[0-9a-f-]{36}$/;

/** GET /api/me/city item — the card's facts plus when this account followed it and when the city last moved it. */
export interface FollowedCase {
  id: string; caseType: string; category: string; street: string; status: string; open: boolean;
  createdAt: string | null; closedAt: string | null; resolution: string | null;
  lat: number | null; lng: number | null;
  followedAt: string | null;   // when this account followed it (null for follows recorded before it was kept)
  updatedAt: string | null;    // statusAt — when we saw the city last move it
}

type Doc = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const iso = (v: unknown): string | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v + 'Z');
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};

/** cityCases/{guid} document → the followed-case view. `open` = status outside Resolved/Closed/Cancelled/Merged;
 *  `closedAt` = the city's resolution date, else the close we watched happen (cityinsights.closedAt), closed cases only. */
export function followedCaseView(doc: Doc, followedAt?: string | null): FollowedCase {
  const status = str(doc.status);
  const open = !CLOSED.has(status);
  const closed = open ? null : closedAt(doc as unknown as CaseLike);
  const detail = (doc.detail ?? null) as { resolution?: string | null } | null;
  return {
    id: str(doc.id), caseType: str(doc.caseType), category: str(doc.category) || 'unsure', street: str(doc.street), status, open,
    createdAt: iso(doc.createdAt),
    closedAt: closed != null ? new Date(closed).toISOString() : null,
    resolution: (typeof detail?.resolution === 'string' && detail.resolution.trim()) || null,
    lat: num(doc.lat), lng: num(doc.lng),
    followedAt: followedAt ?? null,
    updatedAt: iso(doc.statusAt),
  };
}

/** The case's card on the map: /street?case=<guid>, plus lat/lng when the case is located (the page centres there). */
export function caseUrl(base: string, guid: string, lat: number | null, lng: number | null): string {
  const loc = lat != null && lng != null ? `&lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}` : '';
  return `${base.replace(/\/+$/, '')}/street?case=${encodeURIComponent(guid)}${loc}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const longDay = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });

/**
 * Subject + HTML for "the city moved a case you follow". Same neutral voice as notify.ts (the city's "Resolved" is
 * not our "fixed"): we say what the city did, and quote its status and Resolution Message verbatim.
 */
export function cityFollowEmail(o: { caseType: string; street: string; from: string | null; to: string; resolution: string | null; createdAt: string | null; url: string }): { subject: string; html: string } {
  const street = o.street.trim();
  const where = street ? ` on ${street}` : '';
  const subject = `City update: ${o.caseType}${where} — ${o.to}`;
  const phrase = statusPhrase(o.to).replace(/\byour request\b/, 'a request you follow');
  const change = o.from && o.from !== o.to ? `<b>${esc(o.from)}</b> → <b>${esc(o.to)}</b>` : `<b>${esc(o.to)}</b>`;
  const note = o.resolution
    ? `<p style="margin-bottom:4px">The city's note:</p><blockquote style="margin:0 0 1em;padding:8px 12px;border-left:3px solid #ccc;white-space:pre-wrap">${esc(o.resolution)}</blockquote>`
    : '';
  const reported = o.createdAt ? `<p>Reported ${esc(longDay(o.createdAt))}.</p>` : '';
  const html = `<p>${esc(phrase)}: <b>${esc(o.caseType)}</b>${esc(where)}.</p>`
    + `<p>City status: ${change}</p>${note}${reported}`
    + `<p><a href="${esc(o.url)}">See it on the map</a>.</p>`
    + `<p style="color:#888">You follow this request on FixMyPVD — unfollow on its card. FixMyPVD is an independent project, not affiliated with the City of Providence.</p>`;
  return { subject, html };
}

/**
 * Who hears about a change: followers with a verified email whose prefs.emailUpdates is on, one per mailbox. With
 * `guid`, the account's own list must still hold the case (a follow trimmed off the end of a full list is stale).
 * Never the city. A missing user doc is just skipped.
 */
export function eligibleFollowers(users: (UserDoc | null | undefined)[], guid?: string): UserDoc[] {
  const seen = new Set<string>();
  const out: UserDoc[] = [];
  for (const u of users) {
    if (!u?.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(u.email) || !u.emailVerified || u.prefs?.emailUpdates === false) continue;
    if (guid && !(u.cityFollowing ?? []).includes(guid)) continue;
    const key = u.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}

/**
 * The same move as a push (push.ts): title "City update: <type>", body "<street> — <old> → <new>", plus " · " and the
 * first 80 characters of the city's Resolution Message when the new status is a close. `url` = the card, tag = the
 * case, so a later move on the same case replaces the earlier notification instead of stacking.
 */
export function cityFollowPush(o: { caseType: string; street: string; from: string | null; to: string; resolution: string | null; url: string; guid: string }): PushPayload {
  const street = o.street.trim();
  const change = o.from && o.from !== o.to ? `${o.from} → ${o.to}` : o.to;
  const note = CLOSED.has(o.to) && o.resolution ? ` · ${o.resolution.replace(/\s+/g, ' ').trim().slice(0, 80)}` : '';
  return { title: `City update: ${o.caseType}`, body: `${street ? `${street} — ` : ''}${change}${note}`, url: o.url, tag: `case:${o.guid}` };
}

/**
 * Who gets the push: followers whose own list still holds the case and who subscribed a phone. A subscription is the
 * opt-in, so email settings (verified, emailUpdates) do not apply here; one entry per account.
 */
export function pushFollowers(users: (UserDoc | null | undefined)[], guid: string): UserDoc[] {
  const seen = new Set<string>();
  const out: UserDoc[] = [];
  for (const u of users) {
    if (!u || seen.has(u.uid) || !hasPush(u) || !(u.cityFollowing ?? []).includes(guid)) continue;
    seen.add(u.uid);
    out.push(u);
  }
  return out;
}
