import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { getStreet, getStreetCity, type CityCase, type CityOverview, type StreetResponse } from '../api/street';
import { getMe, saveAddress, updateMe, type Me } from '../api/me';
import { useSession } from '../lib/auth';
import { forwardGeocode, inProvidence, reverseGeocode } from '../lib/geo';
import { track } from '../lib/analytics';
import { useT } from '../i18n';
import CategoryIcon from '../components/CategoryIcon';
import SavedAddresses from '../components/SavedAddresses';
import './Street.css';

/** "My street": everyone's 311 cases within a few blocks of an address (worker/src/street.ts), plus the weekly email opt-in.
 *  URL carries the point (?lat&lng&q=<address>) so a view is shareable and the digest email can link straight to it. */

const RADII = [{ m: 150, key: 'block' }, { m: 300, key: 'blocks' }, { m: 800, key: 'hood' }] as const;
const WIDEST = 800;
const DAYS = 30;
const CITY_DAYS = 7;
const SAME_PLACE_M = 60; // a saved address this close to the point counts as "this street"

function metersBetween(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6_371_000; const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat); const dLng = toRad(bLng - aLng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function ago(iso: string | null, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!iso) return '';
  const days = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000));
  if (days === 0) return t('street.ago.today');
  if (days === 1) return t('street.ago.yesterday');
  return t('street.ago.days', { n: days });
}

const pillKey = (s: string) => (s === 'Resolved' || s === 'Closed' ? 'resolved' : s === 'Cancelled' || s === 'Merged' ? 'cityCancelled' : 'received');

function Row({ c }: { c: CityCase & { distanceM?: number } }) {
  const t = useT();
  const statusKey = `street.status.${c.status}`;
  const statusLabel = t(statusKey) === statusKey ? c.status : t(statusKey);
  return (
    <li className="card street-row">
      <span className="street-icon"><CategoryIcon k={c.category} size={24} /></span>
      <div className="street-main">
        <b className="street-type">{c.caseType}</b>
        <span className="street-addr">{c.street || t('street.noStreet')}{c.distanceM != null && <> · {t('street.distance', { m: c.distanceM })}</>}</span>
        <span className="street-when">{c.open ? t('street.when.reported', { when: ago(c.createdAt, t) }) : t('street.when.closed', { when: ago(c.closedAt ?? c.createdAt, t) })}</span>
        {!c.open && c.resolution && <blockquote className="street-note">{c.resolution}</blockquote>}
      </div>
      <span className={`my-status my-status--${pillKey(c.status)}`}>{statusLabel}</span>
    </li>
  );
}

/** "This week in Providence": the landing state, and what a quiet street shows instead of nothing. */
function CityWeek({ title, city, state, retry }: { title: string; city: CityOverview | null; state: 'loading' | 'error' | 'ok'; retry: () => void }) {
  const t = useT();
  if (state === 'error') return <div className="notice notice-error"><span>{t('street.error')}</span><button type="button" className="btn btn-ghost" onClick={retry}>{t('street.retry')}</button></div>;
  if (!city) return <p className="muted" role="status">{t('street.loading')}</p>;
  return (
    <section className="street-city" aria-label={title}>
      <h2 className="street-city-h">{title}</h2>
      <p className="street-summary">{t('street.city.summary', { total: city.total, closed: city.closed })}</p>
      {city.topTypes.length > 0 && (
        <ul className="street-top" aria-label={t('street.city.top')}>
          {city.topTypes.slice(0, 3).map((x) => <li key={x.caseType} className="street-top-item"><CategoryIcon k={x.category} size={18} /><span>{x.caseType}</span><b>{x.n}</b></li>)}
        </ul>
      )}
      {city.latest.length > 0 && <><h3 className="street-h">{t('street.city.latest')}</h3><ul className="street-list">{city.latest.slice(0, 6).map((c) => <Row key={c.id} c={c} />)}</ul></>}
      {city.total === 0 && <p className="muted">{t('street.city.quiet')}</p>}
    </section>
  );
}

