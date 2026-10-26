import { test, expect, type Page } from '@playwright/test';
import { SESSION, TRACK_NEAR, TRACK_PT, feed, nearWire, type Case } from './street-mocks';
import { ENDPOINT, stubPush } from './push-mocks';

const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

interface ViewOverrides {
  status?: string; portalStatus?: string | null; portalCaseId?: string | null;
  photoUrl?: string | null; lat?: number | null; lng?: number | null;
  timeline?: { at: string; label: string; kind?: string; text?: string }[]; nextUpdateHint?: string | null;
  resolutionMessage?: string | null; mine?: boolean;
  notFiled?: { code: string; text: string; duplicateOf?: string | null } | null;
  cancelledByReporter?: boolean;
}

function view(o: ViewOverrides = {}) {
  const now = new Date().toISOString();
  return {
    id: 'abc',
    category: 'pothole',
    categoryLabel: 'Pothole',
    address: '120 Benefit St, Providence, RI',
    lat: 'lat' in o ? o.lat : TRACK_PT.lat,
    lng: 'lng' in o ? o.lng : TRACK_PT.lng,
    photoUrl: o.photoUrl ?? null,
    createdAt: now,
    status: o.status ?? 'sent',
    portalCaseId: 'portalCaseId' in o ? o.portalCaseId : 'PVD2026-87657',
    portalStatus: 'portalStatus' in o ? o.portalStatus : 'Assigned',
    timeline: o.timeline ?? [
      { at: now, label: 'Received by FixMyPVD' },
      { at: now, label: 'Sent to the city' },
    ],
    nextUpdateHint: o.nextUpdateHint ?? 'We check the city for updates daily.',
    notFiled: o.notFiled ?? null,
    cancelledByReporter: o.cancelledByReporter ?? false,
    resolutionMessage: o.resolutionMessage ?? null,
    ...(o.mine !== undefined ? { mine: o.mine } : {}),
  };
}

/** A not-filed report: rejected, no case id, `notFiled` set. */
function notFiledView(code: string, extra: Partial<ViewOverrides> = {}) {
  const now = new Date().toISOString();
  return view({
    status: 'rejected', portalStatus: null, portalCaseId: null,
    timeline: [{ at: now, label: 'Received' }, { at: now, label: 'Not filed' }],
    notFiled: { code, text: extra.notFiled?.text ?? '', duplicateOf: extra.notFiled?.duplicateOf ?? null },
    ...extra,
  });
}

async function mockReport(page: Page, body: object, status = 200) {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/reports/*`, (r) =>
    r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }));
  // "Near this request" (GET /api/street?lat&lng&radiusM&days): nothing nearby unless a test mocks its own set after this.
  await page.route(`${API}/api/street?*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(nearWire([], TRACK_PT)) }));
}

/** The nearby set for the report's point; `status` ≠ 200 is the failed fetch; `delayMs` holds the response (the skeleton). */
async function mockNear(page: Page, items: Case[], o: { status?: number; delayMs?: number } = {}): Promise<string[]> {
  const urls: string[] = [];
  await page.route(`${API}/api/street?*`, async (r) => {
    urls.push(r.request().url());
    if (o.delayMs) await new Promise((res) => setTimeout(res, o.delayMs));
    if (o.status && o.status !== 200) return r.fulfill({ status: o.status, contentType: 'application/json', body: '{"error":"boom"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(nearWire(items, TRACK_PT)) });
  });
  return urls;
}

/** A signed-in viewer: GET /api/me (digest off, no addresses), PUT /api/me/addresses and PATCH /api/me as the Worker answers them. */
/** A signed-in account whose GET/PATCH /api/me and PUT /api/me/addresses are mocked; returns the PUT/PATCH calls.
 *  `o.delayMs` holds every PUT/PATCH response that long (a slow Worker); `o.gets` counts GET /api/me. */
async function signedIn(page: Page, me: Record<string, unknown> = {}, o: { delayMs?: number; gets?: { n: number } } = {}): Promise<{ method: string; body: unknown }[]> {
  const calls: { method: string; body: unknown }[] = [];
  const hold = () => (o.delayMs ? new Promise((res) => setTimeout(res, o.delayMs)) : Promise.resolve());
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  let acct = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true, streetDigest: false }, addresses: [] as unknown[], following: [], cityFollowing: [], createdAt: new Date().toISOString(), ...me } as Record<string, unknown>;
  await page.route(`${API}/api/me`, async (r) => {
    if (r.request().method() === 'PATCH') {
      const body = r.request().postDataJSON();
      calls.push({ method: 'PATCH', body });
      await hold();
      acct = { ...acct, prefs: { ...(acct.prefs as object), ...(body.prefs ?? {}) } };
    } else if (r.request().method() === 'GET' && o.gets) o.gets.n += 1;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(acct) });
  });
  await page.route(`${API}/api/me/addresses`, async (r) => {
    const body = r.request().postDataJSON();
    calls.push({ method: 'PUT', body });
    await hold();
    acct = { ...acct, addresses: [{ id: 'a1', ...body }] };
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ addresses: acct.addresses }) });
  });
  return calls;
}

