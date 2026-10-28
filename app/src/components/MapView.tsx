import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MapView.css';
import { clusterGrid, SPIDER_MAX, spiderOffsets, stackKey, type Bounds, type Cluster, type ClusterPoint } from '../lib/streetMap';
import { caseMarker, casePinKey, clusterHtml, clusterMarker, clusterSize, homeMarker, LEG_CLASS, SPOT_CLASS, SPOT_R, type MarkerParts } from '../lib/mapMarkers';
import { CITY_MARGIN_DEG, PVD_BOUNDS } from '../lib/geo';
import type { LeafletLayerOptions, SourceOptions } from 'protomaps-leaflet';

/** A located city case to draw. Pass the whole filtered set: MapView keeps the ones inside `getBounds().pad(0.25)`.
 *  `group` picks the white type glyph in the pin's head; `isNew` (open, reported in the last 48 h) earns the halo. */
export interface MapPoint { id: string; lat: number; lng: number; open: boolean; group?: string; isNew?: boolean }
/** Debounced (150 ms) after every moveend/zoomend. `bounds` is the unpadded viewport; pad it yourself for the band. */
export interface MapViewChange { bounds: Bounds; center: { lat: number; lng: number }; zoom: number; userGesture: boolean }
/** A programmatic fit, applied whenever `key` changes. A degenerate bounds + `maxZoom` is "setView(point, maxZoom)"
 *  with the point centred in the band between the paddings. */
export interface MapFit { bounds: L.LatLngBoundsLiteral; paddingTop: number; paddingBottom: number; maxZoom?: number; key: string }
/** Chrome over the map (rail bottom) and under it (sheet height) in px — used by panInside and cluster flights. */
export interface MapInsets { top: number; bottom: number }

export interface MapViewProps {
  center?: [number, number];
  zoom?: number;
  draggablePin?: { lat: number; lng: number } | null;
  onPinMove?: (lat: number, lng: number) => void;
  /** Fixed height in px. Omit to fill the parent (which must have a height). */
  height?: number;
  ariaLabel: string;

  /* ── /street: pins, clusters, layers (spec: .claude/street-map-spec.md "pins" + "clustering") ── */
  points?: MapPoint[];
  selectedId?: string | null;
  hoverId?: string | null;
  onSelect?: (id: string) => void;
  /** A same-coordinate stack too big to fan out (more than SPIDER_MAX) tapped at zoom ≥ 17; below that, or a smaller
   *  stack still drawn as a disc, it flies in like any cluster. */
  onStackTap?: (ids: string[]) => void;
  /** A cluster was tapped; MapView has already started `flyToBounds(bounds)` with the insets as padding (maxZoom 18). */
  onClusterTap?: (bounds: Bounds) => void;
  onBackgroundTap?: () => void;
  onViewChange?: (v: MapViewChange) => void;
  /** The searched / located spot: the × pin. */
  home?: { lat: number; lng: number } | null;
  /** Dashed ember circle around `home`, in metres (the digest's coverage). */
  ring?: number | null;
  /** Neighborhood outline, rings as stored: [lng, lat][][]. */
  hood?: [number, number][][] | null;
  fit?: MapFit | null;
  insets?: MapInsets;
  /** The chrome the whole city must fit between at the furthest zoom-out (the landing's detent). Default: none. */
  cityFit?: MapInsets;
  /** Move the map for a new `selectedId` (panInside its pin, or setView 17 when it is hidden in a cluster) and again
   *  when `insets.bottom` grows while it is selected. Default true. The parent passes false while a URL restore has
   *  framed the view itself (shared c/z, point, neighborhood) so the sender's framing is kept. */
  panToSelection?: boolean;
  /** Drops the 2 px frame/radius; zoom control hidden under 720 px; attribution bottom-left, lifted by --sheet-h. Init-only. */
  frameless?: boolean;
  /** Init-only. */
  zoomControl?: boolean;
  /** false: a picture of the spot (the case page's mini-map, 2026-10-27) — no drag, zoom, keyboard or pin taps, no
   *  focus stop; the attribution links stay. Init-only. Default true. */
  interactive?: boolean;
  onReady?: (map: L.Map) => void;
  /** Also exposes window.__streetMap = map for Playwright. The parent passes it only in dev/test builds or on localhost
   *  (the test server is a production build): Street.tsx owns the decision, MapView just honours the flag. */
  testHook?: boolean;
}

/** Providence City Hall. */
const DEFAULT_CENTER: [number, number] = [41.824, -71.4128];
const DEFAULT_ZOOM = 13;

/** Basemap (2026-10-25): a self-hosted Protomaps vector extract of the Providence area, rendered by protomaps-leaflet in
 *  its "light" flavour — the clean, Zillow-like look Rob asked about, with no vendor account and no per-load cost
 *  (one 16 MB static file on Firebase Hosting, which serves byte ranges; scripts/fetch-basemap.sh builds it and writes
 *  /map/basemap.json with the versioned URL, because PMTiles readers cache ranges and the data must never change under
 *  a cached URL). The renderer is a separate chunk loaded only when a map mounts. If the manifest or the archive is
 *  missing (a dev checkout without the script run, a bad deploy), the map falls back to OpenStreetMap's raster tiles.
 *  CARTO's free raster basemaps are NOT usable: they serve an "API KEY REQUIRED" watermark tile (seen live 2026-09-29). */
const BASEMAP_MANIFEST = '/map/basemap.json';
const BASEMAP_MAX_DATA_ZOOM = 15;   // the extract's deepest zoom; vector tiles overzoom to MAX_ZOOM
const MAX_ZOOM = 19;
const VECTOR_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &middot; <a href="https://protomaps.com">Protomaps</a>';
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Speed (Rob, 2026-10-28, "lazy load in details?": /street scored 65–75 on Lighthouse mobile with the main thread
 *  blocked 0.6–1.7 s, most of it protomaps painting the first screen of tiles): the basemap draws in two passes. The
 *  first is cheap — data one zoom coarser (levelDiff 2: a quarter of the tiles to decode and lay out, the finer roads,
 *  outlines and labels left for later) on canvases at most 1× (a third of the pixels at Lighthouse's 1.75×, a ninth on
 *  an iPhone's 3×) — and the full-detail layer (the library's defaults) replaces it once the page has settled. That
 *  makes the first seconds lighter, not the whole load: the full pass is the old single pass, at full pixel ratio,
 *  painted a few seconds later on top of the coarse one, so the main thread does more in all. Local, /street, 412 px at
 *  1.75× and 4× CPU, median of 5, long tasks blocking over a fixed 20 s from navigation (both passes inside it): 2.7 s
 *  before → 3.0 s with the two passes; in the first 4 s, 2.1 → 1.8 s (2026-10-28). Lighthouse, which stops measuring
 *  once the page goes quiet and so never sees the full pass, reads 72 → 85 (blocking 690 → 230 ms, median of 3). */
