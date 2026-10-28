import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { API as WORKER, DEFAULT_ITEMS, SESSION, TRACK_NEAR, caseWire, detailFor, feed, nearWire } from './street-mocks';
import { WEEK, DATED, PLACES } from './week-mocks';
import { ENDPOINT, stubPush } from './push-mocks';
import { addDays, nyYmd } from '../src/lib/streetMap';

// axe-core WCAG 2.x A/AA pass over the main screens, light and dark.
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
/** A custom range on /street: the last `n` Providence days (the date inputs refuse anything outside today − 89 … today). */
const lastDays = (n: number) => { const to = nyYmd(Date.now()); return `from=${addDays(to, -n)}&to=${to}`; };

async function mocks(page: Page) {
  await page.addInitScript(() => { });
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/reports/demo`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'demo', category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St', lat: 41.8, lng: -71.4, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: 'PVD2026-1', portalStatus: 'Assigned', timeline: [{ at: new Date().toISOString(), label: 'Received' }], nextUpdateHint: null }) }));
  await page.route(`${API}/api/reports/closed1234`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'closed1234', category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St', lat: 41.8, lng: -71.4, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: 'PVD2026-2', portalStatus: 'Resolved', resolutionMessage: 'Complaint (CODE-26-1465) has been received and logged into the system for review.', mine: true, timeline: [{ at: new Date().toISOString(), label: 'Received' }, { at: new Date().toISOString(), label: 'Message from the city: Your request has been updated', kind: 'city_message', text: 'Hello,\n\nYour request has been updated.' }], nextUpdateHint: null }) }));
  await page.route(`${API}/api/reports/asked12345`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'asked12345', category: 'noise', categoryLabel: 'Noise', address: '25 Dorrance St', lat: 41.8, lng: -71.4, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: 'PVD2026-90113', portalStatus: 'Department Responded', mine: true, department: 'DPW Sewer', workOrder: { number: '0000206909', status: 'Completed', completedAt: new Date().toISOString() }, cityAsk: { askedAt: new Date().toISOString(), open: true, answered: false, answeredAt: null, id: 'a1', canAnswer: true, expiresAt: new Date().toISOString(), text: 'Please respond to this email by providing the address.', answers: [{ at: new Date().toISOString(), via: 'app', status: 'blocked', text: 'x' }] }, timeline: [{ at: new Date().toISOString(), label: 'The city asked for more information', kind: 'city_ask', text: 'Please respond.' }], nextUpdateHint: null }) }));
  await page.route(`${API}/api/nearby*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  // The tracking page's "Near this request" card (the demo report sits at 41.8, -71.4): rows, pills, the map link, the digest card.
  await page.route(`${API}/api/street?*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(nearWire(TRACK_NEAR, { lat: 41.8, lng: -71.4 })) }));
  await page.route(`${API}/api/street/map*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(feed()) }));
  // The case overlay's GET /api/street/case/:id: every fixture case with a full detail (timeline, answers, address).
  await page.route(`${API}/api/street/case/*`, (r) => {
    const c = DEFAULT_ITEMS.find((x) => x.id === decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop() ?? ''));
    if (!c) return r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...caseWire(c), detail: detailFor(c, { address: `1${c.street}, Providence, RI, 02906, USA`, workCompletedDaysAgo: 0 }) }) });
  });
  await page.route((u) => u.origin + u.pathname === `${API}/api/week`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(new URL(r.request().url()).searchParams.get('until') === '2026-10-18' ? DATED : WEEK) }));
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/map/basemap.json', (r) => r.fulfill({ status: 404, body: '' }));
}

