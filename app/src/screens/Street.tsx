import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type L from 'leaflet';
import { getStreetMap, peekStreetMap, type MapCase, type MapDays, type StreetMap } from '../api/street';
import { getMe, saveAddress, updateMe, type Me } from '../api/me';
import { useSession } from '../lib/auth';
import { forwardGeocode, inProvidence, reverseGeocode } from '../lib/geo';
import { track } from '../lib/analytics';
import { useI18n } from '../i18n';
import type { GroupKey } from '../lib/categories';
import { hoodOfSync, loadNeighborhoods, ringBounds, type NeighborhoodTable, type Rings } from '../lib/neighborhoods';
import {
  applyFilters, CITY_BOUNDS, distanceM, facetCounts, hoodCounts, inBounds, isDefaultView, metersBetween, padBounds,
  parseStreetUrl, sortForPoint, summaryOf, topTypes, writeStreetUrl, type Bounds, type Filters, type LatLng, type StreetUrlState,
} from '../lib/streetMap';
import { DESKTOP_MQ, useMediaQuery } from '../lib/useMediaQuery';
import MapView, { type MapFit, type MapPoint, type MapViewChange } from '../components/MapView';
import StreetSheet, { SHEET_FULL_INSET, SHEET_PEEK_MIN, type Detent, type DetentVia } from '../components/StreetSheet';
import StreetFilters from '../components/StreetFilters';
import StreetRow from '../components/StreetRow';
import StreetDetail from '../components/StreetDetail';
import SavedAddresses from '../components/SavedAddresses';
import CategoryIcon from '../components/CategoryIcon';
import Illustration from '../components/Illustration';
import './Street.css';

/** "My street", map-first (spec: .claude/street-map-spec.md, 2026-10-25). One GET /api/street/map load; every count,
 *  filter, cluster and list is computed in the browser from that array (lib/streetMap.ts). The page is a full-bleed
 *  Leaflet stage with floating search + filter rail, a three-detent sheet (phone) or a fixed panel (≥720 px), and is
 *  never empty: landing (city), viewport list, case card, stack, quiet-street and error states all show something.
 *  URL: ?lat&lng&q (the home point, unchanged for the digest email), c/z (view), n (hood), g/s/d (filters), case. */

const RAIL_BOTTOM = 110;
const RING_M = 300;
const SAME_PLACE_M = 60;
const NEAR_POINT_M = 400;
const PAGE = 40;
const LATEST = 20;
const CITY_LL: L.LatLngBoundsLiteral = [[CITY_BOUNDS.south, CITY_BOUNDS.west], [CITY_BOUNDS.north, CITY_BOUNDS.east]];
const at = (p: LatLng): L.LatLngBoundsLiteral => [[p.lat, p.lng], [p.lat, p.lng]];
/** window.__streetMap for Playwright: dev/test builds, or the production build served on localhost (the test server). */
const TEST_HOOK = import.meta.env.MODE !== 'production' || (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname));

type FeedState = 'loading' | 'error' | 'ok';
interface DigestTarget { lat: number; lng: number; label: string }
/** history.state of entries this page pushes: `street` = ours; `back` = pushed by selectCase from a list view of this
 *  page, so "Back to list" may navigate(-1) (a deep-linked case=, or one re-selected by replace, gets the param removed). */
interface StreetHistoryState { street?: boolean; back?: boolean }

const LocateIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>;
const SearchIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>;
const ShareIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" /></svg>;

