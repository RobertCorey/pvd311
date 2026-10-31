// Providence Rent Cap Map: the April 2026 ordinance (as passed, vetoed) applied to every parcel, one dot per home.
import { classify, type Classification } from '../src/classify.ts';
import { normalizeQuery } from '../src/normalize.ts';
import type { Rules } from '../src/rules.ts';
import type { Parcel } from '../src/types.ts';
import { housingMix } from '../src/units.ts';

declare const maplibregl: any;

interface Hood { name: string; polygons: number[][][][] }
interface Data {
  generated: string; fetched: string; rules: Rules;
  acs: { label: string; housingUnits: number; renterOccupied: number; vacantForRent: number; ownerOccupied?: number };
  neighborhoods: Hood[]; cols: string[]; rows: unknown[][]; dict: Record<string, unknown[]>;
}
// Display rule: every home gets one category from its parcel's result (src/units.ts housingMix, then slicesFor below).
//   owner's own unit, owner-occupied rate on file            → owned       "Not a rental"            neutral, light
//   "owner may live here" (bill at the property, no rate)    → owned for one unit, market for the rest, both "probably"
//   rental the bill covers                                   → controlled  "Rent-stabilized"         hue
//   rental the bill exempts (owner-occupied 2–4s' other units,
//     new construction, institutions …)                      → market      "Open market"             hue
//   rental exempt because a program already sets the rent    → subsidized  "Rent set by a program"   neutral, middle
//   the records can't settle it                              → unclear     "Can't tell"              neutral, dark
// Changing how a group is shown means changing this rule, not the data.
type Cat = 'owned' | 'controlled' | 'market' | 'subsidized' | 'unclear';
const CATS: Cat[] = ['owned', 'controlled', 'market', 'subsidized', 'unclear'];
/** A parcel's homes, split by category and by whether the records settle it ("sure") or it's our best guess. */
interface Slice { cat: Cat; sure: boolean; n: number }
interface Row { p: Parcel; c: Classification; slices: Slice[]; homes: number }
interface Tally { homes: number; sure: Record<Cat, number>; likely: Record<Cat, number>; exemptBy: Map<string, number> }

const LABEL: Record<Cat, string> = { owned: 'Not a rental', controlled: 'Rent-stabilized', market: 'Open market', subsidized: 'Rent set by a program', unclear: "Can't tell" };
const HELP: Record<Cat, string> = {
  owned: "the owner's own home",
  controlled: 'rentals the 4% cap would reach',
  market: 'rentals the bill exempts: mostly other units in owner-occupied 2–4 families, and new construction',
  subsidized: 'public housing, project-based Section 8, tax-credit and other income-restricted rentals',
  unclear: 'big or unusual buildings, owners’ second properties',
};
const OWNER_MAY_LIVE = 'owner_may_live_here';
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const $ = (id: string) => document.getElementById(id)!;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let data: Data;
let rows: Row[] = [];
let city: Tally;
const hoods = new Map<string, Tally>();
let map: any;
let selected: number | null = null;
let selectedHood: string | null = null;
let sortBy: 'count' | 'share' = 'count';
interface Buildings { origin: [number, number]; scale: number; buildings: [number[], number[]][]; addresses: [string, number[]][] }
let bldg: Buildings;
let selectedBuilding: number | null = null;

// ── data ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function toParcel(cols: string[], row: unknown[], dict: Data['dict']): Parcel {
  const o: any = {};
  cols.forEach((c, i) => (o[c] = dict[c] ? dict[c][row[i] as number] : row[i]));
  const bool = (v: unknown) => (v == null ? null : v === 1);
  return {
    ...o,
    ownerOccupiedTaxRate: bool(o.ownerOccupiedTaxRate), mailingIsProperty: bool(o.mailingIsProperty), camaMatched: o.camaMatched === 1,
    ownerNameAmbiguous: o.ownerNameAmbiguous === 1, homeParcelOwnerOccupied: bool(o.homeParcelOwnerOccupied),
    homeParcelId: o.homeParcel === 1 ? 'x' : null, homeParcelAddress: null, homeParcelSameOwner: null,
    ownerOtherResidential: (o.ownerOther as (number | null)[]).map((v) => ({ id: '', address: '', ownerOccupied: bool(v) })),
    ownerOtherResidentialParcels: (o.ownerOther as unknown[]).length,
  } as Parcel;
}

