/**
 * server.ts — a Power-Pages-shaped mock of the Providence 311 portal.
 *
 * Serves exactly the DOM contract worker/src/portal.ts depends on so the REAL driver
 * (login → wizard → setControl → scout → submit → parseRow) runs end-to-end against
 * plain localhost HTTP with a real local Chromium and ZERO traffic to 311.providenceri.gov.
 *
 * Node built-in `http` only — no new dependencies. See ./README.md for the full contract.
 *
 * Pages
 *   GET  /SignIn                                   login form (#Username,#PasswordValue,#submit-signin-local)
 *   POST /SignIn                                   sets auth cookie, 302 → /
 *   GET  /                                         post-login landing (.username)
 *   GET  /my-requests/                             the [role=grid] My Requests grid (+ .username)
 *   GET  /my-requests/New-Request/                 Step 1 (STEP1_SELECTORS + honeypot + case-type modal)
 *   GET  /my-requests/New-Request/?stepid=step2&id Step 2 (#addressIn autocomplete + hidden cop_* + #EntityFormView_EntityID)
 *   GET  /my-requests/New-Request/?stepid=step3&id Step 3 (#description + per-case-type controls + #AttachFile + #NextButton)
 *   POST /my-requests/New-Request/                 wizard Next (Step 1 & 2 postbacks); creates/advances the draft entity
 *   POST /submit                                   AJAX submit; echoes a fake PVD2026-##### and pushes the grid row
 *   GET  /my-requests/New-Request/confirmation     confirmation page (driver ignores it; it re-scrapes the grid)
 * Controls (for the mutation suite)
 *   GET  /_sim/reset                               reset state to the golden seed
 *   GET  /_sim/mutate?name=...&from=...&to=...      arm a drift/fault mutation
 *   GET  /_sim/state                               JSON snapshot (submitPosts, casesCreated, step1Posts, step2Posts, mutations, cases)
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CATEGORIES } from '../../../shared/categories.js';

const HERE = dirname(fileURLToPath(import.meta.url)); // worker/test/sim
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const CENSUS_PATH = resolve(REPO_ROOT, 'scripts', 'case-type-census-2026-08-21.json');

interface CaseType { id: string; name: string }
const CENSUS: CaseType[] = JSON.parse(readFileSync(CENSUS_PATH, 'utf8')).caseTypes;
const GUID_TO_NAME = new Map(CENSUS.map((c) => [c.id, c.name.trim()]));
const GUID_TO_CATEGORY = new Map<string, string>();
for (const [key, cfg] of Object.entries(CATEGORIES)) GUID_TO_CATEGORY.set(cfg.portalCaseTypeGuid, key);

/**
 * A My Requests grid row. In the real portal the PVD number is assigned when the DRAFT is created
 * (Step 1), but the grid only *renders* it once the draft converts (submit) — a Draft row shows no
 * PVD, only its `data-id` entity GUID. `pvd` holds the assigned number for the conversion; it is shown
 * in the title cell only when status !== 'Draft'. (The number is separately readable while Draft via
 * /my-requests/Edit-Request/?id=<GUID> → input#title, which is what readDraftCaseId scrapes.)
 */
interface GridRow { pvd: string; caseType: string; street: string; status: string; createdOn: string; entityId: string }
interface WizardSession { entityId: string; caseTypeGuid: string; requestType: string; method: string; step: 2 | 3; address: string; caseId: string }
interface Mutation { name: string; params: Record<string, string> }

interface SimState {
  cases: GridRow[];
  sessions: Map<string, WizardSession>;
  mutations: Map<string, Mutation>;
  submitPosts: number;
  casesCreated: number;
  step1Posts: number;
  step2Posts: number;
  signInPosts: number;
  caseSeq: number;
  entitySeq: number;
}

/** Golden seed for the My Requests grid: a Draft row (no PVD shown; keyed by GUID) + a converted-draft
 *  (now Submitted) row + one Assigned. */
