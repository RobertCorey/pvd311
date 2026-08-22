import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { FeedItem } from '../api/types';
import { getFeed } from '../api/client';
import { PVD_BOUNDS } from '../lib/geo';
import { useT } from '../i18n';
import CategoryIcon from '../components/CategoryIcon';
import Illustration from '../components/Illustration';
import { neighborhoodsFor, shortNeighborhood } from '../lib/neighborhoods';
import type { MapMarker } from '../components/MapView';
import './Feed.css';

// Lazy so the leaflet chunk (and its CSS) never loads on the Report screen.
const MapView = lazy(() => import('../components/MapView'));

type Bbox = [number, number, number, number];
const PVD_BBOX: Bbox = [PVD_BOUNDS.minLng, PVD_BOUNDS.minLat, PVD_BOUNDS.maxLng, PVD_BOUNDS.maxLat];

type T = ReturnType<typeof useT>;

function markerColor(it: FeedItem): string {
  if (it.portalStatus === 'Resolved') return '--success';
  if (it.portalStatus === 'Cancelled' || it.status === 'failed' || it.status === 'needs_attention' || it.status === 'rejected') return '--warn';
  return '--ember';
}
const isOpen = (it: FeedItem) => markerColor(it) === '--ember';
const WEEK_MS = 7 * 86_400_000;

const KNOWN_PORTAL = ['submitted', 'assigned', 'resolved', 'cancelled'];
function portalPill(portalStatus: string, t: T): { label: string; cls: string } {
  const key = portalStatus.toLowerCase();
  const cls = key === 'resolved' ? 'resolved' : key === 'cancelled' ? 'cancelled' : 'sent';
  return { label: KNOWN_PORTAL.includes(key) ? t(`map.portal.${key}`) : portalStatus, cls };
}
const isCity = (it: FeedItem) => it.source === 'city' || it.status === 'city' || it.id.startsWith('city:');
function statusPill(it: FeedItem, t: T): { label: string; cls: string } {
  if (isCity(it)) return it.portalStatus ? portalPill(it.portalStatus, t) : { label: t('map.status.city'), cls: 'sent' };
  if (it.status === 'sent') {
    if (it.portalStatus) return portalPill(it.portalStatus, t);
    return { label: t('map.status.sent'), cls: 'sent' };
  }
  if (it.status === 'failed' || it.status === 'needs_attention' || it.status === 'rejected') return { label: t('map.status.notSent'), cls: 'failed' };
  return { label: t('map.status.waiting'), cls: 'waiting' }; // received | awaiting_review | sending
}

