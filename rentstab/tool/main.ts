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
type Cat = 'owned' | 'controlled' | 'market' | 'subsidized' | 'unclear';
const CATS: Cat[] = ['owned', 'controlled', 'market', 'subsidized', 'unclear'];
/** A parcel's homes, split by category and by whether the records settle it ("sure") or it's our best guess. */
interface Slice { cat: Cat; sure: boolean; n: number }
interface Row { p: Parcel; c: Classification; slices: Slice[]; homes: number }
interface Tally { homes: number; sure: Record<Cat, number>; likely: Record<Cat, number>; exemptBy: Map<string, number> }

const LABEL: Record<Cat, string> = { owned: 'Owner-occupied', controlled: 'Rent-stabilized', market: 'Exempt rental', subsidized: 'Already subsidized', unclear: "Can't tell" };
const HELP: Record<Cat, string> = {
  owned: "the owner's own home",
  controlled: 'rentals the 4% cap would reach',
  market: 'mostly small owner-occupied buildings and new construction',
  subsidized: 'rents already limited by a housing program',
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
      <h2>rental homes would have been rent-stabilized</h2>
      <p class="muted">That’s ${pct(t.sure.controlled, rentals(t))} of the city’s ${fmt(rentals(t))} rentals, and ${pct(t.sure.controlled, t.homes)} of all ${fmt(t.homes)} homes. ${fmt(t.sure.unclear)} more are in buildings the records can’t settle; it could reach ${fmt(upper)} if none of those, and none of the lighter homes, turn out exempt.</p>
    </section>
    ${bar(t, 'stack')}
    ${keyRows(t)}
    <section style="display:grid;gap:8px">
      <div class="sortbar"><h3 style="margin-right:auto">Neighborhoods</h3>
        <button type="button" data-sort="count" aria-pressed="${sortBy === 'count'}">Most stabilized</button>
        <button type="button" data-sort="share" aria-pressed="${sortBy === 'share'}">Highest share</button>
      </div>
      <p class="note">Each bar is all of a neighborhood’s homes: gray owners, then rentals.</p>
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
      <p>${pct(all(t, 'owned'), t.homes)} of homes are owner-occupied. Of the ${fmt(r)} rentals, <b>${pct(t.sure.controlled, r)}</b> would be rent-stabilized, ${pct(all(t, 'market'), r)} are exempt${topExempt ? ` (mostly: ${esc(topExempt[0].toLowerCase())})` : ''}, ${pct(t.sure.subsidized, r)} are already subsidized, and ${pct(t.sure.unclear, r)} can’t be settled from the records.</p>
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
  if (c.rule === 'public_and_subsidized_housing') cat = 'subsidized';
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
  $('back').addEventListener('click', () => { const h = p.neighborhood; selected = null; updateSelection(); h ? pickHood(h, false) : clearSelection(); });
}

function clearSelection() { selected = null; selectedHood = null; updateSelection(); renderCity(); }

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
      glyphs: `${base}fonts/{fontstack}/{range}.pbf`,
      sources: {
        water: { type: 'geojson', data: basemap.water }, parks: { type: 'geojson', data: basemap.parks },
        roads: { type: 'geojson', data: basemap.roads }, major: { type: 'geojson', data: basemap.major },
        hoods: { type: 'geojson', data: basemap.hoods }, hoodLabels: { type: 'geojson', data: basemap.hoodLabels },
        homes: { type: 'geojson', data: homePoints() },
        sel: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'land', type: 'background', paint: { 'background-color': css('--land') } },
        { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': '#D3E0E8' } },
        { id: 'parks', type: 'fill', source: 'parks', paint: { 'fill-color': '#E3E9D4' } },
        { id: 'hoods-hit', type: 'fill', source: 'hoods', paint: { 'fill-color': '#000', 'fill-opacity': 0 } },
        { id: 'roads', type: 'line', source: 'roads', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 12, 0.4, 15, 2.5, 17, 7, 19, 18] } },
        { id: 'major', type: 'line', source: 'major', layout: { 'line-cap': 'round', 'line-join': 'round' },
          paint: { 'line-color': '#FFFFFF', 'line-width': ['interpolate', ['exponential', 1.6], ['zoom'], 11, 1, 15, 4.5, 17, 11, 19, 26] } },
        { id: 'hoods-line', type: 'line', source: 'hoods', paint: { 'line-color': css('--ink'), 'line-opacity': ['interpolate', ['linear'], ['zoom'], 12, 0.35, 16, 0.15], 'line-width': 1, 'line-dasharray': [3, 2] } },
        { id: 'hood-sel', type: 'line', source: 'hoods', filter: ['==', ['get', 'name'], ''], paint: { 'line-color': css('--ink'), 'line-width': 2.2, 'line-opacity': 0.85 } },
        { id: 'homes', type: 'circle', source: 'homes',
          paint: {
            'circle-color': ['match', ['get', 'k'], 0, colors[0], 1, colors[1], 2, colors[2], 3, colors[3], colors[4]],
            'circle-opacity': ['case', ['==', ['get', 's'], 1], 0.9, 0.38],
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
  map.on('click', (e: any) => {
    const pad = 7;
    const hits = map.queryRenderedFeatures([[e.point.x - pad, e.point.y - pad], [e.point.x + pad, e.point.y + pad]], { layers: ['homes'] });
    if (hits.length) {
      let best = hits[0], bd = Infinity;
      for (const h of hits) { const q = map.project(h.geometry.coordinates); const d = (q.x - e.point.x) ** 2 + (q.y - e.point.y) ** 2; if (d < bd) { bd = d; best = h; } }
      return pickParcel(best.properties.p, false);
    }
    const hood = map.queryRenderedFeatures(e.point, { layers: ['hoods-hit'] })[0];
    if (hood) pickHood(hood.properties.name, false);
  });
}

function updateSelection() {
  if (!map?.getSource('sel')) return;
  const p = selected != null ? rows[selected].p : null;
  map.getSource('sel').setData({ type: 'FeatureCollection', features: p && p.lat != null ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [p.lng, p.lat] } }] : [] });
  map.setFilter('hood-sel', ['==', ['get', 'name'], selectedHood ?? '']);
}

