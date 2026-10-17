import { describe, it, expect, vi } from 'vitest';
import type { AuthUser } from '../src/auth';

// The city asks the reporter for more information → the reporter answers (app or email reply) → the answer goes to the
// city from the relay address, threaded on the city's subject. No person in the loop (Rob, 2026-10-16).
const TOKENS: Record<string, AuthUser> = {
  owner: { uid: 'uid_owner', email: 'owner@example.com', emailVerified: true, name: null, provider: 'password' },
  other: { uid: 'uid_other', email: 'other@example.com', emailVerified: true, name: null, provider: 'password' },
};
vi.mock('../src/auth', async (orig) => ({
  ...(await orig<typeof import('../src/auth')>()),
  userFromRequest: async (_env: unknown, req: Request) => TOKENS[(req.headers.get('authorization') ?? '').replace(/^Bearer /, '')] ?? null,
}));

import {
  classifyCityMail, classifyInbound, extractReplyText, parseNoteTime, askCandidates, syncCityAsks, answerCityAsk, askState,
  cityAnswerMail, askEmail, ASK_REMIND_AFTER_MS,
} from '../src/cityask';
import { handleInbound } from '../src/relay';
import { handleApi } from '../src/api';
import { workOrderOf, nextWorkOrderHistory } from '../src/casedetail';
import type { Env, Store, Mailer, ReportDoc } from '../src/contracts';
import type { CityAsk } from '../../shared/types';

// ── The city's templates, as relayed (2026-10-16; reporter details replaced) ──────────────
const RECEIPT_SUBJ = 'You service request has been receieved by PVD311 (PVD2026-90104 Speeding and Traffic Calming Concerns ) PVD311:0257182';
const RECEIPT = `[cid:image.jpeg@0cf43629ebbb73799934536.0cf43629e]\n\n\n\nRE: PVD2026-90104 Speeding and Traffic Calming Concerns\n\n\n\nDear FixMyPVD fixmypvd.org,\n\nThank you for submitting your service request through the PVD311 Constituent Service Hub. Your request has been successfully received and logged into our PVD311 system. A Constituent Service Representative will review the details and route it to the appropriate department for action.\nWe appreciate you taking the time to report this concern and for helping us serve our community more effectively.\nIf you need to provide additional information, please reply to this email or contact PVD311 by dialing 3-1-1 (within Providence) or 401-421-2489.\nRegards,\nPVD311 Constituent Services`;
const ROUTED_SUBJ = 'Your service request has been received: PVD2026-90090 Sinkhole Concern PVD311:0250700';
const ROUTED = `THIS IS AN AUTOMATED SYSTEM MESSAGE FROM PVD311.\nYour service request has been received and routed for review and action. Below are the details of your request:\nService Request/Issue to Report:Sinkhole Concern﻿\nService Request Number:  PVD2026-90090﻿\nDescription: Road surface damaged.\nAddress to Report: 25 Dorrance St, Providence, RI, 02903, USA﻿\nDepartment Assigned:﻿ DPW Sewer﻿\nNext Steps:\nOnce we receive an update from the assigned city department, we will send you an email.`;
const ASK_SUBJ = 'PVD311 needs more information regarding your service request PVD311:0250715';
const ASK = `[cid:image.jpeg@cb04b158b9de0eb7e22a521.cb04b158b]\n\n\n\nDear FixMyPVD fixmypvd.org,\n\nThank you for using PVD311. We noticed that you began to submit a service request (PVD2026-90113 Noise or Sound Disturbances) but did not provide important information needed to properly submit this service request. In order to submit this to the appropriate city department, please respond to this email by providing the address and details of your request.\nOnce we have this information, we will be able to inform the appropriate city department for action and resolution.\nRegards,\nPVD311 Constituent Services\npvd311@providence.ri.gov<mailto:pvd311@providence.ri.gov> | 311.providenceri.gov`;
const REFERRAL_SUBJ = 'PVD2026-90091 Permit Issues at a Construction Site PVD311:0250713';
const REFERRAL = `Dear FixMyPVD fixmypvd.org﻿\nWe are writing to provide an update regarding your PVD311 service request. As previously informed, your service request has been referred to the Department of Inspections and Standards (DIS) for review and processing.\nFor questions about the inspection or enforcement process, DIS has indicated that you can contact them directly at (401) 680-5350 and provide the Code # referenced in your service request.\nIf you do not receive an update from DIS or need additional assistance, please call 3-1-1 or reply to this email. PVD311 will be happy to follow up.`;

const env = {
  RELAY_ADDRESS: 'cases@fixmypvd.org', CITY_SENDER_DOMAINS: 'providenceri.gov', APP_BASE_URL: 'https://fixmypvd.org', APP_NAME: 'FixMyPVD',
  NOTIFY_EMAIL: 'rob@fixmypvd.org', ANTHROPIC_API_KEY: '',
} as unknown as Env;

const ID = 'm3hPCS9K2-UfxNBB6Fscbg';
const ASKED_AT = '2026-10-16T15:53:08.542Z';
const askMsg = { at: ASKED_AT, from: 'pvd311@providenceri.gov', subject: ASK_SUBJ, text: ASK, caseId: 'PVD2026-90113', messageId: '<ask-1@providenceri.gov>' };

function report(over: Partial<ReportDoc> = {}): ReportDoc {
  return {
    id: ID, timestamp: '2026-10-16T15:43:20Z' as any, category: 'noise', address: '25 Dorrance St', lat: 41.8236, lng: -71.4128,
    description: 'Loud music every night', photo: null, reporterName: null, reporterEmail: 'owner@example.com', ownerUid: 'uid_owner', followerUids: ['uid_fan'],
    status: 'submitted', statusDetail: null, portalCaseId: 'PVD2026-90113', portalStatus: 'Submitted', statusUpdatedAt: null,
    cityMessages: [askMsg], ...over,
  } as ReportDoc;
}

