import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseDetailHtml, parseGridRecord, pickDetailReads, syncCityCases, followUpCityCases, backfillCityCaseGeo, notifyCityFollowers } from '../src/citycases.js';
import type { Env, Mailer, Store, UserDoc } from '../src/contracts.js';

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
    expect(d.address).toBe('10 Example St, Providence, RI, 02908, USA');
    expect(d.receivedOn).toBe('2026-10-16T12:58:18.0000000Z');
    expect(d.routedOn).toBe('2026-10-16T12:58:33.0000000Z');
    expect(d.resolution).toBeNull();
  });
  it('keeps the licence plate with its form label, and skips the pre-checked "No" radios and empty dropdowns', () => {
    expect(d.answers).toEqual({ cop_vehicledetails: 'TEST123' });
    expect(d.labels).toEqual({ cop_vehicledetails: 'Vehicle Details' });
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
    expect(x.answers).toEqual({ cop_typeofanimal: 'Raccoon', cop_presscharges: true, cop_nameandnumberoflandlord: 'Jane 401-555-0100' });
  });
});

describe('pickDetailReads', () => {
  it('picks never-read cases and cases whose status moved, oldest first', () => {
    expect(pickDetailReads({
      a: { s: 'Assigned', ds: 'Assigned', c: '2026-10-10', dv: 2 },
      d: { s: 'Assigned', ds: 'Assigned', c: '2026-10-09' }, // read by the v1 parser
      b: { s: 'Resolved', ds: 'Assigned', c: '2026-10-12' },
      c: { s: 'Submitted', c: '2026-10-11' },
    }, 5)).toEqual(['d', 'c', 'b']);
  });
});

function makeStore(meta: Record<string, any> = {}, users: Record<string, UserDoc> = {}) {
  const cases: Record<string, Record<string, unknown>> = {};
  const store = {
    getMeta: vi.fn(async (k: string) => meta[k] ?? null),
    setMeta: vi.fn(async (k: string, v: Record<string, unknown>) => { meta[k] = { ...(meta[k] ?? {}), ...v }; }),
    patchCityCase: vi.fn(async (id: string, f: Record<string, unknown>) => { cases[id] = { ...(cases[id] ?? {}), ...f }; }),
    getCityCase: vi.fn(async (id: string) => (cases[id] ? { ...cases[id], id } : null)),
    getUser: vi.fn(async (uid: string) => users[uid] ?? null),
    addEvent: vi.fn(async () => {}),
    listStreetWatchUsers: vi.fn(async () => Object.values(users).filter((u) => u.prefs?.streetWatch === true)),
    findReportsByOwner: vi.fn(async () => []),
  } as unknown as Store;
  return { store, meta, cases };
}

/** A follower account; `cityFollowing` names the case(s) it follows (cityfollow.eligibleFollowers checks the list too). */
const follower = (uid: string, cityFollowing: string[], o: Partial<UserDoc> = {}): UserDoc => ({
  uid, email: `${uid}@example.com`, emailVerified: true, displayName: null, provider: 'google', createdAt: '2026-10-01T00:00:00Z', lastSeenAt: '2026-10-01T00:00:00Z',
  prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing, ...o,
});
function mockMailer() {
  const sent: { to: string; subject: string; html: string; kind?: string; caseId?: string | null }[] = [];
  const mailer = { sendTo: vi.fn(async (to: string, subject: string, html: string, o?: { kind?: string; caseId?: string | null }) => { sent.push({ to, subject, html, kind: o?.kind, caseId: o?.caseId }); }) } as unknown as Mailer;
  return { mailer, sent };
}

/** The city over plain HTTP: token page, grid, detail forms (per case when `detailFor` is given), ArcGIS. */
function stubCity(calls: { url: string; method: string; body?: string }[], detailFor: (id: string | null) => string = () => DETAIL) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body as string | undefined });
    if (url.endsWith('/_layout/tokenhtml')) return new Response('<input name="__RequestVerificationToken" type="hidden" value="tok" />', { headers: { 'set-cookie': 'sess=1; path=/' } });
    if (url.includes('entity-grid-data')) return Response.json(GRID);
    if (url.includes('modal-form-template-path')) return new Response(detailFor(new URL(url).searchParams.get('id')));
    if (url.includes('geocode.arcgis.com')) return Response.json({ candidates: [{ location: { x: -71.4005, y: 41.8282 }, score: 100 }] });
    if (url.startsWith('https://push.test/')) return new Response(null, { status: 201 }); // a phone's push service (streetwatch)
    return new Response('nope', { status: 404 });
  }));
}

