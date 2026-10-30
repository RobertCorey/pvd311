// Rent Stabilization Builder: policy controls → classify every parcel in the browser → summary, map, tables, lookup.
import { classify, type Classification } from '../src/classify.ts';
import { normalizeQuery } from '../src/normalize.ts';
import { applyPolicy, mergePolicy, policyFromRules, type Policy, type Preset } from '../src/policy.ts';
import type { Rules, Status } from '../src/rules.ts';
import type { Parcel } from '../src/types.ts';
import { housingMix, MIX_KEYS, unitCounts, type Mix } from '../src/units.ts';

declare const L: any;

interface Hood { name: string; polygons: number[][][][] }
interface Data {
  generated: string; fetched: string; rules: Rules; presets: Preset[];
  acs: { label: string; housingUnits: number; renterOccupied: number; vacantForRent: number };
  neighborhoods: Hood[]; cols: string[]; rows: unknown[][]; dict: Record<string, unknown[]>;
}
type MixKey = (typeof MIX_KEYS)[number];
interface Result { c: Classification; mix: Mix; rental: number; rentalHigh: number }
interface Agg { mix: Record<MixKey, number> & { units: number }; rental: number; rentalHigh: number }

const MIX_LABEL: Record<MixKey, string> = {
  owned: 'Owner-occupied', controlled: 'Rent-stabilized', market: 'Market-rate rental', subsidized: 'Already subsidized', unclear: "Can't tell yet",
};
const MIX_HELP: Record<MixKey, string> = {
  owned: "the owner's own unit",
  controlled: 'rentals the 4% cap would reach',
  market: 'rentals the policy exempts',
  subsidized: 'rents already limited by a program',
  unclear: 'records can’t settle it',
};
const STATUS_LABEL: Record<Status, string> = {
  likely_covered: 'Likely rent-stabilized', likely_exempt: 'Likely exempt', cant_tell: "Can't tell", not_residential_rental: 'Not a rental',
};
const fmt = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : '–');
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
const $ = (id: string) => document.getElementById(id)!;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const isDesk = () => window.matchMedia('(min-width: 900px)').matches;

let data: Data;
let parcels: Parcel[] = [];
let baseRules: Rules;
let basePolicy: Policy;
let baseAgg: Agg;
let policy: Policy;
let rules: Rules;
let results: Result[] = [];
let hoodAgg = new Map<string, Agg>();
let selected: number | null = null;
let selectedHood: string | null = null;
let mapMode: 'hood' | 'dots' = 'hood';

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

function emptyAgg(): Agg { return { mix: { units: 0, owned: 0, controlled: 0, market: 0, subsidized: 0, unclear: 0 }, rental: 0, rentalHigh: 0 }; }
function addTo(a: Agg, r: Result) {
  for (const k of MIX_KEYS) a.mix[k] += r.mix[k];
  a.mix.units += r.mix.units; a.rental += r.rental; a.rentalHigh += r.rentalHigh;
}

function run(rs: Rules): Result[] {
  return parcels.map((p) => {
    const c = classify(p, rs);
    const u = unitCounts(p, c, rs);
    return { c, mix: housingMix(p, c, rs), rental: u.rental, rentalHigh: u.rentalIfOwnerAbsent };
  });
}

function aggregate(rs: Result[]): Agg { const a = emptyAgg(); for (const r of rs) addTo(a, r); return a; }

function recompute() {
  rules = applyPolicy(baseRules, policy);
  results = run(rules);
  hoodAgg = new Map();
  results.forEach((r, i) => {
    const h = parcels[i].neighborhood ?? '—';
    if (!hoodAgg.has(h)) hoodAgg.set(h, emptyAgg());
    addTo(hoodAgg.get(h)!, r);
  });
  renderSummary();
  renderMap();
  if (isDesk()) renderTables();
  renderDetail();
}