function ageLabel(iso: string | null, t: T): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return t('map.age.now');
  const m = Math.floor(s / 60);
  if (m < 60) return t('map.age.minutes', { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t('map.age.hours', { n: h });
  const d = Math.floor(h / 24);
  if (d < 7) return t('map.age.days', { n: d });
  return t('map.age.weeks', { n: Math.floor(d / 7) });
}

export default function Feed() {
  const t = useT();
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const reqIdRef = useRef(0);
  const debounceRef = useRef<number | undefined>(undefined);

  const load = useCallback(async (bbox: Bbox) => {
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(false);
    try {
      const res = await getFeed(bbox, 100);
      if (id !== reqIdRef.current) return; // a newer request superseded this one
      setItems(res.items);
    } catch {
      if (id !== reqIdRef.current) return;
      setError(true);
    } finally {
      if (id === reqIdRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    load(PVD_BBOX);
    return () => window.clearTimeout(debounceRef.current);
  }, [load]);

  const onMoveEnd = useCallback((bbox: Bbox) => {
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => load(bbox), 500);
  }, [load]);

  const markers = useMemo<MapMarker[]>(
    () =>
      (items ?? [])
        .filter((it) => Number.isFinite(it.lat) && Number.isFinite(it.lng))
        .map((it) => ({ id: it.id, lat: it.lat, lng: it.lng, label: it.categoryLabel, color: markerColor(it), open: isOpen(it), href: isCity(it) ? undefined : `/r/${it.id}` })),
    [items],
  );
  // Neighborhoods are first-class: resolve each row's hood (lazy data module) and rank the busiest.
  const [hoods, setHoods] = useState<Record<string, string>>({});
  useEffect(() => {
    const list = (items ?? []).filter((it) => Number.isFinite(it.lat) && Number.isFinite(it.lng));
    if (!list.length) { setHoods({}); return; }
    let cancelled = false;
    neighborhoodsFor(list).then((names) => {
      if (cancelled) return;
      const m: Record<string, string> = {};
      names.forEach((n, i) => { if (n) m[list[i].id] = n; });
      setHoods(m);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [items]);
  const topHoods = useMemo(() => {
    const counts = new Map<string, number>();
    for (const it of items ?? []) { const h = hoods[it.id]; if (h && isOpen(it)) counts.set(h, (counts.get(h) ?? 0) + 1); }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [items, hoods]);

  const stats = useMemo(() => {
    const list = items ?? [];
    const since = Date.now() - WEEK_MS;
    const recent = (it: FeedItem) => { const t = it.createdAt ? new Date(it.createdAt).getTime() : NaN; return Number.isFinite(t) && t >= since; };
    return { open: list.filter(isOpen).length, resolved: list.filter((it) => it.portalStatus === 'Resolved').length, week: list.filter(recent).length };
  }, [items]);

  const showSkeleton = loading && items === null;

  return (
    <section className="section feed">
      <h2>{t('map.title')}</h2>
      <p className="hint">{t('map.subtitle')}</p>

      {items && items.length > 0 && (
        <dl className="feed-stats rise" aria-label={t('map.stats.label')}>
          <div className="feed-stat feed-stat--open"><dt>{t('map.stats.open')}</dt><dd>{stats.open}</dd></div>
          <div className="feed-stat feed-stat--resolved"><dt>{t('map.stats.resolved')}</dt><dd>{stats.resolved}</dd></div>
          <div className="feed-stat"><dt>{t('map.stats.week')}</dt><dd>{stats.week}</dd></div>
        </dl>
      )}
      {topHoods.length > 0 && (
        <ul className="feed-hoods rise" aria-label={t('map.hoods.label')}>
          {topHoods.map(([name, n]) => <li key={name} className="hood-chip"><span className="hood-name">{shortNeighborhood(name)}</span><span className="hood-n">{n}</span></li>)}
        </ul>
      )}

      <div className="feed-map">
        <Suspense fallback={<div className="feed-map-skeleton" aria-hidden="true" />}>
          <MapView markers={markers} onMoveEnd={onMoveEnd} ariaLabel={t('map.mapLabel')} />
        </Suspense>
      </div>

      <div className="feed-list-wrap" aria-live="polite" aria-busy={loading}>
        {showSkeleton ? (
          <ul className="feed-list" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <li key={i}><div className="card feed-row feed-row--skeleton"><span className="sk sk-icon" /><span className="sk sk-line" /><span className="sk sk-pill" /><span className="sk sk-sub" /></div></li>
            ))}
          </ul>
        ) : error ? (
          <div className="notice notice-error feed-state" role="alert">
            <span>{t('map.error')}</span>
            <button type="button" className="btn btn-ghost feed-retry" onClick={() => load(PVD_BBOX)}>{t('map.retry')}</button>
          </div>
        ) : items && items.length > 0 ? (
          <ul className="feed-list">
            {items.map((it) => {
              const pill = statusPill(it, t);
              return (
                <li key={it.id}>
                  {(() => {
                    const inner = (<>
                      <span className="feed-icon" aria-hidden="true"><CategoryIcon k={it.category} /></span>
                      <span className="feed-cat">{it.categoryLabel}</span>
                      <span className={`feed-pill feed-pill--${pill.cls}`}>{pill.label}</span>
                      <span className="feed-addr">{it.address.replace(/,\s*Providence.*$/i, '')}{hoods[it.id] && <span className="feed-hood"> · {shortNeighborhood(hoods[it.id])}</span>}{isCity(it) && <span className="feed-source muted"> · {t('map.source.city')}</span>}</span>
                      <span className="feed-age muted">{ageLabel(it.createdAt, t)}</span>
                    </>);
                    const cls = `card feed-row rise${isOpen(it) ? ' feed-row--open' : ''}`;
                    return isCity(it)
                      ? <div className={`${cls} feed-row--city`}>{inner}</div>
                      : <Link to={`/r/${it.id}`} className={cls}>{inner}</Link>;
                  })()}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="empty feed-empty rise">
            <Illustration kind="street" className="illo" />
            <h2>{t('empty.map.title')}</h2>
            <p className="muted">{t('map.empty')}</p>
          </div>
        )}
      </div>
    </section>
  );
}