function seedCases(): GridRow[] {
  return [
    { pvd: 'PVD2026-00100', caseType: 'Pothole Report', street: '10 Elm St', status: 'Draft', createdOn: '8/20/2026 9:15 AM', entityId: 'seed-draft-0001' },
    { pvd: 'PVD2026-00099', caseType: 'Missed Trash Day Pick-up Issue', street: '22 Oak St', status: 'Submitted', createdOn: '8/19/2026 2:03 PM', entityId: 'seed-sub-0002' },
    { pvd: 'PVD2026-00098', caseType: 'Report Street Light Issue', street: '5 Pine St', status: 'Assigned', createdOn: '8/18/2026 11:30 AM', entityId: 'seed-asg-0003' },
  ];
}

function freshState(): SimState {
  return {
    cases: seedCases(),
    sessions: new Map(),
    mutations: new Map(),
    submitPosts: 0,
    casesCreated: 0,
    step1Posts: 0,
    step2Posts: 0,
    signInPosts: 0,
    caseSeq: 12000,
    entitySeq: 1,
  };
}

// ── HTML helpers ────────────────────────────────────────────────────────────
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
}

/** The anti-bot honeypot present on every wizard form (random id per page). Never filled by the driver. */
function honeypot(): string {
  const id = 'frm_pref_' + Math.random().toString(36).slice(2, 10);
  return `<div class="form-group honeypot"><label for="${id}">Leave this field blank</label>` +
    `<input type="text" id="${id}" name="${id}" aria-label="Leave this field blank" autocomplete="off" tabindex="-1"></div>`;
}

function signInHtml(): string {
  return page('Sign In', `
    <h1>Providence 311 — Sign In</h1>
    <form method="POST" action="/SignIn">
      <label for="Username">Email</label>
      <input type="text" id="Username" name="Username">
      <label for="PasswordValue">Password</label>
      <input type="password" id="PasswordValue" name="PasswordValue">
      <button type="submit" id="submit-signin-local">Sign in</button>
    </form>`);
}

function rootHtml(authed: boolean): string {
  const user = authed ? `<div class="username">test@pvdsnow.org</div>` : '';
  return page('Home', `${user}<h1>Providence Home</h1><a href="/my-requests/">My Requests</a>`);
}

function step1Html(): string {
  // Embed the census so the modal can emit .modal.in table tbody tr[data-id] rows without a network call.
  const census = JSON.stringify(CENSUS.map((c) => ({ id: c.id, name: c.name.trim() })));
  return page('New Request — Step 1', `
    <div class="username">test@pvdsnow.org</div>
    <h1>New Request — Step 1 of 3</h1>
    <form id="step1form" method="POST" action="/my-requests/New-Request/">
      <input type="hidden" name="__step" value="1">
      <input type="hidden" id="cop_casetype_guid" name="caseTypeGuid" value="">
      <div class="form-group">
        <label for="casetypecode">Request Type</label>
        <select id="casetypecode" name="casetypecode">
          <option value="">Select</option>
          <option value="1">Question</option>
          <option value="2">Problem</option>
          <option value="3">Request</option>
          <option value="585680001">Comment</option>
        </select>
      </div>
      <div class="form-group">
        <label id="ctLabel">Choose an Issue (Case Type)</label>
        <button type="button" class="launchentitylookup" aria-label="Choose an Issue (Case Type) Launch lookup modal">Choose an Issue</button>
        <span id="ctChosen"></span>
      </div>
      <div class="form-group">
        <label for="cop_methodofupdate">How should we contact you?</label>
        <select id="cop_methodofupdate" name="cop_methodofupdate">
          <option value="">Select</option>
          <option value="585680002">Email</option>
          <option value="585680000">Phone</option>
          <option value="585680001">Text</option>
          <option value="585680003">No Contact Necessary</option>
          <option value="585680004">Portal Comment</option>
        </select>
      </div>
      ${honeypot()}
      <input type="button" id="NextButton" value="Next" onclick="document.getElementById('step1form').submit()">
    </form>
    <div id="modalMount"></div>
    <script>window.__CENSUS = ${census};</script>
    <script>${STEP1_MODAL_JS}</script>`);
}

