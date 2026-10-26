import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The email log (Rob, 2026-10-16: see the system by user, by report, by email). Every send and every inbound message
// lands in emails/{id}; credentials never do; Resend's history and delivery state are imported.
const mem = new Map<string, Record<string, unknown>>();
const fakeStore = {
  // like Firestore's patch: undefined fields are not written
  putEmail: vi.fn(async (r: { id: string }) => { mem.set(r.id, { ...(mem.get(r.id) ?? {}), ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) }); }),
  getEmail: vi.fn(async (id: string) => (mem.get(id) as never) ?? null),
  patchEmail: vi.fn(async (id: string, f: Record<string, unknown>) => { mem.set(id, { ...(mem.get(id) ?? {}), ...f }); }),
  getMeta: vi.fn(async () => null), setMeta: vi.fn(async () => {}), addEvent: vi.fn(async () => {}),
};
vi.mock('../src/firestore', async (orig) => ({ ...(await orig<typeof import('../src/firestore')>()), createStore: () => fakeStore }));

import { redact, inferKind, caseIdIn, inboundId, record, syncFromResend, importCityMessages, toText } from '../src/emaillog';
import { createMailer } from '../src/email';
import { handleInbound } from '../src/relay';
import { handleAdmin } from '../src/adminapi';
import type { Env, Store, Mailer, ReportDoc } from '../src/contracts';

const env = {
  RESEND_API_KEY: 're_test', NOTIFY_EMAIL: 'rob@fixmypvd.org', NOTIFY_FROM: 'FixMyPVD <updates@fixmypvd.org>', APP_NAME: 'FixMyPVD',
  RELAY_ADDRESS: 'cases@fixmypvd.org', CITY_SENDER_DOMAINS: 'providenceri.gov', APP_BASE_URL: 'https://fixmypvd.org', ADMIN_EMAILS: 'rob@example.com',
} as unknown as Env;

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => { mem.clear(); vi.clearAllMocks(); fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { vi.unstubAllGlobals(); });
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

describe('pure helpers', () => {
  it('redact cuts sign-in and approve/reject links, keeps ordinary links', () => {
    const t = redact('Sign in: https://pvd-snow-report.firebaseapp.com/__/auth/action?apiKey=k&mode=signIn&oobCode=SECRET&continueUrl=x\n'
      + 'Approve: https://api.fixmypvd.org/hitl/approve/abc/123/deadbeef\nTrack: https://fixmypvd.org/r/abc');
    expect(t).not.toContain('SECRET');
    expect(t).not.toContain('deadbeef');
    expect(t).toContain('[link removed]');
    expect(t).toContain('https://fixmypvd.org/r/abc');
  });
  it('inferKind reads our own subjects', () => {
    const k = (s: string, to = 'r@example.com') => inferKind(s, [to], env);
    expect(k('Your FixMyPVD sign-in link')).toBe('signin_link');
    expect(k('Tu enlace para entrar a FixMyPVD')).toBe('signin_link');
    expect(k('Your report was filed with Providence 311 (PVD2026-1)')).toBe('filed');
    expect(k('Providence 311 on your report PVD2026-1: You service request…')).toBe('city_copy');
    expect(k('The city assigned your request (PVD2026-1)')).toBe('status');
    expect(k('A city department responded to your request (PVD2026-1)')).toBe('status');
    expect(k('Your report PVD2026-90089 has been received by the city')).toBe('status');
    expect(k('Your report PVD2026-90089 was assigned to a city crew')).toBe('status');
    expect(k('Your report PVD2026-90090 is now Department Responded')).toBe('status');
    expect(k('Your FixMyPVD report at 13 Wisdom Ave — two quick questions')).toBe('reporter_other');
    expect(k('The city needs more information about your report (PVD2026-1)')).toBe('ask');
    expect(k('Reminder: the city is waiting for more information (PVD2026-1)')).toBe('ask_reminder');
    expect(k('We sent your answer to the city (PVD2026-1)')).toBe('answer_receipt');
    expect(k("[FixMyPVD] We didn't send your pothole report")).toBe('not_sent');
    expect(k('[FixMyPVD] Review: Pothole @ 1 Main', 'rob@fixmypvd.org')).toBe('admin_review');
    expect(k('[FixMyPVD] Daily digest', 'rob@fixmypvd.org')).toBe('admin_digest');
    expect(k('[FixMyPVD] Your r/providence post for this week', 'rob@fixmypvd.org')).toBe('admin_digest');
    expect(k('[FixMyPVD] Circuit breaker tripped', 'rob@fixmypvd.org')).toBe('admin_alert');
    expect(k('RE: PVD311 needs more information PVD311:0250715', 'pvd311@providenceri.gov')).toBe('to_city');
  });
  it('record lowercases + dedupes addrs; ids are stable', () => {
    const r = record({ id: 'x', at: '2026-10-16T00:00:00Z', dir: 'out', kind: 'filed', from: 'FixMyPVD <Updates@FixMyPVD.org>', to: ['A@Example.com', 'a@example.com'], subject: 's', text: 'hi', status: 'sent', source: 'live' });
    expect(r.from).toBe('updates@fixmypvd.org');
    expect(r.addrs).toEqual(['updates@fixmypvd.org', 'a@example.com']);
    expect(inboundId(['r', 'at', 's'])).toBe(inboundId(['r', 'at', 's']));
    expect(inboundId(['r', 'at', 's'])).not.toBe(inboundId(['r', 'at', 't']));
    expect(caseIdIn('Re: pvd2026-90113 x')).toBe('PVD2026-90113');
    expect(toText('<p>a</p><style>x{}</style><p>b&amp;c</p>')).toBe('a\nb&c');
  });
});

