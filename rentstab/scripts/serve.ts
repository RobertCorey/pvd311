// Bare local lookup page (slice-1 stretch): address autocomplete → status + reasons + disclaimer.
// `npm run serve` → http://localhost:4173 (binds 0.0.0.0; PORT env overrides). Needs data/parcels.sqlite.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { classify } from '../src/classify.ts';
import { DB_PATH, rowToParcel } from '../src/db.ts';
import { loadRules } from '../src/rules.ts';

const rules = loadRules(join(import.meta.dirname, '..', 'rules', 'ordinance-2026-04.yaml'));
const db = new DatabaseSync(DB_PATH, { readOnly: true });
const search = db.prepare(`
  SELECT id, address, neighborhood, taxClassDesc, units FROM parcels
  WHERE address LIKE ? ESCAPE '\\' OR address LIKE ? ESCAPE '\\'
  ORDER BY (taxClass IN ('1','2','23','04-05U','03-610','03-11+','04-610','04-11+','12')) DESC, length(address), address, id
  LIMIT 12`);
const byId = db.prepare('SELECT * FROM parcels WHERE id = ?');

const PAGE = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rent Stabilization Lookup</title>
<style>
  :root { --bg:#fff; --fg:#1a1a1a; --muted:#666; --line:#ddd; --cov:#b42318; --ex:#067647; --ct:#b54708; --nr:#475467; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111; --fg:#eee; --muted:#aaa; --line:#333; } }
  body { background:var(--bg); color:var(--fg); font:16px/1.45 system-ui, sans-serif; max-width:680px; margin:0 auto; padding:16px; }
  input { width:100%; box-sizing:border-box; font:inherit; padding:10px; border:1px solid var(--line); border-radius:6px; background:var(--bg); color:var(--fg); }
  ul#sugg { list-style:none; margin:4px 0 0; padding:0; border:1px solid var(--line); border-radius:6px; }
  ul#sugg:empty { display:none; }
  #sugg li { padding:8px 10px; cursor:pointer; border-top:1px solid var(--line); } #sugg li:first-child { border-top:0; }
  #sugg li:hover, #sugg li.on { background:rgba(127,127,127,.15); }
  #sugg small, .muted { color:var(--muted); }
  .status { display:inline-block; font-weight:700; padding:2px 8px; border-radius:4px; color:#fff; }
  .likely_covered { background:var(--cov); } .likely_exempt { background:var(--ex); } .cant_tell { background:var(--ct); } .not_residential_rental { background:var(--nr); }
  .disclaimer { border-top:1px solid var(--line); margin-top:24px; padding-top:12px; font-size:14px; color:var(--muted); }
  li { margin:4px 0; }
</style></head><body>
<h1>Would my apartment be covered?</h1>
<p class="muted">Providence Rent Stabilization Act as passed April 2026 (vetoed). Type a Providence street address.</p>
<input id="q" placeholder="e.g. 135 Brook St" autocomplete="off" autofocus>
<ul id="sugg"></ul>
<div id="out"></div>
<p class="disclaimer" id="disc"></p>
<script>
const LABEL = { likely_covered:'Likely covered', likely_exempt:'Likely exempt', cant_tell:"Can't tell", not_residential_rental:'Not a residential rental' };
const q = document.getElementById('q'), sugg = document.getElementById('sugg'), out = document.getElementById('out');
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
let t;
q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
  const v = q.value.trim(); if (v.length < 2) { sugg.innerHTML = ''; return; }
  const rows = await (await fetch('/api/search?q=' + encodeURIComponent(v))).json();
  sugg.innerHTML = rows.map((r) => '<li data-id="' + esc(r.id) + '">' + esc(r.address) + ' <small>' + esc(r.taxClassDesc) + (r.units ? ' · ' + r.units + ' unit' + (r.units === 1 ? '' : 's') : '') + ' · ' + esc(r.neighborhood ?? '') + ' · ' + esc(r.id) + '</small></li>').join('');
}, 150); });
sugg.addEventListener('click', (e) => { const li = e.target.closest('li'); if (li) show(li.dataset.id); });
async function show(id) {
  sugg.innerHTML = '';
  const r = await (await fetch('/api/classify?id=' + encodeURIComponent(id))).json();
  q.value = r.parcel.address;
  out.innerHTML = '<h2>' + esc(r.parcel.address) + ' <small class="muted">' + esc(r.parcel.id) + '</small></h2>'
    + '<p><span class="status ' + r.result.status + '">' + LABEL[r.result.status] + '</span></p>'
    + '<h3>Why</h3><ul>' + r.result.reasons.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>'
    + (r.result.confidence_notes.length ? '<h3>How sure</h3><ul>' + r.result.confidence_notes.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '')
    + '<p class="muted">This seems wrong? You may know something the records don\\'t: who lives in the building, how many units it really has, or a subsidy. This page is a data test and doesn\\'t take corrections yet.</p>';
  history.replaceState(null, '', '?id=' + encodeURIComponent(id));
}
fetch('/api/meta').then((r) => r.json()).then((m) => { document.getElementById('disc').textContent = m.disclaimer; });
const pre = new URLSearchParams(location.search).get('id'); if (pre) show(pre);
</script></body></html>`;

const json = (res: any, code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(PAGE); }
  if (url.pathname === '/api/meta') return json(res, 200, { disclaimer: rules.disclaimer, rules: rules.id, effective: rules.assumed_effective_date });
  if (url.pathname === '/api/search') {
    const q = (url.searchParams.get('q') ?? '').trim().replace(/[\\%_]/g, (c) => '\\' + c);
    return json(res, 200, q.length < 2 ? [] : search.all(`${q}%`, `% ${q}%`)); // "135 Brook" or just "Brook" 
  }
  if (url.pathname === '/api/classify') {
    const row = byId.get(url.searchParams.get('id') ?? '') as Record<string, any> | undefined;
    if (!row) return json(res, 404, { error: 'no such parcel' });
    const parcel = rowToParcel(row);
    return json(res, 200, { parcel: { id: parcel.id, address: parcel.address, neighborhood: parcel.neighborhood }, result: classify(parcel, rules) });
  }
  json(res, 404, { error: 'not found' });
}).listen(Number(process.env.PORT ?? 4173), '0.0.0.0', () => console.log(`lookup page on http://0.0.0.0:${process.env.PORT ?? 4173}`));