function deps(r: ReportDoc | null = report(), over: Partial<Store> = {}) {
  let current = r;
  const store = {
    fetchReport: vi.fn(async (id: string) => (current && id === current.id ? current : null)),
    findByPortalCaseId: vi.fn(async (c: string) => (current && current.portalCaseId === c ? current : null)),
    findByPortalCaseIdCandidate: vi.fn(async () => null),
    patchReport: vi.fn(async (_id: string, f: Record<string, unknown>) => { if (current) current = { ...current, ...f } as ReportDoc; }),
    addEvent: vi.fn(async () => {}), getMeta: vi.fn(async () => null), setMeta: vi.fn(async () => {}),
    getUser: vi.fn(async (uid: string) => (uid === 'uid_fan' ? { uid, email: 'fan@example.com', prefs: {}, following: [] } : uid === 'uid_owner' ? { uid, email: 'owner@example.com', prefs: { emailUpdates: false }, following: [] } : null)),
    ...over,
  } as unknown as Store;
  const mailer = {
    send: vi.fn(async () => null), alert: vi.fn(async () => {}), sendTo: vi.fn(async () => {}),
    sendAsRelay: vi.fn(async () => ({ ok: true, id: 'resend_1', error: null })),
  } as unknown as Mailer;
  return { store, mailer, sleep: vi.fn(async () => {}), get report() { return current; } };
}
const kinds = (store: Store) => (store.addEvent as any).mock.calls.map((c: any[]) => c[0].kind);

describe('classifyCityMail (rules on the real templates)', () => {
  it('receipt / routed (+ Department Assigned) / ask / update', () => {
    expect(classifyCityMail(RECEIPT_SUBJ, RECEIPT)).toEqual({ kind: 'receipt', dept: null });
    expect(classifyCityMail(ROUTED_SUBJ, ROUTED)).toEqual({ kind: 'routed', dept: 'DPW Sewer' });
    expect(classifyCityMail(ASK_SUBJ, ASK).kind).toBe('ask');
    expect(classifyCityMail(REFERRAL_SUBJ, REFERRAL).kind).toBe('update');
  });
  it('an ask without the template subject is still an ask; boilerplate "reply to this email" lines are not', () => {
    expect(classifyCityMail('Re: your request', 'Hi, could you please confirm which pole has the light out?').kind).toBe('ask');
    expect(classifyCityMail('Update', 'We need additional details about the location.').kind).toBe('ask');
    expect(classifyCityMail('Closed', 'Your request is closed. Please provide your feedback in our short survey.').kind).toBe('update');
    expect(classifyCityMail('Update', 'If you need to provide additional information, please reply to this email.').kind).toBe('update');
  });
  it('classifyInbound only asks the AI about non-template mail, and never without a key', async () => {
    expect(await classifyInbound(env, ASK_SUBJ, ASK)).toEqual({ kind: 'ask', dept: null, by: 'rule' });
    expect(await classifyInbound(env, REFERRAL_SUBJ, REFERRAL)).toEqual({ kind: 'update', dept: null, by: 'rule' });
  });
});

describe('reply parsing', () => {
  it('keeps only the top of a reply (Gmail, Apple, Outlook, Spanish, quote marks, phone signatures)', () => {
    expect(extractReplyText('It is the house at 12 Example St, 2nd floor.\n\nOn Fri, Oct 16, 2026 at 4:12 PM FixMyPVD <updates@fixmypvd.org> wrote:\n> The city needs more information')).toBe('It is the house at 12 Example St, 2nd floor.');
    expect(extractReplyText('Corner of Broad and Elm.\n\nSent from my iPhone\n\nOn Oct 16, 2026, at 4:12 PM, FixMyPVD\n<updates@fixmypvd.org> wrote:\n\n> x')).toBe('Corner of Broad and Elm.');
    expect(extractReplyText('Back yard, every night after 11pm.\r\n\r\n________________________________\r\nFrom: FixMyPVD <updates@fixmypvd.org>\r\nSent: Friday')).toBe('Back yard, every night after 11pm.');
    expect(extractReplyText('Es la casa azul.\n\nEl vie, 16 oct 2026 a las 16:12, FixMyPVD (<updates@fixmypvd.org>)\nescribió:\n> ...')).toBe('Es la casa azul.');
    expect(extractReplyText('> only quoted\n> text')).toBe('');
  });
  it('portal note times are UTC "M/D/YYYY h:mm AM"', () => {
    expect(parseNoteTime('10/16/2026 3:53 PM')).toBe('2026-10-16T15:53:00.000Z');
    expect(parseNoteTime('10/16/2026 12:07 AM')).toBe('2026-10-16T00:07:00.000Z');
    expect(parseNoteTime('a day ago')).toBeNull();
  });
});