describe('every send is logged (email.ts)', () => {
  it('reporter mail: Resend id → rs_<id>, kind + report from the caller, text redacted', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'abc-123' }));
    await createMailer(env).sendTo('Owner@Example.com', 'The city needs more information about your report (PVD2026-90113)', '<p>Hi <a href="https://x/__/auth/action?oobCode=S">x</a></p>', { replyTo: 'cases@fixmypvd.org', kind: 'ask', reportId: 'rep1', caseId: 'PVD2026-90113' });
    const r = mem.get('rs_abc-123')!;
    expect(r).toMatchObject({ dir: 'out', kind: 'ask', status: 'sent', to: ['owner@example.com'], reportId: 'rep1', caseId: 'PVD2026-90113', resendId: 'abc-123', replyTo: 'cases@fixmypvd.org', source: 'live' });
    expect(r.text).not.toContain('oobCode');
    expect(r.addrs).toEqual(['updates@fixmypvd.org', 'owner@example.com']);
  });
  it('a failed send is logged as failed; the kind is inferred when the caller gives none', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 }));
    await createMailer(env).sendTo('r@example.com', 'Your report was filed with Providence 311 (PVD2026-1)', '<p>x</p>');
    const [r] = [...mem.values()];
    expect(r).toMatchObject({ kind: 'filed', status: 'failed', error: 'Resend 429: rate limited', resendId: null });
    expect(String(r.id)).toMatch(/^out_/);
  });
  it('admin alerts and city mail are logged with their kinds', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'al1' })).mockResolvedValueOnce(ok({ id: 'ct1' }));
    const m = createMailer(env);
    await m.alert('Circuit breaker tripped', '<p>x</p>', { reportId: 'rep9' });
    await m.sendAsRelay({ to: 'pvd311@providenceri.gov', subject: 'RE: x', text: 'answer', html: '<p>answer</p>', reportId: 'rep1', caseId: 'PVD2026-1' });
    expect(mem.get('rs_al1')).toMatchObject({ kind: 'admin_alert', to: ['rob@fixmypvd.org'], reportId: 'rep9', subject: '[FixMyPVD] Circuit breaker tripped' });
    expect(mem.get('rs_ct1')).toMatchObject({ kind: 'to_city', from: 'cases@fixmypvd.org', to: ['pvd311@providenceri.gov'], reportId: 'rep1', text: 'answer' });
  });
});

// ── relay.ts: every inbound message ────────────────────────────────────────────────