// ── controls ────────────────────────────────────────────────────────────────────────────────────────────────────────
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
function monthOptions(): [string, string][] {
  const out: [string, string][] = [];
  for (let y = 2027; y <= 2029; y++) for (let m = 1; m <= 12; m += 1) {
    const iso = `${y}-${String(m).padStart(2, '0')}-${m === 4 && y === 2027 ? '15' : '01'}`;
    out.push([iso, new Date(iso + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' })]);
  }
  return out;
}
const sel = (id: string, opts: [string | number, string][], value: unknown) =>
  `<select id="${id}">${opts.map(([v, t]) => `<option value="${v}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
const sw = (id: string, label: string, on: boolean) => `<label class="switch"><input type="checkbox" id="${id}"${on ? ' checked' : ''}><span></span>${esc(label)}</label>`;
const chk = (id: string, label: string, on: boolean) => `<label class="check"><input type="checkbox" id="${id}"${on ? ' checked' : ''}>${esc(label)}</label>`;

function presetMatch(): string {
  const same = (a: Policy, b: Policy) => JSON.stringify(a) === JSON.stringify(b);
  return data.presets.find((pr) => same(mergePolicy(basePolicy, pr.policy), policy))?.id ?? 'custom';
}

let railOpen = false;
function renderRail() {
  const p = policy;
  $('rail').classList.toggle('open', railOpen);
  const presetId = presetMatch();
  const preset = data.presets.find((x) => x.id === presetId);
  const ncLook: [string, string][] = [['0', 'none'], ['3', '3 years'], ['5', '5 years'], ['10', '10 years'], ['null', 'no limit']];
  $('rail').innerHTML = `
    <div class="group">
      <label for="preset" class="eyebrow">Start from</label>
      ${sel('preset', [...data.presets.map((x) => [x.id, x.label] as [string, string]), ...(presetId === 'custom' ? [['custom', 'Your changes'] as [string, string]] : [])], presetId)}
      <p class="preset-desc">${esc(preset?.description ?? 'Your own mix of exemptions.')}</p>
      ${presetId !== 'april_2026' ? '<button class="reset" id="reset" type="button">Back to the April 2026 ordinance</button>' : ''}
      <button class="more phone" id="more" type="button" aria-expanded="${railOpen}">${railOpen ? 'Hide the exemptions' : 'Change the exemptions'}</button>
    </div>

    <div class="group desk">
      <div class="row"><h3>Takes effect</h3>${sel('eff', monthOptions(), p.effectiveDate)}</div>
      <p class="help">Matters for new construction: the look-back counts back from this date.</p>
    </div>

    <div class="group${p.ownerOccupied.on ? '' : ' off'}">
      ${sw('oo', 'Owner-occupied buildings exempt', p.ownerOccupied.on)}
      <div class="inline">Buildings with up to ${sel('oo-units', range(1, 6).map((n) => [n, `${n} unit${n > 1 ? 's' : ''}`]), p.ownerOccupied.maxUnits)}</div>
      <span class="desk">${chk('oo-adu', 'Plus one accessory unit (ADU)', p.ownerOccupied.adu)}</span>
      <p class="help">The owner lives in one of the units. Uses the city’s owner-occupied tax rate.</p>
      <span class="cite">April text: 1–4 units + ADU · Sec. 13-78(n)</span>
    </div>

    <div class="group desk${p.additionalProperty.on ? '' : ' off'}">
      ${sw('ap', 'One extra property for owner-occupants', p.additionalProperty.on)}
      <div class="inline">If it has up to ${sel('ap-units', range(1, 6).map((n) => [n, `${n} unit${n > 1 ? 's' : ''}`]), p.additionalProperty.maxUnits)}</div>
      ${chk('ap-trust', 'Trust-owned property can’t qualify', p.additionalProperty.trustsExcluded)}
      <p class="help">Must be claimed with deeds, so the map never counts these as exempt; they show as “can’t tell”.</p>
      <span class="cite">April text: ≤4 units, trusts allowed · Sec. 13-78(n)</span>
    </div>

    <div class="group${p.newConstruction.on ? '' : ' off'}">
      ${sw('nc', 'New construction exempt', p.newConstruction.on)}
      <div class="inline">For ${sel('nc-years', [5, 10, 15, 20, 30].map((n) => [n, `${n} years`]), p.newConstruction.years)}</div>
      <div class="inline desk">Look-back ${sel('nc-look', ncLook, p.newConstruction.lookbackYears === null ? 'null' : p.newConstruction.lookbackYears)}</div>
      <p class="help">From the certificate of occupancy. Mill and office conversions count. The look-back reaches buildings finished before the law starts.</p>
      <span class="cite">April text: 10 years, 5-year look-back · Sec. 13-78(m)</span>
    </div>

    <div class="group">
      ${sw('aff', 'Subsidized and deed-restricted housing exempt', p.affordable)}
      <p class="help">Public housing, LIHTC, project-based Section 8. Voucher holders in private buildings stay covered.</p>
      <span class="cite">Sec. 13-78(i), (j)</span>
    </div>

    <div class="group alt">
      <span class="eyebrow">Other designs · not in the April text</span>
      <div class="${p.smallBuilding.on ? '' : 'off'}" style="display:grid;gap:6px">
        ${sw('sb', 'Exempt small buildings, any owner', p.smallBuilding.on)}
        <div class="inline">Up to ${sel('sb-units', range(1, 6).map((n) => [n, `${n} unit${n > 1 ? 's' : ''}`]), p.smallBuilding.maxUnits)}</div>
      </div>
      ${sw('sfc', 'Exempt single-family homes and condos', p.singleFamilyCondo)}
      <div class="${p.smallPortfolio.on ? '' : 'off'}" style="display:grid;gap:6px">
        ${sw('spf', 'Exempt small landlords', p.smallPortfolio.on)}
        <div class="inline">Owners with up to ${sel('spf-units', [1, 2, 3, 4, 6, 8, 10, 20].map((n) => [n, `${n} unit${n > 1 ? 's' : ''}`]), p.smallPortfolio.maxUnits)} in the city</div>
        <p class="help">Matched on owner names, so LLCs under different names aren’t linked.</p>
      </div>
    </div>`;
  wireRail();
}

function wireRail() {
  const num = (id: string) => Number(($(id) as HTMLSelectElement).value);
  const checked = (id: string) => ($(id) as HTMLInputElement).checked;
  const bind = (id: string, ev: string, fn: () => void) => { const el = document.getElementById(id); if (el) el.addEventListener(ev, () => { fn(); changed(); }); };
  bind('preset', 'change', () => {
    const pr = data.presets.find((x) => x.id === ($('preset') as HTMLSelectElement).value);
    if (pr) policy = mergePolicy(basePolicy, pr.policy);
  });
  bind('reset', 'click', () => { policy = structuredClone(basePolicy); });
  document.getElementById('more')?.addEventListener('click', () => { railOpen = !railOpen; renderRail(); document.getElementById('more')?.focus(); });
  bind('eff', 'change', () => { policy.effectiveDate = ($('eff') as HTMLSelectElement).value; });
  bind('oo', 'change', () => { policy.ownerOccupied.on = checked('oo'); });
  bind('oo-units', 'change', () => { policy.ownerOccupied.maxUnits = num('oo-units'); });
  bind('oo-adu', 'change', () => { policy.ownerOccupied.adu = checked('oo-adu'); });
  bind('ap', 'change', () => { policy.additionalProperty.on = checked('ap'); });
  bind('ap-units', 'change', () => { policy.additionalProperty.maxUnits = num('ap-units'); });
  bind('ap-trust', 'change', () => { policy.additionalProperty.trustsExcluded = checked('ap-trust'); });
  bind('nc', 'change', () => { policy.newConstruction.on = checked('nc'); });
  bind('nc-years', 'change', () => { policy.newConstruction.years = num('nc-years'); });
  bind('nc-look', 'change', () => { const v = ($('nc-look') as HTMLSelectElement).value; policy.newConstruction.lookbackYears = v === 'null' ? null : Number(v); });
  bind('aff', 'change', () => { policy.affordable = checked('aff'); });
  bind('sb', 'change', () => { policy.smallBuilding.on = checked('sb'); });
  bind('sb-units', 'change', () => { policy.smallBuilding.maxUnits = num('sb-units'); });
  bind('sfc', 'change', () => { policy.singleFamilyCondo = checked('sfc'); });
  bind('spf', 'change', () => { policy.smallPortfolio.on = checked('spf'); });
  bind('spf-units', 'change', () => { policy.smallPortfolio.maxUnits = num('spf-units'); });
}

let pending = 0;
function changed() {
  const focusId = document.activeElement?.id;
  renderRail();
  if (focusId) document.getElementById(focusId)?.focus();
  cancelAnimationFrame(pending);
  pending = requestAnimationFrame(recompute);
}

// ── summary ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function stackBar(m: Agg['mix'], cls = 'stack') {
  return `<div class="${cls}" aria-hidden="true">${MIX_KEYS.map((k) => `<i style="flex-grow:${m[k]};background:var(--${k})"></i>`).join('')}</div>`;
}

function renderSummary() {
  const a = aggregate(results);
  const d = a.mix.controlled - baseAgg.mix.controlled;
  const differs = presetMatch() !== 'april_2026';
  const rentals = a.mix.controlled + a.mix.market + a.mix.subsidized;
  $('summary').innerHTML = `
    <div class="headline">
      <span class="big">${fmt(a.mix.controlled)}</span>
      <h2>rental homes would be rent-stabilized</h2>
      ${differs ? `<span class="delta">${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))} vs. the April 2026 ordinance</span>` : ''}
    </div>
    <p class="muted">That’s ${pct(a.mix.controlled, rentals + a.mix.unclear)}–${pct(a.mix.controlled + a.mix.unclear, rentals + a.mix.unclear)} of rentals and ${pct(a.mix.controlled, a.mix.units)} of all ${fmt(a.mix.units)} homes on record. Another ${fmt(a.mix.unclear)} homes are in buildings the records can’t settle.</p>
    ${stackBar(a.mix)}
    <div class="legend">${MIX_KEYS.map((k) => `<div><span class="sw ${k}"></span><span><b>${fmt(a.mix[k])}</b> ${MIX_LABEL[k].toLowerCase()} <span class="muted desk">· ${MIX_HELP[k]}</span></span></div>`).join('')}</div>`;
}