// Client-side modal logic. Uses string concatenation (no backticks / no ${}) so the server template
// literal does not interpolate it.
const STEP1_MODAL_JS = `
(function(){
  var selectedId = null;
  function renderRows(tbody, list){
    tbody.innerHTML = '';
    list.forEach(function(ct){
      var tr = document.createElement('tr');
      tr.setAttribute('data-id', ct.id);
      tr.setAttribute('data-entity', 'incident');
      tr.setAttribute('data-name', ct.name);
      var tdCheck = document.createElement('td');
      var span = document.createElement('span');
      span.setAttribute('role','checkbox');
      span.setAttribute('aria-checked','false');
      span.textContent = '\\u2610';
      span.style.display = 'inline-block';
      span.style.width = '18px';
      span.style.height = '18px';
      span.style.border = '1px solid #333';
      span.style.cursor = 'pointer';
      span.addEventListener('click', function(){
        selectedId = ct.id;
        var all = tbody.querySelectorAll('span[role=checkbox]');
        for (var i=0;i<all.length;i++){ all[i].setAttribute('aria-checked','false'); }
        span.setAttribute('aria-checked','true');
      });
      tdCheck.appendChild(span);
      var tdName = document.createElement('td');
      tdName.textContent = ct.name;
      tr.appendChild(tdCheck); tr.appendChild(tdName);
      tbody.appendChild(tr);
    });
  }
  function openModal(){
    var mount = document.getElementById('modalMount');
    var modal = document.createElement('div');
    modal.className = 'modal fade modal-lookup in';
    modal.innerHTML =
      '<div class="modal-dialog"><div class="modal-content">' +
      '<input type="text" class="query form-control" aria-label="To search on partial text, use the asterisk (*) wildcard character.">' +
      '<button type="button" class="btn btn-default btn-hg" aria-label="Search Results">Search</button>' +
      '<table><thead><tr><th></th><th>Name</th></tr></thead><tbody class="ctRows"></tbody></table>' +
      '<button type="button" class="cancel btn btn-default" aria-label="Cancel">Cancel</button>' +
      '<button type="button" class="primary btn btn-primary" aria-label="Select">Select</button>' +
      '</div></div>';
    mount.appendChild(modal);
    var tbody = modal.querySelector('.ctRows');
    renderRows(tbody, window.__CENSUS);
    modal.querySelector('[aria-label="Search Results"]').addEventListener('click', function(){
      var q = (modal.querySelector('.query.form-control').value || '').replace(/\\*/g,'').trim().toLowerCase();
      var list = q ? window.__CENSUS.filter(function(c){ return c.name.toLowerCase().indexOf(q) !== -1; }) : window.__CENSUS;
      renderRows(tbody, list);
    });
    modal.querySelector('[aria-label="Cancel"]').addEventListener('click', function(){ mount.removeChild(modal); });
    modal.querySelector('[aria-label="Select"]').addEventListener('click', function(){
      if (selectedId){
        document.getElementById('cop_casetype_guid').value = selectedId;
        var nm = ''; for (var i=0;i<window.__CENSUS.length;i++){ if (window.__CENSUS[i].id===selectedId){ nm = window.__CENSUS[i].name; break; } }
        document.getElementById('ctChosen').textContent = nm;
      }
      mount.removeChild(modal);
    });
  }
  var btn = document.querySelector('button.launchentitylookup');
  if (btn) btn.addEventListener('click', openModal);
})();
`;