describe('syncCityAsks', () => {
  const now = new Date('2026-10-16T21:00:00Z');
  it('records a new ask and mails the owner only — "reply or answer in the app" — once', async () => {
    const d = deps();
    const s = await syncCityAsks(env, d, d.report!, { now });
    expect(s).toEqual({ opened: 1, notified: 1, reminded: 0 });
    const sent = (d.mailer.sendTo as any).mock.calls;
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('owner@example.com'); // even with email updates off: the case stalls without an answer
    expect(sent[0][1]).toBe('The city needs more information about your report (PVD2026-90113)');
    expect(sent[0][2]).toContain('please respond to this email by providing the address and details');
    expect(sent[0][2]).not.toContain('[cid:');
    expect(sent[0][2]).toContain(`https://fixmypvd.org/r/${ID}#answer`);
    expect(sent[0][3]).toEqual({ replyTo: 'cases@fixmypvd.org', kind: 'ask', reportId: ID, caseId: 'PVD2026-90113' });
    const asks = d.report!.cityAsks!;
    expect(asks).toHaveLength(1);
    expect(asks[0]).toMatchObject({ at: ASKED_AT, source: 'email', from: 'pvd311@providenceri.gov', subject: ASK_SUBJ, messageId: '<ask-1@providenceri.gov>', by: 'rule', notifiedAt: now.toISOString() });
    expect(kinds(d.store)).toContain('city.ask');
    // idempotent
    expect(await syncCityAsks(env, d, d.report!, { now })).toEqual({ opened: 0, notified: 0, reminded: 0 });
    expect(d.mailer.sendTo).toHaveBeenCalledTimes(1);
  });
  it('PVD2026-90113 as stored (email ask + its portal note a few seconds apart): one ask, from the email — subject, sender, Message-ID', async () => {
    const note = { postedOn: '10/16/2026 3:53 PM', modifiedOn: '10/16/2026 3:53 PM', from: 'PVD 311', to: 'FixMyPVD fixmypvd.org', createdBy: null, attachments: [], text: ASK.replace(/\[cid:[^\]]+\]\n*/g, '').replace(/\n+/g, ' ') };
    const r = report({ portalDetail: { capturedAt: '2026-10-16T16:01:54Z', hash: 'h', fields: {}, notes: [note] } });
    const { asksOf } = await import('../src/cityask');
    expect(asksOf(r)).toHaveLength(1);
    expect(asksOf(r)[0]).toMatchObject({ source: 'email', subject: ASK_SUBJ, from: 'pvd311@providenceri.gov' });
    const d = deps(r);
    await syncCityAsks(env, d, d.report!, { now });
    expect(d.report!.cityAsks).toHaveLength(1);
    expect(d.report!.cityAsks![0]).toMatchObject({ source: 'email', subject: ASK_SUBJ, messageId: '<ask-1@providenceri.gov>' });
    const pub = await call(deps(r), 'GET', `/api/reports/${ID}`);
    expect(pub.body.timeline.filter((t: any) => t.kind === 'city_ask')).toHaveLength(1);
  });
  it('an ask first found as a portal note takes the email copy when it arrives (answers then thread on the CRM token)', async () => {
    const note = { postedOn: '10/16/2026 3:53 PM', modifiedOn: '10/16/2026 3:53 PM', from: 'PVD 311', to: null, createdBy: null, attachments: [], text: 'Please respond to this email by providing the address and details of your request.' };
    const d = deps(report({ cityMessages: [], portalDetail: { capturedAt: '2026-10-16T16:01:54Z', hash: 'h', fields: {}, notes: [note] } }));
    await syncCityAsks(env, d, d.report!, { now });
    expect(d.report!.cityAsks![0]).toMatchObject({ source: 'portal', subject: '' });
    await d.store.patchReport(ID, { cityMessages: [askMsg] });
    expect((await syncCityAsks(env, d, d.report!, { now })).opened).toBe(0);
    expect(d.report!.cityAsks).toHaveLength(1);
    expect(d.report!.cityAsks![0]).toMatchObject({ source: 'email', subject: ASK_SUBJ, from: 'pvd311@providenceri.gov', messageId: '<ask-1@providenceri.gov>' });
    expect(d.mailer.sendTo).toHaveBeenCalledTimes(1); // no second "the city needs more information"
  });
  it('the same ask seen as an email and as a portal note is one ask', async () => {
    const note = { postedOn: '10/16/2026 3:53 PM', modifiedOn: '10/16/2026 3:53 PM', from: 'PVD 311', to: 'FixMyPVD fixmypvd.org', createdBy: null, attachments: [], text: ASK.replace(/\[cid:[^\]]+\]\n*/g, '').replace(/\n+/g, ' ') };
    const r = report({ portalDetail: { capturedAt: '2026-10-16T16:01:54Z', hash: 'h', fields: {}, notes: [note] } });
    expect(askCandidates(r)).toHaveLength(2);
    const d = deps(r);
    expect((await syncCityAsks(env, d, d.report!, { now })).opened).toBe(1);
    // a portal-only ask (relay missed the mail) is found and mailed
    const d2 = deps(report({ cityMessages: [], portalDetail: { capturedAt: '2026-10-16T16:01:54Z', hash: 'h', fields: {}, notes: [note] } }));
    expect(await syncCityAsks(env, d2, d2.report!, { now })).toEqual({ opened: 1, notified: 1, reminded: 0 });
    expect(d2.report!.cityAsks![0]).toMatchObject({ source: 'portal', from: null, at: '2026-10-16T15:53:00.000Z' });
  });
  it('our own portal comments never count as asks', () => {
    const own = { postedOn: '10/16/2026 3:53 PM', modifiedOn: null, from: 'FixMyPVD fixmypvd.org', to: 'PVD 311', createdBy: null, attachments: [], text: 'Could you please confirm the address?' };
    expect(askCandidates(report({ cityMessages: [], portalDetail: { capturedAt: 'x', hash: 'h', fields: {}, notes: [own] } }))).toEqual([]);
  });
  it('reminds once, 48 h after the mail, while unanswered', async () => {
    const d = deps();
    await syncCityAsks(env, d, d.report!, { now });
    await syncCityAsks(env, d, d.report!, { now: new Date(now.getTime() + ASK_REMIND_AFTER_MS - 60_000) });
    expect(d.mailer.sendTo).toHaveBeenCalledTimes(1);
    expect((await syncCityAsks(env, d, d.report!, { now: new Date(now.getTime() + ASK_REMIND_AFTER_MS) })).reminded).toBe(1);
    expect((d.mailer.sendTo as any).mock.calls[1][1]).toBe('Reminder: the city is waiting for more information (PVD2026-90113)');
    expect((await syncCityAsks(env, d, d.report!, { now: new Date(now.getTime() + 3 * ASK_REMIND_AFTER_MS) })).reminded).toBe(0);
  });
  it('no reminder once answered', async () => {
    const d = deps();
    await syncCityAsks(env, d, d.report!, { now });
    const asks = d.report!.cityAsks!.map((a) => ({ ...a, answers: [{ at: now.toISOString(), via: 'app' as const, text: 'x', status: 'sent' as const }] }));
    await d.store.patchReport(ID, { cityAsks: asks });
    expect((await syncCityAsks(env, d, d.report!, { now: new Date(now.getTime() + ASK_REMIND_AFTER_MS) })).reminded).toBe(0);
  });
  it('records without mail when the case is closed or the ask is old; skips mail younger than settleMs', async () => {
    const closed = deps(report({ portalStatus: 'Resolved' }));
    expect(await syncCityAsks(env, closed, closed.report!, { now })).toEqual({ opened: 1, notified: 0, reminded: 0 });
    expect(closed.report!.cityAsks![0].notifiedAt).toBeNull();
    const old = deps();
    expect((await syncCityAsks(env, old, old.report!, { now: new Date('2026-10-30T00:00:00Z') })).notified).toBe(0);
    const fresh = deps();
    expect((await syncCityAsks(env, fresh, fresh.report!, { now: new Date('2026-10-16T15:55:00Z'), settleMs: 10 * 60_000 })).opened).toBe(0);
  });
  it('never throws (a failing store is logged)', async () => {
    const d = deps(report(), { patchReport: vi.fn(async () => { throw new Error('firestore down'); }) });
    await expect(syncCityAsks(env, d, d.report!, { now })).resolves.toMatchObject({ opened: 1 });
    expect(kinds(d.store)).toContain('city.ask_failed');
  });
});