export default function Street() {
  const t = useT();
  const session = useSession();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const lat = Number(params.get('lat')); const lng = Number(params.get('lng'));
  const hasPoint = params.has('lat') && Number.isFinite(lat) && Number.isFinite(lng);
  const q = params.get('q') ?? '';
  const [text, setText] = useState(q);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [radius, setRadius] = useState<number>(300);
  const [data, setData] = useState<StreetResponse | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error' | 'ok'>('idle');
  const [me, setMe] = useState<Me | null>(null);
  const [digest, setDigest] = useState<'idle' | 'saving' | 'error'>('idle');
  const [radiusPicked, setRadiusPicked] = useState(false); // a chip the visitor tapped is never auto-widened away
  const [widened, setWidened] = useState(false);
  const [city, setCity] = useState<CityOverview | null>(null);
  const [cityState, setCityState] = useState<'loading' | 'error' | 'ok'>('loading');

  useEffect(() => { setText(q); }, [q]);
  const pointKey = hasPoint ? `${lat.toFixed(5)},${lng.toFixed(5)}` : '';
  useEffect(() => { setRadiusPicked(false); setWidened(false); }, [pointKey]);

  const load = useCallback(() => {
    if (!hasPoint) { setData(null); setState('idle'); return; }
    let live = true;
    setState('loading');
    getStreet(lat, lng, { radiusM: radius, days: DAYS })
      .then((d) => {
        if (!live) return;
        // Nothing within a few blocks → show the neighborhood instead of an empty list (a chip the visitor tapped stays).
        if (d.items.length === 0 && radius < WIDEST && !radiusPicked) { setWidened(true); setRadius(WIDEST); return; }
        setData(d); setState('ok'); track('street_view', { radius_m: radius, items: d.items.length, widened: widened ? 1 : 0 });
      })
      .catch(() => { if (live) setState('error'); });
    return () => { live = false; };
  }, [hasPoint, lat, lng, radius, radiusPicked, widened]);
  useEffect(load, [load]);

  // Citywide week: the landing state, and the fallback when even the neighborhood is quiet.
  const quiet = state === 'ok' && data?.items.length === 0;
  const wantCity = !hasPoint || quiet;
  const loadCity = useCallback(() => {
    let live = true;
    setCityState('loading');
    getStreetCity(CITY_DAYS).then((c) => { if (live) { setCity(c); setCityState('ok'); } }).catch(() => { if (live) setCityState('error'); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (wantCity && !city) return loadCity(); }, [wantCity, city, loadCity]);

  useEffect(() => {
    if (!session) { setMe(null); return; }
    let live = true;
    getMe().then((m) => { if (live) setMe(m); }).catch(() => { /* offline */ });
    return () => { live = false; };
  }, [session]);

  function go(address: string, la: number, ln: number) {
    setMsg(null);
    setParams({ lat: la.toFixed(5), lng: ln.toFixed(5), q: address });
  }

  async function search(e: FormEvent) {
    e.preventDefault();
    const s = text.trim();
    if (s.length < 3) return;
    setBusy(true); setMsg(null);
    try {
      const hit = await forwardGeocode(s);
      if (!hit) { setMsg(t('street.notFound')); return; }
      if (!inProvidence(hit.lat, hit.lng)) { setMsg(t('street.outside')); return; }
      go(hit.label, hit.lat, hit.lng);
    } catch { setMsg(t('street.notFound')); } finally { setBusy(false); }
  }

  function locate() {
    if (!navigator.geolocation) { setMsg(t('street.unsupported')); return; }
    setBusy(true); setMsg(t('street.finding'));
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: la, longitude: ln } = pos.coords;
      setBusy(false);
      if (!inProvidence(la, ln)) { setMsg(t('street.outside')); return; }
      const label = await reverseGeocode(la, ln).catch(() => null);
      go(label ?? t('street.here'), la, ln);
    }, () => { setBusy(false); setMsg(t('street.denied')); }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 });
  }

  // Digest: on when the account opted in and has a saved address at (about) this point.
  const savedHere = me && hasPoint ? me.addresses.find((a) => (a.lat != null && a.lng != null && metersBetween(a.lat, a.lng, lat, lng) < SAME_PLACE_M) || (q && a.address.trim().toLowerCase() === q.trim().toLowerCase())) ?? null : null;
  const digestOn = !!(me?.prefs.streetDigest && savedHere);

  async function enableDigest() {
    if (!hasPoint) return;
    setDigest('saving');
    try {
      let addresses = me?.addresses ?? [];
      if (!savedHere) {
        const label = (q.split(',')[0] || t('street.digest.defaultLabel')).slice(0, 40);
        addresses = (await saveAddress({ label, address: q || label, lat, lng })).addresses;
      }
      const fresh = await updateMe({ prefs: { streetDigest: true } });
      setMe({ ...fresh, addresses: fresh.addresses?.length ? fresh.addresses : addresses });
      setDigest('idle');
      track('street_digest_on');
    } catch { setDigest('error'); }
  }
  async function disableDigest() {
    setDigest('saving');
    try { setMe(await updateMe({ prefs: { streetDigest: false } })); setDigest('idle'); track('street_digest_off'); } catch { setDigest('error'); }
  }

  const open = data?.items.filter((c) => c.open) ?? [];
  const closed = data?.items.filter((c) => !c.open) ?? [];
  const here = location.pathname + location.search;

  return (
    <section className="section street">
      <h1>{t('street.title')}</h1>
      <p className="muted street-intro">{t('street.intro')}</p>

      <form className="street-search" onSubmit={search} role="search">
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('street.search.placeholder')} aria-label={t('street.search.placeholder')} autoComplete="street-address" enterKeyHint="search" />
        <button type="submit" className="btn btn-secondary" disabled={busy || text.trim().length < 3}>{t('street.search')}</button>
      </form>
      <div className="street-actions">
        <button type="button" className="btn btn-ghost" onClick={locate} disabled={busy}>{t('street.useLocation')}</button>
        <SavedAddresses onPick={(a) => { if (a.lat != null && a.lng != null) go(a.address, a.lat, a.lng); else setMsg(t('street.notFound')); }} />
      </div>
      {msg && <p className="hint street-msg" role="status">{msg}</p>}

      {!hasPoint && (
        <>
          <p className="street-empty muted">{t('street.empty')}</p>
          <CityWeek title={t('street.city.title')} city={city} state={cityState} retry={loadCity} />
        </>
      )}

      {hasPoint && (
        <>
          <h2 className="street-where">{q || t('street.here')}</h2>
          <div className="street-radius" role="group" aria-label={t('street.radius.blocks')}>
            {RADII.map((r) => (
              <button key={r.m} type="button" className="chip" aria-pressed={radius === r.m} onClick={() => { setRadiusPicked(true); setWidened(false); setRadius(r.m); }}>{t(`street.radius.${r.key}`)}</button>
            ))}
          </div>

          {state === 'loading' && !data && <p className="muted" role="status">{t('street.loading')}</p>}
          {state === 'error' && <div className="notice notice-error"><span>{t('street.error')}</span><button type="button" className="btn btn-ghost" onClick={load}>{t('street.retry')}</button></div>}
          {data && (
            <div className="street-results" aria-busy={state === 'loading'}>
              {widened && data.items.length > 0 && <p className="hint street-widened" role="status">{t('street.widened')}</p>}
              {data.items.length > 0 && <p className="street-summary">{t('street.summary', { open: open.length, closed: closed.length, days: DAYS })}</p>}
              {data.items.length === 0 && (
                <div className="street-none">
                  <p>{t('street.none', { days: DAYS })}</p>
                  <Link to="/" className="btn btn-secondary">{t('street.report')}</Link>
                  <CityWeek title={t('street.city.meanwhile')} city={city} state={cityState} retry={loadCity} />
                </div>
              )}
              {open.length > 0 && <><h3 className="street-h">{t('street.open')}</h3><ul className="street-list">{open.map((c) => <Row key={c.id} c={c} />)}</ul></>}
              {closed.length > 0 && <><h3 className="street-h">{t('street.closed')}</h3><ul className="street-list">{closed.map((c) => <Row key={c.id} c={c} />)}</ul></>}
            </div>
          )}

          <div className="card street-digest">
            <h3>{t('street.digest.title')}</h3>
            <p className="muted">{t('street.digest.body')}</p>
            {!session && <Link to={`/account?returnTo=${encodeURIComponent(here)}`} className="btn btn-secondary">{t('street.digest.signIn')}</Link>}
            {session && !digestOn && <button type="button" className="btn btn-primary" onClick={enableDigest} disabled={digest === 'saving' || !me}>{digest === 'saving' ? t('street.digest.saving') : t('street.digest.cta')}</button>}
            {session && digestOn && (
              <div className="street-digest-on">
                <p className="notice notice-ok" role="status">{t('street.digest.on', { label: savedHere?.label ?? q })}</p>
                <button type="button" className="btn btn-ghost" onClick={disableDigest} disabled={digest === 'saving'}>{t('street.digest.off')}</button>
              </div>
            )}
            {digest === 'error' && <p className="hint" role="alert">{t('street.digest.error')}</p>}
          </div>

          <p className="hint street-source">{t('street.source')}</p>
        </>
      )}
    </section>
  );
}