const BASEMAP_COARSE = { levelDiff: 2, devicePixelRatio: Math.min(1, window.devicePixelRatio || 1) };
/** The full pass waits until the page has settled: the coarse layer has drawn the view (its first 'load') and for
 *  QUIET_MS nothing has loaded (resource timing: the feed, tiles, images) and no long task (> 50 ms) has run (Chrome's
 *  'longtask' entries; Safari and Firefox have none, so there the network alone). That is the page's own start-up over,
 *  so the full paint does not compete with it: with a fixed 2.5 s wait, a slow feed response put both in the same
 *  seconds, and those Lighthouse runs scored 63–70, below the one-pass map. (It also puts the full paint past the point
 *  where Lighthouse stops measuring, ~1 s of network and CPU quiet — hence the gap between its score and the fixed
 *  window above.) Never later than UPGRADE_MAX_MS after the coarse draw. Then the next idle moment
 *  (requestIdleCallback, at most UPGRADE_IDLE_MS; a timeout where there is none). */
const QUIET_MS = 3000;
const UPGRADE_MAX_MS = 10_000;
const UPGRADE_IDLE_MS = 2000;
/** Leaflet fades a loaded tile in over 200 ms and prunes 250 ms after 'load': the coarse layer stays under the full one
 *  until then. */
const TILE_FADE_MS = 250;
/** A full pass that could not read its tiles tries again after this long at the latest (sooner on 'online' or a moveend). */
const RETRY_MS = 15_000;

/** `data-basemap` on the map's container: which basemap is showing — a debugging aid, and the suite reads it. */
type BasemapKind = 'coarse' | 'full' | 'raster';
const markBasemap = (map: L.Map, kind: BasemapKind) => { map.getContainer().dataset.basemap = kind; };

/** Add the vector basemap (its coarse pass, then the full one — upgradeBasemap), or the raster fallback when it cannot
 *  be had. Resolves once a layer is on the map. */
async function addBasemap(map: L.Map, alive: () => boolean): Promise<'vector' | 'raster'> {
  try {
    const m = await fetch(BASEMAP_MANIFEST, { cache: 'no-cache' });
    if (!m.ok) throw new Error(`manifest ${m.status}`);
    const { url } = (await m.json()) as { url?: string };
    if (!url) throw new Error('manifest has no url');
    // The SPA rewrite answers a missing archive with index.html (200), so check the PMTiles magic, not the status.
    const head = await fetch(url, { headers: { Range: 'bytes=0-6' } });
    if (!head.ok || !(await head.text()).startsWith('PMTiles')) throw new Error('not a PMTiles archive');
    const [{ leafletLayer }, { PMTiles }] = await Promise.all([import('protomaps-leaflet'), import('pmtiles')]);
    if (!alive()) return 'vector';
    // One archive for both passes. A layer given the URL makes its own, which fetches the header and root directory
    // again — and pmtiles 3.2 keeps a failed header fetch for good, so one miss at the full pass's start (a weak signal,
    // a captive portal) painted every full-detail tile blank for the rest of the visit, over the drawn coarse ones.
    // Shared, the full pass reads only tiles. `failed` counts tile reads that failed — not aborted ones (protomaps
    // aborts the reads of a zoom the map has left).
    const archive = new PMTiles(url);
    let failed = 0;
    const getZxy = archive.getZxy.bind(archive);
    archive.getZxy = (z, x, y, signal) => getZxy(z, x, y, signal).catch((e: unknown) => {
      if ((e as { name?: string } | null)?.name !== 'AbortError') failed++;
      throw e;
    });
    // levelDiff is read by the layer's sources (SourceOptions), not declared on LeafletLayerOptions.
    const vector = (pass: Partial<typeof BASEMAP_COARSE>) => {
      const o: LeafletLayerOptions & SourceOptions = { url: archive, flavor: 'light', lang: 'en', maxDataZoom: BASEMAP_MAX_DATA_ZOOM, maxZoom: MAX_ZOOM, attribution: VECTOR_ATTRIBUTION, ...pass };
      return leafletLayer(o) as unknown as L.GridLayer;
    };
    const coarse = vector(BASEMAP_COARSE).addTo(map);
    markBasemap(map, 'coarse');
    upgradeBasemap(map, coarse, {
      full: () => vector({}),
      // The tile under the view's centre as the full pass will read it: data one zoom coarser than the display
      // (levelDiff 1, the default), never deeper than the extract.
      probe: () => {
        const z = Math.min(BASEMAP_MAX_DATA_ZOOM, Math.max(0, Math.round(map.getZoom()) - 1));
        const t = map.project(map.getCenter(), z).divideBy(256).floor();
        return archive.getZxy(z, t.x, t.y);
      },
      failures: () => failed,
    }, alive);
    return 'vector';
  } catch (e) {
    if (!alive()) return 'raster';
    console.warn('[map] vector basemap unavailable, using OSM raster:', e instanceof Error ? e.message : e);
    L.tileLayer(TILE_URL, { maxZoom: MAX_ZOOM, attribution: TILE_ATTRIBUTION }).addTo(map);
    markBasemap(map, 'raster');
    return 'raster';
  }
}

/** What upgradeBasemap needs from addBasemap: the full layer to add, a read of the view centre's tile (`probe`) and the
 *  count of failed tile reads so far. */
interface FullPass { full(): L.GridLayer; probe(): Promise<unknown>; failures(): number }

/** The full-detail pass. Never started while the map moves — each tile paint is a long task, and a pan or a pinch
 *  would stutter through them — but a move after it starts is fine. The full layer goes on top and fades its tiles in
 *  over the coarse ones (an unpainted tile is hidden, so the coarse one shows through); the coarse layer comes off once
 *  the full one has drawn the view and its fade has run: nothing ever shows blank and the view never moves. A tile
 *  read that fails is painted as bare background (protomaps), opaque over the coarse tile under it, so the pass needs
 *  the network, not just navigator.onLine (which a weak signal or a captive portal leaves true): it first reads the
 *  view centre's tile, and a full layer that had a read fail while it drew comes off again, the coarse one still
 *  under it. Either way it tries again on the next 'online', the next moveend or after RETRY_MS, whichever is first.
 *  Every step checks `alive`: an unmounted map gets no layer (map.remove() took the coarse one and its listeners). */
