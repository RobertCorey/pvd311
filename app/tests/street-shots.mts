// Screenshots of the /street states for the design check (not a test). Run from app/ with the preview server up:
//   npx tsx tests/street-shots.mts [outDir]
import { chromium, devices } from '@playwright/test';
import { setup, waitForMap, setView, STACK, POINT } from './street-mocks';

const out = process.argv[2] ?? '/tmp/street-shots';
const base = 'http://localhost:4173';

async function shot(name: string, o: { desktop?: boolean }, run: (page: import('@playwright/test').Page) => Promise<void>) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext(o.desktop ? { viewport: { width: 1280, height: 800 } } : { ...devices['Pixel 7'] });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  await run(page);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log(name, errors.length ? `ERRORS: ${errors.join(' | ')}` : 'ok', await page.locator('.street-title').first().textContent(), '/', await page.locator('.street-sub').first().textContent());
  await browser.close();
}

await shot('map-landing', {}, async (page) => { await setup(page); await page.goto(`${base}/street`); await waitForMap(page); await page.waitForSelector('.map-cluster'); });
await shot('map-half', {}, async (page) => { await setup(page); await page.goto(`${base}/street`); await waitForMap(page); await page.waitForSelector('.map-cluster'); await page.locator('.street-grab').click(); });
await shot('map-point', {}, async (page) => { await setup(page); await page.goto(`${base}${POINT}`); await waitForMap(page); await page.waitForSelector('.street-row-btn'); });
await shot('map-case', {}, async (page) => { await setup(page); await page.goto(`${base}${POINT}&case=c2`); await waitForMap(page); await page.waitForSelector('.case-page'); });
await shot('map-quiet', {}, async (page) => { await setup(page, { items: (await import('./street-mocks')).filler() }); await page.goto(`${base}${POINT}`); await waitForMap(page); await page.waitForSelector('.street-none'); });
await shot('map-stack', {}, async (page) => { await setup(page); await page.goto(`${base}/street`); await waitForMap(page); await page.waitForSelector('.map-cluster'); await setView(page, STACK.lat, STACK.lng, 18); await page.waitForSelector('.map-leg'); });
await shot('map-desktop', { desktop: true }, async (page) => { await setup(page); await page.goto(`${base}/street`); await waitForMap(page); await page.waitForSelector('.map-cluster'); });
