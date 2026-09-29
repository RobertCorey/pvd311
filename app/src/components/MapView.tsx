import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import './MapView.css';

export interface MapViewProps {
  center?: [number, number];
  zoom?: number;
  draggablePin?: { lat: number; lng: number } | null;
  onPinMove?: (lat: number, lng: number) => void;
  /** Fixed height in px. Omit to fill the parent (which must have a height). */
  height?: number;
  ariaLabel: string;
}

/** Providence City Hall. */
const DEFAULT_CENTER: [number, number] = [41.824, -71.4128];
const DEFAULT_ZOOM = 13;

/** Basemap: OpenStreetMap's standard tiles. CARTO's free raster basemaps started serving an "API KEY REQUIRED"
 *  watermark tile instead of map imagery (seen live 2026-09-29 on the report screen's location picker at z17), so
 *  we no longer use them. OSM's tile policy is fine for our volume; keep the attribution and never bulk-download. */
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const fill = (color: string) => (color.startsWith('--') ? `var(${color})` : color);

/** Two-ink pin: colored plate off-register behind an ink pin with the × mark (matches BrandMark), with a slow halo. */
function pinHtml(color: string): string {
  return (
    `<span class="map-pin-halo" style="--halo:${fill(color)}"></span>` +
    `<svg width="32" height="40" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<circle cx="15" cy="12.6" r="7.4" style="fill:${fill(color)}"/>` +
    `<path d="M12 1C6.9 1 3 5.1 3 10.2c0 6.6 7.4 17.4 8.3 18.6a.9.9 0 0 0 1.4 0C13.6 27.6 21 16.8 21 10.2 21 5.1 17.1 1 12 1z" ` +
    `style="fill:var(--ink);stroke:var(--bg);stroke-width:1.4"/>` +
    `<path d="M9.4 7.6l5.2 5.2M14.6 7.6l-5.2 5.2" style="stroke:var(--bg);stroke-width:2.2;stroke-linecap:round"/>` +
    `</svg>`
  );
}

function markerIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: 'map-pin',
    html: pinHtml(color),
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
  draggablePin = null,
  onPinMove,
  height,
  ariaLabel,
}: MapViewProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const programmaticRef = useRef(false);
  const pinRef = useRef<L.Marker | null>(null);

  // Keep the latest callback in a ref so the init effect stays mount-only.
  const onPinMoveRef = useRef(onPinMove);
  onPinMoveRef.current = onPinMove;

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

    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: TILE_ATTRIBUTION }).addTo(map);

    map.on('moveend', () => { programmaticRef.current = false; });
    mapRef.current = map;
    // Leaflet can mis-measure if the container animates in; correct on next frame.
    const t = window.setTimeout(() => map.invalidateSize(), 0);

    return () => {
      window.clearTimeout(t);
      map.remove();
      mapRef.current = null;
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
      pin.on('dragend', () => { const ll = pin.getLatLng(); onPinMoveRef.current?.(ll.lat, ll.lng); });
      pin.addTo(map);
      const pinEl = pin.getElement();
      if (pinEl) { pinEl.setAttribute('aria-hidden', 'true'); pinEl.setAttribute('tabindex', '-1'); }
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
