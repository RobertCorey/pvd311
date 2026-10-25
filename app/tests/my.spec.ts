import { test, expect, type Page } from '@playwright/test';

// /my: the account's reports with status pills; sign-in prompt when signed out; empty state when none.
const API = 'https://pvd311-worker.pvd311-worker.workers.dev';
const SESSION = { uid: 'u1', email: 'me@example.com', idToken: 'tok', refreshToken: 'rt', expiresAt: Date.now() + 3_600_000, provider: 'google' };
const view = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, category: 'street_light', categoryLabel: 'Street light out', address: '25 Dorrance St', lat: null, lng: null, photoUrl: null,
  createdAt: new Date().toISOString(), status, portalCaseId: null, portalStatus: null, timeline: [], nextUpdateHint: null, mine: true, ...extra,
});

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
/** One followed city case as GET /api/me/city returns it (api/me.ts FollowedCase). */
const followed = (id: string, status: string, extra: Record<string, unknown> = {}) => ({
  id, caseType: 'Pothole', category: 'pothole', street: '10 Angell St', status, open: !['Resolved', 'Closed', 'Cancelled', 'Merged'].includes(status),
  createdAt: daysAgo(5), closedAt: null, resolution: null, lat: 41.82856, lng: -71.4005, followedAt: daysAgo(2), updatedAt: daysAgo(0), ...extra,
});

async function setup(page: Page, o: { signedIn?: boolean; account?: unknown[]; followed?: unknown[]; unfollowStatus?: number; me?: Record<string, unknown> }) {
  const cityCalls: string[] = [];
  await page.route('https://api.fixmypvd.org/**', (r) => r.abort());
  if (o.me) await page.route(`${API}/api/me`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 'u1', email: 'me@example.com', emailVerified: true, displayName: null, provider: 'google', prefs: { emailUpdates: true }, addresses: [], following: [], cityFollowing: [], createdAt: daysAgo(30), ...o.me }) }));
  if (o.signedIn !== false) await page.addInitScript((s) => localStorage.setItem('fixmypvd.session', JSON.stringify(s)), SESSION);
  await page.route(`${API}/api/me/reports`, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: o.account ?? [] }) }));
  await page.route((u) => u.href.startsWith(`${API}/api/me/city`), (r) => {
    const m = r.request().method();
    cityCalls.push(`${m} ${new URL(r.request().url()).pathname}`);
    if (m === 'GET') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ items: o.followed ?? [] }) });
    const status = o.unfollowStatus ?? 204;
    return r.fulfill({ status, contentType: 'application/json', body: status === 204 ? '' : '{"error":"boom"}' });
  });
  return cityCalls;
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