async function useSpanish(page: Page) {
  await page.addInitScript(() => localStorage.setItem('fixmypvd.lang', 'es'));
}

test('sent + In Progress lights "City working on it" on the rail and says the city is working on it', async ({ page }) => {
  // The first real case (PVD2026-89374) went Assigned → In Progress and the rail fell back to "Sent to 311".
  const now = new Date().toISOString();
  await mockReport(page, view({ portalStatus: 'In Progress', timeline: [
    { at: now, label: 'Received' }, { at: now, label: 'Filed with the city as PVD2026-87657' },
    { at: now, label: 'City status: Submitted' }, { at: now, label: 'City status: Assigned' }, { at: now, label: 'City status: In Progress' },
  ] }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'The city is working on it' })).toBeVisible();
  const rail = page.locator('.rail-step');
  await expect(rail.filter({ hasText: 'City working on it' })).toHaveClass(/rail-step--done/);
  await expect(rail.filter({ hasText: 'Closed by the city' })).toHaveClass(/rail-step--active/);
  // Every city status the watcher saw is its own row, oldest at the bottom.
  const rows = page.locator('.track-timeline li');
  await expect(rows.filter({ hasText: 'City status: In progress' })).toBeVisible();
  await expect(rows.filter({ hasText: 'City status: Assigned' })).toBeVisible();
  await expect(rows.filter({ hasText: 'City status: Submitted' })).toBeVisible();
  await expect(page.getByText("We'll email you as the status changes.")).toBeVisible();
});

test('sent + Merged reads as closed-by-city: merged headline, rail ends at Merged', async ({ page }) => {
  await mockReport(page, view({ portalStatus: 'Merged' }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'The city merged this into another report' })).toBeVisible();
  await expect(page.locator('.rail-step').filter({ hasText: 'Merged' })).toHaveClass(/rail-step--done/);
  await expect(page.getByRole('link', { name: 'Open the official 311 portal' })).toBeVisible();
});

test('sent + Assigned shows the case id and a city status row', async ({ page }) => {
  await mockReport(page, view());
  await page.goto('/r/abc');
  await expect(page.getByText('PVD2026-87657')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The city assigned your request' })).toBeVisible();
  await expect(page.getByText(/crew/i)).toHaveCount(0);
  await expect(page.getByText('Sent to the city')).toBeVisible();
});

test('unknown token shows the not-found state', async ({ page }) => {
  await mockReport(page, { error: 'not_found' }, 404);
  await page.goto('/r/missing');
  await expect(page.getByRole('heading', { name: /can.?t find that report/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /report something/i })).toBeVisible();
});

test('justSubmitted (?submitted=1) shows the confirmation header', async ({ page }) => {
  await mockReport(page, view());
  await page.goto('/r/abc?submitted=1');
  await expect(page.getByRole('heading', { name: /sent to providence 311/i })).toBeVisible();
  await expect(page.getByRole('button', { name: /copy link/i })).toBeVisible();
  await expect(page.getByRole('link', { name: /report another problem/i })).toBeVisible();
});

test('copy-link button writes the tracking url to the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await mockReport(page, view());
  await page.goto('/r/abc?submitted=1');
  await page.getByRole('button', { name: /copy link/i }).click();
  await expect(page.getByRole('button', { name: /copied/i })).toBeVisible();
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toContain('/r/abc');
});

test('filed report shows the case id as plain text (the portal has no public per-case URL to link to)', async ({ page }) => {
  const now = new Date().toISOString();
  await mockReport(page, view({ timeline: [{ at: now, label: 'Received' }, { at: now, label: 'Filed with the city as PVD2026-87657' }] }));
  await page.goto('/r/abc');
  await expect(page.locator('.track-case')).toHaveText(/PVD2026-87657/);
  await expect(page.locator('a.track-case')).toHaveCount(0);
  await expect(page.locator('.track-timeline').getByRole('link')).toHaveCount(0);
  await expect(page.getByText(/about half of requests are closed within a week/i)).toBeVisible();
});

test('cancelled report explains and links to the official portal', async ({ page }) => {
  await mockReport(page, view({ portalStatus: 'Cancelled' }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: /the city closed this one/i })).toBeVisible();
  await expect(page.locator('.track-status').getByRole('link', { name: /official 311 portal/i })).toBeVisible();
});

test('not filed (duplicate) shows the reason, both next steps, and no case number', async ({ page }) => {
  await mockReport(page, notFiledView('duplicate', {
    notFiled: { code: 'duplicate', text: 'Someone reported this pothole two days ago.', duplicateOf: 'xyz789' },
  }));
  await page.goto('/r/abc');
  await expect(page.locator('.track-status').getByRole('heading', { name: /^not filed$/i })).toBeVisible();
  await expect(page.getByText('Someone reported this pothole two days ago.')).toBeVisible();
  await expect(page.getByRole('link', { name: /view that report/i })).toHaveAttribute('href', '/r/xyz789');
  await expect(page.getByRole('link', { name: /report anyway/i })).toHaveAttribute('href', '/');
  await expect(page.getByText('No city case number — this was never filed with 311.')).toBeVisible();
  // no contradictory city-case chip when nothing was filed
  await expect(page.locator('.track-case')).toHaveCount(0);
  // rail ends at the failure — no future steps ahead
  await expect(page.getByText('City working on it')).toHaveCount(0);
  await expect(page.getByText('Resolved', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: process.env.NOTFILED_SHOT || 'notfiled.png', fullPage: true });
});