function step2Html(entityId: string): string {
  return page('New Request — Step 2', `
    <div class="username">test@pvdsnow.org</div>
    <h1>New Request — Step 2 of 3</h1>
    <form id="step2form" method="POST" action="/my-requests/New-Request/">
      <input type="hidden" name="__step" value="2">
      <input type="hidden" name="id" value="${esc(entityId)}">
      <input type="hidden" id="EntityFormView_EntityID" value="${esc(entityId)}">
      <input type="hidden" id="EntityFormView_EntityName" value="incident">
      <div class="form-group">
        <label for="addressIn">Address</label>
        <input type="text" id="addressIn" class="addressIn" autocomplete="off">
      </div>
      <input type="hidden" id="cop_address" name="cop_address">
      <input type="hidden" id="cop_street1" name="cop_street1">
      <input type="hidden" id="cop_city" name="cop_city">
      <input type="hidden" id="cop_stateorprovidence" name="cop_stateorprovidence">
      <input type="hidden" id="cop_zipofpostalcode" name="cop_zipofpostalcode">
      <input type="hidden" id="cop_countryorregion" name="cop_countryorregion">
      <input type="hidden" id="cop_latitude" name="cop_latitude">
      <input type="hidden" id="cop_longitude" name="cop_longitude">
      <table class="addressSuggest"><tbody id="suggestBody"></tbody></table>
      <input type="button" id="NextButton" value="Next" onclick="document.getElementById('step2form').submit()">
    </form>
    <script>${STEP2_AUTOCOMPLETE_JS}</script>`);
}

const STEP2_AUTOCOMPLETE_JS = `
(function(){
  var input = document.getElementById('addressIn');
  var body = document.getElementById('suggestBody');
  if (!input || !body) return;
  input.addEventListener('input', function(){
    var v = input.value || '';
    body.innerHTML = '';
    if (v.length < 3) return;
    var tr = document.createElement('tr');
    tr.className = 'suggestRow';
    var td = document.createElement('td');
    td.className = 'suggestData';
    td.textContent = v + ', Providence, RI 02903';
    tr.appendChild(td);
    td.addEventListener('click', function(){
      input.value = td.textContent;
      document.getElementById('cop_address').value = td.textContent;
      document.getElementById('cop_street1').value = v;
      document.getElementById('cop_city').value = 'Providence';
      document.getElementById('cop_stateorprovidence').value = 'RI';
      document.getElementById('cop_zipofpostalcode').value = '02903';
      document.getElementById('cop_countryorregion').value = 'USA';
      body.innerHTML = '';
    });
    body.appendChild(tr);
  });
})();
`;

function readFixture(category: string | null): string {
  if (!category) return '';
  const p = resolve(HERE, 'fixtures', 'step3', category + '.html');
  return existsSync(p) ? readFileSync(p, 'utf8') : '';
}

function applyStep3Mutations(fixture: string, state: SimState): string {
  let html = fixture;
  const rename = state.mutations.get('rename-control');
  if (rename) {
    const from = rename.params.from || 'cop_size';
    const to = rename.params.to || from + '_renamed';
    html = html.split(`id="${from}"`).join(`id="${to}"`);
  }
  const relabel = state.mutations.get('change-label');
  if (relabel) {
    const from = relabel.params.from || 'Other';
    const to = relabel.params.to || 'Different';
    html = html.split(`aria-label="${from}"`).join(`aria-label="${to}"`);
  }
  if (state.mutations.has('add-required')) {
    html += `
      <div class="form-group">
        <label for="cop_unexpected">Unexpected new required field</label>
        <select id="cop_unexpected" required aria-required="true" aria-label="Unexpected new required field">
          <option value="">Select</option>
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </select>
      </div>`;
  }
  return html;
}

/**
 * A Step-3 control the portal renders on EVERY case type but hides (display:none) unless applicable —
 * a miniature of the ~43 shared inputs whose visibility toggles per case type on the real portal.
 * collectStep3Controls captures it with visible:false; fillStep3 never fills a hidden control. It is
 * unmapped by every category, so if it were ever shown it would be caught as unmapped — proof the
 * canary watches the shared set, not just each case type's visible field.
 */
const SHARED_HIDDEN_STEP3_CONTROL = `
      <div class="form-group" style="display:none" aria-hidden="true">
        <label for="cop_priorcaseref">Related prior case reference</label>
        <input type="text" id="cop_priorcaseref" name="ctl00$ContentContainer$cop_priorcaseref"
               aria-label="Related prior case reference" style="display:none" />
      </div>`;