describe('syncCityCases', () => {
  let calls: { url: string; method: string; body?: string }[];
  beforeEach(() => { calls = []; stubCity(calls); });
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
    expect((c.detail as any).address).toContain('Example St'); // the fixture detail
    // Each street is geocoded once (meta/geo_* cache + `g` in the index) so "My street" can find the case.
    expect(c).toMatchObject({ lat: 41.8282, lng: -71.4005 });
    expect(calls.filter((x) => x.url.includes('geocode.arcgis.com'))).toHaveLength(3);
    expect(Object.keys(meta).filter((k) => k.startsWith('geo_'))).toHaveLength(3);

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

  it('a followed open case outlives the 60-day index prune and keeps its daily re-read; one nobody follows leaves on time', async () => {
    const now = Date.parse('2026-10-17T11:00:00Z');
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const idx = { cases: {
      kept: { s: 'Assigned', ds: 'Assigned', c: ago(61), dc: ago(2) },
      dropped: { s: 'Assigned', ds: 'Assigned', c: ago(61), dc: ago(2) },
      soon: { s: 'Assigned', ds: 'Assigned', c: ago(58), dc: ago(0.5) },  // inside the 3-day lead: flagged now, before the sync's prune could reach it
      young: { s: 'Assigned', ds: 'Assigned', c: ago(20), dc: ago(0.5) }, // far from the prune: no doc read
    } };
    const { store, meta, cases } = makeStore({ cityCasesIdx: idx }, { u: follower('u', ['kept', 'soon']) });
    cases.kept = { caseType: 'Sidewalk', street: '1 Main St', status: 'Assigned', followerUids: ['u'] };
    cases.dropped = { caseType: 'Pothole', street: '2 Main St', status: 'Assigned', followerUids: [] };
    cases.soon = { caseType: 'Tree', street: '3 Main St', status: 'Assigned', followerUids: ['u'] };
    expect(await followUpCityCases(env, store, { gapMs: 0, now })).toBe(2); // kept + dropped were due (soon/young read their detail recently)
    expect((store.getCityCase as any).mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['dropped', 'kept', 'soon']);
    expect(meta.cityCasesIdx.cases.kept).toMatchObject({ f: 1, dc: '2026-10-17T11:00:00.000Z' });
    expect(meta.cityCasesIdx.cases.soon).toMatchObject({ f: 1 });
    expect(meta.cityCasesIdx.cases.dropped).toBeUndefined();
    expect(meta.cityCasesIdx.cases.young).toEqual(idx.cases.young);
    // Next day: still in the index, still due (with soon and young, whose last read is now a day old); everyone
    // unfollowed → the flag clears and the prune takes it after that day's read.
    expect(await followUpCityCases(env, store, { gapMs: 0, now: now + 86_400_000 })).toBe(3);
    expect(meta.cityCasesIdx.cases.kept).toMatchObject({ f: 1 });
    cases.kept.followerUids = [];
    expect(await followUpCityCases(env, store, { gapMs: 0, now: now + 2 * 86_400_000 })).toBe(3);
    expect(meta.cityCasesIdx.cases.kept).toBeUndefined();
    expect(Object.keys(meta.cityCasesIdx.cases).sort()).toEqual(['soon', 'young']);
  });

  it('records a failure in health instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const { store } = makeStore({ cityGridConfig: { url: 'https://city.test/g', body: { base64SecureConfiguration: 'x' } } });
    expect(await syncCityCases(env, store, { gapMs: 0 })).toBeNull();
  });

  describe('followers (cityfollow.ts)', () => {
    const ID = 'ab400112-05c8-f111-a3d0-001dd804b975'; // GRID.Records[1]
    const row = parseGridRecord(GRID.Records[1])!;
    const cfg = { cityGridConfig: { url: 'https://city.test/_services/entity-grid-data.json/v', body: { base64SecureConfiguration: 'cfg' } } };
    const T = (h: string) => Date.parse(`2026-10-17T${h}:00:00Z`);
    const statusAttr = () => GRID.Records[1].Attributes.find((x: any) => x.Name === 'statuscode');

    it('a status change on a followed case mails each eligible follower once, with the Resolution Message from the same run, then never again for that status', async () => {
      const users = {
        on: follower('on', [ID]), off: follower('off', [ID], { prefs: { emailUpdates: false } }), unverified: follower('unverified', [ID], { emailVerified: false }),
        stale: follower('stale', []), // fell off a full list: the case still names it, its list does not
      };
      const { store, cases } = makeStore(cfg, users);
      const { mailer, sent } = mockMailer();
      const r1 = await syncCityCases(env, store, { gapMs: 0, now: T('15'), mailer }); // first sight of every case: nobody follows anything yet
      expect(r1).toMatchObject({ added: 3, changed: 0, mails: 0 });
      cases[ID].followerUids = ['on', 'off', 'unverified', 'stale', 'gone'];

      // The city closes it; its detail form now carries a Resolution Message.
      stubCity(calls, (id) => (id === ID ? DETAIL + '<textarea id="adx_resolution">Light fixed</textarea>' : DETAIL));
      const orig = statusAttr().FormattedValue;
      statusAttr().FormattedValue = 'Resolved';
      try {
        const r2 = await syncCityCases(env, store, { gapMs: 0, now: T('16'), mailer });
        expect(r2).toMatchObject({ changed: 1, details: 1, mails: 1 });
        expect(sent).toEqual([{ to: 'on@example.com', subject: `City update: ${row.caseType} on ${row.street} — Resolved`, html: expect.any(String), kind: 'city_follow', caseId: ID }]);
        expect(sent[0].html).toContain(`<b>${row.status}</b> → <b>Resolved</b>`);
        expect(sent[0].html).toContain('Light fixed');
        expect(sent[0].html).toContain(`href="https://fixmypvd.org/street?case=${ID}&amp;lat=41.82820&amp;lng=-71.40050"`);
        expect(cases[ID]).toMatchObject({ status: 'Resolved', notifiedStatus: 'Resolved' });

        // Same status next run: nothing changed, nothing mailed; even a forced re-check of that change is a no-op.
        const r3 = await syncCityCases(env, store, { gapMs: 0, now: T('17'), mailer });
        expect(r3).toMatchObject({ changed: 0, mails: 0 });
        expect(await notifyCityFollowers(env, store, mailer, [{ id: ID, from: row.status, to: 'Resolved' }])).toBe(0);
        expect(sent).toHaveLength(1);
      } finally { statusAttr().FormattedValue = orig; }
    });

    it('a change nobody follows writes no notifiedStatus; without a mailer nothing is sent; a broken user read never breaks the sync', async () => {
      const { store, cases } = makeStore(cfg, { u: follower('u', [ID]) });
      await syncCityCases(env, store, { gapMs: 0, now: T('15') });
      const orig = statusAttr().FormattedValue;
      statusAttr().FormattedValue = 'Resolved';
      try {
        expect(await syncCityCases(env, store, { gapMs: 0, now: T('16') })).toMatchObject({ changed: 1, mails: 0 }); // no followers, no mailer
        expect(cases[ID].notifiedStatus).toBeUndefined();
        statusAttr().FormattedValue = 'Assigned';
        cases[ID].followerUids = ['u'];
        (store.getUser as any).mockImplementationOnce(async () => { throw new Error('users down'); });
        const { mailer, sent } = mockMailer();
        expect(await syncCityCases(env, store, { gapMs: 0, now: T('17'), mailer })).toMatchObject({ changed: 1, mails: 0 });
        expect(sent).toHaveLength(0);
        expect(cases[ID]).toMatchObject({ status: 'Assigned', notifiedStatus: 'Assigned' }); // the move counts as handled: no run repeats it
      } finally { statusAttr().FormattedValue = orig; }
    });

    it('the daily follow-up: a detail read that moves an out-of-window case mails its followers the same way', async () => {
      const idx = { cases: { old: { s: 'Submitted', ds: 'Submitted', c: '2026-10-01T00:00:00Z', dc: '2026-10-15T00:00:00Z' } } };
      const { store, cases } = makeStore({ cityCasesIdx: idx }, { u: follower('u', ['old']) });
      cases.old = { caseType: 'Pothole', street: '1 Main St', status: 'Submitted', createdAt: '2026-10-01T00:00:00.000Z', followerUids: ['u'], lat: null, lng: null };
      const { mailer, sent } = mockMailer();
      expect(await followUpCityCases(env, store, { gapMs: 0, now: Date.parse('2026-10-17T11:00:00Z'), mailer })).toBe(1); // the fixture form says Assigned
      expect(cases.old).toMatchObject({ status: 'Assigned', notifiedStatus: 'Assigned' });
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: 'u@example.com', subject: 'City update: Pothole on 1 Main St — Assigned', kind: 'city_follow', caseId: 'old' });
      expect(sent[0].html).toContain('<b>Submitted</b> → <b>Assigned</b>');
      expect(sent[0].html).toContain('href="https://fixmypvd.org/street?case=old"'); // unlocated: no lat/lng
    });
  });
});

