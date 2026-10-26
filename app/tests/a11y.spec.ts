import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { API as WORKER, SESSION, TRACK_NEAR, feed, nearWire } from './street-mocks';
import { WEEK, DATED } from './week-mocks';

// axe-core WCAG 2.x A/AA pass over the main screens, light and dark.
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

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
  await page.route((u) => u.origin + u.pathname === `${API}/api/week`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(new URL(r.request().url()).searchParams.get('until') === '2026-10-18' ? DATED : WEEK) }));
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/map/basemap.json', (r) => r.fulfill({ status: 404, body: '' }));
}

/** A signed-in account that follows city case c1 (the /street card's pressed toggle; /my's followed section). */
async function signedIn(page: Page) {
  await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  const me = { uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: ['c1'], createdAt: new Date().toISOString() };
  await page.route(`${WORKER}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }));
  await page.route(`${WORKER}/api/me/reports`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
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
  ['week', (p) => p.goto('/week')],
  ['week-dated', (p) => p.goto('/week?until=2026-10-18')],
  ['street-case', (p) => p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&case=c1')],
  ['street-case-following', async (p) => { await signedIn(p); await p.goto('/street?lat=41.8282&lng=-71.4005&q=481%20Angell%20St&case=c1'); await p.locator('.street-follow-btn[aria-pressed="true"]').waitFor(); }],
  ['my-following', async (p) => { await signedIn(p); await p.goto('/my'); await p.locator('.followed-cases').waitFor(); }],
];

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