function raw(from: string, subject: string, text: string, extra = ''): string {
  return [`From: ${from}`, 'To: cases@fixmypvd.org', `Subject: ${subject}`, 'Date: Fri, 16 Oct 2026 15:53:08 +0000', 'Message-ID: <m1@x>', 'Authentication-Results: mx; dmarc=pass', extra, 'Content-Type: text/plain; charset=utf-8', '', text].filter((l, i) => l !== '' || i > 6).join('\r\n');
}
function relayDeps(report: Partial<ReportDoc> | null) {
  const r = report ? ({ id: 'rep1', category: 'pothole', address: '1 Main', reporterEmail: 'owner@example.com', portalCaseId: 'PVD2026-71677', status: 'submitted', ownerUid: 'u1', ...report } as ReportDoc) : null;
  const store = {
    findByPortalCaseId: vi.fn(async (c: string) => (r && c === r.portalCaseId ? r : null)), findByPortalCaseIdCandidate: vi.fn(async () => null),
    patchReport: vi.fn(async () => {}), addEvent: vi.fn(async () => {}), getMeta: vi.fn(async () => null), setMeta: vi.fn(async () => {}),
    getUser: vi.fn(async () => ({ email: 'owner@example.com', prefs: {} })), putEmail: fakeStore.putEmail,
  } as unknown as Store;
  const mailer = { send: vi.fn(async () => null), alert: vi.fn(async () => {}), sendTo: vi.fn(async () => {}), sendAsRelay: vi.fn(async () => ({ ok: true, id: 'x', error: null })) } as unknown as Mailer;
  return { store, mailer, sleep: vi.fn(async () => {}) };
}
const msg = (r: string, from: string) => ({ from, to: 'cases@fixmypvd.org', headers: new Headers(), raw: r });

describe('relay: inbound mail is logged with what we did', () => {
  it('city mail matched to a report: city_in, its id = the import id, outcome + city kind', async () => {
    const d = relayDeps({});
    const out = await handleInbound(msg(raw('PVD 311 <pvd311@providenceri.gov>', 'PVD2026-71677 Pothole PVD311:1', 'Your request has been successfully received and logged into our PVD311 system.'), 'pvd311@providenceri.gov'), env, d);
    expect(out.kind).toBe('forwarded');
    const r = [...mem.values()][0];
    expect(r).toMatchObject({ dir: 'in', kind: 'city_in', reportId: 'rep1', caseId: 'PVD2026-71677', cityKind: 'receipt', status: 'received', messageId: '<m1@x>' });
    expect(String(r.outcome)).toMatch(/^forwarded to 1 recipient/);
    const at = (out as { at: string }).at;
    expect(r.id).toBe(inboundId(['rep1', at, 'PVD2026-71677 Pothole PVD311:1']));
    // the cityMessages import then finds it already logged
    expect(await importCityMessages(env, { getEmail: fakeStore.getEmail, putEmail: fakeStore.putEmail } as unknown as Store, [{ id: 'rep1', cityMessages: [{ at, from: 'pvd311@providenceri.gov', subject: 'PVD2026-71677 Pothole PVD311:1', text: 'x', caseId: 'PVD2026-71677' }] }])).toBe(0);
  });
  it('a reply nobody asked for → reply_in "sent to you"; noise → dropped_in; unknown case → unmatched_in', async () => {
    await handleInbound(msg(raw('someone@example.com', 'hello', 'hi'), 'someone@example.com'), env, relayDeps(null));
    await handleInbound(msg(raw('x@example.com', 'auto', 'away', 'Auto-Submitted: auto-replied'), 'x@example.com'), env, relayDeps(null));
    await handleInbound(msg(raw('pvd311@providenceri.gov', 'PVD2026-99999 thing', 'x'), 'pvd311@providenceri.gov'), env, relayDeps(null));
    const kinds = [...mem.values()].map((r) => [r.kind, r.status, r.outcome]);
    expect(kinds).toEqual(expect.arrayContaining([
      ['reply_in', 'received', 'sent to you (nothing went to the city)'],
      ['dropped_in', 'dropped', 'dropped (auto-submitted)'],
      ['unmatched_in', 'received', 'no matching report — sent to you'],
    ]));
  });
});

// ── Resend import ──────────────────────────────────────────────────────────────────