for (const code of ['reviewed', 'outside', 'no_photo']) {
  test(`not filed (${code}) offers report-again with a photo and location`, async ({ page }) => {
    await mockReport(page, notFiledView(code, { notFiled: { code, text: 'We couldn’t confirm the location.' } }));
    await page.goto('/r/abc');
    await expect(page.locator('.track-status').getByRole('heading', { name: /^not filed$/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /report again with a photo and the exact location/i })).toHaveAttribute('href', '/');
    await expect(page.getByText('City working on it')).toHaveCount(0);
  });
}

test('not filed (failed) says a person is looking at it, with nothing to do', async ({ page }) => {
  await mockReport(page, notFiledView('failed', { notFiled: { code: 'failed', text: '' } }));
  await page.goto('/r/abc');
  await expect(page.locator('.track-status').getByRole('heading', { name: /^not filed$/i })).toBeVisible();
  await expect(page.getByText(/a person is looking at it/i)).toBeVisible();
  await expect(page.getByRole('link', { name: /report again/i })).toHaveCount(0);
});

test('cancelled-by-you stays distinct from not filed and shows no case number', async ({ page }) => {
  await mockReport(page, notFiledView('cancelled', { cancelledByReporter: true, notFiled: { code: 'cancelled', text: '' } }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: /cancelled by you/i })).toBeVisible();
  await expect(page.locator('.track-status').getByRole('heading', { name: /^not filed$/i })).toHaveCount(0);
  await expect(page.getByText('No city case number — this was never filed with 311.')).toBeVisible();
});

test('spanish localizes the not-filed heading, timeline labels, and category', async ({ page }) => {
  await useSpanish(page);
  await mockReport(page, notFiledView('reviewed', { notFiled: { code: 'reviewed', text: '' } }));
  await page.goto('/r/abc');
  await expect(page.locator('.track-status').getByRole('heading', { name: /no presentado/i })).toBeVisible();
  // server timeline labels ("Received", "Not filed") render localized
  await expect(page.locator('.track-timeline').getByText('Recibido')).toBeVisible();
  await expect(page.locator('.track-timeline').getByText('No presentado')).toBeVisible();
  // category from the key, not the English categoryLabel
  await expect(page.locator('.track-cat-label')).toHaveText('Bache');
  await expect(page.getByText('Pothole')).toHaveCount(0);
});

// PVD2026-90091 (2026-10-16): the city set "Resolved" because 311 referred the complaint to Inspections & Standards.
// We show the city's own Resolution Message verbatim, say "closed" in our words, and let the owner open the city's email.
const CITY_NOTE = 'Complaint (CODE-26-1465) has been received and logged into the system for review.';
const CITY_EMAIL = 'Hello,\n\nThank you for contacting PVD 311. Your request PVD2026-90091 has been updated.\n\nComplaint (CODE-26-1465) has been received and logged into the system for review.\n\n<b>not markup</b>\n\nPVD 311';
function closedView(o: { mine?: boolean; withText?: boolean } = {}) {
  const t0 = Date.now() - 6 * 86_400_000;
  const iso = (h: number) => new Date(t0 + h * 3_600_000).toISOString();
  return view({
    portalStatus: 'Resolved', portalCaseId: 'PVD2026-90091', resolutionMessage: CITY_NOTE, mine: o.mine, nextUpdateHint: null,
    timeline: [
      { at: iso(0), label: 'Received' }, { at: iso(1), label: 'Filed with the city as PVD2026-90091' },
      { at: iso(2), label: 'City status: Submitted' },
      { at: iso(100), label: 'City status: Resolved' },
      { at: iso(101), label: 'Message from the city: Your request  has been updated', kind: 'city_message', ...(o.withText === false ? {} : { text: CITY_EMAIL }) },
    ],
  });
}

