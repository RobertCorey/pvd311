import { describe, it, expect, vi } from 'vitest';
import { parseInbound, extractCaseId, isCitySender, cleanSubject, handleInbound, relayEmail, htmlToText } from '../src/relay';
import type { Env, Store, Mailer, ReportDoc } from '../src/contracts';

const env = {
  RELAY_ADDRESS: 'cases@fixmypvd.org', CITY_SENDER_DOMAINS: 'providenceri.gov', APP_BASE_URL: 'https://fixmypvd.org',
  RELAY_FALLBACK_TO: 'rob@example.com', NOTIFY_EMAIL: 'rob@fixmypvd.org',
} as unknown as Env;

function raw(opts: { from?: string; to?: string; subject?: string; text?: string; html?: string; extra?: string } = {}): string {
  const from = opts.from ?? 'PVD 311 <pvd311@providenceri.gov>';
  const subject = opts.subject ?? 'PVD2026-71677 Report Un-shoveled Sidewalks PVD311:0287749';
  const head = [`From: ${from}`, `To: ${opts.to ?? 'cases@fixmypvd.org'}`, `Subject: ${subject}`, 'Date: Mon, 28 Sep 2026 12:00:00 -0400', 'Message-ID: <abc@providenceri.gov>', 'Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass', opts.extra ?? ''].filter(Boolean);
  if (opts.html) return `${head.join('\r\n')}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${opts.html}`;
  return `${head.join('\r\n')}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${opts.text ?? 'Case Title: Report Un-shoveled Sidewalks\nAddress to Report: 25 Dorrance St\nDepartment Assigned: DPW\nWe will email you on status change.'}`;
}
const msg = (r: string, from = 'pvd311@providenceri.gov') => ({ from, to: 'cases@fixmypvd.org', headers: new Headers(), raw: r });

function report(over: Partial<ReportDoc> = {}): ReportDoc {
  return { id: 'rep1', category: 'unshoveled_sidewalk', address: '25 Dorrance St', reporterEmail: 'neighbor@example.com', portalCaseId: 'PVD2026-71677', status: 'submitted', followers: ['friend@example.com'], ...over } as ReportDoc;
}
function deps(over: Partial<Store> = {}) {
  const store = {
    findByPortalCaseId: vi.fn(async (id: string) => (id === 'PVD2026-71677' ? report() : null)),
    patchReport: vi.fn(async () => {}), addEvent: vi.fn(async () => {}), getMeta: vi.fn(async () => null), setMeta: vi.fn(async () => {}),
    getUser: vi.fn(async () => null), ...over,
  } as unknown as Store;
  const mailer = { send: vi.fn(async () => null), alert: vi.fn(async () => {}), sendTo: vi.fn(async () => {}) } as unknown as Mailer;
  return { store, mailer };
}

describe('relay parsing', () => {
  it('parses a city confirmation and finds the case id', async () => {
    const m = await parseInbound(msg(raw()));
    expect(m.from).toBe('pvd311@providenceri.gov');
    expect(m.fromName).toBe('PVD 311');
    expect(m.subject).toContain('PVD2026-71677');
    expect(m.text).toContain('Department Assigned: DPW');
    expect(m.dmarc).toBe('pass');
    expect(m.autoSubmitted).toBe(false);
    expect(extractCaseId(m.subject, m.text)).toBe('PVD2026-71677');
  });
  it('falls back to the body for the case id and derives text from HTML', async () => {
    const m = await parseInbound(msg(raw({ subject: 'Your request was updated', html: '<html><body><p>Case <b>pvd2026-80001</b> is now</p><p>Resolved &amp; closed</p></body></html>' })));
    expect(m.text).toBe('Case pvd2026-80001 is now\nResolved & closed');
    expect(extractCaseId(m.subject, m.text)).toBe('PVD2026-80001');
  });
  it('flags auto-submitted mail', async () => {
    const m = await parseInbound(msg(raw({ extra: 'Auto-Submitted: auto-replied' })));
    expect(m.autoSubmitted).toBe(true);
  });
  it('isCitySender: domain + not dmarc-failed', () => {
    expect(isCitySender({ from: 'pvd311@providenceri.gov', dmarc: 'pass' }, env)).toBe(true);
    expect(isCitySender({ from: 'x@crm.providenceri.gov', dmarc: 'unknown' }, env)).toBe(true);
    expect(isCitySender({ from: 'pvd311@providenceri.gov', dmarc: 'fail' }, env)).toBe(false);
    expect(isCitySender({ from: 'pvd311@providenceri.gov.evil.com', dmarc: 'pass' }, env)).toBe(false);
    expect(isCitySender({ from: 'neighbor@example.com', dmarc: 'pass' }, env)).toBe(false);
  });
  it('cleanSubject strips the case id and CRM token', () => {
    expect(cleanSubject('RE: PVD2026-71677 Report Un-shoveled Sidewalks PVD311:0287749', 'PVD2026-71677')).toBe('Report Un-shoveled Sidewalks');
  });
  it('htmlToText keeps line breaks', () => {
    expect(htmlToText('<div>a</div><div>b<br>c</div><style>x{}</style>')).toBe('a\nb\nc');
  });
});

