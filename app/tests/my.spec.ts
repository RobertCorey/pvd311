import { test, expect, type Page } from '@playwright/test';

// /my: the account's reports with status pills; sign-in prompt when signed out; empty state when none.
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };
const view = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, category: 'street_light', categoryLabel: 'Street light out', address: '25 Dorrance St', lat: null, lng: null, photoUrl: null,
  createdAt: new Date().toISOString(), status, portalCaseId: null, portalStatus: null, timeline: [], nextUpdateHint: null, mine: true, ...extra,
});

async function setup(page: Page, o: { signedIn?: boolean; account?: unknown[] }) {
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  if (o.signedIn !== false) await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route(`${API}/api/me/reports`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: o.account ?? [] }) }));
}

test('account reports only → cards with status pills, no empty state', async ({ page }) => {
  await setup(page, { account: [view('a1', 'received'), view('a2', 'rejected', { cancelledByReporter: true }), view('a3', 'sent')] });
  await page.goto('/my');
  const main = page.locator('main');
  await expect(main.locator('.my-row')).toHaveCount(3);
  await expect(main.locator('.my-status')).toHaveText(['Received', 'Cancelled', 'Sent']);
  await expect(main).not.toContainText('Nothing here yet');
  await expect(main).not.toContainText('Attach these reports');
});

test("a city-Resolved report's pill says the city closed it, not 'Resolved'", async ({ page }) => {
  await setup(page, { account: [view('a4', 'sent', { portalStatus: 'Resolved', portalCaseId: 'PVD2026-90091' })] });
  await page.goto('/my');
  await expect(page.locator('main .my-status')).toHaveText(['Closed by city']);
  await expect(page.locator('main')).not.toContainText('Resolved');
});

test('signed out with no reports → sign-in prompt, not the empty state', async ({ page }) => {
  await setup(page, { signedIn: false });
  await page.goto('/my');
  const main = page.locator('main');
  await expect(main).toContainText('Your reports are waiting');
  await expect(main).not.toContainText('No reports yet');
  await expect(main.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/account?returnTo=%2Fmy');
});

test('signed in with no reports → "No reports yet" empty state', async ({ page }) => {
  await setup(page, { account: [] });
  await page.goto('/my');
  const main = page.locator('main');
  await expect(main).toContainText('No reports yet');
  await expect(main).not.toContainText('Your reports are waiting');
});

test('signed in → the weekly quota line ("This week: N of 15")', async ({ page }) => {
  await setup(page, { account: [view('a1', 'received')] });
  await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google.com', prefs: { emailUpdates: true }, addresses: [], following: [], createdAt: new Date().toISOString(),
    quota: { dayUsed: 1, dayLimit: 5, weekUsed: 4, weekLimit: 15, dayResetsAt: new Date().toISOString(), weekResetsAt: new Date().toISOString(), nextAllowedAt: null, raised: false } }) }));
  await page.goto('/my');
  await expect(page.locator('main .quota-week')).toHaveText('This week: 4 of 15');
});

test('signed out → no quota line', async ({ page }) => {
  await setup(page, { signedIn: false });
  await page.goto('/my');
  await expect(page.locator('main')).toContainText('Your reports are waiting');
  await expect(page.locator('.quota-week')).toHaveCount(0);
});