/** A signed-in account that follows city case c1 (the /street card's pressed toggle; /my's followed section); `over` adjusts GET /api/me. */
async function signedIn(page: Page, over: Record<string, unknown> = {}) {
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  const me = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: ['c1'], createdAt: new Date().toISOString(), ...over };
  await page.route(`${WORKER}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }));
  await page.route(`${WORKER}/api/me/reports`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route(`${WORKER}/api/me/following`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  const c1 = { id: 'c1', caseType: 'Pothole', category: 'pothole', street: '10 Angell St', status: 'Assigned', open: true, createdAt: new Date().toISOString(), closedAt: null, resolution: null, lat: 41.82856, lng: -71.4005, followedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  const c2 = { ...c1, id: 'c2', caseType: 'Street Light Out', category: 'street_light', street: '22 Thayer St', status: 'Resolved', open: false, closedAt: new Date().toISOString(), resolution: 'Bulb replaced.' };
  await page.route((u) => u.href.startsWith(`${WORKER}/api/me/city`), (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [c1, c2] }) }));
}

async function violations(page: Page): Promise<string[]> {
  await page.addScriptTag({ content: axeSource });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run: (c: Document, o: object) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21aa'] });
    return r.violations.map((v) => `${v.id} (${v.impact}) x${v.nodes.length}: ${v.nodes[0].target[0]}`);
  });
}

const SCREENS: Array<[string, (p: Page) => Promise<unknown>]> = [
  ['home', (p) => p.goto('/')],
  ['details', async (p) => { await p.goto('/'); await p.click('.cat-tile[data-group="streets"]'); await p.click('.type-row[data-category="pothole"]'); }],
  ['rows', async (p) => { await p.goto('/?g=streets'); }],
  ['facet', async (p) => { await p.goto('/?g=streets&o=sidewalk'); }],
  ['track', (p) => p.goto('/r/demo?submitted=1')],
  ['track-closed', async (p) => { await p.goto('/r/closed1234'); await p.click('details.track-tl-msg summary'); }],
  ['track-ask', async (p) => { await p.goto('/r/asked12345'); await p.click('#answer button[type="submit"]'); }],
  ['about', (p) => p.goto('/about')],
  ['my', (p) => p.goto('/my')],
  ['street', (p) => p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St')],
  ['street-landing', (p) => p.goto('/street')],
  // The filter row off its defaults: Show = Open (filled ink), a type and the week picked, Clear leading the row (pinned left).
  ['street-filtered', async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&s=open&g=trash&d=7'); await p.locator('.street-row-btn').first().waitFor(); await p.locator('.street-clear').waitFor(); }],
  // Filters v2: the Type dialog open over the sheet (two groups checked); a custom range's third row (From, To, Clear).
  ['street-type-open', async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&g=trash,streets'); await p.locator('.street-row-btn').first().waitFor(); await p.locator('.street-type-btn').click(); await p.locator('.street-type-pop').waitFor(); }],
  ['street-range', async (p) => { await p.goto(`/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&${lastDays(7)}`); await p.locator('.street-row-btn').first().waitFor(); await p.locator('.street-date').first().waitFor(); }],
  // The landing's half sheet, signed in with a saved address: the "Your places this week" card over the week link.
  ['street-places', async (p) => { await signedIn(p, { addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: 41.8282, lng: -71.4005 }] }); await p.goto('/street'); await p.locator('.map-cluster').first().waitFor(); await p.locator('.street-grab').click(); await p.locator('.street-places-card').waitFor(); }],
  // The landing's half sheet on a return visit (seenAt 2 days ago, 2nd visit, the suite's iPhone UA): the second subtitle line, the New pills, the home-screen nudge with its iPhone hint revealed.
  ['street-return', async (p) => { await p.addInitScript(() => { localStorage.setItem('fixmypvd.street.seenAt', new Date(Date.now() - 2 * 86_400_000).toISOString()); localStorage.setItem('fixmypvd.street.visits', '1'); }); await p.goto('/street'); await p.locator('.map-cluster').first().waitFor(); await p.locator('.street-since').waitFor(); await p.locator('.street-grab').click(); await p.locator('.street-install .street-install-cta').click(); await p.locator('.street-install-ios:not(:empty)').waitFor(); }],
  ['week', (p) => p.goto('/week')],
  ['week-dated', (p) => p.goto('/week?until=2026-10-18')],
  // Signed in with saved places: their hoods tagged "Yours" and pinned (one with nothing this week), the comparison line, the list opened by Show all.
  ['week-yours', async (p) => { await signedIn(p, { addresses: PLACES }); await p.goto('/week'); await p.locator('.week-hood-compare').waitFor(); await p.locator('.week-hoods-more').click(); await p.locator('.week-hoods-more[aria-expanded="true"]').waitFor(); }],
  // The case page (a modal dialog over the whole screen): the mini-map, the stat row, the tiles, Nearby, the digest card.
  ['street-case', async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&case=c1'); await p.locator('.case-page .case-nearby .street-row-btn').first().waitFor(); }],
  // The same with everything GET /api/street/case/:id adds: full address, the form's dates as tiles, timeline with the close, the city's note, answers.
  ['street-case-detail', async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&case=c2'); await p.locator('.case-page .street-tl-step[data-step="resolved"]').waitFor(); await p.locator('.case-page .street-answers').waitFor(); await p.locator('.case-page .case-tile[data-tile="workCompleted"]').waitFor(); }],
  // An unplaced case: no mini-map, no Nearby.
  ['street-case-unplaced', async (p) => { await p.goto('/street?case=z2'); await p.locator('.case-page .case-hero--nomap').waitFor(); }],
  // The phone's pin preview: a pin tapped at the address view — the card (a labelled region: one button face, the ×) over the PEEK sheet.
  ['street-preview', async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St'); await p.locator('.street-row-btn').first().waitFor(); await p.waitForFunction(() => (window as unknown as { __streetMap?: { getZoom(): number } }).__streetMap?.getZoom() === 16); const at = await p.evaluate(() => { const m = (window as unknown as { __streetMap: { latLngToContainerPoint(ll: [number, number]): { x: number; y: number }; getContainer(): HTMLElement } }).__streetMap; const q = m.latLngToContainerPoint([41.82856, -71.4005]); const r = m.getContainer().getBoundingClientRect(); return { x: r.x + q.x, y: r.y + q.y - 14 }; }); await p.mouse.click(at.x, at.y); await p.locator('.street-preview').waitFor(); }],
  // The map key's dialog open over the point view (swatches, the dialog's ×, the button's expanded state).
  ['street-key', async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St'); await p.locator('.street-row-btn').first().waitFor(); await p.getByRole('button', { name: 'Map key', exact: true }).click(); await p.locator('.street-key-pop').waitFor(); }],
  ['street-case-following', async (p) => { await signedIn(p); await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&case=c1'); await p.locator('.street-follow-btn[aria-pressed="true"]').waitFor(); await p.locator('.case-follow-notes .street-follow-note').waitFor(); }],
  ['my-following', async (p) => { await signedIn(p); await p.goto('/my'); await p.locator('.followed-cases').waitFor(); }],
  // Account → Updates: the checkboxes, the phone row (the iPhone install hint under the suite's UA) and the disabled street-watch row.
  ['account-updates', async (p) => { await signedIn(p); await p.goto('/account'); await p.locator('.account-prefs .watch-row').waitFor(); }],
  // The same on a subscribed Android phone: the phone row "on", the street-watch row enabled and checked.
  ['account-updates-on', async (p) => { await signedIn(p, { prefs: { emailUpdates: true, streetWatch: true }, push: { endpoints: [ENDPOINT] } }); await stubPush(p, { subscribed: true, permission: 'granted' }); await p.goto('/account'); await p.locator('.account-prefs .watch-row[data-state="on"]').waitFor(); }],
  // The same with the "Only tell me about" rail under the watch row, two of its chips pressed (ink on paper, with the icons).
  ['account-updates-groups', async (p) => { await signedIn(p, { prefs: { emailUpdates: true, streetWatch: true, watchGroups: ['streets', 'trash'] }, push: { endpoints: [ENDPOINT] } }); await stubPush(p, { subscribed: true, permission: 'granted' }); await p.goto('/account'); await p.locator('.account-prefs .watch-groups [data-group="trash"][aria-pressed="true"]').waitFor(); }],
  // The same with everything on: the "What you'll hear about" summary at the top of the card carries all five lines (the phone one "on this phone").
  ['account-summary', async (p) => { await signedIn(p, { prefs: { emailUpdates: true, streetDigest: true, weekDigest: true, streetWatch: true, watchGroups: ['trash', 'streets', 'trees', 'lights', 'water'] }, addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: 41.8282, lng: -71.4005 }], cityFollowing: ['c1', 'c2'], push: { endpoints: [ENDPOINT] } }); await stubPush(p, { subscribed: true, permission: 'granted' }); await p.goto('/account'); await p.locator('.account-prefs .account-summary [data-item="groups"]').waitFor(); await p.locator('.account-prefs .account-summary [data-item="watch"]', { hasText: 'this phone' }).waitFor(); }],
  // The nothing-on state of the same summary.
  ['account-summary-none', async (p) => { await signedIn(p, { prefs: { emailUpdates: false } }); await p.goto('/account'); await p.locator('.account-prefs .account-summary-none').waitFor(); }],
  // /street with the digest on for Home (the point itself): the digest card's on-state — notice, button, phone row "on", the watch row enabled and unchecked.
  ['street-digest-on', async (p) => { await signedIn(p, { prefs: { emailUpdates: true, streetDigest: true }, addresses: [{ id: 'a9', label: 'Home', address: '481 Angell St, Providence', lat: 41.8282, lng: -71.4005 }], push: { endpoints: [ENDPOINT] } }); await stubPush(p, { subscribed: true, permission: 'granted' }); await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St'); await p.locator('.street-digest .watch-row[data-state="off"]').waitFor(); }],
];

// The desktop panel (≥720 px): the filters as three labelled rows, at the 440 px and the 360 px panel widths.
const DESKTOP_SCREENS: Array<[string, { width: number; height: number }, (p: Page) => Promise<unknown>]> = [
  ['street-desktop', { width: 1280, height: 800 }, async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St'); await p.locator('.street-row-btn').first().waitFor(); }],
  ['street-desktop-filtered', { width: 1280, height: 800 }, async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&s=closed&g=lights&d=90'); await p.locator('.street-row-btn').first().waitFor(); await p.locator('.street-clear').waitFor(); }],
  ['street-desktop-landing-narrow', { width: 800, height: 800 }, async (p) => { await p.goto('/street'); await p.locator('.map-cluster').first().waitFor(); }],
  // A custom range's dates under When, and the Type dialog open over the panel.
  ['street-desktop-range', { width: 1280, height: 800 }, async (p) => { await p.goto(`/street?${lastDays(14)}&g=trash,lights`); await p.locator('.map-cluster').first().waitFor(); await p.locator('.street-date').first().waitFor(); }],
  ['street-desktop-type-open', { width: 1280, height: 800 }, async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&d=1'); await p.locator('.street-row-btn').first().waitFor(); await p.locator('.street-type-btn').click(); await p.locator('.street-type-pop').waitFor(); }],
  // The case page as a centred dialog over the dimmed map and panel, with everything the detail adds; and signed in, following.
  ['street-desktop-case', { width: 1280, height: 800 }, async (p) => { await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&case=c2'); await p.locator('.case-page .street-tl-step[data-step="resolved"]').waitFor(); await p.locator('.case-page .case-nearby .street-row-btn').first().waitFor(); }],
  ['street-desktop-case-following', { width: 1280, height: 800 }, async (p) => { await signedIn(p); await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&case=c1'); await p.locator('.case-page .street-follow-btn[aria-pressed="true"]').waitFor(); await p.locator('.case-page .street-tl').waitFor(); }],
];

test.describe('a11y desktop (light)', () => {
  test.use({ colorScheme: 'light', isMobile: false, hasTouch: false });
  for (const [name, viewport, go] of DESKTOP_SCREENS) {
    test(name, async ({ page }) => {
      await page.setViewportSize(viewport);
      await mocks(page);
      await go(page);
      await page.waitForTimeout(500);
      const v = await violations(page);
      expect(v, v.join('\n')).toEqual([]);
    });
  }
});

for (const scheme of ['light'] as const) {
  test.describe(`a11y (${scheme})`, () => {
    test.use({ colorScheme: scheme });
    for (const [name, go] of SCREENS) {
      test(name, async ({ page }) => {
        await mocks(page);
        await go(page);
        await page.waitForTimeout(500);
        const v = await violations(page);
        expect(v, v.join('\n')).toEqual([]);
      });
    }
  });
}