/** Best estimate: an owner who gets the tax bill at the property but lacks the owner-occupied rate probably lives there. */
function slicesFor(p: Parcel, c: Classification, rules: Rules): { slices: Slice[]; homes: number } {
  const m = housingMix(p, c, rules);
  if (!m.units) return { slices: [], homes: 0 };
  if (c.rule === OWNER_MAY_LIVE) {
    const out: Slice[] = [{ cat: 'owned', sure: false, n: 1 }];
    if (m.units > 1) out.push({ cat: 'market', sure: false, n: m.units - 1 });
    return { slices: out, homes: m.units };
  }
  return { slices: CATS.filter((k) => m[k] > 0).map((k) => ({ cat: k, sure: true, n: m[k] })), homes: m.units };
}

const emptyCats = () => ({ owned: 0, controlled: 0, market: 0, subsidized: 0, unclear: 0 });
const newTally = (): Tally => ({ homes: 0, sure: emptyCats(), likely: emptyCats(), exemptBy: new Map() });
function add(t: Tally, r: Row) {
  t.homes += r.homes;
  for (const s of r.slices) {
    (s.sure ? t.sure : t.likely)[s.cat] += s.n;
    if (s.cat === 'market') {
      const label = r.c.rule === OWNER_MAY_LIVE ? 'owner probably lives in the building' : data.rules.rules.find((x) => x.id === r.c.rule)?.label ?? r.c.rule;
      t.exemptBy.set(label, (t.exemptBy.get(label) ?? 0) + s.n);
    }
  }
}
const all = (t: Tally, k: Cat) => t.sure[k] + t.likely[k];
const rentals = (t: Tally) => t.homes - all(t, 'owned');

// ── panel ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const SEGMENTS: [Cat, boolean][] = [['owned', true], ['owned', false], ['controlled', true], ['market', true], ['market', false], ['subsidized', true], ['unclear', true]];
function bar(t: Tally, cls: string) {
  return `<div class="${cls}" aria-hidden="true">${SEGMENTS.map(([k, sure]) => {
    const n = (sure ? t.sure : t.likely)[k];
    return n ? `<i style="flex-grow:${n};background:var(--${k});opacity:${sure ? 1 : 0.45}"></i>` : '';
  }).join('')}</div>`;
}

function keyRows(t: Tally) {
  const order: Cat[] = ['controlled', 'market', 'subsidized', 'owned', 'unclear'];
  return `<div class="key">${order.map((k) => `
    <div><span class="sw ${k}"></span><span>${LABEL[k]} <span class="muted">· ${HELP[k]}</span></span><b>${fmt(t.sure[k])}${t.likely[k] ? `<span class="muted" style="font-weight:400"> +${fmt(t.likely[k])}</span>` : ''}</b></div>`).join('')}
    <p class="note"><span class="sw owned light" style="display:inline-block;margin-right:4px"></span>The lighter “+” homes are owners who get their tax bill at the building but don’t have the owner-occupied tax rate. They probably live there.</p>
  </div>`;
}

function renderCity() {
  const t = city;
  const upper = t.sure.controlled + t.sure.unclear + t.likely.owned + t.likely.market;
  $('body').innerHTML = `
    <section class="headline">
      <span class="big">${fmt(t.sure.controlled)}</span>
      <h2>rental homes would likely have been rent-stabilized</h2>
      <p class="muted">That’s ${pct(t.sure.controlled, rentals(t))} of the city’s ${fmt(rentals(t))} rentals, and ${pct(t.sure.controlled, t.homes)} of all ${fmt(t.homes)} homes. ${fmt(t.sure.unclear)} more are in buildings the records can’t settle; it could reach ${fmt(upper)} if none of those, and none of the lighter homes, turn out exempt.</p>
      <p class="note">Official estimates, all citywide with no map: the council’s fiscal note said about 60% of rentals (written before the exemptions were widened); the city finance director said under 44%; the mayor’s veto letter said about half are exempt.</p>
    </section>
    ${bar(t, 'stack')}
    ${keyRows(t)}
    <section style="display:grid;gap:8px">
      <div class="sortbar"><h3 style="margin-right:auto">Neighborhoods</h3>
        <button type="button" data-sort="count" aria-pressed="${sortBy === 'count'}">Most stabilized</button>
        <button type="button" data-sort="share" aria-pressed="${sortBy === 'share'}">Highest share</button>
      </div>
      <p class="note">Each bar is all of a neighborhood’s homes: owners’ homes in light gray, then rentals.</p>
      <div class="hoods">${hoodList()}</div>
    </section>`;
  $('body').querySelectorAll<HTMLButtonElement>('[data-sort]').forEach((b) => b.addEventListener('click', () => { sortBy = b.dataset.sort as typeof sortBy; renderCity(); }));
  $('body').querySelectorAll<HTMLButtonElement>('[data-hood]').forEach((b) => b.addEventListener('click', () => pickHood(b.dataset.hood!, true)));
}

