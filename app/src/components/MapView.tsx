import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MapView.css';
import { clusterGrid, type Bounds, type Cluster, type ClusterPoint } from '../lib/streetMap';

/** A located city case to draw. Pass the whole filtered set: MapView keeps the ones inside `getBounds().pad(0.25)`. */
export interface MapPoint { id: string; lat: number; lng: number; open: boolean }
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
  /** A same-coordinate stack tapped at zoom ≥ 17 (below that it flies in like any cluster). */
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
  /** Move the map for a new `selectedId` (panInside its pin, or setView 17 when it is hidden in a cluster) and again
   *  when `insets.bottom` grows while it is selected. Default true. The parent passes false while a URL restore has
   *  framed the view itself (shared c/z, point, neighborhood) so the sender's framing is kept. */
  panToSelection?: boolean;
  /** Drops the 2 px frame/radius; zoom control hidden under 720 px; attribution bottom-left, lifted by --sheet-h. Init-only. */
  frameless?: boolean;
  /** Init-only. */
  zoomControl?: boolean;
  onReady?: (map: L.Map) => void;
  /** Also exposes window.__streetMap = map for Playwright. The parent passes it only in dev/test builds or on localhost
   *  (the test server is a production build): Street.tsx owns the decision, MapView just honours the flag. */
  testHook?: boolean;
}

/** Providence City Hall. */
const DEFAULT_CENTER: [number, number] = [41.824, -71.4128];
const DEFAULT_ZOOM = 13;

/** Basemap: OpenStreetMap's standard tiles. CARTO's free raster basemaps started serving an "API KEY REQUIRED"
 *  watermark tile instead of map imagery (seen live 2026-09-29 on the report screen's location picker at z17), so
 *  we no longer use them. OSM's tile policy is fine for our volume; keep the attribution and never bulk-download. */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const VIEW_DEBOUNCE_MS = 150;
const DRAW_PAD = 0.25;
/** Halos: only from this zoom, only this many open pins, never under reduced motion (nothing loops at city scale). */
const HALO_ZOOM = 16;
const HALO_MAX = 60;
const DROP_STEP_MS = 30;
const DROP_MAX_INDEX = 20;
/** A selected case hidden in a cluster → setView here; a stack lists its cases from here; cluster flights stop here. */
const SELECT_ZOOM = 17;
const STACK_LIST_ZOOM = 17;
const CLUSTER_MAX_ZOOM = 18;
const SELECTED_Z = 1000;
/** A selected open pin stands 32 px above its anchor, ×1.2 when selected: panInside pads the top by this so the head
 *  of the pin never tucks under the rail. */
const PIN_HEAD_PX = 38;
/** panInside / centred setView only when the band between the insets is at least this tall (at FULL it is ~8 px). */
const MIN_BAND_PX = 80;

const fill = (color: string) => (color.startsWith('--') ? `var(${color})` : color);

const PIN_PATH = 'M12 1C6.9 1 3 5.1 3 10.2c0 6.6 7.4 17.4 8.3 18.6a.9.9 0 0 0 1.4 0C13.6 27.6 21 16.8 21 10.2 21 5.1 17.1 1 12 1z';

/** Two-ink pin: colored plate off-register behind an ink pin with the × mark (matches BrandMark), with a slow halo.
 *  Used by the report screen's picker and, as `.map-home`, for "the spot you picked" on /street. */
function pinHtml(color: string): string {
  return (
    `<span class="map-pin-halo" style="--halo:${fill(color)}"></span>` +
    `<svg width="32" height="40" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<circle cx="15" cy="12.6" r="7.4" style="fill:${fill(color)}"/>` +
    `<path d="${PIN_PATH}" style="fill:var(--ink);stroke:var(--bg);stroke-width:1.4"/>` +
    `<path d="M9.4 7.6l5.2 5.2M14.6 7.6l-5.2 5.2" style="stroke:var(--bg);stroke-width:2.2;stroke-linecap:round"/>` +
    `</svg>`
  );
}

