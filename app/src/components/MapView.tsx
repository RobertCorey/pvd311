import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MapView.css';

export interface MapMarker {
  id: string;
  lat: number;
  lng: number;
  label: string;
  /** CSS color or a `--token` name (wrapped in `var()`). Defaults to `--accent-2`. */
  color?: string;
  /** Navigates here (react-router) when the marker is clicked/activated. */
  href?: string;
  /** Still open at the city → slow pulse halo. */
  open?: boolean;
}

export interface MapViewProps {
  center?: [number, number];
  zoom?: number;
  markers?: MapMarker[];
  draggablePin?: { lat: number; lng: number } | null;
  onPinMove?: (lat: number, lng: number) => void;
  onMoveEnd?: (bbox: [number, number, number, number]) => void;
  /** Fixed height in px. Omit to fill the parent (which must have a height). */
  height?: number;
  /** Draw the downtown rivers as an ember accent (the WaterFire line). Default true. */
  rivers?: boolean;
  ariaLabel: string;
}

/** Providence City Hall. */
const DEFAULT_CENTER: [number, number] = [41.824, -71.4128];
const DEFAULT_ZOOM = 13;

/** Basemap. CARTO's free raster basemaps (Voyager light / Dark Matter = 'dark_all' dark) carry the brand better than
 *  default OSM and are fine for our volume; both require the OSM + CARTO attribution below.
 *  Swap back to OSM in one line: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png' (attribution: OSM only). */
const TILE_URL = 'https://{s}.basemaps.cartocdn.com/rastertiles/{style}/{z}/{x}/{y}{r}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
const isDark = () => {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced) return forced === 'dark';
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches;
};
const tileStyle = () => (isDark() ? 'dark_all' : 'voyager');

const fill = (color: string) => (color.startsWith('--') ? `var(${color})` : color);

/** Two-ink pin: colored plate off-register behind an ink pin with the × mark (matches BrandMark). */
function pinHtml(color: string, pulse: boolean): string {
  return (
    (pulse ? `<span class="map-pin-halo" style="--halo:${fill(color)}"></span>` : '') +
    `<svg width="32" height="40" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<circle cx="15" cy="12.6" r="7.4" style="fill:${fill(color)}"/>` +
    `<path d="M12 1C6.9 1 3 5.1 3 10.2c0 6.6 7.4 17.4 8.3 18.6a.9.9 0 0 0 1.4 0C13.6 27.6 21 16.8 21 10.2 21 5.1 17.1 1 12 1z" ` +
    `style="fill:var(--ink);stroke:var(--bg);stroke-width:1.4"/>` +
    `<path d="M9.4 7.6l5.2 5.2M14.6 7.6l-5.2 5.2" style="stroke:var(--bg);stroke-width:2.2;stroke-linecap:round"/>` +
    `</svg>`
  );
}