function step3Html(session: WizardSession, state: SimState): string {
  const category = GUID_TO_CATEGORY.get(session.caseTypeGuid) ?? null;
  const controls = applyStep3Mutations(readFixture(category), state);
  const nextBtn = state.mutations.has('drop-next')
    ? '<!-- #NextButton dropped by mutation -->'
    : `<input type="button" id="NextButton" value="Submit" class="btn btn-primary button next submit-btn">`;
  return page('New Request — Step 3', `
    <div class="username">test@pvdsnow.org</div>
    <h1>New Request — Step 3 of 3</h1>
    <form id="step3form">
      <input type="hidden" id="EntityFormView_EntityID" value="${esc(session.entityId)}">
      <input type="hidden" id="EntityFormView_EntityName" value="incident">
      <input type="hidden" id="EntityFormView_EntityStatus" value="585680001">
      <div class="form-group">
        <label for="description">Description</label>
        <textarea id="description" name="ctl00$ContentContainer$description" aria-label="Description"></textarea>
      </div>
      ${controls}
      ${SHARED_HIDDEN_STEP3_CONTROL}
      ${honeypot()}
      <div class="form-group">
        <label for="AttachFile">Attach a photo</label>
        <input type="file" id="AttachFile" name="AttachFile" accept="*/*," multiple>
      </div>
      ${nextBtn}
      <div class="validation-summary-errors" style="display:none"></div>
    </form>
    <script>${STEP3_SUBMIT_JS}</script>`);
}

const STEP3_SUBMIT_JS = `
(function(){
  var btn = document.getElementById('NextButton');
  if (!btn) return;
  btn.addEventListener('click', function(){
    var entityId = (document.getElementById('EntityFormView_EntityID') || {}).value || '';
    fetch('/submit', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ entityId: entityId }) })
      .then(function(r){ if (r.status !== 200) throw new Error('status ' + r.status); return r.json(); })
      .then(function(j){ window.location.href = '/my-requests/New-Request/confirmation?case=' + encodeURIComponent(j.caseId || ''); })
      .catch(function(){
        var v = document.querySelector('.validation-summary-errors');
        if (v){ v.style.display = 'block'; v.textContent = 'There was a problem submitting your request. Please review the form.'; }
        btn.value = 'Submit';
      });
  });
})();
`;

function myRequestsUnauthedHtml(): string {
  // No .username element → the driver treats this as "not logged in" and goes to /SignIn.
  return page('My Requests', `<h1>Please sign in</h1><a href="/SignIn">Sign in</a>`);
}

function gridRowHtml(r: GridRow): string {
  // Draft rows render NO PVD number (only the entity GUID via data-id), matching the live grid; the
  // number appears in the title only once the draft converts. This is why the driver keys drafts by GUID.
  const isDraft = /^draft$/i.test(r.status);
  const title = isDraft ? `Draft — ${esc(r.caseType)}` : `${esc(r.pvd)} ${esc(r.caseType)}`;
  return `<div role="row" data-id="${esc(r.entityId)}">
    <span role="gridcell">${title}</span>
    <span role="gridcell">${esc(r.street)}</span>
    <span role="gridcell">${esc(r.status)}</span>
    <span role="gridcell">${esc(r.createdOn)}</span>
    <span role="gridcell">Action Menu</span>
  </div>`;
}

function myRequestsGridHtml(cases: GridRow[]): string {
  const rows = cases.map(gridRowHtml).join('\n');
  return page('My Requests', `
    <div class="username">test@pvdsnow.org</div>
    <h1>My Requests</h1>
    <div class="entitylist">
      <div role="grid" aria-label="My Requests">
        <div role="row">
          <span role="columnheader">Request</span>
          <span role="columnheader">Street</span>
          <span role="columnheader">Status Reason</span>
          <span role="columnheader">Created On</span>
          <span role="columnheader">Actions</span>
        </div>
        ${rows}
      </div>
      <nav class="pagination"><ul>
        <li class="disabled"><a aria-label="Next" rel="next">Next</a></li>
      </ul></nav>
    </div>`);
}

function confirmationHtml(caseId: string): string {
  return page('Request Submitted', `
    <div class="username">test@pvdsnow.org</div>
    <h1>Thank you — your request was submitted</h1>
    <p class="case-number">${caseId ? esc(caseId) : 'Reference pending'}</p>`);
}

