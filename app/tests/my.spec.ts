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