test('a report the city is waiting on says so in its pill', async ({ page }) => {
  await setup(page, { account: [view('a5', 'sent', { portalStatus: 'Submitted', portalCaseId: 'PVD2026-90113', cityAsk: { askedAt: new Date().toISOString(), open: true, answered: false, answeredAt: null } })] });
  await page.goto('/my');
  await expect(page.locator('main .my-status')).toHaveText(['City needs info']);
  await expect(page.locator('main .my-status')).toHaveClass(/my-status--cityAsk/);
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

test('signed in with two followed city cases → "City requests you follow": rows, pills, map links; Unfollow removes the row', async ({ page }) => {
  const cityCalls = await setup(page, {
    account: [view('a1', 'received')],
    followed: [
      followed('g1', 'In Progress'),
      followed('g2', 'Resolved', { caseType: 'Street Light Out', category: 'street_light', street: '22 Thayer St', lat: null, lng: null, closedAt: daysAgo(1), resolution: 'Bulb replaced.' }),
    ],
  });
  await page.goto('/my');
  const sec = page.locator('main .followed-cases');
  await expect(sec.locator('h2')).toHaveText('City requests you follow');
  await expect(sec).toContainText('we email you when their status changes');
  const rows = sec.locator('.followed-card');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.my-cat')).toHaveText('Pothole');
  await expect(rows.nth(0).locator('.my-addr')).toHaveText('10 Angell St');
  await expect(rows.nth(0).locator('.my-status')).toHaveText('In progress');
  await expect(rows.nth(0).locator('.my-date')).toHaveText('Updated today');
  await expect(rows.nth(0).locator('a.my-row')).toHaveAttribute('href', '/street?case=g1&lat=41.82856&lng=-71.40050');
  await expect(rows.nth(0).locator('.my-note')).toHaveCount(0);
  await expect(rows.nth(1).locator('.my-status')).toHaveText('Closed');
  await expect(rows.nth(1).locator('.my-date')).toHaveText('Closed yesterday');
  await expect(rows.nth(1).locator('.my-note')).toHaveText('Bulb replaced.');
  await expect(rows.nth(1).locator('a.my-row')).toHaveAttribute('href', '/street?case=g2'); // unplaced: case= alone still opens the card
  // The account's own reports still render above the section.
  await expect(page.locator('main .account-reports .my-row')).toHaveCount(1);
  const unfollow = rows.nth(0).getByRole('button', { name: /^Unfollow/ });
  await expect(unfollow).toHaveAccessibleName('Unfollow — Pothole, 10 Angell St');
  await unfollow.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator('.my-cat')).toHaveText('Street Light Out');
  await expect.poll(() => cityCalls).toEqual(['GET /api/me/city', 'DELETE /api/me/city/g1']);
  // The last one gone → the section leaves with it.
  await rows.first().getByRole('button', { name: /^Unfollow/ }).click();
  await expect(sec).toHaveCount(0);
});

test('follows cases but has reported nothing → the followed list comes first; the reports\' empty state is just its prompt + CTA under it', async ({ page }) => {
  const cityCalls = await setup(page, { account: [], followed: [followed('g1', 'In Progress'), followed('g2', 'Assigned', { street: '22 Thayer St' })] });
  await page.goto('/my');
  const main = page.locator('main');
  const sec = main.locator('.followed-cases');
  await expect(sec.locator('.followed-card')).toHaveCount(2);
  await expect(main).not.toContainText('Nothing here yet');
  await expect(main).toContainText('No reports yet');
  await expect(main.getByRole('link', { name: 'Report a problem' })).toBeVisible();
  // DOM order: the followed section, then the compact empty state.
  const order = await main.evaluate((m) => Array.from(m.querySelectorAll('.followed-cases, .empty')).map((el) => el.className.split(' ')[0]));
  expect(order).toEqual(['followed-cases', 'empty']);
  await expect(main.locator('.empty .illo')).toHaveCount(0);
  await expect.poll(() => cityCalls).toEqual(['GET /api/me/city']); // the swap reordered, never remounted
  // With a report of its own the list stays under the reports (the original order).
  await setup(page, { account: [view('a1', 'received')], followed: [followed('g1', 'In Progress')] });
  await page.goto('/my');
  await expect(main.locator('.followed-card')).toHaveCount(1);
  await expect(main.locator('.account-reports .my-row')).toHaveCount(1);
  const order2 = await main.evaluate((m) => Array.from(m.querySelectorAll('.followed-cases, .account-reports')).map((el) => el.className.split(' ')[0]));
  expect(order2).toEqual(['account-reports', 'followed-cases']);
});

test('the followed hint only promises mail when it would come: email updates off → says so and links to Account', async ({ page }) => {
  await setup(page, { account: [view('a1', 'received')], followed: [followed('g1', 'In Progress')], me: { prefs: { emailUpdates: false } } });
  await page.goto('/my');
  const hint = page.locator('main .followed-cases .hint');
  await expect(hint).toHaveText("The city's own requests you follow. Email updates are off for your account, so you won't hear about changes. Fix this in Account");
  await expect(hint.getByRole('link', { name: 'Fix this in Account' })).toHaveAttribute('href', '/account');
  await setup(page, { account: [view('a1', 'received')], followed: [followed('g1', 'In Progress')], me: { emailVerified: false } });
  await page.goto('/my');
  await expect(hint).toContainText('Verify your email to hear about changes.');
  await expect(hint).not.toContainText('we email you');
});

test('a failed unfollow puts the row back and says so', async ({ page }) => {
  await setup(page, { account: [view('a1', 'received')], followed: [followed('g1', 'Assigned'), followed('g2', 'Submitted', { street: '22 Thayer St' })], unfollowStatus: 500 });
  await page.goto('/my');
  const rows = page.locator('main .followed-cases .followed-card');
  await expect(rows).toHaveCount(2);
  await rows.nth(0).getByRole('button', { name: /^Unfollow/ }).click();
  await expect(page.locator('main .followed-cases .notice-error')).toHaveText("Couldn't save that. Try again.");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).locator('.my-addr')).toHaveText('10 Angell St'); // back in its place, not at the end
});

test('signed in following nothing → no followed section', async ({ page }) => {
  const cityCalls = await setup(page, { account: [view('a1', 'received')] });
  await page.goto('/my');
  await expect(page.locator('main .my-row')).toHaveCount(1);
  await expect.poll(() => cityCalls).toEqual(['GET /api/me/city']);
  await expect(page.locator('.followed-cases')).toHaveCount(0);
});

test('signed out → /api/me/city is never asked, no followed section', async ({ page }) => {
  const cityCalls = await setup(page, { signedIn: false });
  await page.goto('/my');
  await expect(page.locator('main')).toContainText('Your reports are waiting');
  await expect(page.locator('.followed-cases')).toHaveCount(0);
  expect(cityCalls).toEqual([]);
});
