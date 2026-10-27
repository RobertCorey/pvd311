/** Marker markup for the /street map (spec: .claude/street-map-spec.md "pins"; type glyphs + new-only halo 2026-10-27).
 *  Pure strings, no Leaflet and no React: MapView wraps them in cached L.divIcons, and the map key (components/MapKey)
 *  draws its swatches from the very same functions — so the legend can never drift from the map. Light mode only. */
import { GROUP_ORDER, type GroupKey } from '@shared/categories';

/** One marker as the map draws it: the divIcon's className, its inner HTML and its box in CSS px. */
export interface MarkerParts { className: string; html: string; size: [number, number]; anchor: [number, number] }

const fill = (color: string) => (color.startsWith('--') ? `var(${color})` : color);

export const PIN_PATH = 'M12 1C6.9 1 3 5.1 3 10.2c0 6.6 7.4 17.4 8.3 18.6a.9.9 0 0 0 1.4 0C13.6 27.6 21 16.8 21 10.2 21 5.1 17.1 1 12 1z';

/** Two-ink pin: colored plate off-register behind an ink pin with the × mark (matches BrandMark), with a slow halo.
 *  Used by the report screen's picker and, as `.map-home`, for "the spot you picked" on /street. */
export function pinHtml(color: string): string {
  return (
    `<span class="map-pin-halo" style="--halo:${fill(color)}"></span>` +
    `<svg width="32" height="40" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
    `<circle cx="15" cy="12.6" r="7.4" style="fill:${fill(color)}"/>` +
    `<path d="${PIN_PATH}" style="fill:var(--ink);stroke:var(--bg);stroke-width:1.4"/>` +
    `<path d="M9.4 7.6l5.2 5.2M14.6 7.6l-5.2 5.2" style="stroke:var(--bg);stroke-width:2.2;stroke-linecap:round"/>` +
    `</svg>`
  );
}

/** The searched / located spot ("the address you looked up"): the × pin at 32×40. */
export function homeMarker(): MarkerParts {
  return { className: 'map-pin map-home', html: pinHtml('--ember'), size: [32, 40], anchor: [16, 38] };
}

/* ── Type glyphs: one per picker group (shared/categories GROUP_ORDER), drawn white inside the pin's head ─────────
 * A 12-unit box placed on the head (centre 12,10.2, radius 9, in the pin's 24×30 viewBox) → ≈ 12 px on an open pin,
 * 11 px on a closed one. Path-only, simplified from CategoryIcon's group tiles (a road for the pothole, a fir for
 * the broken limb, a drop for the hydrant, a bulb for the lamp post — they read at this size). `d` is stroked,
 * `dots` stroked heavier (round caps on zero-length segments draw the dots), `solid` filled. */
interface Glyph { d?: string; dots?: string; solid?: string }
export const GROUP_GLYPHS: Record<GroupKey, Glyph> = {
  trash: { d: 'M2.5 3.5h7M3.5 3.5l.7 6.6h3.6l.7-6.6M5 3.5V2h2v1.5' },
  streets: { d: 'M1.9 10.8L4.5 1.2M10.1 10.8L7.5 1.2M6 2.8v1.4M6 7.2v1.8' },
  traffic: { d: 'M3.6 1.4h4.8v9.2H3.6z', dots: 'M6 3.6v.01M6 6v.01M6 8.4v.01' },
  trees: { d: 'M6 1.2L3 5.2h1.6L2.2 8.6h7.6L7.4 5.2H9zM6 8.6V11' },
  property: { d: 'M1.8 6.2L6 2.3l4.2 3.9M3.2 5v5.5h5.6V5M5.2 10.5V8h1.6v2.5' },
  lights: { d: 'M4.3 8.2C3.2 7.4 2.6 6.3 2.6 5a3.4 3.4 0 0 1 6.8 0c0 1.3-.6 2.4-1.7 3.2V9H4.3zM4.6 10.9h2.8' },
  nuisance: { d: 'M1.8 4.6h1.8l2.8-2.4v7.6L3.6 7.4H1.8zM8.4 4a2.6 2.6 0 0 1 0 4M9.9 2.6a4.8 4.8 0 0 1 0 6.8' },
  water: { d: 'M6 1.6C4.4 3.8 2.8 5.6 2.8 7.6a3.2 3.2 0 0 0 6.4 0C9.2 5.6 7.6 3.8 6 1.6z' },
  animals: { dots: 'M2.6 5v.01M4.6 2.9v.01M7.4 2.9v.01M9.4 5v.01', solid: 'M6 6.4c-1.9 0-3 1.4-3 2.6 0 .9.9 1.4 3 1.4s3-.5 3-1.4c0-1.2-1.1-2.6-3-2.6z' },
  other: { dots: 'M3 6v.01M6 6v.01M9 6v.01' },
};

const isGroup = (g: string): g is GroupKey => (GROUP_ORDER as string[]).includes(g);
/** A case's group as the pin draws it: anything this app does not know reads as `other`. */
export const pinGroup = (g: string | null | undefined): GroupKey => (g && isGroup(g) ? g : 'other');

/** The glyph's SVG markup (a `<g class="map-pin-glyph">`), for the pin and the map key. */
export function glyphSvg(group: string): string {
  const g = GROUP_GLYPHS[pinGroup(group)];
  return (
    `<g class="map-pin-glyph" transform="translate(6 4.2)" style="fill:none;stroke:#fff;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round">` +
    (g.d ? `<path d="${g.d}"/>` : '') +
    (g.dots ? `<path d="${g.dots}" style="stroke-width:2.3"/>` : '') +
    (g.solid ? `<path d="${g.solid}" style="fill:#fff;stroke:none"/>` : '') +
    `</g>`
  );
}

/** A city case: a plain two-ink teardrop, no ×, no plate, the type glyph in white in its head. Open = ember fill 26×32;
 *  closed = muted fill 22×27 (at .85 opacity, MapView.css). A --bg outline behind the 1.4 ink stroke keeps it legible on
 *  pale tiles. Only a NEW case (open, reported in the last 48 h — lib/streetMap isNewCase) carries the halo span, shown
 *  while the marker has `.map-pin--halo` (MapView grants it to the first HALO_MAX, never under reduced motion). */
export function casePinHtml(group: string, open: boolean, isNew = false): string {
  const [w, h] = open ? [26, 32] : [22, 27];
  const c = open ? 'var(--ember)' : 'var(--muted)';
  return (
    (open && isNew ? `<span class="map-pin-halo" style="--halo:var(--ember)"></span>` : '') +
    `<svg width="${w}" height="${h}" viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" data-group="${pinGroup(group)}">` +
    `<path d="${PIN_PATH}" style="fill:none;stroke:var(--bg);stroke-width:3.4"/>` +
    `<path d="${PIN_PATH}" style="fill:${c};stroke:var(--ink);stroke-width:1.4"/>` +
    glyphSvg(group) +
    `</svg>`
  );
}