function asked(over: Partial<CityAsk> = {}, r: Partial<ReportDoc> = {}): ReportDoc {
  const ask: CityAsk = { id: 'ask1', at: ASKED_AT, source: 'email', from: 'pvd311@providenceri.gov', subject: ASK_SUBJ, text: 'please respond…', messageId: '<ask-1@providenceri.gov>', by: 'rule', notifiedAt: ASKED_AT, answers: [], ...over };
  return report({ cityAsks: [ask], ...r });
}
const clean = async () => [] as string[];

describe('answerCityAsk', () => {
  const now = new Date('2026-10-16T21:00:00Z');
  it('mails the city from the relay address, "RE: <city subject>" (CRM token kept) + case id, threaded, with the original report', async () => {
    const d = deps(asked());
    const res = await answerCityAsk(env, { ...d, moderate: clean }, d.report!, { text: '  The noise is from 30 Example St, back yard, after 11pm.  ', via: 'app' }, now);
    expect(res.ok).toBe(true);
    const mail = (d.mailer.sendAsRelay as any).mock.calls[0][0];
    expect(mail.to).toBe('pvd311@providenceri.gov');
    expect(mail.subject).toBe(`RE: ${ASK_SUBJ} (PVD2026-90113)`);
    expect(mail.subject).toContain('PVD311:0250715');
    expect(mail.inReplyTo).toBe('<ask-1@providenceri.gov>');
    expect(mail.text).toContain('The noise is from 30 Example St, back yard, after 11pm.');
    expect(mail.text).toContain('service request PVD2026-90113 (Noise complaint)');
    expect(mail.text).toContain('Address: 25 Dorrance St');
    expect(mail.text).toContain('https://maps.google.com/?q=41.823600,-71.412800');
    expect(mail.text).toContain(`[FixMyPVD ref:${ID}]`);
    expect(mail.html).not.toContain('<script');
    const answers = d.report!.cityAsks![0].answers!;
    expect(answers).toEqual([{ at: now.toISOString(), via: 'app', text: 'The noise is from 30 Example St, back yard, after 11pm.', status: 'sent', reason: null, emailId: 'resend_1' }]);
    expect(kinds(d.store)).toContain('city.answer_sent');
  });
  it('blocks spam/abuse (recorded, nothing sent); other moderation flags pass', async () => {
    const d = deps(asked());
    const res = await answerCityAsk(env, { ...d, moderate: async () => ['abuse', 'personal_info'] }, d.report!, { text: 'f*** city hall', via: 'app' }, now);
    expect(res).toMatchObject({ ok: false, error: 'blocked', flags: ['abuse'] });
    expect(d.mailer.sendAsRelay).not.toHaveBeenCalled();
    expect(d.report!.cityAsks![0].answers![0]).toMatchObject({ status: 'blocked', reason: 'abuse' });
    const ok = deps(asked());
    expect((await answerCityAsk(env, { ...ok, moderate: async () => ['personal_info'] }, ok.report!, { text: 'My neighbor at 30 Example St', via: 'app' }, now)).ok).toBe(true);
  });
  it('refuses: no ask, empty/too long, closed case, expired, too soon, too many', async () => {
    const m = { moderate: clean };
    const none = deps(report({ cityMessages: [] }));
    expect(await answerCityAsk(env, { ...none, ...m }, none.report!, { text: 'x', via: 'app' }, now)).toEqual({ ok: false, error: 'no_ask' });
    const d = deps(asked());
    expect((await answerCityAsk(env, { ...d, ...m }, d.report!, { text: '   ', via: 'app' }, now)).ok).toBe(false);
    expect(await answerCityAsk(env, { ...d, ...m }, d.report!, { text: 'x'.repeat(2001), via: 'app' }, now)).toEqual({ ok: false, error: 'invalid_text' });
    expect(await answerCityAsk(env, { ...d, ...m }, asked({}, { portalStatus: 'Resolved' }), { text: 'x', via: 'app' }, now)).toEqual({ ok: false, error: 'case_closed' });
    expect(await answerCityAsk(env, { ...d, ...m }, d.report!, { text: 'x', via: 'app' }, new Date('2026-10-31T00:00:00Z'))).toEqual({ ok: false, error: 'expired' });
    const recent = asked({ answers: [{ at: new Date(now.getTime() - 30_000).toISOString(), via: 'app', text: 'a', status: 'sent' }] });
    expect(await answerCityAsk(env, { ...d, ...m }, recent, { text: 'x', via: 'app' }, now)).toEqual({ ok: false, error: 'too_soon', retryAfterSec: 30 });
    const three = asked({ answers: [0, 1, 2].map((i) => ({ at: `2026-10-16T1${i}:00:00Z`, via: 'app' as const, text: 'a', status: 'sent' as const })) });
    expect(await answerCityAsk(env, { ...d, ...m }, three, { text: 'x', via: 'app' }, now)).toEqual({ ok: false, error: 'too_many' });
    expect(d.mailer.sendAsRelay).not.toHaveBeenCalled();
  });
  it('a portal-only ask (or a non-city sender) goes to the default 311 address', async () => {
    for (const from of [null, 'pvd311@providenceri.gov.evil.com']) {
      const d = deps(asked({ from, subject: '' }));
      await answerCityAsk(env, { ...d, moderate: clean }, d.report!, { text: 'Back yard', via: 'app' }, now);
      const mail = (d.mailer.sendAsRelay as any).mock.calls[0][0];
      expect(mail.to).toBe('pvd311@providenceri.gov');
      expect(mail.subject).toBe('RE: PVD2026-90113 — information you asked for');
    }
  });
  it('a failed send is recorded, alerts Rob and can be retried after the gap', async () => {
    const d = deps(asked());
    (d.mailer.sendAsRelay as any).mockResolvedValueOnce({ ok: false, id: null, error: 'Resend 500' });
    expect(await answerCityAsk(env, { ...d, moderate: clean }, d.report!, { text: 'Back yard', via: 'app' }, now)).toMatchObject({ ok: false, error: 'send_failed' });
    expect(d.mailer.alert).toHaveBeenCalled();
    expect(kinds(d.store)).toContain('city.answer_failed');
    expect(askState(d.report!.cityAsks![0], d.report!, now.getTime()).open).toBe(true); // failed ≠ answered
    expect((await answerCityAsk(env, { ...d, moderate: clean }, d.report!, { text: 'Back yard', via: 'app' }, new Date(now.getTime() + 61_000))).ok).toBe(true);
  });
  it('askEmail / cityAnswerMail escape HTML', () => {
    expect(askEmail({ reminder: false, caseId: 'C', category: 'noise', address: '<b>x</b>', trackUrl: 'https://fixmypvd.org/r/1', cityText: '<script>' }).html).not.toMatch(/<script>|<b>x/);
    expect(cityAnswerMail(asked(), asked().cityAsks![0], '<img src=x onerror=alert(1)>').html).not.toContain('<img');
  });
});