// ── map ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
let map: any, hoodLayer: any, dotLayer: any;
const RAMP_MAX = 0.6;
const RAMP = ['#F3E9DA', '#F6CBB0', '#F6A882', '#F4865A', '#E5612E', '#BD3F12'];
const rampColor = (share: number) => RAMP[Math.min(RAMP.length - 1, Math.floor((share / RAMP_MAX) * RAMP.length))];

function initMap() {
  map = L.map('map', { zoomSnap: 0.25, attributionControl: false, zoomControl: false, minZoom: 11, maxZoom: 18 });
  L.control.zoom({ position: 'topright' }).addTo(map);
  const fc = { type: 'FeatureCollection', features: data.neighborhoods.map((h) => ({ type: 'Feature', properties: { name: h.name }, geometry: { type: 'MultiPolygon', coordinates: h.polygons } })) };
  hoodLayer = L.geoJSON(fc, {
    style: () => ({ weight: 1, color: css('--ink'), opacity: 0.35, fillOpacity: 0.9 }),
    onEachFeature: (f: any, layer: any) => {
      layer.on('click', () => { selectedHood = f.properties.name; selected = null; renderDetail(); renderMap(); });
      layer.on('mouseover', () => layer.setStyle({ weight: 2.5, opacity: 0.9 }));
      layer.on('mouseout', () => layer.setStyle({ weight: selectedHood === f.properties.name ? 2.5 : 1, opacity: selectedHood === f.properties.name ? 0.9 : 0.35 }));
    },
  }).addTo(map);
  map.fitBounds(hoodLayer.getBounds(), { padding: [10, 10] });
  map.setMaxBounds(hoodLayer.getBounds().pad(0.25));
  dotLayer = new (dotLayerClass())();
  $('mode-hood').addEventListener('click', () => setMode('hood'));
  $('mode-dots').addEventListener('click', () => setMode('dots'));
  map.on('click', (e: any) => {
    if (mapMode !== 'dots') return;
    const pt = map.latLngToContainerPoint(e.latlng);
    let best = -1, bestD = 12 * 12;
    parcels.forEach((p, i) => {
      if (p.lat == null || !results[i].mix.units) return;
      const q = map.latLngToContainerPoint([p.lat, p.lng]);
      const dd = (q.x - pt.x) ** 2 + (q.y - pt.y) ** 2;
      if (dd < bestD) { bestD = dd; best = i; }
    });
    if (best >= 0) { selected = best; renderDetail(); dotLayer.draw(); }
  });
}