/** The case pin as a marker: one per (group, open, new) — MapView caches the divIcon under `casePinKey`. */
export function caseMarker(group: string, open: boolean, isNew = false): MarkerParts {
  const fresh = open && isNew;
  return {
    className: `map-pin map-case${open ? '' : ' map-pin--closed'}${fresh ? ' map-case--new' : ''}`,
    html: casePinHtml(group, open, fresh),
    size: open ? [26, 32] : [22, 27],
    anchor: open ? [13, 31] : [11, 26],
  };
}
export const casePinKey = (group: string, open: boolean, isNew = false): string => `${pinGroup(group)}|${open ? 1 : 0}|${open && isNew ? 1 : 0}`;

/** Cluster disc: the count in Bricolage ink on surface inside a 2 px ink border, wrapped in a 5 px conic ring —
 *  ember for the open share, muted for the rest (the only place colour encodes status at city scale; the count is the
 *  accessible fact, in the list). The disc is 36 / 44 / 52 px via `.map-cluster--s|m|l`; the marker box is a fixed 52. */
export function clusterHtml(n: number, openShare: number): string {
  const deg = Math.round(Math.min(1, Math.max(0, openShare)) * 360);
  return `<span class="map-cluster-ring" style="--share:${deg}deg"><span class="map-cluster-disc">${n}</span></span>`;
}
export const clusterSize = (n: number): 's' | 'm' | 'l' => (n < 10 ? 's' : n < 100 ? 'm' : 'l');
export const CLUSTER_BOX = 52;
export function clusterMarker(n: number, openShare: number): MarkerParts {
  return { className: `map-cluster map-cluster--${clusterSize(n)}`, html: clusterHtml(n, openShare), size: [CLUSTER_BOX, CLUSTER_BOX], anchor: [CLUSTER_BOX / 2, CLUSTER_BOX / 2] };
}
