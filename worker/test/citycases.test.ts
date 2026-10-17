import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDetailHtml, parseGridRecord, pickDetailReads, syncCityCases, followUpCityCases } from '../src/citycases.js';
import type { Env, Store } from '../src/contracts.js';

// Captured from the live /public-requests/ grid and a row's detail form (2026-10-17); the plate is replaced.
const GRID = JSON.parse(readFileSync(new URL('./fixtures/city-grid-page.json', import.meta.url), 'utf8'));
const DETAIL = readFileSync(new URL('./fixtures/city-case-detail.html', import.meta.url), 'utf8');
const env = { PORTAL_BASE_URL: 'https://city.test' } as Env;

describe('parseGridRecord', () => {
  it('reads id, case type, street (the Value, not the empty FormattedValue), status and created time', () => {
    expect(parseGridRecord(GRID.Records[0])).toEqual({
      id: 'fa4943b8-08c8-f111-a3d0-001dd8050b66', caseType: 'Overflowing Dumpster', caseTypeId: '0e8e7734-cc3f-ef11-8409-001dd800f706',
      street: '481 Angell St', status: 'Resolved', createdAt: '2026-10-14T19:52:01.000Z',
    });
  });
});

describe('parseDetailHtml', () => {
  const d = parseDetailHtml(DETAIL);
  it('reads the public form fields', () => {
    expect(d.status).toBe('Assigned');
    expect(d.address).toBe('24 Ruggles St, Providence, RI, 02908, USA');
    expect(d.receivedOn).toBe('2026-10-16T12:58:18.0000000Z');
    expect(d.routedOn).toBe('2026-10-16T12:58:33.0000000Z');
    expect(d.resolution).toBeNull();
  });
  it('never stores the licence plate or landlord name, and skips the pre-checked "No" radios', () => {
    expect(JSON.stringify(d)).not.toContain('TEST123');
    expect(d.answers).not.toHaveProperty('cop_vehicledetails');
    expect(Object.values(d.answers)).not.toContain('Select');
    expect(d.answers).toEqual({});
  });
  it('reads a dropdown answer, a Yes radio and the resolution message', () => {
    const html = `<span id="statuscode" class="status">Resolved</span>
      <select id="cop_typeofanimal"><option value="">Select</option><option selected="selected" value="3">Raccoon</option></select>
      <input id="cop_presscharges_0" type="radio" value="0"><input id="cop_presscharges_1" type="radio" value="1" checked="checked">
      <input id="cop_nameandnumberoflandlord" type="text" value="Jane 401-555-0100">
      <textarea id="adx_resolution">Reported&#32;to&#32;HHS</textarea>`;
    const x = parseDetailHtml(html);
    expect(x.status).toBe('Resolved');
    expect(x.resolution).toBe('Reported to HHS');
    expect(x.answers).toEqual({ cop_typeofanimal: 'Raccoon', cop_presscharges: true });
  });
});

describe('pickDetailReads', () => {
  it('picks never-read cases and cases whose status moved, oldest first', () => {
    expect(pickDetailReads({
      a: { s: 'Assigned', ds: 'Assigned', c: '2026-10-10' },
      b: { s: 'Resolved', ds: 'Assigned', c: '2026-10-12' },
      c: { s: 'Submitted', c: '2026-10-11' },
    }, 5)).toEqual(['c', 'b']);
  });
});

function makeStore(meta: Record<string, any> = {}) {
  const cases: Record<string, Record<string, unknown>> = {};
  const store = {
    getMeta: vi.fn(async (k: string) => meta[k] ?? null),
    setMeta: vi.fn(async (k: string, v: Record<string, unknown>) => { meta[k] = { ...(meta[k] ?? {}), ...v }; }),
    patchCityCase: vi.fn(async (id: string, f: Record<string, unknown>) => { cases[id] = { ...(cases[id] ?? {}), ...f }; }),
    addEvent: vi.fn(async () => {}),
  } as unknown as Store;
  return { store, meta, cases };
}