test("Resolved case: neutral 'closed' wording, the city's note verbatim, and the owner can expand the city's email", async ({ page }) => {
  await mockReport(page, closedView({ mine: true }));
  await page.goto('/r/abc');
  const status = page.locator('.track-status');
  await expect(status.getByRole('heading', { name: 'The city closed this request' })).toBeVisible();
  await expect(page.getByText(/marked this resolved|resolved by the city/i)).toHaveCount(0);
  await expect(page.locator('.rail-step').last()).toHaveText('Closed by the city');
  await expect(page.locator('.rail-step').last()).toHaveClass(/rail-step--done/);
  // The city's note, attributed, quoted verbatim, under the status.
  await expect(status.getByText("The city's note:")).toBeVisible();
  await expect(status.locator('blockquote.track-city-note-text')).toHaveText(CITY_NOTE);
  // City status itself stays the city's word, attributed.
  await expect(page.locator('.track-timeline li').filter({ hasText: 'City status: Resolved' })).toBeVisible();
  // The city message row is a native disclosure: closed by default, opens on tap, shows plain text (no HTML rendering).
  const msg = page.locator('.track-timeline details.track-tl-msg');
  await expect(msg).toHaveCount(1);
  const summary = msg.locator('summary');
  await expect(summary).toHaveText('Message from the city: Your request has been updated');
  await expect(msg.locator('.track-tl-msg-text')).toBeHidden();
  await summary.click();
  await expect(msg).toHaveAttribute('open', '');
  const body = msg.locator('.track-tl-msg-text');
  await expect(body).toBeVisible();
  await expect(body).toContainText('Thank you for contacting PVD 311.');
  await expect(body).toContainText('<b>not markup</b>');
  await expect(body.locator('b')).toHaveCount(0);
  expect(await body.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
  // Keyboard: the summary is focusable and toggles with Enter.
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(msg).not.toHaveAttribute('open', '');
  await page.keyboard.press('Enter');
  await expect(body).toBeVisible();
  // Review shot (not asserted). The fixed tab bar is hidden only because a full-page capture would paint it mid-page.
  await page.screenshot({ path: process.env.CLOSED_SHOT || 'test-results/track-closed-note.png', fullPage: true, style: '.tabbar { display: none !important; }' });
});

test('public viewer of a Resolved case: sees the city note and the message subject, but no expandable body', async ({ page }) => {
  await mockReport(page, closedView({ withText: false }));
  await page.goto('/r/abc');
  await expect(page.locator('blockquote.track-city-note-text')).toHaveText(CITY_NOTE);
  await expect(page.locator('.track-timeline li').filter({ hasText: 'Message from the city: Your request has been updated' })).toBeVisible();
  await expect(page.locator('.track-timeline details')).toHaveCount(0);
});

test("the city's note shows whatever the status, and not at all when empty", async ({ page }) => {
  await mockReport(page, view({ portalStatus: 'Assigned', resolutionMessage: 'Referred to Forestry.' }));
  await page.goto('/r/abc');
  await expect(page.locator('blockquote.track-city-note-text')).toHaveText('Referred to Forestry.');
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  await mockReport(page, view({ portalStatus: 'Resolved', resolutionMessage: null }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'The city closed this request' })).toBeVisible();
  await expect(page.locator('.track-city-note')).toHaveCount(0);
});

test('spanish: closed wording, the city note label and the city message row are localized; the note stays verbatim', async ({ page }) => {
  await useSpanish(page);
  await mockReport(page, closedView({ mine: true }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'La ciudad cerró esta solicitud' })).toBeVisible();
  await expect(page.locator('.rail-step').last()).toHaveText('Cerrado por la ciudad');
  await expect(page.getByText('La nota de la ciudad:')).toBeVisible();
  await expect(page.locator('blockquote.track-city-note-text')).toHaveText(CITY_NOTE);
  await expect(page.locator('details.track-tl-msg summary')).toHaveText('Mensaje de la ciudad: Your request has been updated');
});

// ── The city asked for more information (Rob, 2026-10-16: relay it to the reporter, relay the answer back) ──

const ASK_TEXT = 'Dear FixMyPVD fixmypvd.org,\n\nWe noticed that you began to submit a service request (PVD2026-90113 Noise or Sound Disturbances) but did not provide important information needed. Please respond to this email by providing the address and details of your request.';
function askView(o: { mine?: boolean; answers?: { at: string; via: string; status: string; text: string }[]; open?: boolean; canAnswer?: boolean; portalStatus?: string } = {}) {
  const now = new Date().toISOString();
  const answers = o.answers ?? [];
  const mine = o.mine ?? true;
  const sent = answers.filter((a) => a.status === 'sent');
  return {
    ...view({ portalStatus: o.portalStatus ?? 'Submitted', portalCaseId: 'PVD2026-90113', timeline: [
      { at: now, label: 'Received' }, { at: now, label: 'Filed with the city as PVD2026-90113' },
      { at: now, label: 'The city confirmed it received the request', kind: 'city_receipt' },
      { at: now, label: 'The city asked for more information', kind: 'city_ask', ...(mine ? { text: ASK_TEXT } : {}) },
    ] }),
    ...(o.mine === undefined || o.mine ? { mine: true } : o.mine === false ? { mine: false } : {}),
    cityAsk: {
      askedAt: now, open: o.open ?? sent.length === 0, answered: sent.length > 0, answeredAt: sent.length ? sent[sent.length - 1].at : null,
      ...(mine ? { id: 'ask1', canAnswer: o.canAnswer ?? true, expiresAt: now, text: ASK_TEXT, answers } : {}),
    },
  };
}
const publicAskView = () => { const v = askView({ mine: false }) as Record<string, unknown>; delete v.mine; return v; };

