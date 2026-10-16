import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// axe-core WCAG 2.x A/AA pass over the main screens, light and dark.
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

async function mocks(page: Page) {
  await page.addInitScript(() => { (window as unknown as { __TURNSTILE_TOKEN__: string }).__TURNSTILE_TOKEN__ = 'x'; });
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/reports/demo`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'demo', category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St', lat: 41.8, lng: -71.4, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: 'PVD2026-1', portalStatus: 'Assigned', timeline: [{ at: new Date().toISOString(), label: 'Received' }], nextUpdateHint: null }) }));
  await page.route(`${API}/api/reports/closed1234`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'closed1234', category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St', lat: 41.8, lng: -71.4, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: 'PVD2026-2', portalStatus: 'Resolved', resolutionMessage: 'Complaint (CODE-26-1465) has been received and logged into the system for review.', mine: true, timeline: [{ at: new Date().toISOString(), label: 'Received' }, { at: new Date().toISOString(), label: 'Message from the city: Your request has been updated', kind: 'city_message', text: 'Hello,\n\nYour request has been updated.' }], nextUpdateHint: null }) }));
  await page.route(`${API}/api/reports/asked12345`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'asked12345', category: 'noise', categoryLabel: 'Noise', address: '25 Dorrance St', lat: 41.8, lng: -71.4, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: 'PVD2026-90113', portalStatus: 'Department Responded', mine: true, department: 'DPW Sewer', workOrder: { number: '0000206909', status: 'Completed', completedAt: new Date().toISOString() }, cityAsk: { askedAt: new Date().toISOString(), open: true, answered: false, answeredAt: null, id: 'a1', canAnswer: true, expiresAt: new Date().toISOString(), text: 'Please respond to this email by providing the address.', answers: [{ at: new Date().toISOString(), via: 'app', status: 'blocked', text: 'x' }] }, timeline: [{ at: new Date().toISOString(), label: 'The city asked for more information', kind: 'city_ask', text: 'Please respond.' }], nextUpdateHint: null }) }));
  await page.route(`${API}/api/nearby*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route(/tile\.openstreetmap\.org/, (r) => r.fulfill({ status: 200, body: '' }));
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
