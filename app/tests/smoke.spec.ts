import { test, expect } from '@playwright/test';

// Integration guard: every route renders with no uncaught exception, in both languages.
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
const ROUTES: Array<[string, RegExp]> = [
  ['/', /What's the problem\?|¿Cuál es el problema\?/],
  ['/map', /What's the problem\?|¿Cuál es el problema\?/], // legacy route → redirects home
  ['/about', /About|Acerca/],
  ['/privacy', /Privacy|Privacidad/],
  ['/my', /My reports|Mis reportes/],
  ['/account', /Your account|Tu cuenta/],
  ['/r/nope', /can't find|no encontramos|no existe|no pudimos encontrar/i],
  ['/definitely-not-a-route', /doesn't exist|no existe/],
];

for (const lang of ['en', 'es']) {
  test(`all routes render in ${lang} without page errors`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((l) => { localStorage.setItem('snappvd.lang', l); (window as unknown as { __TURNSTILE_TOKEN__: string }).__TURNSTILE_TOKEN__ = 'x'; }, lang);
    await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
    await page.route(`${API}/api/public-feed*`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '{"items":[]}' }));
    await page.route(`${API}/api/reports/*`, (r) => r.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_found"}' }));
    await page.route('https://*.tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, body: '' }));
    await page.route('https://*.basemaps.cartocdn.com/**', (r) => r.fulfill({ status: 200, body: '' }));
    for (const [path, expected] of ROUTES) {
      await page.goto(path);
      await expect(page.locator('main')).toContainText(expected, { timeout: 10_000 });
    }
    expect(errors, errors.join('\n')).toEqual([]);
  });
}