describe('handleInbound', () => {
  it('forwards a matching city email to reporter + followers with Reply-To and stores it', async () => {
    const d = deps();
    const out = await handleInbound(msg(raw()), env, d);
    expect(out).toMatchObject({ kind: 'forwarded', caseId: 'PVD2026-71677', reportId: 'rep1', recipients: 2 });
    const calls = (d.mailer.sendTo as any).mock.calls;
    expect(calls.map((c: any[]) => c[0]).sort()).toEqual(['friend@example.com', 'neighbor@example.com']);
    expect(calls[0][1]).toBe('Providence 311 on your report PVD2026-71677: Report Un-shoveled Sidewalks');
    expect(calls[0][2]).toContain('Department Assigned: DPW');
    expect(calls[0][2]).toContain('https://fixmypvd.org/r/rep1');
    expect(calls[0][3]).toEqual({ replyTo: 'cases@fixmypvd.org' });
    const patch = (d.store.patchReport as any).mock.calls[0];
    expect(patch[0]).toBe('rep1');
    expect(patch[1].cityMessages).toHaveLength(1);
    expect(patch[1].cityMessages[0]).toMatchObject({ from: 'pvd311@providenceri.gov', caseId: 'PVD2026-71677' });
    expect(d.mailer.alert).not.toHaveBeenCalled();
    expect((d.store.addEvent as any).mock.calls[0][0].kind).toBe('relay.forwarded');
  });
  it('caps stored city messages at 20', async () => {
    const old = Array.from({ length: 20 }, (_, i) => ({ at: `2026-09-0${i % 9 + 1}T00:00:00Z`, from: 'x', subject: `s${i}`, text: '', caseId: null }));
    const d = deps({ findByPortalCaseId: vi.fn(async () => report({ cityMessages: old })) });
    await handleInbound(msg(raw()), env, d);
    const stored = (d.store.patchReport as any).mock.calls[0][1].cityMessages;
    expect(stored).toHaveLength(20);
    expect(stored[0].subject).toBe('s1');
  });
  it('city email with no matching report goes to Rob', async () => {
    const d = deps();
    const out = await handleInbound(msg(raw({ subject: 'PVD2026-99999 Something PVD311:1' })), env, d);
    expect(out).toEqual({ kind: 'unmatched', caseId: 'PVD2026-99999' });
    expect(d.mailer.sendTo).not.toHaveBeenCalled();
    expect((d.mailer.alert as any).mock.calls[0][0]).toContain('PVD2026-99999');
  });
  it('city email with no case id goes to Rob', async () => {
    const d = deps();
    const out = await handleInbound(msg(raw({ subject: 'Portal maintenance tonight', text: 'The portal will be down.' })), env, d);
    expect(out).toEqual({ kind: 'unmatched', caseId: null });
    expect(d.mailer.alert).toHaveBeenCalled();
  });
  it('a reporter reply goes to Rob and never to the city or other reporters', async () => {
    const d = deps();
    const out = await handleInbound(msg(raw({ from: 'Neighbor <neighbor@example.com>', subject: 'Re: Providence 311 on your report PVD2026-71677: Report Un-shoveled Sidewalks', text: 'Still not fixed!' }), 'neighbor@example.com'), env, d);
    expect(out).toEqual({ kind: 'reply', caseId: 'PVD2026-71677' });
    expect(d.mailer.sendTo).not.toHaveBeenCalled();
    expect(d.store.patchReport).not.toHaveBeenCalled();
    const [subj, html] = (d.mailer.alert as any).mock.calls[0];
    expect(subj).toContain('neighbor@example.com');
    expect(html).toContain('Still not fixed!');
  });
  it('a spoofed city sender that fails DMARC is treated as a reply, not the city', async () => {
    const d = deps();
    const r = raw().replace('dmarc=pass', 'dmarc=fail');
    const out = await handleInbound(msg(r), env, d);
    expect(out.kind).toBe('reply');
    expect(d.mailer.sendTo).not.toHaveBeenCalled();
  });
  it('drops auto-replies and our own mail (loop guard)', async () => {
    const d = deps();
    expect((await handleInbound(msg(raw({ from: 'neighbor@example.com', extra: 'Auto-Submitted: auto-replied' }), 'neighbor@example.com'), env, d)).kind).toBe('dropped');
    expect((await handleInbound(msg(raw({ from: 'updates@fixmypvd.org' }), 'updates@fixmypvd.org'), env, d)).kind).toBe('dropped');
    expect((await handleInbound(msg(raw({ from: 'mailer-daemon@example.com' }), 'mailer-daemon@example.com'), env, d)).kind).toBe('dropped');
    expect(d.mailer.alert).not.toHaveBeenCalled();
    expect(d.mailer.sendTo).not.toHaveBeenCalled();
  });
  it('relayEmail never throws and forwards the raw mail to the fallback on failure', async () => {
    const d = deps({ findByPortalCaseId: vi.fn(async () => { throw new Error('firestore down'); }), patchReport: vi.fn(async () => {}) });
    // findByPortalCaseId errors are swallowed → unmatched; force a real throw via a broken mailer.alert
    (d.mailer.alert as any).mockImplementation(async () => { throw new Error('resend down'); });
    const forward = vi.fn(async () => {});
    const out = await relayEmail({ ...msg(raw()), forward }, env, d);
    expect(out).toBeNull();
    expect(forward).toHaveBeenCalledWith('rob@example.com');
  });
});
