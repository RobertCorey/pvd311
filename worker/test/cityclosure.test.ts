import { describe, it, expect, vi } from 'vitest';
import type { AuthUser } from '../src/auth';

// City "Resolved" ≠ fixed (PVD2026-90091, 2026-10-16): the city's own words are shown verbatim, our words stay neutral,
// a relayed city email's body goes only to the report's owner, and there is no public "resolved" count.
const TOKENS: Record<string, AuthUser> = {
  owner: { uid: 'uid_owner', email: 'owner@example.com', emailVerified: true, name: null, provider: 'password' },
  other: { uid: 'uid_other', email: 'other@example.com', emailVerified: true, name: null, provider: 'password' },
};
vi.mock('../src/auth', async (orig) => ({
  ...(await orig<typeof import('../src/auth')>()),
  userFromRequest: async (_env: unknown, req: Request) => TOKENS[(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')] ?? null,
}));

import { handleApi } from '../src/api';
import { statusChangeEmail, statusChangePush, statusPhrase } from '../src/notify';
import { cityResolutionMessage } from '../src/casedetail';
import type { Store, ReportDoc } from '../src/contracts';

const ID = 'm3hPCS9K2-UfxNBB6Fscbg';
const NOTE = 'Complaint (CODE-26-1465) has been received and logged into the system for review.';
const CITY_TEXT = 'Hello,\n\n[cid:image001.png@01DB1234.56789AB0]\nYour request PVD2026-90091 was referred.\n\n\n\nReporter said: shed going up at 12 Example St\n  indented line kept';

const report = (over: Partial<ReportDoc> = {}): ReportDoc => ({
  id: ID, timestamp: '2026-10-10T12:00:00Z' as any, category: 'other', address: '12 Example St', lat: 41.82, lng: -71.41,
  description: 'shed going up', photo: null, reporterName: null, reporterEmail: 'owner@example.com', ownerUid: 'uid_owner',
  status: 'submitted', statusDetail: null, portalCaseId: 'PVD2026-90091', portalStatus: 'Resolved',
  portalDetail: { capturedAt: '2026-10-16T12:00:00Z', hash: 'x', notes: [], fields: {
    adx_resolution: { label: 'Resolution Message', value: `  ${NOTE}\n`, readonly: true },
    title: { label: 'Case Number', value: 'PVD2026-90091', readonly: true },
  } },
  cityMessages: [{ at: '2026-10-16T13:00:00Z', from: '311@providenceri.gov', subject: 'Your request PVD2026-90091 has been updated', text: CITY_TEXT, caseId: 'PVD2026-90091' }],
  ...over,
} as ReportDoc);

function store(r: ReportDoc, extra: Partial<Store> = {}): Store {
  return {
    fetchReport: vi.fn(async (id: string) => (id === r.id ? r : null)),
    getUser: vi.fn(async () => ({ following: [] })),
    patchUser: vi.fn(async () => {}),
    findReportsByOwner: vi.fn(async () => [r]),
    countByStatus: vi.fn(async () => 42),
    countResolved: vi.fn(async () => 7),
    ...extra,
  } as unknown as Store;
}
const env = {} as any;
async function get(path: string, s: Store, token?: string) {
  const headers: Record<string, string> = { origin: 'https://fixmypvd.org' };
  if (token) headers.authorization = `Bearer ${token}`;
  const resp = (await handleApi(new Request(`https://api.test${path}`, { headers }), env, { store: s }))!;
  return { status: resp.status, body: (await resp.json()) as any };
}
const msgRow = (j: any) => j.timeline.find((t: any) => t.kind === 'city_message');

describe("the city's Resolution Message", () => {
  it('is exposed publicly, verbatim (trimmed only), from portalDetail.fields.adx_resolution', async () => {
    const { status, body } = await get(`/api/reports/${ID}`, store(report()));
    expect(status).toBe(200);
    expect(body.resolutionMessage).toBe(NOTE);
    expect(JSON.stringify(body)).not.toMatch(/crew|resolved by the city/i);
  });
  it('shows whatever the status, and is null when the field is empty or missing', async () => {
    expect((await get(`/api/reports/${ID}`, store(report({ portalStatus: 'Assigned' })))).body.resolutionMessage).toBe(NOTE);
    const empty = report(); empty.portalDetail!.fields.adx_resolution.value = '   ';
    expect((await get(`/api/reports/${ID}`, store(empty))).body.resolutionMessage).toBeNull();
    expect((await get(`/api/reports/${ID}`, store(report({ portalDetail: null })))).body.resolutionMessage).toBeNull();
    expect(cityResolutionMessage({ portalDetail: undefined })).toBeNull();
  });
});

describe('city message text is for the owner only', () => {
  it('anonymous: subject in the label, no text', async () => {
    const { body } = await get(`/api/reports/${ID}`, store(report()));
    const row = msgRow(body);
    expect(row.label).toBe('Message from the city: Your request has been updated');
    expect(row.text).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Reporter said');
    expect(body.description).toBeUndefined();
  });
  it('another signed-in account: still no text', async () => {
    const { body } = await get(`/api/reports/${ID}`, store(report()), 'other');
    expect(body.mine).toBe(false);
    expect(msgRow(body).text).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('Reporter said');
  });
  it('owner: the stored plain text, minus image-placeholder lines and extra blank lines; everything else as stored', async () => {
    const { body } = await get(`/api/reports/${ID}`, store(report()), 'owner');
    expect(body.mine).toBe(true);
    expect(msgRow(body).text).toBe('Hello,\n\nYour request PVD2026-90091 was referred.\n\nReporter said: shed going up at 12 Example St\n  indented line kept');
  });
  it('lists (/api/me/reports) never carry message text, even for the owner', async () => {
    const { body } = await get('/api/me/reports', store(report()), 'owner');
    expect(body.items).toHaveLength(1);
    expect(msgRow(body.items[0]).text).toBeUndefined();
    expect(body.items[0].resolutionMessage).toBe(NOTE);
  });
});

describe('GET /api/stats', () => {
  it('returns filed only — no resolved count', async () => {
    const s = store(report());
    const { status, body } = await get('/api/stats', s);
    expect(status).toBe(200);
    expect(body).toEqual({ filed: 42 });
    expect('resolved' in body).toBe(false);
    expect(s.countResolved).not.toHaveBeenCalled();
  });
});

describe('status-change email wording', () => {
  const base = { category: 'construction_no_permit', address: '12 Example St', caseId: 'PVD2026-90091', trackUrl: `https://fixmypvd.org/r/${ID}`, base: 'https://fixmypvd.org' };
  it('Resolved reads as closed, never "resolved by the city", and quotes the city\'s note verbatim (escaped)', () => {
    const m = statusChangeEmail({ ...base, status: 'Resolved', resolution: `${NOTE} <ok> & "fine"` });
    expect(m.subject).toBe('The city closed your request (PVD2026-90091)');
    expect(m.html).toContain('The city closed your request: your construction no permit report at 12 Example St (city case <b>PVD2026-90091</b>).');
    expect(m.html).toContain('City status: <b>Resolved</b>');
    expect(m.html).toContain("The city's note:");
    expect(m.html).toContain(`${NOTE} &lt;ok&gt; &amp; &quot;fine&quot;`);
    expect(`${m.subject} ${m.html}`).not.toMatch(/resolved by the city|marked resolved|crew/i);
  });
  it('a follower is told about "a report you follow", never "your request"', () => {
    const m = statusChangeEmail({ ...base, status: 'Resolved', resolution: null, follower: true });
    expect(m.subject).toBe('The city closed a report you follow (PVD2026-90091)');
    expect(m.html).toContain('The city closed a report you follow: the construction no permit report at 12 Example St (city case <b>PVD2026-90091</b>).');
    expect(`${m.subject} ${m.html}`).not.toMatch(/\byour (request|construction)/);
  });
  it('no note when the city left none', () => {
    const m = statusChangeEmail({ ...base, status: 'Resolved', resolution: null });
    expect(m.html).not.toContain("The city's note");
  });
  it('Assigned says the city assigned the request, not a crew', () => {
    const m = statusChangeEmail({ ...base, status: 'Assigned', resolution: null });
    expect(m.subject).toBe('The city assigned your request (PVD2026-90091)');
    expect(m.html).not.toMatch(/crew/i);
  });
  it('every status maps to neutral words; unknown ones fall back without guessing', () => {
    expect(statusPhrase('In Progress')).toBe('The city marked your request in progress');
    expect(statusPhrase('Completed')).toBe('The city closed your request');
    expect(statusPhrase('Cancelled')).toBe('The city cancelled your request');
    expect(statusPhrase('Something New')).toBe('The city updated your request');
    expect(statusChangeEmail({ ...base, status: 'Something New', resolution: null }).html).toContain('City status: <b>Something New</b>');
  });
  it('the footer sends people to Account → Updates, not "reply to stop"', () => {
    const { html } = statusChangeEmail({ ...base, status: 'Assigned', resolution: null });
    expect(html).toContain('Change or stop these emails under <a href="https://fixmypvd.org/account/updates">Account → Updates</a>.');
    expect(html).not.toMatch(/reply to stop/i);
  });
  it('the same move as a push to the owner\'s phones: the phrase, the report, the city\'s note cut to 80, the tracking page, one tag per report', () => {
    const long = `${NOTE} ${'x'.repeat(100)}`;
    expect(statusChangePush({ reportId: ID, category: 'construction_no_permit', address: '12 Example St', status: 'Resolved', trackUrl: `https://fixmypvd.org/r/${ID}`, resolution: `  ${long}\n` })).toEqual({
      title: 'The city closed your request',
      body: `construction no permit at 12 Example St — Resolved · ${long.slice(0, 80)}`,
      url: `https://fixmypvd.org/r/${ID}`,
      tag: `report:${ID}`,
    });
    expect(statusChangePush({ reportId: ID, category: 'pothole', address: '1 Main St', status: 'Assigned', trackUrl: 'https://x/r/1', resolution: null }).body).toBe('pothole at 1 Main St — Assigned');
  });
});