function markerIcon(color: string, className = 'map-pin'): L.DivIcon {
  return L.divIcon({
    className,
    html: pinHtml(color),
    iconSize: [32, 40],
    iconAnchor: [16, 38],
    popupAnchor: [0, -36],
  });
}

/** A city case: a plain two-ink teardrop, no ×, no plate. Open = ember fill 26×32 with a halo span (shown only while
 *  the marker carries `.map-pin--halo`); closed = muted fill 22×27 at .85 opacity, no halo. A --bg outline behind the
 *  1.4 ink stroke keeps it legible on OSM's pale tiles. Category is not encoded on the pin (chips, rows and the card do). */
function casePinHtml(open: boolean): string {
  const [w, h] = open ? [26, 32] : [22, 27];
  const c = open ? 'var(--ember)' : 'var(--muted)';
  return (
    (open ? `<span class="map-pin-halo" style="--halo:var(--ember)"></span>` : '') +
    `<svg width="${w}" height="${h}" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path d="${PIN_PATH}" style="fill:none;stroke:var(--bg);stroke-width:3.4"/>` +
    `<path d="${PIN_PATH}" style="fill:${c};stroke:var(--ink);stroke-width:1.4"/>` +
    `</svg>`
  );
}

const CASE_ICON_OPEN = L.divIcon({ className: 'map-pin map-case', html: casePinHtml(true), iconSize: [26, 32], iconAnchor: [13, 31] });
const CASE_ICON_CLOSED = L.divIcon({ className: 'map-pin map-case map-pin--closed', html: casePinHtml(false), iconSize: [22, 27], iconAnchor: [11, 26] });
const caseIcon = (open: boolean) => (open ? CASE_ICON_OPEN : CASE_ICON_CLOSED);

/** Cluster disc: the count in Bricolage ink on surface inside a 2 px ink border, wrapped in a 5 px conic ring —
 *  ember for the open share, muted for the rest (the only place colour encodes status at city scale; the count is the
 *  accessible fact, in the list). The disc is 36 / 44 / 52 px via `.map-cluster--s|m|l`; the marker box is a fixed 52. */
function clusterHtml(n: number, openShare: number): string {
  const deg = Math.round(Math.min(1, Math.max(0, openShare)) * 360);
  return `<span class="map-cluster-ring" style="--share:${deg}deg"><span class="map-cluster-disc">${n}</span></span>`;
}
const clusterSize = (n: number): 's' | 'm' | 'l' => (n < 10 ? 's' : n < 100 ? 'm' : 'l');
const CLUSTER_BOX = 52;

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const toBounds = (b: L.LatLngBounds): Bounds => ({ south: b.getSouth(), west: b.getWest(), north: b.getNorth(), east: b.getEast() });

const hideFromAt = (el: HTMLElement | undefined) => {
  if (!el) return;
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('tabindex', '-1');
};

type Keyed = { layer: L.Marker | L.Circle | L.Polygon; sig: string; cluster?: Cluster; open?: boolean; hood?: unknown };

/** Everything that outlives a render: the layer group, the keyed markers, gesture tracking and the debounced redraw.
 *  Created once per map in the init effect; reads the latest props through `propsRef`. */