function markerIcon(color: string, opts: { pulse?: boolean; index?: number } = {}): L.DivIcon {
  return L.divIcon({
    className: `map-pin${opts.pulse ? ' map-pin--open' : ''}`,
    html: `<span class="map-pin-drop" style="animation-delay:${Math.min(opts.index ?? 0, 20) * 30}ms">${pinHtml(color, !!opts.pulse)}</span>`,
    iconSize: [32, 40],
    iconAnchor: [16, 38],
    popupAnchor: [0, -36],
  });
}

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export default function MapView({
  center,
  zoom,
  markers = [],
  draggablePin = null,
  onPinMove,
  onMoveEnd,
  height,
  rivers = true,
  ariaLabel,
}: MapViewProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const programmaticRef = useRef(false);
  const markerLayerRef = useRef<L.LayerGroup | null>(null);
  const pinRef = useRef<L.Marker | null>(null);
  const navigate = useNavigate();

  // Keep the latest callbacks/label in refs so the init effect stays mount-only.
  const onMoveEndRef = useRef(onMoveEnd);
  const onPinMoveRef = useRef(onPinMove);
  const navigateRef = useRef(navigate);
  onMoveEndRef.current = onMoveEnd;
  onPinMoveRef.current = onPinMove;
  navigateRef.current = navigate;

  // Init map once.
  useEffect(() => {
    const el = elRef.current;
    if (!el || mapRef.current) return;

    const map = L.map(el, {
      center: center ?? DEFAULT_CENTER,
      zoom: zoom ?? DEFAULT_ZOOM,
      zoomControl: true,
      attributionControl: true,
      keyboard: true,
    });
    el.setAttribute('role', 'region');
    el.setAttribute('aria-label', ariaLabel);

    const tiles = L.tileLayer(TILE_URL.replace('{style}', tileStyle()), { maxZoom: 19, subdomains: 'abcd', attribution: TILE_ATTRIBUTION }).addTo(map);
    // Follow the theme live (system switch or manual toggle).
    const mq = window.matchMedia?.('(prefers-color-scheme: dark)');
    const retheme = () => tiles.setUrl(TILE_URL.replace('{style}', tileStyle()));
    mq?.addEventListener?.('change', retheme);
    const mo = new MutationObserver(retheme);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

    markerLayerRef.current = L.layerGroup().addTo(map);

    // The WaterFire line: Providence / Woonasquatucket / Moshassuck rivers in ember — a glow pass under a thin line.
    if (rivers) {
      import('../lib/rivers.data').then(({ RIVERS }) => {
        if (!mapRef.current) return;
        const glow = L.layerGroup().addTo(map);
        for (const r of RIVERS) {
          L.polyline(r.pts, { color: 'var(--ember)', weight: 9, opacity: 0.18, lineCap: 'round', lineJoin: 'round', interactive: false, className: 'map-river-glow' }).addTo(glow);
          L.polyline(r.pts, { color: 'var(--ember)', weight: 2.5, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false, className: 'map-river' }).addTo(glow);
        }
      }).catch(() => {});
    }
    map.on('moveend', () => {
      if (programmaticRef.current) { programmaticRef.current = false; return; } // ignore our own setView
      const b = map.getBounds();
      onMoveEndRef.current?.([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()]);
    });
    mapRef.current = map;
    // Leaflet can mis-measure if the container animates in; correct on next frame.
    const t = window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      window.clearTimeout(t);
      mq?.removeEventListener?.('change', retheme);
      mo.disconnect();
      map.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
      pinRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the aria-label in sync if it changes.
  useEffect(() => {
    elRef.current?.setAttribute('aria-label', ariaLabel);
  }, [ariaLabel]);

  // Render markers.
  useEffect(() => {
    const layer = markerLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    markers.forEach((m, i) => {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) return;
      const marker = L.marker([m.lat, m.lng], {
        icon: markerIcon(m.color ?? '--ember', { pulse: m.open, index: i }),
        title: m.label,
        alt: m.label,
        keyboard: true,
        riseOnHover: true,
      });
      const href = m.href;
      if (href) marker.on('click keypress', (e) => {
        // Enter/Space on a focused marker fire keypress in Leaflet.
        if ('originalEvent' in e && (e as L.LeafletKeyboardEvent).originalEvent) {
          const key = (e as L.LeafletKeyboardEvent).originalEvent.key;
          if (key && key !== 'Enter' && key !== ' ') return;
        }
        navigateRef.current(href);
      });
      marker.addTo(layer);
    });
  }, [markers]);

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
      const pin = L.marker(pos, { icon: markerIcon('--ember', { pulse: true }), draggable: true, keyboard: true, alt: 'Report location' });
      pin.on('dragend', () => { const ll = pin.getLatLng(); onPinMoveRef.current?.(ll.lat, ll.lng); });
      pin.addTo(map);
      pinRef.current = pin;
    } else {
      pinRef.current.setLatLng(pos);
    }
  }, [draggablePin]);

  // Follow controlled center/zoom changes (report screen re-centering on the pin).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !center) return;
    programmaticRef.current = true;
    map.setView(center, zoom ?? map.getZoom(), { animate: !prefersReducedMotion() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.[0], center?.[1], zoom]);

  return <div ref={elRef} className="mapview" style={height ? { height: `${height}px` } : undefined} />;
}