test('owner: the city asks for more information → headline, the city words, an answer form that posts to /answer', async ({ page }) => {
  await mockReport(page, askView());
  let posted: unknown = null;
  await page.route(`${API}/api/reports/*/answer`, async (r) => {
    posted = r.request().postDataJSON();
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, answer: { at: new Date().toISOString(), via: 'app', status: 'sent', text: 'x' } }) });
  });
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'The city needs more information from you' })).toBeVisible();
  const card = page.locator('#answer');
  await expect(card.getByRole('heading', { name: 'Answer the city' })).toBeVisible();
  await expect(card.locator('.track-ask-text')).toContainText('please respond to this email by providing the address'.replace('please', 'Please'));
  await expect(page.locator('.rail-step--active')).toHaveCount(1);
  // empty → says so, nothing posted
  await card.getByRole('button', { name: 'Send to the city' }).click();
  await expect(card.getByRole('alert')).toHaveText('Type your answer first.');
  expect(posted).toBeNull();
  await card.getByLabel('Your answer').fill('  It is 30 Example St, the back yard, after 11pm.  ');
  await card.getByRole('button', { name: 'Send to the city' }).click();
  await expect(card.getByRole('status')).toHaveText("Sent. We'll email you when the city updates the case.");
  expect(posted).toEqual({ text: 'It is 30 Example St, the back yard, after 11pm.', askId: 'ask1' });
  await expect(card.getByLabel('Your answer')).toHaveValue('');
  // the timeline words the ask in our words and keeps the city's text behind a disclosure
  await expect(page.locator('.track-timeline')).toContainText('The city asked for more information');
  await expect(page.locator('.track-timeline')).toContainText('The city confirmed it received the request');
});

test('owner: a flagged answer explains why it was not sent; answered + closed states', async ({ page }) => {
  await mockReport(page, askView());
  await page.route(`${API}/api/reports/*/answer`, (r) => r.fulfill({ status: 422, contentType: 'application/json', body: JSON.stringify({ error: 'blocked', flags: ['abuse'] }) }));
  await page.goto('/r/abc');
  await page.getByLabel('Your answer').fill('rude words');
  await page.getByRole('button', { name: 'Send to the city' }).click();
  await expect(page.locator('#answer').getByRole('alert')).toContainText('our automatic check flagged it');
});

test('owner: after answering, the card lists the answer and offers "Add more details"; the headline is the case status again', async ({ page }) => {
  const at = new Date().toISOString();
  await mockReport(page, askView({ answers: [{ at, via: 'email', status: 'sent', text: 'Back yard of 30 Example St' }, { at, via: 'app', status: 'blocked', text: 'rude' }] }));
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'The city has your report' })).toBeVisible();
  const card = page.locator('#answer');
  await expect(card.getByRole('heading', { name: 'You answered the city' })).toBeVisible();
  await expect(card.locator('.track-ask-answer--sent')).toContainText('Back yard of 30 Example St');
  await expect(card.locator('.track-ask-answer--blocked')).toContainText('Not sent — flagged by our check');
  await expect(card.getByLabel('Add more details')).toBeVisible();
});

test('owner: a closed case shows what the city asked, with no form', async ({ page }) => {
  await mockReport(page, askView({ open: false, canAnswer: false, portalStatus: 'Resolved' }));
  await page.goto('/r/abc');
  const card = page.locator('#answer');
  await expect(card.getByRole('heading', { name: 'The city asked for more information' })).toBeVisible();
  await expect(card).toContainText("Answers can't be sent from here anymore");
  await expect(card.locator('textarea')).toHaveCount(0);
});

test('public viewer: the city is waiting on the reporter, no city words, no form, a sign-in link', async ({ page }) => {
  await mockReport(page, publicAskView());
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'The city asked the reporter for more information' })).toBeVisible();
  const card = page.locator('#answer');
  await expect(card.getByRole('heading', { name: 'The city is waiting on the reporter' })).toBeVisible();
  await expect(card.locator('textarea')).toHaveCount(0);
  await expect(card).not.toContainText('Dear FixMyPVD');
  await expect(card.getByRole('link', { name: 'Is this your report? Sign in to answer.' })).toHaveAttribute('href', '/account?returnTo=%2Fr%2Fabc');
});

test('spanish: the ask card and headline are localized', async ({ page }) => {
  await useSpanish(page);
  await mockReport(page, askView());
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'La ciudad necesita más información de ti' })).toBeVisible();
  await expect(page.locator('#answer').getByRole('button', { name: 'Enviar a la ciudad' })).toBeVisible();
  await expect(page.locator('.track-timeline')).toContainText('La ciudad pidió más información');
});