export default function Street() {
  const { t, lang, setLang } = useI18n();
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const url = useMemo(() => parseStreetUrl(params), [params]);
  const desktop = useMediaQuery(DESKTOP_MQ);

  const point = useMemo((): LatLng | null => (url.lat != null && url.lng != null ? { lat: url.lat, lng: url.lng } : null), [url.lat, url.lng]);
  const pointKey = point ? `${point.lat.toFixed(5)},${point.lng.toFixed(5)}` : '';
  const filters: Filters = useMemo(() => ({ g: url.g, s: url.s, d: url.d }), [url.g, url.s, url.d]);
  const wantDays: MapDays = url.d === 90 ? 90 : 30;

  // Shell: the phone locks to the viewport and hides the footer while this page is mounted (Admin.tsx precedent).
  useEffect(() => { document.body.classList.add('is-street'); return () => document.body.classList.remove('is-street'); }, []);

  /* ── Feed ─────────────────────────────────────────────────────────────────────────────────────── */
  const [data, setData] = useState<StreetMap | null>(null);
  const [feedState, setFeedState] = useState<FeedState>('loading');
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [retryTick, setRetryTick] = useState(0);
  useEffect(() => {
    let live = true;
    setFeedState('loading');
    getStreetMap(wantDays)
      .then((d) => { if (!live) return; setData(d); setNowMs(Date.now()); setFeedState('ok'); })
      .catch(() => { if (live) setFeedState('error'); });
    return () => { live = false; };
  }, [wantDays, retryTick]);

  /* ── Neighborhoods: one table, memoised id → name ─────────────────────────────────────────────── */
  const [nb, setNb] = useState<NeighborhoodTable | null>(null);
  useEffect(() => { let live = true; loadNeighborhoods().then((x) => { if (live) setNb(x); }).catch(() => { /* no hoods, no harm */ }); return () => { live = false; }; }, []);
  const hoodMap = useMemo(() => {
    const m = new Map<string, string>();
    if (nb && data) for (const c of data.cases) if (c.lat != null && c.lng != null) { const h = hoodOfSync(nb, c.lat, c.lng); if (h) m.set(c.id, h); }
    return m;
  }, [nb, data]);
  const hoodOf = useCallback((c: MapCase) => hoodMap.get(c.id) ?? null, [hoodMap]);
  const hoodRings: Rings | null = useMemo(() => (url.hood && nb ? nb[url.hood] ?? null : null), [url.hood, nb]);

  /* ── Map, sheet, view ─────────────────────────────────────────────────────────────────────────── */
  const stageRef = useRef<HTMLElement>(null);
  const [map, setMap] = useState<L.Map | null>(null); // from MapView's onReady (state, not a ref: the band memo reads it in render)
  const [view, setView] = useState<MapViewChange | null>(null);
  const viewRef = useRef<MapViewChange | null>(null);
  const [sheetH, setSheetH] = useState(SHEET_PEEK_MIN);
  const [stageH, setStageH] = useState(0);
  const [peekH, setPeekH] = useState(SHEET_PEEK_MIN); // the last measured PEEK height (the sheet's header), for fits while the sheet is raised
  const [detent, setDetentState] = useState<Detent>(() => (url.lat != null || url.caseId || url.hood ? 'half' : 'peek'));
  const [fit, setFit] = useState<MapFit | null>(null);
  const fitSeq = useRef(0);
  const awaitingFitRef = useRef(false);
  const fittedRef = useRef<{ center: LatLng; zoom: number } | null>(null);
  const [moved, setMoved] = useState(false); // a user pan/zoom (or a shared c/z view) since the last point was set: no auto zoom-out, no teach line
  const raisedRef = useRef(false); // the sheet went PEEK → HALF because of a selection (a background tap drops it back)
  const urlRef = useRef(url);
  const pointRef = useRef(point);
  const locationRef = useRef(location);
  const caseAtRef = useRef<LatLng | null>(null);

  const setDetent = useCallback((d: Detent, via: DetentVia | 'auto') => {
    setDetentState((cur) => { if (cur !== d) track('street_sheet', { detent: d, via }); return d; });
  }, []);

  // The sheet publishes --sheet-h on the stage on every detent/drag frame; mirror it (debounced) together with the
  // stage height. Only the PEEK height has to be measured (the header's content decides it) — HALF and FULL are
  // arithmetic on the stage height, so the band and panInside insets below can be derived from the *target* detent.
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || desktop) { setSheetH(0); setStageH(0); return; }
    const read = () => {
      const v = parseFloat(getComputedStyle(stage).getPropertyValue('--sheet-h'));
      setSheetH(Number.isFinite(v) ? v : 0);
      setStageH(stage.clientHeight);
    };
    read();
    let timer = 0;
    const mo = new MutationObserver(() => { window.clearTimeout(timer); timer = window.setTimeout(read, 60); });
    mo.observe(stage, { attributes: true, attributeFilter: ['style'] });
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => setStageH(stage.clientHeight)) : null;
    ro?.observe(stage);
    return () => { mo.disconnect(); ro?.disconnect(); window.clearTimeout(timer); };
  }, [desktop]);
  useEffect(() => { if (!desktop && detent === 'peek' && sheetH > 0) setPeekH(sheetH); }, [desktop, detent, sheetH]);

  /** The sheet height at detent `d` — the height it is about to have, not the one the 60 ms mirror last saw.
   *  `stage` overrides the mirrored stage height (doFit passes the live measurement: a fit can run before the mirror has). */
  const sheetHeightAt = useCallback((d: Detent, stage = stageH) => {
    if (desktop) return 0;
    const peek = Math.max(SHEET_PEEK_MIN, peekH);
    if (d === 'peek' || stage <= 0) return d === 'peek' ? peek : sheetH;
    return d === 'half' ? Math.min(Math.max(peek, Math.round(stage / 2)), stage - SHEET_FULL_INSET) : Math.max(peek, stage - SHEET_FULL_INSET);
  }, [desktop, stageH, sheetH, peekH]);
  // The sheet top for the current detent: the in-view band and panInside use it so a pin tapped at PEEK is panned
  // clear of the HALF sheet in the same commit that raises it (the mirrored --sheet-h would still read PEEK).
  const sheetTop = sheetHeightAt(detent);
  const insets = useMemo(() => (desktop ? { top: 0, bottom: 0 } : { top: RAIL_BOTTOM, bottom: sheetTop }), [desktop, sheetTop]);

  /** A programmatic fit: the point/bounds centred in the band between the rail and the sheet at detent `d`. */
  const doFit = useCallback((bounds: L.LatLngBoundsLiteral, d: Detent, name: string, maxZoom?: number) => {
    awaitingFitRef.current = true;
    setFit({ bounds, paddingTop: desktop ? 0 : RAIL_BOTTOM, paddingBottom: sheetHeightAt(d, stageRef.current?.clientHeight || 0), maxZoom, key: `${name}#${++fitSeq.current}` });
  }, [desktop, sheetHeightAt]);

  /* ── URL writers ──────────────────────────────────────────────────────────────────────────────── */
  /** Replace writes (c/z, g/s/d, dropping a gone case) keep the entry's history.state — an external deep link stays
   *  "not ours" after a pan or a chip tap. Pushes are stamped ours (`street`), plus whatever `state` adds. */
  const setUrl = useCallback((patch: Partial<StreetUrlState>, replace: boolean, state?: StreetHistoryState) => {
    const cur = (locationRef.current.state as StreetHistoryState | null) ?? null;
    setParams(writeStreetUrl({ ...urlRef.current, ...patch }), { replace, state: replace ? cur : { street: true, ...state } });
  }, [setParams]);

  const [stackIds, setStackIds] = useState<string[] | null>(null);
  const czTimer = useRef(0);
  const onViewChange = useCallback((v: MapViewChange) => {
    viewRef.current = v; setView(v);
    if (v.userGesture) {
      setMoved(true);
      setStackIds(null);
      if (urlRef.current.hood) setUrl({ hood: null }, true); // panning away leaves the neighborhood
    } else if (awaitingFitRef.current) { awaitingFitRef.current = false; fittedRef.current = { center: v.center, zoom: v.zoom }; }
    // c/z: written after a user gesture, dropped whenever the view is back on a derived default.
    window.clearTimeout(czTimer.current);
    czTimer.current = window.setTimeout(() => {
      const cur = urlRef.current;
      const def = isDefaultView({ center: v.center, zoom: v.zoom }, { fitted: fittedRef.current, point: pointRef.current, caseAt: caseAtRef.current });
      if (def) { if (cur.center) setUrl({ center: null, zoom: null }, true); }
      else if (v.userGesture) setUrl({ center: v.center, zoom: v.zoom }, true);
    }, 300);
  }, [setUrl]);
  useEffect(() => () => window.clearTimeout(czTimer.current), []);

  /* ── Restore order: c+z (once) → n → lat/lng → case (when the feed lands) → the city ───────── */
  const [goSeq, setGoSeq] = useState(0);
  const lastTargetRef = useRef<string | null>(null);
  useEffect(() => {
    const target = url.hood ? `hood:${url.hood}` : point ? `pt:${pointKey}:${goSeq}` : url.caseId && lastTargetRef.current == null ? 'case' : 'city';
    if (target === lastTargetRef.current) return;
    if (target.startsWith('hood:') && !nb) return; // the rings are still loading; this effect re-runs when they land
    const prev = lastTargetRef.current;
    lastTargetRef.current = target;
    if (prev == null && url.center && url.zoom != null) {
      // A shared view wins once; paddings 0 so the centre is exact. 'cz' (not 'case') so a case= in the same URL is
      // selected without re-fitting to it — the sender's framing is kept.
      lastTargetRef.current = 'cz';
      awaitingFitRef.current = false;
      setMoved(true); // a shared view is the sender's choice: never auto-widened, even once c/z are dropped as the default
      setFit({ bounds: at(url.center), paddingTop: 0, paddingBottom: 0, maxZoom: url.zoom, key: `cz#${++fitSeq.current}` });
      return;
    }
    if (target.startsWith('hood:') && nb && url.hood) { const r = ringBounds(nb[url.hood]); doFit([[r.south, r.west], [r.north, r.east]], 'half', target); }
    else if (target.startsWith('pt:') && point) doFit(at(point), 'half', target, 16);
    else if (target === 'case') { /* the case effect fits when the feed arrives */ }
    else if (prev == null || prev.startsWith('pt:')) doFit(CITY_LL, 'peek', target); // first paint, or the × cleared the address; a pan that left a hood never recentres
  }, [url.hood, pointKey, goSeq, nb, url.caseId]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Selection (case=) ────────────────────────────────────────────────────────────────────────── */
  const selectedCase = useMemo(() => (url.caseId && data ? data.cases.find((c) => c.id === url.caseId) ?? null : null), [url.caseId, data]);
  // Handlers and timers read the latest URL / point / selected case through refs (layout effect: before every other effect of the commit).
  useLayoutEffect(() => {
    urlRef.current = url; pointRef.current = point; locationRef.current = location;
    caseAtRef.current = selectedCase && selectedCase.lat != null && selectedCase.lng != null ? { lat: selectedCase.lat, lng: selectedCase.lng } : null;
  });
  const selectViaRef = useRef<'pin' | 'row' | null>(null);
  const handledCaseRef = useRef<string | null>(null);
  const [goneId, setGoneId] = useState<string | null>(null);
  // Whether MapView may move the map for the selection (panInside / setView 17 when clustered). True for pin and row
  // taps; for a case= restored from a URL only when the case is the view's sole target — a shared c/z view, a point or
  // a neighborhood in the same URL decides the framing (spec urlState: "a shared view wins once"). MapView's selection
  // effect runs before this screen's case effect in the same commit, so the initial value is what the restore sees.
  const [panToSelection, setPanToSelection] = useState(() => !!url.caseId && !url.center && url.lat == null && !url.hood);
  const refitRef = useRef(false); // a case= that was the URL's sole target and missing from the 30-day set: fit to it when the 90-day set has it
  useEffect(() => {
    if (!url.caseId) { handledCaseRef.current = null; return; }
    if (!data || handledCaseRef.current === url.caseId) return;
    handledCaseRef.current = url.caseId;
    const via = selectViaRef.current ?? 'url'; selectViaRef.current = null;
    if (!selectedCase) {
      setGoneId(url.caseId);
      setUrl({ caseId: null }, true);
      if (lastTargetRef.current === 'case') { refitRef.current = true; lastTargetRef.current = 'city'; doFit(CITY_LL, 'half', 'city'); }
      return;
    }
    setGoneId(null);
    track('street_case', { via });
    if (via === 'url') {
      // Fit to the case only when nothing else framed the view ('case': the URL's sole target, or that case found
      // again after the 90-day switch). A c/z, point or hood restore already placed the map — just select.
      const fitToCase = lastTargetRef.current === 'case' || refitRef.current;
      refitRef.current = false;
      setPanToSelection(fitToCase);
      if (fitToCase && selectedCase.lat != null && selectedCase.lng != null) doFit(at({ lat: selectedCase.lat, lng: selectedCase.lng }), 'half', `case:${selectedCase.id}`, 17);
    }
    setDetentState((d) => { if (d === 'peek') { raisedRef.current = true; track('street_sheet', { detent: 'half', via: 'auto' }); return 'half'; } return d; });
  }, [url.caseId, data, selectedCase]); // eslint-disable-line react-hooks/exhaustive-deps
  // A case that was not in the 30-day set: once the 90-day set has it, select it again.
  useEffect(() => {
    if (goneId && data && data.cases.some((c) => c.id === goneId)) { setGoneId(null); setUrl({ caseId: goneId }, true); }
  }, [goneId, data, setUrl]);

  const selectCase = (id: string, via: 'pin' | 'row') => {
    if (via === 'pin') track('street_pin', { kind: 'pin' });
    const cur = urlRef.current;
    if (cur.caseId === id) return;
    selectViaRef.current = via;
    setPanToSelection(true);
    setStackIds(null);
    // Raise PEEK → HALF in this same event so the card mounts into a non-inert body and takes focus at once (the case
    // effect's raise is the fallback for the URL path). The band insets follow the detent, so the pin is panned clear
    // of the HALF sheet, not of the PEEK one.
    if (via === 'pin') setDetentState((d) => { if (d === 'peek') { raisedRef.current = true; track('street_sheet', { detent: 'half', via: 'auto' }); return 'half'; } return d; });
    // card → card: one entry (replace), so Back — ours or Android's — still lands on the list. Otherwise pushState so
    // Android Back closes the card; `back` marks the entry as pushed from a list view of this page, so "Back to list"
    // may pop it. A case= that arrived any other way (deep link, the 90-day re-select) gets the param removed instead.
    if (cur.caseId) setUrl({ caseId: id }, true); else setUrl({ caseId: id }, false, { back: true });
  };
  const focusAfterRef = useRef<string | null>(null);
  const closeCase = () => {
    focusAfterRef.current = urlRef.current.caseId;
    const st = (locationRef.current.state as StreetHistoryState | null) ?? null;
    if (st?.back) navigate(-1); else setUrl({ caseId: null }, true);
  };
  useEffect(() => {
    if (url.caseId || !focusAfterRef.current) return;
    const id = focusAfterRef.current; focusAfterRef.current = null;
    const stage = stageRef.current;
    const el = stage?.querySelector<HTMLElement>(`.street-row-btn[data-id="${CSS.escape(id)}"]`) ?? stage?.querySelector<HTMLElement>('.street-grab');
    el?.focus({ preventScroll: true });
  }, [url.caseId]);

  const onBackgroundTap = () => {
    if (urlRef.current.caseId) { closeCase(); if (raisedRef.current) { raisedRef.current = false; setDetent('peek', 'auto'); } }
    setStackIds(null);
  };
  const onStackTap = (ids: string[]) => { track('street_pin', { kind: 'stack' }); setStackIds(ids); setDetentState((d) => (d === 'peek' ? 'half' : d)); };
  const onClusterTap = () => { track('street_pin', { kind: 'cluster' }); };

  /* ── Derived sets ─────────────────────────────────────────────────────────────────────────────── */
  const zoom = view?.zoom ?? 12;
  const landing = !point && !url.hood && zoom <= 13;
  const bandBounds = useMemo((): Bounds | null => {
    if (!view) return null;
    if (!map || desktop) return padBounds(view.bounds, 0.05);
    const size = map.getSize();
    const top = RAIL_BOTTOM, bottom = size.y - sheetTop;
    if (bottom - top < 40) return padBounds(view.bounds, 0.05);
    const nw = map.containerPointToLatLng([0, top]); const se = map.containerPointToLatLng([size.x, bottom]);
    return padBounds({ south: se.lat, west: nw.lng, north: nw.lat, east: se.lng }, 0.05);
  }, [view, sheetTop, desktop, map]);

  const windowed = useMemo(() => (data ? applyFilters(data.cases, { g: null, s: null, d: filters.d }, nowMs) : []), [data, filters.d, nowMs]);
  const filtered = useMemo(() => (data ? applyFilters(data.cases, filters, nowMs) : []), [data, filters, nowMs]);
  const points = useMemo<MapPoint[]>(() => filtered.flatMap((c) => (c.lat != null && c.lng != null ? [{ id: c.id, lat: c.lat, lng: c.lng, open: c.open }] : [])), [filtered]);
  const inView = useMemo(() => {
    if (!bandBounds) return [];
    const list = filtered.filter((c) => inBounds(c, bandBounds));
    return point ? sortForPoint(list, point) : list;
  }, [filtered, bandBounds, point]);
  const counts = useMemo(() => (data && (landing || bandBounds) ? facetCounts(data.cases, landing ? null : bandBounds, filters, nowMs) : null), [data, landing, bandBounds, filters, nowMs]);
  const summary = useMemo(() => summaryOf(filtered, landing ? null : bandBounds, filters.d), [filtered, landing, bandBounds, filters.d]);
  const top3 = useMemo(() => topTypes(windowed, 3), [windowed]);
  const hoods = useMemo(() => hoodCounts(windowed, hoodOf), [windowed, hoodOf]);
  const stackCases = useMemo(() => (stackIds && data ? stackIds.flatMap((id) => data.cases.filter((c) => c.id === id)) : null), [stackIds, data]);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [view, filters]);

  // One automatic zoom step 16 → 15 when nothing is near the address (not after a shared z or a user move).
  const [widened, setWidened] = useState(false);
  const firstPointRef = useRef(true);
  useEffect(() => { if (firstPointRef.current) { firstPointRef.current = false; return; } setWidened(false); setGoneId(null); setMoved(false); }, [pointKey]);
  useEffect(() => {
    if (!point || !data || feedState !== 'ok' || widened || url.zoom != null || moved || !view || !bandBounds) return;
    if (Math.round(view.zoom) !== 16 || inView.length > 0 || filters.g != null || filters.s != null) return;
    setWidened(true);
    doFit(at(point), 'half', `pt15:${pointKey}`, 15);
  }, [point, data, feedState, widened, url.zoom, moved, view, bandBounds, inView.length, filters.g, filters.s, pointKey, doFit]);

  /* ── Title + live summary ─────────────────────────────────────────────────────────────────────── */
  const [centerHood, setCenterHood] = useState<string | null>(null);
  useEffect(() => {
    if (!view || !nb || view.zoom < 14) { setCenterHood(null); return; }
    setCenterHood(hoodOfSync(nb, view.center.lat, view.center.lng));
  }, [view, nb]);
  const bandCenter = bandBounds ? { lat: (bandBounds.south + bandBounds.north) / 2, lng: (bandBounds.west + bandBounds.east) / 2 } : null;
  const nearPoint = !!point && !!bandCenter && metersBetween(bandCenter.lat, bandCenter.lng, point.lat, point.lng) < NEAR_POINT_M;
  const title = selectedCase ? (selectedCase.caseType || t(`street.g.${selectedCase.group}`))
    : stackIds ? t('street.spot', { n: stackIds.length })
    : nearPoint ? (url.q || t('street.here'))
    : url.hood ? url.hood
    : zoom >= 14 && centerHood ? centerHood
    : t('street.city.name');

  const num = (n: number) => n.toLocaleString(lang === 'es' ? 'es' : 'en-US');
  const summaryText = !data
    ? (feedState === 'error' ? t('street.error') : t('street.loading'))
    : summary.kind === 'city'
      ? t('street.summary.city', { total: num(summary.total), open: num(summary.open), closed: num(summary.closed), days: summary.days })
      : t('street.summary.view', { n: num(summary.n), open: num(summary.open), closed: num(summary.closed) });
  const [subtitle, setSubtitle] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setSubtitle((s) => (s === summaryText ? s : summaryText)), subtitle === '' ? 0 : 400);
    return () => window.clearTimeout(id);
  }, [summaryText]); // eslint-disable-line react-hooks/exhaustive-deps
  const [flash, setFlash] = useState<string | null>(null);
  useEffect(() => { if (!flash) return; const id = window.setTimeout(() => setFlash(null), 2500); return () => window.clearTimeout(id); }, [flash]);

  /* ── Analytics: one street_view per URL change ────────────────────────────────────────────────── */
  useEffect(() => {
    const id = window.setTimeout(() => {
      const u = urlRef.current;
      const mode = u.caseId ? 'case' : u.hood ? 'hood' : u.lat != null ? 'point' : landing ? 'landing' : 'view';
      track('street_view', { mode, d: u.d, g: u.g ?? '', s: u.s ?? '', z: Math.round(viewRef.current?.zoom ?? 0) });
    }, 500);
    return () => window.clearTimeout(id);
  }, [location.search]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Search / locate / saved places ───────────────────────────────────────────────────────────── */
  const [text, setText] = useState(url.q);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(url.q); }, [url.q]);

  function go(address: string, la: number, ln: number) {
    setMsg(null); setStackIds(null); setGoSeq((s) => s + 1);
    setUrl({ lat: la, lng: ln, q: address, caseId: null, hood: null, center: null, zoom: null }, false);
    setDetent('half', 'auto');
  }
  function clearAddress() {
    setText(''); setMsg(null);
    if (pointRef.current) setUrl({ lat: null, lng: null, q: '', center: null, zoom: null }, false);
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

  /* ── Filters, neighborhoods, whole city, zoom out ─────────────────────────────────────────────── */
  const onFilters = (f: Filters) => {
    setUrl({ g: f.g as GroupKey | null, s: f.s, d: f.d }, true);
    track('street_filter', { g: f.g ?? '', s: f.s ?? '', d: f.d });
  };
  const pickHood = (name: string) => {
    if (!name) return;
    setStackIds(null);
    setUrl({ hood: name, caseId: null, center: null, zoom: null }, false);
    setDetent('half', 'auto');
    track('street_hood', { name });
  };
  const seeCity = () => {
    setStackIds(null);
    setUrl({ hood: null, center: null, zoom: null, caseId: null }, true);
    lastTargetRef.current = 'city';
    doFit(CITY_LL, detent, 'city');
  };
  const zoomOut = () => { if (map) map.setZoom(Math.max(10, map.getZoom() - 2)); };

  /* ── Share ────────────────────────────────────────────────────────────────────────────────────── */
  async function share() {
    const cur = urlRef.current; const v = viewRef.current;
    const def = !v || isDefaultView({ center: v.center, zoom: v.zoom }, { fitted: fittedRef.current, point: pointRef.current, caseAt: caseAtRef.current });
    const p = writeStreetUrl({ ...cur, center: !def && v ? v.center : null, zoom: !def && v ? v.zoom : null });
    if (!def && v && !cur.center) setUrl({ center: v.center, zoom: v.zoom }, true); // location.href matches what we copy
    const href = `${window.location.origin}/street${p.toString() ? `?${p}` : ''}`;
    track('street_share');
    try {
      if (typeof navigator.share === 'function') { await navigator.share({ url: href }); return; }
      await navigator.clipboard.writeText(href);
      setFlash(t('street.detail.copied'));
    } catch { /* cancelled or blocked */ }
  }

  /* ── Weekly digest (kept; bound to the point, or to the selected case's street) ───────────────── */
  const [me, setMe] = useState<Me | null>(null);
  const [digest, setDigest] = useState<'idle' | 'saving' | 'error'>('idle');
  useEffect(() => {
    if (!session) { setMe(null); return; }
    let live = true;
    getMe().then((m) => { if (live) setMe(m); }).catch(() => { /* offline */ });
    return () => { live = false; };
  }, [session]);
  const savedNear = (tg: DigestTarget) => me?.addresses.find((a) => (a.lat != null && a.lng != null && metersBetween(a.lat, a.lng, tg.lat, tg.lng) < SAME_PLACE_M) || (tg.label && a.address.trim().toLowerCase() === tg.label.trim().toLowerCase())) ?? null;
  async function enableDigest(tg: DigestTarget, from: 'point' | 'case') {
    setDigest('saving');
    try {
      const saved = savedNear(tg);
      let addresses = me?.addresses ?? [];
      if (!saved) {
        const label = (tg.label.split(',')[0] || t('street.digest.defaultLabel')).slice(0, 40);
        addresses = (await saveAddress({ label, address: tg.label || label, lat: tg.lat, lng: tg.lng })).addresses;
      }
      const fresh = await updateMe({ prefs: { streetDigest: true } });
      setMe({ ...fresh, addresses: fresh.addresses?.length ? fresh.addresses : addresses });
      setDigest('idle');
      track('street_digest_on', { from });
    } catch { setDigest('error'); }
  }
  async function disableDigest(from: 'point' | 'case') {
    setDigest('saving');
    try { setMe(await updateMe({ prefs: { streetDigest: false } })); setDigest('idle'); track('street_digest_off', { from }); } catch { setDigest('error'); }
  }
  const here = location.pathname + location.search;
  function renderDigest(tg: DigestTarget, from: 'point' | 'case'): ReactNode {
    const saved = savedNear(tg);
    const on = !!(me?.prefs.streetDigest && saved);
    return (
      <div className="card street-digest">
        <h3>{t('street.digest.title')}</h3>
        <p className="muted">{t('street.digest.body')}</p>
        {!session && <Link to={`/account?returnTo=${encodeURIComponent(here)}`} className="btn btn-secondary">{t('street.digest.signIn')}</Link>}
        {session && !on && <button type="button" className="btn btn-primary" onClick={() => enableDigest(tg, from)} disabled={digest === 'saving' || !me}>{digest === 'saving' ? t('street.digest.saving') : t('street.digest.cta')}</button>}
        {session && on && (
          <div className="street-digest-on">
            <p className="notice notice-ok" role="status">{t('street.digest.on', { label: saved?.label ?? tg.label })}</p>
            <button type="button" className="btn btn-ghost" onClick={() => disableDigest(from)} disabled={digest === 'saving'}>{t('street.digest.off')}</button>
          </div>
        )}
        {digest === 'error' && <p className="hint" role="alert">{t('street.digest.error')}</p>}
      </div>
    );
  }

  /* ── Render helpers ───────────────────────────────────────────────────────────────────────────── */
  const [hover, setHover] = useState<string | null>(null);
  const row = (c: MapCase) => (
    <StreetRow key={c.id} c={c} hood={hoodOf(c)} distanceM={point ? distanceM(c, point) : null} selected={c.id === url.caseId}
      onSelect={(id) => selectCase(id, 'row')} onHover={desktop ? setHover : undefined} nowMs={nowMs} />
  );
  const topChips = top3.length > 0 && (
    <ul className="street-top" aria-label={t('street.city.top')}>
      {top3.map((x) => (
        <li key={x.caseType || x.category}>
          <button type="button" className="street-top-item" aria-pressed={filters.g === x.group} onClick={() => onFilters({ ...filters, g: filters.g === x.group ? null : x.group })}>
            <CategoryIcon k={x.category} size={18} /><span className="street-top-name">{x.caseType || t(`street.g.${x.group}`)}</span><b>{num(x.n)}</b>
          </button>
        </li>
      ))}
    </ul>
  );
  const hoodSelect = (
    <select className="select street-hood" aria-label={t('street.hood.jump')} value={url.hood ?? ''} onChange={(e) => pickHood(e.target.value)}>
      <option value="">{t('street.hood.jump')}</option>
      {hoods.map((h) => <option key={h.name} value={h.name}>{h.name} ({h.n})</option>)}
    </select>
  );
  const meanwhile = (
    <section className="street-meanwhile" aria-label={t('street.city.meanwhile')}>
      <h3 className="street-h">{t('street.city.meanwhile')}</h3>
      {topChips}
      <button type="button" className="btn btn-ghost" onClick={seeCity}>{t('street.wholeCity')}</button>
    </section>
  );
  const cached90 = filters.d < 90 ? peekStreetMap(90) : null;
  const lookBack = filters.d < 90 && (
    <button type="button" className="btn btn-ghost" onClick={() => onFilters({ ...filters, d: 90 })}>
      {t('street.fix.days')}{cached90 && bandBounds ? ` (${num(applyFilters(cached90.cases, { ...filters, d: 90 }, nowMs).filter((c) => landing || inBounds(c, bandBounds)).length)})` : ''}
    </button>
  );
  const days = filters.d;
  const active = filters.g != null || filters.s != null;

  function renderEmpty(): ReactNode {
    if (active && counts) {
      return (
        <div className="street-none">
          <p>{t('street.nothing', { days })}</p>
          <div className="street-fixes">
            {filters.g != null && counts.all > 0 && <button type="button" className="btn btn-ghost" onClick={() => onFilters({ ...filters, g: null })}>{t('street.fix.allTypes', { n: num(counts.all) })}</button>}
            {filters.s === 'open' && counts.closed > 0 && <button type="button" className="btn btn-ghost" onClick={() => onFilters({ ...filters, s: null })}>{t('street.fix.closed', { n: num(counts.closed) })}</button>}
            {filters.s === 'closed' && counts.open > 0 && <button type="button" className="btn btn-ghost" onClick={() => onFilters({ ...filters, s: null })}>{t('street.fix.open', { n: num(counts.open) })}</button>}
            {!landing && <button type="button" className="btn btn-ghost" onClick={zoomOut}>{t('street.zoomOut')}</button>}
            {lookBack}
          </div>
          {meanwhile}
        </div>
      );
    }
    if (point) {
      return (
        <div className="street-none">
          <p>{t('street.none', { days })}</p>
          <Link to="/" className="btn btn-secondary">{t('street.report')}</Link>
          {lookBack}
          {meanwhile}
        </div>
      );
    }
    return (
      <div className="street-none">
        <p>{t('street.nothing.plain', { days })}</p>
        <div className="street-fixes">
          <button type="button" className="btn btn-ghost" onClick={zoomOut}>{t('street.zoomOut')}</button>
          {lookBack}
        </div>
        {meanwhile}
      </div>
    );
  }

  function renderBody(): ReactNode {
    if (!data) {
      if (feedState === 'error') return <div className="notice notice-error"><span>{t('street.error')}</span><button type="button" className="btn btn-ghost" onClick={() => setRetryTick((x) => x + 1)}>{t('street.retry')}</button></div>;
      return <div className="street-skel" aria-hidden="true"><span /><span /><span /></div>;
    }
    if (data.total === 0) {
      return (
        <div className="street-quiet">
          <Illustration kind="street" className="illo" />
          <p>{t('street.city.quiet')}</p>
          <div className="street-fixes"><Link to="/" className="btn btn-secondary">{t('street.report')}</Link>{lookBack}</div>
        </div>
      );
    }
    if (selectedCase) {
      const tg: DigestTarget | null = selectedCase.lat != null && selectedCase.lng != null ? { lat: selectedCase.lat, lng: selectedCase.lng, label: selectedCase.street } : null;
      return <StreetDetail c={selectedCase} hood={hoodOf(selectedCase)} distanceM={point ? distanceM(selectedCase, point) : null} onBack={closeCase} onShare={share} nowMs={nowMs} digest={tg ? renderDigest(tg, 'case') : undefined} />;
    }
    if (stackCases) {
      return (
        <section className="street-section" aria-label={t('street.spot', { n: stackCases.length })}>
          <h3 className="street-h">{t('street.spot', { n: stackCases.length })}</h3>
          <ul className="street-list">{stackCases.map(row)}</ul>
          <button type="button" className="btn btn-ghost street-stack-clear" onClick={() => setStackIds(null)}>{t('street.spot.clear')}</button>
        </section>
      );
    }
    if (landing) {
      if (filtered.length === 0) return renderEmpty();
      return (
        <>
          <h3 className="street-h">{t('street.city.top')}</h3>
          {topChips}
          {hoodSelect}
          <h3 className="street-h">{t('street.city.latest')}</h3>
          <ul className="street-list">{filtered.slice(0, LATEST).map(row)}</ul>
        </>
      );
    }
    if (inView.length === 0) return renderEmpty();
    return (
      <>
        {desktop && hoodSelect}
        <h3 className="street-h">{t('street.inview.title')}</h3>
        <ul className="street-list">{inView.slice(0, shown).map(row)}</ul>
        {inView.length > shown && <button type="button" className="btn btn-ghost street-more" onClick={() => setShown((s) => s + PAGE)}>{t('street.showMore', { n: num(inView.length - shown) })}</button>}
      </>
    );
  }

  const digestTarget: DigestTarget | null = point ? { lat: point.lat, lng: point.lng, label: url.q } : null;
  const body = (
    <>
      {data && feedState === 'loading' && <div className="street-skel" aria-hidden="true"><span /><span /></div>}
      {goneId && (
        <div className="street-gone">
          <p className="hint" role="status">{t('street.caseGone', { days })}</p>
          {lookBack}
        </div>
      )}
      {widened && !selectedCase && <p className="hint street-widened" role="status">{t('street.widened')}</p>}
      {renderBody()}
      {digestTarget && !selectedCase && data && renderDigest(digestTarget, 'point')}
      <p className="hint street-source">{t('street.source')}</p>
    </>
  );

  const tail = desktop ? null : (
    <nav className="street-tail" aria-label={t('footer.nav')}>
      <div className="street-tail-links"><Link to="/about">{t('nav.about')}</Link><Link to="/privacy">{t('nav.privacy')}</Link></div>
      <div className="lang-switch" role="group" aria-label={t('footer.language')}>
        <button type="button" className={`lang-btn${lang === 'en' ? ' active' : ''}`} onClick={() => setLang('en')} lang="en" aria-pressed={lang === 'en'}>English</button>
        <span aria-hidden="true">·</span>
        <button type="button" className={`lang-btn${lang === 'es' ? ' active' : ''}`} onClick={() => setLang('es')} lang="es" aria-pressed={lang === 'es'}>Español</button>
      </div>
      <p className="disclaimer">{t('brand.disclaimer')}</p>
    </nav>
  );

  const showTeach = landing && !moved && params.toString() === '' && detent === 'peek';
  const extraLines: ReactNode[] = [];
  if (showTeach) extraLines.push(<p key="teach" className="hint">{t('street.teach')}</p>);
  if (data && summary.kind === 'city' && summary.unplaced > 0) extraLines.push(<p key="unplaced" className="hint">{t('street.unplaced', { n: num(summary.unplaced) })}</p>);
  if (data?.truncated && filters.d === 90) extraLines.push(<p key="trunc" className="hint">{t('street.truncated')}</p>);
  if (data && feedState === 'error') extraLines.push(<p key="asof" className="hint" role="status">{t('street.asOf', { time: new Date(data.at).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' }) })}</p>);

  const places = session && me && me.addresses.length > 0 ? (
    <div className="street-places-row">
      <span className="street-places-label">{t('street.places')}</span>
      <SavedAddresses onPick={(a) => { if (a.lat != null && a.lng != null) go(a.address, a.lat, a.lng); else setMsg(t('street.notFound')); }} />
    </div>
  ) : undefined;

  const shareBtn = <button type="button" className="street-ico" aria-label={t('street.detail.share')} onClick={share}>{ShareIcon}</button>;
  const rail = <StreetFilters filters={filters} counts={counts} loading={feedState === 'loading' && !!data} disabled={feedState === 'error' && !data} onChange={onFilters} />;
  const wholeCityBtn = <button type="button" className="street-vh street-vh-btn" onClick={seeCity}>{t('street.wholeCity')}</button>;
  const hasText = text !== '' || !!point;
  const controls = desktop ? (
    <>
      <form className="street-search-row" role="search" onSubmit={search}>
        <div className="street-input-wrap">
          <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('street.search.placeholder')} aria-label={t('street.search.placeholder')} autoComplete="street-address" enterKeyHint="search" />
          {hasText && <button type="button" className="street-pill-x" aria-label={t('street.search.clear')} onClick={clearAddress}>×</button>}
        </div>
        <button type="submit" className="btn btn-secondary" disabled={busy || text.trim().length < 3}>{t('street.search')}</button>
        <button type="button" className="btn btn-ghost street-locate" onClick={locate} disabled={busy}>{t('street.useLocation')}</button>
      </form>
      {rail}
      {msg && <p className="hint street-msg" role="status">{msg}</p>}
      {wholeCityBtn}
    </>
  ) : (
    <div className="street-controls">
      <div className="street-pill">
        <button type="button" className="street-ico" aria-label={t('street.useLocation')} onClick={locate} disabled={busy}>{LocateIcon}</button>
        <form id="street-search" className="street-pill-form" role="search" onSubmit={search}>
          <input className="street-pill-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={t('street.search.placeholder')} aria-label={t('street.search.placeholder')} autoComplete="street-address" enterKeyHint="search" />
          {hasText && <button type="button" className="street-pill-x" aria-label={t('street.search.clear')} onClick={clearAddress}>×</button>}
        </form>
        <button type="submit" form="street-search" className="street-ico" aria-label={t('street.search.go')} disabled={busy}>{SearchIcon}</button>
      </div>
      {rail}
      {msg && <p className="hint street-msg" role="status">{msg}</p>}
      {wholeCityBtn}
    </div>
  );

  return (
    <section className="street-stage" ref={stageRef}>
      <h1 className="street-vh">{t('street.title')}</h1>
      <p id="street-map-hint" className="street-vh">{t('street.map.hint')}</p>
      {!desktop && controls}
      <StreetSheet
        detent={detent} onDetent={setDetent} title={title} subtitle={flash ?? subtitle}
        labels={{ show: t('street.sheet.show'), more: t('street.sheet.more'), hide: t('street.sheet.hide'), map: t('street.sheet.map') }}
        places={places} extra={extraLines.length ? extraLines : undefined} actions={shareBtn} controls={desktop ? controls : undefined}
        tail={tail} desktop={desktop} panelLabel={t('street.title')} busy={feedState === 'loading' && !!data}
      >
        {body}
      </StreetSheet>
      <MapView
        key={desktop ? 'desk' : 'phone'}
        ariaLabel={t('street.map.label')} frameless={!desktop} zoomControl={desktop}
        points={points} selectedId={url.caseId} hoverId={hover} panToSelection={panToSelection}
        onSelect={(id) => selectCase(id, 'pin')} onStackTap={onStackTap} onClusterTap={onClusterTap} onBackgroundTap={onBackgroundTap} onViewChange={onViewChange}
        home={point} ring={point ? RING_M : null} hood={hoodRings} fit={fit} insets={insets}
        onReady={(m) => { setMap(m); m.getContainer().setAttribute('aria-describedby', 'street-map-hint'); }}
        testHook={TEST_HOOK}
      />
    </section>
  );
}