// ── relay.ts end to end ─────────────────────────────────────────────────────────────

function raw(o: { from: string; subject: string; text: string; dmarc?: string; messageId?: string }): string {
  return [`From: ${o.from}`, 'To: cases@fixmypvd.org', `Subject: ${o.subject}`, 'Date: Fri, 16 Oct 2026 15:53:08 +0000', `Message-ID: ${o.messageId ?? '<m1@example.com>'}`,
    `Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=${o.dmarc ?? 'pass'}`, 'Content-Type: text/plain; charset=utf-8', '', o.text].join('\r\n');
}
const inbound = (r: string, from: string) => ({ from, to: 'cases@fixmypvd.org', headers: new Headers(), raw: r });

describe('relay: city asks in, owner answers out', () => {
  it('a city ask: followers get the usual copy, the owner gets "the city needs more information", the ask is recorded', async () => {
    const d = deps(report({ cityMessages: [] }));
    const out = await handleInbound(inbound(raw({ from: 'PVD 311 <pvd311@providenceri.gov>', subject: ASK_SUBJ, text: ASK.replace('submit a service request (', 'submit a service request (PVD2026-90113 ').replace('(PVD2026-90113 PVD2026-90113', '(PVD2026-90113'), messageId: '<ask-9@providenceri.gov>' }), 'pvd311@providenceri.gov'), env, d);
    expect(out).toMatchObject({ kind: 'forwarded', caseId: 'PVD2026-90113', recipients: 2 });
    const calls = (d.mailer.sendTo as any).mock.calls;
    expect(calls.map((c: any[]) => c[0]).sort()).toEqual(['fan@example.com', 'owner@example.com']);
    expect(calls.find((c: any[]) => c[0] === 'fan@example.com')[1]).toMatch(/^Providence 311 on your report PVD2026-90113/);
    expect(calls.find((c: any[]) => c[0] === 'owner@example.com')[1]).toBe('The city needs more information about your report (PVD2026-90113)');
    expect(d.report!.cityMessages!.at(-1)).toMatchObject({ kind: 'ask', by: 'rule', messageId: '<ask-9@providenceri.gov>' });
    expect(d.report!.cityAsks![0]).toMatchObject({ source: 'email', messageId: '<ask-9@providenceri.gov>' });
  });
  it('a routing email stores its department; the owner gets the usual copy', async () => {
    const d = deps(report({ cityMessages: [], portalCaseId: 'PVD2026-90090' }));
    await handleInbound(inbound(raw({ from: 'pvd311@providenceri.gov', subject: ROUTED_SUBJ, text: ROUTED }), 'pvd311@providenceri.gov'), env, d);
    expect(d.report!.cityMessages![0]).toMatchObject({ kind: 'routed', dept: 'DPW Sewer' });
    expect(d.report!.cityAsks).toBeUndefined();
    expect((d.mailer.sendTo as any).mock.calls.map((c: any[]) => c[0]).sort()).toEqual(['fan@example.com']); // owner opted out of updates
  });
  it("the owner's emailed reply (DMARC pass) goes to the city, and they get a receipt", async () => {
    const d = deps(asked());
    const text = 'It is 30 Example St, the back yard.\n\nOn Fri, Oct 16, 2026 at 4:12 PM FixMyPVD <updates@fixmypvd.org> wrote:\n> The city needs more information';
    const out = await handleInbound(inbound(raw({ from: 'Owner <OWNER@example.com>', subject: 'Re: The city needs more information about your report (PVD2026-90113)', text }), 'owner@example.com'), env, d);
    expect(out).toEqual({ kind: 'answer', caseId: 'PVD2026-90113', reportId: ID, outcome: 'sent' });
    const mail = (d.mailer.sendAsRelay as any).mock.calls[0][0];
    expect(mail.text).toContain('It is 30 Example St, the back yard.');
    expect(mail.text).not.toContain('The city needs more information');
    expect(mail.text).not.toContain('updates@fixmypvd.org');
    expect(d.report!.cityAsks![0].answers![0]).toMatchObject({ via: 'email', status: 'sent' });
    const receipt = (d.mailer.sendTo as any).mock.calls[0];
    expect(receipt[0]).toBe('owner@example.com');
    expect(receipt[1]).toBe('We sent your answer to the city (PVD2026-90113)');
    expect(d.mailer.alert).not.toHaveBeenCalled();
  });
  it('an emailed answer works before the watcher has recorded the ask (it is recorded with the answer, unmailed)', async () => {
    const d = deps(report()); // the ask is only in cityMessages
    const out = await handleInbound(inbound(raw({ from: 'owner@example.com', subject: 'Re: Providence 311 on your report PVD2026-90113: PVD311 needs more information regarding your service request', text: 'Back yard' }), 'owner@example.com'), env, d);
    expect(out).toMatchObject({ kind: 'answer', outcome: 'sent' });
    expect(d.report!.cityAsks![0]).toMatchObject({ notifiedAt: null, answers: [expect.objectContaining({ via: 'email', status: 'sent', text: 'Back yard' })] });
  });
  it('an unverified owner reply is not sent; they get the app link', async () => {
    const d = deps(asked());
    const out = await handleInbound(inbound(raw({ from: 'owner@example.com', subject: 'Re: The city needs more information about your report (PVD2026-90113)', text: 'Back yard', dmarc: 'none' }), 'owner@example.com'), env, d);
    expect(out).toMatchObject({ kind: 'answer', outcome: 'unverified' });
    expect(d.mailer.sendAsRelay).not.toHaveBeenCalled();
    expect((d.mailer.sendTo as any).mock.calls[0][2]).toContain(`/r/${ID}#answer`);
  });
  it('a refused emailed answer tells the owner why', async () => {
    const d = deps(asked({}, { portalStatus: 'Resolved' }));
    await handleInbound(inbound(raw({ from: 'owner@example.com', subject: 'Re: The city needs more information about your report (PVD2026-90113)', text: 'Back yard' }), 'owner@example.com'), env, d);
    expect(d.mailer.sendAsRelay).not.toHaveBeenCalled();
    expect((d.mailer.sendTo as any).mock.calls[0][1]).toBe("We couldn't send your answer (PVD2026-90113)");
    expect((d.mailer.sendTo as any).mock.calls[0][2]).toContain('already closed');
  });
  it('a reply to other mail (status mail says "Reply to stop updates") or a bare "stop" is never an answer', async () => {
    const status = deps(asked());
    expect(await handleInbound(inbound(raw({ from: 'owner@example.com', subject: 'Re: The city assigned your request (PVD2026-90113)', text: 'thanks!' }), 'owner@example.com'), env, status)).toMatchObject({ kind: 'reply' });
    const stop = deps(asked());
    expect(await handleInbound(inbound(raw({ from: 'owner@example.com', subject: 'Re: The city needs more information about your report (PVD2026-90113)', text: 'STOP\n\nOn Fri, Oct 16, 2026 at 4:12 PM FixMyPVD <updates@fixmypvd.org> wrote:\n> x' }), 'owner@example.com'), env, stop)).toMatchObject({ kind: 'reply' });
    const thanks = deps(asked());
    expect(await handleInbound(inbound(raw({ from: 'owner@example.com', subject: 'Re: We sent your answer to the city (PVD2026-90113)', text: 'Thank you!' }), 'owner@example.com'), env, thanks)).toMatchObject({ kind: 'reply' });
    expect(status.mailer.sendAsRelay).not.toHaveBeenCalled();
    expect(stop.mailer.sendAsRelay).not.toHaveBeenCalled();
    expect(thanks.mailer.sendAsRelay).not.toHaveBeenCalled();
  });
  it("a reply to the city's own ask as relayed counts, and attachments are noted in the receipt", async () => {
    const d = deps(asked());
    const r = raw({ from: 'owner@example.com', subject: 'Re: Providence 311 on your report PVD2026-90113: PVD311 needs more information regarding your service request', text: 'Back yard' });
    const withFile = r.replace('Content-Type: text/plain; charset=utf-8\r\n\r\nBack yard', 'Content-Type: multipart/mixed; boundary="b"\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nBack yard\r\n--b\r\nContent-Type: image/jpeg\r\nContent-Disposition: attachment; filename="a.jpg"\r\nContent-Transfer-Encoding: base64\r\n\r\n/9j/4AAQ\r\n--b--');
    expect(await handleInbound(inbound(withFile, 'owner@example.com'), env, d)).toMatchObject({ kind: 'answer', outcome: 'sent' });
    expect((d.mailer.sendAsRelay as any).mock.calls[0][0].text).toContain('Back yard');
    expect((d.mailer.sendTo as any).mock.calls[0][2]).toContain("We can't pass along photos or files");
  });
  it('anyone else — or the owner on a case the city never asked about — still goes to Rob, nothing to the city', async () => {
    const stranger = deps(asked());
    expect(await handleInbound(inbound(raw({ from: 'someone@example.com', subject: 'Re: The city needs more information about your report (PVD2026-90113)', text: 'hi' }), 'someone@example.com'), env, stranger)).toMatchObject({ kind: 'reply' });
    expect(stranger.mailer.alert).toHaveBeenCalled();
    const noAsk = deps(report({ cityMessages: [] }));
    expect(await handleInbound(inbound(raw({ from: 'owner@example.com', subject: 'Re: Providence 311 on your report PVD2026-90113: Report Street Light Issue', text: 'thanks' }), 'owner@example.com'), env, noAsk)).toMatchObject({ kind: 'reply' });
    expect(stranger.mailer.sendAsRelay).not.toHaveBeenCalled();
    expect(noAsk.mailer.sendAsRelay).not.toHaveBeenCalled();
  });
});