test("work order + department: the city's facts on the ticket, worded neutrally, one timeline row per change", async ({ page }) => {
  const now = new Date().toISOString();
  await mockReport(page, {
    ...view({ portalStatus: 'Department Responded', portalCaseId: 'PVD2026-90090', timeline: [
      { at: now, label: 'Received' },
      { at: now, label: 'The city sent it to DPW Sewer', kind: 'city_routed', vars: { dept: 'DPW Sewer' } } as never,
      { at: '2026-10-16T13:30:00Z', label: 'City work order 0000206909: New Request', kind: 'work_order', vars: { number: '0000206909', status: 'New Request' } } as never,
      { at: '2026-10-16T15:00:00Z', label: 'City work order 0000206909: Completed', kind: 'work_order', vars: { number: '0000206909', status: 'Completed' } } as never,
      { at: now, label: 'City work order 0000206910: Inspection Scheduled', kind: 'work_order', vars: { number: '0000206910', status: 'Inspection Scheduled' } } as never,
    ] }),
    department: 'DPW Sewer',
    workOrder: { number: '0000206909', status: 'Completed', completedAt: '2026-10-16T11:24:00.000Z' },
  });
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'A city department responded' })).toBeVisible();
  await expect(page.locator('.rail-step').filter({ hasText: 'City working on it' })).toHaveClass(/rail-step--done/);
  const facts = page.locator('.track-facts');
  await expect(facts).toContainText('Sent to');
  await expect(facts).toContainText('DPW Sewer');
  await expect(facts).toContainText('#0000206909 · Marked complete');
  await expect(page.getByText('The city marked its work order complete; the case itself is still open.')).toBeVisible();
  const tl = page.locator('.track-timeline');
  await expect(tl).toContainText('The city sent it to DPW Sewer');
  await expect(tl).toContainText('City work order #0000206909: New');
  await expect(tl).toContainText('City work order #0000206909: Marked complete');
  await expect(tl).toContainText('City work order #0000206910: Inspection Scheduled'); // unknown word → the city's own
  await expect(page.locator('#answer')).toHaveCount(0);
});

// ── Near this request (2026-10-26): the city's cases within a few blocks, the map, and the weekly digest for this street ──

const near = (page: Page) => page.locator('.track-near');
const MAP_HREF = '/street?lat=41.82680&lng=-71.40530&q=120%20Benefit%20St%2C%20Providence%2C%20RI';