function hoodList() {
  const list = [...hoods.entries()].filter(([n, t]) => n !== '—' && t.homes > 50);
  list.sort((a, b) => (sortBy === 'count' ? b[1].sure.controlled - a[1].sure.controlled : b[1].sure.controlled / rentals(b[1]) - a[1].sure.controlled / rentals(a[1])));
  return list.map(([n, t]) => `<button type="button" data-hood="${esc(n)}">
      <span class="top"><b>${esc(n)}</b><span>${pct(rentals(t), t.homes)} rentals · ${pct(t.sure.controlled, rentals(t))} of rentals stabilized</span></span>
      ${bar(t, 'mini')}
    </button>`).join('');
}

function renderHood(name: string) {
  const t = hoods.get(name);
  if (!t) return renderCity();
  const r = rentals(t);
  const topExempt = [...t.exemptBy.entries()].sort((a, b) => b[1] - a[1])[0];
  $('body').innerHTML = `
    <div class="card">
      <button class="back" type="button" id="back">← All of Providence</button>
      <div><h2>${esc(name)}</h2><p class="muted small">${fmt(t.homes)} homes on record</p></div>
      ${bar(t, 'stack')}
      <p>${pct(all(t, 'owned'), t.homes)} of homes are owner-occupied. Of the ${fmt(r)} rentals, <b>${pct(t.sure.controlled, r)}</b> would be rent-stabilized, ${pct(all(t, 'market'), r)} stay on the open market${topExempt ? ` (mostly: ${esc(topExempt[0].toLowerCase())})` : ''}, ${pct(t.sure.subsidized, r)} have rents set by a program, and ${pct(t.sure.unclear, r)} can’t be settled from the records.</p>
      ${keyRows(t)}
    </div>`;
  $('back').addEventListener('click', clearSelection);
}