function pickParcel(i: number, fly: boolean) {
  selected = i; selectedHood = rows[i].p.neighborhood;
  const p = rows[i].p;
  if (fly && p.lat != null) map.flyTo({ center: [p.lng, p.lat], zoom: Math.max(map.getZoom(), 17), speed: 1.6 });
  updateSelection(); renderParcel(i);
}

function pickHood(name: string, fly: boolean) {
  selectedHood = name; selected = null;
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
  const lower = rows.map((r) => r.p.address.toLowerCase());
  let items: number[] = [], active = -1;
  const show = () => {
    sugg.innerHTML = items.map((i, n) => { const p = rows[i].p; return `<li role="option" data-i="${i}" aria-selected="${n === active}">${esc(p.address)} <small>${esc(p.taxClassDesc)}${p.units ? ` · ${p.units} unit${p.units > 1 ? 's' : ''}` : ''} · ${esc(p.neighborhood ?? '')}</small></li>`; }).join('');
    q.setAttribute('aria-expanded', String(items.length > 0));
  };
  const pick = (i: number) => { items = []; show(); q.value = rows[i].p.address; q.blur(); pickParcel(i, true); };
  q.addEventListener('input', () => {
    const v = normalizeQuery(q.value);
    active = -1;
    if (v.length < 2) { items = []; return show(); }
    const out: number[] = [];
    for (let i = 0; i < lower.length && out.length < 40; i++) if (lower[i].startsWith(v) || lower[i].includes(' ' + v)) out.push(i);
    items = out.sort((a, b) => (rows[a].homes ? 0 : 1) - (rows[b].homes ? 0 : 1) || lower[a].length - lower[b].length || lower[a].localeCompare(lower[b])).slice(0, 10);
    show();
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); show(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); show(); e.preventDefault(); }
    else if (e.key === 'Enter' && items.length) { pick(items[Math.max(0, active)]); e.preventDefault(); }
    else if (e.key === 'Escape') { items = []; show(); }
  });
  sugg.addEventListener('click', (e) => { const li = (e.target as HTMLElement).closest('li'); if (li) pick(Number(li.dataset.i)); });
}

// ── boot ────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function boot() {
  const [d, basemap] = await Promise.all([fetch('data.json').then((r) => r.json()), fetch('basemap.json').then((r) => r.json())]);
  data = d;
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
  initMap(basemap);
  wireSearch();
  renderCity();
  $('maplegend').innerHTML = `<b style="font-weight:600">Each dot is one home</b>
    ${(['controlled', 'market', 'subsidized', 'owned', 'unclear'] as Cat[]).map((k) => `<div class="row"><span class="sw ${k}"></span>${LABEL[k]}</div>`).join('')}
    <div class="row"><span class="sw owned light"></span><span class="sw market light"></span>Lighter: probably (owner seems to live there)</div>`;
  $('footer').innerHTML = `<p>${esc(rules.disclaimer)}</p>
    <p>Homes are the assessor’s legal units, placed at each parcel. Owner-occupancy comes from the city’s owner-occupied tax rate (as of 12/31/2024). The Census counts ${fmt(data.acs.housingUnits)} housing units and ${fmt(data.acs.renterOccupied)} renter households (${esc(data.acs.label)}), and about 29,600 owner-occupied homes, more than the tax rate shows, which is why owners who get their tax bill at the building are counted as probably living there.</p>
    <p>Sources: Providence FY2026 tax roll, assessor building records (2024), building permits Dec 2016 – Mar 2024, HUD LIHTC / assisted / public housing lists, Providence Housing Authority sites, city GIS streets, parks and neighborhoods. Data fetched ${esc(data.fetched)}.</p>`;
}

boot().catch((err) => {
  $('loading').textContent = `Couldn’t load the map data (${err.message}). Reload the page to try again.`;
});