test('near: two skeleton rows while loading, then the counts, three rows in the /street look, the map link; a row opens its case on the map; fetched once per report', async ({ page }) => {
  await mockReport(page, view());
  const urls = await mockNear(page, TRACK_NEAR, { delayMs: 600 });
  await page.goto('/r/abc');
  const card = near(page).locator('.track-near-card');
  await expect(near(page).getByRole('heading', { name: 'Near this request' })).toBeVisible();
  await expect(card).toHaveAttribute('aria-busy', 'true');
  await expect(card.locator('.track-near-skel-row')).toHaveCount(2);
  await expect(page.locator('.track-near .spinner, .track-near [role="progressbar"]')).toHaveCount(0);
  // Loaded: our own report is not in the list — these are the city's cases (2 open · 2 closed; the 4th is counted, not listed).
  await expect(card.locator('.track-near-summary')).toHaveText('2 other open requests within a few blocks · 2 closed this month');
  await expect(card).not.toHaveAttribute('aria-busy', 'true');
  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain('/api/street?lat=41.8268&lng=-71.4053&radiusM=300&days=30');
  const rows = card.locator('.street-row-btn');
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText('Pothole');
  await expect(rows.nth(0)).toContainText('124 Benefit St · 28 m away');
  await expect(rows.nth(0)).toContainText('Reported 3 days ago');
  await expect(rows.nth(0).locator('.my-status')).toHaveText('Assigned');
  await expect(rows.nth(1).locator('.my-status')).toHaveText('Closed');
  await expect(rows.nth(1)).toContainText('Bulb replaced.');
  await expect(rows.nth(2)).toContainText('Graffiti');
  await expect(card).not.toContainText('77 Benefit St');
  const link = card.getByRole('link', { name: 'See them on the map' });
  await expect(link).toHaveAttribute('href', MAP_HREF);
  expect((await link.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect((await rows.nth(0).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  // The digest card follows, bound to the same point.
  await expect(near(page).locator('.street-digest h3')).toHaveText('Hear about this street every week');
  // A row opens that case on the map, at the report's point (/street's own feed mocked so nothing reaches the real Worker).
  await page.route(`${API}/api/street/map*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed()) }));
  await rows.nth(0).click();
  await expect(page).toHaveURL(new RegExp(`${MAP_HREF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}&case=n1$`));
  // Back on the tracking page the set comes from the component's cache: still one request.
  await page.goBack();
  await expect(card.locator('.street-row-btn')).toHaveCount(3);
  expect(urls).toHaveLength(1);
});

test('near: nothing within a few blocks → "yours may be the first", the map link and the digest card still render', async ({ page }) => {
  await mockReport(page, view());
  await page.goto('/r/abc');
  const card = near(page).locator('.track-near-card');
  await expect(card.locator('.track-near-none')).toHaveText('Nothing else reported within a few blocks this month — yours may be the first.');
  await expect(card.locator('.street-row-btn')).toHaveCount(0);
  await expect(card.getByRole('link', { name: 'See this street on the map' })).toHaveAttribute('href', MAP_HREF);
  await expect(near(page).locator('.street-digest')).toBeVisible();
});

test('near: a failed fetch drops the card and its heading (the digest card needs no feed, so it stays); the page is otherwise whole', async ({ page }) => {
  await mockReport(page, view());
  await mockNear(page, TRACK_NEAR, { status: 500 });
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'The city assigned your request' })).toBeVisible();
  await expect(page.locator('.street-digest')).toBeVisible();
  await expect(page.locator('.track-near-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Near this request' })).toHaveCount(0);
  await expect(page.locator('.notice-error')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What to expect' })).toBeVisible();
});

test('near: the feed failing while a digest save is in flight — the card keeps its instance, the save lands in the on-state, one GET /api/me', async ({ page }) => {
  await mockReport(page, view());
  await mockNear(page, TRACK_NEAR, { status: 500, delayMs: 1500 }); // the failed fetch lands mid-save
  const gets = { n: 0 };
  const calls = await signedIn(page, {}, { delayMs: 1200, gets }); // PUT ~1.2 s after the tap, PATCH ~2.4 s
  await stubPush(page);
  await page.goto('/r/abc');
  const digest = near(page).locator('.street-digest');
  await expect(near(page).locator('.track-near-skel-row')).toHaveCount(2);
  const cta = digest.getByRole('button', { name: 'Email me about this street' });
  await expect(cta).toBeEnabled();
  await digest.evaluate((el) => el.setAttribute('data-probe', 'same-node'));
  await cta.click();
  await expect(digest.getByRole('button', { name: 'Saving…' })).toBeVisible();
  // The feed fails: the heading and the card go, the digest card is the same DOM node, still saving.
  await expect(page.locator('.track-near-card')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Near this request' })).toHaveCount(0);
  await expect(digest).toHaveAttribute('data-probe', 'same-node');
  await expect(digest.getByRole('button', { name: 'Saving…' })).toBeVisible();
  // The save finishes into that instance: the on-state, the phone row, no second account read.
  await expect(digest.locator('.street-digest-on .notice-ok')).toHaveText('On — Mondays, for 120 Benefit St. Manage addresses under Account.');
  await expect(digest.locator('.push-card')).toHaveAttribute('data-state', 'off');
  await expect(digest).toHaveAttribute('data-probe', 'same-node');
  expect(calls.map((c) => c.method)).toEqual(['PUT', 'PATCH']);
  expect(gets.n).toBe(1);
});

test('near: the report\'s own case, once the city sync lists it, is not an "other" request — dropped from the rows and the counts; a same-type case the same day on another street stays', async ({ page }) => {
  await mockReport(page, view());
  const own: Case = { id: 'own', t: 0, status: 'Received', createdDaysAgo: 0, lat: 41.82695, lng: -71.40545, street: '120 BENEFIT ST' }; // the city's geocode of our street: ~20 m off the pin
  const twin: Case = { id: 'twin', t: 0, status: 'Received', createdDaysAgo: 0, lat: 41.8278, lng: -71.4042, street: '30 Meeting St' }; // same type, same day, ~145 m away
  await mockNear(page, [own, twin, ...TRACK_NEAR]);
  await page.goto('/r/abc');
  const card = near(page).locator('.track-near-card');
  await expect(card.locator('.track-near-summary')).toHaveText('3 other open requests within a few blocks · 2 closed this month');
  const rows = card.locator('.street-row-btn');
  await expect(rows).toHaveCount(3);
  await expect(card).not.toContainText('120 BENEFIT ST');
  await expect(card.locator('[data-id="own"]')).toHaveCount(0);
  await expect(rows.nth(0)).toContainText('30 Meeting St');
  await expect(rows.nth(1)).toContainText('124 Benefit St');
});

test('near: a report without coordinates has no card and asks the Worker nothing', async ({ page }) => {
  await mockReport(page, view({ lat: null, lng: null }));
  const urls = await mockNear(page, TRACK_NEAR);
  await page.goto('/r/abc');
  await expect(page.getByRole('heading', { name: 'What to expect' })).toBeVisible();
  await expect(near(page)).toHaveCount(0);
  await expect(page.locator('.street-digest')).toHaveCount(0);
  expect(urls).toEqual([]);
});

test('near, signed in: one tap saves the address (label = the part before the comma) and turns the Monday email on, then the phone row appears', async ({ page }) => {
  await mockReport(page, view());
  await mockNear(page, TRACK_NEAR);
  const calls = await signedIn(page);
  await stubPush(page); // an Android UA with a PushManager: the row reads "off" instead of the iPhone install hint
  await page.goto('/r/abc');
  const digest = near(page).locator('.street-digest');
  await expect(digest.locator('.push-card')).toHaveCount(0);
  const cta = digest.getByRole('button', { name: 'Email me about this street' });
  await expect(cta).toBeEnabled();
  expect((await cta.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await cta.click();
  await expect(digest.locator('.street-digest-on .notice-ok')).toHaveText('On — Mondays, for 120 Benefit St. Manage addresses under Account.');
  expect(calls.map((c) => c.method)).toEqual(['PUT', 'PATCH']);
  expect(calls[0].body).toEqual({ label: '120 Benefit St', address: '120 Benefit St, Providence, RI', lat: TRACK_PT.lat, lng: TRACK_PT.lng });
  expect(calls[1].body).toEqual({ prefs: { streetDigest: true } });
  const push = digest.locator('.push-card');
  await expect(push).toHaveAttribute('data-state', 'off');
  await expect(push.getByRole('button', { name: 'Turn on' })).toBeVisible();
  await expect(digest.getByRole('button', { name: 'Turn off', exact: true })).toBeVisible();
  // Off again: one PATCH, the row goes with the on-state.
  await digest.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(digest.getByRole('button', { name: 'Email me about this street' })).toBeVisible();
  expect(calls.map((c) => c.method)).toEqual(['PUT', 'PATCH', 'PATCH']);
  expect(calls[2].body).toEqual({ prefs: { streetDigest: false } });
  await expect(digest.locator('.push-card')).toHaveCount(0);
});

test('near, signed in with this street already saved and on: the on-state, no second save', async ({ page }) => {
  await mockReport(page, view());
  const calls = await signedIn(page, { prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a9', label: 'Home', address: '120 Benefit St, Providence, RI', lat: TRACK_PT.lat, lng: TRACK_PT.lng }] });
  await page.goto('/r/abc');
  await expect(near(page).locator('.street-digest-on .notice-ok')).toContainText('for Home');
  expect(calls).toEqual([]);
});

test('near, street watch: the checkbox sits under the phone row in the on-state, armed because this phone is subscribed; check → one PATCH streetWatch true; a slow PATCH shows the optimistic state once', async ({ page }) => {
  await mockReport(page, view());
  await mockNear(page, TRACK_NEAR);
  const calls = await signedIn(page, { prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a9', label: 'Home', address: '120 Benefit St, Providence, RI', lat: TRACK_PT.lat, lng: TRACK_PT.lng }], push: { endpoints: [ENDPOINT] } }, { delayMs: 400 });
  await stubPush(page, { subscribed: true, permission: 'granted' });
  await page.goto('/r/abc');
  const digest = near(page).locator('.street-digest');
  await expect(digest.locator('.push-card')).toHaveAttribute('data-state', 'on');
  const row = digest.locator('.watch-row');
  const box = row.getByRole('checkbox', { name: 'Tell me right away when something new is reported near my places' });
  await expect(row).toHaveAttribute('data-state', 'off');
  await expect(box).toBeEnabled();
  expect(await digest.locator('.street-digest-on').evaluate((el) => Array.from(el.children).map((c) => c.className.split(' ')[0]))).toEqual(['notice', 'btn', 'push-card', 'watch-row', 'watch-groups']);
  await box.check();
  await expect(box).toBeChecked(); // optimistic, before the Worker answers
  await expect(box).toHaveAttribute('aria-busy', 'true');
  await expect(box).not.toHaveAttribute('aria-busy', 'true');
  await expect(box).toBeChecked();
  await expect(row.locator('.watch-hint')).toHaveText('On — new requests near your places reach this phone right away.');
  expect(calls).toEqual([{ method: 'PATCH', body: { prefs: { streetWatch: true } } }]);
});

test('near, street watch under the suite\'s iPhone tab (no push yet): the checkbox is disabled with the hint, and nothing is sent', async ({ page }) => {
  await mockReport(page, view());
  const calls = await signedIn(page, { prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a9', label: 'Home', address: '120 Benefit St, Providence, RI', lat: TRACK_PT.lat, lng: TRACK_PT.lng }] });
  await page.goto('/r/abc');
  const digest = near(page).locator('.street-digest');
  await expect(digest.locator('.push-card')).toHaveAttribute('data-state', 'ios-needs-install');
  const row = digest.locator('.watch-row');
  await expect(row).toHaveAttribute('data-state', 'needs-push');
  await expect(row.getByRole('checkbox')).toBeDisabled();
  await expect(row.locator('.watch-hint')).toHaveText('Turn on phone notifications first.');
  expect(calls).toEqual([]);
});

test('near, signed out: the digest card offers sign-in and comes straight back to this report', async ({ page }) => {
  await mockReport(page, view());
  await page.goto('/r/abc');
  const link = near(page).locator('.street-digest a.btn');
  await expect(link).toHaveText('Sign in to get the weekly email');
  await expect(link).toHaveAttribute('href', '/account?returnTo=%2Fr%2Fabc');
  await expect(near(page).locator('.street-digest button')).toHaveCount(0);
});

test('near: Spanish title, summary and map link (singulars included); the city\'s case type stays its own', async ({ page }) => {
  await useSpanish(page);
  await mockReport(page, view());
  await mockNear(page, TRACK_NEAR.slice(0, 2)); // 1 open · 1 closed
  await page.goto('/r/abc');
  await expect(near(page).getByRole('heading', { name: 'Cerca de esta solicitud' })).toBeVisible();
  await expect(near(page).locator('.track-near-summary')).toHaveText('1 otra solicitud abierta a unas cuadras · 1 cerrada este mes');
  await expect(near(page).getByRole('link', { name: 'Verlas en el mapa' })).toHaveAttribute('href', MAP_HREF);
  await expect(near(page).locator('.street-row-btn').first()).toContainText('a 28 m');
  await expect(near(page).locator('.street-row-btn').first().locator('.my-status')).toHaveText('Asignado');
});