describe('syncCityCases', () => {
  let calls: { url: string; method: string; body?: string }[];
  beforeEach(() => {
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
      if (url.endsWith('/_layout/tokenhtml')) return new Response('<input name="__RequestVerificationToken" type="hidden" value="tok" />', { headers: { 'set-cookie': 'sess=1; path=/' } });
      if (url.includes('entity-grid-data')) return Response.json(GRID);
      if (url.includes('modal-form-template-path')) return new Response(DETAIL);
      return new Response('nope', { status: 404 });
    }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('does nothing until the grid config has been captured', async () => {
    const { store } = makeStore();
    expect(await syncCityCases(env, store, { gapMs: 0 })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('stores every listed case, reads details once, and writes nothing on an unchanged second run', async () => {
    const { store, meta, cases } = makeStore({ cityGridConfig: { url: 'https://city.test/_services/entity-grid-data.json/v', body: { base64SecureConfiguration: 'cfg', page: 1, pageSize: 12 } } });
    const r1 = await syncCityCases(env, store, { gapMs: 0, now: Date.parse('2026-10-17T15:00:00Z') });
    expect(r1).toMatchObject({ listed: 3, added: 3, changed: 0, details: 3 });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(post.body!)).toMatchObject({ base64SecureConfiguration: 'cfg', page: 1, pageSize: 50 });
    const c = cases['fa4943b8-08c8-f111-a3d0-001dd8050b66'];
    expect(c).toMatchObject({ caseType: 'Overflowing Dumpster', street: '481 Angell St', firstSeenAt: '2026-10-17T15:00:00.000Z' });
    expect((c.detail as any).address).toContain('Ruggles'); // the fixture detail

    // Second run, same list: no case writes, no detail reads — one token GET + one list POST.
    const writes = (store.patchCityCase as any).mock.calls.length;
    calls = [];
    const r2 = await syncCityCases(env, store, { gapMs: 0, now: Date.parse('2026-10-17T15:30:00Z') });
    expect(r2).toMatchObject({ added: 0, changed: 0, details: 0, requests: 2 });
    expect((store.patchCityCase as any).mock.calls.length).toBe(writes);
    expect(Object.keys(meta.cityCasesIdx.cases)).toHaveLength(3);

    // A status change: one case write + one detail read for that case only.
    GRID.Records[1].Attributes.find((x: any) => x.Name === 'statuscode').FormattedValue = 'Resolved';
    const r3 = await syncCityCases(env, store, { gapMs: 0, now: Date.parse('2026-10-17T16:00:00Z') });
    GRID.Records[1].Attributes.find((x: any) => x.Name === 'statuscode').FormattedValue = 'In Progress';
    expect(r3).toMatchObject({ added: 0, changed: 1, details: 1 });
    expect(cases['ab400112-05c8-f111-a3d0-001dd804b975']).toMatchObject({ status: 'Resolved', 'statusSeen.Resolved': '2026-10-17T16:00:00.000Z' });
  });

  it('follows up open cases that left the window, once a day', async () => {
    const idx = { cases: {
      old: { s: 'Assigned', ds: 'Assigned', c: '2026-10-01T00:00:00Z', dc: '2026-10-15T00:00:00Z' },
      done: { s: 'Resolved', ds: 'Resolved', c: '2026-10-02T00:00:00Z' },
      fresh: { s: 'Assigned', ds: 'Assigned', c: '2026-10-16T00:00:00Z' },
    } };
    const { store, cases } = makeStore({ cityCasesIdx: idx });
    expect(await followUpCityCases(env, store, { gapMs: 0, now: Date.parse('2026-10-17T11:00:00Z') })).toBe(1);
    expect(Object.keys(cases)).toEqual(['old']);
    expect(cases.old).toEqual({ detail: expect.any(Object), detailAt: '2026-10-17T11:00:00.000Z' }); // the fixture form says Assigned: no status write
    expect(await followUpCityCases(env, store, { gapMs: 0, now: Date.parse('2026-10-17T12:00:00Z') })).toBe(0);
  });

  it('records a failure in health instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const { store } = makeStore({ cityGridConfig: { url: 'https://city.test/g', body: { base64SecureConfiguration: 'x' } } });
    expect(await syncCityCases(env, store, { gapMs: 0 })).toBeNull();
  });
});