describe('syncFromResend', () => {
  const item = (id: string, subject: string, to = 'r@example.com', last_event = 'delivered') => ({ id, to: [to], from: 'FixMyPVD <updates@fixmypvd.org>', created_at: '2026-10-16 19:31:34.043000+00', subject, last_event });
  it('imports what the log lacks (kind from the subject, report from the case id), refreshes delivery state, follows pages', async () => {
    mem.set('rs_have', { id: 'rs_have', lastEvent: 'sent' });
    fetchMock
      .mockResolvedValueOnce(ok({ data: [item('new1', 'The city received your request (PVD2026-90124)'), item('have', 'x')], has_more: true }))
      .mockResolvedValueOnce(ok({ data: [item('new2', '[FixMyPVD] Daily digest', 'rob@fixmypvd.org')], has_more: false }));
    const store = { ...fakeStore, findByPortalCaseId: vi.fn(async (c: string) => (c === 'PVD2026-90124' ? { id: 'rep124' } : null)) } as unknown as Store;
    const r = await syncFromResend(env, store, { now: new Date('2026-10-16T22:00:00Z') });
    expect(r).toEqual({ scanned: 3, imported: 2, updated: 1 });
    expect(String(fetchMock.mock.calls[1][0])).toContain('after=have');
    expect(mem.get('rs_new1')).toMatchObject({ kind: 'status', reportId: 'rep124', caseId: 'PVD2026-90124', at: '2026-10-16T19:31:34.043Z', text: null, lastEvent: 'delivered', source: 'import' });
    expect(mem.get('rs_new2')).toMatchObject({ kind: 'admin_digest', reportId: null });
    expect(mem.get('rs_have')).toMatchObject({ lastEvent: 'delivered' });
  });
});

// ── Admin API ──────────────────────────────────────────────────────────────────────

const admin = { uid: 'u', email: 'rob@example.com', emailVerified: true, name: null, provider: 'google.com' };
const call = async (store: Store, method: string, path: string) => {
  const req = new Request(`https://api.test${path}`, { method });
  const resp = await handleAdmin(req, new URL(req.url), env, store, admin);
  return { status: resp.status, body: (await resp.json()) as any };
};
const E = (id: string, o: Record<string, unknown> = {}) => ({ id, at: '2026-10-16T20:00:00.000Z', dir: 'out', kind: 'status', from: 'updates@fixmypvd.org', to: ['owner@example.com'], addrs: ['updates@fixmypvd.org', 'owner@example.com'], subject: 'The city assigned your request (PVD2026-1)', text: 'body text', status: 'sent', source: 'live', ...o });