const PILL: Record<string, [Cat, string]> = {
  likely_covered: ['controlled', 'Likely rent-stabilized'],
  likely_exempt: ['market', 'Likely exempt'],
  cant_tell: ['unclear', "Can't tell"],
  not_residential_rental: ['owned', 'Not a rental'],
};
function renderParcel(i: number) {
  const { p, c, slices } = rows[i];
  let [cat, label] = PILL[c.status];
  if (c.rule === 'public_and_subsidized_housing') { cat = 'subsidized'; label = 'Likely exempt · rent set by a program'; }
  if (c.rule === OWNER_MAY_LIVE) label = "Can't tell · the owner probably lives here";
  const homes = slices.map((s) => `${s.n} ${LABEL[s.cat].toLowerCase()}${s.sure ? '' : ' (probably)'}`).join(', ');
  $('body').innerHTML = `
    <div class="card">
      <button class="back" type="button" id="back">← ${p.neighborhood ? esc(p.neighborhood) : 'All of Providence'}</button>
      <div><h2>${esc(p.address)}</h2><p class="muted small">${esc(p.neighborhood ?? '')} · ${esc(p.taxClassDesc)}${p.units ? ` · ${p.units} unit${p.units > 1 ? 's' : ''}` : ''}${p.yearBuilt ? ` · built ${p.yearBuilt}` : ''}</p></div>
      <p><span class="pill ${cat}">${esc(label)}</span></p>
      <ul>${c.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${homes ? `<p class="small muted">On the map: ${esc(homes)}.</p>` : ''}
      ${c.confidence_notes.length ? `<details><summary>How sure is this?</summary><ul>${c.confidence_notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
      <p class="small muted">Seems wrong? You may know something the records don’t: who lives there, how many units it really has, or a subsidy.</p>
    </div>`;
  $('back').addEventListener('click', () => { const h = p.neighborhood; selected = null; selectedBuilding = null; updateSelection(); h ? pickHood(h, false) : clearSelection(); });
}

function clearSelection() { selected = null; selectedHood = null; selectedBuilding = null; updateSelection(); renderCity(); }
/** Parcel → its largest building, for highlighting after a search. */
const buildingOf = new Map<number, number>();

// ── map ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** One point per home, arranged in a sunflower spiral around the parcel point so a 3-family reads as three dots. */
function homePoints() {
  const features: any[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  rows.forEach((r, i) => {
    const { p } = r;
    if (p.lat == null || p.lng == null || !r.homes) return;
    const spacing = r.homes > 64 ? 48 / Math.sqrt(r.homes) : 6; // metres; big buildings stay within ~48 m
    const mPerLng = 111320 * Math.cos((p.lat * Math.PI) / 180);
    let j = 0;
    for (const s of r.slices) {
      for (let n = 0; n < s.n; n++, j++) {
        const rad = r.homes === 1 ? 0 : spacing * Math.sqrt(j + 0.5), th = j * golden;
        features.push({ type: 'Feature', properties: { p: i, k: CATS.indexOf(s.cat), s: s.sure ? 1 : 0 },
          geometry: { type: 'Point', coordinates: [p.lng + (rad * Math.cos(th)) / mPerLng, p.lat + (rad * Math.sin(th)) / 111320] } });
      }
    }
  });
  // Shuffle so no category is always drawn on top of the others.
  let seed = 311;
  for (let i = features.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [features[i], features[j]] = [features[j], features[i]];
  }
  return { type: 'FeatureCollection', features };
}

// Building fill classes: the lot's result, in the same colors as the dots, plus owner's home and no homes.
const BK = { owned: 0, controlled: 1, market: 2, subsidized: 3, unclear: 4, nohomes: 5 } as const;
function buildingClass(lots: number[]): { k: number; s: number } {
  const tally: Record<Cat, number> = { owned: 0, controlled: 0, market: 0, subsidized: 0, unclear: 0 };
  let probable = 0, total = 0;
  for (const i of lots) for (const sl of rows[i].slices) { tally[sl.cat] += sl.n; total += sl.n; if (!sl.sure) probable += sl.n; }
  if (!total) return { k: BK.nohomes, s: 1 };
  // A building's color is its rentals' result when it has rentals; the owner's home only when it is nothing else.
  const rentalCats: Cat[] = ['controlled', 'market', 'subsidized', 'unclear'];
  const best = rentalCats.reduce((a, b) => (tally[b] > tally[a] ? b : a));
  const k = tally[best] > 0 ? BK[best] : BK.owned;
  return { k, s: probable * 2 > total ? 0 : 1 };
}

function buildingFeatures() {
  const [X0, Y0] = bldg.origin, Q = bldg.scale;
  return {
    type: 'FeatureCollection',
    features: bldg.buildings.map(([lots, q], b) => {
      const ring: number[][] = [];
      let x = 0, y = 0;
      for (let j = 0; j < q.length; j += 2) { x += q[j]; y += q[j + 1]; ring.push([X0 + x / Q, Y0 + y / Q]); }
      return { type: 'Feature', id: b, properties: { b, ...buildingClass(lots) }, geometry: { type: 'Polygon', coordinates: [ring] } };
    }),
  };
}

function initMap(basemap: any) {
  const base = location.href.replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  const colors = CATS.map((k) => css(`--${k}`));
  const bounds = new maplibregl.LngLatBounds();
  for (const f of basemap.hoods.features) for (const poly of f.geometry.coordinates) for (const [x, y] of poly[0]) bounds.extend([x, y]);
  map = new maplibregl.Map({
    container: 'map', bounds, fitBoundsOptions: { padding: 16 }, maxBounds: [[bounds.getWest() - 0.03, bounds.getSouth() - 0.02], [bounds.getEast() + 0.03, bounds.getNorth() + 0.02]],
    minZoom: 11, maxZoom: 19, dragRotate: false, pitchWithRotate: false, attributionControl: false,
    style: {
      version: 8,
      glyphs: `${base}fonts/{fontstack}/{range}.woff`,
      sources: {
        water: { type: 'geojson', data: basemap.water }, parks: { type: 'geojson', data: basemap.parks },
        noHomes: { type: 'geojson', data: basemap.noHomes },
        roads: { type: 'geojson', data: basemap.roads }, major: { type: 'geojson', data: basemap.major },
        hoods: { type: 'geojson', data: basemap.hoods }, hoodLabels: { type: 'geojson', data: basemap.hoodLabels },
        homes: { type: 'geojson', data: homePoints() },
        buildings: { type: 'geojson', data: buildingFeatures() },
        sel: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'land', type: 'background', paint: { 'background-color': css('--land') } },
        { id: 'nohomes', type: 'fill', source: 'noHomes', paint: { 'fill-color': css('--nohomes'), 'fill-outline-color': css('--line') } },
        { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': '#D3E0E8' } },
        { id: 'parks', type: 'fill', source: 'parks', paint: { 'fill-color': '#E3E9D4' } },
        { id: 'hoods-hit', type: 'fill', source: 'hoods', paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
        { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.4, 15, 2.5, 17, 7, 19, 18] } },
        { id: 'major', type: 'line', source: 'major', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 1, 15, 4.5, 17, 11, 19, 26] } },
        { id: 'hoods-line', type: 'line', source: 'hoods', paint: { 'line-color': css('--ink'), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 16, 0.15], 'line-width': 1, 'line-dasharray': [3, 2] } },
        { id: 'hood-sel', type: 'line', source: 'hoods', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': css('--ink'), 'line-width': 2.2, 'line-opacity': 0.85 } },
        { id: 'bldg', type: 'fill', source: 'buildings', minzoom: 14,
          paint: {
            'fill-color': ['match', ['get', 'k'], 0, css('--owned'), 1, colors[1], 2, colors[2], 3, colors[3], 4, colors[4], css('--nohomes')],
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14.2, 0, 15.2, ['case', ['==', ['get', 's'], 1], 0.85, 0.42]],
          } },
        { id: 'bldg-line', type: 'line', source: 'buildings', minzoom: 15,
          paint: { 'line-color': css('--ink'), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 15, 0, 16.5, 0.28], 'line-width': 0.6 } },
        { id: 'bldg-sel', type: 'line', source: 'buildings', filter: ['==', ['get', 'b'], -1], paint: { 'line-color': css('--ink'), 'line-width': 2.5 } },
        { id: 'homes', type: 'circle', source: 'homes',
          paint: {
            'circle-color': ['match', ['get', 'k'], 0, colors[0], 1, colors[1], 2, colors[2], 3, colors[3], colors[4]],
            'circle-opacity': ['interpolate', ['linear'], ['zoom'], 14.8, ['case', ['==', ['get', 's'], 1], 0.95, 0.5], 15.6, 0],
            'circle-radius': ['interpolate', ['exponential', 1.5], ['zoom'], 11, 0.8, 13, 1.3, 15, 2.4, 16, 3.2, 17, 4.4, 18, 6.5, 19, 9],
          } },
        { id: 'sel', type: 'circle', source: 'sel',
          paint: { 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': css('--ink'), 'circle-stroke-width': 2,
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 13, 6, 17, 14, 19, 26] } },
        { id: 'road-labels', type: 'symbol', source: 'roads', minzoom: 15.5,
          layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['NotoSans-Regular'], 'text-size': 11, 'text-letter-spacing': 0.02 },
          paint: { 'text-color': css('--muted'), 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.4 } },
        { id: 'major-labels', type: 'symbol', source: 'major', minzoom: 13.5,
          layout: { 'symbol-placement': 'line', 'text-field': ['get', 'name'], 'text-font': ['NotoSans-Medium'], 'text-size': ['interpolate', ['linear'], ['zoom'], 13.5, 10.5, 17, 13] },
          paint: { 'text-color': css('--ink'), 'text-halo-color': '#FFFFFF', 'text-halo-width': 1.6 } },
        { id: 'hood-labels', type: 'symbol', source: 'hoodLabels', maxzoom: 14.5,
          layout: { 'text-field': ['get', 'name'], 'text-font': ['NotoSans-Medium'], 'text-size': ['interpolate', ['linear'], ['zoom'], 11, 9.5, 14, 12.5], 'text-letter-spacing': 0.12, 'text-max-width': 7 },
          paint: { 'text-color': css('--ink'), 'text-opacity': 0.75, 'text-halo-color': css('--land'), 'text-halo-width': 1.8 } },
      ],
    },
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  map.on('load', () => $('loading').remove());
  map.on('mouseenter', 'homes', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'homes', () => (map.getCanvas().style.cursor = ''));
  map.on('mouseenter', 'bldg', () => (map.getCanvas().style.cursor = 'pointer'));
  map.on('mouseleave', 'bldg', () => (map.getCanvas().style.cursor = ''));
  map.on('click', (e: any) => {
    if (map.getZoom() >= 15.2) {
      const b = map.queryRenderedFeatures(e.point, { layers: ['bldg'] })[0];
      if (b) return pickBuilding(b.properties.b);
    }
    const pad = 7;
    const hits = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers: ['homes'] });
    if (hits.length) {
      let best = hits[0], bd = Infinity;
      for (const h of hits) { const q = map.project(h.geometry.coordinates); const d = (q.x - e.point.x) ** 2 + (q.y - e.point.y) ** 2; if (d < bd) { bd = d; best = h; } }
      return pickParcel(best.properties.p, false);
    }
    const lot = map.queryRenderedFeatures(e.point, { layers: ['nohomes'] })[0];
    if (lot && map.getZoom() >= 14) return pickParcel(lot.properties.i, false);
    const hood = map.queryRenderedFeatures(e.point, { layers: ['hoods-hit'] })[0];
    if (hood) pickHood(hood.properties.name, false);
  });
}

function updateSelection() {
  if (!map?.getSource('sel')) return;
  const p = selected != null ? rows[selected].p : null;
  // The ring marks a parcel only when it has no building outline to highlight instead.
  const ring = p && p.lat != null && selectedBuilding == null;
  map.getSource('sel').setData({ type: 'FeatureCollection', features: ring ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p!.lng, p!.lat] } }] : [] });
  map.setFilter('hood-sel', ['==', ['get', 'name'], selectedHood ?? '']);
  map.setFilter('bldg-sel', ['==', ['get', 'b'], selectedBuilding ?? -1]);
}

/** A building: show its lot (the biggest one, by homes, when a stacked condo lot returns several). */
function pickBuilding(b: number) {
  const lots = bldg.buildings[b][0];
  if (!lots.length) return;
  const main = lots.reduce((a, c) => (rows[c].homes > rows[a].homes ? c : a), lots[0]);
  pickParcel(main, false, b);
  if (lots.length > 1) {
    const homes = lots.reduce((a, i) => a + rows[i].homes, 0);
    $('body').querySelector('.card')?.insertAdjacentHTML('beforeend', `<p class="small muted">This building sits on a lot shared by ${lots.length} parcels (${fmt(homes)} homes, e.g. condo units); showing the largest.</p>`);
  }
}

function pickParcel(i: number, fly: boolean, building: number | null = null) {
  selected = i; selectedHood = rows[i].p.neighborhood; selectedBuilding = building ?? buildingOf.get(i) ?? null;
  const p = rows[i].p;
  if (fly && p.lat != null) map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 17), speed: 1.6 });
  updateSelection(); renderParcel(i);
}

function pickHood(name: string, fly: boolean) {
  selectedHood = name; selected = null; selectedBuilding = null;
  if (fly) {
    const h = data.neighborhoods.find((x) => x.name === name);
    if (h) {
      const b = new maplibregl.LngLatBounds();
      for (const poly of h.polygons) for (const [x, y] of poly[0]) b.extend([x, y]);
      map.fitBounds(b, { padding: 40, maxZoom: 15.5 });
    }
  }
  updateSelection(); renderHood(name);
}

// ── address search ──────────────────────────────────────────────────────────────────────────────────────────────────
function wireSearch() {
  const q = $('q') as HTMLInputElement, sugg = $('sugg');
  // Searchable entries: each parcel's roll address, plus every other street address the state has on that lot.
  const entries: { label: string; lower: string; i: number; alias: boolean }[] = rows.map((r, i) => ({ label: r.p.address, lower: r.p.address.toLowerCase(), i, alias: false }));
  for (const [label, lots] of bldg.addresses) {
    const main = lots.reduce((a, c) => (rows[c].homes > rows[a].homes ? c : a), lots[0]);
    entries.push({ label, lower: label.toLowerCase(), i: main, alias: true });
  }
  let items: number[] = [], active = -1;
  const show = () => {
    sugg.innerHTML = items.map((e, n) => { const en = entries[e], p = rows[en.i].p; return `<li role="option" data-e="${e}" aria-selected="${n === active}">${esc(en.label)} <small>${en.alias ? `on the lot of ${esc(p.address)} · ` : ''}${esc(p.taxClassDesc)}${p.units ? ` · ${p.units} unit${p.units > 1 ? 's' : ''}` : ''} · ${esc(p.neighborhood ?? '')}</small></li>`; }).join('');
    q.setAttribute('aria-expanded', String(items.length > 0));
  };
  const pick = (e: number) => { items = []; show(); q.value = entries[e].label; q.blur(); pickParcel(entries[e].i, true); };
  q.addEventListener('input', () => {
    const v = normalizeQuery(q.value);
    active = -1;
    if (v.length < 2) { items = []; return show(); }
    const out: number[] = [];
    for (let e = 0; e < entries.length && out.length < 60; e++) if (entries[e].lower.startsWith(v) || entries[e].lower.includes(' ' + v)) out.push(e);
    const homes = (e: number) => (rows[entries[e].i].homes ? 0 : 1);
    items = out.sort((a, b) => homes(a) - homes(b) || entries[a].lower.length - entries[b].lower.length || entries[a].lower.localeCompare(entries[b].lower)).slice(0, 10);
    show();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); show(); e.preventDefault(); }
    else if (e.key === 'Enter' && items.length) { pick(items[Math.max(0, active)]); e.preventDefault(); }
    else if (e.key === 'Escape') { items = []; show(); }
  });
  sugg.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest('li'); if (li) pick(Number(li.dataset.e)); });
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  const [d, basemap, b] = await Promise.all([
    fetch('data.json').then((r) => r.json()), fetch('basemap.json').then((r) => r.json()), fetch('buildings.json').then((r) => r.json()),
  ]);
  data = d;
  bldg = b;
  const rules = data.rules;
  rows = data.rows.map((raw) => {
    const p = toParcel(data.cols, raw, data.dict);
    const c = classify(p, rules);
    return { p, c, ...slicesFor(p, c, rules) };
  });
  city = newTally();
  for (const r of rows) {
    add(city, r);
    const h = r.p.neighborhood ?? '—';
    if (!hoods.has(h)) hoods.set(h, newTally());
    add(hoods.get(h)!, r);
  }
  // Each parcel's largest building (by outline length as a size proxy), for highlighting after a search.
  const size = new Map<number, number>();
  bldg.buildings.forEach(([lots, q], i) => { for (const lot of lots) if (q.length > (size.get(lot) ?? 0)) { size.set(lot, q.length); buildingOf.set(lot, i); } });
  initMap(basemap);
  wireSearch();
  renderCity();
  $('maplegend').innerHTML = `<b style="font-weight:600">Each dot is one home</b>
    ${(['controlled', 'market', 'subsidized', 'owned', 'unclear'] as Cat[]).map((k) => `<div class="row"><span class="sw ${k}"></span>${LABEL[k]}</div>`).join('')}
    <div class="row"><span class="sw owned light"></span><span class="sw market light"></span>Lighter: probably (the owner seems to live there)</div>
    <div class="row"><span class="sw sq nohomes"></span>Lot with no homes (offices, shops, campuses, vacant)</div>
    <span class="muted">Zoom in to see buildings, colored by their result. Click one for details.</span>`;
  $('footer').innerHTML = `<p>${esc(rules.disclaimer)}</p>
    <p>Homes are the assessor’s legal units, placed at each parcel. Owner-occupancy comes from the city’s owner-occupied tax rate (as of 12/31/2024). The Census counts ${fmt(data.acs.housingUnits)} housing units and ${fmt(data.acs.renterOccupied)} renter households (${esc(data.acs.label)}), and about 29,600 owner-occupied homes, more than the tax rate shows, which is why owners who get their tax bill at the building are counted as probably living there.</p>
    <p>Not modeled: who actually lives in a home, unpermitted units, voucher holders (covered under the April text), short-term rentals, employee or transitional housing, an owner’s temporary absence, and the 20-year exemption for buildings built to prevailing-wage standards.</p>
    <p>Sources: Providence FY2026 tax roll, assessor building records (2024), building permits Dec 2016 – Sep 2026, HUD LIHTC / assisted / public housing / Section 8 contract lists, Providence Housing Authority sites, city GIS streets, parks and neighborhoods. Data fetched ${esc(data.fetched)}.</p>`;
}

boot().catch((err) => {
  $('loading').textContent = `Couldn’t load the map data (${err.message}). Reload the page to try again.`;
});