function upgradeBasemap(map: L.Map, coarse: L.GridLayer, pass: FullPass, alive: () => boolean) {
  let moving = false;
  const moveStart = () => { moving = true; };
  const moveEnd = () => { moving = false; };
  map.on('movestart', moveStart).on('moveend', moveEnd);
  const whenIdle = (fn: () => void) => {
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout: UPGRADE_IDLE_MS });
    else window.setTimeout(fn, 0);
  };
  const retry = () => {
    let timer = 0;
    const again = () => {
      window.clearTimeout(timer); window.removeEventListener('online', again); map.off('moveend', again);
      whenIdle(swap);
    };
    timer = window.setTimeout(again, RETRY_MS);
    window.addEventListener('online', again);
    map.on('moveend', again); // after moveEnd (registered first): the flag is clear
  };
  const swap = async () => {
    if (!alive()) return;
    if (moving) { map.once('moveend', () => whenIdle(swap)); return; } // moveEnd (registered first) has cleared the flag
    if (!navigator.onLine) { window.addEventListener('online', () => whenIdle(swap), { once: true }); return; }
    try { await pass.probe(); } catch { if (alive()) retry(); return; }
    if (!alive()) return;
    if (moving) { map.once('moveend', () => whenIdle(swap)); return; } // the map started moving while the probe read
    const failed = pass.failures();
    const full = pass.full().addTo(map);
    full.once('load', () => window.setTimeout(() => {
      if (!alive()) return;
      if (pass.failures() > failed) { full.remove(); retry(); return; }
      map.off('movestart', moveStart).off('moveend', moveEnd);
      coarse.remove();
      markBasemap(map, 'full');
    }, TILE_FADE_MS));
  };
  // The end of the page's last network response or long task (a resource entry's duration runs to its responseEnd).
  let lastBusy = performance.now();
  const busy = new PerformanceObserver((list) => { for (const e of list.getEntries()) lastBusy = Math.max(lastBusy, e.startTime + e.duration); });
  for (const type of ['resource', 'longtask']) if (PerformanceObserver.supportedEntryTypes?.includes(type)) busy.observe({ type, buffered: true });
  map.once('unload', () => busy.disconnect()); // map.remove() before the pass was due
  const settle = (deadline: number) => {
    const wait = Math.min(lastBusy + QUIET_MS, deadline) - performance.now();
    if (wait > 0 && alive()) { window.setTimeout(() => settle(deadline), wait); return; }
    busy.disconnect();
    whenIdle(swap);
  };
  coarse.once('load', () => settle(performance.now() + UPGRADE_MAX_MS));
}

const VIEW_DEBOUNCE_MS = 150;
const DRAW_PAD = 0.25;
/** Halos mark NEW cases only (open, reported in the last 48 h — Rob, 2026-10-27: pins should say more than open/closed),
 *  at any zoom a pin is drawn: at most this many, never under reduced motion. */
const HALO_MAX = 60;
const DROP_STEP_MS = 30;
const DROP_MAX_INDEX = 20;
/** A selected case hidden in a cluster → setView here; a stack too big to fan lists its cases from here; cluster
 *  flights stop here. */
const SELECT_ZOOM = 17;
const STACK_LIST_ZOOM = 17;
/** From here, while clusterGrid only stacks (no grid), a stack of up to SPIDER_MAX is drawn as its own pins fanned
 *  around the shared point on legs (Rob, 2026-10-27: "impossible to zoom in far enough to get individual pins" — a "2"
 *  disc never split). Offsets are screen px (lib/streetMap spiderOffsets), re-slotted on every zoom. */
const SPIDER_ZOOM = 17;
const CLUSTER_MAX_ZOOM = 18;
const SELECTED_Z = 1000;
/** A selected open pin stands 32 px above its anchor, ×1.2 when selected: panInside pads the top by this so the head
 *  of the pin never tucks under the rail. */
const PIN_HEAD_PX = 38;
/** panInside / centred setView only when the band between the insets is at least this tall (at FULL it is ~8 px). */
const MIN_BAND_PX = 80;

/** Keep the map on Providence (Rob, 2026-10-27): every case is in the city (live check that day: all 497 located cases
 *  within 0.003° of PVD_BOUNDS) and every search, locate and report pin is gated by inProvidence(), so there is
 *  nothing to see further out — and the self-hosted basemap stops a few km past the line (scripts/fetch-basemap.sh).
 *  Zoom out stops at the landing view: the deepest zoom at which the whole city fits the container less `cityFit`, but
 *  never more than one step below the whole-container fit (on /street's phone layout the band between the filter rows
 *  and the PEEK sheet → z11; beside the 1280×800 panel → z12; the report picker → the whole container; recomputed on
 *  resize and when `cityFit` changes). Panning stops ~1 km past the city — plus the chrome over the map: the rail's height (and a pin head) on
 *  the north and the sheet's height on the south, in pixels at the zoom being moved to, so any edge case can still be
 *  brought into the visible band above a half-raised sheet (a pin head's height is added on both sides: the north one
 *  keeps an edge pin's head clear of the rail, the south one keeps the limit's centre on the band's centre, which is
 *  where Leaflet puts a view taller than the limit). Leaflet takes maxBounds as fixed LatLngs, so the bounds
 *  are re-derived per zoom by wrapping the one helper every maxBounds check goes through (setView/fitBounds/zoom at the
 *  target zoom, inertia and keyboard pans); options.maxBounds is kept at the current zoom's value for the drag's
 *  viscosity, which reads it at dragstart. The after-the-fact correction (a fly or a pinch that ends outside) is ours,
 *  not setMaxBounds' moveend handler: that one pans with animation from inside the moveend that setView's _stop()
 *  fires, and the new pan then runs on after the setView, landing ~420 px off (seen on desktop: the default z13 view
 *  is wider than the limit, the correction started, the point fit interrupted it). Ours waits a frame and skips
 *  while anything is still animating — that animation's own moveend checks again. */
const LIMIT_BASE = L.latLngBounds(
  [PVD_BOUNDS.minLat - CITY_MARGIN_DEG, PVD_BOUNDS.minLng - CITY_MARGIN_DEG],
  [PVD_BOUNDS.maxLat + CITY_MARGIN_DEG, PVD_BOUNDS.maxLng + CITY_MARGIN_DEG],
);
const CITY_LL = L.latLngBounds([PVD_BOUNDS.minLat, PVD_BOUNDS.minLng], [PVD_BOUNDS.maxLat, PVD_BOUNDS.maxLng]);
/** A container too small to fit the city at any sane zoom (collapsed, hidden) still stops here. */
const MIN_ZOOM_FLOOR = 10;