// ── API ───────────────────────────────────────────────────────────────────────────

async function call(d: ReturnType<typeof deps>, method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { origin: 'https://fixmypvd.org' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const resp = (await handleApi(new Request(`https://api.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), env, { store: d.store, mailer: d.mailer, moderate: clean }))!;
  return { status: resp.status, body: (await resp.json()) as any };
}

describe('POST /api/reports/:id/answer', () => {
  it('owner only', async () => {
    expect((await call(deps(asked()), 'POST', `/api/reports/${ID}/answer`, undefined, { text: 'x' })).status).toBe(401);
    expect((await call(deps(asked()), 'POST', `/api/reports/${ID}/answer`, 'other', { text: 'x' })).body).toEqual({ error: 'not_owner' });
  });
  it('sends the answer (recording an ask the watcher has not recorded yet, without mailing about it)', async () => {
    const d = deps(report()); // ask only in cityMessages
    const r = await call(d, 'POST', `/api/reports/${ID}/answer`, 'owner', { text: 'Back yard of 30 Example St' });
    expect(r.status).toBe(200);
    expect(r.body.answer).toMatchObject({ via: 'app', status: 'sent', text: 'Back yard of 30 Example St' });
    expect(d.mailer.sendAsRelay).toHaveBeenCalledTimes(1);
    expect(d.mailer.sendTo).not.toHaveBeenCalled();
    expect(d.report!.cityAsks![0].notifiedAt).toBeNull();
    // the watcher then sees the ask as known — no "the city needs more information" mail after the fact
    expect((await syncCityAsks(env, d, d.report!, { now: new Date('2026-10-16T22:00:00Z') })).opened).toBe(0);
  });
  it('maps refusals to statuses', async () => {
    expect((await call(deps(report({ cityMessages: [] })), 'POST', `/api/reports/${ID}/answer`, 'owner', { text: 'x' })).status).toBe(409);
    expect((await call(deps(asked()), 'POST', `/api/reports/${ID}/answer`, 'owner', { text: '' })).status).toBe(400);
    expect((await call(deps(asked()), 'POST', `/api/reports/${ID}/answer`, 'owner', {})).status).toBe(400);
    const r = await call(deps(asked({ answers: [{ at: new Date().toISOString(), via: 'app', text: 'a', status: 'sent' }] })), 'POST', `/api/reports/${ID}/answer`, 'owner', { text: 'x' });
    expect(r.status).toBe(429);
    expect(r.body.error).toBe('too_soon');
  });
});

describe('tracking projection: the progress the city shows', () => {
  const WO_FIELDS = {
    cop_workordernumber: { label: 'Work Order Number', value: '0000206909', readonly: true },
    cop_workorderstatus: { label: 'Work Order Status', value: 'Completed', readonly: true },
    cop_workcompletedon: { label: 'Work Completed On', value: '2026-10-16T11:24:00.0000000Z', readonly: true },
    cop_surfacetype: { label: 'Surface', value: 'Select', readonly: false },
  };
  const full = () => report({
    portalStatus: 'Department Responded',
    cityMessages: [
      { at: '2026-10-16T11:47:00Z', from: 'pvd311@providenceri.gov', subject: RECEIPT_SUBJ, text: RECEIPT, caseId: 'PVD2026-90113' },
      { at: '2026-10-16T11:48:00Z', from: 'pvd311@providenceri.gov', subject: RECEIPT_SUBJ, text: RECEIPT, caseId: 'PVD2026-90113' },
      { at: '2026-10-16T13:07:13Z', from: 'pvd311@providenceri.gov', subject: ROUTED_SUBJ, text: ROUTED, caseId: 'PVD2026-90113', kind: 'routed', dept: 'DPW Sewer' },
      askMsg,
    ],
    portalDetail: { capturedAt: '2026-10-16T16:01:54Z', hash: 'h', notes: [], fields: WO_FIELDS },
  });
  it('public: receipt once, routing with its department, the ask (no words), the work order — and no PII', async () => {
    const { body } = await call(deps(full()), 'GET', `/api/reports/${ID}`);
    const rows = body.timeline;
    expect(rows.filter((t: any) => t.kind === 'city_receipt')).toHaveLength(1);
    expect(rows.find((t: any) => t.kind === 'city_routed')).toMatchObject({ label: 'The city sent it to DPW Sewer', vars: { dept: 'DPW Sewer' } });
    expect(rows.find((t: any) => t.kind === 'city_ask')).toEqual({ at: ASKED_AT, label: 'The city asked for more information', kind: 'city_ask' });
    expect(rows.find((t: any) => t.kind === 'work_order')).toMatchObject({ at: '2026-10-16T11:24:00.000Z', label: 'City work order 0000206909: Completed', vars: { number: '0000206909', status: 'Completed' } });
    expect(rows.some((t: any) => t.text)).toBe(false);
    expect(body.workOrder).toEqual({ number: '0000206909', status: 'Completed', completedAt: '2026-10-16T11:24:00.000Z' });
    expect(body.department).toBe('DPW Sewer');
    expect(body.cityAsk).toEqual({ askedAt: ASKED_AT, open: true, answered: false, answeredAt: null });
  });
  it('owner: the city words on every row, the ask text, answers and whether they can answer', async () => {
    const r = full();
    r.cityAsks = [{ id: 'ask1', at: ASKED_AT, source: 'email', from: 'pvd311@providenceri.gov', subject: ASK_SUBJ, text: 'please respond by providing the address', by: 'rule', notifiedAt: ASKED_AT,
      answers: [{ at: '2026-10-16T21:00:00Z', via: 'email', text: 'Back yard', status: 'sent' }, { at: '2026-10-16T20:00:00Z', via: 'app', text: 'f***', status: 'blocked' }] }];
    const { body } = await call(deps(r), 'GET', `/api/reports/${ID}`, 'owner');
    expect(body.cityAsk).toMatchObject({ id: 'ask1', open: false, answered: true, answeredAt: '2026-10-16T21:00:00Z', canAnswer: true, text: 'please respond by providing the address' });
    expect(body.cityAsk.answers).toHaveLength(2);
    expect(body.timeline.find((t: any) => t.kind === 'city_answer')).toMatchObject({ label: 'Answer sent to the city', text: 'Back yard' });
    expect(body.timeline.filter((t: any) => t.kind === 'city_answer')).toHaveLength(1); // blocked answers are not progress
    expect(body.timeline.find((t: any) => t.kind === 'city_routed').text).toContain('Department Assigned:');
    expect(body.timeline.find((t: any) => t.kind === 'city_routed').text).not.toContain('﻿');
    const other = await call(deps(r), 'GET', `/api/reports/${ID}`, 'other');
    expect(other.body.cityAsk).toEqual({ askedAt: ASKED_AT, open: false, answered: true, answeredAt: '2026-10-16T21:00:00Z' });
    expect(other.body.timeline.find((t: any) => t.kind === 'city_answer').text).toBeUndefined();
  });
  it('a routing email stored before kinds existed still yields its department', async () => {
    const r = report({ cityMessages: [{ at: '2026-10-16T13:07:13Z', from: 'pvd311@providenceri.gov', subject: ROUTED_SUBJ, text: ROUTED, caseId: 'PVD2026-90090' }] });
    const { body } = await call(deps(r), 'GET', `/api/reports/${ID}`);
    expect(body.department).toBe('DPW Sewer');
    expect(body.timeline.find((t: any) => t.kind === 'city_routed')).toMatchObject({ vars: { dept: 'DPW Sewer' } });
  });
  it('work order history: one row per change the watcher saw', async () => {
    const r = full();
    r.workOrderHistory = [
      { number: '0000206909', status: 'New Request', completedAt: null, at: '2026-10-16T13:30:00Z' },
      { number: '0000206909', status: 'Completed', completedAt: '2026-10-16T15:00:00Z', at: '2026-10-16T16:01:54Z' },
    ];
    const { body } = await call(deps(r), 'GET', `/api/reports/${ID}`);
    expect(body.timeline.filter((t: any) => t.kind === 'work_order').map((t: any) => [t.at, t.vars.status])).toEqual([['2026-10-16T13:30:00Z', 'New Request'], ['2026-10-16T15:00:00Z', 'Completed']]);
  });
  it('a closed case: the ask is no longer open', async () => {
    const { body } = await call(deps(report({ portalStatus: 'Resolved' })), 'GET', `/api/reports/${ID}`, 'owner');
    expect(body.cityAsk).toMatchObject({ open: false, answered: false, canAnswer: false });
  });
});

describe('work orders (casedetail)', () => {
  it('workOrderOf reads the city fields verbatim; nextWorkOrderHistory appends only on change', () => {
    const f = (status: string, number = '0000205328') => ({ cop_workordernumber: { label: '', value: number, readonly: true }, cop_workorderstatus: { label: '', value: status, readonly: true } });
    expect(workOrderOf({})).toBeNull();
    expect(workOrderOf(f('In Progress'))).toEqual({ number: '0000205328', status: 'In Progress', completedAt: null });
    const h1 = nextWorkOrderHistory(null, f('New Request'), 'a')!;
    expect(h1).toEqual([{ number: '0000205328', status: 'New Request', completedAt: null, at: 'a' }]);
    expect(nextWorkOrderHistory(h1, f('New Request'), 'b')).toBeNull();
    expect(nextWorkOrderHistory(h1, f('In Progress'), 'c')!.map((x) => x.status)).toEqual(['New Request', 'In Progress']);
    expect(nextWorkOrderHistory(h1, {}, 'd')).toBeNull();
  });
});
