import { test, expect } from '@playwright/test';

// Integration guard: every route renders with no uncaught exception, in both languages.
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
const ROUTES: Array<[string, RegExp]> = [
  ['/', /What's the problem\?|¿Cuál es el problema\?/],
  ['/about', /About|Acerca/],
  ['/privacy', /Privacy|Privacidad/],
  ['/my', /My reports|Mis reportes/],
  ['/street', /My street|Mi calle/],
  ['/week', /This week in Providence|Esta semana en Providence/],
  ['/account', /Your account|Tu cuenta/],
  ['/admin', /Admin/],
  ['/r/nope', /can't find|no encontramos|no existe|no pudimos encontrar/i],
  ['/definitely-not-a-route', /doesn't exist|no existe/],
];

test('footer disclaimer is localized to Spanish on / and /about', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('fixmypvd.lang', 'es');
  });
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route(`${API}/api/reports/*`, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/map/basemap.json', (r) => r.fulfill({ status: 404, body: '' }));
  for (const path of ['/', '/about']) {
    await page.goto(path);
    await expect(page.locator('.app-footer .disclaimer')).toContainText('no está afiliado');
  }
});

for (const lang of ['en', 'es']) {
  test(`all routes render in ${lang} without page errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((l) => { localStorage.setItem('fixmypvd.lang', l); }, lang);
    await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
    await page.route(`${API}/api/reports/*`, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/map/basemap.json', (r) => r.fulfill({ status: 404, body: '' }));
    for (const [path, expected] of ROUTES) {
      await page.goto(path);
      await expect(page.locator('main')).toContainText(expected, { timeout: 10_000 });
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
}

// Test runs must not report to the production Sentry project (JAVASCRIPT-9 was this suite's localhost:4173
// run). index.html skips the Sentry loader on localhost; on any other host it must still load.
const SENTRY = /(^|\.)sentry(-cdn)?\.io$|(^|\.)sentry-cdn\.com$/;
test('Sentry is not loaded on localhost', async ({ page }) => {
  const hits: string[] = [];
  page.on('request', (r) => { if (SENTRY.test(new URL(r.url()).hostname)) hits.push(r.url()); });
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/map/basemap.json', (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.locator('main')).toBeVisible();
  await page.waitForLoadState('networkidle');
  expect(hits, hits.join('\n')).toEqual([]);
  expect(await page.evaluate(() => 'sentryOnLoad' in window)).toBe(false);
});

test('Sentry loader is still requested on a non-local host', async ({ page }) => {
  const hits: string[] = [];
  await page.route(/sentry-cdn\.com|sentry\.io/, (r) => { hits.push(r.request().url()); return r.abort(); });
  // Serve the built index.html as if from a production-like hostname.
  await page.route('http://fixmypvd.test/', async (r) => {
    const res = await r.fetch({ url: 'http://localhost:4173/' });
    await r.fulfill({ response: res });
  });
  await page.route(/^http:\/\/fixmypvd\.test\/(?!$)/, (r) => r.abort());
  await page.goto('http://fixmypvd.test/');
  await expect.poll(() => hits.length).toBeGreaterThan(0);
  expect(hits[0]).toContain('js.sentry-cdn.com/04195069c1daa8e3d2057b6405e37a21.min.js');
  expect(await page.evaluate(() => typeof (window as unknown as { sentryOnLoad?: unknown }).sentryOnLoad)).toBe('function');
});
