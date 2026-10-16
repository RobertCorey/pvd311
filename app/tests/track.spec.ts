import { test, expect, type Page } from '@playwright/test';

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
    lat: o.lat ?? 41.8268,
    lng: o.lng ?? -71.4053,
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
