import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// axe-core WCAG 2.x A/AA pass over the main screens, light and dark.
const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';

async function mocks(page: Page) {
  await page.addInitScript(() => { (window as unknown as { __TURNSTILE_TOKEN__: string }).__TURNSTILE_TOKEN__ = 'x'; });
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/public-feed*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: [{ id: 'a', source: 'snappvd', category: 'pothole', categoryLabel: 'Pothole', lat: 41.8268, lng: -71.4053, address: '120 Benefit St', createdAt: new Date().toISOString(), status: 'sent', portalStatus: 'Assigned' }] }) }));
  await page.route(`${API}/api/reports/demo`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'demo', category: 'pothole', categoryLabel: 'Pothole', address: '120 Benefit St', lat: 41.8, lng: -71.4, photoUrl: null, createdAt: new Date().toISOString(), status: 'sent', portalCaseId: 'PVD2026-1', portalStatus: 'Assigned', timeline: [{ at: new Date().toISOString(), label: 'Received' }], nextUpdateHint: null, hasEmail: false }) }));
  await page.route(`${API}/api/nearby*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
  await page.route(/tile|basemaps\.cartocdn/, (r) => r.fulfill({ status: 200, body: '' }));
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
  ['details', async (p) => { await p.goto('/'); await p.click('[data-category="pothole"]'); }],
  ['track', (p) => p.goto('/r/demo?submitted=1')],
  ['about', (p) => p.goto('/about')],
  ['my', (p) => p.goto('/my')],
];

for (const scheme of ['light', 'dark'] as const) {
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