describe('admin email endpoints', () => {
  it('GET /api/admin/emails: summaries (no body), filters by dir/kind/q, scoped by report or person', async () => {
    const rows = [E('a', { dir: 'in', kind: 'city_in', from: 'pvd311@providenceri.gov' }), E('b'), E('c', { kind: 'signin_link', subject: 'Your FixMyPVD sign-in link', reportId: null })];
    const store = { listEmails: vi.fn(async () => rows), findEmails: vi.fn(async ({ reportId, addr }: { reportId?: string; addr?: string }) => rows.filter((r) => (reportId ? r.reportId === reportId : (r.addrs as string[]).includes(addr!)))), getUser: vi.fn(async () => ({ uid: 'u1', email: 'owner@example.com' })) } as unknown as Store;
    const all = await call(store, 'GET', '/api/admin/emails');
    expect(all.body.items.map((x: any) => x.id)).toEqual(['a', 'b', 'c']);
    expect(all.body.items[0].text).toBeUndefined();
    expect(all.body.items[0].preview).toBe('body text');
    expect((await call(store, 'GET', '/api/admin/emails?dir=in')).body.items.map((x: any) => x.id)).toEqual(['a']);
    expect((await call(store, 'GET', '/api/admin/emails?kind=signin_link')).body.items.map((x: any) => x.id)).toEqual(['c']);
    expect((await call(store, 'GET', '/api/admin/emails?q=assigned')).body.items.map((x: any) => x.id)).toEqual(['a', 'b']);
    await call(store, 'GET', '/api/admin/emails?uid=u1');
    expect(store.findEmails).toHaveBeenCalledWith({ addr: 'owner@example.com', limit: 300 });
    await call(store, 'GET', '/api/admin/emails?reportId=rep1');
    expect(store.findEmails).toHaveBeenCalledWith({ reportId: 'rep1', limit: 300 });
  });
  it('GET /api/admin/emails/:id: fetches an imported body from Resend (redacted), refreshes delivery, links report + account', async () => {
    mem.set('rs_r1', E('rs_r1', { text: null, resendId: 'r1', reportId: 'rep1', lastEventAt: null }));
    fetchMock.mockResolvedValueOnce(ok({ id: 'r1', html: '<p>Tap <a href="https://x/__/auth/action?oobCode=S">here</a></p>', text: null, last_event: 'delivered' }));
    const store = { ...fakeStore, fetchReport: vi.fn(async () => ({ id: 'rep1', category: 'pothole', address: '1 Main', status: 'submitted', portalCaseId: 'PVD2026-1', portalStatus: 'Assigned' })), findUserByEmail: vi.fn(async (a: string) => (a === 'owner@example.com' ? { uid: 'u1', email: a } : null)) } as unknown as Store;
    const { status, body } = await call(store, 'GET', '/api/admin/emails/rs_r1');
    expect(status).toBe(200);
    expect(body.text).toBe('Tap here');
    expect(body.lastEvent).toBe('delivered');
    expect(body.report).toMatchObject({ id: 'rep1', categoryLabel: 'Pothole', portalCaseId: 'PVD2026-1' });
    expect(body.accounts).toEqual([{ uid: 'u1', email: 'owner@example.com' }]);
    expect(mem.get('rs_r1')).toMatchObject({ text: 'Tap here', lastEvent: 'delivered' });
  });
  it('GET /api/admin/users/:uid/profile: the person, their reports, their email', async () => {
    const store = {
      getUser: vi.fn(async () => ({ uid: 'u1', email: 'owner@example.com', provider: 'google.com', emailVerified: true, createdAt: '2026-10-01', prefs: { emailUpdates: false }, following: ['x'], addresses: [{}] })),
      findReportsByOwner: vi.fn(async () => [{ id: 'rep1', category: 'pothole', address: '1 Main', status: 'submitted', timestamp: null, statusUpdatedAt: null }]),
      findEmails: vi.fn(async () => [E('b')]), countOwnerByStatus: vi.fn(async (_u: string, s: string) => (s === 'submitted' ? 2 : 0)),
    } as unknown as Store;
    const { body } = await call(store, 'GET', '/api/admin/users/u1xxxx/profile');
    expect(body.user).toMatchObject({ uid: 'u1', email: 'owner@example.com', emailUpdates: false, following: ['x'], addresses: 1, submitted: 2, rejected: 0 });
    expect(body.reports[0]).toMatchObject({ id: 'rep1', categoryLabel: 'Pothole' });
    expect(body.emails[0]).toMatchObject({ id: 'b', kind: 'status' });
  });
  it('admin only', async () => {
    const req = new Request('https://api.test/api/admin/emails');
    expect((await handleAdmin(req, new URL(req.url), env, {} as Store, { ...admin, email: 'x@example.com' })).status).toBe(403);
  });
});

// ── Resend webhook (delivery state pushed to us) + a send-only key ─────────────────

import { verifyResendWebhook, handleResendWebhook } from '../src/emaillog';

const SECRET = 'whsec_' + btoa('0123456789abcdef0123456789abcdef');
async function signed(body: string, ts = Math.floor(Date.now() / 1000), secret = SECRET) {
  const key = await crypto.subtle.importKey('raw', Uint8Array.from(atob(secret.replace(/^whsec_/, '')), (c) => c.charCodeAt(0)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`msg_1.${ts}.${body}`)));
  return new Request('https://api.test/hooks/resend', { method: 'POST', body, headers: { 'svix-id': 'msg_1', 'svix-timestamp': String(ts), 'svix-signature': `v1,${btoa(String.fromCharCode(...mac))}` } });
}
const hookEnv = { ...env, RESEND_WEBHOOK_SECRET: SECRET } as unknown as Env;
const ev = (type: string, id = 'w1', subject = 'The city assigned your request (PVD2026-90113)') => JSON.stringify({ type, created_at: '2026-10-16T22:05:00.000Z', data: { email_id: id, from: 'FixMyPVD <updates@fixmypvd.org>', to: ['owner@example.com'], subject, created_at: '2026-10-16T22:04:59.000Z' } });

