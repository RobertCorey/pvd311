import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import type L from 'leaflet';
import { getStreetCase, getStreetCaseFull, getStreetMap, peekStreetCase, peekStreetMap, type CaseDetail, type MapCase, type MapDays, type StreetMap } from '../api/street';
import { followCity, getMe, placedAddresses, unfollowCity, type Me } from '../api/me';
import { isSafeReturnTo, useSession } from '../lib/auth';
import { forwardGeocode, inProvidence, reverseGeocode } from '../lib/geo';
import { track } from '../lib/analytics';
import { useI18n } from '../i18n';
import { hoodOfSync, loadNeighborhoods, ringBounds, type NeighborhoodTable, type Rings } from '../lib/neighborhoods';
import {
  applyFilters, CITY_BOUNDS, clampRange, DAY_MS, distanceM, facetCounts, feedDays, inBounds, isDefaultView, isNewCase, metersBetween, nearbyCases, nyDayStart,
  padBounds, parseStreetUrl, placeActivity, reportHref, sortForPoint, streetSearch, summaryOf, topGroups, type Bounds, type DateRange, type Filters, type LatLng,
  type StreetUrlState,
} from '../lib/streetMap';
import { GROUP_ICON } from '../lib/categories';
import { DESKTOP_MQ, useMediaQuery } from '../lib/useMediaQuery';
import { useInstallPrompt } from '../lib/useInstallPrompt';
import { currentEnv, isIOS } from '../lib/push';
import {
  bumpVisits, INSTALL_FROM_VISIT, installSnoozed, isNewSince, newCutoff, newestCreated, newSince, readSeenAt, readSeenFeedAt,
  sinceCutoff, sinceWhen, snoozeInstall, writeSeenAt, writeSeenFeedAt,
} from '../lib/streetVisit';
import MapView, { type MapFit, type MapPoint, type MapViewChange } from '../components/MapView';
import StreetSheet, { SHEET_FULL_INSET, SHEET_PEEK_MIN, type Detent, type DetentVia } from '../components/StreetSheet';
import StreetFilters from '../components/StreetFilters';
import StreetRow from '../components/StreetRow';
import StreetCasePage, { type NearbyRow } from '../components/StreetCasePage';
import StreetPreview from '../components/StreetPreview';
import MapKey from '../components/MapKey';
import StreetFollow, { type FollowAccountState, type FollowEmailState } from '../components/StreetFollow';
import { caseHref } from '../components/FollowedCases';
import StreetDigestCard, { addressLabel } from '../components/StreetDigestCard';
import SavedAddresses from '../components/SavedAddresses';
import CategoryIcon from '../components/CategoryIcon';
import Illustration from '../components/Illustration';
import './Street.css';

/** "My street", map-first (spec: .claude/street-map-spec.md, 2026-10-25). One GET /api/street/map load; every count,
 *  filter, cluster and list is computed in the browser from that array (lib/streetMap.ts). The page is a full-bleed
 *  Leaflet stage with floating search + one row of filters (Show · When · Type), a three-detent sheet (phone) or a fixed panel (≥720 px), and is
 *  never empty: landing (city), viewport list, stack, quiet-street and error states all show something.
 *  URL: ?lat&lng&q (the home point, unchanged for the digest email), c/z (view), n (hood — /week's neighborhood rows link
 *  here; the page has no picker of its own any more), g/s/d or g/s/from+to (filters), case. A from+to is read inside
 *  the date inputs' bounds (lib/streetMap clampRange; none left → the preset) and written back in place.
 *  A neighborhood (n=) counts and lists only the cases inside its outline — "14 in Fox Point" (Rob, 2026-10-28) — with
 *  the outline fitted between the rail and the HALF sheet; any pan or zoom leaves it (n= cleared).
 *  A case= that is not in the loaded window (a followed case months old, from the follow mail or a /my row) is fetched by
 *  itself (GET /api/street/case/:guid) and shown with its pin; only a case the city's record no longer has is "gone".
 *  A selected case opens the case page over everything (components/StreetCasePage; Rob, 2026-10-27, with a Zillow
 *  listing as the model): a list row, a ?case= deep link or, at ≥ 720 px, a pin or a fanned pin opens it; the map does
 *  not move for it (the pin stays selected behind it) and the sheet/panel keep their list, so closing it returns to
 *  exactly the view and the list from before. case= stays the state: every open is a history entry, so Back closes it.
 *  On a phone a pin shows Zillow's small card first (components/StreetPreview; Rob, 2026-10-28, "idk you pick"): docked
 *  over the PEEK sheet, its tap opens the case page, and Back from that page finds the card again. The card is not in
 *  the URL. Pins carry their type's glyph and only new cases pulse; the "Map key" button explains every mark. */

/** The phone's floating controls end here, from the stage's top: 10 + 48 search pill + 8 + 44 Show row + 8 + 44
 *  When / Type row (Street.css .street-controls; StreetParts.css .street-filters). Fits, the in-view band and the
 *  city's edges read it. While "Custom range…" is chosen the From / To row adds RANGE_ROW (8 + 44) below — and the
 *  sheet's FULL stops that much lower, the map key sits that much lower (Street.css .street-stage--range). */
const RAIL_BOTTOM = 162;
const RANGE_ROW = 52;
/** A pin the phone's preview card would cover is nudged up until its tip — and the 5 px of selection ring under it —
 *  clears the card's top by PREVIEW_GAP. */
const PREVIEW_GAP = 8;
const PIN_RING_PX = 5;
/** The card's dock over the sheet (Street.css .street-preview: `bottom` = the sheet's height + 30 px). */
const PREVIEW_DOCK = 30;
const RING_M = 300;
const NEAR_POINT_M = 400;
const PAGE = 40;
const LATEST = 20;
/** "Your places this week": api/me placedAddresses (≤ 5 saved addresses), each counted over the last 7 days within RING_M. */
const PLACES_DAYS = 7;
const CITY_LL: L.LatLngBoundsLiteral = [[CITY_BOUNDS.south, CITY_BOUNDS.west], [CITY_BOUNDS.north, CITY_BOUNDS.east]];
const at = (p: LatLng): L.LatLngBoundsLiteral => [[p.lat, p.lng], [p.lat, p.lng]];
/** window.__streetMap for Playwright: dev/test builds, or the production build served on localhost (the test server). */
const TEST_HOOK = import.meta.env.MODE !== 'production' || (typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(location.hostname));

type FeedState = 'loading' | 'error' | 'ok';
/** What GET /api/street/case/:id added to the selected case (api/street caches it per id). */
interface CaseMore { id: string; state: 'loading' | 'ok' | 'error'; detail: CaseDetail | null }
/** history.state of entries this page pushes: `street` = ours; `depth` = how many case entries openCase has pushed on
 *  top of the entry the case page opened over (1 for a pin or row, +1 per nearby swap); `back` = that entry is a list
 *  view of this page, so "Back to map" may navigate(-depth) to it. Without `back` (the page opened from a deep link)
 *  "Back to map" pops to the deep link's own entry and removes its case= in place, so it never leaves the app. */
interface StreetHistoryState { street?: boolean; back?: boolean; depth?: number }

const LocateIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="1.5" fill="currentColor" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>;
const SearchIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></svg>;
const ShareIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3v12" /><path d="M8 7l4-4 4 4" /><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" /></svg>;

