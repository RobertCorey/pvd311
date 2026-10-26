import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { getNearby, type Nearby } from '../api/street';
import type { ReportView } from '../api/types';
import { useT } from '../i18n';
import { track } from '../lib/analytics';
import { likelyOwnCase } from '../lib/streetMap';
import StreetRow from './StreetRow';
import StreetDigestCard, { addressLabel } from './StreetDigestCard';

/** "Near this request" on the tracking page: the city's own cases within RADIUS_M of the report in the last DAYS
 *  (GET /api/street), as one summary line, up to ROWS rows in the /street look, "See them on the map" (→ /street at
 *  the report's point, the × pin and the 300 m ring) and the weekly digest card bound to the same point. Rendered only
 *  when the report has coordinates. The report itself joins the city's list once the sync picks it up, so the one row
 *  that is most likely this report (lib/streetMap likelyOwnCase) is dropped from the rows and the counts.
 *    loading → two row-shaped skeletons (no spinner)     nothing nearby → "yours may be the first", the link, the card
 *    failed  → the heading and the card are dropped (the digest card stays: it needs no feed) — the page never looks
 *              broken for this
 *  The section is ONE root in every state so the digest card is never remounted by the feed: a tap on its CTA during
 *  the skeleton must finish into the same instance when the feed then fails (or a save in flight is lost from the UI
 *  and an owned card re-reads GET /api/me).
 *  Fetched once per report (module cache): the page re-renders on its 60 s poll and a return to the tab. */

const RADIUS_M = 300;
const DAYS = 30;
const ROWS = 3;

const cache = new Map<string, Nearby>();
const inflight = new Map<string, Promise<Nearby>>();
function nearbyFor(id: string, lat: number, lng: number): Promise<Nearby> {
  const hit = cache.get(id);
  if (hit) return Promise.resolve(hit);
  const pending = inflight.get(id);
  if (pending) return pending;
  const p = getNearby(lat, lng, RADIUS_M, DAYS)
    .then((data) => { cache.set(id, data); return data; })
    .finally(() => { inflight.delete(id); });
  inflight.set(id, p);
  return p;
}

/** The /street deep link for the report's point (same shape as the digest mail's: worker/src/street.ts streetUrl). */
export function streetHref(lat: number, lng: number, address: string): string {
  return `/street?lat=${lat.toFixed(5)}&lng=${lng.toFixed(5)}&q=${encodeURIComponent(address)}`;
}

type State = { kind: 'loading' } | { kind: 'ok'; data: Nearby } | { kind: 'error' };

export default function TrackNear({ id, view }: { id: string; view: ReportView }) {
  const t = useT();
  const navigate = useNavigate();
  const lat = view.lat, lng = view.lng;
  const [state, setState] = useState<State>(() => { const hit = cache.get(id); return hit ? { kind: 'ok', data: hit } : { kind: 'loading' }; });
  const [nowMs] = useState(() => Date.now());

  useEffect(() => {
    if (lat == null || lng == null) return;
    let live = true;
    const hit = cache.get(id);
    if (hit) { setState({ kind: 'ok', data: hit }); return; }
    setState({ kind: 'loading' });
    nearbyFor(id, lat, lng)
      .then((data) => { if (live) setState({ kind: 'ok', data }); })
      .catch(() => { if (live) setState({ kind: 'error' }); });
    return () => { live = false; };
  }, [id, lat, lng]);

  // The city's cases minus the one that is most likely this very report (see the header).
  const own = state.kind === 'ok' && lat != null && lng != null
    ? likelyOwnCase(state.data.items, { category: view.category, createdAt: view.createdAt, lat, lng, address: view.address })
    : null;
  const items = state.kind === 'ok' ? state.data.items.filter((c) => c.id !== own) : [];
  const open = items.filter((c) => c.open).length;
  const closed = items.length - open;
  useEffect(() => {
    if (state.kind === 'ok') track('track_near_view', { open, closed });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per loaded set
  }, [state.kind]);

  if (lat == null || lng == null) return null;
  const href = streetHref(lat, lng, view.address);
  const failed = state.kind === 'error';

  const openText = open === 0 ? t('track.near.openNone') : open === 1 ? t('track.near.openOne') : t('track.near.open', { n: open });
  const closedText = closed === 0 ? t('track.near.closedNone') : closed === 1 ? t('track.near.closedOne') : t('track.near.closed', { n: closed });
  const seeMap = (via: 'link' | 'row') => track('track_near_map', via === 'row' ? { via } : undefined);

  return (
    <section className="section track-near" aria-labelledby={failed ? undefined : 'track-near-h'}>
      {!failed && <h2 id="track-near-h">{t('track.near.title')}</h2>}
      {!failed && (
        <div className="card track-near-card" aria-busy={state.kind === 'loading' || undefined}>
          {state.kind === 'loading' ? (
            <div className="track-near-skel" aria-hidden="true">
              {[0, 1].map((i) => (
                <div key={i} className="track-near-skel-row">
                  <span className="track-near-skel-icon" />
                  <span className="track-near-skel-lines"><span className="sk-line sk-type" /><span className="sk-line" /><span className="sk-line sk-sm" /></span>
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <>
              <p className="track-near-none">{t('track.near.none')}</p>
              <Link className="btn btn-secondary track-near-map" to={href} onClick={() => seeMap('link')}>{t('track.near.mapEmpty')}</Link>
            </>
          ) : (
            <>
              <p className="track-near-summary">{t('track.near.summary', { open: openText, closed: closedText })}</p>
              <ul className="street-list">
                {items.slice(0, ROWS).map((c) => (
                  <StreetRow key={c.id} c={c} distanceM={c.distanceM} nowMs={nowMs}
                    onSelect={(cid) => { seeMap('row'); navigate(`${href}&case=${encodeURIComponent(cid)}`); }} />
                ))}
              </ul>
              <Link className="btn btn-secondary track-near-map" to={href} onClick={() => seeMap('link')}>{t('track.near.map')}</Link>
            </>
          )}
        </div>
      )}
      <StreetDigestCard key="digest" lat={lat} lng={lng} label={addressLabel(view.address)} address={view.address} from="track" returnTo={`/r/${id}`} />
    </section>
  );
}