/**
 * Edit-Request view of an existing draft. Unlike the running New-Request wizard, this page prints the
 * PVD number the portal assigned at draft creation, in input#title — exactly what readDraftCaseId()
 * scrapes from a side tab. Read-only here; creates nothing.
 */
function editRequestHtml(session: WizardSession): string {
  const caseType = GUID_TO_NAME.get(session.caseTypeGuid) || 'Service Request';
  return page('Edit Request', `
    <div class="username">test@pvdsnow.org</div>
    <h1>Edit Request</h1>
    <form id="editform">
      <input type="hidden" id="EntityFormView_EntityID" value="${esc(session.entityId)}">
      <label for="title">Case</label>
      <input type="text" id="title" name="title" value="${esc(session.caseId + ' ' + caseType)}" readonly>
    </form>`);
}

// ── request plumbing ────────────────────────────────────────────────────────
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => res(data));
  });
}
function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
  res.end(body);
}
function json(res: ServerResponse, status: number, obj: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

export interface Sim {
  url: string; // e.g. http://127.0.0.1:49152 (no trailing slash) — use as PORTAL_BASE_URL
  port: number;
  close(): Promise<void>;
  reset(): void;
  mutate(name: string, params?: Record<string, string>): void;
  snapshot(): { submitPosts: number; casesCreated: number; step1Posts: number; step2Posts: number; signInPosts: number; mutations: string[]; cases: GridRow[] };
}

export async function startSim(): Promise<Sim> {
  let state = freshState();

  const nextCaseId = () => `PVD2026-${String(state.caseSeq++).padStart(5, '0')}`;
  const nextEntityId = () => `entity-${String(state.entitySeq++).padStart(4, '0')}-${Math.random().toString(16).slice(2, 8)}`;

  const server: Server = createServer(async (req, res) => {
    try {
      const base = `http://${req.headers.host || '127.0.0.1'}`;
      const u = new URL(req.url || '/', base);
      const path = u.pathname;
      const authed = cookies(req).sim_auth === '1';

      // ── sim controls ──
      if (path === '/_sim/reset') { state = freshState(); return json(res, 200, { ok: true }); }
      if (path === '/_sim/state') {
        return json(res, 200, {
          submitPosts: state.submitPosts, casesCreated: state.casesCreated,
          step1Posts: state.step1Posts, step2Posts: state.step2Posts, signInPosts: state.signInPosts,
          mutations: [...state.mutations.keys()], cases: state.cases,
        });
      }
      if (path === '/_sim/mutate') {
        const name = u.searchParams.get('name') || '';
        const params: Record<string, string> = {};
        u.searchParams.forEach((v, k) => { if (k !== 'name') params[k] = v; });
        if (name) state.mutations.set(name, { name, params });
        return json(res, 200, { ok: true, mutations: [...state.mutations.keys()] });
      }

      // ── auth ──
      if (path === '/SignIn' && req.method === 'POST') {
        await readBody(req);
        state.signInPosts++;
        return send(res, 302, '', { 'set-cookie': 'sim_auth=1; Path=/', location: '/' });
      }
      if (path === '/SignIn') return send(res, 200, signInHtml());
      if (path === '/') return send(res, 200, rootHtml(authed));

      // ── My Requests grid ──
      if (path === '/my-requests/' || path === '/my-requests') {
        return send(res, 200, authed ? myRequestsGridHtml(state.cases) : myRequestsUnauthedHtml());
      }

      // ── Edit-Request (draft view that exposes the assigned PVD in input#title) ──
      if (path === '/my-requests/Edit-Request/' || path === '/my-requests/Edit-Request') {
        if (!authed) return send(res, 200, myRequestsUnauthedHtml());
        const s = state.sessions.get(u.searchParams.get('id') || '');
        if (!s) return send(res, 404, page('No draft', '<h1>Draft not found</h1>'));
        return send(res, 200, editRequestHtml(s));
      }

      // ── wizard ──
      if (path === '/my-requests/New-Request/confirmation') {
        return send(res, 200, confirmationHtml(u.searchParams.get('case') || ''));
      }
      if (path === '/my-requests/New-Request/' || path === '/my-requests/New-Request') {
        if (req.method === 'POST') {
          const body = new URLSearchParams(await readBody(req));
          const step = body.get('__step');
          if (step === '1') {
            // Draft creation assigns the PVD number (visible via Edit-Request, not the wizard) and drops
            // a Draft row into My Requests (rendered without the number; keyed by its entity GUID).
            const entityId = nextEntityId();
            const caseTypeGuid = body.get('caseTypeGuid') || CATEGORIES.pothole.portalCaseTypeGuid;
            const caseId = nextCaseId();
            state.sessions.set(entityId, {
              entityId, caseTypeGuid,
              requestType: body.get('casetypecode') || '2',
              method: body.get('cop_methodofupdate') || '',
              step: 3, address: '', caseId,
            });
            state.cases.unshift({
              pvd: caseId, caseType: GUID_TO_NAME.get(caseTypeGuid) || 'Service Request',
              street: '', status: 'Draft', createdOn: '8/22/2026 2:55 PM', entityId,
            });
            state.step1Posts++;
            return send(res, 302, '', { location: `/my-requests/New-Request/?stepid=step2&id=${entityId}` });
          }
          if (step === '2') {
            const id = body.get('id') || '';
            const s = state.sessions.get(id);
            const street = body.get('cop_street1') || body.get('cop_address') || '';
            if (s) s.step = 3;
            if (s) s.address = street;
            const row = state.cases.find((c) => c.entityId === id);
            if (row && street) row.street = street;
            state.step2Posts++;
            return send(res, 302, '', { location: `/my-requests/New-Request/?stepid=step3&id=${id}` });
          }
          return send(res, 400, page('Bad step', '<h1>Bad wizard step</h1>'));
        }
        // GET
        if (!authed) return send(res, 200, myRequestsUnauthedHtml());
        const stepid = u.searchParams.get('stepid');
        const id = u.searchParams.get('id') || '';
        if (stepid === 'step2') {
          if (!state.sessions.has(id)) return send(res, 404, page('No draft', '<h1>Draft not found</h1>'));
          return send(res, 200, step2Html(id));
        }
        if (stepid === 'step3') {
          const s = state.sessions.get(id);
          if (!s) return send(res, 404, page('No draft', '<h1>Draft not found</h1>'));
          return send(res, 200, step3Html(s, state));
        }
        return send(res, 200, step1Html());
      }

      // ── submit (AJAX) ──
      if (path === '/submit' && req.method === 'POST') {
        const raw = await readBody(req);
        let entityId = '';
        try { entityId = JSON.parse(raw || '{}').entityId || ''; } catch { /* ignore */ }
        state.submitPosts++;
        const session = state.sessions.get(entityId);
        const row = state.cases.find((c) => c.entityId === entityId);

        if (state.mutations.has('submit-500')) {
          return json(res, 500, { error: 'internal error' });
        }
        if (state.mutations.has('dup-case')) {
          // Portal accepted the click but the draft never converted (a duplicate / no-op): its grid row
          // stays Draft, so it renders no PVD number and extractCaseId() (candidate branch) can't confirm.
          return json(res, 200, { caseId: '' });
        }
        // Normal path: the draft converts — its grid row flips Draft → Submitted and now shows the PVD.
        if (row) { row.status = 'Submitted'; if (session?.address) row.street = session.address; }
        state.casesCreated++;
        if (session) state.sessions.delete(entityId); // draft consumed
        return json(res, 200, { caseId: session?.caseId || row?.pvd || '' });
      }

      return send(res, 404, page('Not found', `<h1>404</h1><p>${esc(path)}</p>`));
    } catch (err) {
      json(res, 500, { error: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: () => new Promise<void>((r) => server.close(() => r())),
    reset: () => { state = freshState(); },
    mutate: (name, params = {}) => state.mutations.set(name, { name, params }),
    snapshot: () => ({
      submitPosts: state.submitPosts, casesCreated: state.casesCreated,
      step1Posts: state.step1Posts, step2Posts: state.step2Posts, signInPosts: state.signInPosts,
      mutations: [...state.mutations.keys()], cases: state.cases.slice(),
    }),
  };
}