export default function Street() {
  const { t, lang, setLang } = useI18n();
  const session = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const parsed = useMemo(() => parseStreetUrl(params), [params]);
  // A custom range from an old link may reach back past what the 90-day load covers (its counts would read 0): it is
  // read inside the inputs' bounds, and the address bar follows (below, once setUrl exists).
  const url = useMemo(() => ({ ...parsed, range: clampRange(parsed.range, Date.now()) }), [parsed]);
  const desktop = useMediaQuery(DESKTOP_MQ);

  const point = useMemo((): LatLng | null => (url.lat != null && url.lng != null ? { lat: url.lat, lng: url.lng } : null), [url.lat, url.lng]);
  const pointKey = point ? `${point.lat.toFixed(5)},${point.lng.toFixed(5)}` : '';
  // Keyed by value: the URL is parsed again on every c/z write, and a pan must not look like a filter change.
  const gKey = url.g.join(','), fromKey = url.range?.from ?? '', toKey = url.range?.to ?? '';
  const filters: Filters = useMemo(() => ({ g: url.g, s: url.s, d: url.d, range: url.range }), [gKey, url.s, url.d, fromKey, toKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const wantDays: MapDays = useMemo(() => feedDays(filters, Date.now()), [filters]);
  // The phone's rail grows by the From / To row while "Custom range…" is chosen.
  const railBottom = desktop ? 0 : RAIL_BOTTOM + (filters.range ? RANGE_ROW : 0);
  const fullInset = SHEET_FULL_INSET + (!desktop && filters.range ? RANGE_ROW : 0);

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
  const hoodOf = useCallback((c: MapCase) => hoodMap.get(c.id) ?? (nb && c.lat != null && c.lng != null ? hoodOfSync(nb, c.lat, c.lng) : null), [hoodMap, nb]);
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

  /** The sheet height at detent `d` — the height it is about to have, not the one the 60 ms mirror last saw.
   *  `stage` overrides the mirrored stage height (doFit passes the live measurement: a fit can run before the mirror has). */
  const sheetHeightAt = useCallback((d: Detent, stage = stageH) => {
    if (desktop) return 0;
    const peek = Math.max(SHEET_PEEK_MIN, peekH);
    if (d === 'peek' || stage <= 0) return d === 'peek' ? peek : sheetH;
    return d === 'half' ? Math.min(Math.max(peek, Math.round(stage / 2)), stage - fullInset) : Math.max(peek, stage - fullInset);
  }, [desktop, stageH, sheetH, peekH, fullInset]);
  // The sheet top for the current detent: the in-view band and panInside use it so a pin tapped at PEEK is panned
  // clear of the HALF sheet in the same commit that raises it (the mirrored --sheet-h would still read PEEK).
  const sheetTop = sheetHeightAt(detent);
  const peekTop = sheetHeightAt('peek');
  const cityFit = useMemo(() => (desktop ? undefined : { top: railBottom, bottom: peekTop }), [desktop, railBottom, peekTop]);

  /** A programmatic fit: the point/bounds centred in the band between the rail and the sheet at detent `d`. */
  const doFit = useCallback((bounds: L.LatLngBoundsLiteral, d: Detent, name: string, maxZoom?: number) => {
    awaitingFitRef.current = true;
    setFit({ bounds, paddingTop: railBottom, paddingBottom: sheetHeightAt(d, stageRef.current?.clientHeight || 0), maxZoom, key: `${name}#${++fitSeq.current}` });
  }, [railBottom, sheetHeightAt]);

  /* ── URL writers ──────────────────────────────────────────────────────────────────────────────── */
  /** Replace writes (c/z, g/s/d, dropping a gone case) keep the entry's history.state — an external deep link stays
   *  "not ours" after a pan or a chip tap. Pushes are stamped ours (`street`), plus whatever `state` adds. */
  const setUrl = useCallback((patch: Partial<StreetUrlState>, replace: boolean, state?: StreetHistoryState) => {
    const cur = (locationRef.current.state as StreetHistoryState | null) ?? null;
    const q = streetSearch({ ...urlRef.current, ...patch }); // setSearchParams would write g's commas as %2C
    navigate({ search: q ? `?${q}` : '' }, { replace, state: replace ? cur : { street: true, ...state } });
  }, [navigate]);
  // A range the read clamped (or dropped) replaces the link's own, so Share and a reload carry the dates shown.
  useEffect(() => { if (url.range !== parsed.range) setUrl({ range: url.range }, true); }, [url, parsed, setUrl]);

  const [stackIds, setStackIds] = useState<string[] | null>(null);
  /** The phone's pin preview (components/StreetPreview): the case whose card shows — never in the URL. `previewTap`
   *  counts pin taps (focus and the nudge run once per tap, also on a tap of the pin already shown). */
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewTap, setPreviewTap] = useState(0);
  const previewRef = useRef<HTMLElement>(null);
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

  // The From / To row came or went (the phone's rail grew or shrank by RANGE_ROW): move the map by half of it, so the
  // band between the rail and the sheet keeps its centre — the address stays in the middle of what is listed. A view
  // that was the page's own fit stays one (c/z stay out of the URL).
  const railRef = useRef({ railBottom, desktop });
  useEffect(() => {
    const prev = railRef.current;
    railRef.current = { railBottom, desktop };
    if (!map || desktop || prev.desktop !== desktop || prev.railBottom === railBottom) return;
    const v = viewRef.current;
    if (v && isDefaultView({ center: v.center, zoom: v.zoom }, { fitted: fittedRef.current, point: pointRef.current, caseAt: caseAtRef.current })) awaitingFitRef.current = true;
    map.panBy([0, (prev.railBottom - railBottom) / 2], { animate: false });
  }, [railBottom, desktop, map]);

  /* ── Restore order: c+z (once) → n → lat/lng → case (when the feed lands) → the city ───────── */
  const [goSeq, setGoSeq] = useState(0);
  const lastTargetRef = useRef<string | null>(null);
  useEffect(() => {
    const target = url.hood ? `hood:${url.hood}` : point ? `pt:${pointKey}:${goSeq}` : url.caseId && lastTargetRef.current == null ? 'case' : 'city';
    if (target === lastTargetRef.current) return;
    if (target.startsWith('hood:') && !nb) return; // the rings are still loading; this effect re-runs when they land
    const prev = lastTargetRef.current;
    lastTargetRef.current = target;
    // The card is not in the URL: a view this effect fits — Back or Forward to another address, neighborhood or the
    // city — leaves it behind with the view it was opened on. Not a pan off a neighborhood (no refit: the card stays).
    if (target.startsWith('hood:') || target.startsWith('pt:') || (target === 'city' && prev?.startsWith('pt:'))) setPreviewId(null);
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
  // The PEEK sheet settles after the first city fit (the subtitle wraps, the "since you last looked" line lands), and
  // the city is the furthest out the map goes: refit the untouched city view so its southern edge is not left under it.
  const peekFitRef = useRef(peekH);
  useEffect(() => {
    if (peekFitRef.current === peekH) return;
    peekFitRef.current = peekH;
    // Only while the map still shows that fit — read live, not from the debounced view: moving the map rewrites the
    // summary, which resizes the header and lands here within the debounce (and a cluster flight is not a gesture).
    const m = map as (L.Map & { _flyToFrame?: number | null; _animatingZoom?: boolean; _panAnim?: { _inProgress?: boolean } }) | null;
    if (!m || m._flyToFrame || m._animatingZoom || m._panAnim?._inProgress) return;
    // The city fit was asked for but has not reported its view yet (awaitingFitRef — a slow phone measures the sheet
    // inside that window): it is the fit to redo, as is, or the city's south edge stays under the sheet.
    const pending = awaitingFitRef.current && lastTargetRef.current === 'city';
    const f = fittedRef.current, c = m.getCenter();
    const untouched = pending || (!!f && Math.round(m.getZoom()) === Math.round(f.zoom) && metersBetween(c.lat, c.lng, f.center.lat, f.center.lng) <= 30);
    if (!desktop && lastTargetRef.current === 'city' && !moved && untouched && detent === 'peek' && !url.caseId) doFit(CITY_LL, 'peek', 'city');
  }, [peekH]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Selection (case=) ────────────────────────────────────────────────────────────────────────── */
  // A case= missing from the loaded window is looked up on its own; `lookedUp.c === null` = the city's record is gone.
  const [lookedUp, setLookedUp] = useState<{ id: string; c: MapCase | null } | null>(null);
  const lookupRef = useRef<string | null>(null);
  const selectedCase = useMemo(() => {
    if (!url.caseId || !data) return null;
    return data.cases.find((c) => c.id === url.caseId) ?? (lookedUp?.id === url.caseId ? lookedUp.c : null);
  }, [url.caseId, data, lookedUp]);
  /** The selected case when it came from the lookup, not the feed: drawn as a pin alongside the window's cases. */
  const extraCase = selectedCase && lookedUp?.id === selectedCase.id && !data?.cases.some((c) => c.id === selectedCase.id) ? selectedCase : null;
  const lookingUp = !!url.caseId && !!data && !selectedCase && lookedUp?.id !== url.caseId;
  // Handlers and timers read the latest URL / point / selected case through refs (layout effect: before every other effect of the commit).
  useLayoutEffect(() => {
    urlRef.current = url; pointRef.current = point; locationRef.current = location;
    caseAtRef.current = selectedCase && selectedCase.lat != null && selectedCase.lng != null ? { lat: selectedCase.lat, lng: selectedCase.lng } : null;
  });
  const selectViaRef = useRef<'pin' | 'row' | 'nearby' | 'card' | null>(null);
  const handledCaseRef = useRef<string | null>(null);
  const [goneId, setGoneId] = useState<string | null>(null);
  // The map never pans for a selection (MapView panToSelection={false}): the case page covers it, and closing the page
  // must find the view as it was. A case= restored from a URL is fitted to only when it is the view's sole target — a
  // shared c/z view, a point or a neighborhood in the same URL decides the framing (spec urlState: "a shared view wins once").
  const refitRef = useRef(false); // a case= that was the URL's sole target and missing from the 30-day set: fit to it when the 90-day set has it
  useEffect(() => {
    if (!url.caseId) { handledCaseRef.current = null; return; }
    if (!data) return;
    if (!selectedCase && lookedUp?.id !== url.caseId) {
      // Not in this window (a followed case may be months old, from the follow mail or a /my row): ask for the case
      // itself, once per id. This comes before the handled check so an already-shown case is fetched too, and drawn as
      // extraCase. The effect runs again when the answer lands; a failed request counts as gone (there is nothing else to try).
      if (lookupRef.current !== url.caseId) {
        const id = url.caseId; lookupRef.current = id;
        getStreetCase(id).then((c) => setLookedUp({ id, c }), () => setLookedUp({ id, c: null }));
      }
      return;
    }
    if (handledCaseRef.current === url.caseId && selectedCase) return; // selected already: a new window only redraws it
    handledCaseRef.current = url.caseId;
    const via = selectViaRef.current ?? 'url'; selectViaRef.current = null;
    if (!selectedCase) {
      setGoneId(url.caseId);
      setUrl({ caseId: null }, true);
      if (lastTargetRef.current === 'case') { refitRef.current = true; lastTargetRef.current = 'city'; doFit(CITY_LL, 'half', 'city'); }
      return;
    }
    setGoneId(null);
    track('street_case', { via, src: data.cases.some((c) => c.id === selectedCase.id) ? 'feed' : 'lookup' });
    if (via === 'url') {
      // Fit to the case only when nothing else framed the view ('case': the URL's sole target, or that case found
      // again after the 90-day switch). A c/z, point or hood restore already placed the map — just select.
      const fitToCase = lastTargetRef.current === 'case' || refitRef.current;
      refitRef.current = false;
      if (fitToCase) {
        if (selectedCase.lat != null && selectedCase.lng != null) doFit(at({ lat: selectedCase.lat, lng: selectedCase.lng }), 'half', `case:${selectedCase.id}`, 17);
        else doFit(CITY_LL, 'half', 'city'); // an unplaced case: the page, over the whole city
      }
    }
  }, [url.caseId, data, selectedCase, lookedUp]); // eslint-disable-line react-hooks/exhaustive-deps
  // A case that was not in the 30-day set: once the 90-day set has it, select it again.
  useEffect(() => {
    if (goneId && data && data.cases.some((c) => c.id === goneId)) { setGoneId(null); setUrl({ caseId: goneId }, true); }
  }, [goneId, data, setUrl]);

  /** Open the case page (a pin or a fanned pin at ≥ 720 px, a row, the phone's preview card) or swap it to a nearby
   *  case. The map, the detent and the list stay as they are. Every open is a history entry, so Back — ours, the
   *  browser's or Android's — closes the page, and Back from a nearby case returns to the one before it
   *  (StreetHistoryState). */
  const openerRef = useRef<{ via: 'pin' | 'row' | 'card'; id: string } | null>(null);
  const openCase = (id: string, via: 'pin' | 'row' | 'nearby' | 'card') => {
    if (via === 'pin') track('street_pin', { kind: 'pin' });
    const cur = urlRef.current;
    if (cur.caseId === id) return;
    selectViaRef.current = via;
    if (via !== 'nearby') openerRef.current = { via, id };
    const st = (locationRef.current.state as StreetHistoryState | null) ?? null;
    if (cur.caseId) setUrl({ caseId: id }, false, { back: st?.back, depth: (st?.depth ?? 0) + 1 });
    else setUrl({ caseId: id }, false, { back: true, depth: 1 });
  };
  /** "Back to map", Escape, the backdrop: pop every case entry we pushed; from a deep link, pop to its entry and drop
   *  its case= there (`strip`; the page stays hidden in between — `holding`). Once per entry: a second Escape before
   *  the URL has moved would pop one entry too many. */
  const closingKeyRef = useRef<string | null>(null);
  const stripRef = useRef(false);
  const [holding, setHolding] = useState(false);
  const closeCase = () => {
    const loc = locationRef.current;
    if (closingKeyRef.current === loc.key) return;
    closingKeyRef.current = loc.key;
    const st = (loc.state as StreetHistoryState | null) ?? null;
    const depth = st?.depth ?? (st?.back ? 1 : 0);
    if (depth > 0 && st?.back) navigate(-depth);
    else if (depth > 0) { stripRef.current = true; setHolding(true); navigate(-depth); }
    else setUrl({ caseId: null }, true);
  };
  useEffect(() => {
    closingKeyRef.current = null; // the URL moved: the next close is a new one (Forward can bring back the same entry)
    if (!stripRef.current || (location.state as StreetHistoryState | null)?.depth) return;
    stripRef.current = false;
    if (urlRef.current.caseId) setUrl({ caseId: null }, true);
  }, [location.key]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!url.caseId) setHolding(false); }, [url.caseId]);
  const caseOpen = !!selectedCase && !holding;
  // Closed (by any of the above or the browser's Back): focus goes back to what opened the page — the row, the preview
  // card's face (still there), or the map for a pin (pins are aria-hidden; the map's container is their focusable
  // owner) — and, for a deep link, to the sheet's grabber (phone) or the map (desktop). Not when focus has already gone
  // somewhere on purpose.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (caseOpen) { wasOpenRef.current = true; return; }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const o = openerRef.current; openerRef.current = null;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const stage = stageRef.current;
    const row = o?.via === 'row' ? stage?.querySelector<HTMLElement>(`.street-row-btn[data-id="${CSS.escape(o.id)}"]`) : null;
    const card = o?.via === 'card' ? previewRef.current?.querySelector<HTMLElement>('.street-preview-open') : null;
    const grab = !o && !desktop ? stage?.querySelector<HTMLElement>('.street-grab') : null;
    (row ?? card ?? grab ?? map?.getContainer())?.focus({ preventScroll: true });
  }, [caseOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── The selected case's detail: GET /api/street/case/:id once per id (api/street caches it; the stale deep-link
   *  lookup above already filled the cache for its case). The page shows at once; the detail block follows. ────── */
  const [caseMore, setCaseMore] = useState<CaseMore | null>(null);
  const selectedId = selectedCase?.id ?? null;
  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    getStreetCaseFull(selectedId).then(
      (r) => { if (live) setCaseMore({ id: selectedId, state: 'ok', detail: r?.detail ?? null }); },
      () => { if (live) setCaseMore({ id: selectedId, state: 'error', detail: null }); },
    );
    return () => { live = false; };
  }, [selectedId]);
  const moreFor = (id: string): CaseMore => {
    if (caseMore?.id === id) return caseMore;
    const hit = peekStreetCase(id); // settled already (a reopened case, the deep-link lookup): no skeleton flash
    return hit !== undefined ? { id, state: 'ok', detail: hit?.detail ?? null } : { id, state: 'loading', detail: null };
  };

  const onBackgroundTap = () => { setStackIds(null); setPreviewId(null); };
  const onStackTap = (ids: string[]) => { track('street_pin', { kind: 'stack' }); setPreviewId(null); setStackIds(ids); setDetentState((d) => (d === 'peek' ? 'half' : d)); };
  const onClusterTap = () => { track('street_pin', { kind: 'cluster' }); setPreviewId(null); };

  /* ── Derived sets ─────────────────────────────────────────────────────────────────────────────── */
  const zoom = view?.zoom ?? 12;
  const landing = !point && !url.hood && zoom <= 13;
  const bandBounds = useMemo((): Bounds | null => {
    if (!view) return null;
    if (!map || desktop) return padBounds(view.bounds, 0.05);
    const size = map.getSize();
    const top = railBottom, bottom = size.y - sheetTop;
    if (bottom - top < 40) return padBounds(view.bounds, 0.05);
    const nw = map.containerPointToLatLng([0, top]); const se = map.containerPointToLatLng([size.x, bottom]);
    return padBounds({ south: se.lat, west: nw.lng, north: nw.lat, east: se.lng }, 0.05);
  }, [view, railBottom, sheetTop, desktop, map]);

  const filtered = useMemo(() => (data ? applyFilters(data.cases, filters, nowMs) : []), [data, filters, nowMs]);
  /** n=: the neighborhood's own cases (inside its outline), all and filtered; null without n= or until the rings load. */
  const hoodAll = useMemo(() => (url.hood && nb && data ? data.cases.filter((c) => hoodOf(c) === url.hood) : null), [url.hood, nb, data, hoodOf]);
  const hoodCases = useMemo(() => (hoodAll ? applyFilters(hoodAll, filters, nowMs) : null), [hoodAll, filters, nowMs]);
  const points = useMemo<MapPoint[]>(() => {
    // The pin draws the type's glyph; a case open and reported in the last 48 h gets the halo.
    const pin = (c: MapCase): MapPoint[] => (c.lat != null && c.lng != null ? [{ id: c.id, lat: c.lat, lng: c.lng, open: c.open, group: c.group, isNew: isNewCase(c, nowMs) }] : []);
    const pts = filtered.flatMap(pin);
    if (extraCase) pts.push(...pin(extraCase));
    return pts;
  }, [filtered, extraCase, nowMs]);
  const inView = useMemo(() => {
    if (hoodCases) return point ? sortForPoint(hoodCases, point) : hoodCases;
    if (!bandBounds) return [];
    const list = filtered.filter((c) => inBounds(c, bandBounds));
    return point ? sortForPoint(list, point) : list;
  }, [hoodCases, filtered, bandBounds, point]);
  const counts = useMemo(
    () => (data && (landing || bandBounds || hoodAll) ? facetCounts(hoodAll ?? data.cases, landing || hoodAll ? null : bandBounds, filters, nowMs) : null),
    [data, hoodAll, landing, bandBounds, filters, nowMs],
  );
  const summary = useMemo(() => summaryOf(hoodCases ?? filtered, landing || hoodCases ? null : bandBounds, filters.d), [hoodCases, filtered, landing, bandBounds, filters.d]);
  const top3 = useMemo(() => topGroups(filtered, 3), [filtered]);
  const stackCases = useMemo(() => (stackIds && data ? stackIds.flatMap((id) => data.cases.filter((c) => c.id === id)) : null), [stackIds, data]);
  const [shown, setShown] = useState(PAGE);
  useEffect(() => { setShown(PAGE); }, [view, filters]);

  // One automatic zoom step 16 → 15 when nothing is near the address (not after a shared z or a user move).
  const [widened, setWidened] = useState(false);
  const firstPointRef = useRef(true);
  useEffect(() => { if (firstPointRef.current) { firstPointRef.current = false; return; } setWidened(false); setGoneId(null); setMoved(false); }, [pointKey]);
  useEffect(() => {
    if (!point || !data || feedState !== 'ok' || widened || url.zoom != null || moved || !view || !bandBounds) return;
    if (Math.round(view.zoom) !== 16 || inView.length > 0 || filters.g.length > 0 || filters.s != null) return;
    setWidened(true);
    doFit(at(point), 'half', `pt15:${pointKey}`, 15);
  }, [point, data, feedState, widened, url.zoom, moved, view, bandBounds, inView.length, filters.g, filters.s, pointKey, doFit]);

  /* ── The phone's pin preview (components/StreetPreview) ───────────────────────────────────────── */
  // A pin tap at ≥ 720 px opens the case page as before. Under 720 px it shows the card, which needs the PEEK sheet: at
  // HALF the band above the sheet is about as tall as the card, so the tap lowers the sheet (Zillow's list does the
  // same), and raising it again closes the card. The card also goes when its case leaves the filters or the window,
  // and at ≥ 720 px (no card there).
  const previewCase = useMemo(
    () => (previewId && !desktop && detent === 'peek' ? filtered.find((c) => c.id === previewId && c.lat != null && c.lng != null) ?? null : null),
    [previewId, desktop, detent, filtered],
  );
  useEffect(() => { if (previewId && !previewCase) setPreviewId(null); }, [previewId, previewCase]);
  // While the card shows, the map's pan limit (MapView keepInCity) reaches below the sheet by the card too, so a pin in
  // the city's south half at the landing zoom can move up clear of it (keepPinClear) instead of being pulled back under
  // it. The in-view band and the list still end at the sheet (bandBounds reads sheetTop).
  const [previewH, setPreviewH] = useState(0);
  useLayoutEffect(() => { if (previewCase && previewRef.current) setPreviewH(previewRef.current.offsetHeight); }, [previewCase]);
  const cardBottom = previewCase ? PREVIEW_DOCK + previewH : 0;
  const insets = useMemo(() => (desktop ? { top: 0, bottom: 0 } : { top: railBottom, bottom: sheetTop + cardBottom }), [desktop, railBottom, sheetTop, cardBottom]);
  const onPin = (id: string) => {
    if (desktop) { openCase(id, 'pin'); return; }
    track('street_pin', { kind: 'pin' });
    setStackIds(null);
    if (detent !== 'peek') setDetent('peek', 'auto');
    setPreviewId(id); setPreviewTap((n) => n + 1);
  };
  /** The × and Escape: the card goes and focus goes to the map, the pins' focusable owner (they are aria-hidden). */
  const closePreview = () => { setPreviewId(null); map?.getContainer().focus({ preventScroll: true }); };
  /** A pin the card would cover moves up just clear of it: the pin's tip and selection ring PREVIEW_GAP above the
   *  card's top, the smallest move that shows both. The card's top is read off its `bottom` (Street.css: the sheet's
   *  height + the attribution's strip), which the sheet has already set for PEEK even while its height animates there. */
  const keepPinClear = () => {
    const card = previewRef.current, stage = stageRef.current;
    if (!previewCase || !card || !stage || !map) return;
    const pin = stage.querySelector<HTMLElement>(`.mapview .map-case[data-id="${CSS.escape(previewCase.id)}"]`);
    if (!pin) return;
    const cardTop = stage.clientHeight - parseFloat(getComputedStyle(card).bottom) - card.offsetHeight;
    const tip = pin.getBoundingClientRect().bottom - stage.getBoundingClientRect().top + PIN_RING_PX;
    const over = Math.round(tip + PREVIEW_GAP - cardTop);
    if (over > 0) map.panBy([0, over], { animate: !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches });
  };
  // Every pin tap: focus moves to the card (a region named "Selected request"), and the pin is kept clear of it.
  useEffect(() => {
    if (!previewTap || !previewCase) return;
    previewRef.current?.focus({ preventScroll: true });
    keepPinClear();
  }, [previewTap]); // eslint-disable-line react-hooks/exhaustive-deps
  // The PEEK sheet grew under the card (its subtitle wrapped, the places row came): the card rose with it. Never under
  // the case page, which the map must not move behind.
  useEffect(() => { if (!caseOpen) keepPinClear(); }, [peekH]); // eslint-disable-line react-hooks/exhaustive-deps
  // Panned or pinched far — the case left the band between the rail and the sheet: the card goes with it. (Under the
  // card is still in the band: a small pan never closes it.)
  useEffect(() => {
    if (!previewCase || !view?.userGesture || !map) return;
    const p = map.latLngToContainerPoint([previewCase.lat!, previewCase.lng!]), size = map.getSize();
    if (p.y < railBottom || p.y > size.y - sheetTop || p.x < 0 || p.x > size.x) setPreviewId(null);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  // Escape closes it — from the card, the map or nowhere; not another control's Escape (the map key, the Type dialog,
  // the search box), and not while the case page (its own Escape) is over it.
  useEffect(() => {
    if (!previewCase || caseOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const a = document.activeElement;
      if (a && a !== document.body && a !== map?.getContainer() && !previewRef.current?.contains(a)) return;
      e.preventDefault();
      closePreview();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [previewCase, caseOpen, map]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Title + live summary ─────────────────────────────────────────────────────────────────────── */
  const [centerHood, setCenterHood] = useState<string | null>(null);
  useEffect(() => {
    if (!view || !nb || view.zoom < 14) { setCenterHood(null); return; }
    setCenterHood(hoodOfSync(nb, view.center.lat, view.center.lng));
  }, [view, nb]);
  const bandCenter = bandBounds ? { lat: (bandBounds.south + bandBounds.north) / 2, lng: (bandBounds.west + bandBounds.east) / 2 } : null;
  const nearPoint = !!point && !!bandCenter && metersBetween(bandCenter.lat, bandCenter.lng, point.lat, point.lng) < NEAR_POINT_M;
  const title = stackIds ? t('street.spot', { n: stackIds.length })
    : nearPoint ? (url.q || t('street.here'))
    : url.hood ? url.hood
    : zoom >= 14 && centerHood ? centerHood
    : t('street.city.name');

  const locale = lang === 'es' ? 'es' : 'en-US';
  const num = (n: number) => n.toLocaleString(locale);
  /** A Providence calendar day ("YYYY-MM-DD") as "Oct 1" / "1 oct". */
  const dayText = (ymd: string) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }); };
  /** The day we started reading the city's list, when the loaded window reaches back to it (the feed's firstDay). */
  const first = data?.firstDay ?? null;
  /** The window in words: the summary's tail ("last 24 hours", "Oct 1 – Oct 15") and the empty states' ("in the last
   *  24 hours", "from Oct 1 to Oct 15"); a one-day range is its date. A window reaching back before `first` holds no
   *  more than what came since: "since Oct 10", and a range starts there (2026-10-28 audit: 30 and 90 days both 546). */
  const windowWords = (r: DateRange | null, d: number, kind: 'window' | 'when') => {
    if (r) {
      const from = first && r.from < first && r.to >= first ? first : r.from;
      return from === r.to ? (kind === 'when' ? t('street.when.date', { date: dayText(from) }) : dayText(from)) : t(`street.${kind}.range`, { from: dayText(from), to: dayText(r.to) });
    }
    if (first && nowMs - d * DAY_MS < nyDayStart(first)) return t(`street.${kind}.since`, { date: dayText(first) });
    return d === 1 ? t(`street.${kind}.day`) : t(`street.${kind}.days`, { days: d });
  };
  const summaryText = !data
    ? (feedState === 'error' ? t('street.error') : t('street.loading'))
    : summary.kind === 'city' && url.hood && hoodCases
      ? t('street.summary.hood', { n: num(summary.total), hood: url.hood, open: num(summary.open), closed: num(summary.closed) })
    : summary.kind === 'city'
      ? t('street.summary.city', { total: num(summary.total), open: num(summary.open), closed: num(summary.closed), window: windowWords(filters.range, summary.days, 'window') })
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
      track('street_view', { mode, d: u.range ? 'range' : u.d, g: u.g.join('+'), s: u.s ?? '', z: Math.round(viewRef.current?.zoom ?? 0) });
    }, 500);
    return () => window.clearTimeout(id);
  }, [location.search]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Search / locate / saved places ───────────────────────────────────────────────────────────── */
  const [text, setText] = useState(url.q);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setText(url.q); }, [url.q]);

  function go(address: string, la: number, ln: number) {
    // Search and locate check this already; a saved place (Account accepts any address) must too — the map cannot go there.
    if (!inProvidence(la, ln)) { setMsg(t('street.outside')); return; }
    setMsg(null); setStackIds(null); setPreviewId(null); setGoSeq((s) => s + 1);
    setUrl({ lat: la, lng: ln, q: address, caseId: null, hood: null, center: null, zoom: null }, false);
    setDetent('half', 'auto');
  }
  function clearAddress() {
    setText(''); setMsg(null); setPreviewId(null);
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

  /* ── Filters, whole city, zoom out ────────────────────────────────────────────────────────────── */
  const onFilters = (f: Filters) => {
    setUrl({ g: f.g, s: f.s, d: f.d, range: f.range }, true);
    track('street_filter', { g: f.g.join('+'), s: f.s ?? '', d: f.range ? 'range' : f.d });
  };
  const seeCity = () => {
    setStackIds(null); setPreviewId(null);
    setUrl({ hood: null, center: null, zoom: null, caseId: null }, true);
    lastTargetRef.current = 'city';
    // The whole city fits the PEEK band (MapView's zoom-out floor is derived from it), so lower the sheet with the fit.
    setDetent('peek', 'auto');
    doFit(CITY_LL, 'peek', 'city');
  };
  const zoomOut = () => { if (map) map.setZoom(Math.max(10, map.getZoom() - 2)); };

  /* ── Share ────────────────────────────────────────────────────────────────────────────────────── */
  async function share() {
    const cur = urlRef.current; const v = viewRef.current;
    const def = !v || isDefaultView({ center: v.center, zoom: v.zoom }, { fitted: fittedRef.current, point: pointRef.current, caseAt: caseAtRef.current });
    const p = streetSearch({ ...cur, center: !def && v ? v.center : null, zoom: !def && v ? v.zoom : null });
    if (!def && v && !cur.center) setUrl({ center: v.center, zoom: v.zoom }, true); // location.href matches what we copy
    const href = `${window.location.origin}/street${p ? `?${p}` : ''}`;
    track('street_share');
    try {
      if (typeof navigator.share === 'function') { await navigator.share({ url: href }); return; }
      await navigator.clipboard.writeText(href);
      setFlash(t('street.detail.copied'));
    } catch { /* cancelled or blocked */ }
  }

  /* ── Account (shared by the digest switch, the Follow toggle and "Your places") ─────────────────── */
  const [me, setMe] = useState<Me | null>(null);
  // The city cases this account follows (users.cityFollowing). Its own state, not derived from `me`: the toggles below
  // update it optimistically and the digest switch's saves must not reset it. null = signed out / not loaded yet.
  const [cityFollowing, setCityFollowing] = useState<string[] | null>(null);
  const [meState, setMeState] = useState<FollowAccountState>('loading');
  const [meTick, setMeTick] = useState(0); // the Follow toggle's retry after a failed load
  useEffect(() => {
    if (!session) { setMe(null); setCityFollowing(null); setMeState('loading'); return; }
    let live = true;
    setMeState('loading');
    getMe().then((m) => { if (live) { setMe(m); setCityFollowing(m.cityFollowing ?? []); setMeState('ok'); } }).catch(() => { if (live) setMeState('error'); });
    return () => { live = false; };
  }, [session, meTick]);
  // Whether the Worker would mail this account about a followed case (cityfollow.eligibleFollowers): the card and the
  // /my hint only promise an email when it will arrive.
  const followEmail: FollowEmailState | undefined = me ? (me.prefs.emailUpdates === false ? 'off' : !me.emailVerified ? 'unverified' : 'ok') : undefined;

  /* ── Follow a city case (PUT/DELETE /api/me/city/:guid): optimistic, reverted on failure ───────── */
  const setFollowed = (id: string, on: boolean) => setCityFollowing((cur) => { const rest = (cur ?? []).filter((x) => x !== id); return on ? [id, ...rest] : rest; });
  async function followCase(id: string) {
    setFollowed(id, true);
    try { await followCity(id); track('street_follow', { on: true }); } catch (e) { setFollowed(id, false); throw e; }
  }
  async function unfollowCase(id: string) {
    setFollowed(id, false);
    try { await unfollowCity(id); track('street_follow', { on: false }); } catch (e) { setFollowed(id, true); throw e; }
  }
  const here = location.pathname + location.search;
  /** The sign-in links' returnTo: this exact URL (takeReturnTo accepts /street's `+` and `,`); should it ever hold a
   *  character the allowlist rejects, the case alone — the same shape as the follow mail's link — so the card still reopens. */
  const returnHere = (c?: MapCase | null) => {
    if (isSafeReturnTo(here)) return here;
    return c ? caseHref(c) : '/street';
  };

  /* ── Render helpers ───────────────────────────────────────────────────────────────────────────── */
  const [hover, setHover] = useState<string | null>(null);
  const rowWith = (c: MapCase, tag?: string) => (
    <StreetRow key={c.id} c={c} hood={hoodOf(c)} distanceM={point ? distanceM(c, point) : null} selected={c.id === url.caseId}
      onSelect={(id) => openCase(id, 'row')} onHover={desktop ? setHover : undefined} nowMs={nowMs} tag={tag} />
  );
  const row = (c: MapCase) => rowWith(c);
  /** "Most reported": the busiest type groups of what the filters show. A chip is pressed while its group is the whole
   *  Type selection; a tap picks just it, or clears it. */
  const only = (g: string) => filters.g.length === 1 && filters.g[0] === g;
  const topChips = top3.length > 0 && (
    <ul className="street-top" aria-label={t('street.city.top')}>
      {top3.map((x) => (
        <li key={x.group}>
          <button type="button" className="street-top-item" aria-pressed={only(x.group)} onClick={() => onFilters({ ...filters, g: only(x.group) ? [] : [x.group] })}>
            <CategoryIcon k={GROUP_ICON[x.group]} size={18} /><span className="street-top-name">{t(`group.${x.group}`)}</span><b>{num(x.n)}</b>
          </button>
        </li>
      ))}
    </ul>
  );
  /** "Report something here", with the address the map is about (not the "Where you are" stand-in for a located point). */
  const reportHere = <Link to={reportHref(point, url.q && url.q !== t('street.here') ? url.q : '')} className="btn btn-secondary">{t('street.report')}</Link>;
  const meanwhile = (
    <section className="street-meanwhile" aria-label={t('street.city.meanwhile')}>
      <h3 className="street-h">{t('street.city.meanwhile')}</h3>
      {topChips}
      <button type="button" className="btn btn-ghost" onClick={seeCity}>{t('street.wholeCity')}</button>
    </section>
  );
  // A custom range counts as short of 90 days: "Look back 90 days" replaces it with the preset.
  const short = filters.range != null || filters.d < 90;
  const cached90 = short ? peekStreetMap(90) : null;
  const lookBack = short && (
    <button type="button" className="btn btn-ghost" onClick={() => onFilters({ ...filters, d: 90, range: null })}>
      {t('street.fix.days')}{cached90 && bandBounds ? ` (${num(applyFilters(cached90.cases, { ...filters, d: 90, range: null }, nowMs).filter((c) => landing || inBounds(c, bandBounds)).length)})` : ''}
    </button>
  );
  const when = windowWords(filters.range, filters.d, 'when');
  const active = filters.g.length > 0 || filters.s != null;

  function renderEmpty(): ReactNode {
    if (active && counts) {
      return (
        <div className="street-none">
          <p>{t('street.nothing', { when })}</p>
          <div className="street-fixes">
            {filters.g.length > 0 && counts.all > 0 && <button type="button" className="btn btn-ghost" onClick={() => onFilters({ ...filters, g: [] })}>{t('street.fix.allTypes', { n: num(counts.all) })}</button>}
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
          <p>{t('street.none', { when })}</p>
          {reportHere}
          {lookBack}
          {meanwhile}
        </div>
      );
    }
    return (
      <div className="street-none">
        <p>{t('street.nothing.plain', { when })}</p>
        <div className="street-fixes">
          <button type="button" className="btn btn-ghost" onClick={zoomOut}>{t('street.zoomOut')}</button>
          {lookBack}
        </div>
        {meanwhile}
      </div>
    );
  }

  /* ── "Your places this week": the saved addresses' 7-day counts, from the loaded feed (no request) ─── */
  // Every window the page loads (30 or 90 days) contains the last 7, so the card reads the same under either; the
  // filters are not applied — it is the glanceable answer to "anything at my places?", not a view of the map.
  const placeRows = useMemo(() => {
    if (!session || !me || !data) return [];
    return placedAddresses(me.addresses)
      .map((a) => ({ a, lat: a.lat, lng: a.lng, ...placeActivity(data.cases, { lat: a.lat, lng: a.lng }, nowMs, RING_M, PLACES_DAYS) }));
  }, [session, me, data, nowMs]);
  /** The card sits at the top of the landing list (signed in, ≥ 1 saved address with coordinates); a row does what
   *  its "Your places" chip does. Counted as one street_places_view per page mount. */
  const placesShown = landing && !!data && data.total > 0 && !stackCases && !lookingUp && filtered.length > 0 && placeRows.length > 0;
  const placesTracked = useRef(false);
  useEffect(() => {
    if (!placesShown || placesTracked.current) return;
    placesTracked.current = true;
    track('street_places_view', { n: placeRows.length });
  }, [placesShown, placeRows.length]);
  const placesCard = (
    <section className="card street-places-card" aria-labelledby="street-places-h">
      <h3 id="street-places-h" className="street-h">{t('street.places.title')}</h3>
      <ul className="street-places-list">
        {placeRows.map(({ a, lat, lng, created, closed }) => {
          const quiet = created === 0 && closed === 0;
          const counts = quiet ? t('street.places.quiet')
            : `${t(created === 1 ? 'street.places.new.one' : 'street.places.new', { n: num(created) })} · ${t(closed === 1 ? 'street.places.closed.one' : 'street.places.closed', { n: num(closed) })}`;
          return (
            <li key={a.id}>
              <button type="button" className="street-place" title={a.address} onClick={() => go(a.address, lat, lng)}>
                <span className="street-place-label">{a.label || addressLabel(a.address) || t('street.digest.defaultLabel')}</span>
                <span className={`street-place-n${quiet ? ' street-place-n--quiet' : ''}`}>{counts}</span>
                <span className="street-place-go" aria-hidden="true">›</span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );

  /* ── Return visit: "since you last looked" + the home-screen nudge (lib/streetVisit.ts) ─────────── */
  // The previous visit's seenAt is read once at mount; the new one and the visit count are written only after the feed
  // has loaded with the landing sheet on screen (once per mount) — so the comparison is always against the PREVIOUS visit,
  // and a digest link straight to an address never counts as having looked at the landing.
  const [prevSeenAt] = useState(() => readSeenAt());
  const [prevSeenFeedAt] = useState(() => readSeenFeedAt());
  const [visitNo, setVisitNo] = useState<number | null>(null);
  // The landing list is in the sheet (also behind an open case page — its header lines stay put); it counts as a visit
  // only with no case page over it.
  const landingList = landing && !stackIds && !!data;
  const landingShown = landingList && !url.caseId;
  const visitedRef = useRef(false);
  useEffect(() => {
    if (!landingShown || visitedRef.current) return;
    visitedRef.current = true;
    const now = Date.now();
    writeSeenAt(now);
    writeSeenFeedAt(Math.min(now, newestCreated(data?.cases ?? []) ?? now));
    setVisitNo(bumpVisits());
  }, [landingShown]); // eslint-disable-line react-hooks/exhaustive-deps
  // The second subtitle line + the "New" tags: only with a previous visit at least an hour old (sinceCutoff), over the
  // whole loaded feed (not the filters) — cases the city did not have last time. Plain text in the header (StreetSheet
  // `note`), never a second live region.
  const visitCutoff = sinceCutoff(prevSeenAt, nowMs);
  const cutoff = newCutoff(visitCutoff, prevSeenFeedAt); // what counts as new: after the newest case that visit saw
  const sinceN = useMemo(() => (cutoff != null && data ? newSince(data.cases, cutoff) : null), [cutoff, data]);
  let sinceNote: string | undefined;
  if (landingList && visitCutoff != null && sinceN != null) {
    const w = sinceWhen(visitCutoff, nowMs); // "when" is the visit, not the newest case it showed
    const when = w === 'today' ? t('street.ago.today') : w === 'yesterday' ? t('street.ago.yesterday') : w === 'while' ? t('street.since.while') : t('street.ago.days', { n: w.days });
    sinceNote = sinceN === 0 ? t('street.since.none', { when }) : t(sinceN === 1 ? 'street.since.one' : 'street.since', { n: num(sinceN), when });
  }
  // Home-screen nudge: from the 2nd landing visit, on a phone that can install (Chromium's beforeinstallprompt, or any
  // iPhone browser tab — iOS has no prompt event and only pushes from a Home Screen app), never once installed
  // (standalone), never at ≥ 720 px, held 30 days by "Not now". In the body (the sheet's PEEK height does not move).
  const { canInstall, install } = useInstallPrompt();
  const [env] = useState(() => currentEnv());
  const iosTab = isIOS(env) && !env.standalone;
  const [installState, setInstallState] = useState<'offer' | 'hint' | 'done'>(() => (installSnoozed(Date.now()) ? 'done' : 'offer'));
  const nudgeShown = landingList && !desktop && !env.standalone && installState !== 'done' && visitNo != null && visitNo >= INSTALL_FROM_VISIT && (canInstall || iosTab) && filtered.length > 0;
  const nudgeTracked = useRef(false);
  useEffect(() => {
    if (!nudgeShown || nudgeTracked.current) return;
    nudgeTracked.current = true;
    track('street_install_shown', { via: canInstall ? 'prompt' : 'ios' });
  }, [nudgeShown, canInstall]);
  // Both buttons remove themselves (the CTA on iPhone, the whole card otherwise): focus moves on with them, to the hint
  // or to the next control in the sheet after the card, instead of falling to <body>.
  const installRef = useRef<HTMLElement | null>(null);
  const installHintRef = useRef<HTMLParagraphElement | null>(null);
  const afterInstallRef = useRef<HTMLElement | null>(null);
  const installFocus = useRef(false);
  const leaveInstall = () => {
    const card = installRef.current;
    installFocus.current = !!card && card.contains(document.activeElement);
    if (!card || !installFocus.current) return;
    const sheetEl = card.closest('.street-sheet, .street-panel') ?? document;
    const all = Array.from(sheetEl.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), select:not([disabled]), input:not([disabled])'));
    afterInstallRef.current = all.find((el) => !card.contains(el) && !!(card.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? null;
  };
  useEffect(() => {
    if (!installFocus.current) return;
    if (installState === 'hint') installHintRef.current?.focus();
    else if (installState === 'done') { installFocus.current = false; if (afterInstallRef.current?.isConnected) afterInstallRef.current.focus(); afterInstallRef.current = null; }
  }, [installState]);
  const installTap = async () => {
    track('street_install_tap', { via: canInstall ? 'prompt' : 'ios' });
    leaveInstall();
    if (canInstall) { try { await install(); } catch { /* the browser declined to show its prompt */ } setInstallState('done'); }
    else setInstallState('hint');
  };
  const installLater = () => { track('street_install_later'); leaveInstall(); snoozeInstall(Date.now()); setInstallState('done'); };
  const installCard = (
    <section ref={installRef} className="card street-install" aria-labelledby="street-install-h">
      <h3 id="street-install-h" className="street-install-title">{t('street.install.title')}</h3>
      <p className="street-install-body">{t('street.install.body')}</p>
      <p ref={installHintRef} className="street-install-ios" role="status" tabIndex={-1}>{installState === 'hint' ? t('street.install.ios') : null}</p>
      <div className="street-install-actions">
        {installState !== 'hint' && <button type="button" className="btn btn-secondary street-install-cta" onClick={() => { void installTap(); }}>{t('street.install.cta')}</button>}
        <button type="button" className="btn btn-ghost street-install-later" onClick={installLater}>{t('street.install.later')}</button>
      </div>
    </section>
  );

  function renderBody(): ReactNode {
    if (!data) {
      if (feedState === 'error') return <div className="notice notice-error"><span>{t('street.error')}</span><button type="button" className="btn btn-ghost" onClick={() => setRetryTick((x) => x + 1)}>{t('street.retry')}</button></div>;
      return <div className="street-skel" aria-hidden="true"><span /><span /><span /></div>;
    }
    if (lookingUp) return <div className="street-skel street-skel--case" aria-hidden="true"><span /><span /><span /></div>;
    if (data.total === 0) {
      return (
        <div className="street-quiet">
          <Illustration kind="street" className="illo" />
          <p>{t('street.city.quiet', { when })}</p>
          <div className="street-fixes">{reportHere}{lookBack}</div>
        </div>
      );
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
          {nudgeShown && installCard}
          {placesShown && placesCard}
          <Link to="/week" className="card street-week-link">{t('street.weekLink')}</Link>
          <h3 className="street-h">{t('street.city.top')}</h3>
          {topChips}
          <h3 className="street-h">{t('street.city.latest')}</h3>
          <ul className="street-list">{filtered.slice(0, LATEST).map((c) => rowWith(c, isNewSince(c, cutoff) ? t('street.newTag') : undefined))}</ul>
        </>
      );
    }
    if (inView.length === 0) return renderEmpty();
    return (
      <>
        <h3 className="street-h">{hoodCases && url.hood ? url.hood : t('street.inview.title')}</h3>
        <ul className="street-list">{inView.slice(0, shown).map(row)}</ul>
        {inView.length > shown && <button type="button" className="btn btn-ghost street-more" onClick={() => setShown((s) => s + PAGE)}>{t('street.showMore', { n: num(inView.length - shown) })}</button>}
      </>
    );
  }

  const body = (
    <>
      {data && feedState === 'loading' && <div className="street-skel" aria-hidden="true"><span /><span /></div>}
      {goneId && (
        <div className="street-gone">
          <p className="hint" role="status">{t('street.caseGone')}</p>
        </div>
      )}
      {widened && <p className="hint street-widened" role="status">{t('street.widened')}</p>}
      {renderBody()}
      {/* The address view's one subscription control (components/StreetDigestCard), bound to the home point. */}
      {point && data && <StreetDigestCard lat={point.lat} lng={point.lng} address={url.q} returnTo={returnHere(selectedCase)} me={me} onMe={setMe} />}
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

  const showTeach = landing && !moved && [...params.keys()].every((k) => k === 'case') && detent === 'peek';
  const extraLines: ReactNode[] = [];
  if (showTeach) extraLines.push(<p key="teach" className="hint">{t('street.teach')}</p>);
  if (data && summary.kind === 'city' && summary.unplaced > 0) extraLines.push(<p key="unplaced" className="hint">{summary.unplaced === 1 ? t('street.unplaced.one') : t('street.unplaced', { n: num(summary.unplaced) })}</p>);
  if (data?.truncated && wantDays === 90) extraLines.push(<p key="trunc" className="hint">{t('street.truncated')}</p>);
  if (data && feedState === 'error') extraLines.push(<p key="asof" className="hint" role="status">{t('street.asOf', { time: new Date(data.at).toLocaleTimeString(lang, { hour: 'numeric', minute: '2-digit' }) })}</p>);

  const places = session && me && me.addresses.length > 0 ? (
    <div className="street-places-row">
      <span className="street-places-label">{t('street.places')}</span>
      <SavedAddresses onPick={(a) => { if (a.lat != null && a.lng != null) go(a.address, a.lat, a.lng); else setMsg(t('street.notFound')); }} />
    </div>
  ) : undefined;

  const shareBtn = <button type="button" className="street-ico" aria-label={t('street.detail.share')} onClick={share}>{ShareIcon}</button>;
  const filterBar = <StreetFilters filters={filters} counts={counts} loading={feedState === 'loading' && !!data} disabled={feedState === 'error' && !data} panel={desktop} onChange={onFilters} />;
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
      {filterBar}
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
        <button type="submit" form="street-search" className="street-ico" aria-label={t('street.search')} disabled={busy}>{SearchIcon}</button>
      </div>
      {filterBar}
      {msg && <p className="hint street-msg" role="status">{msg}</p>}
      {wholeCityBtn}
    </div>
  );

  /* ── The case page (components/StreetCasePage), over everything ──────────────────────────────────── */
  const nearby = useMemo<NearbyRow[]>(
    () => (selectedCase && data ? nearbyCases(data.cases, selectedCase).map(({ c, m }) => ({ c, m, hood: hoodOf(c) })) : []),
    [selectedCase, data, hoodOf],
  );
  let casePage: ReactNode = null;
  if (caseOpen && selectedCase) {
    const c = selectedCase;
    const followed = !!cityFollowing?.includes(c.id);
    const m = point ? distanceM(c, point) : null;
    casePage = (
      <StreetCasePage
        c={c} hood={hoodOf(c)} from={m != null ? { m, place: (url.q && url.q !== t('street.here') && addressLabel(url.q)) || null } : null} more={moreFor(c.id)} nowMs={nowMs}
        nearby={nearby} days={data?.days ?? wantDays} onNearby={(id) => openCase(id, 'nearby')} onClose={closeCase} onShare={share} flash={flash}
        follow={(notes) => (
          <StreetFollow key={c.id} signedIn={!!session} following={cityFollowing ? followed : null} returnTo={returnHere(c)}
            account={meState} onRetry={() => setMeTick((x) => x + 1)} email={followEmail}
            onFollow={() => followCase(c.id)} onUnfollow={() => unfollowCase(c.id)} notes={notes} />
        )}
      />
    );
  }

  return (
    <>
      <section className={`street-stage${!desktop && filters.range ? ' street-stage--range' : ''}`} ref={stageRef}>
        <h1 className="street-vh">{t('nav.street')}</h1>
        <p id="street-map-hint" className="street-vh">{t('street.map.hint')}</p>
        {!desktop && controls}
        {!desktop && <MapKey hidden={detent === 'full'} />}
        {previewCase && (
          <StreetPreview ref={previewRef} c={previewCase} hood={hoodOf(previewCase)} nowMs={nowMs}
            onOpen={() => openCase(previewCase.id, 'card')} onClose={closePreview} />
        )}
        {/* The sheet/panel keep the list while the case page is open; "Link copied" is the page's own line then. */}
        <StreetSheet
          detent={detent} onDetent={setDetent} title={title} subtitle={(!caseOpen && flash) || subtitle} note={sinceNote}
          labels={{ show: t('street.sheet.show'), more: t('street.sheet.more'), hide: t('street.sheet.hide'), map: t('street.sheet.map') }}
          places={places} extra={extraLines.length ? extraLines : undefined} actions={shareBtn} controls={desktop ? controls : undefined}
          tail={tail} desktop={desktop} panelLabel={t('nav.street')} busy={feedState === 'loading' && !!data}
          onPeekHeight={desktop ? undefined : setPeekH} fullInset={fullInset}
        >
          {body}
        </StreetSheet>
        {desktop && <MapKey withText />}
        <MapView
          key={desktop ? 'desk' : 'phone'}
          ariaLabel={t('street.map.label')} frameless={!desktop} zoomControl={desktop}
          points={points} selectedId={url.caseId ?? previewCase?.id ?? null} hoverId={hover} panToSelection={false}
          onSelect={onPin} onStackTap={onStackTap} onClusterTap={onClusterTap} onBackgroundTap={onBackgroundTap} onViewChange={onViewChange}
          home={point} ring={point ? RING_M : null} hood={hoodRings} fit={fit} insets={insets} cityFit={cityFit}
          onReady={(m) => { setMap(m); m.getContainer().setAttribute('aria-describedby', 'street-map-hint'); }}
          testHook={TEST_HOOK}
        />
      </section>
      {casePage}
    </>
  );
}