interface CityLimit { insetsChanged(): void; resized(): void; dispose(): void }
/** Leaflet never clears _flyToFrame when a flight ends, so keepInCity clears it on every moveend (a flight in progress
 *  fires none; a stopped one had its frame cancelled before the interrupting move's moveend). */
type MapInternals = { _animatingZoom?: boolean; _panAnim?: { _inProgress?: boolean }; _flyToFrame?: number | null };

/** `run` wraps the limit's own moves like any other move MapView makes, so a forced zoom is never taken for a gesture. */
function keepInCity(map: L.Map, insets: () => MapInsets, cityFit: () => MapInsets | undefined, run: (fn: () => void) => void): CityLimit {
  const at = (zoom: number) => {
    if (!Number.isFinite(zoom)) return LIMIT_BASE; // an unmeasured map's fit (NaN zoom): never throw from the limit
    const ins = insets();
    const nw = map.project(LIMIT_BASE.getNorthWest(), zoom).subtract([0, ins.top + PIN_HEAD_PX]);
    const se = map.project(LIMIT_BASE.getSouthEast(), zoom).add([0, ins.bottom + PIN_HEAD_PX]);
    return L.latLngBounds(map.unproject(nw, zoom), map.unproject(se, zoom));
  };
  type Offset = (px: L.Bounds, bounds: L.LatLngBounds, zoom?: number) => L.Point;
  const m = map as unknown as { _getBoundsOffset: Offset };
  const base = m._getBoundsOffset;
  m._getBoundsOffset = function (this: L.Map, px, _bounds, zoom) { return base.call(this, px, at(zoom ?? this.getZoom()), zoom); };

  /** The deepest zoom at which the whole city fits the band — but never more than one step below the zoom at which it
   *  fills the whole map: on a short phone the chrome (two filter rows + the PEEK sheet) leaves a band a few pixels
   *  shorter than the city at z11, and z10 would show half of Rhode Island; one step keeps the city's edges at most a
   *  few pixels under the chrome. getBoundsZoom clamps to the current minZoom, so lift it first; a band too thin to
   *  mean anything falls back to the whole container. */
  const cityZoom = (): number | null => {
    const size = map.getSize();
    if (!size.x || !size.y) return null;
    const fit = cityFit();
    const chrome = fit ? fit.top + fit.bottom : 0;
    map.options.minZoom = 0;
    const whole = map.getBoundsZoom(CITY_LL, false);
    const band = map.getBoundsZoom(CITY_LL, false, L.point(0, size.y - chrome >= MIN_BAND_PX ? chrome : 0));
    return Math.max(MIN_ZOOM_FLOOR, band, whole - 1);
  };
  const refresh = () => { map.options.maxBounds = at(map.getZoom()); };
  let frame = 0;
  const enforce = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const m = map as unknown as MapInternals;
      if (m._animatingZoom || m._panAnim?._inProgress || m._flyToFrame) return;
      refresh();
      const c = map.getCenter();
      const lim = (map as unknown as { _limitCenter(c: L.LatLng, z: number, b: L.LatLngBounds): L.LatLng })._limitCenter(c, map.getZoom(), map.options.maxBounds as L.LatLngBounds);
      if (!c.equals(lim)) run(() => map.panTo(lim));
    });
  };
  const resized = () => {
    const z = cityZoom();
    if (z != null) {
      if (map.getZoom() < z) run(() => map.setMinZoom(z));
      else map.setMinZoom(z);
    }
    refresh();
    enforce();
  };
  /** The chrome moved (the sheet changed detent): a lowered sheet tightens the limit, so bring the view back inside now
   *  rather than on the first frame of the next drag (the drag's viscosity would snap it there). */
  const insetsChanged = () => { refresh(); enforce(); };

  // First view: clamp without animating (setMinZoom would zoom there), then hold it inside the limit.
  const z0 = cityZoom();
  if (z0 != null) {
    map.options.minZoom = z0;
    if (map.getZoom() < z0) map.setView(map.getCenter(), z0, { animate: false });
  }
  refresh();
  map.panInsideBounds(map.options.maxBounds!, { animate: false });
  const flightOver = () => { (map as unknown as MapInternals)._flyToFrame = null; };
  map.on('zoomend', refresh);
  map.on('moveend', flightOver);
  map.on('moveend', enforce);
  map.on('resize', resized);
  return {
    insetsChanged, resized,
    dispose: () => { cancelAnimationFrame(frame); map.off('zoomend', refresh); map.off('moveend', flightOver); map.off('moveend', enforce); map.off('resize', resized); },
  };
}

const divIcon = (m: MarkerParts, className = m.className): L.DivIcon =>
  L.divIcon({ className, html: m.html, iconSize: m.size, iconAnchor: m.anchor, popupAnchor: [0, -m.anchor[1] + 2] });

/** The report screen's draggable pin (and /street's `.map-home`): the × pin, markup in lib/mapMarkers. */
function markerIcon(className = 'map-pin'): L.DivIcon {
  return divIcon(homeMarker(), className);
}

