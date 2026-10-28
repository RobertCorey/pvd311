import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getNearby, type Nearby } from '../api/street';
import type { ReportView } from '../api/types';
import { useT } from '../i18n';
import { track } from '../lib/analytics';
import { likelyOwnCase } from '../lib/streetMap';

/** "Near this request" on the tracking page, one line: how many of the city's own cases within RADIUS_M of the report
 *  in the last DAYS are open (GET /api/street) · "See them on the map" (→ /street at the report's point, the × pin and
 *  the 300 m ring). Rendered only when the report has coordinates. The report itself joins the city's list once the
 *  sync picks it up, so the one case that is most likely this report (lib/streetMap likelyOwnCase) is not counted.
 *  Loading or failed: the map link alone — the page never looks broken for this.
 *  Fetched once per report (module cache): the page re-renders on its 60 s poll and a return to the tab. */

const RADIUS_M = 300;
const DAYS = 30;

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

export default function TrackNear({ id, view }: { id: string; view: ReportView }) {
  const t = useT();
  const lat = view.lat, lng = view.lng;
  const [got, setGot] = useState<{ id: string; data: Nearby } | null>(null);
  const data = got?.id === id ? got.data : cache.get(id) ?? null;

  useEffect(() => {
    if (lat == null || lng == null) return;
    let live = true;
    nearbyFor(id, lat, lng).then((d) => { if (live) setGot({ id, data: d }); }).catch(() => { /* the map link alone */ });
    return () => { live = false; };
  }, [id, lat, lng]);

  // The city's open cases minus the one that is most likely this very report (see the header).
  const own = data && lat != null && lng != null
    ? likelyOwnCase(data.items, { category: view.category, createdAt: view.createdAt, lat, lng, address: view.address })
    : null;
  const open = data ? data.items.filter((c) => c.open && c.id !== own).length : null;
  useEffect(() => {
    if (open != null) track('track_near_view', { open });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per loaded set
  }, [data]);

  if (lat == null || lng == null) return null;
  const count = open == null ? null : open === 0 ? t('track.near.openNone') : open === 1 ? t('track.near.openOne') : t('track.near.open', { n: open });
  return (
    <p className="section track-near">
      {count && <>{count} · </>}
      <Link to={streetHref(lat, lng, view.address)} onClick={() => track('track_near_map')}>{t(open === 1 ? 'track.near.mapOne' : open ? 'track.near.map' : 'track.near.mapEmpty')}</Link>
    </p>
  );
}
