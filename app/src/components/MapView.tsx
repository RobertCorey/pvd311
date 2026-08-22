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
  ariaLabel: string;
}

/** Providence City Hall. */
const DEFAULT_CENTER: [number, number] = [41.824, -71.4128];
const DEFAULT_ZOOM = 13;

const fill = (color: string) => (color.startsWith('--') ? `var(${color})` : color);

function pinHtml(color: string): string {
  return (
    `<svg width="30" height="38" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<path d="M12 1C6.9 1 3 5.1 3 10.2c0 6.6 7.4 17.4 8.3 18.6a.9.9 0 0 0 1.4 0C13.6 27.6 21 16.8 21 10.2 21 5.1 17.1 1 12 1z" ` +
    `style="fill:${fill(color)};stroke:#fff;stroke-width:1.6"/>` +
    `<circle cx="12" cy="10.2" r="3.4" style="fill:#fff"/>` +
    `</svg>`
  );
}

function markerIcon(color: string): L.DivIcon {
  return L.divIcon({
    className: 'map-pin',
    html: pinHtml(color),
    iconSize: [30, 38],
    iconAnchor: [15, 36],
    popupAnchor: [0, -34],
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

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);

    markerLayerRef.current = L.layerGroup().addTo(map);
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
    for (const m of markers) {
      if (!Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
      const marker = L.marker([m.lat, m.lng], {
        icon: markerIcon(m.color ?? '--accent-2'),
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
    }
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
      const pin = L.marker(pos, { icon: markerIcon('--accent-2'), draggable: true, keyboard: true, alt: 'Report location' });
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