describe('Resend delivery webhook', () => {
  it('verifies the svix signature (and its age)', async () => {
    const body = ev('email.delivered');
    const req = await signed(body);
    expect(await verifyResendWebhook(SECRET, req.headers, body)).toBe(true);
    expect(await verifyResendWebhook(SECRET, req.headers, body + ' ')).toBe(false);
    expect(await verifyResendWebhook('whsec_' + btoa('another-secret-another-secret-xx'), req.headers, body)).toBe(false);
    const old = await signed(body, Math.floor(Date.now() / 1000) - 3600);
    expect(await verifyResendWebhook(SECRET, old.headers, body)).toBe(false);
  });
  it('moves an email forward (a late "sent" never undoes "delivered"; a bounce always wins); unsigned → 401', async () => {
    mem.set('rs_w1', { id: 'rs_w1', lastEvent: null });
    const store = { ...fakeStore, findByPortalCaseId: vi.fn(async () => null) } as unknown as Store;
    expect((await handleResendWebhook(await signed(ev('email.delivered')), hookEnv, store)).status).toBe(200);
    expect(mem.get('rs_w1')).toMatchObject({ lastEvent: 'delivered', lastEventAt: '2026-10-16T22:05:00.000Z' });
    await handleResendWebhook(await signed(ev('email.sent')), hookEnv, store);
    expect(mem.get('rs_w1')!.lastEvent).toBe('delivered');
    await handleResendWebhook(await signed(ev('email.bounced')), hookEnv, store);
    expect(mem.get('rs_w1')!.lastEvent).toBe('bounced');
    const forged = new Request('https://api.test/hooks/resend', { method: 'POST', body: ev('email.delivered'), headers: { 'svix-id': 'x', 'svix-timestamp': String(Math.floor(Date.now() / 1000)), 'svix-signature': 'v1,AAAA' } });
    expect((await handleResendWebhook(forged, hookEnv, store)).status).toBe(401);
    expect((await handleResendWebhook(await signed(ev('email.delivered')), env, store)).status).toBe(503); // no secret configured
  });
  it('an email the log never saw is recorded from the event (kind from the subject, report from the case id)', async () => {
    const store = { ...fakeStore, findByPortalCaseId: vi.fn(async () => ({ id: 'rep1' })) } as unknown as Store;
    await handleResendWebhook(await signed(ev('email.delivered', 'w2')), hookEnv, store);
    expect(mem.get('rs_w2')).toMatchObject({ dir: 'out', kind: 'status', reportId: 'rep1', caseId: 'PVD2026-90113', lastEvent: 'delivered', to: ['owner@example.com'], source: 'import', text: null });
  });
  it('a live send logged after its webhook keeps the delivery state (the log write leaves lastEvent alone)', async () => {
    mem.set('rs_w3', { id: 'rs_w3', lastEvent: 'delivered' });
    fetchMock.mockResolvedValueOnce(ok({ id: 'w3' }));
    await createMailer(env).sendTo('owner@example.com', 'The city assigned your request (PVD2026-1)', '<p>x</p>', { kind: 'status' });
    expect(mem.get('rs_w3')).toMatchObject({ lastEvent: 'delivered', kind: 'status', source: 'live' });
  });
  it('a send-only Resend key: the sync reports unreadable instead of failing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 401 }));
    expect(await syncFromResend(env, fakeStore as unknown as Store)).toEqual({ scanned: 0, imported: 0, updated: 0, unreadable: true });
  });
});

describe('sign-in link emails stay out of the log (Rob, 2026-10-17)', () => {
  it('a sign-in email sent through the Mailer, imported from Resend, or seen by the webhook is never stored', async () => {
    fetchMock.mockResolvedValueOnce(ok({ id: 'si1' }));
    await createMailer(env).sendTo('r@example.com', 'Your FixMyPVD sign-in link', '<p>x</p>');
    expect(mem.has('rs_si1')).toBe(false);
    fetchMock.mockResolvedValueOnce(ok({ data: [{ id: 'si2', to: ['r@example.com'], from: 'FixMyPVD <updates@fixmypvd.org>', created_at: '2026-10-16 19:02:15.425000+00', subject: 'Tu enlace para entrar a FixMyPVD', last_event: 'delivered' }], has_more: false }));
    expect(await syncFromResend(env, { ...fakeStore, findByPortalCaseId: vi.fn(async () => null) } as unknown as Store)).toMatchObject({ scanned: 1, imported: 0 });
    expect(mem.has('rs_si2')).toBe(false);
    await handleResendWebhook(await signed(ev('email.delivered', 'si3', 'Your FixMyPVD sign-in link')), hookEnv, { ...fakeStore, findByPortalCaseId: vi.fn(async () => null) } as unknown as Store);
    expect(mem.has('rs_si3')).toBe(false);
  });
});