/** Case pins: one cached divIcon per (group, open, new) — never one per case (ten groups × three looks = 30 at most). */
const caseIcons = new Map<string, L.DivIcon>();
function caseIcon(group: string | undefined, open: boolean, isNew: boolean | undefined): L.DivIcon {
  const key = casePinKey(group ?? 'other', open, !!isNew);
  let icon = caseIcons.get(key);
  if (!icon) { icon = divIcon(caseMarker(group ?? 'other', open, !!isNew)); caseIcons.set(key, icon); }
  return icon;
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const toBounds = (b: L.LatLngBounds): Bounds => ({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });

const hideFromAt = (el: HTMLElement | undefined) => {
  if (!el) return;
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('tabindex', '-1');
};

type Keyed = { layer: L.Marker | L.Path; sig: string; cluster?: Cluster; icon?: string; hood?: unknown };
/** A stack drawn fanned out: its shared point and its members in slot order (spiderOffsets' order). */
interface Fan { lat: number; lng: number; ids: string[] }

/** Everything that outlives a render: the layer group, the keyed markers, gesture tracking and the debounced redraw.
 *  Created once per map in the init effect; reads the latest props through `propsRef`. */
function createController(map: L.Map, propsRef: { current: MapViewProps }) {
  const group = L.layerGroup().addTo(map);
  const entries = new Map<string, Keyed>();
  let byId = new Map<string, MapPoint>();
  /** Where each case drawn as its own pin sits — its coordinate, or its slot in a fan. The selection pans read this. */
  let drawnAt = new Map<string, L.LatLng>();
  /** The fans drawn now, by cluster key: refan() re-slots them for a new zoom ahead of the debounced redraw. */
  let fans = new Map<string, Fan>();
  /** A selection whose pin was not drawn when it was made (in a disc, or before the feed came): once it is drawn in a
   *  fan, that pin — not the shared point the move centred — is brought into the band. A user move cancels it. */
  let revealFan: string | null = null;
  let hysteresis: { zoom: number; clustered: boolean } | null = null;
  const reduced = prefersReducedMotion();

  // Gesture tracking: a drag is always the user's; a zoomstart is, unless a programmatic move is in flight.
  let gesture = false; // since the last reported view change
  let lastViewByUser = false; // the last view change was the user's → pins created now drop in
  let programmatic = false;
  let moved = false;
  let programmaticTimer = 0;
  let viewTimer = 0;
  let fitCount = 0;

  /** Wrap any move MapView makes itself. An animated zoom fires its start events on the next frame and a no-op fires
   *  none, so the flag is released after a beat when nothing moved (moveend releases it otherwise). */
  const run = (fn: () => void) => {
    programmatic = true; moved = false;
    window.clearTimeout(programmaticTimer);
    fn();
    programmaticTimer = window.setTimeout(() => { if (!moved) programmatic = false; }, 80);
  };

  const insets = () => propsRef.current.insets ?? { top: 0, bottom: 0 };

  /** The centre that puts `p` in the middle of the band between the insets at `zoom`. */
  const centerFor = (p: { lat: number; lng: number }, zoom: number): L.LatLng => {
    const size = map.getSize(); const ins = insets();
    const dy = (ins.top + (size.y - ins.bottom)) / 2 - size.y / 2;
    return map.unproject(map.project([p.lat, p.lng], zoom).subtract([0, dy]), zoom);
  };

  function applyPinState(e: Keyed, id: string, halo: boolean) {
    const m = e.layer as L.Marker; const el = m.getElement();
    const selected = id === (propsRef.current.selectedId ?? null);
    if (el) {
      el.classList.toggle('map-pin--selected', selected);
      el.classList.toggle('map-pin--hover', id === (propsRef.current.hoverId ?? null));
      el.classList.toggle('map-pin--halo', halo);
    }
    m.setZIndexOffset(selected ? SELECTED_Z : 0);
  }

  function applyClusterState(e: Keyed) {
    const sel = propsRef.current.selectedId ?? null;
    (e.layer as L.Marker).getElement()?.classList.toggle('map-cluster--selected', !!sel && !!e.cluster?.ids.includes(sel));
  }

  const drop = (el: HTMLElement | undefined, i: number) => {
    if (!el || !lastViewByUser || reduced) return;
    el.style.setProperty('--drop-delay', `${Math.min(i, DROP_MAX_INDEX) * DROP_STEP_MS}ms`);
    el.classList.add('map-pin--drop');
  };

  /** `data-id` on the marker element (not in the shared icon) so a test or a debugger can find a case's pin. */
  const tagPin = (el: HTMLElement | undefined, id: string) => { hideFromAt(el); if (el) el.dataset.id = id; };

  /** A case pin at `at`: its own coordinate, or its slot in a fan — the same pin, tap and states either way. */
  function makePin(p: MapPoint, i: number, at: L.LatLng): Keyed {
    const m = L.marker(at, { icon: caseIcon(p.group, p.open, p.isNew), keyboard: false, interactive: propsRef.current.interactive !== false });
    m.on('click', () => propsRef.current.onSelect?.(p.id));
    group.addLayer(m);
    tagPin(m.getElement(), p.id);
    drop(m.getElement(), i);
    return { layer: m, sig: `${at.lat},${at.lng}`, icon: casePinKey(p.group ?? 'other', p.open, !!p.isNew) };
  }

  /** A fan's pin anchors at `zoom`: the shared point plus spiderOffsets in screen px, back to LatLngs. */
  const fanSpots = (f: Fan, zoom: number): L.LatLng[] => {
    const o = map.project([f.lat, f.lng], zoom);
    return spiderOffsets(f.ids.length).map((d) => map.unproject(o.add([d.x, d.y]), zoom));
  };

  /** Where `p` will be drawn at `zoom` if its stack fans out there; null for a lone case or a stack too big to fan.
   *  The members are the points at its 5-dp spot in the points' order — the order clusterGrid lists them in. */
  const fanSpotOf = (p: MapPoint, zoom: number): L.LatLng | null => {
    if (zoom < SPIDER_ZOOM) return null;
    const k = stackKey(p.lat, p.lng);
    const members = [...byId.values()].filter((q) => stackKey(q.lat, q.lng) === k);
    if (members.length < 2 || members.length > SPIDER_MAX) return null;
    return fanSpots({ lat: members[0].lat, lng: members[0].lng, ids: members.map((q) => q.id) }, zoom)[members.indexOf(p)] ?? null;
  };

  /** Re-slot the drawn fans for `zoom`: on zoomanim (`pinsOnly`, the target zoom — the pins animate to slots that keep
   *  their pixel spacing) and on zoomend (the legs too, and a zoom without animation). The debounced redraw then settles
   *  who is in which fan. Not the legs on zoomanim: the map's zoom changes only after it (after a pinch it is fractional,
   *  the SVG frame still the pre-pinch one), so a leg set then is drawn in the old frame, which the transition scales —
   *  overshooting its pin or falling short until zoomend. Legs and dot sit the transition out (MapView.css). */
  function refan(zoom: number, pinsOnly = false) {
    for (const f of fans.values()) {
      const spots = fanSpots(f, zoom);
      f.ids.forEach((id, i) => {
        const at = spots[i], sig = `${at.lat},${at.lng}`;
        const pin = entries.get(`c:${id}`), leg = pinsOnly ? undefined : entries.get(`l:${id}`);
        if (pin && pin.sig !== sig) { (pin.layer as L.Marker).setLatLng(at); pin.sig = sig; }
        if (leg && leg.sig !== sig) { (leg.layer as L.Polyline).setLatLngs([[f.lat, f.lng], at]); leg.sig = sig; }
        if (drawnAt.has(id)) drawnAt.set(id, at);
      });
    }
  }

  const animating = () => {
    const m = map as unknown as MapInternals;
    return !!(m._animatingZoom || m._panAnim?._inProgress || m._flyToFrame);
  };

  function onClusterClick(key: string) {
    const c = entries.get(key)?.cluster; if (!c) return;
    // Only a stack too big to fan lists; a smaller one still a disc here (z17 while the grid runs) flies in to 18 and fans.
    if (c.stack && map.getZoom() >= STACK_LIST_ZOOM && c.n > SPIDER_MAX) { propsRef.current.onStackTap?.(c.ids); return; }
    const pts = c.ids.map((id) => byId.get(id)).filter((p): p is MapPoint => !!p).map((p) => L.latLng(p.lat, p.lng));
    const b = pts.length ? L.latLngBounds(pts) : L.latLngBounds([[c.lat, c.lng], [c.lat, c.lng]]);
    const ins = insets();
    gesture = true; // the user tapped the map: the view is theirs and the revealed pins drop in
    run(() => map.flyToBounds(b, { paddingTopLeft: [16, ins.top + 16], paddingBottomRight: [16, ins.bottom + 16], maxZoom: CLUSTER_MAX_ZOOM, animate: !reduced }));
    propsRef.current.onClusterTap?.(toBounds(b));
  }

  function makeCluster(key: string, c: Cluster, i: number): Keyed {
    const icon = divIcon(clusterMarker(c.n, c.open / c.n));
    const m = L.marker([c.lat, c.lng], { icon, keyboard: false, interactive: true });
    m.on('click', () => onClusterClick(key));
    group.addLayer(m);
    hideFromAt(m.getElement());
    drop(m.getElement(), i);
    return { layer: m, sig: clusterSig(c), cluster: c };
  }
  const clusterSig = (c: Cluster) => `${c.n}|${Math.round((c.open / c.n) * 360)}|${c.lat},${c.lng}`;

  function updateCluster(e: Keyed, c: Cluster) {
    const m = e.layer as L.Marker;
    if (e.sig !== clusterSig(c)) {
      if (e.cluster && (e.cluster.lat !== c.lat || e.cluster.lng !== c.lng)) m.setLatLng([c.lat, c.lng]);
      const el = m.getElement();
      if (el) {
        el.innerHTML = clusterHtml(c.n, c.open / c.n);
        for (const s of ['s', 'm', 'l'] as const) el.classList.toggle(`map-cluster--${s}`, clusterSize(c.n) === s);
      }
      e.sig = clusterSig(c);
    }
    e.cluster = c;
  }

  /** Diff the wanted key set against the drawn one: unchanged keys keep their DOM node (class/zIndex updates only),
   *  removed keys go, new keys are created. Called on the debounced view change and on every prop change. */
  function redraw() {
    const props = propsRef.current;
    const want = new Set<string>();
    const size = map.getSize();
    let created = 0;

    // Case pins + clusters. A case pin is keyed by its case (`c:`) wherever it is drawn — its own coordinate or its slot
    // in a fan — so a stack fanning out or folding back, or a pan, reuses or drops exactly the right nodes; a fan adds
    // a leg per member (`l:`) and the centre dot (`d:`), which go with it.
    const pts = props.points;
    byId = new Map();
    const nextDrawn = new Map<string, L.LatLng>();
    const nextFans = new Map<string, Fan>();
    if (pts && pts.length && size.x > 0 && size.y > 0) {
      const zoom = map.getZoom();
      const draw = map.getBounds().pad(DRAW_PAD);
      const inView: ClusterPoint[] = [];
      for (const p of pts) { byId.set(p.id, p); if (draw.contains([p.lat, p.lng])) inView.push(p); }
      const forcePins = hysteresis != null && hysteresis.zoom === zoom && !hysteresis.clustered;
      const res = clusterGrid(inView, (lat, lng) => map.project([lat, lng], zoom), zoom, { forcePins });
      hysteresis = { zoom, clustered: res.clustered };
      const fanning = zoom >= SPIDER_ZOOM && !res.clustered;

      let halos = 0;
      const pinAt = (p: MapPoint, at: L.LatLng) => {
        const key = `c:${p.id}`; want.add(key); nextDrawn.set(p.id, at);
        const halo = !reduced && p.open && !!p.isNew && halos < HALO_MAX; if (halo) halos++;
        let e = entries.get(key);
        if (!e) { e = makePin(p, created++, at); entries.set(key, e); }
        else {
          const m = e.layer as L.Marker;
          const icon = casePinKey(p.group ?? 'other', p.open, !!p.isNew);
          if (e.icon !== icon) { m.setIcon(caseIcon(p.group, p.open, p.isNew)); e.icon = icon; tagPin(m.getElement(), p.id); }
          const sig = `${at.lat},${at.lng}`; if (e.sig !== sig) { m.setLatLng(at); e.sig = sig; }
        }
        applyPinState(e, p.id, halo);
      };
      /** A stack fanned out: per member a leg from the shared point and its pin at its slot, then the centre dot. */
      const fanOut = (c: Cluster) => {
        const f: Fan = { lat: c.lat, lng: c.lng, ids: c.ids };
        nextFans.set(c.key, f);
        const spots = fanSpots(f, zoom);
        let newLeg = false;
        c.ids.forEach((id, i) => {
          const p = byId.get(id); if (!p) return;
          const at = spots[i], sig = `${at.lat},${at.lng}`, key = `l:${id}`;
          want.add(key);
          const e = entries.get(key);
          if (!e) {
            const leg = L.polyline([[c.lat, c.lng], at], { className: LEG_CLASS, interactive: false });
            group.addLayer(leg); entries.set(key, { layer: leg, sig }); newLeg = true;
          } else if (e.sig !== sig) { (e.layer as L.Polyline).setLatLngs([[c.lat, c.lng], at]); e.sig = sig; }
          pinAt(p, at);
        });
        const key = `d:${c.key}`, sig = `${c.lat},${c.lng}`; want.add(key);
        const e = entries.get(key);
        if (!e) {
          const dot = L.circleMarker([c.lat, c.lng], { radius: SPOT_R, className: SPOT_CLASS, interactive: false });
          group.addLayer(dot); entries.set(key, { layer: dot, sig });
        } else {
          if (e.sig !== sig) { (e.layer as L.CircleMarker).setLatLng([c.lat, c.lng]); e.sig = sig; }
          if (newLeg) (e.layer as L.CircleMarker).bringToFront(); // the dot stays over the legs' ends
        }
      };

      for (const id of res.singles) { const p = byId.get(id); if (p) pinAt(p, L.latLng(p.lat, p.lng)); }
      for (const c of res.clusters) {
        if (fanning && c.stack && c.n <= SPIDER_MAX) { fanOut(c); continue; }
        const key = `k:${c.key}`; want.add(key);
        let e = entries.get(key);
        if (!e) { e = makeCluster(key, c, created++); entries.set(key, e); } else updateCluster(e, c);
        applyClusterState(e);
      }
    } else if (pts) for (const p of pts) byId.set(p.id, p);
    drawnAt = nextDrawn;
    fans = nextFans;

    // Home pin + ring
    const home = props.home;
    if (home) {
      want.add('home');
      const sig = `${home.lat},${home.lng}`;
      const e = entries.get('home');
      if (!e) {
        // Pointer-transparent: a tap on your own spot is a tap on the map (deselect), never a swallowed click.
        const m = L.marker([home.lat, home.lng], { icon: markerIcon('map-pin map-home'), keyboard: false, interactive: false, zIndexOffset: SELECTED_Z + 1 });
        group.addLayer(m); hideFromAt(m.getElement());
        entries.set('home', { layer: m, sig });
      } else if (e.sig !== sig) { (e.layer as L.Marker).setLatLng([home.lat, home.lng]); e.sig = sig; }

      const r = props.ring;
      if (r && r > 0) {
        want.add('ring');
        const rsig = `${sig}|${r}`;
        const re = entries.get('ring');
        if (!re) {
          const circle = L.circle([home.lat, home.lng], { radius: r, className: 'map-ring', interactive: false });
          group.addLayer(circle);
          entries.set('ring', { layer: circle, sig: rsig });
        } else if (re.sig !== rsig) { (re.layer as L.Circle).setLatLng([home.lat, home.lng]).setRadius(r); re.sig = rsig; }
      }
    }

    // Neighborhood outline (recreated only when the rings array identity changes)
    const hood = props.hood;
    if (hood && hood.length) {
      want.add('hood');
      const e = entries.get('hood');
      if (!e || e.hood !== hood) {
        if (e) group.removeLayer(e.layer);
        const latlngs = hood.map((ring) => ring.map(([lng, lat]) => [lat, lng] as [number, number]));
        const poly = L.polygon(latlngs, { className: 'map-hood', interactive: false });
        group.addLayer(poly);
        entries.set('hood', { layer: poly, sig: 'hood', hood });
      }
    }

    for (const [key, e] of entries) if (!want.has(key)) { group.removeLayer(e.layer); entries.delete(key); }

    // A selection made while its pin was hidden: drawn on its own coordinate, the move that revealed it centred it
    // already; drawn in a fan, bring that pin — not the shared point — into the band if the move left it outside
    // (once, never mid-flight; a move to its predicted slot needs no second one).
    if (revealFan && drawnAt.has(revealFan) && !animating()) {
      const id = revealFan; revealFan = null;
      if (id === (props.selectedId ?? null) && entries.has(`l:${id}`) && !showsInBand(drawnAt.get(id)!)) bringSelectedIntoBand();
    }
  }

  /** A pin anchored at `at` shows whole in the band between the insets: its head below the top inset, its tip above the
   *  bottom one, inside the map's width. */
  function showsInBand(at: L.LatLng): boolean {
    const p = map.latLngToContainerPoint(at), size = map.getSize(), ins = insets();
    return p.y - PIN_HEAD_PX >= ins.top && p.y <= size.y - ins.bottom && p.x >= 0 && p.x <= size.x;
  }

  function scheduleView() {
    window.clearTimeout(viewTimer);
    viewTimer = window.setTimeout(() => {
      const user = gesture; gesture = false; lastViewByUser = user;
      redraw();
      const b = map.getBounds(), c = map.getCenter();
      propsRef.current.onViewChange?.({ bounds: toBounds(b), center: { lat: c.lat, lng: c.lng }, zoom: map.getZoom(), userGesture: user });
    }, VIEW_DEBOUNCE_MS);
  }

  /** Selection changed: classes + zIndex everywhere, then bring the case into the band — panInside when its pin is
   *  drawn, setView(…, 17) centred in the band when it is hidden in a cluster (or off the drawn scope). */
  function selectionChanged() {
    revealFan = propsRef.current.selectedId ?? null;
    for (const [key, e] of entries) {
      if (key.startsWith('c:')) applyPinState(e, key.slice(2), (e.layer as L.Marker).getElement()?.classList.contains('map-pin--halo') ?? false);
      else if (key.startsWith('k:')) applyClusterState(e);
    }
    bringSelectedIntoBand();
  }

  /** Pan the selected pin into the band between the insets (also re-run when the sheet rises under a selection) — the
   *  pin where it is drawn: its coordinate, or its slot in a fan. Hidden in a disc → setView 17 centred on where it
   *  will be drawn there (its fan slot when its stack will fan out; redraw corrects with revealFan if not). */
  function bringSelectedIntoBand() {
    if (propsRef.current.panToSelection === false) { revealFan = null; return; }
    const sel = propsRef.current.selectedId; if (!sel) return;
    const p = byId.get(sel); if (!p) return;
    const ins = insets();
    if (map.getSize().y - ins.top - ins.bottom < MIN_BAND_PX) return; // FULL: the list is the view, the map is a sliver
    const at = drawnAt.get(sel);
    if (at) { revealFan = null; run(() => map.panInside(at, { paddingTopLeft: [0, ins.top + 16 + PIN_HEAD_PX], paddingBottomRight: [0, ins.bottom + 16], animate: !reduced })); }
    else run(() => map.setView(centerFor(fanSpotOf(p, SELECT_ZOOM) ?? p, SELECT_ZOOM), SELECT_ZOOM, { animate: !reduced }));
  }

  function hoverChanged() {
    const hover = propsRef.current.hoverId ?? null;
    for (const [key, e] of entries) if (key.startsWith('c:')) (e.layer as L.Marker).getElement()?.classList.toggle('map-pin--hover', key.slice(2) === hover);
  }

  /** Leaflet's setView silently drops a view change while a zoom animation is still running (map._animatingZoom):
   *  a fit requested right after a pinch or a "Zoom out" tap would vanish. Wait for that zoomend, then move. */
  const whenZoomIdle = (fn: () => void) => {
    if ((map as unknown as { _animatingZoom?: boolean })._animatingZoom) map.once('zoomend', () => { window.setTimeout(fn, 0); });
    else fn();
  };

  /** A fit needs a measured container: at zero height (the first paint, before the page shell lays out) Leaflet's
   *  getBoundsZoom returns NaN. Re-measure once; still empty → hold the fit until the map reports a size ('resize'). */
  let pendingFit: MapFit | null = null;
  const hasSize = () => {
    let s = map.getSize();
    if (!s.x || !s.y) { map.invalidateSize({ pan: false }); s = map.getSize(); }
    return !!(s.x && s.y);
  };
  map.on('resize', () => { if (pendingFit && hasSize()) { const f = pendingFit; pendingFit = null; fit(f); } });

  function fit(f: MapFit) {
    if (!hasSize()) { pendingFit = f; return; }
    pendingFit = null;
    const first = fitCount++ === 0;
    whenZoomIdle(() => run(() => map.fitBounds(f.bounds, { paddingTopLeft: [0, f.paddingTop], paddingBottomRight: [0, f.paddingBottom], maxZoom: f.maxZoom, animate: !first && !reduced })));
  }

  function setView(center: L.LatLngExpression, zoom: number) {
    whenZoomIdle(() => run(() => map.setView(center, zoom, { animate: !reduced })));
  }

  map.on('movestart', () => { moved = true; });
  map.on('dragstart', () => { gesture = true; revealFan = null; });
  map.on('zoomstart', () => { if (!programmatic) { gesture = true; revealFan = null; } });
  // Registered before any marker exists, so it runs ahead of the markers' own zoomanim handlers.
  map.on('zoomanim', (e: L.ZoomAnimEvent) => refan(e.zoom, true));
  map.on('zoomend', () => refan(map.getZoom()));
  map.on('moveend', () => { programmatic = false; });
  map.on('moveend zoomend resize', scheduleView);
  map.on('click', () => propsRef.current.onBackgroundTap?.());

  function dispose() {
    window.clearTimeout(viewTimer); window.clearTimeout(programmaticTimer);
    group.clearLayers(); entries.clear(); fans.clear(); drawnAt.clear();
  }

  return { redraw, scheduleView, selectionChanged, bringSelectedIntoBand, hoverChanged, fit, setView, run, dispose };
}
type Controller = ReturnType<typeof createController>;

export default function MapView(props: MapViewProps) {
  const {
    center, zoom, draggablePin = null, height, ariaLabel, frameless = false, zoomControl = true, interactive = true,
    points, selectedId = null, hoverId = null, home = null, ring = null, hood = null, fit = null, insets, cityFit,
  } = props;
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const ctlRef = useRef<Controller | null>(null);
  const pinRef = useRef<L.Marker | null>(null);
  const limitRef = useRef<CityLimit | null>(null);

  // Keep the latest props in a ref so the init effect stays mount-only and map handlers never go stale.
  const propsRef = useRef(props);
  propsRef.current = props;

  // Init map once.
  useEffect(() => {
    const el = elRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: center ?? DEFAULT_CENTER,
      zoom: zoom ?? DEFAULT_ZOOM,
      zoomControl: zoomControl && interactive,
      attributionControl: false,
      keyboard: interactive,
      maxBoundsViscosity: 1,
      ...(interactive ? {} : { dragging: false, touchZoom: false, scrollWheelZoom: false, doubleClickZoom: false, boxZoom: false }),
    });
    const limit = keepInCity(map, () => propsRef.current.insets ?? { top: 0, bottom: 0 }, () => propsRef.current.cityFit,
      (fn) => { if (ctlRef.current) ctlRef.current.run(fn); else fn(); });
    limitRef.current = limit;
    L.control.attribution({ position: frameless ? 'bottomleft' : 'bottomright' }).addTo(map);
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', ariaLabel);

    let alive = true;
    void addBasemap(map, () => alive);

    const ctl = createController(map, propsRef);
    ctlRef.current = ctl;
    mapRef.current = map;
    // Leaflet can mis-measure if the container animates in; correct on next frame, then report the first view.
    const t = window.setTimeout(() => { map.invalidateSize(); limit.resized(); ctl.scheduleView(); }, 0);

    const w = window as unknown as { __streetMap?: L.Map };
    if (propsRef.current.testHook) w.__streetMap = map;
    propsRef.current.onReady?.(map);

    return () => {
      alive = false;
      window.clearTimeout(t);
      limit.dispose();
      ctl.dispose();
      map.remove();
      if (w.__streetMap === map) delete w.__streetMap;
      mapRef.current = null;
      ctlRef.current = null;
      limitRef.current = null;
      pinRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the aria-label in sync if it changes.
  useEffect(() => {
    elRef.current?.setAttribute('aria-label', ariaLabel);
  }, [ariaLabel]);

  // Draggable pin (used by the report screen).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!draggablePin) {
      if (pinRef.current) { pinRef.current.remove(); pinRef.current = null; }
      return;
    }
    const pos: L.LatLngExpression = [draggablePin.lat, draggablePin.lng];
    if (!pinRef.current) {
      // The address field is the accessible input for the location; the pin is a
      // pointer-only convenience, so keep it out of the tab order and the a11y tree.
      const pin = L.marker(pos, { icon: markerIcon(), draggable: true, keyboard: false, alt: 'Report location' });
      pin.on('dragend', () => { const ll = pin.getLatLng(); propsRef.current.onPinMove?.(ll.lat, ll.lng); });
      pin.addTo(map);
      hideFromAt(pin.getElement());
      pinRef.current = pin;
    } else {
      pinRef.current.setLatLng(pos);
    }
  }, [draggablePin]);

  // Follow controlled center/zoom changes (report screen re-centering on the pin).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) return;
    ctlRef.current?.setView(center, zoom ?? map.getZoom());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.[0], center?.[1], zoom]);

  // Programmatic fit (city, neighborhood, point, case) — once per key.
  useEffect(() => {
    if (fit) ctlRef.current?.fit(fit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fit?.key]);

  // Pins, clusters, home, ring, hood: one keyed diff.
  useEffect(() => {
    ctlRef.current?.redraw();
  }, [points, home?.lat, home?.lng, ring, hood]);

  useEffect(() => {
    ctlRef.current?.selectionChanged();
  }, [selectedId]);

  // The band moved: re-derive the pan limit for the new chrome (enforced a frame later, and not while a fit animates).
  useEffect(() => {
    limitRef.current?.insetsChanged();
  }, [insets?.top, insets?.bottom]);

  // The landing band changed (the PEEK sheet was measured): re-derive the zoom-out floor.
  useEffect(() => {
    limitRef.current?.resized();
  }, [cityFit?.top, cityFit?.bottom]);

  // The sheet rose (or the rail changed) under a selected pin: pan it back into the visible band.
  const insetBottom = insets?.bottom ?? 0;
  const prevInsetBottom = useRef(insetBottom);
  useEffect(() => {
    const grew = insetBottom > prevInsetBottom.current;
    prevInsetBottom.current = insetBottom;
    if (grew && selectedId) ctlRef.current?.bringSelectedIntoBand();
  }, [insetBottom, selectedId]);

  useEffect(() => {
    ctlRef.current?.hoverChanged();
  }, [hoverId]);

  return <div ref={elRef} className={`mapview map-pins${frameless ? ' is-frameless' : ''}${interactive ? '' : ' is-static'}`} style={height ? { height: `${height}px` } : undefined} />;
}