function setMode(m: 'hood' | 'dots') {
  mapMode = m;
  $('mode-hood').setAttribute('aria-pressed', String(m === 'hood'));
  $('mode-dots').setAttribute('aria-pressed', String(m === 'dots'));
  if (m === 'dots') { dotLayer.addTo(map); hoodLayer.setStyle({ fillOpacity: 0, opacity: 0.5 }); }
  else { map.removeLayer(dotLayer); }
  renderMap();
}

/** Dominant bucket for a parcel's dot. */
function dotKind(r: Result): MixKey | null {
  if (!r.mix.units) return null;
  let best: MixKey = 'owned', v = -1;
  for (const k of MIX_KEYS) if (r.mix[k] > v) { v = r.mix[k]; best = k; }
  return best;
}

function dotLayerClass() {
  return L.Layer.extend({
    onAdd(this: any, m: any) {
      this._canvas = L.DomUtil.create('canvas', 'dots');
      this._canvas.style.pointerEvents = 'none';
      m.getPanes().overlayPane.appendChild(this._canvas);
      m.on('moveend zoomend resize viewreset', this.draw, this);
      m.on('zoomstart', this._hide, this);
      this.draw();
    },
    onRemove(this: any, m: any) {
      this._canvas.remove();
      m.off('moveend zoomend resize viewreset', this.draw, this);
      m.off('zoomstart', this._hide, this);
    },
    _hide(this: any) { this._canvas.style.visibility = 'hidden'; },
    draw(this: any) {
      const m = this._map; if (!m) return;
      const size = m.getSize(), dpr = Math.min(2, window.devicePixelRatio || 1);
      const cv = this._canvas as HTMLCanvasElement;
      cv.width = size.x * dpr; cv.height = size.y * dpr; cv.style.width = `${size.x}px`; cv.style.height = `${size.y}px`;
      L.DomUtil.setPosition(cv, m.containerPointToLayerPoint([0, 0]));
      cv.style.visibility = 'visible';
      const ctx = cv.getContext('2d')!;
      ctx.scale(dpr, dpr);
      const z = m.getZoom(), base = Math.max(1.2, (z - 11) * 0.9);
      const colors: Record<MixKey, string> = { owned: css('--owned'), controlled: css('--controlled'), market: css('--market'), subsidized: css('--subsidized'), unclear: css('--unclear') };
      const order: MixKey[] = ['owned', 'unclear', 'market', 'subsidized', 'controlled'];
      for (const k of order) {
        ctx.fillStyle = colors[k];
        ctx.globalAlpha = k === 'owned' ? 0.55 : 0.9;
        ctx.beginPath();
        parcels.forEach((p, i) => {
          if (p.lat == null || dotKind(results[i]) !== k) return;
          const q = m.latLngToContainerPoint([p.lat, p.lng]);
          if (q.x < -10 || q.y < -10 || q.x > size.x + 10 || q.y > size.y + 10) return;
          const rad = base * Math.sqrt(Math.min(results[i].mix.units, 200)) * 0.8 + 0.6;
          ctx.moveTo(q.x + rad, q.y); ctx.arc(q.x, q.y, rad, 0, Math.PI * 2);
        });
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      if (selected != null && parcels[selected].lat != null) {
        const q = m.latLngToContainerPoint([parcels[selected].lat, parcels[selected].lng]);
        ctx.strokeStyle = css('--ink'); ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(q.x, q.y, 9, 0, Math.PI * 2); ctx.stroke();
      }
    },
  });
}

function renderMap() {
  if (!map) return;
  if (mapMode === 'hood') {
    hoodLayer.eachLayer((layer: any) => {
      const name = layer.feature.properties.name;
      const a = hoodAgg.get(name);
      const share = a && a.mix.units ? a.mix.controlled / a.mix.units : 0;
      const on = selectedHood === name;
      layer.setStyle({ fillColor: rampColor(share), fillOpacity: 0.92, weight: on ? 2.5 : 1, opacity: on ? 0.9 : 0.35 });
      layer.unbindTooltip();
      if (isDesk()) layer.bindTooltip(`<b>${esc(name)}</b><br>${pct(a?.mix.controlled ?? 0, a?.mix.units ?? 0)} of homes rent-stabilized`, { sticky: true });
    });
    $('maplegend').innerHTML = `<span>Share of all homes rent-stabilized</span>
      <div class="ramp">${RAMP.map((c) => `<i style="background:${c}"></i>`).join('')}</div>
      <div class="ramplabels"><span>0%</span><span>30%</span><span>60%+</span></div>`;
  } else {
    dotLayer.draw();
    $('maplegend').innerHTML = `<span>Each dot is a parcel, sized by homes, colored by most of its homes</span>
      <div class="legend" style="grid-template-columns:repeat(3,auto)">${MIX_KEYS.map((k) => `<div><span class="sw ${k}"></span>${MIX_LABEL[k]}</div>`).join('')}</div>`;
  }
}

// ── detail panel (address result or neighborhood) ───────────────────────────────────────────────────────────────────
function mixRows(m: Agg['mix']) {
  return `<div class="legend" style="grid-template-columns:1fr">${MIX_KEYS.filter((k) => m[k]).map((k) => `<div><span class="sw ${k}"></span><span><b>${fmt(m[k])}</b> ${MIX_LABEL[k].toLowerCase()} · ${pct(m[k], m.units)}</span></div>`).join('')}</div>`;
}

function renderDetail() {
  const body = $('detailbody');
  if (selected != null) {
    const p = parcels[selected], r = results[selected];
    const subsidized = r.c.rule === 'public_and_subsidized_housing';
    let was = '';
    if (presetMatch() !== 'april_2026') {
      const before = classify(p, baseRules);
      if (before.status !== r.c.status) was = `<p class="was">Under the April 2026 ordinance: ${STATUS_LABEL[before.status]}.</p>`;
    }
    body.innerHTML = `
      <div><h2>${esc(p.address)}</h2><p class="muted small">${esc(p.neighborhood ?? '')} · ${esc(p.taxClassDesc)}${p.units ? ` · ${p.units} unit${p.units > 1 ? 's' : ''}` : ''}${p.yearBuilt ? ` · built ${p.yearBuilt}` : ''}</p></div>
      <p><span class="pill ${r.c.status}${subsidized ? ' subsidized' : ''}">${STATUS_LABEL[r.c.status]}</span></p>
      ${was}
      <ul>${r.c.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      ${r.c.confidence_notes.length ? `<details><summary>How sure is this?</summary><ul>${r.c.confidence_notes.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
      <p class="small muted">Seems wrong? You may know something the records don’t: who lives there, how many units it really has, or a subsidy.</p>`;
    return;
  }
  if (selectedHood) {
    const a = hoodAgg.get(selectedHood);
    if (a) {
      body.innerHTML = `<div><h2>${esc(selectedHood)}</h2><p class="muted small">${fmt(a.mix.units)} homes on record</p></div>
        <p><b class="num">${pct(a.mix.controlled, a.mix.units)}</b> of homes would be rent-stabilized.</p>
        ${stackBar(a.mix, 'minibar')}${mixRows(a.mix)}`;
      return;
    }
  }
  body.innerHTML = `<p class="muted small">${isDesk() ? 'Pick an address, a neighborhood, or a building on the map.' : 'Pick an address, or tap a neighborhood on the map.'}</p>`;
}

// ── tables (desktop) ────────────────────────────────────────────────────────────────────────────────────────────────
function renderTables() {
  const buckets = ['1', '2', '3', '4', '5', '6–10', '11–49', '50+'];
  const bucket = (u: number) => (u <= 5 ? String(u) : u <= 10 ? '6–10' : u <= 49 ? '11–49' : '50+');
  const bySize = new Map(buckets.map((b) => [b, emptyAgg()]));
  const byRule = new Map<string, { label: string; status: Status; units: number }>();
  results.forEach((r, i) => {
    if (!r.mix.units) return;
    addTo(bySize.get(bucket(r.mix.units))!, r);
    if (r.c.status === 'not_residential_rental') return;
    const key = `${r.c.status}|${r.c.rule}`;
    const rule = rules.rules.find((x) => x.id === r.c.rule);
    const e = byRule.get(key) ?? { label: rule?.label ?? r.c.rule, status: r.c.status, units: 0 };
    e.units += r.mix.controlled + r.mix.market + r.mix.subsidized + r.mix.unclear;
    byRule.set(key, e);
    void i;
  });
  const hoods = [...hoodAgg.entries()].filter(([n]) => n !== '—').sort((a, b) => b[1].mix.controlled / (b[1].mix.units || 1) - a[1].mix.controlled / (a[1].mix.units || 1));
  const ruleRows = [...byRule.values()].sort((a, b) => ['likely_covered', 'likely_exempt', 'cant_tell'].indexOf(a.status) - ['likely_covered', 'likely_exempt', 'cant_tell'].indexOf(b.status) || b.units - a.units);
  $('tables').innerHTML = `
    <div class="panel"><h3>By building size</h3><div class="tablewrap"><table>
      <thead><tr><th>Homes in building</th><th class="n">Homes</th><th class="n">Stabilized</th><th>Mix</th></tr></thead>
      <tbody>${buckets.map((b) => { const a = bySize.get(b)!; return `<tr><td>${b}</td><td class="n">${fmt(a.mix.units)}</td><td class="n">${pct(a.mix.controlled, a.mix.units)}</td><td class="bar">${stackBar(a.mix, 'minibar')}</td></tr>`; }).join('')}</tbody>
    </table></div></div>
    <div class="panel"><h3>By neighborhood</h3><div class="tablewrap"><table>
      <thead><tr><th>Neighborhood</th><th class="n">Homes</th><th class="n">Stabilized</th><th>Mix</th></tr></thead>
      <tbody>${hoods.map(([n, a]) => `<tr class="click" data-hood="${esc(n)}"><td>${esc(n)}</td><td class="n">${fmt(a.mix.units)}</td><td class="n">${pct(a.mix.controlled, a.mix.units)}</td><td class="bar">${stackBar(a.mix, 'minibar')}</td></tr>`).join('')}</tbody>
    </table></div></div>
    <div class="panel"><h3>Why rentals land where they do</h3><div class="tablewrap"><table>
      <thead><tr><th>Reason</th><th>Result</th><th class="n">Homes</th></tr></thead>
      <tbody>${ruleRows.map((e) => `<tr><td>${esc(e.label)}</td><td><span class="pill ${e.status}" style="font-size:11.5px;padding:1px 7px">${STATUS_LABEL[e.status]}</span></td><td class="n">${fmt(e.units)}</td></tr>`).join('')}</tbody>
    </table></div></div>`;
  $('tables').querySelectorAll<HTMLElement>('tr[data-hood]').forEach((tr) => tr.addEventListener('click', () => {
    selectedHood = tr.dataset.hood!; selected = null;
    hoodLayer.eachLayer((l: any) => { if (l.feature.properties.name === selectedHood) map.fitBounds(l.getBounds(), { padding: [30, 30] }); });
    renderMap(); renderDetail();
    $('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }));
}

// ── address lookup ──────────────────────────────────────────────────────────────────────────────────────────────────
function wireSearch() {
  const q = $('q') as HTMLInputElement, sugg = $('sugg');
  const lower = parcels.map((p) => p.address.toLowerCase());
  let items: number[] = [], active = -1;
  const show = () => {
    sugg.innerHTML = items.map((i, n) => `<li role="option" data-i="${i}" aria-selected="${n === active}">${esc(parcels[i].address)} <small>${esc(parcels[i].taxClassDesc)}${parcels[i].units ? ` · ${parcels[i].units} unit${parcels[i].units! > 1 ? 's' : ''}` : ''} · ${esc(parcels[i].neighborhood ?? '')}</small></li>`).join('');
    q.setAttribute('aria-expanded', String(items.length > 0));
  };
  const pick = (i: number) => {
    selected = i; selectedHood = null; items = []; show(); q.value = parcels[i].address;
    const p = parcels[i];
    if (p.lat != null) map.setView([p.lat, p.lng], Math.max(map.getZoom(), 16));
    renderDetail(); if (mapMode === 'dots') dotLayer.draw();
  };
  q.addEventListener('input', () => {
    const v = normalizeQuery(q.value);
    active = -1;
    if (v.length < 2) { items = []; return show(); }
    const out: number[] = [];
    for (let i = 0; i < lower.length && out.length < 40; i++) if (lower[i].startsWith(v) || lower[i].includes(' ' + v)) out.push(i);
    const resi = (i: number) => (results[i].mix.units ? 0 : 1);
    items = out.sort((a, b) => resi(a) - resi(b) || lower[a].length - lower[b].length || lower[a].localeCompare(lower[b])).slice(0, 10);
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
  data = await (await fetch('data.json')).json();
  parcels = data.rows.map((r) => toParcel(data.cols, r, data.dict));
  baseRules = data.rules;
  basePolicy = policyFromRules(baseRules);
  policy = structuredClone(basePolicy);
  baseAgg = aggregate(run(baseRules));
  renderRail();
  initMap();
  wireSearch();
  recompute();
  $('footer').innerHTML = `<p>${esc(data.rules.disclaimer)}</p>
    <p>Sources: Providence FY2026 tax roll (owner-occupied tax rate, assessment 12/31/2024), assessor building records (2024), building permits Dec 2016 – Mar 2024, HUD LIHTC / assisted housing / public housing lists, Providence Housing Authority sites. Data fetched ${esc(data.fetched)}.
    “Homes on record” are the assessor’s legal units (${fmt(aggregate(results).mix.units)}); the Census counts ${fmt(data.acs.housingUnits)} housing units and ${fmt(data.acs.renterOccupied)} renter households (${esc(data.acs.label)}).</p>`;
  let wasDesk = isDesk();
  window.addEventListener('resize', () => { if (isDesk() !== wasDesk) { wasDesk = isDesk(); renderRail(); recompute(); if (!wasDesk && mapMode === 'dots') setMode('hood'); map.invalidateSize(); } });
}

boot().catch((err) => {
  $('rail').innerHTML = `<p>Couldn’t load the parcel data (${esc(err.message)}). Reload the page to try again.</p>`;
});
