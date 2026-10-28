import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { followedCases, unfollowCity, type FollowedCase } from '../api/me';
import { shortLabel } from '../lib/categories';
import { useT } from '../i18n';
import CategoryIcon from './CategoryIcon';
import type { FollowEmailState } from './StreetFollow';
import { StatusPill, agoText } from './StreetRow';
import '../screens/Account.css';

/** "City requests you follow" on /my: the city's own cases this account follows (GET /api/me/city), each a card that
 *  opens the case on the /street map, with the city's status pill, "Updated …" / "Closed …" and the Resolution Message
 *  (two lines). Unfollow is optimistic (the row leaves at once; it comes back with an alert when the Worker says no).
 *  Renders nothing when signed out, while loading, or when the account follows nothing — the page's own empty state
 *  is about the account's reports, not this list. `onLoaded(n)` tells the page how many (so it can put this list
 *  first when there are no reports); `email` (StreetFollow's FollowEmailState) decides whether the hint promises a
 *  mail or says why none would come, with a link to Account → Updates. */
export default function FollowedCases({ email, onLoaded }: { email?: FollowEmailState; onLoaded?: (n: number) => void } = {}) {
  const t = useT();
  const session = useSession();
  const [items, setItems] = useState<FollowedCase[] | null>(null);
  const [error, setError] = useState(false);
  const [nowMs] = useState(() => Date.now());
  const titleId = useId();

  useEffect(() => {
    if (!session) { setItems(null); return; }
    let live = true;
    followedCases().then((r) => { if (live) { setItems(r.items); onLoaded?.(r.items.length); } }).catch(() => { if (live) { setItems([]); onLoaded?.(0); } });
    return () => { live = false; };
  }, [session]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!items || items.length === 0) return null;

  async function unfollow(c: FollowedCase) {
    const at = Math.max(0, (items ?? []).findIndex((x) => x.id === c.id)); // its place before it leaves, for the revert
    setError(false);
    setItems((cur) => (cur ?? []).filter((x) => x.id !== c.id));
    try { await unfollowCity(c.id); }
    catch {
      setError(true);
      setItems((cur) => { const list = cur ?? []; if (list.some((x) => x.id === c.id)) return list; const out = [...list]; out.splice(Math.min(at, out.length), 0, c); return out; });
    }
  }

  return (
    <section className="followed-cases" aria-labelledby={titleId}>
      <h2 id={titleId}>{t('my.cityFollowing.title')}</h2>
      {email == null || email === 'ok'
        ? <p className="hint">{t('my.cityFollowing.hint')}</p>
        : <p className="hint">{t('my.cityFollowing.hint.plain')} {t(email === 'off' ? 'street.follow.emailOff' : 'street.follow.unverified')} <Link to="/account/updates">{t('street.follow.account')}</Link></p>}
      {error && <p className="notice notice-error" role="alert">{t('street.follow.error')}</p>}
      <ul className="my-list">
        {items.map((c) => <Row key={c.id} c={c} nowMs={nowMs} onUnfollow={() => unfollow(c)} />)}
      </ul>
    </section>
  );
}

/** The /street deep link to a case: `case=` opens its page; when it is placed, the map view `c=<lat>,<lng>&z=17` frames
 *  it — a view, not a lat/lng point, which would make the case's own spot "where you are" (2026-10-28 audit). The same
 *  shape as the follow mail's link (worker/src/cityfollow.ts caseUrl). */
export function caseHref(c: Pick<FollowedCase, 'id' | 'lat' | 'lng'>): string {
  const view = c.lat != null && c.lng != null ? `&c=${c.lat.toFixed(4)},${c.lng.toFixed(4)}&z=17` : '';
  return `/street?case=${encodeURIComponent(c.id)}${view}`;
}

function Row({ c, nowMs, onUnfollow }: { c: FollowedCase; nowMs: number; onUnfollow: () => void }) {
  const t = useT();
  const title = c.caseType || shortLabel(c.category, t);
  const street = c.street || t('street.noStreet');
  const when = c.open ? agoText(t, c.updatedAt ?? c.createdAt, nowMs) : agoText(t, c.closedAt ?? c.updatedAt ?? c.createdAt, nowMs);
  const whenLine = when ? (c.open ? t('my.cityFollowing.updated', { when }) : t('street.when.closed', { when })) : '';
  return (
    <li className="card followed-card rise">
      <Link to={caseHref(c)} className="my-row followed-link">
        <span className="my-icon" aria-hidden="true"><CategoryIcon k={c.category} size={36} /></span>
        <span className="my-cat">{title}</span>
        <span className="my-addr">{street}</span>
        <span className="muted my-date">{whenLine}</span>
        <span className="my-status-slot"><StatusPill status={c.status} /></span>
        {!c.open && c.resolution && <span className="my-note">{c.resolution}</span>}
      </Link>
      <button type="button" className="btn btn-ghost followed-unfollow" aria-label={`${t('my.cityFollowing.unfollow')} — ${title}, ${street}`} onClick={onUnfollow}>{t('my.cityFollowing.unfollow')}</button>
    </li>
  );
}