describe('street watch (streetwatch.ts)', () => {
  // A fresh meta object per store: makeStore writes the index into the object it is given.
  const cfg = () => ({ cityGridConfig: { url: 'https://city.test/_services/entity-grid-data.json/v', body: { base64SecureConfiguration: 'cfg' } } });
  // The fixture's three rows were created 23:20–23:52 UTC on 2026-10-14; the ArcGIS stub puts every street at Angell/Thayer.
  const NEWEST = 1792007521000;
  const push = { endpoint: 'https://push.test/1', p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg', ua: 'test', createdAt: '2026-10-01T00:00:00.000Z' };
  const watcher = (uid: string, o: Partial<UserDoc> = {}) => follower(uid, [], { prefs: { emailUpdates: true, streetWatch: true }, addresses: [{ id: 'h', label: 'Home', address: '12 Angell St', lat: 41.8282, lng: -71.4005 }], push: [push], ...o });
  let calls: { url: string; method: string; body?: string }[];
  beforeEach(() => { calls = []; stubCity(calls); });
  afterEach(() => vi.unstubAllGlobals());

  it('a new located case near a watching account\'s address is one push to that phone, in the same sync; nothing for the same cases next run', async () => {
    const { store } = makeStore(cfg(), {
      w: watcher('w'),
      nopush: watcher('nopush', { push: [] }),                                   // the pref without a subscription: nothing
      far: watcher('far', { addresses: [{ id: 'f', label: 'Far', address: '1 Far Rd', lat: 41.84, lng: -71.41 }] }),
    });
    const r1 = await syncCityCases(env, store, { gapMs: 0, now: NEWEST + 3_600_000 }); // the three cases are 1 h – 1 h 31 min old
    expect(r1).toMatchObject({ added: 3, watchPushed: 3 });
    const pushes = calls.filter((c) => c.url.startsWith('https://push.test/'));
    expect(pushes).toHaveLength(3);
    expect(pushes.every((c) => c.url === 'https://push.test/1' && c.method === 'POST')).toBe(true);
    expect((store.listStreetWatchUsers as any).mock.calls).toHaveLength(1);
    const ev = (store.addEvent as any).mock.calls.map((c: any[]) => c[0]).find((e: any) => e.kind === 'watch.pushed');
    expect(ev).toMatchObject({ data: { cases: 3, users: 3, hits: 3, pushed: 3, accounts: 1 } });

    calls.length = 0; // keep the reference the fetch stub records into
    const r2 = await syncCityCases(env, store, { gapMs: 0, now: NEWEST + 5_400_000 }); // nothing new: no users read, no push
    expect(r2).toMatchObject({ added: 0, watchPushed: 0 });
    expect(calls.filter((c) => c.url.startsWith('https://push.test/'))).toHaveLength(0);
    expect((store.listStreetWatchUsers as any).mock.calls).toHaveLength(1);
  });

  it('cases first seen more than two hours after the city created them push nothing (a backfill or an outage), and the account\'s own filing is skipped', async () => {
    const late = makeStore(cfg(), { w: watcher('w') });
    expect(await syncCityCases(env, late.store, { gapMs: 0, now: NEWEST + 3 * 3_600_000 })).toMatchObject({ added: 3, watchPushed: 0 });
    expect(calls.filter((c) => c.url.startsWith('https://push.test/'))).toHaveLength(0);
    expect(late.store.listStreetWatchUsers).not.toHaveBeenCalled();

    calls.length = 0; // keep the reference the fetch stub records into
    const own = makeStore(cfg(), { w: watcher('w') });
    (own.store.findReportsByOwner as any).mockImplementation(async () => [{ id: 'mine', portalEntityId: 'ab400112-05c8-f111-a3d0-001dd804b975' }]); // GRID.Records[1]
    expect(await syncCityCases(env, own.store, { gapMs: 0, now: NEWEST + 3_600_000 })).toMatchObject({ added: 3, watchPushed: 2 });
    expect(calls.filter((c) => c.url.startsWith('https://push.test/'))).toHaveLength(2);
  });

  it('a filing listed as Draft mid-wizard pushes nothing (no users read); the run that first lists it Submitted pushes it once, from the cached geocode; the run after pushes nothing', async () => {
    const statusAttrs = GRID.Records.map((rec: any) => rec.Attributes.find((x: any) => x.Name === 'statuscode'));
    const orig = statusAttrs.map((a: any) => a.FormattedValue);
    for (const a of statusAttrs) a.FormattedValue = 'Draft';
    try {
      const { store, cases, meta } = makeStore(cfg(), { w: watcher('w') });
      const r1 = await syncCityCases(env, store, { gapMs: 0, now: NEWEST + 1_800_000 }); // three Drafts, all under 2 h old
      expect(r1).toMatchObject({ added: 3, changed: 0, watchPushed: 0 });
      expect(calls.filter((c) => c.url.startsWith('https://push.test/'))).toHaveLength(0);
      expect(store.listStreetWatchUsers).not.toHaveBeenCalled();
      expect(meta.cityCasesIdx.cases['fa4943b8-08c8-f111-a3d0-001dd8050b66']).toMatchObject({ s: 'Draft', g: 1 });

      // The resident finishes the wizard: the same GUID is listed Submitted. A status change to the index, a new request to the street.
      statusAttrs[0].FormattedValue = 'Submitted';
      calls.length = 0;
      const r2 = await syncCityCases(env, store, { gapMs: 0, now: NEWEST + 3_600_000 });
      expect(r2).toMatchObject({ added: 0, changed: 1, watchPushed: 1 });
      expect(calls.filter((c) => c.url.startsWith('https://push.test/'))).toHaveLength(1);
      expect(calls.filter((c) => c.url.includes('geocode.arcgis.com'))).toHaveLength(0); // the Draft run geocoded the street
      expect((store.listStreetWatchUsers as any).mock.calls).toHaveLength(1);
      expect(cases['fa4943b8-08c8-f111-a3d0-001dd8050b66']).toMatchObject({ status: 'Submitted', lat: 41.8282, lng: -71.4005 });
      const ev = (store.addEvent as any).mock.calls.map((c: any[]) => c[0]).find((e: any) => e.kind === 'watch.pushed');
      expect(ev).toMatchObject({ data: { cases: 1, hits: 1, pushed: 1, accounts: 1 } });

      calls.length = 0;
      const r3 = await syncCityCases(env, store, { gapMs: 0, now: NEWEST + 5_400_000 }); // unchanged list: nothing
      expect(r3).toMatchObject({ added: 0, changed: 0, watchPushed: 0 });
      expect(calls.filter((c) => c.url.startsWith('https://push.test/'))).toHaveLength(0);
      expect((store.listStreetWatchUsers as any).mock.calls).toHaveLength(1);
    } finally { statusAttrs.forEach((a: any, i: number) => { a.FormattedValue = orig[i]; }); }
  });
});

describe('backfillCityCaseGeo', () => {
  it('geocodes stored cases that never got coordinates, bounded, and leaves geocoded ones alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ candidates: [{ location: { x: -71.41, y: 41.83 }, score: 100 }] })));
    const { store, cases, meta } = makeStore();
    const rows = [
      { id: 'a', street: '1 Hope St', createdAt: '2026-10-01T00:00:00Z' },
      { id: 'b', street: '2 Hope St', createdAt: '2026-10-02T00:00:00Z', lat: 41.8, lng: -71.4 },
      { id: 'c', street: '3 Hope St', createdAt: '2026-10-03T00:00:00Z', lat: null, lng: null }, // geocoder had nothing: not retried
      { id: 'd', street: '4 Hope St', createdAt: '2026-10-04T00:00:00Z' },
    ];
    // (2026-10-25) a blank street geocoded to the downtown centroid: it must be nulled, not kept.
    rows.push({ id: 'e', street: '', createdAt: '2026-10-05T00:00:00Z', lat: 41.8239, lng: -71.4128 } as any);
    (store as any).listCityCasesSince = vi.fn(async () => rows.map((r) => ({ ...r, ...(cases[r.id] ?? {}) })));
    try {
      expect(await backfillCityCaseGeo(store, { limit: 1 })).toEqual({ patched: 1, remaining: 2 });
      expect(Object.keys(cases)).toEqual(['a']);
      expect(cases.a).toEqual({ lat: 41.83, lng: -71.41 });
      expect(meta.cityGeoBackfill.doneAt).toBeUndefined();
      expect(await backfillCityCaseGeo(store)).toEqual({ patched: 2, remaining: 0 });
      expect(cases.e).toEqual({ lat: null, lng: null });
      expect(meta.cityGeoBackfill.doneAt).toBeTruthy();
    } finally { vi.unstubAllGlobals(); }
  });
});