function createController(map: L.Map, propsRef: { current: MapViewProps }) {
  const group = L.layerGroup().addTo(map);
  const entries = new Map<string, Keyed>();
  let byId = new Map<string, MapPoint>();
  let singles = new Set<string>();
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

  function makePin(p: MapPoint, i: number): Keyed {
    const m = L.marker([p.lat, p.lng], { icon: caseIcon(p.open), keyboard: false, interactive: true });
    m.on('click', () => propsRef.current.onSelect?.(p.id));
    group.addLayer(m);
    hideFromAt(m.getElement());
    drop(m.getElement(), i);
    return { layer: m, sig: `${p.lat},${p.lng}`, open: p.open };
  }

  function onClusterClick(key: string) {
    const c = entries.get(key)?.cluster; if (!c) return;
    if (c.stack && map.getZoom() >= STACK_LIST_ZOOM) { propsRef.current.onStackTap?.(c.ids); return; }
    const pts = c.ids.map((id) => byId.get(id)).filter((p): p is MapPoint => !!p).map((p) => L.latLng(p.lat, p.lng));
    const b = pts.length ? L.latLngBounds(pts) : L.latLngBounds([[c.lat, c.lng], [c.lat, c.lng]]);
    const ins = insets();
    gesture = true; // the user tapped the map: the view is theirs and the revealed pins drop in
    run(() => map.flyToBounds(b, { paddingTopLeft: [16, ins.top + 16], paddingBottomRight: [16, ins.bottom + 16], maxZoom: CLUSTER_MAX_ZOOM, animate: !reduced }));
    propsRef.current.onClusterTap?.(toBounds(b));
  }

  function makeCluster(key: string, c: Cluster, i: number): Keyed {
    const icon = L.divIcon({ className: `map-cluster map-cluster--${clusterSize(c.n)}`, html: clusterHtml(c.n, c.open / c.n), iconSize: [CLUSTER_BOX, CLUSTER_BOX], iconAnchor: [CLUSTER_BOX / 2, CLUSTER_BOX / 2] });
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

    // Case pins + clusters
    const pts = props.points;
    byId = new Map();
    const nextSingles = new Set<string>();
    if (pts && pts.length && size.x > 0 && size.y > 0) {
      const zoom = map.getZoom();
      const draw = map.getBounds().pad(DRAW_PAD);
      const inView: ClusterPoint[] = [];
      for (const p of pts) { byId.set(p.id, p); if (draw.contains([p.lat, p.lng])) inView.push(p); }
      const forcePins = hysteresis != null && hysteresis.zoom === zoom && !hysteresis.clustered;
      const res = clusterGrid(inView, (lat, lng) => map.project([lat, lng], zoom), zoom, { forcePins });
      hysteresis = { zoom, clustered: res.clustered };

      let halos = 0;
      const haloOk = zoom >= HALO_ZOOM && !reduced;
      for (const id of res.singles) {
        const p = byId.get(id); if (!p) continue;
        const key = `c:${id}`; want.add(key); nextSingles.add(id);
        const halo = haloOk && p.open && halos < HALO_MAX; if (halo) halos++;
        let e = entries.get(key);
        if (!e) { e = makePin(p, created++); entries.set(key, e); }
        else {
          const m = e.layer as L.Marker;
          if (e.open !== p.open) { m.setIcon(caseIcon(p.open)); e.open = p.open; hideFromAt(m.getElement()); }
          const sig = `${p.lat},${p.lng}`; if (e.sig !== sig) { m.setLatLng([p.lat, p.lng]); e.sig = sig; }
        }
        applyPinState(e, id, halo);
      }
      for (const c of res.clusters) {
        const key = `k:${c.key}`; want.add(key);
        let e = entries.get(key);
        if (!e) { e = makeCluster(key, c, created++); entries.set(key, e); } else updateCluster(e, c);
        applyClusterState(e);
      }
    } else if (pts) for (const p of pts) byId.set(p.id, p);
    singles = nextSingles;

    // Home pin + ring
    const home = props.home;
    if (home) {
      want.add('home');
      const sig = `${home.lat},${home.lng}`;
      const e = entries.get('home');
      if (!e) {
        // Pointer-transparent: a tap on your own spot is a tap on the map (deselect), never a swallowed click.
        const m = L.marker([home.lat, home.lng], { icon: markerIcon('--ember', 'map-pin map-home'), keyboard: false, interactive: false, zIndexOffset: SELECTED_Z + 1 });
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
    for (const [key, e] of entries) {
      if (key.startsWith('c:')) applyPinState(e, key.slice(2), (e.layer as L.Marker).getElement()?.classList.contains('map-pin--halo') ?? false);
      else if (key.startsWith('k:')) applyClusterState(e);
    }
    bringSelectedIntoBand();
  }

  /** Pan the selected pin into the band between the insets (also re-run when the sheet rises under a selection). */
  function bringSelectedIntoBand() {
    if (propsRef.current.panToSelection === false) return;
    const sel = propsRef.current.selectedId; if (!sel) return;
    const p = byId.get(sel); if (!p) return;
    const ins = insets();
    if (map.getSize().y - ins.top - ins.bottom < MIN_BAND_PX) return; // FULL: the list is the view, the map is a sliver
    if (singles.has(sel)) run(() => map.panInside([p.lat, p.lng], { paddingTopLeft: [0, ins.top + 16 + PIN_HEAD_PX], paddingBottomRight: [0, ins.bottom + 16], animate: !reduced }));
    else run(() => map.setView(centerFor(p, SELECT_ZOOM), SELECT_ZOOM, { animate: !reduced }));
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

  function fit(f: MapFit) {
    const first = fitCount++ === 0;
    whenZoomIdle(() => run(() => map.fitBounds(f.bounds, { paddingTopLeft: [0, f.paddingTop], paddingBottomRight: [0, f.paddingBottom], maxZoom: f.maxZoom, animate: !first && !reduced })));
  }

  function setView(center: L.LatLngExpression, zoom: number) {
    whenZoomIdle(() => run(() => map.setView(center, zoom, { animate: !reduced })));
  }

  map.on('movestart', () => { moved = true; });
  map.on('dragstart', () => { gesture = true; });
  map.on('zoomstart', () => { if (!programmatic) gesture = true; });
  map.on('moveend', () => { programmatic = false; });
  map.on('moveend zoomend resize', scheduleView);
  map.on('click', () => propsRef.current.onBackgroundTap?.());

  function dispose() {
    window.clearTimeout(viewTimer); window.clearTimeout(programmaticTimer);
    group.clearLayers(); entries.clear();
  }

  return { redraw, scheduleView, selectionChanged, bringSelectedIntoBand, hoverChanged, fit, setView, dispose };
}
type Controller = ReturnType<typeof createController>;

export default function MapView(props: MapViewProps) {
  const {
    center, zoom, draggablePin = null, height, ariaLabel, frameless = false, zoomControl = true,
    points, selectedId = null, hoverId = null, home = null, ring = null, hood = null, fit = null, insets,
  } = props;
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const ctlRef = useRef<Controller | null>(null);
  const pinRef = useRef<L.Marker | null>(null);

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
      zoomControl,
      attributionControl: false,
      keyboard: true,
    });
    L.control.attribution({ position: frameless ? 'bottomleft' : 'bottomright' }).addTo(map);
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', ariaLabel);

    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);

    const ctl = createController(map, propsRef);
    ctlRef.current = ctl;
    mapRef.current = map;
    // Leaflet can mis-measure if the container animates in; correct on next frame, then report the first view.
    const t = window.setTimeout(() => { map.invalidateSize(); ctl.scheduleView(); }, 0);

    const w = window as unknown as { __streetMap?: L.Map };
    if (propsRef.current.testHook) w.__streetMap = map;
    propsRef.current.onReady?.(map);

    return () => {
      window.clearTimeout(t);
      ctl.dispose();
      map.remove();
      if (w.__streetMap === map) delete w.__streetMap;
      mapRef.current = null;
      ctlRef.current = null;
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
      const pin = L.marker(pos, { icon: markerIcon('--ember'), draggable: true, keyboard: false, alt: 'Report location' });
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

  return <div ref={elRef} className={frameless ? 'mapview is-frameless' : 'mapview'} style={height ? { height: `${height}px` } : undefined} />;
}
